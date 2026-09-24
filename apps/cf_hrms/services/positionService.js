import { EFFECTIVE_SEATS_SQL, effectiveSeats, vacancies as vacancyOf } from './seatCount.js';
/**
 * positionService.js — positions, their work contexts, the FORMAL reporting
 * structure between them, and position content overlays. (Plan §5.4, §7.)
 *
 * A Position is a *sanctioned seat*: the organisation's design, independent of
 * who is in it. That is why formal reporting lives between positions and not
 * between people — a vacancy still has a manager, and replacing a person does
 * not rewrite the chart.
 *
 * Position is OPTIONAL on a work assignment (non-negotiable 5). Nothing in this
 * file may be made a precondition of doing work; an SME that has never written
 * down a sanctioned headcount still has real people with real responsibilities.
 *
 * RULES ENFORCED HERE, because TiDB runs with tidb_enable_check_constraint = 0
 * and none of these are expressible as a CHECK anyway:
 *   - no self-reporting: from_position_id != to_position_id;
 *   - no cycles on formal (is_formal = 1) relationship types, walked with a
 *     guard counter so a pre-existing bad edge cannot hang the request;
 *   - at most one live relationship of a type whose allow_multiple = 0;
 *   - at most one primary work context per position, live on a date;
 *   - exactly one of the three definition FKs on a content-override row, and it
 *     must agree with content_type;
 *   - effective-dated rows are ENDED, never overwritten (plan §2 rule 8): the
 *     identity-bearing fields of a live row cannot be edited, only ended and
 *     replaced — and `replacesId` on a create does both inside one transaction.
 *
 * VACANCY IS A FACT, NOT AN ERROR. sanctioned − filled is reported as a number
 * and never as a failure; 156 of Karni's 169 seats are vacant and that is the
 * truth the system exists to show.
 */
import { invalid, notFound, conflict, assertNoProblems } from '../lib/errors.js';

export const POSITION_STATUSES = ['DRAFT', 'ACTIVE', 'FROZEN', 'CLOSED'];
export const SCOPE_TYPES = ['GENERAL', 'FUNCTION', 'RESPONSIBILITY', 'WORK_CONTEXT', 'PROJECT', 'OTHER'];
export const CONTENT_TYPES = ['KRA', 'RESPONSIBILITY', 'KPI'];
export const OVERRIDE_ACTIONS = ['ADD', 'OVERRIDE', 'SUPPRESS'];

/** How long a reporting chain may be before we call it a cycle. Karni's deepest is 7. */
const MAX_CHAIN = 64;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');

/** MySQL hands DATE back as a local-midnight Date; toISOString would shift it a day. */
export function dateText(d) {
  if (d == null || d === '') return null;
  if (d instanceof Date) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return String(d).slice(0, 10);
}
export const today = () => dateText(new Date());
export const blank = (v) => v == null || String(v).trim() === '';

export function readDate(value, label, problems) {
  if (blank(value)) return null;
  const s = String(value).trim().slice(0, 10);
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00`))) {
    problems.push(`${label} needs a date as YYYY-MM-DD.`);
    return null;
  }
  return s;
}

export function readText(value, label, max, problems) {
  if (blank(value)) return null;
  const s = String(value).trim();
  if (s.length > max) problems.push(`${label} is up to ${max} characters.`);
  return s.slice(0, max);
}

export function readEnum(value, label, allowed, problems, fallback = null) {
  if (blank(value)) return fallback;
  const s = String(value).trim().toUpperCase();
  if (!allowed.includes(s)) { problems.push(`${label} must be one of ${allowed.join(', ')}.`); return fallback; }
  return s;
}

export function readInt(value, label, problems) {
  if (blank(value)) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) { problems.push(`${label} must be a whole number.`); return null; }
  return n;
}

export const bool = (v, fallback = false) => (v == null ? fallback : Boolean(v) && v !== 'false' && v !== '0');

/**
 * "Live on this date" — the single definition every screen in this app depends
 * on. A NULL effective_from means "always has been"; a NULL effective_to means
 * "still is". Written once here so a reporting line, a context link and an
 * assignment never disagree about what "today" includes.
 */
export const LIVE_ON = (alias) =>
  `(${alias}.effective_from IS NULL OR ${alias}.effective_from <= ?) AND (${alias}.effective_to IS NULL OR ${alias}.effective_to >= ?)`;

/** Reference existence checks. Each pushes a sentence rather than throwing, so a form gets every problem at once. */
async function exists(db, companyId, table, id, label, problems) {
  if (id == null) return null;
  const [[row]] = await db.query(
    `SELECT * FROM ${table} WHERE company_id = ? AND id = ? AND deleted_at IS NULL`,
    [companyId, id],
  );
  if (!row) problems.push(`That ${label} does not exist in this company.`);
  return row ?? null;
}

export async function requirePosition(db, companyId, id, { lock = false } = {}) {
  const [[p]] = await db.query(
    `SELECT * FROM hrms_positions WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, id],
  );
  if (!p) throw notFound('Position');
  return p;
}

/* ══════════════════════════════════════════════════════════════════════════
 * Content overrides — shared by positions and work assignments
 * ══════════════════════════════════════════════════════════════════════════
 * Both override tables have the same shape and the same rule, so it is written
 * once and assignmentService.js imports it. (Plan §7 reserves the name
 * contentOverrideService.js for when Phase 7's contentResolver lands; this is
 * that logic living in the file the phase was allowed to create.)
 *
 * THE RULE: exactly one of kra_definition_id / responsibility_definition_id /
 * kpi_definition_id is set, and the one that is set must be the one
 * content_type names. Zero set is a row that overrides nothing; two set is a
 * row nobody can resolve. TiDB will accept both, so this function is the only
 * thing standing between the model and content that cannot be rendered.
 */
const DEF_COLUMN = {
  KRA: 'kra_definition_id',
  RESPONSIBILITY: 'responsibility_definition_id',
  KPI: 'kpi_definition_id',
};
const DEF_TABLE = {
  KRA: ['hrms_kra_definitions', 'KRA'],
  RESPONSIBILITY: ['hrms_responsibility_definitions', 'responsibility'],
  KPI: ['hrms_kpi_definitions', 'KPI'],
};

export async function readContentOverride(db, companyId, body) {
  const problems = [];
  const contentType = readEnum(body.contentType, 'Content type', CONTENT_TYPES, problems);
  const action = readEnum(body.action, 'Action', OVERRIDE_ACTIONS, problems);
  if (!contentType) problems.push('Say whether this overrides a KRA, a responsibility or a KPI.');
  if (!action) problems.push('Say whether this adds, overrides or suppresses.');

  const given = {
    KRA: readInt(body.kraDefinitionId, 'KRA', problems),
    RESPONSIBILITY: readInt(body.responsibilityDefinitionId, 'Responsibility', problems),
    KPI: readInt(body.kpiDefinitionId, 'KPI', problems),
  };
  const setKeys = CONTENT_TYPES.filter((k) => given[k] != null);

  if (setKeys.length === 0) problems.push('Choose the KRA, responsibility or KPI this override applies to.');
  if (setKeys.length > 1) {
    problems.push(`An override points at exactly one definition; this one names ${setKeys.length} (${setKeys.join(', ')}).`);
  }
  if (contentType && setKeys.length === 1 && setKeys[0] !== contentType) {
    problems.push(`Content type says ${contentType} but the definition given is a ${setKeys[0]}.`);
  }
  if (contentType && given[contentType] != null) {
    const [table, label] = DEF_TABLE[contentType];
    await exists(db, companyId, table, given[contentType], label, problems);
  }

  const parentKraDefinitionId = readInt(body.parentKraDefinitionId, 'Parent KRA', problems);
  if (parentKraDefinitionId) await exists(db, companyId, 'hrms_kra_definitions', parentKraDefinitionId, 'KRA', problems);
  if (parentKraDefinitionId && contentType === 'KRA') {
    problems.push('A KRA override does not sit under another KRA.');
  }

  let overrideJson = null;
  if (!blank(body.overrideJson)) {
    try {
      overrideJson = typeof body.overrideJson === 'string' ? JSON.parse(body.overrideJson) : body.overrideJson;
      if (typeof overrideJson !== 'object' || Array.isArray(overrideJson)) throw new Error('shape');
    } catch {
      problems.push('Override details must be a JSON object, for example {"weightPercent": 15}.');
    }
  }
  if (action === 'OVERRIDE' && overrideJson == null) {
    problems.push('An OVERRIDE needs override details saying what changes — otherwise it changes nothing.');
  }
  if (action === 'SUPPRESS' && overrideJson != null) {
    problems.push('A SUPPRESS removes inherited content; it carries no override details.');
  }

  const effectiveFrom = readDate(body.effectiveFrom, 'Effective from', problems);
  const effectiveTo = readDate(body.effectiveTo, 'Effective to', problems);
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) problems.push('Effective to cannot be before effective from.');

  assertNoProblems(problems);
  return {
    contentType,
    action,
    kraDefinitionId: given.KRA,
    responsibilityDefinitionId: given.RESPONSIBILITY,
    kpiDefinitionId: given.KPI,
    parentKraDefinitionId,
    overrideJson: overrideJson == null ? null : JSON.stringify(overrideJson),
    effectiveFrom,
    effectiveTo,
    reason: readText(body.reason, 'Reason', 2000, problems),
    definitionColumn: DEF_COLUMN[contentType],
  };
}

/** Shapes an override row for the wire, with the definition's name resolved. */
export function shapeOverride(r) {
  return {
    id: r.id,
    contentType: r.content_type,
    action: r.action,
    kraDefinitionId: r.kra_definition_id,
    responsibilityDefinitionId: r.responsibility_definition_id,
    kpiDefinitionId: r.kpi_definition_id,
    definitionName: r.definition_name ?? null,
    parentKraDefinitionId: r.parent_kra_definition_id,
    parentKraName: r.parent_kra_name ?? null,
    overrideJson: r.override_json == null ? null : (typeof r.override_json === 'string' ? JSON.parse(r.override_json) : r.override_json),
    effectiveFrom: dateText(r.effective_from),
    effectiveTo: dateText(r.effective_to),
    reason: r.reason ?? null,
    createdAt: r.created_at,
  };
}

const OVERRIDE_SELECT = (table, fk) => `
  SELECT o.*,
         COALESCE(k.name, rs.name, kp.name) AS definition_name,
         pk.name AS parent_kra_name
    FROM ${table} o
    LEFT JOIN hrms_kra_definitions            k  ON k.company_id  = o.company_id AND k.id  = o.kra_definition_id
    LEFT JOIN hrms_responsibility_definitions rs ON rs.company_id = o.company_id AND rs.id = o.responsibility_definition_id
    LEFT JOIN hrms_kpi_definitions            kp ON kp.company_id = o.company_id AND kp.id = o.kpi_definition_id
    LEFT JOIN hrms_kra_definitions            pk ON pk.company_id = o.company_id AND pk.id = o.parent_kra_definition_id
   WHERE o.company_id = ? AND o.${fk} = ? AND o.deleted_at IS NULL
   ORDER BY o.content_type, o.action, o.id`;

/* ══════════════════════════════════════════════════════════════════════════
 * Positions
 * ══════════════════════════════════════════════════════════════════════════ */

function shapePosition(p) {
  // sanctionedHeadcount stays the raw column — it means ONE SEAT and the edit
  // form writes it back. `seats` is the effective strength for the date, which
  // is what fill and vacancy are measured against. services/seatCount.js says why.
  const sanctioned = Number(p.sanctioned_headcount ?? 0);
  const seats = Number(p.effective_seats ?? sanctioned);
  const filled = Number(p.filled_count ?? 0);
  return {
    id: p.id,
    positionCode: p.position_code,
    positionTitle: p.position_title,
    displayTitle: p.position_title || p.role_title || `Position ${p.id}`,
    roleId: p.role_id,
    roleCode: p.role_code ?? null,
    roleTitle: p.role_title ?? null,
    departmentId: p.department_id,
    departmentName: p.department_name ?? null,
    locationId: p.location_id,
    locationName: p.location_name ?? null,
    sanctionedHeadcount: sanctioned,
    seats,
    filledCount: filled,
    // A fact, not an error. Never negative on the wire: an over-filled seat is
    // its own signal (filledCount > sanctionedHeadcount) and is not a vacancy.
    vacancyCount: vacancyOf(seats, filled),
    overFilled: filled > seats,
    defaultShiftId: p.default_shift_id,
    shiftCode: p.shift_code ?? null,
    shiftName: p.shift_name ?? null,
    status: p.status,
    effectiveFrom: dateText(p.effective_from),
    effectiveTo: dateText(p.effective_to),
    contextCount: p.context_count == null ? undefined : Number(p.context_count),
    reportingCount: p.reporting_count == null ? undefined : Number(p.reporting_count),
    overrideCount: p.override_count == null ? undefined : Number(p.override_count),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

const POSITION_SELECT = `
  SELECT p.*, r.title AS role_title, r.role_code,
         d.name AS department_name, l.name AS location_name,
         s.code AS shift_code, s.name AS shift_name,
         ${EFFECTIVE_SEATS_SQL('p')} AS effective_seats,
         (SELECT COUNT(*) FROM hrms_work_assignments wa
           WHERE wa.company_id = p.company_id AND wa.position_id = p.id AND wa.deleted_at IS NULL
             AND wa.status = 'ACTIVE'
             AND (wa.effective_from IS NULL OR wa.effective_from <= ?)
             AND (wa.effective_to IS NULL OR wa.effective_to >= ?)) AS filled_count,
         (SELECT COUNT(*) FROM hrms_position_work_contexts c
           WHERE c.company_id = p.company_id AND c.position_id = p.id AND c.deleted_at IS NULL) AS context_count,
         (SELECT COUNT(*) FROM hrms_position_reporting_relationships rr
           WHERE rr.company_id = p.company_id AND rr.from_position_id = p.id AND rr.deleted_at IS NULL) AS reporting_count,
         (SELECT COUNT(*) FROM hrms_position_content_overrides o
           WHERE o.company_id = p.company_id AND o.position_id = p.id AND o.deleted_at IS NULL) AS override_count
    FROM hrms_positions p
    LEFT JOIN hrms_roles       r ON r.company_id = p.company_id AND r.id = p.role_id
    LEFT JOIN hrms_departments d ON d.company_id = p.company_id AND d.id = p.department_id
    LEFT JOIN hrms_locations   l ON l.company_id = p.company_id AND l.id = p.location_id
    LEFT JOIN hrms_shifts      s ON s.company_id = p.company_id AND s.id = p.default_shift_id`;

export async function listPositions(db, companyId, query = {}) {
  const on = dateText(query.on) || today();
  const where = ['p.company_id = ?', 'p.deleted_at IS NULL'];
  // EFFECTIVE_SEATS_SQL comes first in the SELECT and takes four date params
  // (two subqueries x two date bounds); then filled_count takes two.
  const params = [on, on, on, on, on, on, companyId];

  if (!blank(query.status)) {
    const statuses = String(query.status).split(',').map((s) => s.trim().toUpperCase()).filter((s) => POSITION_STATUSES.includes(s));
    if (statuses.length) { where.push(`p.status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses); }
  }
  for (const [key, col] of [['roleId', 'p.role_id'], ['departmentId', 'p.department_id'], ['locationId', 'p.location_id'], ['shiftId', 'p.default_shift_id']]) {
    if (!blank(query[key])) { where.push(`${col} = ?`); params.push(Number(query[key])); }
  }
  if (!blank(query.search)) {
    where.push('(p.position_code LIKE ? OR p.position_title LIKE ? OR r.title LIKE ?)');
    const like = `%${String(query.search).trim()}%`;
    params.push(like, like, like);
  }

  const [rows] = await db.query(`${POSITION_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.title, p.position_code, p.id`, params);
  const items = rows.map(shapePosition);
  return {
    asOf: on,
    items,
    total: items.length,
    // The StatStrip's numbers, computed over the SAME filtered set the list
    // shows, so they can never disagree with the rows underneath.
    totals: {
      sanctioned: items.reduce((n, p) => n + p.seats, 0),
      filled: items.reduce((n, p) => n + p.filledCount, 0),
      vacant: items.reduce((n, p) => n + p.vacancyCount, 0),
      overFilled: items.filter((p) => p.overFilled).length,
    },
  };
}

export async function getPosition(db, companyId, id, query = {}) {
  const on = dateText(query.on) || today();
  const [[row]] = await db.query(`${POSITION_SELECT} WHERE p.company_id = ? AND p.id = ? AND p.deleted_at IS NULL`, [on, on, on, on, on, on, companyId, id]);
  if (!row) throw notFound('Position');
  return { asOf: on, position: shapePosition(row) };
}

async function readPositionBody(db, companyId, body, { partial = false, current = null } = {}) {
  const problems = [];
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has('roleId')) {
    const roleId = readInt(body.roleId, 'Role', problems);
    if (roleId == null && !partial) problems.push('A position needs a role — that is what the seat is for.');
    if (roleId != null) await exists(db, companyId, 'hrms_roles', roleId, 'role', problems);
    if (roleId != null) out.role_id = roleId;
  }
  if (!partial || has('positionCode')) out.position_code = readText(body.positionCode, 'Position code', 50, problems);
  if (!partial || has('positionTitle')) out.position_title = readText(body.positionTitle, 'Position title', 200, problems);

  for (const [key, col, table, label] of [
    ['departmentId', 'department_id', 'hrms_departments', 'department'],
    ['locationId', 'location_id', 'hrms_locations', 'location'],
    ['defaultShiftId', 'default_shift_id', 'hrms_shifts', 'shift'],
  ]) {
    if (!partial || has(key)) {
      const v = readInt(body[key], label, problems);
      if (v != null) await exists(db, companyId, table, v, label, problems);
      out[col] = v;
    }
  }

  if (!partial || has('sanctionedHeadcount')) {
    const raw = body.sanctionedHeadcount;
    if (blank(raw)) out.sanctioned_headcount = partial ? (current?.sanctioned_headcount ?? 1) : 1;
    else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) problems.push('Sanctioned headcount cannot be negative.');
      else if (n > 99999) problems.push('Sanctioned headcount is up to 99999.');
      else out.sanctioned_headcount = n;
    }
  }
  if (!partial || has('status')) out.status = readEnum(body.status, 'Status', POSITION_STATUSES, problems, current?.status ?? 'DRAFT');
  if (!partial || has('effectiveFrom')) out.effective_from = readDate(body.effectiveFrom, 'Effective from', problems);
  if (!partial || has('effectiveTo')) out.effective_to = readDate(body.effectiveTo, 'Effective to', problems);

  const from = out.effective_from ?? current?.effective_from ?? null;
  const to = out.effective_to ?? current?.effective_to ?? null;
  if (from && to && dateText(to) < dateText(from)) problems.push('Effective to cannot be before effective from.');

  assertNoProblems(problems);
  return out;
}

export async function createPosition(db, { companyId, userId }, body) {
  const data = await readPositionBody(db, companyId, body);
  const cols = { company_id: companyId, created_by: userId, ...data };
  const keys = Object.keys(cols);
  const [res] = await db.query(
    `INSERT INTO hrms_positions (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((k) => cols[k]),
  );
  return getPosition(db, companyId, res.insertId);
}

export async function updatePosition(db, { companyId }, id, body) {
  const current = await requirePosition(db, companyId, id, { lock: true });
  const data = await readPositionBody(db, companyId, body, { partial: true, current });
  const keys = Object.keys(data);
  if (keys.length) {
    await db.query(
      `UPDATE hrms_positions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...keys.map((k) => data[k]), companyId, id],
    );
  }
  return getPosition(db, companyId, id);
}

export async function setPositionStatus(db, { companyId }, id, status) {
  await requirePosition(db, companyId, id, { lock: true });
  const problems = [];
  const next = readEnum(status, 'Status', POSITION_STATUSES, problems);
  assertNoProblems(problems);
  await db.query('UPDATE hrms_positions SET status = ? WHERE company_id = ? AND id = ?', [next, companyId, id]);
  return getPosition(db, companyId, id);
}

/**
 * Soft-delete. Refused while anyone is assigned to the seat: an occupied
 * position that disappears leaves assignments pointing at nothing, and the spec
 * is explicit that referenced records are ended, not deleted (§8).
 */
export async function deletePosition(db, { companyId }, id) {
  await requirePosition(db, companyId, id, { lock: true });
  const [[{ n }]] = await db.query(
    `SELECT COUNT(*) AS n FROM hrms_work_assignments
      WHERE company_id = ? AND position_id = ? AND deleted_at IS NULL AND status <> 'ENDED'`,
    [companyId, id],
  );
  if (n) {
    throw conflict('IN_USE', `${n} work assignment${n === 1 ? '' : 's'} still point at this position. End them, or close the position instead of deleting it.`);
  }
  await db.query('UPDATE hrms_positions SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [companyId, id]);
  await db.query('UPDATE hrms_position_work_contexts SET deleted_at = NOW() WHERE company_id = ? AND position_id = ? AND deleted_at IS NULL', [companyId, id]);
  await db.query('UPDATE hrms_position_reporting_relationships SET deleted_at = NOW() WHERE company_id = ? AND (from_position_id = ? OR to_position_id = ?) AND deleted_at IS NULL', [companyId, id, id]);
  await db.query('UPDATE hrms_position_content_overrides SET deleted_at = NOW() WHERE company_id = ? AND position_id = ? AND deleted_at IS NULL', [companyId, id]);
  return { ok: true, deleted: id };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Position work contexts
 * ══════════════════════════════════════════════════════════════════════════
 * The answer to the shared-resource problem: one Helper covering four machines
 * is ONE position with four rows here, never four cloned positions.
 */
const shapePositionContext = (r) => ({
  id: r.id,
  positionId: r.position_id,
  workContextId: r.work_context_id,
  workContextName: r.context_name ?? null,
  workContextCode: r.context_code ?? null,
  contextType: r.context_type ?? null,
  isPrimary: Boolean(r.is_primary),
  effectiveFrom: dateText(r.effective_from),
  effectiveTo: dateText(r.effective_to),
  notes: r.notes ?? null,
});

export async function listPositionContexts(db, companyId, positionId) {
  await requirePosition(db, companyId, positionId);
  const [rows] = await db.query(
    `SELECT c.*, wc.name AS context_name, wc.code AS context_code, wc.context_type
       FROM hrms_position_work_contexts c
       JOIN hrms_work_contexts wc ON wc.company_id = c.company_id AND wc.id = c.work_context_id
      WHERE c.company_id = ? AND c.position_id = ? AND c.deleted_at IS NULL
      ORDER BY c.is_primary DESC, wc.name`,
    [companyId, positionId],
  );
  return { items: rows.map(shapePositionContext), total: rows.length };
}

export async function addPositionContext(db, { companyId, userId }, positionId, body) {
  await requirePosition(db, companyId, positionId);
  const problems = [];
  const workContextId = readInt(body.workContextId, 'Work context', problems);
  if (workContextId == null) problems.push('Choose the machine, line, area or project this position covers.');
  if (workContextId != null) await exists(db, companyId, 'hrms_work_contexts', workContextId, 'work context', problems);
  const effectiveFrom = readDate(body.effectiveFrom, 'Effective from', problems);
  const effectiveTo = readDate(body.effectiveTo, 'Effective to', problems);
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) problems.push('Effective to cannot be before effective from.');
  const isPrimary = bool(body.isPrimary);
  assertNoProblems(problems);

  // At most one primary. Not a unique index, because "primary" only means
  // anything among rows live on a date — so it is checked, and the previous
  // primary is demoted rather than the write being refused.
  if (isPrimary) {
    await db.query(
      'UPDATE hrms_position_work_contexts SET is_primary = 0 WHERE company_id = ? AND position_id = ? AND deleted_at IS NULL AND is_primary = 1',
      [companyId, positionId],
    );
  }
  const [res] = await db.query(
    `INSERT INTO hrms_position_work_contexts
       (company_id, position_id, work_context_id, is_primary, effective_from, effective_to, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, positionId, workContextId, isPrimary ? 1 : 0, effectiveFrom, effectiveTo, readText(body.notes, 'Notes', 2000, []), userId],
  );
  return { ok: true, id: res.insertId };
}

export async function updatePositionContext(db, { companyId }, id, body) {
  const [[row]] = await db.query('SELECT * FROM hrms_position_work_contexts WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [companyId, id]);
  if (!row) throw notFound('Position work context');
  const problems = [];
  const sets = {};
  if (Object.prototype.hasOwnProperty.call(body, 'isPrimary')) {
    sets.is_primary = bool(body.isPrimary) ? 1 : 0;
    if (sets.is_primary) {
      await db.query('UPDATE hrms_position_work_contexts SET is_primary = 0 WHERE company_id = ? AND position_id = ? AND id <> ? AND deleted_at IS NULL', [companyId, row.position_id, id]);
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'effectiveFrom')) sets.effective_from = readDate(body.effectiveFrom, 'Effective from', problems);
  if (Object.prototype.hasOwnProperty.call(body, 'effectiveTo')) sets.effective_to = readDate(body.effectiveTo, 'Effective to', problems);
  if (Object.prototype.hasOwnProperty.call(body, 'notes')) sets.notes = readText(body.notes, 'Notes', 2000, problems);
  assertNoProblems(problems);
  const keys = Object.keys(sets);
  if (keys.length) {
    await db.query(`UPDATE hrms_position_work_contexts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`, [...keys.map((k) => sets[k]), companyId, id]);
  }
  return { ok: true, id };
}

export async function removePositionContext(db, { companyId }, id) {
  const [res] = await db.query('UPDATE hrms_position_work_contexts SET deleted_at = NOW() WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!res.affectedRows) throw notFound('Position work context');
  return { ok: true, id };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Formal position reporting — the org chart's edge list
 * ══════════════════════════════════════════════════════════════════════════
 * Position to position, typed, SCOPED and effective-dated. Multiple rows per
 * position are normal and expected (v1.1 §13.1): a primary line plus a dotted
 * one is TWO ROWS, not two positions and never two roles.
 */
export const shapePositionReporting = (r) => ({
  id: r.id,
  origin: 'POSITION',
  layer: 'FORMAL',
  fromPositionId: r.from_position_id,
  fromPositionTitle: r.from_title ?? null,
  toPositionId: r.to_position_id,
  toPositionCode: r.to_code ?? null,
  toPositionTitle: r.to_title ?? null,
  toRoleTitle: r.to_role_title ?? null,
  relationshipTypeId: r.relationship_type_id,
  relationshipTypeCode: r.type_code ?? null,
  relationshipTypeName: r.type_name ?? null,
  isFormalType: r.type_is_formal == null ? null : Boolean(r.type_is_formal),
  allowMultiple: r.type_allow_multiple == null ? null : Boolean(r.type_allow_multiple),
  isPrimary: Boolean(r.is_primary),
  scope: {
    type: r.scope_type,
    label: r.scope_label ?? null,
    workContextId: r.scope_work_context_id ?? null,
    workContextName: r.scope_context_name ?? null,
    notes: r.notes ?? null,
  },
  effectiveFrom: dateText(r.effective_from),
  effectiveTo: dateText(r.effective_to),
});

const POSITION_REPORTING_SELECT = `
  SELECT rr.*,
         fp.position_title AS from_title,
         tp.position_code  AS to_code,
         COALESCE(tp.position_title, tr.title) AS to_title,
         tr.title AS to_role_title,
         t.code AS type_code, t.name AS type_name, t.is_formal AS type_is_formal, t.allow_multiple AS type_allow_multiple,
         sc.name AS scope_context_name
    FROM hrms_position_reporting_relationships rr
    JOIN hrms_positions fp ON fp.company_id = rr.company_id AND fp.id = rr.from_position_id
    JOIN hrms_positions tp ON tp.company_id = rr.company_id AND tp.id = rr.to_position_id
    LEFT JOIN hrms_roles tr ON tr.company_id = rr.company_id AND tr.id = tp.role_id
    JOIN hrms_reporting_relationship_types t ON t.company_id = rr.company_id AND t.id = rr.relationship_type_id
    LEFT JOIN hrms_work_contexts sc ON sc.company_id = rr.company_id AND sc.id = rr.scope_work_context_id`;

export async function listPositionReporting(db, companyId, positionId, query = {}) {
  await requirePosition(db, companyId, positionId);
  const on = dateText(query.on) || today();
  const includeEnded = bool(query.includeEnded);
  const params = [companyId, positionId];
  let sql = `${POSITION_REPORTING_SELECT} WHERE rr.company_id = ? AND rr.from_position_id = ? AND rr.deleted_at IS NULL`;
  if (!includeEnded) { sql += ` AND ${LIVE_ON('rr')}`; params.push(on, on); }
  sql += ' ORDER BY rr.is_primary DESC, t.sort_order, rr.id';
  const [rows] = await db.query(sql, params);

  // Who reports TO this position — the other half of the chart, and the reason
  // a position screen can answer "who works for this seat" without the chart.
  const [reports] = await db.query(
    `${POSITION_REPORTING_SELECT} WHERE rr.company_id = ? AND rr.to_position_id = ? AND rr.deleted_at IS NULL AND ${LIVE_ON('rr')}
     ORDER BY rr.is_primary DESC, t.sort_order, rr.id`,
    [companyId, positionId, on, on],
  );
  return {
    asOf: on,
    managers: rows.map(shapePositionReporting),
    directReports: reports.map((r) => ({ ...shapePositionReporting(r), fromPositionId: r.from_position_id, fromPositionTitle: r.from_title })),
    total: rows.length,
  };
}

/**
 * Cycle guard for the formal hierarchy. Walks up from the proposed manager via
 * FORMAL relationship types only; if it reaches the subordinate, the edge would
 * close a loop. MAX_CHAIN stops a pre-existing bad edge (an import, a manual DB
 * fix) from turning a cheap check into a hung request.
 *
 * Only is_formal types participate. A dotted or project line is explicitly
 * allowed to point anywhere — that is the whole point of a matrix, and treating
 * one as a hierarchy edge is how a legitimate structure gets refused.
 */
async function assertNoCycle(db, companyId, fromPositionId, toPositionId) {
  // `seen` starts EMPTY on purpose. Seeding it with fromPositionId would filter
  // the subordinate out of every frontier — and the subordinate appearing in a
  // frontier is exactly what a cycle looks like.
  const seen = new Set();
  let frontier = [toPositionId];
  let steps = 0;
  while (frontier.length) {
    if (++steps > MAX_CHAIN) {
      throw conflict('REPORTING_CHAIN_TOO_DEEP', `The formal reporting chain above this position is more than ${MAX_CHAIN} levels deep, which usually means it already contains a loop. Fix that before adding another line.`);
    }
    if (frontier.some((id) => id === fromPositionId)) {
      throw conflict('REPORTING_CYCLE', 'That would make this position report, directly or indirectly, to itself.');
    }
    frontier.forEach((id) => seen.add(id));
    const [rows] = await db.query(
      `SELECT DISTINCT rr.to_position_id AS id
         FROM hrms_position_reporting_relationships rr
         JOIN hrms_reporting_relationship_types t ON t.company_id = rr.company_id AND t.id = rr.relationship_type_id
        WHERE rr.company_id = ? AND rr.deleted_at IS NULL AND t.is_formal = 1
          AND rr.from_position_id IN (${frontier.map(() => '?').join(',')})`,
      [companyId, ...frontier],
    );
    frontier = rows.map((r) => r.id).filter((id) => !seen.has(id));
  }
}

async function requireRelationshipType(db, companyId, id, problems) {
  const [[t]] = await db.query(
    'SELECT * FROM hrms_reporting_relationship_types WHERE company_id = ? AND id = ? AND deleted_at IS NULL',
    [companyId, id],
  );
  if (!t) problems.push('That reporting relationship type does not exist in this company.');
  else if (t.status && t.status !== 'ACTIVE') problems.push(`${t.name} is inactive.`);
  return t ?? null;
}

/**
 * Reads the scope triple. This is the mechanism that keeps a partial-authority
 * manager from becoming a second Role (v1.1 §13.2): "CFO, for statutory
 * compliance" is a SCOPE on a relationship row, nothing more.
 */
async function readScope(db, companyId, body, problems) {
  const scopeType = readEnum(body.scopeType, 'Scope', SCOPE_TYPES, problems, 'GENERAL');
  const scopeLabel = readText(body.scopeLabel, 'Scope label', 250, problems);
  const scopeWorkContextId = readInt(body.scopeWorkContextId, 'Scope work context', problems);
  if (scopeWorkContextId != null) await exists(db, companyId, 'hrms_work_contexts', scopeWorkContextId, 'work context', problems);
  if (scopeType === 'WORK_CONTEXT' && scopeWorkContextId == null) {
    problems.push('A WORK_CONTEXT scope needs the machine, line or area it applies to.');
  }
  if (scopeType !== 'GENERAL' && blank(scopeLabel) && scopeWorkContextId == null) {
    problems.push('A scoped relationship needs a label saying what it covers — "Statutory compliance", "Payroll".');
  }
  if (scopeType === 'GENERAL' && !blank(scopeLabel)) {
    problems.push('A GENERAL scope covers the whole job, so it carries no label. Choose FUNCTION, RESPONSIBILITY, WORK_CONTEXT, PROJECT or OTHER.');
  }
  return { scopeType, scopeLabel, scopeWorkContextId };
}

/**
 * allow_multiple = 0 means one LIVE row of that type per source. PRIMARY_MANAGER
 * is the only seeded type with it. It does NOT make reporting exclusive — a
 * dotted, functional or project row sits happily beside the primary; that is
 * v1.1 §13.3 and the single most important thing not to get wrong here.
 */
async function assertTypeAllowed(db, { table, sourceColumn, sourceId, companyId, type, effectiveFrom, effectiveTo, excludeId = null }) {
  if (Number(type.allow_multiple)) return;
  const params = [companyId, sourceId, type.id, effectiveTo ?? '9999-12-31', effectiveFrom];
  let sql = `SELECT id, effective_from, effective_to FROM ${table}
              WHERE company_id = ? AND ${sourceColumn} = ? AND relationship_type_id = ? AND deleted_at IS NULL
                AND (effective_from IS NULL OR effective_from <= ?)
                AND (effective_to IS NULL OR effective_to >= ?)`;
  if (excludeId) { sql += ' AND id <> ?'; params.push(excludeId); }
  const [rows] = await db.query(sql, params);
  if (rows.length) {
    throw conflict('TYPE_NOT_MULTIPLE', `There is already a live ${type.name} here (from ${dateText(rows[0].effective_from) ?? 'the start'}). End that one first, or add a different relationship type — a second manager does not need a second role.`, {
      problems: [`Existing ${type.name} relationship #${rows[0].id} covers this date range.`],
    });
  }
}

export async function addPositionReporting(db, { companyId, userId }, positionId, body) {
  await requirePosition(db, companyId, positionId);
  const problems = [];
  const toPositionId = readInt(body.toPositionId, 'Manager position', problems);
  if (toPositionId == null) problems.push('Choose the position this one reports to.');
  if (toPositionId === positionId) problems.push('A position cannot report to itself.');
  if (toPositionId != null && toPositionId !== positionId) await exists(db, companyId, 'hrms_positions', toPositionId, 'position', problems);

  const relationshipTypeId = readInt(body.relationshipTypeId, 'Relationship type', problems);
  if (relationshipTypeId == null) problems.push('Choose a relationship type — primary, functional, dotted, project.');
  const type = relationshipTypeId == null ? null : await requireRelationshipType(db, companyId, relationshipTypeId, problems);

  const scope = await readScope(db, companyId, body, problems);
  const effectiveFrom = readDate(body.effectiveFrom, 'Effective from', problems) ?? today();
  const effectiveTo = readDate(body.effectiveTo, 'Effective to', problems);
  if (effectiveTo && effectiveTo < effectiveFrom) problems.push('Effective to cannot be before effective from.');
  assertNoProblems(problems);

  // `replacesId` is how "ended, not overwritten" is actually done: the old edge
  // is closed and the new one opened in one transaction, so history keeps both.
  const replacesId = readInt(body.replacesId, 'Replaces', []);
  if (replacesId) await endPositionReporting(db, { companyId }, replacesId, { effectiveTo: previousDay(effectiveFrom) });

  if (Number(type.is_formal)) await assertNoCycle(db, companyId, positionId, toPositionId);
  await assertTypeAllowed(db, {
    table: 'hrms_position_reporting_relationships', sourceColumn: 'from_position_id',
    sourceId: positionId, companyId, type, effectiveFrom, effectiveTo,
  });

  const [res] = await db.query(
    `INSERT INTO hrms_position_reporting_relationships
       (company_id, from_position_id, to_position_id, relationship_type_id, is_primary,
        scope_type, scope_label, scope_work_context_id, effective_from, effective_to, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, positionId, toPositionId, relationshipTypeId, bool(body.isPrimary, Number(type.allow_multiple) === 0) ? 1 : 0,
      scope.scopeType, scope.scopeLabel, scope.scopeWorkContextId, effectiveFrom, effectiveTo,
      readText(body.notes, 'Notes', 2000, []), userId],
  );
  return { ok: true, id: res.insertId, replaced: replacesId ?? null };
}

/** The day before an ISO date, so an ended row and its replacement never overlap. */
export function previousDay(iso) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return dateText(d);
}

/**
 * Only the fields that do NOT change the edge's identity may be edited. Manager,
 * type, scope and start date are identity: changing one is a different
 * relationship and must be a new row (plan §2 rule 8), which is what the
 * refusal message tells the user to do — and what `replacesId` does for them.
 */
export async function updatePositionReporting(db, { companyId }, id, body) {
  const [[row]] = await db.query('SELECT * FROM hrms_position_reporting_relationships WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [companyId, id]);
  if (!row) throw notFound('Reporting relationship');
  const problems = [];
  const immutable = [
    ['toPositionId', row.to_position_id, 'the manager position'],
    ['relationshipTypeId', row.relationship_type_id, 'the relationship type'],
    ['scopeType', row.scope_type, 'the scope'],
    ['effectiveFrom', dateText(row.effective_from), 'the start date'],
  ];
  for (const [key, currentValue, what] of immutable) {
    if (Object.prototype.hasOwnProperty.call(body, key) && !blank(body[key])) {
      const given = key === 'effectiveFrom' ? dateText(body[key]) : (key === 'scopeType' ? String(body[key]).toUpperCase() : Number(body[key]));
      if (String(given) !== String(currentValue)) {
        problems.push(`Changing ${what} makes this a different reporting line. End this one and add the new one — history keeps both.`);
      }
    }
  }
  const sets = {};
  if (Object.prototype.hasOwnProperty.call(body, 'isPrimary')) sets.is_primary = bool(body.isPrimary) ? 1 : 0;
  if (Object.prototype.hasOwnProperty.call(body, 'scopeLabel')) sets.scope_label = readText(body.scopeLabel, 'Scope label', 250, problems);
  if (Object.prototype.hasOwnProperty.call(body, 'notes')) sets.notes = readText(body.notes, 'Notes', 2000, problems);
  if (Object.prototype.hasOwnProperty.call(body, 'effectiveTo')) {
    sets.effective_to = readDate(body.effectiveTo, 'Effective to', problems);
    if (sets.effective_to && dateText(row.effective_from) && sets.effective_to < dateText(row.effective_from)) {
      problems.push('Effective to cannot be before effective from.');
    }
  }
  assertNoProblems(problems);
  const keys = Object.keys(sets);
  if (keys.length) {
    await db.query(`UPDATE hrms_position_reporting_relationships SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`, [...keys.map((k) => sets[k]), companyId, id]);
  }
  return { ok: true, id };
}

/** Ending is the normal way a reporting line stops. Deleting one is for a mistake. */
export async function endPositionReporting(db, { companyId }, id, body = {}) {
  const [[row]] = await db.query('SELECT * FROM hrms_position_reporting_relationships WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [companyId, id]);
  if (!row) throw notFound('Reporting relationship');
  const problems = [];
  const effectiveTo = readDate(body.effectiveTo, 'Effective to', problems) ?? today();
  if (dateText(row.effective_from) && effectiveTo < dateText(row.effective_from)) problems.push('A reporting line cannot end before it started.');
  assertNoProblems(problems);
  await db.query('UPDATE hrms_position_reporting_relationships SET effective_to = ? WHERE company_id = ? AND id = ?', [effectiveTo, companyId, id]);
  return { ok: true, id, effectiveTo };
}

export async function removePositionReporting(db, { companyId }, id) {
  const [res] = await db.query('UPDATE hrms_position_reporting_relationships SET deleted_at = NOW() WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!res.affectedRows) throw notFound('Reporting relationship');
  return { ok: true, id };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Occupants — who is actually in this seat
 * ══════════════════════════════════════════════════════════════════════════ */
export async function listPositionOccupants(db, companyId, positionId, query = {}) {
  await requirePosition(db, companyId, positionId);
  const on = dateText(query.on) || today();
  const [rows] = await db.query(
    `SELECT wa.id, wa.employee_id, e.employee_code, e.full_name, wa.role_id, r.title AS role_title,
            wa.allocation_percent, wa.is_primary, wa.status, wa.effective_from, wa.effective_to,
            wa.assignment_title, d.name AS department_name, l.name AS location_name
       FROM hrms_work_assignments wa
       JOIN hrms_employees e ON e.company_id = wa.company_id AND e.id = wa.employee_id
       LEFT JOIN hrms_roles r ON r.company_id = wa.company_id AND r.id = wa.role_id
       LEFT JOIN hrms_departments d ON d.company_id = wa.company_id AND d.id = wa.department_id
       LEFT JOIN hrms_locations l ON l.company_id = wa.company_id AND l.id = wa.location_id
      WHERE wa.company_id = ? AND wa.position_id = ? AND wa.deleted_at IS NULL
      ORDER BY (wa.status = 'ACTIVE') DESC, wa.effective_from DESC`,
    [companyId, positionId],
  );
  const items = rows.map((w) => ({
    id: w.id,
    employeeId: w.employee_id,
    employeeCode: w.employee_code,
    employeeName: w.full_name,
    roleId: w.role_id,
    roleTitle: w.role_title,
    assignmentTitle: w.assignment_title,
    allocationPercent: w.allocation_percent == null ? null : Number(w.allocation_percent),
    isPrimary: Boolean(w.is_primary),
    status: w.status,
    departmentName: w.department_name,
    locationName: w.location_name,
    effectiveFrom: dateText(w.effective_from),
    effectiveTo: dateText(w.effective_to),
    liveOnDate: w.status === 'ACTIVE'
      && (!w.effective_from || dateText(w.effective_from) <= on)
      && (!w.effective_to || dateText(w.effective_to) >= on),
  }));
  return { asOf: on, items, total: items.length, filledCount: items.filter((i) => i.liveOnDate).length };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Position content overrides
 * ══════════════════════════════════════════════════════════════════════════ */
export async function listPositionOverrides(db, companyId, positionId) {
  await requirePosition(db, companyId, positionId);
  const [rows] = await db.query(OVERRIDE_SELECT('hrms_position_content_overrides', 'position_id'), [companyId, positionId]);
  return { items: rows.map(shapeOverride), total: rows.length };
}

export async function addPositionOverride(db, { companyId, userId }, positionId, body) {
  await requirePosition(db, companyId, positionId);
  const o = await readContentOverride(db, companyId, body);
  const [res] = await db.query(
    `INSERT INTO hrms_position_content_overrides
       (company_id, position_id, content_type, kra_definition_id, responsibility_definition_id, kpi_definition_id,
        action, parent_kra_definition_id, override_json, effective_from, effective_to, reason, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, positionId, o.contentType, o.kraDefinitionId, o.responsibilityDefinitionId, o.kpiDefinitionId,
      o.action, o.parentKraDefinitionId, o.overrideJson, o.effectiveFrom, o.effectiveTo, o.reason, userId],
  );
  return { ok: true, id: res.insertId };
}

export async function removePositionOverride(db, { companyId }, id) {
  const [res] = await db.query('UPDATE hrms_position_content_overrides SET deleted_at = NOW() WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!res.affectedRows) throw notFound('Content override');
  return { ok: true, id };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Pickers
 * ══════════════════════════════════════════════════════════════════════════
 * One request for every list a position form needs. Four screens asking for the
 * same six lookups separately is four times the latency and four chances for
 * one of them to be filtered differently from the others.
 */
export async function positionOptions(db, companyId) {
  const q = (sql) => db.query(sql, [companyId]).then(([rows]) => rows);
  const [roles, departments, locations, shifts, contexts, types, positions, kras, responsibilities, kpis] = await Promise.all([
    q("SELECT id, role_code AS code, title AS name, status FROM hrms_roles WHERE company_id = ? AND deleted_at IS NULL ORDER BY title"),
    q('SELECT id, code, name FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL ORDER BY name'),
    q('SELECT id, code, name FROM hrms_locations WHERE company_id = ? AND deleted_at IS NULL ORDER BY name'),
    q('SELECT id, code, name FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY code'),
    q('SELECT id, code, name, context_type AS contextType FROM hrms_work_contexts WHERE company_id = ? AND deleted_at IS NULL ORDER BY name'),
    q('SELECT id, code, name, is_formal AS isFormal, allow_multiple AS allowMultiple, sort_order FROM hrms_reporting_relationship_types WHERE company_id = ? AND deleted_at IS NULL ORDER BY sort_order, id'),
    q(`SELECT p.id, p.position_code AS code, COALESCE(p.position_title, r.title) AS name, r.title AS roleTitle, p.status
         FROM hrms_positions p LEFT JOIN hrms_roles r ON r.company_id = p.company_id AND r.id = p.role_id
        WHERE p.company_id = ? AND p.deleted_at IS NULL ORDER BY name`),
    // The three content masters an override row may point at. Served here so a
    // dialog needs one request and cannot show a definition from another tenant.
    q('SELECT id, code, name FROM hrms_kra_definitions WHERE company_id = ? AND deleted_at IS NULL ORDER BY name'),
    q('SELECT id, code, name FROM hrms_responsibility_definitions WHERE company_id = ? AND deleted_at IS NULL ORDER BY name LIMIT 500'),
    q('SELECT id, code, name FROM hrms_kpi_definitions WHERE company_id = ? AND deleted_at IS NULL ORDER BY name'),
  ]);
  return {
    kraDefinitions: kras,
    responsibilityDefinitions: responsibilities,
    kpiDefinitions: kpis,
    roles,
    departments,
    locations,
    shifts,
    workContexts: contexts,
    relationshipTypes: types.map((t) => ({ ...t, isFormal: Boolean(t.isFormal), allowMultiple: Boolean(t.allowMultiple) })),
    positions,
    scopeTypes: SCOPE_TYPES,
    positionStatuses: POSITION_STATUSES,
  };
}
