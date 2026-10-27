/**
 * policy.js — attendance policies: the rules, their sentences, where each applies.
 * (TM/CF_HRMS_HIRING_SPEC.md §28.3.)
 *
 * A policy is a named set of rules, every rule optional. It is ASSIGNED like a leave policy
 * (§8, §17) — company default, location, role, label — and the most specific wins:
 * ROLE, else the department's LABEL, else LOCATION, else COMPANY, else none.
 * `resolveAttendance` is the one implementation.
 *
 * THE RULES (rules_json; `readRules` is the only writer, `sentencesOf` the only description):
 *   graceInMinutes / graceOutMinutes   null = the shift's own grace
 *   lateMarks       { count, includeEarlyOut, action }    every `count` late marks in a month -> the action
 *   shortDay        { halfDayBelowHours, absentBelowHours }
 *   missingPunch    { treatAs: HALF_DAY | ABSENT | ASK, askWithinDays }
 *   absentIsLop     an absent day without approved leave is unpaid
 *   sandwich        weekly offs / holidays between two absent days count as absent
 *   shortPermission { perMonth, maxMinutes }               a request; within it a late / early is excused
 *   overtime        { afterMinutes, rateMultiplier, minMinutes, maxMinutesPerDay }
 *   weeklyOffDuty   (spec §42.4) work on a weekly off ("Sunday duty"):
 *                   { pay: PER_DAY | PER_HOUR | null, amount, minHours, compOffDays: 0.5 | 1 | null, alsoOvertime }
 *   holidayDuty     (spec §42.4) work on a festival holiday (a full holiday of the shift's calendar):
 *                   { pay: FIXED | DAY_WAGE | null, amount (FIXED), wageMultiple (DAY_WAGE), minHours, compOffDays, alsoOvertime }
 *                   A day counts when the hours worked reach minHours (none = any work). The month summary
 *                   (month.js) turns them into amounts and comp-off days; payroll pays SUNDAY_DUTY / FESTIVAL_DUTY.
 *                   alsoOvertime false (the default): the day's hours are NOT also paid as overtime.
 * An ACTION: { type: LEAVE | LOP | AMOUNT | WARNING, days (LEAVE, LOP: 0.5 | 1),
 *              leaveTypeIds (LEAVE, in order of preference), elseLop (LEAVE), amount (AMOUNT) }
 */
import { attendancePolicyGate } from '../complianceChecks/wire.js';
import { HrmsError, invalid, notFound, conflict } from '../../lib/errors.js';
import { audit } from '../peopleService.js';
import { hoursWords, minutesWords } from './time.js';

export const ACTION_TYPES = ['LEAVE', 'LOP', 'AMOUNT', 'WARNING'];
export const MISSING_TREATMENTS = ['HALF_DAY', 'ABSENT', 'ASK'];
export const POLICY_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'];
export const SCOPES = ['COMPANY', 'LOCATION', 'ROLE', 'LABEL'];

export const RULE_DEFAULTS = Object.freeze({
  graceInMinutes: null, graceOutMinutes: null, lateMarks: null, shortDay: null, missingPunch: null,
  absentIsLop: true, sandwich: false, shortPermission: null, overtime: null, weeklyOffDuty: null, holidayDuty: null,
});
export const WEEKLY_OFF_PAY = ['PER_DAY', 'PER_HOUR'];
export const HOLIDAY_PAY = ['FIXED', 'DAY_WAGE'];

/* ══ reading a body ═════════════════════════════════════════════════════════ */

const blank = (v) => v === null || v === undefined || v === '';
const flag = (v) => v === true || v === 1 || v === '1' || v === 'true';

function num(v, label, problems, { min = 0, max = 100000, whole = false, required = false } = {}) {
  if (blank(v)) { if (required) problems.push(`Say ${label}.`); return null; }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (whole && !Number.isInteger(n))) {
    problems.push(`${label.charAt(0).toUpperCase()}${label.slice(1)} must be ${whole ? 'a whole number' : 'a number'} from ${min} to ${max}.`);
    return null;
  }
  return n;
}

/**
 * A body's rules -> clean rules. Pushes every problem in words; never throws.
 * @param typeIds Set of the company's leave type ids (a LEAVE action must name them)
 */
export function readRules(input = {}, problems = [], { typeIds = null } = {}) {
  const r = { ...RULE_DEFAULTS };
  const src = input && typeof input === 'object' ? input : {};
  r.graceInMinutes = num(src.graceInMinutes, 'the grace for arriving late (minutes)', problems, { max: 240, whole: true });
  r.graceOutMinutes = num(src.graceOutMinutes, 'the grace for leaving early (minutes)', problems, { max: 240, whole: true });
  r.absentIsLop = src.absentIsLop === undefined ? true : flag(src.absentIsLop);
  r.sandwich = flag(src.sandwich);

  if (src.lateMarks) {
    const lm = src.lateMarks;
    const count = num(lm.count, 'how many late marks make a penalty', problems, { min: 1, max: 31, whole: true, required: true });
    const action = readAction(lm.action, problems, { typeIds, what: 'the late-mark penalty' });
    if (count) r.lateMarks = { count, includeEarlyOut: flag(lm.includeEarlyOut), action };
  }
  if (src.shortDay) {
    const half = num(src.shortDay.halfDayBelowHours, 'the hours below which a day is a half day', problems, { min: 0.5, max: 24 });
    const absent = num(src.shortDay.absentBelowHours, 'the hours below which a day is absent', problems, { min: 0.5, max: 24 });
    if (half !== null && absent !== null && absent >= half) problems.push('A short day: the hours for "absent" must be fewer than the hours for "half day".');
    if (half !== null || absent !== null) r.shortDay = { halfDayBelowHours: half, absentBelowHours: absent };
  }
  if (src.missingPunch) {
    const t = String(src.missingPunch.treatAs ?? '').toUpperCase();
    if (!MISSING_TREATMENTS.includes(t)) problems.push('A missing punch: choose half day, absent, or "ask for a correction".');
    else {
      const days = t === 'ASK' ? num(src.missingPunch.askWithinDays, 'the days to ask for a correction within', problems, { min: 1, max: 60, whole: true }) : null;
      r.missingPunch = { treatAs: t, askWithinDays: days };
    }
  }
  if (src.shortPermission) {
    const perMonth = num(src.shortPermission.perMonth, 'how many short permissions a month', problems, { min: 1, max: 31, whole: true, required: true });
    const maxMinutes = num(src.shortPermission.maxMinutes, 'the longest short permission (minutes)', problems, { min: 5, max: 480, whole: true, required: true });
    if (perMonth && maxMinutes) r.shortPermission = { perMonth, maxMinutes };
  }
  if (src.overtime) {
    const o = src.overtime;
    const afterMinutes = num(o.afterMinutes, 'the minutes beyond the shift after which overtime counts', problems, { max: 600, whole: true }) ?? 0;
    const rateMultiplier = num(o.rateMultiplier, 'the overtime rate', problems, { min: 0.5, max: 5 }) ?? 2;
    const minMinutes = num(o.minMinutes, 'the least overtime counted (minutes)', problems, { max: 600, whole: true }) ?? 0;
    const maxMinutesPerDay = num(o.maxMinutesPerDay, 'the most overtime in a day (minutes)', problems, { min: 1, max: 960, whole: true });
    if (maxMinutesPerDay !== null && minMinutes > maxMinutesPerDay) problems.push('Overtime: the least counted is more than the most in a day.');
    r.overtime = { afterMinutes, rateMultiplier, minMinutes, maxMinutesPerDay };
  }
  if (src.weeklyOffDuty) r.weeklyOffDuty = readDuty(src.weeklyOffDuty, problems, { what: 'Work on a weekly off', pays: WEEKLY_OFF_PAY });
  if (src.holidayDuty) r.holidayDuty = readDuty(src.holidayDuty, problems, { what: 'Work on a festival holiday', pays: HOLIDAY_PAY });
  return r;
}

/** A duty rule (spec §42.4): an allowance and/or comp-off. Pushes problems in words. */
function readDuty(d, problems, { what, pays }) {
  const pay = blank(d.pay) ? null : String(d.pay).toUpperCase();
  if (pay !== null && !pays.includes(pay)) { problems.push(`${what}: choose how it is paid.`); return null; }
  const low = what.toLowerCase();
  const out = { pay, amount: null, wageMultiple: null, minHours: null, compOffDays: null, alsoOvertime: flag(d.alsoOvertime) };
  if (pay === 'PER_DAY' || pay === 'PER_HOUR' || pay === 'FIXED') {
    out.amount = num(d.amount, `${low}: the amount (₹${pay === 'PER_HOUR' ? ' an hour' : ' a day'})`, problems, { min: 1, max: 100000, required: true });
  }
  if (pay === 'DAY_WAGE') out.wageMultiple = num(d.wageMultiple, `${low}: how many times the day’s wage`, problems, { min: 0.5, max: 5, required: true });
  out.minHours = num(d.minHours, `${low}: the least hours worked for it to count`, problems, { min: 0, max: 24 }) || null;
  if (!blank(d.compOffDays)) {
    const c = Number(d.compOffDays);
    if (c !== 0.5 && c !== 1 && c !== 0) problems.push(`${what}: comp-off is half a day or a whole day.`);
    else out.compOffDays = c || null;
  }
  if (!out.pay && !out.compOffDays) problems.push(`${what}: choose an allowance, a comp-off, or both.`);
  return out;
}

function readAction(a, problems, { typeIds, what }) {
  const src = a && typeof a === 'object' ? a : {};
  const type = String(src.type ?? '').toUpperCase();
  if (!ACTION_TYPES.includes(type)) { problems.push(`Choose what ${what} does: take leave, loss of pay, a fixed amount, or a warning.`); return { type: 'WARNING' }; }
  if (type === 'WARNING') return { type };
  if (type === 'AMOUNT') {
    const amount = num(src.amount, `the amount of ${what} (₹)`, problems, { min: 1, max: 100000, required: true });
    return { type, amount: amount ?? 0 };
  }
  const days = Number(src.days);
  if (days !== 0.5 && days !== 1) problems.push(`${what.charAt(0).toUpperCase()}${what.slice(1)} takes half a day or a whole day.`);
  const out = { type, days: days === 0.5 ? 0.5 : 1 };
  if (type === 'LEAVE') {
    const ids = Array.isArray(src.leaveTypeIds) ? [...new Set(src.leaveTypeIds.map(Number))] : [];
    if (!ids.length) problems.push(`Choose the leave type ${what} takes from.`);
    else if (ids.some((x) => !Number.isInteger(x) || x <= 0) || (typeIds && ids.some((x) => !typeIds.has(x)))) problems.push(`A leave type of ${what} is not one of this company’s leave types.`);
    out.leaveTypeIds = ids.filter((x) => Number.isInteger(x) && x > 0);
    out.elseLop = src.elseLop === undefined ? true : flag(src.elseLop);
  }
  return out;
}

/* ══ the sentences ══════════════════════════════════════════════════════════ */

const dayWord = (d) => (Number(d) === 0.5 ? 'half a day' : 'a whole day');
const orList = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`);
const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** What an action does, in words. `typeNames`: Map<id, name>. */
export function actionWords(action, typeNames = new Map()) {
  if (!action) return 'nothing happens';
  if (action.type === 'WARNING') return 'a warning is recorded; nothing is deducted';
  if (action.type === 'AMOUNT') return `₹${Number(action.amount).toLocaleString('en-IN')} is deducted from pay`;
  if (action.type === 'LOP') return `${dayWord(action.days)} without pay`;
  const names = (action.leaveTypeIds ?? []).map((id) => typeNames.get(Number(id)) ?? 'a leave type');
  const from = `${dayWord(action.days)} is taken from ${orList(names) || 'leave'}`;
  return action.elseLop ? `${from}, or, when none is left, ${dayWord(action.days)} without pay` : `${from}; when none is left, a warning is recorded`;
}

/**
 * THE SENTENCES of a rule set, in order. `shift` grace is said when the policy has none.
 * @returns string[]
 */
export function sentencesOf(rules, { typeNames = new Map() } = {}) {
  const r = { ...RULE_DEFAULTS, ...(rules ?? {}) };
  const out = [];
  if (r.graceInMinutes !== null) out.push(r.graceInMinutes ? `Arriving more than ${r.graceInMinutes} minutes after the shift starts is a late mark.` : 'Arriving after the shift starts is a late mark.');
  else out.push('Late marks use the grace of each shift.');
  if (r.graceOutMinutes !== null) out.push(r.graceOutMinutes ? `Leaving more than ${r.graceOutMinutes} minutes before the shift ends is an early exit.` : 'Leaving before the shift ends is an early exit.');
  if (r.lateMarks) {
    const what = r.lateMarks.includeEarlyOut ? 'late marks or early exits' : 'late marks';
    out.push(`Every ${r.lateMarks.count} ${what} in a month: ${actionWords(r.lateMarks.action, typeNames)}.`);
  }
  if (r.shortDay) {
    const parts = [];
    if (r.shortDay.halfDayBelowHours !== null) parts.push(`under ${hoursWords(r.shortDay.halfDayBelowHours)} worked is a half day`);
    if (r.shortDay.absentBelowHours !== null) parts.push(`under ${hoursWords(r.shortDay.absentBelowHours)} is absent`);
    const s = parts.join('; ');
    out.push(`${s.charAt(0).toUpperCase()}${s.slice(1)}.`);
  }
  if (r.missingPunch) {
    const t = r.missingPunch.treatAs;
    if (t === 'HALF_DAY') out.push('A day with only one punch counts as a half day.');
    else if (t === 'ABSENT') out.push('A day with only one punch counts as absent.');
    else out.push(r.missingPunch.askWithinDays
      ? `A day with only one punch must be corrected within ${r.missingPunch.askWithinDays} day${r.missingPunch.askWithinDays === 1 ? '' : 's'}, or it counts as absent.`
      : 'A day with only one punch counts as present until it is corrected.');
  } else out.push('A day with only one punch counts as present, marked for a correction.');
  out.push(r.absentIsLop ? 'An absent day without approved leave is unpaid (loss of pay).' : 'An absent day is recorded, but not taken from pay here.');
  if (r.sandwich) out.push('Weekly offs and holidays between two absent days count as absent too.');
  if (r.shortPermission) out.push(`Short permission: up to ${minutesWords(r.shortPermission.maxMinutes)}, ${times(r.shortPermission.perMonth)} a month; within it a late arrival or an early exit is excused.`);
  if (r.overtime) {
    const o = r.overtime;
    const parts = [`Overtime counts ${o.afterMinutes ? `once someone works ${minutesWords(o.afterMinutes)} or more beyond the shift` : 'for time worked beyond the shift'}, at ${o.rateMultiplier} times the hourly rate`];
    if (o.minMinutes) parts.push(`at least ${minutesWords(o.minMinutes)}`);
    if (o.maxMinutesPerDay) parts.push(`at most ${minutesWords(o.maxMinutesPerDay)} a day`);
    const asDuty = [r.weeklyOffDuty && !r.weeklyOffDuty.alsoOvertime ? 'WO' : null, r.holidayDuty && !r.holidayDuty.alsoOvertime ? 'H' : null].filter(Boolean);
    const tail = !asDuty.length ? 'Work on a weekly off or holiday is all overtime.'
      : asDuty.length === 2 ? 'Work on a weekly off or a festival holiday is paid as duty (below), not as overtime.'
        : asDuty[0] === 'WO' ? 'Work on a weekly off is paid as duty (below), not as overtime; work on a holiday is all overtime.'
          : 'Work on a festival holiday is paid as duty (below), not as overtime; work on a weekly off is all overtime.';
    out.push(`${parts.join('; ')}. ${tail}`);
  } else out.push('No overtime is counted.');
  if (r.weeklyOffDuty) out.push(dutySentence(r.weeklyOffDuty, 'weekly off', 'Sunday duty allowance'));
  if (r.holidayDuty) out.push(dutySentence(r.holidayDuty, 'festival holiday', 'festival duty allowance'));
  return out;
}

const rupees = (n) => `₹${Number(n).toLocaleString('en-IN')}`;
const multipleWords = (m) => (Number(m) === 1 ? 'the day’s wage' : Number(m) === 2 ? 'twice the day’s wage' : `${m} times the day’s wage`);

/** "Work on a weekly off (at least 4 hours): ₹500 a day as Sunday duty allowance, and half a day of comp-off." */
export function dutySentence(d, dayName, allowance) {
  const when = d.minHours ? ` (at least ${hoursWords(d.minHours)})` : '';
  const parts = [];
  if (d.pay === 'PER_DAY' || d.pay === 'FIXED') parts.push(`${rupees(d.amount)} a day as ${allowance}`);
  else if (d.pay === 'PER_HOUR') parts.push(`${rupees(d.amount)} an hour as ${allowance}`);
  else if (d.pay === 'DAY_WAGE') parts.push(`${multipleWords(d.wageMultiple)} as ${allowance}`);
  if (d.compOffDays) parts.push(`${dayWord(d.compOffDays)} of comp-off`);
  return `Work on a ${dayName}${when}: ${parts.join(', and ')}.`;
}

/* ══ a policy on the wire ═══════════════════════════════════════════════════ */

const json = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };

export async function leaveTypeNames(db, companyId) {
  const [rows] = await db.query('SELECT id, name FROM hrms_leave_types WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  return new Map(rows.map((t) => [t.id, t.name]));
}

export function shapePolicy(row, typeNames, assignments = []) {
  const rules = { ...RULE_DEFAULTS, ...(json(row.rules_json) ?? {}) };
  return {
    id: row.id, code: row.code ?? null, name: row.name, description: row.description ?? null, status: row.status,
    rules, sentences: sentencesOf(rules, { typeNames }),
    assignments: assignments.filter((a) => a.policyId === row.id),
  };
}

/* ══ where a policy applies ═════════════════════════════════════════════════ */

/** Every live assignment, as an index — two queries, sent together. */
export async function loadAttendanceIndex(db, companyId) {
  const [[rows], [carried], [policies]] = await Promise.all([
    db.query(
      `SELECT a.id, a.scope, a.location_id, a.role_id, a.label_id, a.policy_id, l.name AS location_name, r.title AS role_title, dl.name AS label_name
         FROM hrms_attendance_policy_assignments a
         LEFT JOIN hrms_locations l ON l.company_id = a.company_id AND l.id = a.location_id
         LEFT JOIN hrms_roles r ON r.company_id = a.company_id AND r.id = a.role_id
         LEFT JOIN hrms_department_labels dl ON dl.company_id = a.company_id AND dl.id = a.label_id AND dl.deleted_at IS NULL
        WHERE a.company_id = ? AND a.deleted_at IS NULL`, [companyId]),
    db.query(
      `SELECT d.id AS department_id, l.id AS label_id
         FROM hrms_departments d
         JOIN hrms_department_labels l ON l.company_id = d.company_id AND l.deleted_at IS NULL AND LOWER(l.name) = LOWER(d.department_type)
         JOIN hrms_label_groups g ON g.company_id = l.company_id AND g.id = l.group_id AND g.is_kind = 1 AND g.deleted_at IS NULL
        WHERE d.company_id = ? AND d.deleted_at IS NULL`, [companyId]),
    db.query('SELECT id, name, status, rules_json FROM hrms_attendance_policies WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
  ]);
  const byId = new Map(policies.map((p) => [p.id, { id: p.id, name: p.name, status: p.status, rules: { ...RULE_DEFAULTS, ...(json(p.rules_json) ?? {}) } }]));
  const index = { company: null, byLocation: new Map(), byRole: new Map(), byLabel: new Map(), labelOfDepartment: new Map(), names: new Map(), policies: byId, rows: [] };
  for (const r of rows) {
    const p = byId.get(r.policy_id);
    if (!p || p.status === 'ARCHIVED') continue;
    index.rows.push({ id: r.id, scope: r.scope, locationId: r.location_id, roleId: r.role_id, labelId: r.label_id, policyId: r.policy_id,
      target: r.scope === 'COMPANY' ? 'The whole company' : (r.location_name ?? r.role_title ?? r.label_name ?? '—') });
    if (r.scope === 'COMPANY') index.company = p;
    else if (r.scope === 'LOCATION' && r.location_id) { index.byLocation.set(r.location_id, p); index.names.set(`L${r.location_id}`, r.location_name); }
    else if (r.scope === 'ROLE' && r.role_id) index.byRole.set(r.role_id, p);
    else if (r.scope === 'LABEL' && r.label_id) { index.byLabel.set(r.label_id, p); index.names.set(`B${r.label_id}`, r.label_name); }
  }
  for (const k of carried) index.labelOfDepartment.set(k.department_id, k.label_id);
  return index;
}

/**
 * THE RESOLUTION: ROLE, else the department's LABEL, else LOCATION, else COMPANY, else none.
 * @returns { policy: { id, name, rules } | null, from, line }
 */
export function resolveAttendance(index, { roleId = null, locationId = null, departmentId = null } = {}) {
  const role = roleId != null ? index.byRole.get(Number(roleId)) : null;
  if (role) return { policy: role, from: 'ROLE', line: `${role.name} — from the role` };
  const labelId = departmentId != null ? index.labelOfDepartment.get(Number(departmentId)) : null;
  const label = labelId != null ? index.byLabel.get(labelId) : null;
  if (label) return { policy: label, from: 'LABEL', line: `${label.name} — from the kind ${index.names.get(`B${labelId}`) ?? ''}`.trim() };
  const loc = locationId != null ? index.byLocation.get(Number(locationId)) : null;
  if (loc) return { policy: loc, from: 'LOCATION', line: `${loc.name} — from ${index.names.get(`L${locationId}`) ?? 'the location'}` };
  if (index.company) return { policy: index.company, from: 'COMPANY', line: `${index.company.name} — the company default` };
  return { policy: null, from: null, line: 'No attendance policy — the shift’s grace applies and nothing else' };
}

/* ══ writing policies ═══════════════════════════════════════════════════════ */

async function typeIdsOf(db, companyId) {
  const [rows] = await db.query('SELECT id FROM hrms_leave_types WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  return new Set(rows.map((r) => r.id));
}

function readHead(body, problems, { creating }) {
  const name = String(body.name ?? '').trim();
  if (creating && !name) problems.push('Give the policy a name.');
  if (name.length > 150) problems.push('The name is up to 150 characters.');
  const status = body.status == null ? null : String(body.status).toUpperCase();
  if (status !== null && !POLICY_STATUSES.includes(status)) problems.push('The status is draft, active or archived.');
  return { name: name || null, code: body.code == null ? null : String(body.code).trim().slice(0, 50) || null, description: body.description == null ? null : String(body.description).trim().slice(0, 1000) || null, status };
}

export async function listPolicies(db, c) {
  const [[rows], names, index] = await Promise.all([
    db.query('SELECT * FROM hrms_attendance_policies WHERE company_id = ? AND deleted_at IS NULL ORDER BY name', [c.companyId]),
    leaveTypeNames(db, c.companyId),
    loadAttendanceIndex(db, c.companyId),
  ]);
  return { policies: rows.map((r) => shapePolicy(r, names, index.rows)), assignments: index.rows };
}

export async function readPolicy(db, c, id) {
  const [[row]] = await db.query('SELECT * FROM hrms_attendance_policies WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, id]);
  if (!row) throw notFound('That attendance policy');
  const [names, index] = await Promise.all([leaveTypeNames(db, c.companyId), loadAttendanceIndex(db, c.companyId)]);
  return { policy: shapePolicy(row, names, index.rows) };
}

/** POST /attendance/policies/sentences { rules } -> { sentences, problems } — the editor's live text. */
export async function previewSentences(db, c, body = {}) {
  const problems = [];
  const rules = readRules(body.rules ?? {}, problems, { typeIds: await typeIdsOf(db, c.companyId) });
  return { sentences: sentencesOf(rules, { typeNames: await leaveTypeNames(db, c.companyId) }), problems };
}

export async function createPolicy(conn, c, body = {}, requestId = null) {
  const problems = [];
  const head = readHead(body, problems, { creating: true });
  const rules = readRules(body.rules ?? {}, problems, { typeIds: await typeIdsOf(conn, c.companyId) });
  if (problems.length) throw invalid('INVALID', problems[0], { problems });
  const [ins] = await conn.query(
    'INSERT INTO hrms_attendance_policies (company_id, code, name, description, status, rules_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, head.code, head.name, head.description, head.status ?? 'ACTIVE', JSON.stringify(rules), c.userId],
  );
  await audit(conn, c, 'hrms_attendance_policies', ins.insertId, 'CREATE', null, { ...head, rules }, requestId);
  // Spec §36.2: overtime below the legal rate refuses an ACTIVE policy.
  const compliance = await attendancePolicyGate(conn, c, ins.insertId);
  return { ...(await readPolicy(conn, c, ins.insertId)), compliance };
}

export async function updatePolicy(conn, c, id, body = {}, requestId = null) {
  const [[row]] = await conn.query('SELECT * FROM hrms_attendance_policies WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, id]);
  if (!row) throw notFound('That attendance policy');
  const problems = [];
  const head = readHead(body, problems, { creating: false });
  const rules = body.rules === undefined ? null : readRules(body.rules, problems, { typeIds: await typeIdsOf(conn, c.companyId) });
  if (problems.length) throw invalid('INVALID', problems[0], { problems });
  const next = {
    name: head.name ?? row.name, code: body.code === undefined ? row.code : head.code, description: body.description === undefined ? row.description : head.description,
    status: head.status ?? row.status, rules: rules ?? json(row.rules_json),
  };
  await conn.query('UPDATE hrms_attendance_policies SET name = ?, code = ?, description = ?, status = ?, rules_json = ? WHERE company_id = ? AND id = ?',
    [next.name, next.code, next.description, next.status, JSON.stringify(next.rules), c.companyId, id]);
  await audit(conn, c, 'hrms_attendance_policies', id, 'UPDATE', { name: row.name, status: row.status, rules: json(row.rules_json) }, next, requestId);
  const compliance = await attendancePolicyGate(conn, c, id);
  return { ...(await readPolicy(conn, c, id)), compliance };
}

export async function removePolicy(conn, c, id, requestId = null) {
  const [[row]] = await conn.query('SELECT id, name FROM hrms_attendance_policies WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, id]);
  if (!row) throw notFound('That attendance policy');
  const [[used]] = await conn.query('SELECT COUNT(*) AS n FROM hrms_attendance_policy_assignments WHERE company_id = ? AND policy_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  if (Number(used.n)) throw conflict('IN_USE', `${row.name} is assigned in ${used.n} place${Number(used.n) === 1 ? '' : 's'}. Take those assignments off first.`, { count: Number(used.n) });
  await conn.query('UPDATE hrms_attendance_policies SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  await audit(conn, c, 'hrms_attendance_policies', id, 'DELETE', { name: row.name }, null, requestId);
  return { ok: true };
}

/**
 * PUT /attendance/policy-assignments { scope, targetId, policyId | null } — one per target;
 * null takes the assignment off.
 */
export async function putAssignment(conn, c, body = {}, requestId = null) {
  const scope = String(body.scope ?? '').toUpperCase();
  if (!SCOPES.includes(scope)) throw invalid('INVALID', 'Choose where it applies: the whole company, a location, a role or a label.');
  const targetId = scope === 'COMPANY' ? null : Number(body.targetId);
  if (scope !== 'COMPANY' && (!Number.isInteger(targetId) || targetId <= 0)) throw invalid('INVALID', 'Choose the location, role or label.');
  const table = { LOCATION: 'hrms_locations', ROLE: 'hrms_roles', LABEL: 'hrms_department_labels' }[scope];
  if (table) {
    const [[t]] = await conn.query(`SELECT id FROM ${table} WHERE company_id = ? AND id = ? AND deleted_at IS NULL`, [c.companyId, targetId]);
    if (!t) throw notFound(`That ${scope.toLowerCase()}`);
  }
  const policyId = body.policyId == null || body.policyId === '' ? null : Number(body.policyId);
  if (policyId !== null) {
    const [[p]] = await conn.query("SELECT id, status FROM hrms_attendance_policies WHERE company_id = ? AND id = ? AND deleted_at IS NULL", [c.companyId, policyId]);
    if (!p) throw notFound('That attendance policy');
    if (p.status === 'ARCHIVED') throw invalid('ARCHIVED', 'An archived policy cannot be assigned.');
  }
  const col = { LOCATION: 'location_id', ROLE: 'role_id', LABEL: 'label_id' }[scope];
  const [[current]] = await conn.query(
    `SELECT id, policy_id FROM hrms_attendance_policy_assignments WHERE company_id = ? AND scope = ? AND deleted_at IS NULL ${col ? `AND ${col} = ?` : ''} FOR UPDATE`,
    [c.companyId, scope, ...(col ? [targetId] : [])]);
  if (current && current.policy_id === policyId) return { assignment: { scope, targetId, policyId } };
  if (current) {
    await conn.query('UPDATE hrms_attendance_policy_assignments SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, current.id]);
    await audit(conn, c, 'hrms_attendance_policy_assignments', current.id, 'DELETE', { scope, targetId, policyId: current.policy_id }, null, requestId);
  }
  if (policyId !== null) {
    const [ins] = await conn.query(
      `INSERT INTO hrms_attendance_policy_assignments (company_id, scope, location_id, role_id, label_id, policy_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [c.companyId, scope, scope === 'LOCATION' ? targetId : null, scope === 'ROLE' ? targetId : null, scope === 'LABEL' ? targetId : null, policyId, c.userId]);
    await audit(conn, c, 'hrms_attendance_policy_assignments', ins.insertId, 'CREATE', null, { scope, targetId, policyId }, requestId);
  }
  return { assignment: { scope, targetId, policyId } };
}

export default { RULE_DEFAULTS, readRules, sentencesOf, dutySentence, actionWords, shapePolicy, loadAttendanceIndex, resolveAttendance, listPolicies, readPolicy, createPolicy, updatePolicy, removePolicy, putAssignment, previewSentences, leaveTypeNames };
export { HrmsError };
