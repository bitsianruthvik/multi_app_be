/**
 * jobContentService.js — a job's KRAs, with the responsibilities and KPIs under
 * each, as ONE shape the screens draw (the org chart panel, a role, a position,
 * a person, the Departments screen), plus the plain-language edits of that
 * content at each of its three layers.
 *
 * WHAT THIS FILE IS NOT. It is not a resolver. `contentResolver.resolveContent`
 * is the one implementation of Role -> Position -> Person (plan §2 rule 6) and
 * everything here reads its output. This file only
 *   - flattens that output into the lines a screen prints, each carrying a MARK
 *     that says whether the position (or the person) added it, changed it or
 *     switched it off, and
 *   - turns "add / change / switch off / undo for this position — or for this
 *     person" into the override rows `positionService` / `assignmentService`
 *     already know how to write.
 * A generated JD reads the same resolver, so the screen and the document cannot
 * disagree.
 *
 * THE RULE THE CLIENT SET (2026-10-10). KRAs are fixed at the ROLE. A position
 * (and a person, spec §16.2) may expand, change or contract the RESPONSIBILITIES,
 * the KPIs and a KPI's TARGET — never the KRAs.
 *
 * EVERY CHANGE IS DATED (spec §16.1). A change takes effect today, or on a later
 * day ("from 1 Nov"); a past day only for the Owner, with a reason. Nothing is
 * deleted: a change CLOSES the rows it replaces (effective_to = the day before)
 * and opens new ones (effective_from = that day), so the job as it stood on any
 * date is still there to read. A change of the same line on the same day
 * replaces the one made earlier that day (the old row's window becomes empty).
 *
 * HOW "CHANGE THE WORDING FOR THIS POSITION" IS STORED. The resolver cannot
 * rename a definition from an overlay ("define once, assign to a context"), and
 * a JD prints the definition's name. So a wording change is
 *     SUPPRESS the inherited line  +  ADD a new line, written for this position
 * The ADD's `override_json` carries `replacesDefinitionId` (and the SAME line
 * key as the line it replaces) so the two rows read as ONE change on screen and
 * in history ("this line, reworded") and are undone together. A change to a KPI
 * TARGET alone is a plain OVERRIDE of `targetOperator` / `targetValue`.
 *
 * THE PERSON LAYER (spec §16.2) is the same four verbs one layer down, stored
 * against the person's work assignment in the position they hold on that day —
 * so when they move, their own changes stay with the old position's assignment
 * (they end with it, history keeps them) and do not follow them.
 */
import { invalid, conflict, notFound, assertNoProblems } from '../lib/errors.js';
import { resolveContent, targetText, wireLayer } from './contentResolver.js';
import { requirePosition, addPositionOverride, dateText, today } from './positionService.js';
import { addAssignmentOverride } from './assignmentService.js';
import {
  requireRole, audit, createMasterItem, addContent, validateTarget, CONTENT,
  changeRoleLine, removeRoleLine, isoDate,
} from './roleContentService.js';
import { readTakesEffect, dayBefore, newLineKey, longDay, isVoid } from './datedChange.js';
import { readTargetInput, readTargetText, normaliseSpec } from './kpiTarget.js';
import { buildOrgChart } from './orgChartService.js';
import { SEATS_PER_POSITION, HOLDS_SEAT_SQL } from './seatCount.js';

const KINDS = ['RESPONSIBILITY', 'KPI'];
const DEF_COLUMN = { RESPONSIBILITY: 'responsibility_definition_id', KPI: 'kpi_definition_id' };
const DEF_FIELD = { RESPONSIBILITY: 'responsibilityDefinitionId', KPI: 'kpiDefinitionId' };
const MASTER_KIND = { RESPONSIBILITY: 'responsibilities', KPI: 'kpis' };
const ROLE_KIND = { RESPONSIBILITY: 'responsibilities', KPI: 'kpis' };
const NOUN = { RESPONSIBILITY: 'responsibility', KPI: 'KPI' };

/** The two overlay layers, by the name the resolver gives them. */
const LAYER = {
  POSITION: { table: 'hrms_position_content_overrides', owner: 'position_id', word: 'position', add: addPositionOverride },
  ASSIGNMENT: { table: 'hrms_work_assignment_content_overrides', owner: 'work_assignment_id', word: 'person', add: addAssignmentOverride },
};

const titleCase = (s) => (s ? String(s).replace(/_/g, ' ').toLowerCase().replace(/^./, (ch) => ch.toUpperCase()) : null);
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/**
 * A definition's name is 250 characters; a long duty is stored with its name cut
 * short and ending "..." and the whole sentence in the description (the importer
 * does this, and so does a line written here). On screen that is ONE sentence —
 * the whole one — not a cut-off line with its own text repeated under it.
 */
const NAME_MAX = 250;
const cutShort = (name, description) => {
  const n = String(name ?? '').trim();
  const d = String(description ?? '').trim();
  if (!d || !/(\.\.\.|…)$/.test(n)) return false;
  const stem = n.replace(/(\.\.\.|…)$/, '').trim().toLowerCase();
  return stem.length > 0 && d.toLowerCase().startsWith(stem);
};
const wordingOf = (name, description) => (cutShort(name, description) ? String(description).trim() : name);
const nameFor = (text) => (text.length > NAME_MAX ? `${text.slice(0, NAME_MAX - 3).trimEnd()}...` : text);

/* ══════════════════════════════════════════════════════════════════════════
 * The read — one shape for a role, a position and a person
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * One printed line. `mark` is the provenance story in one word, at the layer
 * `markLayer` says ('POSITION' | 'PERSON'):
 *   null      as the layer above says it
 *   ADDED     specific to this position / this person
 *   CHANGED   the layer above says something else (`was` holds what)
 *   OFF       the layer above says it and this position / person does not do it
 * `layer` / `since` / `changedFrom` (spec §16.3): which layer last shaped the
 * line, from which day, and the wording or target it replaced.
 */
function lineOf(item, ctx) {
  const line = {
    key: item.key,
    kind: item.kind,
    definitionId: item.definitionId,
    lineKey: item.lineKey ?? null,
    name: wordingOf(item.name, item.description),
    description: item.description && !same(item.description, item.name) && !cutShort(item.name, item.description)
      ? item.description
      : null,
    detail: null,
    mark: null,
    markLayer: null,
    was: null,
    reason: item.reason ?? null,
    overrideIds: [],
    replacesDefinitionId: null,
    // The role's own assignment row, when the role introduced the line — what the
    // role editor edits, moves and removes. Null for a line a position or person added.
    roleRowId: item.origin === 'ROLE' ? item.sourceRowId : null,
    parentKraDefinitionId: item.parentKraDefinitionId ?? null,
    note: item.orphanNote ?? null,
    layer: item.layer ?? 'ROLE',
    since: item.since ?? null,
    changedFrom: item.changedFrom ?? null,
  };

  if (item.kind === 'KPI') {
    line.targetText = item.targetText ?? null;
    line.targetOperator = item.targetOperator ?? null;
    line.targetValue = item.targetValue ?? null;
    line.measurementType = item.measurementType ?? null;
    line.unit = item.unit ?? null;
    line.direction = item.direction ?? null;
    // Spec §24 step 2: what this line stores, and the target as it applies (the library KPI's
    // measured-in and which-way over the line's number) — null when it is words.
    line.targetSpec = item.targetSpec ?? null;
    line.structured = item.structured ?? null;
    line.frequency = item.frequency ?? null;
    line.detail = [item.targetText, titleCase(item.frequency)].filter(Boolean).join(' · ') || null;
  } else if (item.responsibilityClass && item.responsibilityClass !== 'GENERIC') {
    line.detail = titleCase(item.responsibilityClass);
  }

  if (item.origin !== 'ROLE' && ctx.layers.includes(item.origin)) {
    const row = ctx.rowOf(item.origin, item.sourceRowId);
    const replaces = row?.overrideJson?.replacesDefinitionId ?? null;
    line.mark = replaces ? 'CHANGED' : 'ADDED';
    line.markLayer = wireLayer(item.origin);
    line.replacesDefinitionId = replaces ? Number(replaces) : null;
    line.overrideIds = [Number(item.sourceRowId)];
    line.seatAuthored = row?.overrideJson?.seatAuthored === true;
    line.origin = wireLayer(item.origin);
  } else {
    line.origin = item.origin === 'ROLE' ? 'ROLE' : wireLayer(item.origin);
    const changes = (item.changes ?? []).filter((c) => ctx.layers.includes(c.byLayer));
    if (item.overridden && changes.length) {
      const last = changes[changes.length - 1].byLayer;
      line.mark = 'CHANGED';
      line.markLayer = wireLayer(last);
      line.overrideIds = [...new Set(changes.filter((c) => c.byLayer === last).map((c) => Number(c.byOverrideId)))];
      line.was = wasText(item, last);
    }
  }
  return line;
}

/** "Role target: 95%" — what the layer above said before this layer changed it. */
function wasText(item, layer) {
  const all = item.changes ?? [];
  const changes = all.filter((c) => c.byLayer === layer);
  const firstOf = (field) => changes.find((c) => c.field === field);
  const above = layer === 'ASSIGNMENT' && all.some((c) => c.byLayer === 'POSITION') ? 'Position' : 'Role';
  const bits = [];
  if (item.kind === 'KPI' && (firstOf('targetValue') || firstOf('targetOperator'))) {
    const operator = firstOf('targetOperator') ? firstOf('targetOperator').from : item.targetOperator;
    const value = firstOf('targetValue') ? firstOf('targetValue').from : item.targetValue;
    bits.push(`${above} target: ${targetText(operator, value, item.measurementType, item.unit)}`);
  }
  const LABEL = {
    weightPercent: 'weight', frequency: 'frequency', isMandatory: 'mandatory',
    responsibilityClass: 'class', notes: 'notes', description: 'description', sequence: 'order',
  };
  const other = [...new Set(changes.map((c) => c.field))].filter((f) => LABEL[f]).map((f) => LABEL[f]);
  if (other.length) bits.push(`Also changed here: ${other.join(', ')}`);
  return bits.join('. ') || (layer === 'ASSIGNMENT' ? 'Changed for this person' : 'Changed for this position');
}

/** A line switched off at a layer, rebuilt from the resolver's `suppressed` entry. */
function offLine(s) {
  return {
    key: `${s.kind}:${s.definitionId}`,
    kind: s.kind,
    definitionId: s.definitionId,
    lineKey: s.lineKey ?? null,
    name: s.name,
    description: null,
    detail: s.kind === 'KPI' ? s.targetText ?? null : null,
    mark: 'OFF',
    markLayer: wireLayer(s.byLayer),
    was: null,
    reason: s.reason ?? null,
    overrideIds: [Number(s.byOverrideId)],
    replacesDefinitionId: null,
    roleRowId: null,
    parentKraDefinitionId: s.parentKraDefinitionId ?? null,
    note: null,
    layer: wireLayer(s.byLayer),
    since: s.since ?? null,
    changedFrom: null,
    origin: s.origin === 'ROLE' ? 'ROLE' : wireLayer(s.origin),
  };
}

const SUBJECT_LAYERS = { ROLE: [], SEAT: ['POSITION'], PERSON: ['POSITION', 'ASSIGNMENT'] };

function shape(resolved, subject, extra = {}) {
  const layers = SUBJECT_LAYERS[subject];
  const rows = new Map();
  for (const o of resolved.overlay?.position ?? []) rows.set(`POSITION:${o.id}`, o);
  for (const o of resolved.overlay?.assignment ?? []) rows.set(`ASSIGNMENT:${o.id}`, o);
  const ctx = { layers, rowOf: (layer, id) => rows.get(`${layer}:${Number(id)}`) ?? null };
  const on = resolved.asOf;
  const live = (o) => (!o.effectiveFrom || o.effectiveFrom <= on) && (!o.effectiveTo || o.effectiveTo >= on);

  const suppressed = (resolved.suppressed ?? []).filter((s) => KINDS.includes(s.kind) && layers.includes(s.byLayer));

  const kras = resolved.kras.map((k) => ({
    key: k.key,
    definitionId: k.definitionId,
    lineKey: k.lineKey ?? null,
    // The role's own KRA row — what rename, delete and "move a line here" address.
    roleRowId: k.origin === 'ROLE' ? k.sourceRowId : null,
    name: k.name,
    description: k.description ?? null,
    weightPercent: k.weightPercent ?? null,
    mark: k.origin !== 'ROLE' ? 'ADDED' : (k.overridden ? 'CHANGED' : null),
    overrideIds: k.origin !== 'ROLE' ? [Number(k.sourceRowId)] : [],
    layer: k.layer ?? 'ROLE',
    since: k.since ?? null,
    changedFrom: k.changedFrom ?? null,
    responsibilities: k.responsibilities.map((i) => lineOf(i, ctx)),
    kpis: k.kpis.map((i) => lineOf(i, ctx)),
  }));
  const ungrouped = {
    responsibilities: resolved.additional.responsibilities.map((i) => lineOf(i, ctx)),
    kpis: resolved.additional.kpis.map((i) => lineOf(i, ctx)),
  };
  const kraByDefinition = new Map(kras.map((k) => [Number(k.definitionId), k]));

  // A wording change is two rows that are one change: fold the switched-off line
  // into its replacement at the same layer, so it is shown once.
  const everyLine = [
    ...kras.flatMap((k) => [...k.responsibilities, ...k.kpis]),
    ...ungrouped.responsibilities, ...ungrouped.kpis,
  ];
  const replacements = everyLine.filter((l) => l.replacesDefinitionId);
  for (const s of suppressed) {
    const replacement = replacements.find((l) => l.kind === s.kind && l.markLayer === wireLayer(s.byLayer)
      && (Number(l.replacesDefinitionId) === Number(s.definitionId) || (l.lineKey && l.lineKey === s.lineKey)));
    if (replacement) {
      const above = s.origin === 'POSITION' ? 'The position says' : 'The role says';
      replacement.was = `${above}: ${s.name}`;
      replacement.roleWording = s.name;
      replacement.overrideIds.push(Number(s.byOverrideId));
      replacement.folded = true;
      continue;
    }
    const line = offLine(s);
    const parent = kraByDefinition.get(Number(s.parentKraDefinitionId));
    line.parentKraDefinitionId = parent ? parent.definitionId : null;
    const into = s.kind === 'KPI' ? 'kpis' : 'responsibilities';
    (parent ?? ungrouped)[into].push(line);
  }
  // A replacement whose replaced line is no longer switched off is simply the layer's own line.
  for (const l of everyLine) {
    if (l.replacesDefinitionId && !l.folded) { l.mark = 'ADDED'; l.replacesDefinitionId = null; }
    delete l.folded;
  }

  const all = [
    ...kras.flatMap((k) => [...k.responsibilities, ...k.kpis]),
    ...ungrouped.responsibilities, ...ungrouped.kpis,
  ];
  const shown = all.filter((l) => l.mark !== 'OFF');
  const overlayRows = [
    ...(layers.includes('POSITION') ? (resolved.overlay?.position ?? []).map((o) => ['POSITION', o]) : []),
    ...(layers.includes('ASSIGNMENT') ? (resolved.overlay?.assignment ?? []).map((o) => ['ASSIGNMENT', o]) : []),
  ];

  return {
    asOf: resolved.asOf,
    subject,                                  // 'ROLE' | 'SEAT' | 'PERSON'
    roleId: resolved.target.roleId,
    roleTitle: resolved.target.roleTitle,
    positionId: resolved.target.positionId,
    ...extra,
    kras,
    ungrouped,
    counts: {
      kras: kras.length,
      responsibilities: shown.filter((l) => l.kind === 'RESPONSIBILITY').length,
      kpis: shown.filter((l) => l.kind === 'KPI').length,
      ungrouped: ungrouped.responsibilities.length + ungrouped.kpis.length,
      added: all.filter((l) => l.mark === 'ADDED').length,
      changed: all.filter((l) => l.mark === 'CHANGED').length,
      off: all.filter((l) => l.mark === 'OFF').length,
    },
    /**
     * Rows that touch a KRA. The rule is that KRAs are fixed at the role, so the
     * screens offer no way to write one — but a row written before the rule (or
     * through the raw override endpoint) still resolves, and hiding it would
     * make the KRAs differ from the role's for no visible reason.
     */
    kraExceptions: overlayRows
      .filter(([, o]) => o.contentType === 'KRA' && live(o))
      .map(([layer, o]) => ({ overrideId: o.id, layer: wireLayer(layer), action: o.action, name: o.definitionName ?? null, reason: o.reason ?? null })),
    /** Rows that changed nothing, each with the reason — never silent. */
    ignored: (resolved.overlay?.ignored ?? [])
      .filter((i) => layers.includes(i.layer))
      .map((i) => ({ overrideId: i.overrideId, layer: wireLayer(i.layer), name: i.name ?? null, why: i.why })),
  };
}

/** A ROLE's job content: what every position holding it starts from. */
export async function roleJobContent(db, companyId, roleId, { on } = {}) {
  const resolved = await resolveContent(db, companyId, { roleId, on });
  return shape(resolved, 'ROLE');
}

/** A POSITION's job content: its role's, with this position's own changes applied and marked. */
export async function positionJobContent(db, companyId, positionId, { on } = {}) {
  const position = await requirePosition(db, companyId, positionId);
  const resolved = await resolveContent(db, companyId, { roleId: position.role_id, positionId, on });
  // How many OTHER positions hold the same role — so "for this position only" has a number beside it.
  const [[others]] = await db.query(
    `SELECT COUNT(*) AS n FROM hrms_positions
      WHERE company_id = ? AND role_id = ? AND id <> ? AND deleted_at IS NULL AND status <> 'CLOSED'`,
    [companyId, position.role_id, positionId],
  );
  return shape(resolved, 'SEAT', {
    positionTitle: position.position_title ?? resolved.target.roleTitle ?? null,
    positionCode: position.position_code ?? null,
    otherSeatsOnRole: Number(others.n ?? 0),
  });
}

/* ── the person ─────────────────────────────────────────────────────────── */

async function requireEmployee(db, companyId, employeeId) {
  const [[e]] = await db.query(
    'SELECT id, employee_code, full_name, employment_status FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL',
    [companyId, employeeId],
  );
  if (!e) throw notFound('Employee');
  return e;
}

/** The assignment through which a person holds a position on a day (primary first), or null. */
export async function seatHeldOn(db, companyId, employeeId, on) {
  const [[a]] = await db.query(
    `SELECT wa.id, wa.position_id, wa.role_id, wa.effective_from, wa.effective_to,
            p.position_code, COALESCE(p.position_title, r.title) AS position_title, p.role_id AS position_role_id
       FROM hrms_work_assignments wa
       JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id
       LEFT JOIN hrms_roles r ON r.company_id = p.company_id AND r.id = p.role_id
      WHERE wa.company_id = ? AND wa.employee_id = ? AND ${HOLDS_SEAT_SQL('wa')}
        AND (wa.effective_from IS NULL OR wa.effective_from <= ?) AND (wa.effective_to IS NULL OR wa.effective_to >= ?)
      ORDER BY wa.is_primary DESC, wa.effective_from DESC, wa.id DESC
      LIMIT 1`,
    [companyId, employeeId, on, on],
  );
  return a ?? null;
}

/**
 * A PERSON's job content (spec §16.2): their position's — role, then the
 * position's changes — and then their own, each marked with its layer. A person
 * in no position on that day has no job content; the answer says so.
 */
export async function employeeJobContent(db, companyId, employeeId, { on } = {}) {
  const date = dateText(on) || today();
  const e = await requireEmployee(db, companyId, employeeId);
  const person = { employeeId: e.id, employeeName: e.full_name, employeeCode: e.employee_code ?? null };
  const a = await seatHeldOn(db, companyId, employeeId, date);
  if (!a) {
    return {
      asOf: date, subject: 'PERSON', roleId: null, roleTitle: null, positionId: null, ...person,
      workAssignmentId: null, positionTitle: null, positionCode: null, notInPosition: true,
      kras: [], ungrouped: { responsibilities: [], kpis: [] },
      counts: { kras: 0, responsibilities: 0, kpis: 0, ungrouped: 0, added: 0, changed: 0, off: 0 },
      kraExceptions: [], ignored: [],
    };
  }
  const resolved = await resolveContent(db, companyId, { workAssignmentId: a.id, on: date });
  return shape(resolved, 'PERSON', {
    ...person,
    workAssignmentId: a.id,
    positionTitle: a.position_title ?? null,
    positionCode: a.position_code ?? null,
    notInPosition: false,
  });
}

/* ══════════════════════════════════════════════════════════════════════════
 * Edits at a layer — Add, Change, Switch off, Undo
 * ══════════════════════════════════════════════════════════════════════════
 * One implementation for both layers; `t` says which:
 *   { layer: 'POSITION', ownerId: positionId, positionId }
 *   { layer: 'ASSIGNMENT', ownerId: workAssignmentId, positionId, workAssignmentId, employeeId }
 * Each writes in the caller's transaction and answers with the job content AFTER
 * the edit (as on today), so the screen needs no second request.
 */

function readKind(value) {
  const kind = String(value ?? '').trim().toUpperCase();
  if (kind === 'KRA') {
    throw invalid('KRA_FIXED_AT_ROLE', 'KRAs are set on the role and are the same for every position holding it. Change them on the role.');
  }
  if (!KINDS.includes(kind)) throw invalid('INVALID', 'Say whether this is a responsibility or a KPI.');
  return kind;
}

function readText(value, label, problems, { required = true, max = 2000 } = {}) {
  const s = value == null ? '' : String(value).trim();
  if (!s) { if (required) problems.push(`${label} is required.`); return null; }
  if (s.length > max) problems.push(`${label} is up to ${max} characters.`);
  return s;
}

/**
 * A target as the screen sends it -> the three json fields an override carries.
 *   { text } | { value } | { min, max } | { date } | { done: true }   (spec §24 step 2, kpiTarget.readTargetInput)
 *   { operator, value }                                               the older form, still read
 * `line` is the line as it reads on that day: its KPI's measured-in, unit and which way. A structured
 * target writes its text from the structure; free text is kept as typed, its structure filled when
 * it reads cleanly. An empty box is "no target", not a target that failed validation.
 */
function readTarget(target, line, problems) {
  if (target == null) return null;
  const def = { measurementType: line?.measurementType ?? null, unit: line?.unit ?? null, direction: line?.direction ?? null };
  const name = line?.name ?? '';
  if (target.operator === undefined) {
    const before = problems.length;
    const t = readTargetInput(target, def, problems, { name });
    if (problems.length > before || t.empty) return null;
    return { targetOperator: 'EQ', targetValue: t.text, targetSpec: t.spec };
  }
  if (!target.operator && (target.value == null || String(target.value).trim() === '')) return null;
  const measurementType = line?.measurementType ?? null;
  const operator = String(target.operator ?? (measurementType === 'TEXT' ? 'EQ' : '')).trim().toUpperCase() || null;
  const before = problems.length;
  const stored = validateTarget(operator, target.value, measurementType ?? 'NUMBER', problems);
  if (problems.length > before) return null;
  const value = stored == null ? null : JSON.parse(stored);
  const spec = operator === 'EQ' && typeof value === 'string' ? normaliseSpec(readTargetText(value, { def, name })) : null;
  return { targetOperator: operator ?? 'INFO', targetValue: value, targetSpec: spec };
}

const resolveFor = (db, companyId, t, on) => (t.layer === 'ASSIGNMENT'
  ? resolveContent(db, companyId, { workAssignmentId: t.workAssignmentId, on })
  : resolveContent(db, companyId, { roleId: t.roleId, positionId: t.positionId, on }));

const readAfter = (db, companyId, t) => (t.layer === 'ASSIGNMENT'
  ? employeeJobContent(db, companyId, t.employeeId)
  : positionJobContent(db, companyId, t.positionId));

/** Every line the job resolves to on `on`, flat, with the role's KRAs. */
async function currentLines(db, companyId, t, on) {
  const resolved = await resolveFor(db, companyId, t, on);
  const lines = [
    ...resolved.kras.flatMap((k) => [...k.responsibilities, ...k.kpis]),
    ...resolved.additional.responsibilities, ...resolved.additional.kpis,
  ];
  return { resolved, lines };
}

/** This layer's rows that have not ended before `on` (a row dated ahead included). */
async function openRows(db, companyId, t, on) {
  const L = LAYER[t.layer];
  const [rows] = await db.query(
    `SELECT id, content_type, action, responsibility_definition_id, kpi_definition_id, parent_kra_definition_id,
            override_json, reason, effective_from, effective_to, line_key
       FROM ${L.table}
      WHERE company_id = ? AND ${L.owner} = ? AND deleted_at IS NULL AND (effective_to IS NULL OR effective_to >= ?)`,
    [companyId, t.ownerId, on],
  );
  return rows
    .map((r) => ({
      ...r,
      from: dateText(r.effective_from),
      json: r.override_json == null ? null : (typeof r.override_json === 'string' ? JSON.parse(r.override_json) : r.override_json),
    }))
    .filter((r) => !isVoid(r));
}

/**
 * This layer's rows on one line: by definition — and, for a line this layer did
 * not write, by the line's identity too (an OVERRIDE or SUPPRESS written before
 * the role reworded the line still belongs to it).
 */
const rowsOfLine = (rows, line, layer) => rows.filter((o) => o.content_type === line.kind && (
  Number(o[DEF_COLUMN[line.kind]]) === Number(line.definitionId)
  || (line.origin !== layer && o.action !== 'ADD' && line.lineKey && o.line_key === line.lineKey)));

/** A row of this line that began after `on` and has ALREADY begun is history: refused. */
function refuseRewrite(rows, on) {
  const now = today();
  const begun = rows.find((r) => r.from && r.from > on && r.from <= now);
  if (begun) {
    throw conflict('LATER_CHANGE', `This line changed again on ${longDay(begun.from)}. A change dated before that would rewrite what came after it — date it ${longDay(begun.from)} or later.`);
  }
}

/** Ends rows the day before `on` (a row dated on or after `on` is cancelled: its window empties). */
async function closeRows(db, c, t, rows, on) {
  if (!rows.length) return;
  const L = LAYER[t.layer];
  const end = dayBefore(on);
  await db.query(
    `UPDATE ${L.table} SET effective_to = ?, ended_by = ? WHERE company_id = ? AND id IN (${rows.map(() => '?').join(',')})`,
    [end, c.userId, c.companyId, ...rows.map((r) => r.id)],
  );
  for (const r of rows) {
    await audit(db, c, L.table, r.id, 'UPDATE',
      { action: r.action, contentType: r.content_type, definitionId: r.responsibility_definition_id ?? r.kpi_definition_id, effectiveFrom: r.from },
      { endedOn: end, cancelled: Boolean(r.from && r.from >= on) });
  }
}

async function writeOverride(db, c, t, body, on) {
  const L = LAYER[t.layer];
  const { id } = await L.add(db, c, t.ownerId, { ...body, effectiveFrom: on });
  await audit(db, c, L.table, id, 'CREATE', null, { [L.owner]: t.ownerId, ...body, takesEffect: on });
  return id;
}

async function writeOwnDefinition(db, c, kind, text, like = null) {
  const body = kind === 'KPI'
    ? {
      name: nameFor(text),
      description: text.length > NAME_MAX ? text : null,
      measurementType: like?.measurementType ?? 'TEXT',
      unit: like?.unit ?? null,
      direction: like?.direction ?? null,
      defaultFrequency: like?.frequency ?? null,
      status: 'ACTIVE',
    }
    : { name: nameFor(text), description: text, responsibilityClass: like?.responsibilityClass ?? null, status: 'ACTIVE' };
  return createMasterItem(db, c, MASTER_KIND[kind], body);
}

const ownWord = (t) => (t.layer === 'ASSIGNMENT' ? 'This person' : 'This position');

/** ADD — a responsibility or a KPI for this position (or person) only, under one of the role's KRAs or none. */
async function layerAddLine(db, c, t, body = {}) {
  const kind = readKind(body.kind);
  const when = readTakesEffect(body, c);
  const problems = [];
  const text = readText(body.text, kind === 'KPI' ? 'The KPI' : 'The responsibility', problems);
  const reason = readText(body.reason, 'Reason', problems, { required: false, max: 2000 });
  const target = kind === 'KPI' ? readTarget(body.target, { measurementType: 'TEXT', name: text ?? '' }, problems) : null;
  assertNoProblems(problems);

  const { resolved, lines } = await currentLines(db, c.companyId, t, when.on);
  if (lines.some((l) => l.kind === kind && same(wordingOf(l.name, l.description), text))) {
    throw conflict('ALREADY_THERE', `${ownWord(t)} already has that ${NOUN[kind]}.`);
  }
  const parent = body.parentKraDefinitionId == null || body.parentKraDefinitionId === '' ? null : Number(body.parentKraDefinitionId);
  if (parent != null && !resolved.kras.some((k) => Number(k.definitionId) === parent)) {
    throw invalid('BAD_REFERENCE', 'Pick one of the KRAs of the role. A position or a person cannot have a KRA its role does not have.');
  }

  const definition = await writeOwnDefinition(db, c, kind, text);
  await writeOverride(db, c, t, {
    contentType: kind,
    action: 'ADD',
    [DEF_FIELD[kind]]: definition.id,
    parentKraDefinitionId: parent,
    overrideJson: { seatAuthored: true, ...(target ?? {}) },
    reason,
    lineKey: newLineKey(),
  }, when.on);
  return readAfter(db, c.companyId, t);
}

/** CHANGE — the wording of a line, or a KPI's target, for this position (or person) only. */
async function layerChangeLine(db, c, t, body = {}) {
  const kind = readKind(body.kind);
  const definitionId = Number(body.definitionId);
  const when = readTakesEffect(body, c);
  const { resolved, lines } = await currentLines(db, c.companyId, t, when.on);
  const line = lines.find((l) => l.kind === kind && Number(l.definitionId) === definitionId);
  if (!line) throw notFound(`That ${NOUN[kind]} on ${longDay(when.on)}`);

  const problems = [];
  const text = body.text === undefined ? null : readText(body.text, 'The wording', problems);
  const reason = readText(body.reason, 'Reason', problems, { required: false, max: 2000 });
  const target = kind === 'KPI' && body.target !== undefined ? readTarget(body.target, line, problems) : null;
  assertNoProblems(problems);

  const rewording = text != null && !same(text, wordingOf(line.name, line.description));
  if (!rewording && !target) throw invalid('NOTHING_TO_CHANGE', 'Nothing was changed.');
  if (rewording && lines.some((l) => l !== line && l.kind === kind && same(wordingOf(l.name, l.description), text))) {
    throw conflict('ALREADY_THERE', `${ownWord(t)} already has a ${NOUN[kind]} with that wording.`);
  }

  const rows = await openRows(db, c.companyId, t, when.on);
  const mine = rowsOfLine(rows, line, t.layer);
  refuseRewrite(mine, when.on);
  const owned = line.origin === t.layer;
  const lineKey = line.lineKey ?? null;

  if (!rewording) {
    // Target only. One row says it from that day: the row(s) that said it before end the day before.
    if (owned) {
      const add = mine.find((o) => o.action === 'ADD');
      await closeRows(db, c, t, mine.filter((o) => o.action === 'ADD'), when.on);
      await writeOverride(db, c, t, {
        contentType: kind, action: 'ADD', [DEF_FIELD[kind]]: definitionId,
        parentKraDefinitionId: add?.parent_kra_definition_id ?? line.parentKraDefinitionId ?? null,
        overrideJson: { ...(add?.json ?? {}), ...target },
        reason: reason ?? add?.reason ?? null,
        lineKey: add?.line_key ?? lineKey ?? newLineKey(),
      }, when.on);
    } else {
      const earlier = mine.filter((o) => o.action === 'OVERRIDE');
      // Keep anything else an earlier override said (a weight, a frequency).
      const carried = Object.assign({}, ...earlier.map((o) => o.json ?? {}));
      await closeRows(db, c, t, earlier, when.on);
      await writeOverride(db, c, t, {
        contentType: kind, action: 'OVERRIDE', [DEF_FIELD[kind]]: definitionId,
        overrideJson: { ...carried, ...target },
        reason,
        lineKey: lineKey ?? newLineKey(),
      }, when.on);
    }
    return readAfter(db, c.companyId, t);
  }

  // Wording. This layer gets a line of its own; the inherited line is switched off — the same line, reworded.
  const definition = await writeOwnDefinition(db, c, kind, text, line);
  const carriedTarget = kind === 'KPI'
    ? (target ?? { targetOperator: line.targetOperator ?? 'INFO', targetValue: line.targetValue ?? null, targetSpec: line.targetSpec ?? null })
    : {};
  if (owned) {
    const add = mine.find((o) => o.action === 'ADD');
    await closeRows(db, c, t, mine, when.on);
    await writeOverride(db, c, t, {
      contentType: kind, action: 'ADD', [DEF_FIELD[kind]]: definition.id,
      parentKraDefinitionId: add?.parent_kra_definition_id ?? line.parentKraDefinitionId ?? null,
      overrideJson: { ...(add?.json ?? {}), seatAuthored: true, ...carriedTarget },
      reason: reason ?? add?.reason ?? null,
      lineKey: add?.line_key ?? lineKey ?? newLineKey(),
    }, when.on);
  } else {
    await closeRows(db, c, t, mine, when.on);
    await writeOverride(db, c, t, { contentType: kind, action: 'SUPPRESS', [DEF_FIELD[kind]]: definitionId, reason, lineKey }, when.on);
    const parentStillThere = line.parentKraDefinitionId != null
      && resolved.kras.some((k) => Number(k.definitionId) === Number(line.parentKraDefinitionId));
    await writeOverride(db, c, t, {
      contentType: kind, action: 'ADD', [DEF_FIELD[kind]]: definition.id,
      parentKraDefinitionId: parentStillThere ? line.parentKraDefinitionId : null,
      overrideJson: { seatAuthored: true, replacesDefinitionId: definitionId, sequence: line.sequence, ...carriedTarget },
      reason,
      lineKey: lineKey ?? newLineKey(),
    }, when.on);
  }
  return readAfter(db, c.companyId, t);
}

/** SWITCH OFF — a line that does not apply to this position (or person) from that day. */
async function layerSwitchOffLine(db, c, t, body = {}) {
  const kind = readKind(body.kind);
  const definitionId = Number(body.definitionId);
  const when = readTakesEffect(body, c);
  const problems = [];
  const reason = readText(body.reason, 'Reason', problems, { required: false, max: 2000 });
  assertNoProblems(problems);

  const { lines } = await currentLines(db, c.companyId, t, when.on);
  const line = lines.find((l) => l.kind === kind && Number(l.definitionId) === definitionId);
  if (!line) throw notFound(`That ${NOUN[kind]} on ${longDay(when.on)}`);

  const rows = await openRows(db, c.companyId, t, when.on);
  const mine = rowsOfLine(rows, line, t.layer);
  refuseRewrite(mine, when.on);

  if (line.origin === t.layer) {
    // This layer's own line. Switching it off is ending it; if it replaced an
    // inherited line, that line stays switched off — which is what was asked for.
    await closeRows(db, c, t, mine, when.on);
  } else {
    await closeRows(db, c, t, mine, when.on);
    await writeOverride(db, c, t, {
      contentType: kind, action: 'SUPPRESS', [DEF_FIELD[kind]]: definitionId, reason, lineKey: line.lineKey ?? null,
    }, when.on);
  }
  return readAfter(db, c.companyId, t);
}

/**
 * UNDO — put one line back to what the layer above says, from that day. Ends
 * every row this layer holds on it; for a wording change that is the layer's
 * line AND the switch-off of the line it replaced, together.
 */
async function layerUndoLine(db, c, t, body = {}) {
  const kind = readKind(body.kind);
  const definitionId = Number(body.definitionId);
  const when = readTakesEffect(body, c);
  const { resolved, lines } = await currentLines(db, c.companyId, t, when.on);
  const shown = lines.find((l) => l.kind === kind && Number(l.definitionId) === definitionId);
  const off = (resolved.suppressed ?? []).find((s) => s.kind === kind && Number(s.definitionId) === definitionId && s.byLayer === t.layer);
  const line = shown ?? (off ? { kind, definitionId, lineKey: off.lineKey ?? null, origin: off.origin } : { kind, definitionId, lineKey: null, origin: 'ROLE' });

  const rows = await openRows(db, c.companyId, t, when.on);
  const mine = rowsOfLine(rows, line, t.layer);
  const nothing = t.layer === 'ASSIGNMENT'
    ? 'This person has not changed that line — it already reads as their position says.'
    : 'This position has not changed that line — it already reads as the role says.';
  if (!mine.length) throw invalid('NOTHING_TO_UNDO', nothing);

  const replaced = mine.filter((o) => o.action === 'ADD' && o.json?.replacesDefinitionId);
  const paired = rows.filter((o) => o.content_type === kind && o.action === 'SUPPRESS' && !mine.includes(o)
    && replaced.some((a) => Number(o[DEF_COLUMN[kind]]) === Number(a.json.replacesDefinitionId) || (a.line_key && o.line_key === a.line_key)));
  refuseRewrite([...mine, ...paired], when.on);
  await closeRows(db, c, t, [...mine, ...paired], when.on);
  return readAfter(db, c.companyId, t);
}

/* ── the position's door ── */

async function positionTarget(db, companyId, positionId) {
  const position = await requirePosition(db, companyId, positionId);
  return { layer: 'POSITION', ownerId: Number(positionId), positionId: Number(positionId), roleId: position.role_id };
}
export async function seatAddLine(db, c, positionId, body = {}) { return layerAddLine(db, c, await positionTarget(db, c.companyId, positionId), body); }
export async function seatChangeLine(db, c, positionId, body = {}) { return layerChangeLine(db, c, await positionTarget(db, c.companyId, positionId), body); }
export async function seatSwitchOffLine(db, c, positionId, body = {}) { return layerSwitchOffLine(db, c, await positionTarget(db, c.companyId, positionId), body); }
export async function seatUndoLine(db, c, positionId, body = {}) { return layerUndoLine(db, c, await positionTarget(db, c.companyId, positionId), body); }

/* ── the person's door ── */

/**
 * The person's changes are written against the assignment through which they
 * hold a position ON THE DAY THE CHANGE TAKES EFFECT. A person in no position
 * then has nothing to change (409 NO_POSITION).
 */
export async function personTarget(db, c, employeeId, body = {}) {
  await requireEmployee(db, c.companyId, employeeId);
  const when = readTakesEffect(body, c);
  const a = await seatHeldOn(db, c.companyId, employeeId, when.on);
  if (!a) throw conflict('NO_POSITION', `This person is not in a position on ${longDay(when.on)}, so there is no job of theirs to change.`);
  return {
    layer: 'ASSIGNMENT', ownerId: a.id, workAssignmentId: a.id, positionId: a.position_id, roleId: a.role_id, employeeId: Number(employeeId),
  };
}
export async function personAddLine(db, c, employeeId, body = {}) { return layerAddLine(db, c, await personTarget(db, c, employeeId, body), body); }
export async function personChangeLine(db, c, employeeId, body = {}) { return layerChangeLine(db, c, await personTarget(db, c, employeeId, body), body); }
export async function personSwitchOffLine(db, c, employeeId, body = {}) { return layerSwitchOffLine(db, c, await personTarget(db, c, employeeId, body), body); }
export async function personUndoLine(db, c, employeeId, body = {}) { return layerUndoLine(db, c, await personTarget(db, c, employeeId, body), body); }

/* ══════════════════════════════════════════════════════════════════════════
 * Role edits — the KRAs themselves, and a role line's wording
 * ══════════════════════════════════════════════════════════════════════════
 * A KRA is written freely per role, but `hrms_kra_definitions.name` is unique
 * per company (the master is a shared vocabulary). So:
 *   create  reuses the definition of that name when one exists, else writes one;
 *   rename  points THIS role's KRA line at the definition of the new name (one
 *           that exists, or a new one) FROM A DATE: the old version is closed,
 *           the new one opens — the old name is still what the role said before
 *           that day, and no other role's KRA is touched (spec §16.1).
 */

async function requireRoleKra(db, companyId, id) {
  const [[row]] = await db.query(
    `SELECT a.id, a.role_id, a.kra_definition_id, d.name, d.description
       FROM hrms_role_kra_assignments a
       JOIN hrms_kra_definitions d ON d.company_id = a.company_id AND d.id = a.kra_definition_id
      WHERE a.company_id = ? AND a.id = ? AND (a.deleted_at IS NULL OR (a.effective_to IS NOT NULL AND a.effective_to >= ?))`,
    [companyId, id, today()],
  );
  if (!row) throw notFound('KRA');
  return row;
}

async function kraDefinitionNamed(db, companyId, name) {
  const [[row]] = await db.query(
    'SELECT id, name, description, status FROM hrms_kra_definitions WHERE company_id = ? AND deleted_at IS NULL AND LOWER(name) = LOWER(?)',
    [companyId, name],
  );
  return row ?? null;
}

async function roleHasKra(db, companyId, roleId, definitionId, exceptId = null) {
  const [[row]] = await db.query(
    `SELECT id FROM hrms_role_kra_assignments
      WHERE company_id = ? AND role_id = ? AND kra_definition_id = ? AND deleted_at IS NULL AND (? IS NULL OR id <> ?)`,
    [companyId, roleId, definitionId, exceptId, exceptId],
  );
  return !!row;
}

/** Create a KRA on a role by writing it: `{ name, description?, takesEffect?, reason? }`. */
export async function createRoleKra(db, c, roleId, body = {}) {
  await requireRole(db, c.companyId, roleId);
  const problems = [];
  const name = readText(body.name, 'The KRA', problems, { max: 200 });
  const description = readText(body.description, 'Description', problems, { required: false, max: 4000 });
  assertNoProblems(problems);

  let definition = await kraDefinitionNamed(db, c.companyId, name);
  if (definition && await roleHasKra(db, c.companyId, roleId, definition.id)) {
    throw conflict('ALREADY_THERE', `This role already has the KRA "${definition.name}".`);
  }
  if (!definition) {
    definition = await createMasterItem(db, c, 'kras', { name, description, status: 'ACTIVE' });
  } else if (definition.status === 'INACTIVE') {
    throw conflict('INACTIVE', `A KRA named "${definition.name}" exists but is inactive. Reactivate it in the KRA list, or use another name.`);
  }
  return addContent(db, c, roleId, 'kras', { kraDefinitionId: definition.id, takesEffect: body.takesEffect, reason: body.reason });
}

/** How many OTHER roles lean on a KRA definition. */
async function kraSharedBy(db, companyId, definitionId, roleId) {
  const [[row]] = await db.query(
    `SELECT (SELECT COUNT(*) FROM hrms_role_kra_assignments a
              WHERE a.company_id = ? AND a.kra_definition_id = ? AND a.deleted_at IS NULL AND a.role_id <> ?) AS roles`,
    [companyId, definitionId, roleId],
  );
  return Number(row.roles ?? 0);
}

/**
 * Rename a role's KRA from a day (`takesEffect`, default today), and/or rewrite
 * its description. The description belongs to the KRA list (the shared
 * vocabulary) and is edited there in place; the NAME is what the role carries,
 * and a new name is a new version of the role's KRA line.
 */
export async function renameRoleKra(db, c, id, body = {}) {
  const kra = await requireRoleKra(db, c.companyId, id);
  const problems = [];
  const name = body.name === undefined ? kra.name : readText(body.name, 'The KRA', problems, { max: 200 });
  const description = body.description === undefined
    ? kra.description
    : readText(body.description, 'Description', problems, { required: false, max: 4000 });
  assertNoProblems(problems);
  const when = readTakesEffect(body, c);

  const shared = await kraSharedBy(db, c.companyId, kra.kra_definition_id, kra.role_id);
  const renamed = !same(name, kra.name);
  if (!renamed) {
    if (!same(description, kra.description)) {
      await db.query('UPDATE hrms_kra_definitions SET description = ? WHERE company_id = ? AND id = ?', [description, c.companyId, kra.kra_definition_id]);
      await audit(db, c, 'hrms_kra_definitions', kra.kra_definition_id, 'UPDATE', { description: kra.description }, { description });
    }
    return { ok: true, id, definitionId: kra.kra_definition_id, forked: false, sharedWithRoles: shared };
  }

  const existing = await kraDefinitionNamed(db, c.companyId, name);
  if (existing && Number(existing.id) !== Number(kra.kra_definition_id)
      && await roleHasKra(db, c.companyId, kra.role_id, existing.id, id)) {
    throw conflict('ALREADY_THERE', `This role already has a KRA named "${existing.name}". Move the lines there instead.`);
  }
  const target = existing ?? await createMasterItem(db, c, 'kras', { name, description, status: 'ACTIVE' });
  const next = await changeRoleLine(db, c, 'kras', id, { kra_definition_id: target.id }, when);
  return { ok: true, id: next.id, previousId: id, definitionId: target.id, forked: true, sharedWithRoles: shared, takesEffect: when.on };
}

/**
 * Delete a KRA from a role, from a day. ITS LINES ARE NOT DELETED: from that day
 * they stay on the role, ungrouped (a new version of each), so writing the same
 * KRA again later starts empty instead of silently swallowing them back.
 */
export async function deleteRoleKra(db, c, id, body = {}) {
  const kra = await requireRoleKra(db, c.companyId, id);
  const when = readTakesEffect(body, c);
  const out = await removeRoleLine(db, c, 'kras', id, when);
  return { ok: true, id, name: kra.name, ungrouped: out.ungrouped ?? 0, endedOn: out.endedOn };
}

/**
 * Move several lines under one KRA (or out of every KRA) in one write, from a
 * day. `{ roleKraAssignmentId | null, responsibilities: [rowId], kpis: [rowId], takesEffect? }`.
 */
export async function moveRoleLines(db, c, roleId, body = {}) {
  await requireRole(db, c.companyId, roleId);
  const target = body.roleKraAssignmentId == null || body.roleKraAssignmentId === '' ? null : Number(body.roleKraAssignmentId);
  if (target != null) {
    const kra = await requireRoleKra(db, c.companyId, target);
    if (Number(kra.role_id) !== Number(roleId)) {
      throw invalid('BAD_REFERENCE', 'A responsibility or KPI can only be grouped under a KRA that belongs to the same role.');
    }
  }
  const when = readTakesEffect(body, c);
  let moved = 0;
  for (const kind of ['responsibilities', 'kpis']) {
    const ids = [...new Set((Array.isArray(body[kind]) ? body[kind] : []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) continue;
    const marks = ids.map(() => '?').join(',');
    const [found] = await db.query(
      `SELECT id, role_kra_assignment_id FROM ${CONTENT[kind].table}
        WHERE company_id = ? AND role_id = ? AND id IN (${marks})
          AND (deleted_at IS NULL OR (effective_to IS NOT NULL AND effective_to >= ?))`,
      [c.companyId, roleId, ...ids, today()],
    );
    if (found.length !== ids.length) {
      throw invalid('INVALID', 'That selection lists a line that is not part of this role — reload the screen and try again.');
    }
    for (const row of found) {
      if ((row.role_kra_assignment_id ?? null) === target) continue;
      await changeRoleLine(db, c, kind, row.id, { role_kra_assignment_id: target }, when);
      moved += 1;
    }
  }
  if (!moved && !['responsibilities', 'kpis'].some((k) => Array.isArray(body[k]) && body[k].length)) {
    throw invalid('INVALID', 'Pick at least one line to move.');
  }
  return { ok: true, roleId, roleKraAssignmentId: target, moved };
}

/**
 * CHANGE THE WORDING of a role's responsibility or KPI, from a day (spec §16.1).
 * The wording belongs to a definition other roles may share, so the role's line
 * moves to a NEW definition with the new words (a KPI keeps its measurement) —
 * the same line, reworded: the old words are what the role said before that day.
 * `{ text, target?, takesEffect?, reason? }` on the role's row id.
 */
export async function rewordRoleLine(db, c, kind, roleRowId, body = {}) {
  const k = readKind(kind);
  const contentKind = ROLE_KIND[k];
  const table = CONTENT[contentKind].table;
  const [[row]] = await db.query(
    `SELECT a.*, d.name AS def_name, d.description AS def_description
       FROM ${table} a JOIN ${CONTENT[contentKind].def.table} d ON d.company_id = a.company_id AND d.id = a.${DEF_COLUMN[k]}
      WHERE a.company_id = ? AND a.id = ? AND (a.deleted_at IS NULL OR (a.effective_to IS NOT NULL AND a.effective_to >= ?))`,
    [c.companyId, roleRowId, today()],
  );
  if (!row) throw notFound(NOUN[k] === 'KPI' ? 'KPI' : 'Responsibility');
  const when = readTakesEffect(body, c);
  const problems = [];
  const text = readText(body.text, 'The wording', problems);
  assertNoProblems(problems);
  if (same(text, wordingOf(row.def_name, row.def_description))) throw invalid('NOTHING_TO_CHANGE', 'Nothing was changed.');

  let like = null;
  if (k === 'KPI') {
    const [[d]] = await db.query('SELECT measurement_type, unit, direction, default_frequency FROM hrms_kpi_definitions WHERE company_id = ? AND id = ?', [c.companyId, row.kpi_definition_id]);
    like = { measurementType: d?.measurement_type, unit: d?.unit, direction: d?.direction, frequency: d?.default_frequency };
  } else {
    const [[d]] = await db.query('SELECT responsibility_class FROM hrms_responsibility_definitions WHERE company_id = ? AND id = ?', [c.companyId, row.responsibility_definition_id]);
    like = { responsibilityClass: d?.responsibility_class ?? null };
  }
  const definition = await writeOwnDefinition(db, c, k, text, like);
  return changeRoleLine(db, c, contentKind, roleRowId, { [DEF_COLUMN[k]]: definition.id }, when);
}

/* ══════════════════════════════════════════════════════════════════════════
 * Departments — the roles and positions inside each one
 * ══════════════════════════════════════════════════════════════════════════
 * Built FROM THE ORG CHART'S OWN NODES, not from a second query over positions,
 * so a department's seats, filled and vacant here are the chart's numbers by
 * construction. One position is one seat (services/seatCount.js): `seats` is
 * the number of positions, and each position row is filled (one `occupant`) or
 * vacant. Each row also carries its `shift` and its `cardId`, so the screen can
 * show seven chairs of one card as one line with seven rows.
 * The whole company in one answer — Karni is 220 positions — so the Departments
 * screen makes one request, not one per department and never one per position.
 */
export async function departmentStaffing(db, companyId, { on } = {}) {
  const asOf = dateText(on) || today();
  const chart = await buildOrgChart(db, companyId, { on: asOf });

  const byDepartment = new Map();
  const bucket = (id) => {
    const key = id == null ? 0 : Number(id);
    if (!byDepartment.has(key)) byDepartment.set(key, { departmentId: id == null ? null : Number(id), roles: new Map() });
    return byDepartment.get(key);
  };

  for (const n of chart.nodes) {
    const dept = bucket(n.departmentId);
    const roleKey = n.roleId ?? 0;
    if (!dept.roles.has(roleKey)) {
      dept.roles.set(roleKey, {
        roleId: n.roleId ?? null, roleTitle: n.roleTitle ?? 'No role', roleCode: n.roleCode ?? null,
        seats: 0, filled: 0, vacant: 0, positions: [],
      });
    }
    const role = dept.roles.get(roleKey);
    const vacant = Number(n.vacancies);
    const seats = SEATS_PER_POSITION;
    const filled = seats - vacant;
    role.seats += seats;
    role.filled += filled;
    role.vacant += vacant;
    role.positions.push({
      positionId: n.id,
      positionCode: n.positionCode,
      title: n.displayTitle ?? n.title,
      status: n.status,
      cardId: n.cardId,
      shiftPattern: n.shiftPattern,
      shift: n.defaultShift,
      seats,
      filled,
      vacant,
      overFilled: n.overFilled === true,
      // The one person in the position, or null. `occupants` is the same person
      // as a list, for the screens written when a position held several.
      occupant: n.occupants[0]
        ? { employeeId: n.occupants[0].employeeId, name: n.occupants[0].name, employeeCode: n.occupants[0].employeeCode ?? null, notice: n.occupants[0].notice ?? null }
        : null,
      occupants: n.occupants.map((o) => ({ employeeId: o.employeeId, name: o.name, employeeCode: o.employeeCode ?? null, notice: o.notice ?? null })),
      // The OPEN hiring on this position, or null — the chart's own, so the two screens agree.
      hiring: n.hiring ?? null,
      // …and who is due to join it from a later date, or null.
      joining: n.joining ?? null,
      // Whether this seat reads differently from its role (an add / change / switch-off).
      hasSeatChanges: false,
    });
  }

  // Which seats carry changes of their own on the date — one grouped query for the company.
  const [changed] = await db.query(
    `SELECT o.position_id, COUNT(*) AS n FROM hrms_position_content_overrides o
      WHERE o.company_id = ? AND o.deleted_at IS NULL
        AND (o.effective_from IS NULL OR o.effective_from <= ?) AND (o.effective_to IS NULL OR o.effective_to >= ?)
      GROUP BY o.position_id`,
    [companyId, asOf, asOf],
  );
  const changedIds = new Set(changed.map((r) => Number(r.position_id)));

  const departments = [...byDepartment.values()].map((d) => {
    const roles = [...d.roles.values()].sort((a, b) => a.roleTitle.localeCompare(b.roleTitle));
    for (const r of roles) {
      for (const p of r.positions) p.hasSeatChanges = changedIds.has(Number(p.positionId));
      r.positions.sort((a, b) => a.title.localeCompare(b.title));
    }
    const sum = (key) => roles.reduce((t, r) => t + r[key], 0);
    return {
      departmentId: d.departmentId,
      roles,
      counts: {
        roles: roles.length,
        positions: roles.reduce((t, r) => t + r.positions.length, 0),
        seats: sum('seats'),
        filled: sum('filled'),
        vacant: sum('vacant'),
      },
    };
  });

  return {
    asOf,
    departments,
    // The chart's own totals, passed through so the screen can show they agree.
    counts: {
      positions: chart.counts.positions,
      seats: chart.counts.sanctioned,
      filled: chart.counts.filled,
      vacant: chart.counts.vacant,
    },
  };
}

// isoDate is re-exported for the history service, which reads the same rows.
export { isoDate };

export default {
  roleJobContent, positionJobContent, employeeJobContent,
  seatAddLine, seatChangeLine, seatSwitchOffLine, seatUndoLine,
  personAddLine, personChangeLine, personSwitchOffLine, personUndoLine,
  createRoleKra, renameRoleKra, deleteRoleKra, moveRoleLines, rewordRoleLine,
  departmentStaffing,
};
