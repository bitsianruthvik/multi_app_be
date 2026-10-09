/**
 * contentCopyService.js — copy KRAs, responsibilities, KPIs, skills and
 * qualifications from one role or seat to others.
 *
 * ── WHY THIS IS NOT A "PASTE" ─────────────────────────────────────────────
 * The client's own org-chart tool copies between POSITIONS because in that tool a
 * position owns its lists. Here content belongs to a ROLE, and a role is shared:
 * "Helper 1" is one role across ten seats. So "copy these duties to that seat" can
 * mean three different acts, and the difference between them is how many
 * people's job descriptions change:
 *
 *   SEAT  an overlay on that one seat (hrms_position_content_overrides, ADD).
 *         Changes exactly one seat. THE SAFE DEFAULT.
 *   ROLE  new rows on the target's role. Changes EVERY seat holding it, so the
 *         caller must send back the seat count it was shown (`confirm.seats`)
 *         and is refused if the number has moved since.
 *   FORK  a new role, cloned from the target seat's own role plus the copied
 *         lines, and the seat is repointed to it. One seat changes, the old role
 *         and its other seats do not — at the price of one more role to keep.
 *
 * Only KRAs, responsibilities and KPIs have a seat-level layer (models/init.sql:
 * the override tables cover those three), so SEAT refuses everything else out
 * loud rather than quietly dropping it. A qualification can only be copied at
 * role level, which is what FORK is for.
 *
 * ── THE RULES THAT ARE EASY TO GET WRONG ──────────────────────────────────
 * 1. NOTHING IS RESOLVED HERE. What a role or a seat "carries" is read through
 *    contentResolver.resolveContent — the one implementation of plan §2 rule 6.
 *    Copying FROM a seat copies what that seat effectively says (its role plus its
 *    own exceptions), and a SUPPRESSED line is not copied because the seat does not
 *    carry it.
 * 2. A COPY NEVER CREATES A DEFINITION. "Define once, assign to a context": the
 *    new row points at the same master row the source line points at, so the
 *    masters never grow from a copy. What can be "reused" is the TARGET's line:
 *    a line the target already carries — by the same definition, or by a
 *    differently-numbered definition that says the same words once normalised
 *    (the importer's own key: trim, squeeze spaces, lower-case, drop trailing
 *    . ; ,) — is left alone and counted as reused, never doubled.
 * 3. SAME ROLE = REFUSED. If source and target already share a role, everything
 *    the role says is already on both. That is refused with a sentence, not run
 *    as a silent no-op.
 * 4. A SEAT THAT SUPPRESSES A LINE KEEPS SUPPRESSING IT. Copying must not undo
 *    an explicit exception; that line is reported as blocked, with the reason.
 * 5. FORK MOVES THE PEOPLE WITH THE SEAT. A work assignment's role is meant to
 *    equal its position's role unless an exception was recorded
 *    (assignmentService), so repointing a seat without its assignments would make
 *    the JD and the person's profile disagree. They move together. Earlier
 *    generated documents are history and stay as they were.
 * 6. ONE TRANSACTION, BULK WRITES. The caller's connection is used and never
 *    committed here. Every table is written with one multi-row INSERT — a copy of
 *    30 lines to 10 seats is a handful of round trips, not 300 (49 ms each on
 *    prod). Ids are never derived from insertId; they are read back.
 *
 * `planCopy` is the single place a decision is made. The preview and the write
 * both call it, so what the screen promised and what was written cannot differ.
 */
import { invalid, conflict, notFound } from '../lib/errors.js';
import {
  CONTENT, requireRole, audit, assertTitleFree, isoDate,
} from './roleContentService.js';
import { resolveContent } from './contentResolver.js';
import { today as localToday } from './positionService.js';

/* ══════════════════════════════════════════════════════════════════════════
 * Vocabulary
 * ══════════════════════════════════════════════════════════════════════════ */

export const COPY_MODES = ['SEAT', 'ROLE', 'FORK'];

/** Processing order matters: KRAs first, so a responsibility can be filed under one the copy just made. */
export const COPY_KINDS = [
  'kras', 'responsibilities', 'kpis', 'skills', 'qualifications', 'authorities',
  'experience', 'relationships', 'conditions',
];

/** The only kinds with a seat-level layer. See models/init.sql, section 4. */
export const SEAT_KINDS = ['kras', 'responsibilities', 'kpis'];

const KIND_WORDS = {
  kras: ['KRA', 'KRAs'],
  responsibilities: ['responsibility', 'responsibilities'],
  kpis: ['KPI', 'KPIs'],
  skills: ['skill', 'skills'],
  qualifications: ['qualification', 'qualifications'],
  authorities: ['authority', 'authorities'],
  experience: ['experience requirement', 'experience requirements'],
  relationships: ['relationship', 'relationships'],
  conditions: ['working condition', 'working conditions'],
};
const noun = (kind, n = 2) => KIND_WORDS[kind][n === 1 ? 0 : 1];

const CONTENT_TYPE = { kras: 'KRA', responsibilities: 'RESPONSIBILITY', kpis: 'KPI' };

/**
 * The context columns each assignment table carries beyond its definition,
 * `sequence`, the dates and the grouping — i.e. what an assignment MEANS for a
 * role. Mirrors CONTENT[kind].fields in roleContentService and the DDL in
 * models/init.sql. JSON columns are carried as text.
 */
const COLS = {
  kras: ['weight_percent', 'is_mandatory', 'notes'],
  responsibilities: ['responsibility_class_override', 'is_mandatory', 'notes'],
  kpis: ['target_operator', 'target_value', 'weight_percent', 'frequency_override', 'is_mandatory', 'notes'],
  skills: ['requirement_level', 'proficiency_level', 'notes'],
  qualifications: ['requirement_level', 'notes'],
  authorities: ['limit_json', 'notes'],
  experience: ['min_years', 'preferred_years', 'experience_area', 'requirement_level', 'notes'],
  relationships: ['relationship_scope', 'counterparty', 'purpose'],
  conditions: ['condition_type', 'description', 'is_mandatory'],
};

/** Statuses of an assignment that put somebody on a job, or are about to. */
const LIVE_ASSIGNMENT = ['ACTIVE', 'SUSPENDED'];
const OPEN_ASSIGNMENT = ['PLANNED', 'ACTIVE', 'SUSPENDED'];

const MAX_TARGETS = 100;
const MAX_ROWS = 20000;
const INSERT_CHUNK = 400;

/* ══════════════════════════════════════════════════════════════════════════
 * Small helpers
 * ══════════════════════════════════════════════════════════════════════════ */

const qs = (n) => Array(n).fill('?').join(',');
const squeeze = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

/**
 * The importer's identity for a line of text (scripts/import-org-chart.mjs,
 * `normKey`): so a copy and an import agree on what "the same words" means. The
 * one difference: whitespace before the trailing punctuation is dropped too
 * ("do it ;" and "do it" are the same duty), which the importer's pattern kept.
 */
export const normKey = (s) => squeeze(s).toLowerCase().replace(/[\s.;,]+$/, '');

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const blank = (v) => v == null || String(v).trim() === '';
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(s));

/** "a, b and c". */
function listWords(items) {
  const xs = items.filter(Boolean);
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** One multi-row INSERT per chunk. The only way rows are written by this file. */
async function insertRows(db, table, columns, rows) {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const part = rows.slice(i, i + INSERT_CHUNK);
    const tuple = `(${qs(columns.length)})`;
    await db.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${part.map(() => tuple).join(', ')}`,
      part.flat(),
    );
  }
  return rows.length;
}

/* ══════════════════════════════════════════════════════════════════════════
 * Reading the request
 * ══════════════════════════════════════════════════════════════════════════ */

function readRef(raw, label, problems) {
  const type = String(raw?.type ?? '').trim().toLowerCase();
  const id = Number(raw?.id);
  if (!['role', 'position'].includes(type) || !Number.isInteger(id) || id <= 0) {
    problems.push(`${label} has to be a role or a position, with its id.`);
    return null;
  }
  return { type, id };
}

/** Validates the whole request at once, so a form gets every problem in one go. */
export function readCopyRequest(body = {}) {
  const problems = [];
  const mode = String(body.mode ?? '').trim().toUpperCase();
  if (!COPY_MODES.includes(mode)) problems.push(`Say how to copy: ${COPY_MODES.join(', ')}.`);

  const source = readRef(body.source, 'The source', problems);

  const seen = new Set();
  const targets = [];
  for (const [i, t] of (Array.isArray(body.targets) ? body.targets : []).entries()) {
    const ref = readRef(t, `Target ${i + 1}`, problems);
    if (!ref || seen.has(`${ref.type}:${ref.id}`)) continue;
    seen.add(`${ref.type}:${ref.id}`);
    targets.push(ref);
  }
  if (!targets.length) problems.push('Pick at least one place to copy to.');
  if (targets.length > MAX_TARGETS) problems.push(`Copy to at most ${MAX_TARGETS} places at a time.`);

  const kinds = [];
  for (const raw of Array.isArray(body.kinds) ? body.kinds : []) {
    const k = String(raw).trim().toLowerCase();
    if (!COPY_KINDS.includes(k)) problems.push(`"${raw}" is not something that can be copied.`);
    else if (!kinds.includes(k)) kinds.push(k);
  }
  if (!kinds.length) problems.push('Choose what to copy: at least one kind.');
  kinds.sort((a, b) => COPY_KINDS.indexOf(a) - COPY_KINDS.indexOf(b));

  const lines = body.lines == null ? null : (Array.isArray(body.lines) ? body.lines.map(String) : null);
  if (body.lines != null && lines === null) problems.push('Lines is a list of line keys.');

  const on = blank(body.on) ? localToday() : String(body.on).slice(0, 10);
  if (!validDate(on)) problems.push('"On" is a date as YYYY-MM-DD.');

  let effectiveFrom = null;
  if (!blank(body.effectiveFrom)) {
    effectiveFrom = String(body.effectiveFrom).slice(0, 10);
    if (!validDate(effectiveFrom)) {
      problems.push('Applies from is a date as YYYY-MM-DD.');
      effectiveFrom = null;
    }
  }

  const forkTitle = blank(body.forkTitle) ? null : String(body.forkTitle).trim();
  if (forkTitle && forkTitle.length > 200) problems.push('A role title is up to 200 characters.');

  let confirmSeats = null;
  if (body.confirm && body.confirm.seats != null) {
    confirmSeats = Number(body.confirm.seats);
    if (!Number.isInteger(confirmSeats) || confirmSeats < 0) {
      problems.push('Confirm the number of seats as a whole number.');
      confirmSeats = null;
    }
  }

  if (problems.length) throw invalid('INVALID', 'Some fields need attention.', { problems });
  return { mode, source, targets, kinds, lines, on, effectiveFrom, forkTitle, confirmSeats };
}

/**
 * What a caller must hold for a mode: SEAT is org_manage (the same tag
 * routes/positions.js asks for on a position override), ROLE is roles_manage,
 * FORK needs both because it writes a role AND moves a seat. `null` for a mode
 * nobody has heard of — the route then asks for either tag, so an unknown mode
 * is still a 403 for anyone holding neither (cf_hrms_self_view reaches none of it).
 */
export function permissionsForCopyMode(mode, PERM) {
  switch (String(mode ?? '').toUpperCase()) {
    case 'SEAT': return [PERM.orgManage];
    case 'ROLE': return [PERM.rolesManage];
    case 'FORK': return [PERM.rolesManage, PERM.orgManage];
    default: return null;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * Loading roles, seats and their reach
 * ══════════════════════════════════════════════════════════════════════════ */

async function loadRoles(db, companyId, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const [rows] = await db.query(
    `SELECT * FROM hrms_roles WHERE company_id = ? AND deleted_at IS NULL AND id IN (${qs(ids.length)})`,
    [companyId, ...ids],
  );
  for (const r of rows) {
    out.set(r.id, {
      id: r.id, code: r.role_code ?? null, title: r.title, status: r.status,
      purpose: r.role_purpose ?? null, summary: r.role_summary ?? null,
      departmentId: r.default_department_id ?? null,
      effectiveFrom: isoDate(r.effective_from), effectiveTo: isoDate(r.effective_to),
    });
  }
  return out;
}

async function loadPositions(db, companyId, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const [rows] = await db.query(
    `SELECT p.id, p.position_code, p.position_title, p.role_id, p.status,
            r.title AS role_title, r.role_code
       FROM hrms_positions p
       JOIN hrms_roles r ON r.company_id = p.company_id AND r.id = p.role_id AND r.deleted_at IS NULL
      WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.id IN (${qs(ids.length)})`,
    [companyId, ...ids],
  );
  for (const p of rows) {
    out.set(p.id, {
      id: p.id, code: p.position_code ?? null, title: p.position_title ?? null,
      roleId: p.role_id, roleTitle: p.role_title, roleCode: p.role_code ?? null, status: p.status,
      label: p.position_title || p.role_title,
    });
  }
  return out;
}

const seatLabel = (p) => `${p.label}${p.code ? ` (${p.code})` : ''}`;
const roleLabel = (r) => `${r.title}${r.code ? ` (${r.code})` : ''}`;

/**
 * Who a change reaches. Seats are positions (the number the Roles screen calls
 * "Positions using it"); people are those holding an assignment that is live on
 * the date. Both come from SQL, once, for every role and seat at the same time.
 */
async function loadReach(db, companyId, { roleIds, positionIds, on }) {
  const seatsByRole = new Map();
  const peopleByRole = new Map();
  const peopleByPosition = new Map();
  const live = `wa.company_id = ? AND wa.deleted_at IS NULL AND wa.status IN (${qs(LIVE_ASSIGNMENT.length)})
        AND (wa.effective_from IS NULL OR wa.effective_from <= ?) AND (wa.effective_to IS NULL OR wa.effective_to >= ?)`;
  const liveParams = [companyId, ...LIVE_ASSIGNMENT, on, on];

  if (roleIds.length) {
    const [seats] = await db.query(
      `SELECT role_id, COUNT(*) AS n FROM hrms_positions
        WHERE company_id = ? AND deleted_at IS NULL AND role_id IN (${qs(roleIds.length)}) GROUP BY role_id`,
      [companyId, ...roleIds],
    );
    for (const r of seats) seatsByRole.set(r.role_id, Number(r.n));
    const [people] = await db.query(
      `SELECT wa.role_id, COUNT(DISTINCT wa.employee_id) AS n FROM hrms_work_assignments wa
        WHERE ${live} AND wa.role_id IN (${qs(roleIds.length)}) GROUP BY wa.role_id`,
      [...liveParams, ...roleIds],
    );
    for (const r of people) peopleByRole.set(r.role_id, Number(r.n));
  }
  if (positionIds.length) {
    const [people] = await db.query(
      `SELECT wa.position_id, COUNT(DISTINCT wa.employee_id) AS n FROM hrms_work_assignments wa
        WHERE ${live} AND wa.position_id IN (${qs(positionIds.length)}) GROUP BY wa.position_id`,
      [...liveParams, ...positionIds],
    );
    for (const r of people) peopleByPosition.set(r.position_id, Number(r.n));
  }

  /** Distinct people across a whole set — a person in two of the roles is one person. */
  const distinctPeople = async (column, ids) => {
    if (!ids.length) return 0;
    const [[row]] = await db.query(
      `SELECT COUNT(DISTINCT wa.employee_id) AS n FROM hrms_work_assignments wa
        WHERE ${live} AND wa.${column} IN (${qs(ids.length)})`,
      [...liveParams, ...ids],
    );
    return Number(row.n ?? 0);
  };
  return { seatsByRole, peopleByRole, peopleByPosition, distinctPeople };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Reading the source
 * ══════════════════════════════════════════════════════════════════════════ */

const DEF_TABLE = {
  kras: 'hrms_kra_definitions',
  responsibilities: 'hrms_responsibility_definitions',
  kpis: 'hrms_kpi_definitions',
  skills: 'hrms_skill_definitions',
  qualifications: 'hrms_qualification_definitions',
  authorities: 'hrms_authority_definitions',
};

/** The master rows behind a set of lines — one query per master. */
async function loadDefinitions(db, companyId, items) {
  const wanted = new Map();
  for (const l of items) {
    if (l.definitionId == null || !DEF_TABLE[l.kind]) continue;
    if (!wanted.has(l.kind)) wanted.set(l.kind, new Set());
    wanted.get(l.kind).add(l.definitionId);
  }
  const out = new Map();
  for (const [kind, ids] of wanted) {
    const list = [...ids];
    const [rows] = await db.query(
      `SELECT * FROM ${DEF_TABLE[kind]} WHERE company_id = ? AND id IN (${qs(list.length)})`,
      [companyId, ...list],
    );
    for (const r of rows) out.set(`${kind}:${r.id}`, r);
  }
  return out;
}

const mandatory = (v) => (v === false || v === 0 ? 0 : 1);
const jsonText = (v) => (v === null || v === undefined ? null : JSON.stringify(v));

/**
 * One resolved row as a "line": what it is, where it came from, the columns a
 * role assignment of it would carry, and what an overlay ADD of it would carry.
 *
 * The role-row columns are rebuilt from the RESOLVED values, so a weight the
 * source seat had overridden is the weight that is copied. A class or frequency
 * is written as an override only where it differs from the definition's own
 * default; otherwise the target inherits the default like every other row does.
 */
function makeLine(kind, it, parentKraDefinitionId, def) {
  const defId = it.definitionId ?? null;
  const line = {
    kind,
    key: defId != null ? `${kind}:${defId}` : `${kind}:row${it.sourceRowId}`,
    definitionId: defId,
    sourceRowId: it.sourceRowId ?? null,
    name: it.name ?? '',
    code: it.code ?? null,
    description: it.description ?? null,
    text: it.text ?? it.name ?? '',
    origin: it.origin ?? 'ROLE',
    parentKraDefinitionId: parentKraDefinitionId ?? null,
    effectiveTo: it.effectiveTo ?? null,
    order: [Number(it.sequence ?? 0), Number(it.sourceRowId ?? 0)],
    defStatus: def?.status ?? null,
    cols: {},
    overlay: {},
    textKey: null,
    contentKey: null,
  };

  const notes = it.notes ? String(it.notes) : null;
  switch (kind) {
    case 'kras':
      line.cols = { weight_percent: it.weightPercent ?? null, is_mandatory: mandatory(it.isMandatory), notes };
      if (it.weightPercent != null) line.overlay.weightPercent = it.weightPercent;
      if (it.isMandatory === false) line.overlay.isMandatory = false;
      if (notes) line.overlay.notes = notes;
      break;
    case 'responsibilities': {
      const effective = it.responsibilityClass ?? null;
      const own = def?.responsibility_class ?? null;
      const override = effective && effective !== own ? effective : null;
      line.cols = { responsibility_class_override: override, is_mandatory: mandatory(it.isMandatory), notes };
      if (override) line.overlay.responsibilityClass = override;
      if (it.isMandatory === false) line.overlay.isMandatory = false;
      if (notes) line.overlay.notes = notes;
      line.textKey = normKey(it.description || it.name);
      break;
    }
    case 'kpis': {
      const effective = it.frequency ?? null;
      const own = def?.default_frequency ?? null;
      const override = effective && effective !== own ? effective : null;
      line.cols = {
        target_operator: it.targetOperator ?? null,
        target_value: it.targetValue === null || it.targetValue === undefined ? null : jsonText(it.targetValue),
        weight_percent: it.weightPercent ?? null,
        frequency_override: override,
        is_mandatory: mandatory(it.isMandatory),
        notes,
      };
      if (it.targetOperator) {
        line.overlay.targetOperator = it.targetOperator;
        if (it.targetValue !== null && it.targetValue !== undefined) line.overlay.targetValue = it.targetValue;
      }
      if (it.weightPercent != null) line.overlay.weightPercent = it.weightPercent;
      if (override) line.overlay.frequency = override;
      if (it.isMandatory === false) line.overlay.isMandatory = false;
      if (notes) line.overlay.notes = notes;
      break;
    }
    case 'skills':
      line.cols = { requirement_level: it.requirementLevel ?? 'REQUIRED', proficiency_level: it.proficiencyLevel ?? null, notes };
      break;
    case 'qualifications':
      line.cols = { requirement_level: it.requirementLevel ?? 'REQUIRED', notes };
      break;
    case 'authorities':
      line.cols = { limit_json: it.limitJson ? jsonText(it.limitJson) : null, notes };
      break;
    case 'experience':
      line.cols = {
        min_years: it.minYears ?? null, preferred_years: it.preferredYears ?? null,
        experience_area: it.experienceArea ?? null, requirement_level: it.requirementLevel ?? 'REQUIRED', notes,
      };
      line.contentKey = [normKey(it.experienceArea), it.minYears ?? '', it.preferredYears ?? '', it.requirementLevel ?? ''].join('|');
      break;
    case 'relationships':
      line.cols = { relationship_scope: it.relationshipScope ?? 'INTERNAL', counterparty: it.name, purpose: it.purpose ?? null };
      line.contentKey = [it.relationshipScope ?? '', normKey(it.name), normKey(it.purpose)].join('|');
      break;
    case 'conditions':
      line.cols = { condition_type: it.conditionType ?? 'OTHER', description: it.description ?? '', is_mandatory: mandatory(it.isMandatory) };
      line.contentKey = [it.conditionType ?? '', normKey(it.description)].join('|');
      break;
    default:
  }
  return line;
}

/**
 * Everything a role or a seat carries, as lines — through the one resolver.
 * A role is read with no overlay; a seat with its own.
 */
async function loadSource(db, companyId, ref, on) {
  let roleId;
  let label;
  let seats = 1;
  let position = null;
  if (ref.type === 'role') {
    const role = (await loadRoles(db, companyId, [ref.id])).get(ref.id);
    if (!role) throw notFound('The source role');
    roleId = role.id;
    label = roleLabel(role);
    const [[n]] = await db.query(
      'SELECT COUNT(*) AS n FROM hrms_positions WHERE company_id = ? AND role_id = ? AND deleted_at IS NULL',
      [companyId, role.id],
    );
    seats = Number(n.n ?? 0);
  } else {
    position = (await loadPositions(db, companyId, [ref.id])).get(ref.id);
    if (!position) throw notFound('The source position');
    roleId = position.roleId;
    label = seatLabel(position);
  }

  const resolved = await resolveContent(db, companyId, ref.type === 'role' ? { roleId, on } : { positionId: ref.id, on });

  // Two passes: a line needs its master (status, class default), and the masters
  // are fetched once per kind, not once per line.
  const raw = [];
  const add = (kind, item, parent) => raw.push({ kind, item, parent });
  for (const k of resolved.kras) {
    add('kras', k, null);
    for (const r of k.responsibilities) add('responsibilities', r, k.definitionId);
    for (const p of k.kpis) add('kpis', p, k.definitionId);
  }
  for (const r of resolved.additional.responsibilities) add('responsibilities', r, r.parentKraDefinitionId ?? null);
  for (const p of resolved.additional.kpis) add('kpis', p, p.parentKraDefinitionId ?? null);
  for (const kind of ['skills', 'qualifications', 'authorities', 'experience', 'relationships', 'conditions']) {
    for (const row of resolved[kind]) add(kind, row, null);
  }
  const defs = await loadDefinitions(db, companyId, raw.map((r) => ({ kind: r.kind, definitionId: r.item.definitionId ?? null })));
  const lines = raw
    .map((r) => makeLine(r.kind, r.item, r.parent, defs.get(`${r.kind}:${r.item.definitionId}`) ?? null))
    .sort((a, b) => (COPY_KINDS.indexOf(a.kind) - COPY_KINDS.indexOf(b.kind)) || (a.order[0] - b.order[0]) || (a.order[1] - b.order[1]));

  const kraName = new Map(resolved.kras.map((k) => [Number(k.definitionId), k.name]));
  return {
    ref: { ...ref, label, roleId, roleTitle: resolved.role.title, positionId: position?.id ?? null, seats },
    roleId,
    lines,
    kraName,
    layers: resolved.layers,
    suppressed: resolved.suppressed ?? [],
  };
}

/** A line as the screen needs it. Nothing here is a database row. */
function publicLine(l, kraName) {
  return {
    key: l.key,
    kind: l.kind,
    definitionId: l.definitionId,
    name: l.name,
    code: l.code,
    description: l.description,
    text: l.text,
    origin: l.origin,
    groupName: l.parentKraDefinitionId != null ? (kraName.get(Number(l.parentKraDefinitionId)) ?? null) : null,
    inactive: l.defStatus === 'INACTIVE',
    endsOn: l.effectiveTo,
  };
}

/**
 * GET: what could be copied from this role or seat, today (or on `on`). The
 * screen builds its line picker from this, so the keys it sends back are the
 * ones the server made.
 */
export async function describeCopySource(db, companyId, query = {}) {
  const problems = [];
  const ref = readRef({ type: query.type, id: query.id }, 'The source', problems);
  const on = blank(query.on) ? localToday() : String(query.on).slice(0, 10);
  if (!validDate(on)) problems.push('"On" is a date as YYYY-MM-DD.');
  if (problems.length) throw invalid('INVALID', 'Some fields need attention.', { problems });

  const src = await loadSource(db, companyId, ref, on);
  const counts = Object.fromEntries(COPY_KINDS.map((k) => [k, src.lines.filter((l) => l.kind === k).length]));
  return {
    source: src.ref,
    asOf: on,
    layers: src.layers,
    lines: src.lines.map((l) => publicLine(l, src.kraName)),
    counts,
    suppressed: src.suppressed.map((s) => ({ kind: s.kind, name: s.name, byLayer: s.byLayer })),
    seatKinds: SEAT_KINDS,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * What the targets already carry
 * ══════════════════════════════════════════════════════════════════════════ */

const ended = (to, on) => !!to && to < on;

/**
 * The live rows of each role, per kind: which definitions it carries, which
 * wordings, where the next sequence number starts, and which KRA row a
 * responsibility could be filed under. Several roles in one query per kind.
 */
async function loadRoleStates(db, companyId, roleIds, kinds) {
  const states = new Map(roleIds.map((id) => [id, {}]));
  if (!roleIds.length) return states;
  const need = new Set(kinds);
  if (need.has('responsibilities') || need.has('kpis')) need.add('kras');   // grouping needs them

  for (const kind of COPY_KINDS.filter((k) => need.has(k))) {
    const k = CONTENT[kind];
    const defCol = k.def?.column ?? null;
    const extra = {
      responsibilities: ', d.description AS d_desc, d.name AS d_name',
      experience: ', a.min_years, a.preferred_years, a.experience_area, a.requirement_level',
      relationships: ', a.relationship_scope, a.counterparty, a.purpose',
      conditions: ', a.condition_type, a.description',
    }[kind] ?? '';
    const join = kind === 'responsibilities'
      ? 'LEFT JOIN hrms_responsibility_definitions d ON d.company_id = a.company_id AND d.id = a.responsibility_definition_id'
      : '';
    const [rows] = await db.query(
      `SELECT a.id, a.role_id, a.sequence, a.effective_to${defCol ? `, a.${defCol} AS def_id` : ''}${extra}
         FROM ${k.table} a ${join}
        WHERE a.company_id = ? AND a.deleted_at IS NULL AND a.role_id IN (${qs(roleIds.length)})`,
      [companyId, ...roleIds],
    );
    for (const id of roleIds) {
      states.get(id)[kind] = { byDef: new Map(), textKeys: new Set(), contentKeys: new Set(), maxSeq: 0 };
    }
    for (const r of rows) {
      const ks = states.get(r.role_id)[kind];
      ks.maxSeq = Math.max(ks.maxSeq, Number(r.sequence ?? 0));
      if (r.def_id != null) ks.byDef.set(Number(r.def_id), { id: r.id, to: isoDate(r.effective_to) });
      if (kind === 'responsibilities') ks.textKeys.add(normKey(r.d_desc || r.d_name));
      if (kind === 'experience') {
        ks.contentKeys.add([normKey(r.experience_area), r.min_years == null ? '' : Number(r.min_years),
          r.preferred_years == null ? '' : Number(r.preferred_years), r.requirement_level ?? ''].join('|'));
      }
      if (kind === 'relationships') ks.contentKeys.add([r.relationship_scope ?? '', normKey(r.counterparty), normKey(r.purpose)].join('|'));
      if (kind === 'conditions') ks.contentKeys.add([r.condition_type ?? '', normKey(r.description)].join('|'));
    }
  }
  return states;
}

/** The live ADD and SUPPRESS overlays of each seat, for the three overlayable kinds. */
async function loadSeatOverlays(db, companyId, positionIds) {
  const out = new Map(positionIds.map((id) => [id, { add: new Map(), addText: new Set(), suppress: new Map() }]));
  if (!positionIds.length) return out;
  const [rows] = await db.query(
    `SELECT o.position_id, o.content_type, o.action, o.kra_definition_id, o.responsibility_definition_id,
            o.kpi_definition_id, o.effective_to, d.description AS d_desc, d.name AS d_name
       FROM hrms_position_content_overrides o
       LEFT JOIN hrms_responsibility_definitions d
              ON d.company_id = o.company_id AND d.id = o.responsibility_definition_id
      WHERE o.company_id = ? AND o.deleted_at IS NULL AND o.action IN ('ADD', 'SUPPRESS')
        AND o.position_id IN (${qs(positionIds.length)})`,
    [companyId, ...positionIds],
  );
  const kindOf = { KRA: 'kras', RESPONSIBILITY: 'responsibilities', KPI: 'kpis' };
  for (const r of rows) {
    const kind = kindOf[r.content_type];
    const defId = r.kra_definition_id ?? r.responsibility_definition_id ?? r.kpi_definition_id;
    if (!kind || defId == null) continue;
    const o = out.get(r.position_id);
    const key = `${kind}:${defId}`;
    const to = isoDate(r.effective_to);
    if (r.action === 'SUPPRESS') o.suppress.set(key, to);
    else {
      o.add.set(key, to);
      if (kind === 'responsibilities') o.addText.add(normKey(r.d_desc || r.d_name));
    }
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * Deciding, line by line
 * ══════════════════════════════════════════════════════════════════════════ */

const create = () => ({ outcome: 'CREATE', code: null, why: null });
const reuse = (code, why) => ({ outcome: 'REUSE', code, why });
const block = (code, why) => ({ outcome: 'BLOCK', code, why });

/** Rules shared by every mode: a master that is switched off, and dates that cannot work. */
function commonBlock(line, req) {
  if (line.defStatus === 'INACTIVE') {
    return block('INACTIVE', `"${line.name}" is inactive in its master. Reactivate it there before copying it.`);
  }
  if (req.effectiveFrom && line.effectiveTo && line.effectiveTo < req.effectiveFrom) {
    return block('ENDS_BEFORE_START', `It ends on ${line.effectiveTo}, before the date you chose for it to start.`);
  }
  return null;
}

/** The identity inside one copy: two selected lines that say the same thing become one. */
const copyIdentity = (line) => {
  if (line.textKey) return `${line.kind}|t|${line.textKey}`;
  if (line.contentKey) return `${line.kind}|c|${line.contentKey}`;
  return `${line.kind}|d|${line.definitionId}`;
};

function decideOnRole(line, roleState, seen, req, roleTitle) {
  const blocked = commonBlock(line, req);
  if (blocked) return blocked;
  const ks = roleState[line.kind];
  if (line.definitionId != null && ks.byDef.has(line.definitionId)) {
    return reuse('ON_ROLE', `"${roleTitle}" already carries it.`);
  }
  if (line.textKey && ks.textKeys.has(line.textKey)) {
    return reuse('SAME_WORDING', `"${roleTitle}" already carries a line with the same wording.`);
  }
  if (line.contentKey && ks.contentKeys.has(line.contentKey)) {
    return reuse('ON_ROLE', `"${roleTitle}" already has an identical line.`);
  }
  const id = copyIdentity(line);
  if (seen.has(id)) return reuse('REPEATED', 'Another line in this copy says the same thing, so it is only added once.');
  seen.add(id);
  return create();
}

function decideOnSeat(line, roleState, overlay, seen, req, on, roleTitle) {
  const blocked = commonBlock(line, req);
  if (blocked) return blocked;
  const key = `${line.kind}:${line.definitionId}`;
  if (overlay.suppress.has(key) && !ended(overlay.suppress.get(key), on)) {
    return block('SUPPRESSED', 'This seat deliberately drops it. Remove that exception on the seat first if it should apply.');
  }
  const ks = roleState[line.kind];
  const onRole = ks.byDef.get(line.definitionId);
  if (onRole && !ended(onRole.to, on)) return reuse('ON_ROLE', `It already comes with the seat's role, "${roleTitle}".`);
  if (line.textKey && ks.textKeys.has(line.textKey)) {
    return reuse('SAME_WORDING', `The seat's role, "${roleTitle}", already carries a line with the same wording.`);
  }
  if (overlay.add.has(key) && !ended(overlay.add.get(key), on)) return reuse('ON_SEAT', 'Already added to this seat.');
  if (line.textKey && overlay.addText.has(line.textKey)) return reuse('SAME_WORDING', 'This seat already has a line with the same wording.');
  const id = copyIdentity(line);
  if (seen.has(id)) return reuse('REPEATED', 'Another line in this copy says the same thing, so it is only added once.');
  seen.add(id);
  return create();
}

/* ══════════════════════════════════════════════════════════════════════════
 * The plan
 * ══════════════════════════════════════════════════════════════════════════ */

/** Four ways the same refusal reads, depending on what is being copied to what. */
function sameRoleSentence(u, req) {
  if (u.type === 'role') {
    return req.source.type === 'role'
      ? `"${u.roleTitle}" is the role you are copying from.`
      : `"${u.roleTitle}" is the role the seat you are copying from already holds.`;
  }
  return req.source.type === 'role'
    ? `${u.label} already holds "${u.roleTitle}", the role you are copying from.`
    : `${u.label} holds "${u.roleTitle}", the same role as the seat you are copying from.`;
}

/**
 * Reads everything and decides everything; writes nothing. `preview` returns it,
 * `execute` acts on it inside the same transaction, after locking the rows it
 * will touch — so the decision and the write see the same world.
 */
async function planCopy(db, c, req) {
  const { companyId } = c;
  const { mode, on } = req;
  const problems = [];

  // ── 1. what is being copied ──────────────────────────────────────────────
  if (mode === 'SEAT') {
    const off = req.kinds.filter((k) => !SEAT_KINDS.includes(k));
    if (off.length) {
      throw invalid(
        'KIND_NOT_ON_SEAT',
        `${cap(listWords(off.map((k) => noun(k))))} can't be added to a single seat — only KRAs, responsibilities and KPIs have a layer below the role. `
        + 'Add them to the role instead, or give the seat its own copy of the role.',
        { problems: off.map((k) => `${cap(noun(k))}: role level only`) },
      );
    }
  }
  const src = await loadSource(db, companyId, req.source, on);
  const inKinds = src.lines.filter((l) => req.kinds.includes(l.kind));
  let selected = inKinds;
  if (req.lines) {
    const wanted = new Set(req.lines);
    const known = new Set(inKinds.map((l) => l.key));
    const unknown = [...wanted].filter((k) => !known.has(k));
    if (unknown.length) {
      problems.push(`${plural(unknown.length, 'selected line is', 'selected lines are')} not in the source any more — reload and choose again.`);
    }
    selected = inKinds.filter((l) => wanted.has(l.key));
  }

  // ── 2. who it is going to ────────────────────────────────────────────────
  const roleRefs = req.targets.filter((t) => t.type === 'role').map((t) => t.id);
  const seatRefs = req.targets.filter((t) => t.type === 'position').map((t) => t.id);
  if (mode !== 'ROLE' && roleRefs.length) {
    throw invalid(
      'TARGET_NEEDS_SEAT',
      `${mode === 'SEAT' ? 'A seat-only copy' : 'Giving a seat its own role'} needs seats to copy to, and a role is not a seat. `
      + 'Pick seats, or choose "add to the role".',
    );
  }
  const roles = await loadRoles(db, companyId, roleRefs);
  const seats = await loadPositions(db, companyId, seatRefs);
  for (const id of roleRefs) if (!roles.has(id)) problems.push(`Role ${id} no longer exists.`);
  for (const id of seatRefs) if (!seats.has(id)) problems.push(`Position ${id} no longer exists.`);
  if (problems.length) throw invalid('INVALID', 'Some fields need attention.', { problems });

  // One receiving unit per role (ROLE) or per seat (SEAT, FORK).
  const units = [];
  if (mode === 'ROLE') {
    const byRole = new Map();
    for (const id of roleRefs) byRole.set(id, { roleId: id, via: [] });
    for (const id of seatRefs) {
      const s = seats.get(id);
      if (!byRole.has(s.roleId)) byRole.set(s.roleId, { roleId: s.roleId, via: [] });
      byRole.get(s.roleId).via.push(seatLabel(s));
    }
    const missing = [...byRole.keys()].filter((id) => !roles.has(id));
    for (const [id, r] of await loadRoles(db, companyId, missing)) roles.set(id, r);
    for (const u of byRole.values()) {
      const role = roles.get(u.roleId);
      units.push({ type: 'role', id: role.id, label: roleLabel(role), roleId: role.id, roleTitle: role.title, via: u.via });
    }
  } else {
    for (const id of seatRefs) {
      const s = seats.get(id);
      units.push({ type: 'position', id: s.id, label: seatLabel(s), roleId: s.roleId, roleTitle: s.roleTitle, seat: s, via: [] });
    }
  }

  // ── 3. RULE 3: the same role is refused, out loud ────────────────────────
  const same = units.filter((u) => u.roleId === src.roleId);
  if (same.length) {
    const lead = same.length === 1
      ? sameRoleSentence(same[0], req)
      : `${plural(same.length, 'target shares', 'targets share')} the role "${same[0].roleTitle}" with the source.`;
    throw conflict(
      'SAME_ROLE',
      `${lead} Everything the role says is already there, so copying it would change nothing. Nothing was written.`,
      { problems: same.map((u) => sameRoleSentence(u, req)) },
    );
  }

  // ── 4. what each target already carries ──────────────────────────────────
  const roleIds = [...new Set(units.map((u) => u.roleId))];
  const states = await loadRoleStates(db, companyId, roleIds, req.kinds);
  const overlays = mode === 'SEAT' ? await loadSeatOverlays(db, companyId, units.map((u) => u.id)) : null;

  // ── 5. reach ─────────────────────────────────────────────────────────────
  const seatIds = units.filter((u) => u.type === 'position').map((u) => u.id);
  const reach = await loadReach(db, companyId, { roleIds, positionIds: seatIds, on });
  const seatsOf = (roleId) => reach.seatsByRole.get(roleId) ?? 0;
  for (const u of units) {
    u.reach = u.type === 'role'
      ? { seats: seatsOf(u.id), people: reach.peopleByRole.get(u.id) ?? 0 }
      : { seats: 1, people: reach.peopleByPosition.get(u.id) ?? 0 };
  }
  const totalSeats = units.reduce((n, u) => n + u.reach.seats, 0);
  const totalPeople = mode === 'ROLE'
    ? await reach.distinctPeople('role_id', roleIds)
    : await reach.distinctPeople('position_id', seatIds);

  // What each way of copying WOULD reach — the numbers on the three cards, shown
  // before anyone chooses. A role target can only be copied to as a role.
  const reachByMode = {};
  const rolesReached = roleIds;
  const roleSeats = rolesReached.reduce((n, id) => n + seatsOf(id), 0);
  reachByMode.ROLE = {
    seats: roleSeats,
    people: mode === 'ROLE' ? totalPeople : await reach.distinctPeople('role_id', rolesReached),
    roles: rolesReached.length,
  };
  if (!roleRefs.length) {
    const seatPeople = mode === 'ROLE' ? await reach.distinctPeople('position_id', seatRefs) : totalPeople;
    reachByMode.SEAT = { seats: seatRefs.length, people: seatPeople, roles: 0 };
    reachByMode.FORK = { seats: seatRefs.length, people: seatPeople, roles: 0, newRoles: seatRefs.length };
  }

  // ── 6. FORK: the extra facts, and the new titles ─────────────────────────
  if (mode === 'FORK') {
    const ids = units.map((u) => u.id);
    const [moved] = await db.query(
      `SELECT wa.position_id, COUNT(*) AS n FROM hrms_work_assignments wa
         JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id
        WHERE wa.company_id = ? AND wa.deleted_at IS NULL AND wa.status IN (${qs(OPEN_ASSIGNMENT.length)})
          AND wa.role_id = p.role_id AND wa.position_id IN (${qs(ids.length)}) GROUP BY wa.position_id`,
      [companyId, ...OPEN_ASSIGNMENT, ...ids],
    );
    const [mp] = await db.query(
      `SELECT m.position_id, COUNT(*) AS n FROM hrms_manpower_requirements m
         JOIN hrms_positions p ON p.company_id = m.company_id AND p.id = m.position_id
        WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.role_id = p.role_id AND m.position_id IN (${qs(ids.length)})
        GROUP BY m.position_id`,
      [companyId, ...ids],
    );
    const [docs] = await db.query(
      `SELECT position_id, COUNT(*) AS n FROM hrms_generated_documents
        WHERE company_id = ? AND deleted_at IS NULL AND is_current = 1 AND document_type = 'ROLE_JD'
          AND position_id IN (${qs(ids.length)}) GROUP BY position_id`,
      [companyId, ...ids],
    );
    const num = (rows) => new Map(rows.map((r) => [r.position_id, Number(r.n)]));
    const movedBy = num(moved); const mpBy = num(mp); const docsBy = num(docs);
    if (req.forkTitle && units.length > 1) {
      throw invalid('INVALID', 'One title cannot name several new roles. Leave the title empty and each seat gets its own, or copy to one seat at a time.');
    }
    const titles = new Set();
    for (const u of units) {
      const title = req.forkTitle ?? `${u.roleTitle} — ${u.seat.code ?? u.seat.label}`;
      if (title.length > 200) throw invalid('INVALID', `The new role's title would be longer than 200 characters: "${title.slice(0, 60)}…".`);
      if (titles.has(title.toLowerCase())) {
        throw conflict('DUPLICATE_TITLE', `Two of the new roles would both be called "${title}". Give the seats distinct codes, or copy one at a time.`);
      }
      titles.add(title.toLowerCase());
      await assertTitleFree(db, companyId, title);
      u.fork = {
        newRoleTitle: title,
        assignmentsMoved: movedBy.get(u.id) ?? 0,
        manpowerMoved: mpBy.get(u.id) ?? 0,
        currentDocuments: docsBy.get(u.id) ?? 0,
      };
    }
  }

  // ── 7. decide ────────────────────────────────────────────────────────────
  for (const u of units) {
    const roleState = states.get(u.roleId);
    const overlay = overlays?.get(u.id) ?? null;
    const seen = new Set();
    u.decisions = {};
    u.counts = {};
    u.ungrouped = 0;

    // The KRAs this target will show once the copy is done — what a
    // responsibility or KPI can be filed under.
    const covered = new Set();
    for (const [d, row] of roleState.kras?.byDef ?? []) if (mode !== 'SEAT' || !ended(row.to, on)) covered.add(d);
    if (overlay) {
      for (const [key, to] of overlay.add) if (key.startsWith('kras:') && !ended(to, on)) covered.add(Number(key.slice(5)));
      for (const [key, to] of overlay.suppress) if (key.startsWith('kras:') && !ended(to, on)) covered.delete(Number(key.slice(5)));
    }

    for (const kind of req.kinds) {
      u.decisions[kind] = [];
      for (const line of selected.filter((l) => l.kind === kind)) {
        const d = mode === 'SEAT'
          ? decideOnSeat(line, roleState, overlay, seen, req, on, u.roleTitle)
          : decideOnRole(line, roleState, seen, req, u.roleTitle);
        u.decisions[kind].push({ line, ...d });
        if (d.outcome === 'CREATE' && kind === 'kras') covered.add(line.definitionId);
      }
    }
    for (const kind of req.kinds) {
      const ds = u.decisions[kind];
      for (const d of ds) {
        if (d.outcome === 'CREATE' && (kind === 'responsibilities' || kind === 'kpis')
          && d.line.parentKraDefinitionId != null && !covered.has(Number(d.line.parentKraDefinitionId))) u.ungrouped += 1;
      }
      u.counts[kind] = {
        selected: ds.length,
        created: ds.filter((d) => d.outcome === 'CREATE').length,
        reused: ds.filter((d) => d.outcome === 'REUSE').length,
        blocked: ds.filter((d) => d.outcome === 'BLOCK').length,
      };
    }
    u.covered = covered;
    u.roleState = roleState;
  }

  const totals = {
    targets: units.length,
    seats: totalSeats,
    people: totalPeople,
    selected: 0, created: 0, reused: 0, blocked: 0, ungrouped: 0,
    // A copy points at the existing master row. The masters never grow from it.
    definitionsCreated: 0,
    newRoles: mode === 'FORK' ? units.length : 0,
    assignmentsMoved: units.reduce((n, u) => n + (u.fork?.assignmentsMoved ?? 0), 0),
    manpowerMoved: units.reduce((n, u) => n + (u.fork?.manpowerMoved ?? 0), 0),
    byKind: {},
  };
  for (const kind of req.kinds) {
    const k = { selected: 0, created: 0, reused: 0, blocked: 0 };
    for (const u of units) for (const f of Object.keys(k)) k[f] += u.counts[kind][f];
    totals.byKind[kind] = k;
    for (const f of Object.keys(k)) totals[f] += k[f];
  }
  totals.ungrouped = units.reduce((n, u) => n + u.ungrouped, 0);

  return { req, src, selected, units, totals, reachByMode };
}

/* ── the plan as the screen sees it ─────────────────────────────────────── */

const fromWords = (src) => `${src.ref.label} (${src.ref.type === 'role' ? 'role' : 'seat'})`;

function noticesFor(plan) {
  const { req, units, totals, src } = plan;
  const out = [];
  const add = (tone, text) => out.push({ tone, text });
  if (req.mode === 'ROLE') {
    add('warning', `This changes ${units.length === 1 ? 'a role itself' : `${units.length} roles themselves`}, not a single seat: ${plural(totals.seats, 'seat', 'seats')}`
      + `${totals.people ? ` and ${plural(totals.people, 'person', 'people')} in them` : ''} will see these lines in their job descriptions.`);
  }
  if (req.mode === 'SEAT') {
    add('info', `${units.length === 1 ? 'The seat keeps its' : 'Each seat keeps its'} role unchanged. The lines are added as that seat's own exceptions, and each says where it was copied from.`);
  }
  if (req.mode === 'FORK') {
    add('info', 'Each seat moves onto a new role that starts as a copy of its current one. The old role, and every other seat on it, is not touched.');
    const docs = units.reduce((n, u) => n + (u.fork?.currentDocuments ?? 0), 0);
    if (docs) {
      add('info', `${plural(docs, 'job description', 'job descriptions')} already generated for ${docs === 1 ? 'this seat was' : 'these seats were'} written against the old role. ${docs === 1 ? 'It stays' : 'They stay'} as history; generate a new one to see the change.`);
    }
  }
  if (totals.ungrouped) {
    add('info', `${plural(totals.ungrouped, 'line', 'lines')} will sit under "Additional" because the KRA they were filed under in ${src.ref.label} isn't there. They still count.`);
  }
  if (totals.selected && !totals.created) add('info', 'Nothing to add — everything selected is already there.');
  return out;
}

function publicPlan(plan, { dryRun, extra = {} } = {}) {
  const { req, units, totals, src, reachByMode } = plan;
  return {
    ok: true,
    dryRun,
    mode: req.mode,
    asOf: req.on,
    source: src.ref,
    kinds: req.kinds,
    effectiveFrom: req.effectiveFrom,
    targets: units.map((u) => ({
      type: u.type,
      id: u.id,
      label: u.label,
      roleId: u.roleId,
      roleTitle: u.roleTitle,
      via: u.via,
      reach: u.reach,
      kinds: u.counts,
      ungrouped: u.ungrouped,
      fork: u.fork,
      exceptions: req.kinds.flatMap((kind) => u.decisions[kind]
        .filter((d) => d.outcome !== 'CREATE')
        .map((d) => ({
          key: d.line.key, kind, name: d.line.name, outcome: d.outcome === 'REUSE' ? 'REUSED' : 'BLOCKED', code: d.code, why: d.why,
        }))),
      ...(extra.units?.[`${u.type}:${u.id}`] ?? {}),
    })),
    totals,
    reachByMode,
    confirmSeats: totals.seats,
    needsSeatConfirmation: req.mode === 'ROLE',
    notices: noticesFor(plan),
  };
}

/** Preview: the plan, nothing written. The same function the write uses. */
export async function previewCopy(db, c, body) {
  const req = readCopyRequest(body);
  return publicPlan(await planCopy(db, c, req), { dryRun: true });
}

/* ══════════════════════════════════════════════════════════════════════════
 * Writing
 * ══════════════════════════════════════════════════════════════════════════ */

async function readKraMap(db, companyId, roleId) {
  const [rows] = await db.query(
    'SELECT id, kra_definition_id FROM hrms_role_kra_assignments WHERE company_id = ? AND role_id = ? AND deleted_at IS NULL',
    [companyId, roleId],
  );
  return new Map(rows.map((r) => [Number(r.kra_definition_id), r.id]));
}

/** New assignment rows on a role. The decisions were made in the plan; this only writes them. */
async function writeRoleRows(db, c, roleId, unit, req) {
  const written = {};
  const needsMap = ['responsibilities', 'kpis'].some((k) => (unit.decisions[k] ?? []).some((d) => d.outcome === 'CREATE'));
  let kraMap = needsMap ? await readKraMap(db, c.companyId, roleId) : null;

  for (const kind of req.kinds) {
    const lines = unit.decisions[kind].filter((d) => d.outcome === 'CREATE').map((d) => d.line);
    if (!lines.length) continue;
    const k = CONTENT[kind];
    const columns = ['company_id', 'role_id', k.def?.column, k.grouped ? 'role_kra_assignment_id' : null,
      ...COLS[kind], 'sequence', 'effective_from', 'effective_to', 'created_by'].filter(Boolean);
    const base = unit.roleState[kind]?.maxSeq ?? 0;
    const rows = lines.map((line, i) => [
      c.companyId, roleId,
      ...(k.def ? [line.definitionId] : []),
      ...(k.grouped ? [line.parentKraDefinitionId != null ? (kraMap?.get(Number(line.parentKraDefinitionId)) ?? null) : null] : []),
      ...COLS[kind].map((col) => line.cols[col] ?? null),
      base + i + 1, req.effectiveFrom, line.effectiveTo ?? null, c.userId,
    ]);
    await insertRows(db, k.table, columns, rows);
    written[kind] = lines.map((l) => l.definitionId ?? l.sourceRowId);
    if (kind === 'kras') kraMap = await readKraMap(db, c.companyId, roleId);
  }
  return written;
}

/** ADD overlays on one seat. Exactly one definition column is set per row, by construction. */
async function writeSeatRows(db, c, positionId, unit, req, reason) {
  const rows = [];
  const written = {};
  for (const kind of SEAT_KINDS) {
    for (const d of unit.decisions[kind] ?? []) {
      if (d.outcome !== 'CREATE') continue;
      const line = d.line;
      const parent = kind !== 'kras' && line.parentKraDefinitionId != null && unit.covered.has(Number(line.parentKraDefinitionId))
        ? line.parentKraDefinitionId : null;
      rows.push([
        c.companyId, positionId, CONTENT_TYPE[kind],
        kind === 'kras' ? line.definitionId : null,
        kind === 'responsibilities' ? line.definitionId : null,
        kind === 'kpis' ? line.definitionId : null,
        'ADD', parent,
        Object.keys(line.overlay).length ? JSON.stringify(line.overlay) : null,
        req.effectiveFrom, line.effectiveTo ?? null, reason, c.userId,
      ]);
      (written[kind] ??= []).push(line.definitionId);
    }
  }
  await insertRows(db, 'hrms_position_content_overrides', [
    'company_id', 'position_id', 'content_type', 'kra_definition_id', 'responsibility_definition_id', 'kpi_definition_id',
    'action', 'parent_kra_definition_id', 'override_json', 'effective_from', 'effective_to', 'reason', 'created_by',
  ], rows);
  return written;
}

/**
 * A faithful copy of a role's live content onto another role, set-based: one
 * INSERT … SELECT per table, no rows pass through the server. Responsibilities
 * and KPIs are re-filed under the NEW role's KRA rows by definition, the same
 * way getRoleContent groups them.
 */
async function cloneRoleContent(db, c, fromRoleId, toRoleId) {
  const cloned = {};
  for (const kind of ['kras', 'skills', 'qualifications', 'authorities', 'experience', 'relationships', 'conditions']) {
    const k = CONTENT[kind];
    const cols = [k.def?.column, ...COLS[kind], 'sequence', 'effective_from', 'effective_to'].filter(Boolean);
    const [r] = await db.query(
      `INSERT INTO ${k.table} (company_id, role_id, ${cols.join(', ')}, created_by)
       SELECT company_id, ?, ${cols.join(', ')}, ? FROM ${k.table}
        WHERE company_id = ? AND role_id = ? AND deleted_at IS NULL`,
      [toRoleId, c.userId, c.companyId, fromRoleId],
    );
    cloned[kind] = r.affectedRows;
  }
  for (const kind of ['responsibilities', 'kpis']) {
    const k = CONTENT[kind];
    const cols = [k.def.column, ...COLS[kind], 'sequence', 'effective_from', 'effective_to'];
    const [r] = await db.query(
      `INSERT INTO ${k.table} (company_id, role_id, ${cols.join(', ')}, role_kra_assignment_id, created_by)
       SELECT o.company_id, ?, ${cols.map((col) => `o.${col}`).join(', ')}, nk.id, ?
         FROM ${k.table} o
         LEFT JOIN hrms_role_kra_assignments ok ON ok.company_id = o.company_id AND ok.id = o.role_kra_assignment_id
         LEFT JOIN hrms_role_kra_assignments nk ON nk.company_id = o.company_id AND nk.role_id = ?
              AND nk.kra_definition_id = ok.kra_definition_id AND nk.deleted_at IS NULL
        WHERE o.company_id = ? AND o.role_id = ? AND o.deleted_at IS NULL`,
      [toRoleId, c.userId, toRoleId, c.companyId, fromRoleId],
    );
    cloned[kind] = r.affectedRows;
  }
  return cloned;
}

/** Locks the rows about to be written, so two copies to one seat cannot both see "not there yet". */
async function lockTargets(db, companyId, req) {
  const seatIds = req.targets.filter((t) => t.type === 'position').map((t) => t.id);
  const roleIds = req.targets.filter((t) => t.type === 'role').map((t) => t.id);
  if (seatIds.length) {
    await db.query(`SELECT id FROM hrms_positions WHERE company_id = ? AND id IN (${qs(seatIds.length)}) FOR UPDATE`, [companyId, ...seatIds]);
    if (req.mode === 'ROLE') {
      const [rows] = await db.query(
        `SELECT DISTINCT role_id FROM hrms_positions WHERE company_id = ? AND id IN (${qs(seatIds.length)})`,
        [companyId, ...seatIds],
      );
      roleIds.push(...rows.map((r) => r.role_id));
    }
  }
  if (roleIds.length) {
    const ids = [...new Set(roleIds)];
    await db.query(`SELECT id FROM hrms_roles WHERE company_id = ? AND id IN (${qs(ids.length)}) FOR UPDATE`, [companyId, ...ids]);
  }
}

/**
 * The write. Call it inside the caller's transaction.
 *
 * The caller must already have been checked for the permissions of the mode
 * (routes/roles.js). For ROLE, `confirm.seats` is REQUIRED and must equal the
 * seats the plan finds now: a role-wide change is only ever made by someone who
 * was shown how wide it is.
 */
export async function executeCopy(db, c, body) {
  const req = readCopyRequest(body);
  await lockTargets(db, c.companyId, req);
  const plan = await planCopy(db, c, req);

  const stale = (shown) => conflict(
    'STALE_COUNT',
    `You were shown ${plural(shown, 'seat', 'seats')}, but this now reaches ${plural(plan.totals.seats, 'seat', 'seats')}. Nothing was written — look again and confirm.`,
    { expected: shown, actual: plan.totals.seats },
  );
  if (req.mode === 'ROLE') {
    if (req.confirmSeats === null) {
      throw invalid(
        'CONFIRM_SEATS',
        `Adding to a role changes every seat that holds it. Preview first, then confirm the number — this would reach ${plural(plan.totals.seats, 'seat', 'seats')}.`,
      );
    }
    if (req.confirmSeats !== plan.totals.seats) throw stale(req.confirmSeats);
  } else if (req.confirmSeats !== null && req.confirmSeats !== plan.totals.seats) {
    throw stale(req.confirmSeats);
  }
  if (plan.totals.created > MAX_ROWS) {
    throw invalid('TOO_BIG', `That would write ${plan.totals.created} rows at once. Copy fewer lines or fewer places.`);
  }
  if (req.mode === 'FORK') {
    const idle = plan.units.filter((u) => !Object.values(u.counts).some((k) => k.created));
    if (idle.length) {
      throw conflict(
        'NOTHING_TO_FORK',
        `Everything selected is already on ${listWords(idle.map((u) => `"${u.roleTitle}"`))}, so a role of its own would be a copy with nothing new in it. Nothing was written.`,
      );
    }
  }

  const reason = `Copied from ${fromWords(plan.src)} on ${req.on}`.slice(0, 2000);
  const extra = { units: {} };

  for (const u of plan.units) {
    const summary = {
      copiedFrom: { type: req.source.type, id: req.source.id, label: plan.src.ref.label },
      mode: req.mode,
      asOf: req.on,
    };
    if (req.mode === 'SEAT') {
      const written = await writeSeatRows(db, c, u.id, u, req, reason);
      await audit(db, c, 'hrms_positions', u.id, 'UPDATE', null, { ...summary, overlaysAdded: written, reason });
    } else if (req.mode === 'ROLE') {
      const written = await writeRoleRows(db, c, u.id, u, req);
      await audit(db, c, 'hrms_roles', u.id, 'UPDATE', null, { ...summary, contentAdded: written });
    } else {
      const old = await requireRole(db, c.companyId, u.roleId);
      const [ins] = await db.query(
        `INSERT INTO hrms_roles (company_id, role_code, title, role_purpose, role_summary, default_department_id, status,
                                 effective_from, effective_to, created_by)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [c.companyId, u.fork.newRoleTitle, old.role_purpose, old.role_summary, old.default_department_id, old.status,
          old.effective_from, old.effective_to, c.userId],
      );
      const newRoleId = ins.insertId;
      const cloned = await cloneRoleContent(db, c, u.roleId, newRoleId);
      const written = await writeRoleRows(db, c, newRoleId, u, req);

      // The seat, its people and its headcount follow the role, together.
      await db.query('UPDATE hrms_positions SET role_id = ? WHERE company_id = ? AND id = ?', [newRoleId, c.companyId, u.id]);
      const [moved] = await db.query(
        `SELECT id FROM hrms_work_assignments WHERE company_id = ? AND deleted_at IS NULL AND position_id = ?
            AND role_id = ? AND status IN (${qs(OPEN_ASSIGNMENT.length)})`,
        [c.companyId, u.id, u.roleId, ...OPEN_ASSIGNMENT],
      );
      if (moved.length) {
        await db.query(
          `UPDATE hrms_work_assignments SET role_id = ? WHERE company_id = ? AND id IN (${qs(moved.length)})`,
          [newRoleId, c.companyId, ...moved.map((m) => m.id)],
        );
      }
      const [mp] = await db.query(
        'UPDATE hrms_manpower_requirements SET role_id = ? WHERE company_id = ? AND position_id = ? AND role_id = ? AND deleted_at IS NULL',
        [newRoleId, c.companyId, u.id, u.roleId],
      );
      await audit(db, c, 'hrms_roles', newRoleId, 'CREATE', null, {
        title: u.fork.newRoleTitle, forkedFrom: { id: u.roleId, title: u.roleTitle }, cloned, ...summary, contentAdded: written,
      });
      await audit(db, c, 'hrms_positions', u.id, 'UPDATE', { roleId: u.roleId }, {
        roleId: newRoleId, assignmentsMoved: moved.map((m) => m.id), manpowerMoved: mp.affectedRows,
      });
      extra.units[`${u.type}:${u.id}`] = {
        fork: { ...u.fork, newRoleId, cloned, assignmentsMoved: moved.length, manpowerMoved: mp.affectedRows },
      };
    }
  }

  return publicPlan(plan, { dryRun: false, extra });
}

export default { describeCopySource, previewCopy, executeCopy, permissionsForCopyMode, COPY_MODES, COPY_KINDS, SEAT_KINDS };
