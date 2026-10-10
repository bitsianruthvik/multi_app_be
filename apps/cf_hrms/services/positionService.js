import {
  SEATS_PER_POSITION, HOLDS_SEAT_SQL, filledSeats, vacancies as vacancyOf, overFilled as overFilledOf,
} from './seatCount.js';
import { computeCards, cardMembers, loadCards, chairOnShift } from './positionCards.js';
import { openHiringsByPosition, COMING_OR_LIVE_SQL, splitComing, dayText } from './hiringRead.js';
/**
 * positionService.js — positions, their work contexts, the FORMAL reporting
 * structure between them, and position content overlays. (Plan §5.4, §7.)
 *
 * A Position is a *sanctioned seat*: the organisation's design, independent of
 * who is in it. That is why formal reporting lives between positions and not
 * between people — a vacancy still has a manager, and replacing a person does
 * not rewrite the chart.
 *
 * ONE POSITION IS ONE CHAIR (2026-10-10; services/seatCount.js has the rule).
 * A position is for one person on one shift. `sanctioned_headcount` is always
 * written as 1 whatever a caller sends; `default_shift_id` is the position's
 * shift, set on create (the company's General shift when none is given) and
 * never cleared. Twelve helpers are twelve positions — "one more like this" is
 * addSiblingPosition, and the chart draws the twelve as one CARD
 * (services/positionCards.js). Reporting lines run chair to chair, but a team
 * reports to the CARD: taking one chair away leaves its team with the card's
 * other chairs, and only the card's last chair sends the team up a level.
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
 * VACANCY IS A FACT, NOT AN ERROR. A position with nobody in it is reported as
 * vacant and never as a failure; 149 of Karni's 220 positions are vacant and
 * that is the truth the system exists to show.
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

/**
 * `people` is who holds this chair on the date: none or one. Two is wrong data
 * (assignmentService refuses it); it shows as overFilled and still counts as
 * one filled seat. `sanctionedHeadcount`, `seats`, `filledCount` and
 * `vacancyCount` keep their names for the screens that read them — they are
 * now 1, 1, 0|1 and 1|0.
 *
 * `hiring` is the OPEN hiring on the position, or null (services/hiringRead.js).
 * A position somebody is being hired for is still vacant.
 */
function shapePosition(p, people = [], hiring = null, joining = null) {
  const live = people.length;
  const first = people[0] ?? null;
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
    sanctionedHeadcount: SEATS_PER_POSITION,
    seats: SEATS_PER_POSITION,
    filledCount: filledSeats(live),
    // A fact, not an error.
    vacancyCount: vacancyOf(live),
    overFilled: overFilledOf(live),
    // The one person in this position, or null when it is vacant.
    occupant: first
      ? { employeeId: first.employee_id, name: first.full_name, employeeCode: first.employee_code ?? null, assignmentId: first.assignment_id }
      : null,
    hiring: hiring ?? null,
    // Who is due to join it from a later date, or null. Still vacant until then.
    joining: joining ?? null,
    // The position's shift, as an object and (older readers) as three flat fields.
    shift: p.default_shift_id ? { id: p.default_shift_id, code: p.shift_code ?? null, name: p.shift_name ?? null } : null,
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

/**
 * Who holds which chair on a date — one read for the whole company (or one
 * position), joined to the rows in memory. "Holds" is seatCount.js's predicate.
 *
 * The same read also finds who is DUE TO JOIN a position from a later date
 * (hiringRead.js): the rows are "not over yet" rather than "in date", and are
 * split in memory.
 * @returns {{ live: Map<number, Array>, joining: Map<number, object> }}
 *   live: position id -> the people in it (normally one); joining: position id -> who joins it
 */
async function occupantsByPosition(db, companyId, on, positionId = null) {
  const [rows] = await db.query(
    `SELECT wa.id AS assignment_id, wa.position_id, wa.employee_id, wa.effective_from, e.full_name, e.employee_code
       FROM hrms_work_assignments wa
       JOIN hrms_employees e ON e.company_id = wa.company_id AND e.id = wa.employee_id
      WHERE wa.company_id = ? AND ${HOLDS_SEAT_SQL('wa')} AND ${COMING_OR_LIVE_SQL('wa')}${positionId == null ? '' : ' AND wa.position_id = ?'}
      ORDER BY wa.is_primary DESC, wa.id`,
    positionId == null ? [companyId, on] : [companyId, on, positionId],
  );
  const { live, joining } = splitComing(rows, on);
  const by = new Map();
  for (const r of live) by.set(r.position_id, [...(by.get(r.position_id) ?? []), r]);
  return { live: by, joining };
}

export async function listPositions(db, companyId, query = {}) {
  const on = dateText(query.on) || today();
  const where = ['p.company_id = ?', 'p.deleted_at IS NULL'];
  const params = [companyId];

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

  // One extra read for the whole list, never one per row.
  const [[rows], people, hirings] = await Promise.all([
    db.query(`${POSITION_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.title, p.position_code, p.id`, params),
    occupantsByPosition(db, companyId, on),
    openHiringsByPosition(db, companyId),
  ]);
  const items = rows.map((p) => shapePosition(p, people.live.get(p.id), hirings.get(p.id), people.joining.get(p.id)));
  return {
    asOf: on,
    items,
    total: items.length,
    // The StatStrip's numbers, computed over the SAME filtered set the list
    // shows, so they can never disagree with the rows underneath. A position is
    // one seat, so `sanctioned` is the number of rows. (A CLOSED row is listed
    // when the filter asks for it and is then counted here too; the chart and
    // Home never count one.)
    totals: {
      positions: items.length,
      sanctioned: items.length,
      filled: items.reduce((n, p) => n + p.filledCount, 0),
      vacant: items.reduce((n, p) => n + p.vacancyCount, 0),
      overFilled: items.filter((p) => p.overFilled).length,
    },
  };
}

export async function getPosition(db, companyId, id, query = {}) {
  const on = dateText(query.on) || today();
  const [[[row]], people, hirings] = await Promise.all([
    db.query(`${POSITION_SELECT} WHERE p.company_id = ? AND p.id = ? AND p.deleted_at IS NULL`, [companyId, id]),
    occupantsByPosition(db, companyId, on, id),
    openHiringsByPosition(db, companyId, id),
  ]);
  if (!row) throw notFound('Position');
  return { asOf: on, position: shapePosition(row, people.live.get(row.id), hirings.get(row.id), people.joining.get(row.id)) };
}

/** The shift a new position gets when none is named: General (a code starting 'G'), else the company's first. */
async function generalShiftId(db, companyId) {
  const [shifts] = await db.query('SELECT id, code FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY id', [companyId]);
  const general = shifts.find((s) => String(s.code ?? '').trim().toUpperCase().startsWith('G'));
  return (general ?? shifts[0])?.id ?? null;
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

  // The position's shift. A new position with none named gets the company's
  // General shift; an existing one cannot be left without one — a chair is on a
  // shift, and "no shift" is how the old day/night box used to be written.
  if (!partial && out.default_shift_id == null) out.default_shift_id = await generalShiftId(db, companyId);
  if (partial && has('defaultShiftId') && out.default_shift_id == null && !problems.some((p) => /shift/i.test(p))) {
    if (current?.default_shift_id != null) problems.push('A position is on one shift. Choose the shift this position works.');
    else delete out.default_shift_id;
  }

  // One position is one seat. Whatever a caller sends here is ignored without
  // complaint — older forms still post the field — and 1 is what is stored.
  if (!partial || has('sanctionedHeadcount')) out.sanctioned_headcount = SEATS_PER_POSITION;
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

/**
 * Changing a position's SHIFT moves the person in it: the chair is on a shift,
 * so whoever sits in it is on that shift too. Their work assignment's
 * `default_shift_id` follows in the same transaction (a planned successor's
 * too); ended assignments keep the shift they were worked on.
 */
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
  let occupantsMoved = 0;
  if (data.default_shift_id != null && data.default_shift_id !== current.default_shift_id) {
    const [res] = await db.query(
      `UPDATE hrms_work_assignments wa SET wa.default_shift_id = ?
        WHERE wa.company_id = ? AND wa.position_id = ? AND ${HOLDS_SEAT_SQL('wa')}
          AND (wa.effective_to IS NULL OR wa.effective_to >= ?)`,
      [data.default_shift_id, companyId, id, today()],
    );
    occupantsMoved = res.affectedRows;
  }
  return { ...(await getPosition(db, companyId, id)), occupantsMovedToShift: occupantsMoved };
}

/** `P021-3` -> `P021`; a code with no `-<digits>` tail is its own base. */
const siblingBase = (code) => String(code).replace(/-\d+$/, '');

/**
 * POST /positions/:id/add-sibling — one more position like this one: a new,
 * VACANT chair in the same card.
 *
 *   - same role, title, department, location, status and dates as the source;
 *   - shift = `shiftId` when given, else the source's;
 *   - the source's reporting lines (every type, not yet ended), each pointed at
 *     the manager card's chair on the NEW position's shift when that card has
 *     one, else exactly where the source points — the rule the migration used
 *     (scripts/one-chair-positions.mjs), so a night chair lands under the night
 *     in-charge without anyone drawing a line;
 *   - NO position-level content: a change made "for this position only" was
 *     made for that position. The new one starts from the role;
 *   - code = the source's code without a trailing `-<digits>`, plus `-<n>` with
 *     the lowest n >= 2 that is free. The source keeps its code.
 *
 * The same role, department and manager card put it in the source's card by
 * construction (services/positionCards.js). Returns what create returns.
 */
export async function addSiblingPosition(db, c, id, body = {}) {
  const { companyId, userId } = c;
  const source = await requirePosition(db, companyId, id, { lock: true });
  const sourceTitle = source.position_title || `Position ${source.id}`;
  if (source.status === 'CLOSED') {
    throw conflict('POSITION_CLOSED', `${sourceTitle} is closed, so another position like it cannot be added. Reopen it first, or create a new position.`);
  }

  const problems = [];
  const givenShiftId = readInt(body.shiftId, 'Shift', problems);
  if (givenShiftId != null) await exists(db, companyId, 'hrms_shifts', givenShiftId, 'shift', problems);
  assertNoProblems(problems);
  const shiftId = givenShiftId ?? source.default_shift_id ?? await generalShiftId(db, companyId);

  // The code. Only live positions hold a code (uq_hpos_code keys off deleted_at).
  let code = null;
  if (!blank(source.position_code)) {
    const base = siblingBase(source.position_code);
    const [taken] = await db.query(
      'SELECT position_code FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL AND LOWER(position_code) LIKE ?',
      [companyId, `${base.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}-%`],
    );
    const used = new Set(taken.map((r) => String(r.position_code).toLowerCase()));
    let n = 2;
    while (used.has(`${base}-${n}`.toLowerCase())) n += 1;
    code = `${base}-${n}`;
    if (code.length > 50) throw invalid('INVALID', `The next code would be ${code}, which is longer than 50 characters. Shorten ${source.position_code} first.`);
  }

  const [res] = await db.query(
    `INSERT INTO hrms_positions (company_id, position_code, role_id, position_title, department_id, location_id,
                                 sanctioned_headcount, default_shift_id, status, effective_from, effective_to, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, code, source.role_id, source.position_title, source.department_id, source.location_id,
      SEATS_PER_POSITION, shiftId, source.status, dateText(source.effective_from), dateText(source.effective_to), userId],
  );
  const newId = res.insertId;

  // Its reporting lines: the source's, on the new chair's shift where the manager card has that shift.
  const on = today();
  const [lines] = await db.query(
    `SELECT * FROM hrms_position_reporting_relationships
      WHERE company_id = ? AND from_position_id = ? AND deleted_at IS NULL AND (effective_to IS NULL OR effective_to >= ?)
      ORDER BY id`,
    [companyId, id, on],
  );
  const reportsTo = [];
  if (lines.length) {
    const cards = await loadCards(db, companyId, on);
    const shiftOf = (positionId) => cards.positions.get(positionId)?.shiftId ?? null;
    const rows = lines.map((e) => {
      const managerCard = cards.members.get(cards.cardOf.get(e.to_position_id)) ?? [];
      const to = chairOnShift(managerCard, shiftOf, shiftId, e.to_position_id);
      reportsTo.push({ toPositionId: to, relationshipTypeId: e.relationship_type_id });
      return [companyId, newId, to, e.relationship_type_id, e.is_primary, e.scope_type, e.scope_label, e.scope_work_context_id,
        dateText(e.effective_from), e.effective_to ? dateText(e.effective_to) : null, e.notes, userId];
    });
    await db.query(
      `INSERT INTO hrms_position_reporting_relationships
         (company_id, from_position_id, to_position_id, relationship_type_id, is_primary,
          scope_type, scope_label, scope_work_context_id, effective_from, effective_to, notes, created_by)
       VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      rows.flat(),
    );
  }

  await audit(db, c, newId, 'CREATE', null,
    { addedBeside: id, positionCode: code, roleId: source.role_id, defaultShiftId: shiftId, reportsTo });
  return getPosition(db, companyId, newId);
}

/**
 * Sets the status and nothing else. NOTE for CLOSED: the chart does not draw a
 * closed seat, so closing a seat that has direct reports leaves them as tops of
 * the chart. closePosition (below) is the call that also moves them up; this one
 * stays exactly as it was because the workbook import calls it after moving the
 * reporting lines itself.
 */
export async function setPositionStatus(db, { companyId }, id, status) {
  await requirePosition(db, companyId, id, { lock: true });
  const problems = [];
  const next = readEnum(status, 'Status', POSITION_STATUSES, problems);
  assertNoProblems(problems);
  await db.query('UPDATE hrms_positions SET status = ? WHERE company_id = ? AND id = ?', [next, companyId, id]);
  return getPosition(db, companyId, id);
}

/* ══════════════════════════════════════════════════════════════════════════
 * Taking a seat off the chart — close it, delete it alone, or delete its team
 * ══════════════════════════════════════════════════════════════════════════
 *
 * THE BUG THIS REPLACES. deletePosition used to soft-delete every reporting row
 * that named the seat — `from_position_id = ? OR to_position_id = ?` — and the
 * second half of that OR is the seat's own TEAM's line to its manager. Delete
 * "Production Manager" and ten positions lost the only edge that placed them in
 * the organisation: the chart drew eleven tops and nobody was told. (Measured on
 * Karni's local data: deleting a seat with four reports took the chart from 1
 * root to 5. Closing it did exactly the same, because the chart does not draw a
 * CLOSED seat — see closePosition.)
 *
 * So removing a seat is a decision about its team, and the decision is never
 * made silently:
 *   THIS_ONLY  the seat goes; its direct reports are re-homed. A TEAM REPORTS
 *              TO THE CARD (2026-10-10, one chair per position): while another
 *              open chair of the same card remains, each report moves to that
 *              card's chair on the report's own shift, else to its first
 *              remaining chair — nobody changes manager-in-the-chart because
 *              one of two in-charge chairs was removed. Only when the seat was
 *              the card's LAST chair do they move UP one level, to the seat's
 *              own manager — what an organisation does when a job is abolished.
 *              A last chair with no manager has nowhere to send them, so it is
 *              REFUSED rather than turned into N new tops.
 *   WITH_TEAM  the seat and every position under it go. If any of them holds a
 *              live work assignment the whole thing is refused, by name —
 *              never half a subtree.
 *   CLOSE      the seat stays, with its history. See closePosition.
 *
 * "ITS MANAGER" MEANS THE PRIMARY_MANAGER LINE LIVE TODAY. Reporting is not a
 * column (plan §2 rule 1, §3.1): there is no position.manager_id, a position
 * can have several managers with different types and scopes, and only one of
 * them — the PRIMARY_MANAGER edge — is the line the chart lays its tree out on
 * (orgChartService). Dotted, functional and project lines are other rows with
 * other scopes. They are not "the manager", so they are NOT moved; they go with
 * the seat they point at, and the impact says how many. A position with no live
 * PRIMARY_MANAGER line is a root. If the manager's own seat is CLOSED the chart
 * does not draw it either, so the walk goes on up to the first seat that is.
 *
 * ONE FUNCTION DECIDES. assess() answers "what would each outcome do, and may
 * it?" from three company-wide reads, in memory. The impact endpoint serves its
 * answer, and every write calls it again inside its own transaction and refuses
 * in the same words — so what the dialog promised and what the server enforces
 * cannot drift, and a stale dialog is caught by `expect` (the number the person
 * saw) rather than by luck.
 *
 * ROUND TRIPS. The team is walked in memory over one company-wide edge list,
 * and every write is one statement for the whole set (`IN (...)`, one multi-row
 * INSERT). A 41-seat team costs the same dozen statements as a leaf — the
 * difference between 0.6 s and 25 s against production (49 ms a trip).
 *
 * Nothing here is a hard delete. Everything is `deleted_at`, and uniqueness
 * lives on VIRTUAL columns that key off it (uq_hprr_edge), so a moved line is
 * written as a NEW row and the old one retired — never edited into another
 * manager's row. The one exception is the unique-key trap in moveReports.
 */
export const REMOVAL_MODES = ['THIS_ONLY', 'WITH_TEAM'];

/** The relationship type whose edges ARE the chart's tree. */
const PRIMARY_MANAGER = 'PRIMARY_MANAGER';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const liveOnDate = (row, on) =>
  (!row.effective_from || dateText(row.effective_from) <= on) && (!row.effective_to || dateText(row.effective_to) >= on);

/**
 * Everything assess() needs, from three queries for the whole company. Positions
 * are few (Karni: 130) and the chart loads the same edge list on every render,
 * so reading it all is cheaper than being clever about which rows.
 */
async function loadStructure(db, companyId, on) {
  const [positionRows] = await db.query(
    `SELECT p.id, p.position_code, p.position_title, p.status, p.effective_from, p.effective_to, r.title AS role_title,
            p.role_id, p.department_id, p.default_shift_id
       FROM hrms_positions p
       LEFT JOIN hrms_roles r ON r.company_id = p.company_id AND r.id = p.role_id
      WHERE p.company_id = ? AND p.deleted_at IS NULL`,
    [companyId],
  );
  // Every edge of every type, live or not: assess() needs the primary tree AND a
  // count of what else touches a seat (secondary, planned and ended lines).
  const [edges] = await db.query(
    `SELECT rr.*, t.code AS type_code
       FROM hrms_position_reporting_relationships rr
       JOIN hrms_reporting_relationship_types t ON t.company_id = rr.company_id AND t.id = rr.relationship_type_id
      WHERE rr.company_id = ? AND rr.deleted_at IS NULL`,
    [companyId],
  );
  // The SAME predicate the delete guard has always used (not "ACTIVE and live
  // today"): a planned or suspended assignment still points at the seat.
  const [assignmentRows] = await db.query(
    `SELECT position_id, COUNT(*) AS n FROM hrms_work_assignments
      WHERE company_id = ? AND deleted_at IS NULL AND status <> 'ENDED' AND position_id IS NOT NULL
      GROUP BY position_id`,
    [companyId],
  );

  // What promises a position to somebody: an open hiring, or a person appointed
  // from a later date. Either stops a close or a delete (assess, below).
  const hirings = await openHiringsByPosition(db, companyId);
  const [comingRows] = await db.query(
    `SELECT wa.id AS assignment_id, wa.position_id, wa.employee_id, wa.effective_from, e.full_name, e.employee_code
       FROM hrms_work_assignments wa
       JOIN hrms_employees e ON e.company_id = wa.company_id AND e.id = wa.employee_id
      WHERE wa.company_id = ? AND ${HOLDS_SEAT_SQL('wa')} AND wa.effective_from > ?`,
    [companyId, on],
  );
  const { joining } = splitComing(comingRows, on);

  const byId = new Map(positionRows.map((p) => [p.id, {
    id: p.id,
    code: p.position_code ?? null,
    title: p.position_title || p.role_title || `Position ${p.id}`,
    status: p.status,
    open: p.status !== 'CLOSED' && liveOnDate(p, on),   // does the chart draw it?
    roleId: p.role_id,
    departmentId: p.department_id ?? null,
    shiftId: p.default_shift_id ?? null,
  }]));

  // "The" manager of a position: its PRIMARY_MANAGER line live today — the first
  // by the chart's own order (is_primary, then id) if the data ever holds two.
  const parentEdge = new Map();
  const reportsOf = new Map();
  const treeCandidates = edges
    .filter((e) => e.type_code === PRIMARY_MANAGER && liveOnDate(e, on) && byId.has(e.from_position_id) && byId.has(e.to_position_id))
    .sort((a, b) => (Number(b.is_primary) - Number(a.is_primary)) || (a.id - b.id));
  for (const e of treeCandidates) {
    if (parentEdge.has(e.from_position_id)) continue;
    parentEdge.set(e.from_position_id, e);
    const list = reportsOf.get(e.to_position_id) ?? [];
    list.push(e.from_position_id);
    reportsOf.set(e.to_position_id, list);
  }
  for (const list of reportsOf.values()) list.sort((a, b) => a - b);

  // The cards, over the positions the chart draws — the same rule and the same
  // inputs the chart uses (positionCards.js), so "the other chairs of this
  // card" here are the rows the person saw in the box.
  const openParent = new Map();
  for (const [from, e] of parentEdge) openParent.set(from, e.to_position_id);
  const cardOf = computeCards([...byId.values()].filter((p) => p.open), openParent);

  return {
    byId,
    edges,
    parentEdge,
    reportsOf,
    cardOf,
    cardMembersOf: cardMembers(cardOf),
    treeEdgeIds: new Set([...parentEdge.values()].map((e) => e.id)),
    assignments: new Map(assignmentRows.map((r) => [r.position_id, Number(r.n)])),
    hirings,
    joining,
  };
}

const seatInfo = (s, id) => {
  const p = s.byId.get(id);
  return { id: p.id, positionCode: p.code, title: p.title, status: p.status };
};
const seatLabel = (p) => (p.positionCode ? `${p.title} (${p.positionCode})` : p.title);

/**
 * What each outcome would do to this seat, and whether it may. Pure: takes the
 * structure loadStructure() read and touches no database.
 */
function assess(s, id, on) {
  const seat = s.byId.get(id);
  if (!seat) throw notFound('Position');

  // The team: every position under this one by PRIMARY_MANAGER lines. Walked a
  // level at a time over the in-memory map, with a seen-set so a loop in bad
  // data ends the walk instead of hanging it.
  const direct = s.reportsOf.get(id) ?? [];
  const inTeam = new Set([id]);
  const team = [];
  let frontier = [id];
  while (frontier.length) {
    const next = [];
    for (const x of frontier) {
      for (const k of s.reportsOf.get(x) ?? []) {
        if (inTeam.has(k)) continue;
        inTeam.add(k);
        team.push(k);
        next.push(k);
      }
    }
    frontier = next;
  }

  // Where a team goes if its seat goes: the first OPEN seat up the primary chain.
  let up = s.parentEdge.get(id)?.to_position_id ?? null;
  const climbed = new Set([id]);
  while (up != null && !s.byId.get(up).open) {
    if (climbed.has(up) || climbed.size > MAX_CHAIN) { up = null; break; }
    climbed.add(up);
    up = s.parentEdge.get(up)?.to_position_id ?? null;
  }

  // A team reports to the CARD. While another open chair of this seat's card
  // remains, the reports stay with the card: each goes to the remaining chair
  // on its OWN shift, else to the first remaining one (the migration's rule).
  // Only the card's last chair sends them up.
  const cardId = s.cardOf.get(id);
  const remaining = cardId == null ? [] : (s.cardMembersOf.get(cardId) ?? []).filter((x) => x !== id);
  const withinCard = remaining.length > 0;
  const targetOf = new Map();
  for (const reportId of direct) {
    const to = withinCard
      ? chairOnShift(remaining, (x) => s.byId.get(x).shiftId, s.byId.get(reportId).shiftId, remaining[0])
      : up;
    if (to != null) targetOf.set(reportId, to);
  }
  const targetIds = [...new Set(targetOf.values())].sort((x, y) => x - y);
  const targets = targetIds.map((x) => ({ ...seatInfo(s, x), reports: direct.filter((r) => targetOf.get(r) === x).length }));
  // `manager` is what the wire has always called "where the reports go": the
  // one target, or the one taking most of them when a card splits them by shift.
  const main = withinCard
    ? ([...targets].sort((x, y) => y.reports - x.reports || x.id - y.id)[0]?.id ?? remaining[0])
    : up;
  const manager = main == null ? null : seatInfo(s, main);

  const assignmentsOf = (x) => s.assignments.get(x) ?? 0;
  const ownAssignments = assignmentsOf(id);
  const blockers = team
    .filter((x) => assignmentsOf(x) > 0)
    .map((x) => ({ ...seatInfo(s, x), assignments: assignmentsOf(x) }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id - b.id);

  // Lines that touch the seat(s) and are NOT part of the live primary tree:
  // dotted / functional / project lines, and ended or not-yet-started ones.
  // They go with the seat. Counted so that "go with it" is a number.
  const otherLines = (set) => s.edges.filter(
    (e) => !s.treeEdgeIds.has(e.id) && (set.has(e.from_position_id) || set.has(e.to_position_id)),
  ).length;

  const noWhere = direct.length > 0 && manager == null;
  const looped = targetIds.some((x) => inTeam.has(x)) || (manager != null && inTeam.has(manager.id));
  const t = seat.title;
  const rootReason = `${s.parentEdge.has(id) ? `Every position above ${t} is closed` : `${t} is at the top of the chart`}, so its ${plural(direct.length, 'direct report')} would have nobody to report to. Give them another manager first, or delete it with its team.`;
  const ok = { allowed: true, code: null, reason: null, problems: [] };
  const no = (code, reason, problems = [], extra = null) => ({ allowed: false, code, reason, problems, extra });

  // PROMISED TO SOMEBODY. A position with an open hiring, or with a person
  // appointed from a later date, can be neither closed nor deleted: the hiring
  // would be left pointing at a chair that is gone, and the person would arrive
  // to no position. Both outrank every other reason — nothing else the person
  // fixes makes the removal possible.
  const hiring = s.hirings.get(id) ?? null;
  const joiner = s.joining.get(id) ?? null;
  const hiringOpen = hiring && no('HIRING_OPEN', 'A hiring is open for this position. Close the hiring first.', [],
    { existing: { id: hiring.id, stage: hiring.stage }, detail: { hiringId: hiring.id, positionId: id } });
  const joinerDue = joiner && no('POSITION_FILLED',
    `${joiner.name} joins this position on ${dayText(joiner.date)}. End that assignment first.`, [],
    { detail: { positionId: id, joining: joiner } });
  const promised = hiringOpen || joinerDue;
  const teamHirings = team.filter((x) => s.hirings.has(x)).map((x) => ({ ...seatInfo(s, x), hiringId: s.hirings.get(x).id }));
  const teamHiringOpen = teamHirings.length > 0 && no('HIRING_OPEN',
    `${plural(teamHirings.length, 'position')} under ${seat.title} ${teamHirings.length === 1 ? 'has' : 'have'} a hiring open (${teamHirings.slice(0, 3).map(seatLabel).join(', ')}${teamHirings.length > 3 ? ` and ${teamHirings.length - 3} more` : ''}). Close ${teamHirings.length === 1 ? 'that hiring' : 'those hirings'} first.`,
    teamHirings.slice(0, 25).map(seatLabel),
    { existing: { id: teamHirings[0]?.hiringId }, detail: { hiringId: teamHirings[0]?.hiringId, hiringIds: teamHirings.map((x) => x.hiringId) } });

  const inUse = ownAssignments > 0
    && no('IN_USE', `${plural(ownAssignments, 'work assignment')} still ${ownAssignments === 1 ? 'points' : 'point'} at this position. End ${ownAssignments === 1 ? 'it' : 'them'}, or close the position instead of deleting it.`);
  const loop = looped
    && no('REPORTING_LOOP', `The position above ${t} is also somewhere under it, which is a loop in the reporting lines. Fix those first.`);

  const close = seat.status === 'CLOSED' ? no('ALREADY_CLOSED', 'It is already closed.')
    : promised || (noWhere ? no('ROOT_HAS_TEAM', rootReason)
      : loop || ok);
  const deleteOnly = promised || inUse || (noWhere && no('ROOT_HAS_TEAM', rootReason)) || loop || ok;

  const shown = blockers.slice(0, 3).map(seatLabel).join(', ');
  const more = blockers.length > 3 ? ` and ${blockers.length - 3} more` : '';
  const deleteWithTeam = promised || inUse || teamHiringOpen
    || (blockers.length > 0 && no(
      'TEAM_IN_USE',
      `Cannot delete ${t} with its team: ${plural(blockers.length, 'position')} under it still ${blockers.length === 1 ? 'has' : 'have'} people assigned (${shown}${more}). End those assignments first, or close the positions instead.`,
      blockers.slice(0, 25).map((b) => `${seatLabel(b)} — ${plural(b.assignments, 'work assignment')}`)
        .concat(blockers.length > 25 ? [`…and ${blockers.length - 25} more`] : []),
    ))
    || ok;

  return {
    on,
    seat: seatInfo(s, id),
    manager,
    // Where each direct report goes, and whether that is inside the card.
    withinCard,
    targetOf,
    targets,
    cardId: cardId ?? id,
    remainingInCard: remaining.length,
    directIds: direct,
    teamIds: team,
    ownAssignments,
    hiring,
    joining: joiner,
    blockers,
    otherLines: { thisOnly: otherLines(new Set([id])), withTeam: otherLines(inTeam) },
    closedInTeam: team.filter((x) => s.byId.get(x).status === 'CLOSED').length,
    outcomes: { close, deleteOnly, deleteWithTeam },
  };
}

/** The wire shape of an assessment — what the dialog reads before anyone confirms. */
function shapeImpact(s, a) {
  const out = (o, extra) => ({ allowed: o.allowed, code: o.code, reason: o.reason, ...extra });
  return {
    asOf: a.on,
    position: a.seat,
    // Where its direct reports would move to. null = nowhere: it is its card's
    // last chair and has no open seat above it.
    manager: a.manager,
    // 'CARD' = they stay with the card, on its other chair(s); 'UP' = this is
    // the card's last chair, so they go up a level. `moveTargets` lists every
    // chair that takes some, with how many.
    movesReportsTo: a.directIds.length === 0 ? null : (a.withinCard ? 'CARD' : 'UP'),
    moveTargets: a.targets,
    card: { cardId: a.cardId, otherPositions: a.remainingInCard },
    directReports: a.directIds.map((x) => ({
      ...seatInfo(s, x), assignments: s.assignments.get(x) ?? 0, movesToPositionId: a.targetOf.get(x) ?? null,
    })),
    team: {
      count: a.teamIds.length,          // positions under it, all levels
      total: a.teamIds.length + 1,      // what "with its team" deletes: those, plus the seat
      closed: a.closedInTeam,
      blockers: a.blockers,             // team members holding live work assignments
    },
    ownAssignments: a.ownAssignments,
    // What promises this position to somebody: its open hiring, the person due to join it. Either blocks all three outcomes.
    hiring: a.hiring,
    joining: a.joining,
    otherLines: a.otherLines,           // dotted / functional / planned / ended lines that go with it
    outcomes: {
      close: out(a.outcomes.close, { movesReports: a.directIds.length }),
      deleteOnly: out(a.outcomes.deleteOnly, { movesReports: a.directIds.length }),
      deleteWithTeam: out(a.outcomes.deleteWithTeam, { deletes: a.teamIds.length + 1 }),
    },
  };
}

/**
 * GET /positions/:id/delete-impact — what closing, deleting alone and deleting
 * with the team would each do, before anyone does it. A separate read rather
 * than a field on GET /positions/:id because it costs three company-wide
 * queries, and that belongs to the one screen that asks, not to every list and
 * detail load.
 */
export async function getDeleteImpact(db, companyId, id) {
  const on = today();
  const s = await loadStructure(db, companyId, on);
  return shapeImpact(s, assess(s, id, on));
}

function refuse(outcome) {
  if (!outcome.allowed) throw conflict(outcome.code, outcome.reason, { ...(outcome.problems?.length ? { problems: outcome.problems } : {}), ...(outcome.extra ?? {}) });
}

/** `expect` is the number the person saw. */
function readExpect(value, problems) {
  if (blank(value)) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) { problems.push('expect must be a whole number.'); return null; }
  return n;
}
/** If the world moved under the dialog, say so instead of doing more than they agreed to. */
function checkExpect(expect, actual, what) {
  if (expect != null && expect !== actual) {
    throw conflict('IMPACT_CHANGED', `This changed while you were deciding: it now ${what(actual)}, not ${expect}. Look again before you confirm.`);
  }
}

const noteTrail = (existing, line) => (blank(existing) ? line : `${existing}\n${line}`);

/**
 * Moves a seat's direct reports to where assess() said each one goes
 * (`a.targetOf` — another chair of the seat's card, or the seat's manager when
 * it was the card's last chair): for each, the PRIMARY_MANAGER line to the seat
 * becomes the same line (same type, scope, primary flag) to its target.
 * Set-based: one INSERT for all of them.
 *
 *   keepHistory = false  (delete) the old line is retired by the caller's
 *     cascade, and the new one keeps the old one's dates — a deleted seat leaves
 *     no trace, so its team reported to the manager all along, and a chart for
 *     an earlier date does not grow tops the delete never meant to make.
 *   keepHistory = true   (close) the old line is ENDED the day before (or
 *     retired if it began today) and the new one starts today — a closed seat
 *     keeps its history, so history must show the team reporting to it until now.
 *
 * THE UNIQUE-KEY TRAP. uq_hprr_edge is (from, to, type, scope) and takes no
 * dates, so a report that once reported to this manager — an ended row from an
 * earlier re-org, which is exactly how this app moves people — already owns the
 * key the new line needs. An INSERT would die on a duplicate key halfway through
 * a team. So that row is REUSED, its dates widened to cover the new range. The
 * org-chart workbook import resolves the same collision the same way
 * (org-apply-workbook.mjs, "reopened"), so the two paths agree.
 */
async function moveReports(db, { companyId, userId }, s, a, { keepHistory }) {
  if (!a.directIds.length) return [];
  const on = a.on;
  const yesterday = previousDay(on);
  // Each report has its own target (a.targetOf): another chair of the seat's
  // card while one remains, the seat's manager when it was the last.
  const trail = `Moved ${a.withinCard ? 'across' : 'up'} from ${seatLabel(a.seat)} on ${on}, when that position was ${keepHistory ? 'closed' : 'deleted'}.`;

  const targetIds = new Set(a.targetOf.values());
  const owned = new Map();
  for (const f of s.edges) {
    if (targetIds.has(f.to_position_id)) owned.set(`${f.to_position_id}|${f.from_position_id}|${f.relationship_type_id}|${f.scope_key}`, f);
  }

  const rows = [];
  const widen = [];
  const endNow = [];
  const retireNow = [];
  for (const reportId of a.directIds) {
    const e = s.parentEdge.get(reportId);
    const targetId = a.targetOf.get(reportId);
    const from = keepHistory ? on : dateText(e.effective_from);
    const to = e.effective_to ? dateText(e.effective_to) : null;
    const f = owned.get(`${targetId}|${e.from_position_id}|${e.relationship_type_id}|${e.scope_key}`);
    if (f) {
      const fFrom = dateText(f.effective_from);
      const fTo = f.effective_to ? dateText(f.effective_to) : null;
      const wFrom = fFrom < from ? fFrom : from;
      const wTo = fTo == null || to == null ? null : (fTo > to ? fTo : to);
      if (wFrom !== fFrom || wTo !== fTo) widen.push({ id: f.id, from: wFrom, to: wTo });
    } else {
      rows.push([
        companyId, e.from_position_id, targetId, e.relationship_type_id, e.is_primary,
        e.scope_type, e.scope_label, e.scope_work_context_id, from, to, noteTrail(e.notes, trail), userId,
      ]);
    }
    if (keepHistory) (dateText(e.effective_from) > yesterday ? retireNow : endNow).push(e.id);
  }

  if (rows.length) {
    await db.query(
      `INSERT INTO hrms_position_reporting_relationships
         (company_id, from_position_id, to_position_id, relationship_type_id, is_primary,
          scope_type, scope_label, scope_work_context_id, effective_from, effective_to, notes, created_by)
       VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      rows.flat(),
    );
  }
  for (const w of widen) {
    await db.query('UPDATE hrms_position_reporting_relationships SET effective_from = ?, effective_to = ? WHERE company_id = ? AND id = ?', [w.from, w.to, companyId, w.id]);
  }
  if (endNow.length) {
    await db.query(
      `UPDATE hrms_position_reporting_relationships SET effective_to = ? WHERE company_id = ? AND id IN (${endNow.map(() => '?').join(',')})`,
      [yesterday, companyId, ...endNow],
    );
  }
  if (retireNow.length) {
    await db.query(
      `UPDATE hrms_position_reporting_relationships SET deleted_at = NOW() WHERE company_id = ? AND id IN (${retireNow.map(() => '?').join(',')})`,
      [companyId, ...retireNow],
    );
  }
  return a.directIds.map((x) => ({ ...seatInfo(s, x), movedToPositionId: a.targetOf.get(x) }));
}

/** "to Printing Incharge (P024-2)" / "up to Production Manager" — where a seat's reports go, in the dialog's words. */
function whereTo(a) {
  if (!a.withinCard) return `up to ${a.manager.title}`;
  const names = a.targets.map(seatLabel);
  return `to ${names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`}, in the same card`;
}

/** Append-only; written in the caller's transaction (init.sql §9c). TiDB has no triggers. */
async function audit(db, { companyId, userId }, entityId, action, before, after) {
  await db.query(
    `INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_by)
     VALUES (?, ?, 'hrms_positions', ?, ?, ?, ?, ?)`,
    [companyId, userId, entityId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, userId],
  );
}

/**
 * Soft-delete a seat — alone (its team moves up) or with everything under it.
 *
 * `mode` is required whenever the seat HAS reports: leaving it out would mean
 * choosing for the caller, which is the bug in a politer form. A seat with no
 * reports needs no choice and behaves as it always did.
 *
 * Still refused while anyone is assigned to a seat that would go: an occupied
 * position that disappears leaves assignments pointing at nothing, and the spec
 * is explicit that referenced records are ended, not deleted (§8).
 */
export async function deletePosition(db, c, id, options = {}) {
  const { companyId } = c;
  const problems = [];
  const mode = readEnum(options.mode, 'Mode', REMOVAL_MODES, problems);
  const expect = readExpect(options.expect, problems);
  assertNoProblems(problems);

  const seat = await requirePosition(db, companyId, id, { lock: true });
  const on = today();
  const s = await loadStructure(db, companyId, on);
  const a = assess(s, id, on);

  if (!mode && a.directIds.length) {
    // Own assignments outrank the missing choice: no mode would have worked.
    if (['IN_USE', 'HIRING_OPEN', 'POSITION_FILLED'].includes(a.outcomes.deleteOnly.code)) refuse(a.outcomes.deleteOnly);
    throw conflict('HAS_TEAM', `${a.seat.title} has ${plural(a.directIds.length, 'direct report')}${a.teamIds.length > a.directIds.length ? ` (${plural(a.teamIds.length, 'position')} under it in all)` : ''}. ${
      a.manager
        ? `Choose to delete it alone, which moves them ${whereTo(a)}, or to delete it with its team.`
        : 'There is no open position above it for them to move up to, so the choice is to delete it with its team.'}`);
  }
  const chosen = mode ?? 'THIS_ONLY';
  const withTeam = chosen === 'WITH_TEAM';
  refuse(withTeam ? a.outcomes.deleteWithTeam : a.outcomes.deleteOnly);
  checkExpect(expect, withTeam ? a.teamIds.length + 1 : a.directIds.length,
    withTeam ? (n) => `deletes ${plural(n, 'position')}` : (n) => `has ${plural(n, 'direct report')}`);

  const doomed = withTeam ? [id, ...a.teamIds] : [id];
  const marks = doomed.map(() => '?').join(',');

  // Lock every seat that goes, so two overlapping deletes cannot both proceed,
  // and notice a seat another request has already removed.
  const [locked] = await db.query(
    `SELECT id FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL AND id IN (${marks}) FOR UPDATE`,
    [companyId, ...doomed],
  );
  if (locked.length !== doomed.length) {
    throw conflict('IMPACT_CHANGED', 'This changed while you were deciding: part of it has already been removed. Look again before you confirm.');
  }

  const moved = withTeam ? [] : await moveReports(db, c, s, a, { keepHistory: false });

  const gone = new Set(doomed);
  const touching = s.edges.filter((e) => gone.has(e.from_position_id) || gone.has(e.to_position_id)).length;
  await db.query(`UPDATE hrms_positions SET deleted_at = NOW() WHERE company_id = ? AND id IN (${marks})`, [companyId, ...doomed]);
  await db.query(`UPDATE hrms_position_work_contexts SET deleted_at = NOW() WHERE company_id = ? AND position_id IN (${marks}) AND deleted_at IS NULL`, [companyId, ...doomed]);
  // Every line that names a seat that is going. The lines from a team that is
  // NOT going (THIS_ONLY) were replaced by moveReports a moment ago, so this
  // retires the old ones along with the seat's own and its secondary ones.
  const [edgeRes] = await db.query(
    `UPDATE hrms_position_reporting_relationships SET deleted_at = NOW()
      WHERE company_id = ? AND deleted_at IS NULL AND (from_position_id IN (${marks}) OR to_position_id IN (${marks}))`,
    [companyId, ...doomed, ...doomed],
  );
  if (edgeRes.affectedRows !== touching) {
    // A line was added or removed between the read and the write. The
    // transaction rolls back; nothing has changed.
    throw conflict('IMPACT_CHANGED', 'This changed while you were deciding: someone edited the reporting lines. Look again before you confirm.');
  }
  await db.query(`UPDATE hrms_position_content_overrides SET deleted_at = NOW() WHERE company_id = ? AND position_id IN (${marks}) AND deleted_at IS NULL`, [companyId, ...doomed]);

  await audit(db, c, id, 'DELETE',
    { positionCode: seat.position_code, title: a.seat.title, status: seat.status },
    {
      mode: chosen, deletedIds: doomed, movedReportIds: moved.map((m) => m.id), movedToId: moved.length ? a.manager.id : null,
      movedWithinCard: moved.length ? a.withinCard : null, moves: moved.map((m) => [m.id, m.movedToPositionId]),
    });

  return {
    ok: true,
    deleted: id,                       // what this endpoint always returned
    mode: chosen,
    deletedIds: doomed,
    deletedCount: doomed.length,
    movedReports: moved,               // each says where it went: movedToPositionId
    movedTo: moved.length ? a.manager : null,
    movedWithinCard: moved.length ? a.withinCard : null,
    movedToPositions: moved.length ? a.targets : [],
  };
}

/**
 * The guard for the two ROUTES that can set CLOSED directly (POST /positions/:id/status
 * and PUT /positions/:id): a seat with direct reports may not be closed that way,
 * because the chart does not draw a closed seat and its team would become tops of the
 * chart. Say so, and point at POST /positions/:id/close, which moves the team up.
 * setPositionStatus itself is unchanged (the workbook applier calls it directly).
 */
export async function refuseCloseWithTeam(db, companyId, id, status) {
  if (String(status ?? '').trim().toUpperCase() !== 'CLOSED') return;
  const seat = await requirePosition(db, companyId, id);
  if (seat.status === 'CLOSED') return;
  const s = await loadStructure(db, companyId, today());
  // Promised to somebody — an open hiring, a person due to join: not closed this way either.
  const { close } = assess(s, id, today()).outcomes;
  if (['HIRING_OPEN', 'POSITION_FILLED'].includes(close.code)) refuse(close);
  const n = (s.reportsOf.get(id) ?? []).length;
  if (n > 0) {
    throw conflict('HAS_TEAM', `${s.byId.get(id).title} has ${plural(n, 'direct report')}, and closing it this way would leave them as separate tops of the chart. Use POST /positions/${id}/close instead: it closes the position and moves them to another position of the same card, or up to its manager when it is the card's last one.`);
  }
}

/**
 * Close a seat: it stays, with its history, and leaves the chart.
 *
 * Why this is not just setPositionStatus(…, 'CLOSED'): the chart does not draw a
 * CLOSED seat, and a team whose manager is not drawn becomes tops of the chart —
 * the same eleven roots as the delete bug, reached by the action the UI now
 * recommends. So closing a seat that has reports also moves them up, with
 * history kept (their old line is ended, not erased). A seat with no open
 * position above it is refused for the same reason deleting one is.
 *
 * setPositionStatus is left exactly as it was: the workbook import calls it
 * after moving the lines itself, and its 172-check suite depends on that. The
 * status field on the edit form (PUT /positions/:id) goes the same direct way,
 * so closing a manager from there still drops its team out of the chart — the
 * dialogs that offer "Close" use this instead.
 */
export async function closePosition(db, c, id, options = {}) {
  const { companyId } = c;
  const problems = [];
  const expect = readExpect(options.expect, problems);
  assertNoProblems(problems);

  const seat = await requirePosition(db, companyId, id, { lock: true });
  if (seat.status === 'CLOSED') {
    return { ok: true, alreadyClosed: true, ...(await getPosition(db, companyId, id)), movedReports: [], movedTo: null };
  }

  const on = today();
  const s = await loadStructure(db, companyId, on);
  const a = assess(s, id, on);
  refuse(a.outcomes.close);
  checkExpect(expect, a.directIds.length, (n) => `has ${plural(n, 'direct report')}`);

  const moved = await moveReports(db, c, s, a, { keepHistory: true });
  await db.query("UPDATE hrms_positions SET status = 'CLOSED' WHERE company_id = ? AND id = ?", [companyId, id]);
  await audit(db, c, id, 'UPDATE',
    { status: seat.status },
    {
      status: 'CLOSED', movedReportIds: moved.map((m) => m.id), movedToId: moved.length ? a.manager.id : null,
      movedWithinCard: moved.length ? a.withinCard : null, moves: moved.map((m) => [m.id, m.movedToPositionId]),
    });

  return {
    ok: true,
    ...(await getPosition(db, companyId, id)),
    movedReports: moved,
    movedTo: moved.length ? a.manager : null,
    movedWithinCard: moved.length ? a.withinCard : null,
    movedToPositions: moved.length ? a.targets : [],
  };
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
      ORDER BY (wa.status <> 'ENDED') DESC, wa.effective_from DESC`,
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
    // seatCount.js's rule: anything not ENDED and in date holds the chair.
    liveOnDate: w.status !== 'ENDED'
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
