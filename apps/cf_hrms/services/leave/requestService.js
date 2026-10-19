/**
 * requestService.js — asking for leave, and deciding it.
 * (TM/CF_HRMS_HIRING_SPEC.md §22.3–§22.5.)
 *
 * WHAT LIVES ELSEWHERE, ON PURPOSE
 *   - which days count:          ./days.js (pure)
 *   - what is available:         ./balance.js (pure, the only place a balance is computed)
 *   - which policy applies:      ../leavePolicyRead.js (resolveEffective, rulesOfPolicies)
 *   - who the manager is:        ../reportingResolver.js (resolveReporting, resolvePositionReporting)
 * This file reads what those need — in bulk, a fixed number of queries whatever the
 * number of people (`loadWorlds`) — runs the checks, and writes the requests.
 *
 * THE LIFECYCLE (§22.4). Submit = PENDING (no DRAFT). PENDING -> APPROVED | REJECTED |
 * CANCELLED; APPROVED -> CANCELLED. A request is never deleted and every change writes
 * hrms_audit_log, in the caller's transaction. No attendance rows are written.
 *
 *   approver   at submit: the person in the chair the person's MAIN position reports to
 *              on the line the org chart draws (PRIMARY_MANAGER); vacant -> the next chair
 *              up; nobody -> NULL, and HR decides.
 *   decide     the approver, anybody above them in the same chain, or HR (leave edit, in
 *              their department scope). Nobody decides their own request. A rejection
 *              needs a note. Approving runs the BLOCK checks again, against the balance as
 *              it is then, without this request's own hold.
 *   cancel     the person while PENDING, or while APPROVED and the first day is ahead;
 *              HR any time, with a note. Cancelling releases the days (a balance is
 *              computed from the requests, so nothing else moves).
 *
 * WHO IS ASKING — a `viewer`:
 *   { userId, employeeId | null, hr: null | { all: true } | { departmentIds: Set } }
 * `hr` is set only for a login holding leave edit; the routes build it.
 */
import { HrmsError, invalid, notFound, conflict } from '../../lib/errors.js';
import { audit } from '../peopleService.js';
import { today as todayText, dateText, LIVE_ON } from '../positionService.js';
import { loadAssignmentIndex, resolveEffective, rulesOfPolicies, applicability, noticeForQuantity } from '../leavePolicyRead.js';
import { resolveReporting, resolvePositionReporting } from '../reportingResolver.js';
import { EMPLOYEE_IN_DEPARTMENTS_SQL } from '../accessScope.js';
import {
  makeCalendar, countDays, isDate, addDays, daysBetween, spanText, dayText, daysWords, daysOffPhrase, MAX_RANGE_DAYS,
} from './days.js';
import { balanceOf, leaveYearOf, yearOfKey, yearFromStart, plain, presentBetween } from './balance.js';

const iso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : new Date(v).toISOString()));
const num = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);
const clip = (s, n) => (s == null ? null : String(s).slice(0, n));
const blank = (v) => v == null || String(v).trim() === '';
const STATUS_WORDS = { PENDING: 'waiting for approval', APPROVED: 'approved', REJECTED: 'rejected', CANCELLED: 'cancelled', DRAFT: 'a draft' };

/* ══════════════════════════════════════════════════════════════════════════
 * Reading people in bulk
 * ══════════════════════════════════════════════════════════════════════════ */

/** Each person's seat today: the ACTIVE assignment first, the primary one first. */
const SEATS_SQL = `
  SELECT wa.id AS assignment_id, wa.employee_id, wa.position_id,
         COALESCE(p.role_id, wa.role_id) AS role_id, COALESCE(wa.location_id, p.location_id) AS location_id,
         COALESCE(p.department_id, wa.department_id) AS department_id,
         COALESCE(wa.default_shift_id, p.default_shift_id) AS shift_id,
         COALESCE(p.position_title, pr.title, r.title) AS position_title, d.name AS department_name
    FROM hrms_work_assignments wa
    LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id AND p.deleted_at IS NULL
    LEFT JOIN hrms_roles pr ON pr.company_id = wa.company_id AND pr.id = p.role_id
    LEFT JOIN hrms_roles r ON r.company_id = wa.company_id AND r.id = wa.role_id
    LEFT JOIN hrms_departments d ON d.company_id = wa.company_id AND d.id = COALESCE(p.department_id, wa.department_id)
   WHERE wa.company_id = ? AND wa.employee_id IN (?) AND wa.deleted_at IS NULL
     AND wa.status IN ('ACTIVE', 'SUSPENDED', 'PLANNED') AND ${LIVE_ON('wa')}
   ORDER BY wa.employee_id, FIELD(wa.status, 'ACTIVE', 'SUSPENDED', 'PLANNED'), wa.is_primary DESC, wa.effective_from DESC, wa.id`;

const personOf = (e, seat) => ({
  employeeId: e.id,
  name: e.full_name,
  employeeCode: e.employee_code ?? null,
  positionTitle: seat?.position_title ?? null,
  departmentName: seat?.department_name ?? null,
});

/** Person shapes for some employees: two queries. */
export async function loadPersons(db, companyId, employeeIds, on = todayText()) {
  const ids = [...new Set(employeeIds.filter((x) => x != null).map(Number))];
  const out = new Map();
  if (!ids.length) return out;
  const [[emps], [seats]] = await Promise.all([
    db.query('SELECT id, full_name, employee_code FROM hrms_employees WHERE company_id = ? AND id IN (?)', [companyId, ids]),
    db.query(SEATS_SQL, [companyId, ids, on, on]),
  ]);
  const seatOf = new Map();
  for (const s of seats) if (!seatOf.has(s.employee_id)) seatOf.set(s.employee_id, s);
  for (const e of emps) out.set(e.id, personOf(e, seatOf.get(e.id)));
  return out;
}

/**
 * Everything the checks and the balances of some people need, read once:
 * employee, seat, effective policy and its rules, shift and holidays, HR's openings
 * and every request. A fixed number of queries (about nine), whatever the number of people.
 * @returns Map<employeeId, World>
 */
export async function loadWorlds(db, companyId, employeeIds, { on = todayText() } = {}) {
  const ids = [...new Set(employeeIds.filter((x) => x != null).map(Number))];
  const worlds = new Map();
  if (!ids.length) return worlds;
  const [[emps], [seats], index, [policies], [openingRows], [requestRows]] = await Promise.all([
    db.query(
      `SELECT id, employee_code, full_name, gender, date_of_joining, exit_date, employment_status, user_id
         FROM hrms_employees WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`, [companyId, ids]),
    db.query(SEATS_SQL, [companyId, ids, on, on]),
    loadAssignmentIndex(db, companyId),
    db.query('SELECT id, year_starts_month, effective_from FROM hrms_leave_policies WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
    db.query(
      `SELECT id, employee_id, leave_type_id, period_key, opening_balance, note, updated_at
         FROM hrms_leave_balances WHERE company_id = ? AND employee_id IN (?) AND deleted_at IS NULL`, [companyId, ids]),
    db.query(
      `SELECT r.id, r.employee_id, r.leave_type_id, r.from_date, r.to_date, r.quantity, r.status, r.half_day, r.approver_employee_id, r.created_at,
              lt.name AS lt_name
         FROM hrms_leave_requests r JOIN hrms_leave_types lt ON lt.company_id = r.company_id AND lt.id = r.leave_type_id
        WHERE r.company_id = ? AND r.employee_id IN (?) AND r.deleted_at IS NULL
        ORDER BY r.from_date, r.id`, [companyId, ids]),
  ]);
  const seatOf = new Map();
  for (const s of seats) if (!seatOf.has(s.employee_id)) seatOf.set(s.employee_id, s);
  const startsOf = new Map(policies.map((p) => [p.id, Number(p.year_starts_month) || 1]));
  const effectiveFromOf = new Map(policies.map((p) => [p.id, dateText(p.effective_from)]));

  const effectiveOf = new Map();
  for (const e of emps) {
    const seat = seatOf.get(e.id);
    // No position held: the company default still applies.
    effectiveOf.set(e.id, resolveEffective(index, seat
      ? { roleId: seat.role_id, locationId: seat.location_id, departmentId: seat.department_id }
      : {}));
  }
  const policyIds = [...new Set([...effectiveOf.values()].map((x) => x.policy?.id).filter(Boolean))];
  const shiftIds = [...new Set([...seatOf.values()].map((s) => s.shift_id).filter(Boolean))];
  const [rulesBy, [shiftRows]] = await Promise.all([
    rulesOfPolicies(db, companyId, policyIds),
    shiftIds.length ? db.query(
      `SELECT s.id, s.name, s.holiday_calendar_id, d.weekday, d.is_working
         FROM hrms_shifts s
         LEFT JOIN hrms_shift_days d ON d.company_id = s.company_id AND d.shift_id = s.id AND d.deleted_at IS NULL
        WHERE s.company_id = ? AND s.id IN (?)`, [companyId, shiftIds]) : [[]],
  ]);
  const shifts = new Map();
  for (const r of shiftRows) {
    const s = shifts.get(r.id) ?? { id: r.id, name: r.name, calendarId: r.holiday_calendar_id, days: new Map() };
    if (r.weekday != null) s.days.set(Number(r.weekday), Boolean(r.is_working));
    shifts.set(r.id, s);
  }
  const calendarIds = [...new Set([...shifts.values()].map((s) => s.calendarId).filter(Boolean))];
  const [holidayRows] = calendarIds.length
    ? await db.query('SELECT calendar_id, location_id, holiday_date, name, is_optional FROM hrms_holidays WHERE company_id = ? AND calendar_id IN (?) AND deleted_at IS NULL', [companyId, calendarIds])
    : [[]];

  const byEmployee = (rows) => { const m = new Map(); for (const r of rows) { const l = m.get(r.employee_id) ?? []; l.push(r); m.set(r.employee_id, l); } return m; };
  // §28.4: once the company's attendance is live, what it recorded — present days by month (and by
  // day, for one person's own reads) — for EL's present days and ML's days worked.
  const attendanceBy = await loadAttendance(db, companyId, ids);
  const openingsBy = byEmployee(openingRows);
  const requestsBy = byEmployee(requestRows);

  for (const e of emps) {
    const seat = seatOf.get(e.id) ?? null;
    const effective = effectiveOf.get(e.id);
    const rules = effective.policy ? (rulesBy.get(effective.policy.id) ?? []) : [];
    const shift = seat?.shift_id ? shifts.get(seat.shift_id) : null;
    // A weekday with no row follows the shift rule of shiftRead: Monday to Saturday working, Sunday off.
    const workingWeekdays = shift ? [1, 2, 3, 4, 5, 6, 7].filter((wd) => (shift.days.has(wd) ? shift.days.get(wd) : wd !== 7)) : null;
    const holidays = shift?.calendarId
      ? holidayRows.filter((h) => h.calendar_id === shift.calendarId && (h.location_id == null || h.location_id === seat.location_id))
        .map((h) => ({ date: dateText(h.holiday_date), name: h.name, isOptional: Boolean(h.is_optional) }))
      : [];
    const calendar = makeCalendar({ shift: shift ? { name: shift.name, workingWeekdays } : null, holidays, hasHolidayCalendar: Boolean(shift?.calendarId) });
    const openings = new Map();
    for (const o of openingsBy.get(e.id) ?? []) {
      const m = openings.get(o.leave_type_id) ?? new Map();
      m.set(o.period_key, { id: o.id, opening: Number(o.opening_balance), note: o.note ?? null, updatedAt: o.updated_at });
      openings.set(o.leave_type_id, m);
    }
    worlds.set(e.id, {
      employee: {
        id: e.id, code: e.employee_code, name: e.full_name, gender: e.gender ?? null, joinDate: dateText(e.date_of_joining),
        exitDate: dateText(e.exit_date), status: e.employment_status, userId: e.user_id ?? null,
      },
      person: personOf(e, seat),
      seat: seat ? { assignmentId: seat.assignment_id, positionId: seat.position_id, departmentId: seat.department_id, locationId: seat.location_id } : null,
      effective,
      rules,
      startsMonth: effective.policy ? (startsOf.get(effective.policy.id) ?? 1) : 1,
      // §23.1: nothing is earned before the policy takes effect.
      effectiveFrom: effective.policy ? (effectiveFromOf.get(effective.policy.id) ?? null) : null,
      calendar,
      attendance: attendanceBy.get(e.id) ?? null,
      openings,
      requests: (requestsBy.get(e.id) ?? []).map((r) => ({
        id: r.id, leaveTypeId: r.leave_type_id, leaveTypeName: r.lt_name, from: dateText(r.from_date), to: dateText(r.to_date),
        quantity: Number(r.quantity), status: r.status, halfDay: r.half_day ?? null, approverId: r.approver_employee_id ?? null, createdAt: r.created_at,
      })),
    });
  }
  return worlds;
}

/**
 * Attendance for the balances (§28.4): Map<employeeId, { liveFrom, presentByMonth, presentByDay | null }>,
 * empty when the company's attendance is not live. By day only for a handful of people (one person's
 * reads), so the balances grid of the whole company stays one aggregate query.
 */
async function loadAttendance(db, companyId, ids) {
  const out = new Map();
  const [[s]] = await db.query('SELECT live_from FROM hrms_attendance_settings WHERE company_id = ?', [companyId]);
  const liveFrom = dateText(s?.live_from);
  if (!liveFrom || !ids.length) return out;
  const [months] = await db.query(
    `SELECT employee_id, DATE_FORMAT(attendance_date, '%Y-%m') AS m, SUM(present_value) AS p FROM hrms_attendance_records
      WHERE company_id = ? AND employee_id IN (?) AND deleted_at IS NULL AND attendance_date >= ? GROUP BY employee_id, m`, [companyId, ids, liveFrom]);
  let days = [];
  if (ids.length <= 5) {
    [days] = await db.query(
      `SELECT employee_id, attendance_date, present_value FROM hrms_attendance_records
        WHERE company_id = ? AND employee_id IN (?) AND deleted_at IS NULL AND attendance_date >= ? AND present_value > 0`, [companyId, ids, liveFrom]);
  }
  for (const id of ids) out.set(id, { liveFrom, presentByMonth: new Map(), presentByDay: ids.length <= 5 ? new Map() : null });
  for (const r of months) out.get(r.employee_id)?.presentByMonth.set(r.m, Number(r.p) || 0);
  for (const r of days) out.get(r.employee_id)?.presentByDay?.set(dateText(r.attendance_date), Number(r.present_value) || 0);
  return out;
}

async function worldOf(db, companyId, employeeId) {
  const w = (await loadWorlds(db, companyId, [employeeId])).get(Number(employeeId));
  if (!w) throw notFound('That employee');
  return w;
}

/** The policy as the screens show it: Effective, its year start and its rules. */
const policyOf = (w) => ({ ...w.effective, yearStartsMonth: w.effective.policy ? w.startsMonth : null, effectiveFrom: w.effectiveFrom ?? null, rules: w.rules });

/* ══════════════════════════════════════════════════════════════════════════
 * Balances
 * ══════════════════════════════════════════════════════════════════════════ */

const genderOf = (g) => {
  const s = String(g ?? '').trim().toLowerCase();
  if (['f', 'female', 'woman', 'women'].includes(s)) return 'WOMEN';
  if (['m', 'male', 'man', 'men'].includes(s)) return 'MEN';
  return null;
};
const forWhom = (appliesTo) => (appliesTo === 'WOMEN' ? 'women' : 'men');

/** On a balances page: the day earned is counted up to. Past year: all of it; future: its first day. */
export function asOfFor(year, today = todayText()) {
  if (today < year.from) return year.from;
  if (today > year.to) return null;
  return today;
}

/** One rule's balance for a person, with canAsk. */
function balanceFor(w, rule, { year, asOf, excludeRequestId = null }) {
  const { balance, info } = balanceOf({
    rule, year, startsMonth: w.startsMonth, joinDate: w.employee.joinDate, asOf,
    openings: w.openings.get(rule.leaveTypeId) ?? new Map(),
    requests: w.requests.filter((r) => r.leaveTypeId === rule.leaveTypeId),
    calendar: w.calendar, excludeRequestId, effectiveFrom: w.effectiveFrom ?? null, attendance: w.attendance ?? null,
  });
  let cannotWhy = null;
  const g = genderOf(w.employee.gender);
  if (rule.appliesTo !== 'ANYONE' && g && g !== rule.appliesTo) cannotWhy = `This leave is for ${forWhom(rule.appliesTo)} only.`;
  else if (rule.basis === 'PER_EVENT' && info.maxTimes && info.timesUsed + info.timesHeld >= info.maxTimes) cannotWhy = `It can be taken ${info.maxTimes === 1 ? 'once' : `${info.maxTimes} times`} in a person’s service, and that is used up.`;
  else if (balance.limited && balance.available !== null && balance.available <= info.floor) cannotWhy = 'Nothing is left of it this year.';
  return { balance: { ...balance, canAsk: !cannotWhy, ...(cannotWhy ? { cannotWhy } : {}) }, info };
}

/** Every balance of a person's policy for a year. */
export function balancesOf(w, year, asOf = asOfFor(year)) {
  return w.rules.map((rule) => balanceFor(w, rule, { year, asOf }).balance);
}

/** A person's leave year: from a key, or the one today is in. 422 for a key of the wrong shape. */
function yearFor(w, key) {
  if (key == null || key === '') return leaveYearOf(todayText(), w.startsMonth);
  const y = yearOfKey(key, w.startsMonth);
  if (!y) {
    const sample = yearFromStart(Number(todayText().slice(0, 4)), w.startsMonth).key;
    throw invalid('INVALID', `The leave year is written like ${sample}.`);
  }
  return y;
}

/* ══════════════════════════════════════════════════════════════════════════
 * The checks (§22.3)
 * ══════════════════════════════════════════════════════════════════════════ */

const isSick = (rule) => /^SL$/i.test(rule?.leaveTypeCode ?? '') || /sick|medical/i.test(rule?.leaveTypeName ?? '');
const block = (code, text) => ({ level: 'BLOCK', code, text });
const noteOf = (code, text) => ({ level: 'NOTE', code, text });

/**
 * The sentences of a rule's note that turn on attendance (EL's "20 present days", ML's
 * "80 days worked"), or null. Attendance is not recorded, so such a condition can only be
 * assumed and checked by HR — the request says so (§23.1: a note, not a field).
 */
const ATTENDANCE_RE = /\b(attendance|attended|present|presence|worked)\b/i;
export function attendanceSentences(notes) {
  if (!notes) return null;
  const hit = String(notes).split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x && ATTENDANCE_RE.test(x));
  return hit.length ? hit.join(' ') : null;
}

/** The longest run of days off that still joins two leaves ("next to" across a long holiday break). */
const MAX_OFF_RUN = 40;

/** Are `a` and `b` (a < b) next to each other: nothing but days off strictly between them? */
function onlyDaysOffBetween(calendar, a, b) {
  let n = 0;
  for (let d = addDays(a, 1); d < b; d = addDays(d, 1)) {
    if (calendar.isWorking(d) || (n += 1) > MAX_OFF_RUN) return false;
  }
  return true;
}

/**
 * A PENDING / APPROVED request of a leave type this one may not touch (§23.1): the asked
 * rule's own `notWithLeaveTypeIds`, or another rule naming the asked type in its own — the
 * policy forbids the pair either way round. Touching = overlapping, or next to it with only
 * days off between. @returns { request, overlaps } | null
 */
function notWithClash(w, rule, ask, excludeRequestId) {
  const forbidden = new Set((rule.notWithLeaveTypeIds ?? []).map(Number));
  for (const other of w.rules) {
    if ((other.notWithLeaveTypeIds ?? []).map(Number).includes(Number(rule.leaveTypeId))) forbidden.add(Number(other.leaveTypeId));
  }
  forbidden.delete(Number(rule.leaveTypeId));
  if (!forbidden.size) return null;
  for (const r of w.requests) {
    if (r.id === excludeRequestId || !forbidden.has(Number(r.leaveTypeId)) || (r.status !== 'PENDING' && r.status !== 'APPROVED')) continue;
    const overlaps = r.from <= ask.to && r.to >= ask.from;
    const before = r.to < ask.from && onlyDaysOffBetween(w.calendar, r.to, ask.from);
    const after = r.from > ask.to && onlyDaysOffBetween(w.calendar, ask.to, r.from);
    if (overlaps || before || after) return { request: r, overlaps };
  }
  return null;
}

/** A request body, read: 422 only for what cannot be read at all. */
export function readAsk(body = {}, { needEmployee = false } = {}) {
  const problems = [];
  const out = {};
  if (needEmployee) {
    const n = Number(body.employeeId);
    if (!Number.isInteger(n) || n <= 0) problems.push('Choose the person.'); else out.employeeId = n;
  }
  const t = Number(body.leaveTypeId);
  if (!Number.isInteger(t) || t <= 0) problems.push('Choose the leave type.'); else out.leaveTypeId = t;
  const from = String(body.from ?? '').slice(0, 10);
  const to = body.to == null || body.to === '' ? from : String(body.to).slice(0, 10);
  if (!isDate(from)) problems.push('The first day must be a date.'); else out.from = from;
  if (!isDate(to)) problems.push('The last day must be a date.'); else out.to = to;
  if (out.from && out.to && out.to >= out.from && daysBetween(out.from, out.to) >= MAX_RANGE_DAYS) problems.push(`One request covers at most ${MAX_RANGE_DAYS} days.`);
  const half = body.halfDay == null || body.halfDay === '' ? null : String(body.halfDay).toUpperCase();
  if (half !== null && half !== 'FIRST' && half !== 'SECOND') problems.push('A half day is the first half or the second half.'); else out.halfDay = half;
  out.reason = body.reason == null ? '' : String(body.reason).trim().slice(0, 2000);
  if (problems.length) throw invalid('INVALID', problems[0], { problems });
  return out;
}

/**
 * Every check of one ask, and what it would count and cost.
 * @param type   the leave type row ({ id, code, name, is_paid }) — for the words when it is not in the policy
 * @param mode   'preview' | 'submit' | 'approve' (the reason is needed on submit only)
 * @param askedOn the day it is asked on (today; on approve, the day it was submitted)
 * @returns { checks, days, quantity, rule, balance, info, before, after, canSubmit }
 */
export function checkAsk(w, type, ask, { mode = 'preview', excludeRequestId = null, askedOn = todayText() } = {}) {
  const checks = [];
  const out = { checks, days: [], quantity: 0, rule: null, balance: null, info: null, before: null, after: null };
  const typeName = type?.name ?? 'This leave';
  const done = () => { out.canSubmit = !checks.some((c) => c.level === 'BLOCK'); return out; };

  if (ask.to < ask.from) checks.push(block('END_BEFORE_START', 'The last day is before the first day.'));
  if (ask.halfDay && ask.to !== ask.from) checks.push(block('HALF_ON_RANGE', 'A half day is one date only. Choose one day, or a range without a half day.'));
  if (mode === 'submit' && blank(ask.reason)) checks.push(block('NO_REASON', 'Write the reason for the leave.'));
  if (!w.effective.policy) { checks.push(block('NO_POLICY', 'No leave policy applies yet. HR sets one for the position.')); return done(); }
  const rule = w.rules.find((r) => r.leaveTypeId === Number(ask.leaveTypeId));
  if (!rule) { checks.push(block('NOT_IN_POLICY', `${typeName} is not in the leave policy ${w.effective.policy.name}.`)); return done(); }
  out.rule = rule;
  const a = applicability(rule);
  const halfOk = a.halfDayAllowed && rule.halfDayAllowed;
  if (ask.halfDay && !halfOk) checks.push(block('HALF_NOT_ALLOWED', `Half days are not allowed for ${rule.leaveTypeName}.`));
  if (ask.to < ask.from) return done();

  const counted = countDays({ from: ask.from, to: ask.to, halfDay: ask.halfDay && ask.from === ask.to ? ask.halfDay : null, calendar: w.calendar, countDaysOffBetween: rule.countDaysOffBetween });
  out.days = counted.days;
  out.quantity = counted.quantity;
  if (counted.quantity === 0) checks.push(block('NO_DAY_COUNTS', 'No day in these dates counts as leave: they are all days off.'));

  // ── the person ──
  const g = genderOf(w.employee.gender);
  if (rule.appliesTo !== 'ANYONE') {
    if (!g) checks.push(noteOf('GENDER_UNKNOWN', `${rule.leaveTypeName} is for ${forWhom(rule.appliesTo)}, and no gender is recorded. The manager decides.`));
    else if (g !== rule.appliesTo) checks.push(block('NOT_FOR_GENDER', `${rule.leaveTypeName} is for ${forWhom(rule.appliesTo)} only.`));
  }
  const join = w.employee.joinDate;
  if (join && ask.from < join) checks.push(block('BEFORE_JOINING', `These dates are before the joining date, ${dayText(join, true)}.`));
  const wait = Number(rule.waitDaysAfterJoining) || 0;
  if (join && wait > 0 && ask.from >= join && ask.from < addDays(join, wait)) {
    checks.push(block('WAITING', `${rule.leaveTypeName} can be taken after ${daysWords(wait)} in the job, from ${dayText(addDays(join, wait), true)}.`));
  }
  if (w.employee.exitDate && ask.to > w.employee.exitDate) checks.push(block('AFTER_EXIT', `These dates are after the last working day, ${dayText(w.employee.exitDate, true)}.`));

  // ── how much ──
  const most = Number(rule.maxDaysAtOnce) || 0;
  if (most && counted.quantity > most) checks.push(block('TOO_LONG', `No more than ${daysWords(most)} at a stretch. This is ${daysWords(counted.quantity)}.`));
  const year = leaveYearOf(ask.from, w.startsMonth);
  const { balance, info } = balanceFor(w, rule, { year, asOf: ask.from, excludeRequestId });
  out.balance = balance;
  out.info = info;
  out.before = balance.available;
  out.after = balance.available === null ? null : Math.round((balance.available - counted.quantity) * 100) / 100;
  if (rule.basis === 'PER_EVENT') {
    if (info.maxTimes && info.timesUsed + info.timesHeld >= info.maxTimes) {
      checks.push(block('TIMES_USED', `${rule.leaveTypeName} can be taken ${info.maxTimes === 1 ? 'once' : `${info.maxTimes} times`} in a person’s service, and that is used up.`));
    } else if (info.perOccasion !== null && counted.quantity > info.perOccasion) {
      checks.push(block('NOT_ENOUGH', `One occasion gives ${daysWords(info.perOccasion)}. This asks for ${daysWords(counted.quantity)}.`));
    }
    out.after = info.perOccasion === null || out.before === null ? null : Math.max(0, out.before - counted.quantity);
  } else if (balance.limited && counted.quantity > 0 && out.after < info.floor) {
    checks.push(block('NOT_ENOUGH', `${balance.available <= 0 ? 'Nothing is' : `Only ${daysWords(balance.available)} ${balance.available <= 1 ? 'is' : 'are'}`} available in ${year.key}. This asks for ${daysWords(counted.quantity)}.`));
  }

  // ── another request on these days ──
  const clash = w.requests.find((r) => r.id !== excludeRequestId && (r.status === 'PENDING' || r.status === 'APPROVED')
    && r.from <= ask.to && r.to >= ask.from
    && !(r.halfDay && ask.halfDay && r.from === r.to && ask.from === ask.to && r.halfDay !== ask.halfDay));
  if (clash) checks.push(block('OVERLAP', `There is already leave on these days: ${clash.leaveTypeName}, ${spanText(clash.from, clash.to)}, ${STATUS_WORDS[clash.status]}.`));

  // ── a leave type it may not touch (§23.1), either rule saying so ──
  const near = notWithClash(w, rule, ask, excludeRequestId);
  if (near) {
    checks.push(block('NOT_WITH', `${rule.leaveTypeName} cannot be taken next to ${near.request.leaveTypeName}. There is ${near.request.leaveTypeName}, ${spanText(near.request.from, near.request.to)}, ${STATUS_WORDS[near.request.status]}, ${near.overlaps ? 'on these days' : 'next to these dates with only days off between'}.`));
  }

  // ── for the manager to weigh ──
  // The notice by length (§23.1) replaces the one notice when it is set.
  const tiered = Array.isArray(rule.noticeTiers) && rule.noticeTiers.length;
  const notice = tiered ? (noticeForQuantity(rule.noticeTiers, counted.quantity) ?? 0) : (Number(rule.minNoticeDays) || 0);
  const ahead = daysBetween(askedOn, ask.from);
  if (ask.from < askedOn) checks.push(noteOf('IN_PAST', 'These dates are in the past. This records leave already taken.'));
  else if (notice > 0 && ahead < notice) {
    checks.push(noteOf('SHORT_NOTICE', `Asked ${ahead === 0 ? 'on the day' : `${daysWords(ahead)} ahead`}. ${tiered ? `For ${daysWords(counted.quantity)} the policy asks for ${daysWords(notice)} ahead.` : `The policy asks for ${daysWords(notice)} ahead.`}`));
  }
  const attendance = attendanceSentences(rule.notes);
  const live = w.attendance?.liveFrom && w.attendance.liveFrom <= ask.from ? w.attendance : null;
  if (attendance && !live) checks.push(noteOf('ATTENDANCE', `Attendance is not recorded yet, so this is assumed and must be checked by HR: ${attendance}`));
  else if (live && (attendance || rule.minPresentDaysForCredit)) {
    // §28.4: attendance is live — what it says, instead of an assumption.
    // "80 days worked" or "worked at least 80 days".
    const m = /(\d+)\s+days?\s+worked|worked\s+(?:at\s+least\s+|for\s+)?(\d+)\s+days?/i.exec(String(rule.notes ?? ''));
    const worked = m ? [m[0], m[1] ?? m[2]] : null;
    if (worked) {
      const from12 = addDays(ask.from, -365);
      const since = from12 < live.liveFrom ? live.liveFrom : from12;
      const n = presentBetween(live, since, addDays(ask.from, -1));
      const need = Number(worked[1]);
      checks.push(noteOf('ATTENDANCE', `Attendance shows ${plain(n)} day${n === 1 ? '' : 's'} worked from ${dayText(since, true)} to ${dayText(addDays(ask.from, -1), true)}${since > from12 ? ` (attendance is recorded from ${dayText(live.liveFrom, true)}; earlier months must be checked by HR)` : ''}; the policy asks for ${need}.`));
    } else if (rule.minPresentDaysForCredit) {
      checks.push(noteOf('ATTENDANCE', `Attendance is live: a month is credited only when it has ${rule.minPresentDaysForCredit} present days, and the balance above already counts that.`));
    } else {
      checks.push(noteOf('ATTENDANCE', `Attendance is live from ${dayText(live.liveFrom, true)}; HR checks this against it: ${attendance}`));
    }
  }
  if (!rule.allowedInProbation) checks.push(noteOf('PROBATION', `${rule.leaveTypeName} is not meant for probation. Probation is not recorded here, so check it.`));
  const proof = rule.proofAfterDays === null || rule.proofAfterDays === undefined ? null : Number(rule.proofAfterDays);
  if (proof !== null && counted.quantity > proof) {
    const what = isSick(rule) ? 'a medical certificate' : 'proof';
    checks.push(noteOf('PROOF', proof === 0 ? `Bring ${what}: it is needed every time.` : `Bring ${what}: it is needed beyond ${daysWords(proof)}.`));
  }
  if (!rule.isPaid) checks.push(noteOf('UNPAID', `${rule.leaveTypeName} is unpaid.`));
  if (w.calendar.note) checks.push(noteOf('CALENDAR', w.calendar.note));
  return done();
}

/** "3 days of Casual leave, 12–15 Oct (Sunday is a weekly off). 4 left after this." */
export function summaryOfAsk(result, type, ask) {
  const name = result.rule?.leaveTypeName ?? type?.name ?? 'leave';
  if (!result.rule) return `${name}, ${spanText(ask.from, ask.to)}.`;
  if (ask.to < ask.from) return 'The last day is before the first day.';
  if (result.quantity === 0) return `No day of ${spanText(ask.from, ask.to)} counts as leave${daysOffPhrase(result.days)}.`;
  const qty = daysWords(result.quantity);
  const head = `${qty.charAt(0).toUpperCase()}${qty.slice(1)} of ${name}, ${spanText(ask.from, ask.to)}${ask.halfDay ? ` (${ask.halfDay === 'FIRST' ? 'first' : 'second'} half)` : ''}${daysOffPhrase(result.days)}.`;
  if (result.after === null) return `${head} There is no fixed limit.`;
  return `${head} ${plain(result.after)} left after this.`;
}

/* ══════════════════════════════════════════════════════════════════════════
 * The approver (§22.4)
 * ══════════════════════════════════════════════════════════════════════════ */

/** The line the org chart draws: PRIMARY_MANAGER, the general one first, the primary one first. */
function chartLine(relationships) {
  const lines = relationships.filter((r) => r.relationshipType?.code === 'PRIMARY_MANAGER');
  return lines.find((r) => r.scope?.type === 'GENERAL') ?? lines[0] ?? null;
}

/**
 * Walk up from the person's main position. Each step is a chair (or, for a line
 * recorded on the person's own work, a person) and who sits in it today.
 * @returns { approverId | null, chain: [{ positionId, employeeIds }] }  `full` walks to the top.
 */
export async function approverChain(db, companyId, w, { on = todayText(), full = false } = {}) {
  const chain = [];
  let approverId = null;
  if (!w.seat) return { approverId, chain };
  const self = w.employee.id;
  const rep = await resolveReporting(db, companyId, w.seat.assignmentId, { on });
  let line = chartLine(rep.relationships);
  const seen = new Set([w.seat.positionId].filter(Boolean));
  for (let hop = 0; line && hop < 40; hop += 1) {
    const positionId = line.origin === 'ASSIGNMENT' ? (line.manager?.positionId ?? null) : (line.managerPosition?.id ?? null);
    const people = (line.origin === 'ASSIGNMENT' ? [line.manager?.employeeId] : line.managerCandidates.map((m) => m.employeeId))
      .filter((id) => id != null && id !== self);
    chain.push({ positionId, employeeIds: people });
    if (approverId === null && people.length) { approverId = people[0]; if (!full) break; }
    if (!positionId || seen.has(positionId)) break;
    seen.add(positionId);
    line = chartLine((await resolvePositionReporting(db, companyId, positionId, { on })).relationships);
  }
  return { approverId, chain };
}

/** Is `employeeId` the approver of this request, or in a chair above the approver's in the same chain? */
async function isAboveOrApprover(db, companyId, w, approverId, employeeId) {
  if (employeeId == null) return false;
  if (approverId != null && approverId === employeeId) return true;
  const { chain } = await approverChain(db, companyId, w, { full: true });
  const at = approverId == null ? 0 : chain.findIndex((c) => c.employeeIds.includes(approverId));
  return chain.slice(Math.max(0, at)).some((c) => c.employeeIds.includes(employeeId));
}

/* ══════════════════════════════════════════════════════════════════════════
 * Shaping a request
 * ══════════════════════════════════════════════════════════════════════════ */

const REQUEST_SELECT = `
  SELECT r.id, r.employee_id, r.leave_type_id, r.from_date, r.to_date, r.half_day, r.quantity, r.reason, r.status,
         r.approver_employee_id, r.created_at, r.decided_at, r.decided_by, r.decision_note, r.cancel_note, r.raised_by_hr, r.raised_by_system, r.days_json,
         lt.code AS lt_code, lt.name AS lt_name, lt.is_paid AS lt_is_paid, u.name AS decided_by_name
    FROM hrms_leave_requests r
    JOIN hrms_leave_types lt ON lt.company_id = r.company_id AND lt.id = r.leave_type_id
    LEFT JOIN users u ON u.id = r.decided_by
   WHERE r.company_id = ? AND r.deleted_at IS NULL`;

/** The employees of `ids` HR's rights apply to, for this viewer. */
async function hrIdsOf(db, companyId, viewer, ids) {
  if (!viewer?.hr || !ids.length) return new Set();
  if (viewer.hr.all) return new Set(ids);
  const depts = [...(viewer.hr.departmentIds ?? [])];
  if (!depts.length) return new Set();
  const on = todayText();
  const [rows] = await db.query(`SELECT e.id FROM hrms_employees e WHERE e.company_id = ? AND e.id IN (?) AND ${EMPLOYEE_IN_DEPARTMENTS_SQL('e')}`, [companyId, ids, on, on, depts]);
  return new Set(rows.map((r) => r.id));
}

/** What this viewer may do to this request. `hrIds`: the people HR's rights apply to; `above`: request ids they sit above. */
function canOf(row, viewer, { hrIds = new Set(), above = new Set(), today = todayText() } = {}) {
  const own = viewer?.employeeId != null && row.employee_id === viewer.employeeId;
  const hr = hrIds.has(row.employee_id);
  const decider = !own && ((row.approver_employee_id != null && row.approver_employee_id === viewer?.employeeId) || hr || above.has(row.id));
  const pending = row.status === 'PENDING';
  const from = dateText(row.from_date);
  const cancel = (own && (pending || (row.status === 'APPROVED' && from > today))) || (hr && (pending || row.status === 'APPROVED'));
  return { approve: pending && decider, reject: pending && decider, cancel: Boolean(cancel) };
}

function shapeRequest(row, persons, can) {
  return {
    id: row.id,
    person: persons.get(row.employee_id) ?? { employeeId: row.employee_id, name: null, employeeCode: null, positionTitle: null, departmentName: null },
    leaveType: { id: row.leave_type_id, code: row.lt_code, name: row.lt_name, isPaid: Boolean(row.lt_is_paid) },
    from: dateText(row.from_date),
    to: dateText(row.to_date),
    halfDay: row.half_day ?? null,
    quantity: num(row.quantity),
    reason: row.reason ?? '',
    status: row.status,
    approver: row.approver_employee_id != null ? (persons.get(row.approver_employee_id) ?? null) : null,
    submittedAt: iso(row.created_at),
    decidedAt: row.decided_at ? iso(row.decided_at) : null,
    decidedBy: row.decided_by_name ?? null,
    decisionNote: row.decision_note ?? null,
    cancelNote: row.cancel_note ?? null,
    raisedByHr: Boolean(row.raised_by_hr),
    // §28.3: taken by the attendance rules (a penalty), never asked for; waived on the Penalties screen.
    raisedBySystem: Boolean(row.raised_by_system),
    can,
  };
}

/** Rows -> Request[] for a viewer: persons in one go, HR's reach in one query. */
async function shapeRows(db, companyId, rows, viewer, { above = new Set() } = {}) {
  const ids = rows.flatMap((r) => [r.employee_id, r.approver_employee_id]);
  const [persons, hrIds] = await Promise.all([
    loadPersons(db, companyId, ids),
    hrIdsOf(db, companyId, viewer, [...new Set(rows.map((r) => r.employee_id))]),
  ]);
  const today = todayText();
  return rows.map((r) => shapeRequest(r, persons, canOf(r, viewer, { hrIds, above, today })));
}

async function requestRow(db, companyId, id, { lock = false } = {}) {
  // The lock is on the request row alone, not on the rows it is read with.
  if (lock) await db.query('SELECT id FROM hrms_leave_requests WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [companyId, id]);
  const [[row]] = await db.query(`${REQUEST_SELECT} AND r.id = ?`, [companyId, id]);
  if (!row) throw notFound('That leave request');
  return row;
}

async function leaveTypeRow(db, companyId, id) {
  const [[t]] = await db.query('SELECT id, code, name, is_paid FROM hrms_leave_types WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!t) throw notFound('That leave type');
  return t;
}

/* ══════════════════════════════════════════════════════════════════════════
 * The login's own employee
 * ══════════════════════════════════════════════════════════════════════════ */

/** The employee of this login, or null. */
export async function employeeIdOfLogin(db, c) {
  if (!c.userId) return null;
  const [[e]] = await db.query('SELECT id FROM hrms_employees WHERE company_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [c.companyId, c.userId]);
  return e?.id ?? null;
}
async function myEmployeeId(db, c) {
  const id = await employeeIdOfLogin(db, c);
  if (!id) throw new HrmsError(403, 'NOT_LINKED', 'This login is not linked to an employee, so it has no leave of its own.');
  return id;
}

/* ══════════════════════════════════════════════════════════════════════════
 * Preview and submit — the person, or HR on their behalf
 * ══════════════════════════════════════════════════════════════════════════ */

async function previewOf(db, companyId, employeeId, ask) {
  const w = await worldOf(db, companyId, employeeId);
  const type = await leaveTypeRow(db, companyId, ask.leaveTypeId);
  const result = checkAsk(w, type, ask, { mode: 'preview' });
  const { approverId } = await approverChain(db, companyId, w);
  const persons = await loadPersons(db, companyId, [approverId]);
  // §28.4: what attendance already recorded on those days (asking for leave already taken).
  const [att] = ask.to >= ask.from ? await db.query(
    'SELECT attendance_date, status, status_reason FROM hrms_attendance_records WHERE company_id = ? AND employee_id = ? AND deleted_at IS NULL AND attendance_date BETWEEN ? AND ? ORDER BY attendance_date',
    [companyId, employeeId, ask.from, ask.to]) : [[]];
  return {
    days: result.days,
    attendance: att.map((a) => ({ date: dateText(a.attendance_date), status: a.status, why: a.status_reason ?? null })),
    quantity: result.quantity,
    balance: { before: result.before, after: result.after, why: result.balance?.why ?? '' },
    checks: result.checks,
    approver: approverId != null ? (persons.get(approverId) ?? null) : null,
    canSubmit: result.canSubmit,
    summary: summaryOfAsk(result, type, ask),
  };
}

async function submitFor(conn, c, employeeId, ask, { raisedByHr = false, requestId = null, viewer = null } = {}) {
  // One person's requests are written one at a time: two at once cannot both spend the same days.
  const [[e]] = await conn.query('SELECT id FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, employeeId]);
  if (!e) throw notFound('That employee');
  const w = await worldOf(conn, c.companyId, employeeId);
  const type = await leaveTypeRow(conn, c.companyId, ask.leaveTypeId);
  const result = checkAsk(w, type, ask, { mode: 'submit' });
  const blocks = result.checks.filter((x) => x.level === 'BLOCK');
  if (blocks.length) throw invalid('INVALID', 'This leave cannot be asked for yet.', { problems: blocks.map((b) => b.text), checks: result.checks });
  const { approverId } = await approverChain(conn, c.companyId, w);
  const [ins] = await conn.query(
    `INSERT INTO hrms_leave_requests
       (company_id, employee_id, leave_type_id, from_date, to_date, quantity, reason, status, approver_employee_id, half_day, days_json, raised_by_hr, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)`,
    [c.companyId, employeeId, ask.leaveTypeId, ask.from, ask.to, result.quantity, ask.reason, approverId, ask.halfDay,
      JSON.stringify(result.days), raisedByHr ? 1 : 0, c.userId],
  );
  await audit(conn, c, 'hrms_leave_requests', ins.insertId, 'CREATE', null, {
    employeeId, leaveTypeId: ask.leaveTypeId, from: ask.from, to: ask.to, halfDay: ask.halfDay, quantity: result.quantity,
    status: 'PENDING', approverEmployeeId: approverId, raisedByHr, notes: result.checks.filter((x) => x.level === 'NOTE').map((x) => x.code),
  }, requestId);
  const row = await requestRow(conn, c.companyId, ins.insertId);
  return { request: (await shapeRows(conn, c.companyId, [row], viewer ?? { userId: c.userId, employeeId: raisedByHr ? null : employeeId, hr: null }))[0] };
}

/* ══ self ════════════════════════════════════════════════════════════════ */

/** GET /user/me/leave?year= */
export async function myLeave(db, c, { year: key = null } = {}) {
  const me = await myEmployeeId(db, c);
  const w = await worldOf(db, c.companyId, me);
  const year = yearFor(w, key);
  const [{ approverId }, [rows]] = await Promise.all([
    approverChain(db, c.companyId, w),
    db.query(`${REQUEST_SELECT} AND r.employee_id = ? ORDER BY r.from_date DESC, r.id DESC`, [c.companyId, me]),
  ]);
  const viewer = { userId: c.userId, employeeId: me, hr: null };
  const [requests, persons] = await Promise.all([shapeRows(db, c.companyId, rows, viewer), loadPersons(db, c.companyId, [approverId])]);
  return {
    year: { key: year.key, label: year.label, from: year.from, to: year.to },
    policy: policyOf(w),
    balances: balancesOf(w, year),
    requests,
    approver: approverId != null ? (persons.get(approverId) ?? null) : null,
    calendarNote: w.calendar.note,
  };
}

/** POST /user/me/leave/preview */
export async function previewMine(db, c, body = {}) {
  return previewOf(db, c.companyId, await myEmployeeId(db, c), readAsk(body));
}

/** POST /user/me/leave */
export async function submitMine(conn, c, body = {}, requestId = null) {
  const me = await myEmployeeId(conn, c);
  return submitFor(conn, c, me, readAsk(body), { requestId, viewer: { userId: c.userId, employeeId: me, hr: null } });
}

/** POST /user/me/leave/:id/cancel — the person's own request only (another's reads as not found). */
export async function cancelMine(conn, c, id, body = {}, requestId = null) {
  const me = await myEmployeeId(conn, c);
  const row = await requestRow(conn, c.companyId, id, { lock: true });
  if (row.employee_id !== me) throw notFound('That leave request');
  if (row.raised_by_system) throw conflict('SYSTEM_REQUEST', 'This leave was taken by the attendance rules (a penalty). HR or your manager can waive the penalty; that gives the day back.');
  const today = todayText();
  if (row.status === 'APPROVED' && dateText(row.from_date) <= today) {
    throw conflict('ALREADY_STARTED', 'This leave has started, so it cannot be cancelled here. Ask HR.');
  }
  if (row.status !== 'PENDING' && row.status !== 'APPROVED') throw conflict('NOT_OPEN', `This request is already ${STATUS_WORDS[row.status]}.`);
  return writeCancel(conn, c, row, String(body.note ?? '').trim(), { userId: c.userId, employeeId: me, hr: null }, requestId);
}

async function writeCancel(conn, c, row, note, viewer, requestId) {
  await conn.query("UPDATE hrms_leave_requests SET status = 'CANCELLED', cancel_note = ? WHERE company_id = ? AND id = ?", [note || null, c.companyId, row.id]);
  await audit(conn, c, 'hrms_leave_requests', row.id, 'UPDATE', { status: row.status }, { status: 'CANCELLED', cancelNote: note || null }, requestId);
  // §28.4: an approved leave marked days; cancelling it processes them again.
  if (row.status === 'APPROVED') await attendanceAfterLeave(conn, c, row);
  const fresh = await requestRow(conn, c.companyId, row.id);
  return { request: (await shapeRows(conn, c.companyId, [fresh], viewer))[0] };
}

/* ══ HR ══════════════════════════════════════════════════════════════════ */

/** POST /leave/requests/preview { employeeId, … } */
export async function previewForPerson(db, c, body = {}) {
  const ask = readAsk(body, { needEmployee: true });
  return previewOf(db, c.companyId, ask.employeeId, ask);
}

/** POST /leave/requests { employeeId, … } — on the person's behalf: raised_by_hr. */
export async function submitForPerson(conn, c, body = {}, viewer = null, requestId = null) {
  const ask = readAsk(body, { needEmployee: true });
  return submitFor(conn, c, ask.employeeId, ask, { raisedByHr: true, requestId, viewer });
}

/** POST /leave/requests/:id/cancel — HR, any time, with a note. */
export async function cancelByHr(conn, c, id, body = {}, viewer = null, requestId = null) {
  const row = await requestRow(conn, c.companyId, id, { lock: true });
  if (row.raised_by_system) throw conflict('SYSTEM_REQUEST', 'This leave was taken by the attendance rules (a penalty). Waive the penalty on Attendance › Penalties; that gives the day back.');
  if (row.status !== 'PENDING' && row.status !== 'APPROVED') throw conflict('NOT_OPEN', `This request is already ${STATUS_WORDS[row.status]}.`);
  const note = String(body.note ?? '').trim();
  if (!note) throw invalid('NOTE_NEEDED', 'Say why it is cancelled.');
  return writeCancel(conn, c, row, note.slice(0, 2000), viewer, requestId);
}

/**
 * GET /leave/requests?status=&leaveTypeId=&departmentId=&from=&to=&q=
 * @param scopeDeptIds null for the whole company, else the login's departments
 */
export async function listRequests(db, c, query = {}, scopeDeptIds = null, viewer = null) {
  const where = [];
  const params = [c.companyId];
  const on = todayText();
  const statuses = String(query.status ?? '').toUpperCase().split(',').map((s) => s.trim()).filter((s) => ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(s));
  if (statuses.length) { where.push('r.status IN (?)'); params.push(statuses); }
  if (query.leaveTypeId) { where.push('r.leave_type_id = ?'); params.push(Number(query.leaveTypeId) || 0); }
  if (isDate(String(query.from ?? ''))) { where.push('r.to_date >= ?'); params.push(String(query.from)); }
  if (isDate(String(query.to ?? ''))) { where.push('r.from_date <= ?'); params.push(String(query.to)); }
  if (!blank(query.q)) { where.push('(e.full_name LIKE ? OR e.employee_code LIKE ?)'); const like = `%${String(query.q).trim().slice(0, 100)}%`; params.push(like, like); }
  if (query.departmentId) { where.push(EMPLOYEE_IN_DEPARTMENTS_SQL('e')); params.push(on, on, [Number(query.departmentId) || 0]); }
  if (scopeDeptIds) {
    if (!scopeDeptIds.length) return { items: [], total: 0 };
    where.push(EMPLOYEE_IN_DEPARTMENTS_SQL('e')); params.push(on, on, scopeDeptIds);
  }
  const [rows] = await db.query(
    `${REQUEST_SELECT.replace('LEFT JOIN users u', 'JOIN hrms_employees e ON e.company_id = r.company_id AND e.id = r.employee_id\n    LEFT JOIN users u')}
     ${where.length ? `AND ${where.join(' AND ')}` : ''}
     ORDER BY FIELD(r.status, 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'), r.from_date DESC, r.id DESC
     LIMIT 1000`, params);
  const items = await shapeRows(db, c.companyId, rows, viewer);
  return { items, total: items.length };
}

/** The employee a request is for — for the department scope gate. */
export async function requestEmployeeId(db, companyId, id) {
  const [[r]] = await db.query('SELECT employee_id FROM hrms_leave_requests WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  return r?.employee_id ?? null;
}

/* ══════════════════════════════════════════════════════════════════════════
 * Context, the approvals feed, deciding
 * ══════════════════════════════════════════════════════════════════════════ */

const parseDays = (v) => { if (v == null) return null; if (Array.isArray(v)) return v; try { return JSON.parse(v); } catch { return null; } };
const askOfRow = (row) => ({ leaveTypeId: row.leave_type_id, from: dateText(row.from_date), to: dateText(row.to_date), halfDay: row.half_day ?? null, reason: row.reason ?? '' });
const askedOnOf = (row) => (row.created_at ? iso(row.created_at).slice(0, 10) : todayText());

/** The checks of a request as it stands, without its own hold. */
function recheck(w, row) {
  return checkAsk(w, { id: row.leave_type_id, code: row.lt_code, name: row.lt_name }, askOfRow(row), { mode: 'approve', excludeRequestId: row.id, askedOn: askedOnOf(row) });
}

/** The side sheet: { request, context }. */
async function contextOf(db, c, row, request) {
  const w = await worldOf(db, c.companyId, row.employee_id);
  const result = recheck(w, row);
  const from = dateText(row.from_date);
  const to = dateText(row.to_date);
  const year = leaveYearOf(from, w.startsMonth);
  const yearSoFar = w.requests
    .filter((r) => r.id !== row.id && r.from >= year.from && r.from <= year.to)
    .map((r) => ({ leaveTypeName: r.leaveTypeName, quantity: r.quantity, from: r.from, to: r.to, status: r.status }));
  const dept = w.seat?.departmentId ?? null;
  const on = todayText();
  const [others] = await db.query(
    `SELECT r.employee_id, r.from_date, r.to_date, r.status, lt.name AS lt_name
       FROM hrms_leave_requests r JOIN hrms_leave_types lt ON lt.company_id = r.company_id AND lt.id = r.leave_type_id
      WHERE r.company_id = ? AND r.deleted_at IS NULL AND r.status IN ('PENDING', 'APPROVED') AND r.employee_id <> ?
        AND r.from_date <= ? AND r.to_date >= ?
        AND (r.approver_employee_id = ? OR EXISTS (
              SELECT 1 FROM hrms_work_assignments swa
                LEFT JOIN hrms_positions sp ON sp.company_id = swa.company_id AND sp.id = swa.position_id AND sp.deleted_at IS NULL
               WHERE swa.company_id = r.company_id AND swa.employee_id = r.employee_id AND swa.deleted_at IS NULL AND swa.status <> 'ENDED'
                 AND (swa.effective_from IS NULL OR swa.effective_from <= ?) AND (swa.effective_to IS NULL OR swa.effective_to >= ?)
                 AND COALESCE(sp.department_id, swa.department_id) = ?))
      ORDER BY r.from_date, r.id LIMIT 200`,
    [c.companyId, row.employee_id, to, from, row.approver_employee_id ?? -1, on, on, dept ?? -1],
  );
  const persons = await loadPersons(db, c.companyId, others.map((o) => o.employee_id));
  const rule = result.rule;
  return {
    request,
    context: {
      balance: result.balance,
      checks: result.checks,
      days: parseDays(row.days_json) ?? result.days,
      yearSoFar,
      teamOff: others.map((o) => ({ person: persons.get(o.employee_id), from: dateText(o.from_date), to: dateText(o.to_date), leaveTypeName: o.lt_name, status: o.status })),
      policyLine: w.effective.line,
      ruleSentence: rule?.summary ?? '',
      noticeDays: daysBetween(askedOnOf(row), from),
    },
  };
}

/** Is this viewer allowed to read / decide this request through the approvals screen? */
async function reachOf(db, c, row, viewer) {
  const hrIds = await hrIdsOf(db, c.companyId, viewer, [row.employee_id]);
  const own = viewer.employeeId != null && row.employee_id === viewer.employeeId;
  let above = false;
  if (!own && !hrIds.has(row.employee_id) && viewer.employeeId != null) {
    if (row.approver_employee_id != null && row.approver_employee_id === viewer.employeeId) above = true;
    else above = await isAboveOrApprover(db, c.companyId, await worldOf(db, c.companyId, row.employee_id), row.approver_employee_id ?? null, viewer.employeeId);
  }
  return { own, hrIds, above: above ? new Set([row.id]) : new Set(), decider: !own && (hrIds.has(row.employee_id) || above) };
}

/** GET /user/me/approvals/leave/:id */
export async function approvalDetail(db, c, viewer, id) {
  const row = await requestRow(db, c.companyId, id);
  const reach = await reachOf(db, c, row, viewer);
  if (!reach.decider && row.decided_by !== c.userId) {
    throw new HrmsError(403, 'NOT_YOUR_APPROVAL', reach.own ? 'This is your own request. It is in My leave.' : 'This request is not waiting for you.');
  }
  const [request] = await shapeRowsWith(db, c.companyId, [row], viewer, reach);
  return contextOf(db, c, row, request);
}

async function shapeRowsWith(db, companyId, rows, viewer, reach) {
  const persons = await loadPersons(db, companyId, rows.flatMap((r) => [r.employee_id, r.approver_employee_id]));
  return rows.map((r) => shapeRequest(r, persons, canOf(r, viewer, { hrIds: reach.hrIds, above: reach.above })));
}

/** GET /leave/requests/:id — HR (the scope gate ran first). */
export async function readRequest(db, c, viewer, id) {
  const row = await requestRow(db, c.companyId, id);
  const [request] = await shapeRows(db, c.companyId, [row], viewer);
  return contextOf(db, c, row, request);
}

/**
 * POST …/approve | …/reject. `verdict`: 'APPROVE' | 'REJECT'.
 * The approver, anybody above them, or HR — never the person themselves.
 */
export async function decide(conn, c, viewer, id, verdict, body = {}, requestId = null) {
  const row = await requestRow(conn, c.companyId, id, { lock: true });
  const reach = await reachOf(conn, c, row, viewer);
  if (reach.own) throw new HrmsError(403, 'OWN_REQUEST', 'Nobody decides their own leave. It goes to your manager.');
  if (!reach.decider) throw new HrmsError(403, 'NOT_YOUR_APPROVAL', 'This request is not waiting for you. Its approver, a manager above them, or HR decides it.');
  if (row.status !== 'PENDING') throw conflict('NOT_PENDING', `This request is already ${STATUS_WORDS[row.status]}.`);
  const note = String(body.note ?? '').trim().slice(0, 2000);
  if (verdict === 'REJECT' && !note) throw invalid('NOTE_NEEDED', 'Say why it is rejected.');
  if (verdict === 'APPROVE') {
    // The BLOCK checks again, against the balance as it is now, without this request's own hold.
    await conn.query('SELECT id FROM hrms_employees WHERE company_id = ? AND id = ? FOR UPDATE', [c.companyId, row.employee_id]);
    const w = await worldOf(conn, c.companyId, row.employee_id);
    const blocks = recheck(w, row).checks.filter((x) => x.level === 'BLOCK');
    if (blocks.length) throw invalid('INVALID', 'This leave cannot be approved as it stands.', { problems: blocks.map((b) => b.text) });
  }
  const status = verdict === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  await conn.query(
    `UPDATE hrms_leave_requests SET status = ?, decided_by = ?, decided_at = NOW(), decision_note = ?${verdict === 'APPROVE' ? ', approved_at = NOW()' : ''}
      WHERE company_id = ? AND id = ?`,
    [status, c.userId, note || null, c.companyId, row.id],
  );
  await audit(conn, c, 'hrms_leave_requests', row.id, verdict === 'APPROVE' ? 'APPROVE' : 'UPDATE', { status: 'PENDING' }, { status, decisionNote: note || null }, requestId);
  if (verdict === 'APPROVE') await attendanceAfterLeave(conn, c, row);
  const fresh = await requestRow(conn, c.companyId, row.id);
  const [request] = await shapeRowsWith(conn, c.companyId, [fresh], viewer, reach);
  return { request };
}

/**
 * GET /user/me/approvals?status=PENDING|DECIDED -> { items: ApprovalItem[], counts: { pending } }
 * Waiting for this login: requests whose approver they are, and — with leave edit — the
 * ones nobody was found for, in their scope. Today only kind LEAVE; another kind adds
 * its own rows here and its own `kind`.
 */
export async function myApprovals(db, c, viewer, { status = 'PENDING' } = {}) {
  const me = viewer.employeeId ?? -1;
  const on = todayText();
  let hrSql = '0';
  const hrParams = [];
  if (viewer.hr?.all) hrSql = '1';
  else if (viewer.hr?.departmentIds?.size) { hrSql = EMPLOYEE_IN_DEPARTMENTS_SQL('e'); hrParams.push(on, on, [...viewer.hr.departmentIds]); }
  const waiting = `r.status = 'PENDING' AND r.employee_id <> ? AND (r.approver_employee_id = ? OR (r.approver_employee_id IS NULL AND ${hrSql}))`;
  const withEmployee = REQUEST_SELECT.replace('LEFT JOIN users u', 'JOIN hrms_employees e ON e.company_id = r.company_id AND e.id = r.employee_id\n    LEFT JOIN users u');
  const decided = String(status).toUpperCase() === 'DECIDED';
  const [[rows], [[count]]] = await Promise.all([
    decided
      ? db.query(`${withEmployee} AND r.status <> 'PENDING' AND (r.decided_by = ? OR r.approver_employee_id = ?) ORDER BY COALESCE(r.decided_at, r.updated_at) DESC, r.id DESC LIMIT 200`, [c.companyId, c.userId ?? -1, me])
      : db.query(`${withEmployee} AND ${waiting} ORDER BY r.created_at, r.id LIMIT 500`, [c.companyId, me, me, ...hrParams]),
    db.query(`SELECT COUNT(*) AS n FROM hrms_leave_requests r JOIN hrms_employees e ON e.company_id = r.company_id AND e.id = r.employee_id WHERE r.company_id = ? AND r.deleted_at IS NULL AND ${waiting}`, [c.companyId, me, me, ...hrParams]),
  ]);
  const persons = await loadPersons(db, c.companyId, rows.map((r) => r.employee_id));
  const worlds = decided ? new Map() : await loadWorlds(db, c.companyId, rows.map((r) => r.employee_id));
  const now = Date.now();
  const items = rows.map((r) => {
    const w = worlds.get(r.employee_id);
    const flags = w ? recheck(w, r).checks.map((x) => x.text) : [];
    const end = r.decided_at ? new Date(r.decided_at).getTime() : now;
    return {
      kind: 'LEAVE',
      id: r.id,
      person: persons.get(r.employee_id),
      title: `${r.lt_name} · ${daysWords(Number(r.quantity))}`,
      when: spanText(dateText(r.from_date), dateText(r.to_date)),
      submittedAt: iso(r.created_at),
      waitingDays: Math.max(0, Math.floor((end - new Date(r.created_at).getTime()) / 86400000)),
      flags,
      status: r.status,
    };
  });
  return { items, counts: { pending: Number(count?.n ?? 0) } };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Attendance (§28.3, §28.4)
 * ══════════════════════════════════════════════════════════════════════════ */

/** Approved leave marks days LEAVE; a cancelled one gives them back. The attendance module decides whether it is live. */
async function attendanceAfterLeave(conn, c, row) {
  try {
    const { reprocess } = await import('../attendance/process.js');
    await reprocess(conn, c, [row.employee_id], dateText(row.from_date), dateText(row.to_date), 'LEAVE');
  } catch (err) {
    // The leave decision stands whatever attendance makes of it; the nightly run catches up.
    console.warn(`[cf_hrms] attendance after leave ${row.id}: ${err.message}`);
  }
}

/**
 * A SYSTEM leave request (§28.3): a penalty's leave deduction. It goes through the same checks
 * as any request (the balance, the type in the policy, half days, overlaps) and, when nothing
 * BLOCKs, is written APPROVED with raised_by_system = 1 — so the balance is the one truth.
 * @param ask { leaveTypeId, from, to?, halfDay?, reason }
 * @returns { request: { id, quantity } } | { blocked: true, problems: string[] }
 */
export async function raiseSystemRequest(conn, c, employeeId, ask, { requestId = null } = {}) {
  const w = await worldOf(conn, c.companyId, employeeId);
  const [[type]] = await conn.query('SELECT id, code, name, is_paid FROM hrms_leave_types WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, ask.leaveTypeId]);
  if (!type) return { blocked: true, problems: ['That leave type is not there.'] };
  const full = { leaveTypeId: Number(ask.leaveTypeId), from: ask.from, to: ask.to ?? ask.from, halfDay: ask.halfDay ?? null, reason: String(ask.reason ?? '').slice(0, 2000) };
  const result = checkAsk(w, type, full, { mode: 'preview' });
  const blocks = result.checks.filter((x) => x.level === 'BLOCK');
  if (blocks.length) return { blocked: true, problems: blocks.map((b) => b.text) };
  const [ins] = await conn.query(
    `INSERT INTO hrms_leave_requests
       (company_id, employee_id, leave_type_id, from_date, to_date, quantity, reason, status, approver_employee_id, half_day, days_json,
        raised_by_hr, raised_by_system, decided_by, decided_at, approved_at, decision_note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'APPROVED', NULL, ?, ?, 0, 1, ?, NOW(), NOW(), 'Taken by the attendance rules', ?)`,
    [c.companyId, employeeId, full.leaveTypeId, full.from, full.to, result.quantity, full.reason, full.halfDay, JSON.stringify(result.days), c.userId ?? null, c.userId ?? null],
  );
  await audit(conn, c, 'hrms_leave_requests', ins.insertId, 'CREATE', null, {
    employeeId, leaveTypeId: full.leaveTypeId, from: full.from, to: full.to, halfDay: full.halfDay, quantity: result.quantity, status: 'APPROVED', raisedBySystem: true,
  }, requestId);
  return { request: { id: ins.insertId, quantity: result.quantity } };
}

/** Cancel a SYSTEM leave request (its penalty was waived or reversed): the day goes back to the balance. */
export async function cancelSystemRequest(conn, c, id, note, requestId = null) {
  const [[row]] = await conn.query('SELECT id, status, raised_by_system FROM hrms_leave_requests WHERE company_id = ? AND id = ? FOR UPDATE', [c.companyId, id]);
  if (!row || !row.raised_by_system || row.status !== 'APPROVED') return false;
  await conn.query("UPDATE hrms_leave_requests SET status = 'CANCELLED', cancel_note = ? WHERE company_id = ? AND id = ?", [String(note ?? '').slice(0, 2000) || null, c.companyId, id]);
  await audit(conn, c, 'hrms_leave_requests', id, 'UPDATE', { status: 'APPROVED' }, { status: 'CANCELLED', cancelNote: note ?? null, raisedBySystem: true }, requestId);
  return true;
}

/* ══════════════════════════════════════════════════════════════════════════
 * Opening balances (HR) and the person × type grid
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * GET /leave/balances?year=&departmentId=&q=
 * -> { year, leaveTypes: [{ id, code, name, isPaid }], rows: [{ person, policy, year, balances }] }
 * Each person's leave year is the one of their own policy that starts in the same
 * calendar year as `year` (or the one today is in).
 */
export async function balancesGrid(db, c, query = {}, scopeDeptIds = null) {
  const on = todayText();
  const where = ["e.company_id = ?", 'e.deleted_at IS NULL', "e.employment_status <> 'EXITED'"];
  const params = [c.companyId];
  if (!blank(query.q)) { where.push('(e.full_name LIKE ? OR e.employee_code LIKE ?)'); const like = `%${String(query.q).trim().slice(0, 100)}%`; params.push(like, like); }
  if (query.departmentId) { where.push(EMPLOYEE_IN_DEPARTMENTS_SQL('e')); params.push(on, on, [Number(query.departmentId) || 0]); }
  if (scopeDeptIds) {
    if (!scopeDeptIds.length) return { year: null, leaveTypes: [], rows: [] };
    where.push(EMPLOYEE_IN_DEPARTMENTS_SQL('e')); params.push(on, on, scopeDeptIds);
  }
  const startYear = /^\d{4}/.test(String(query.year ?? '')) ? Number(String(query.year).slice(0, 4)) : null;
  const [emps] = await db.query(`SELECT e.id FROM hrms_employees e WHERE ${where.join(' AND ')} ORDER BY e.full_name, e.id LIMIT 2000`, params);
  const worlds = await loadWorlds(db, c.companyId, emps.map((e) => e.id));
  const types = new Map();
  const rows = [];
  let shownYear = null;
  for (const e of emps) {
    const w = worlds.get(e.id);
    if (!w) continue;
    const year = startYear === null ? leaveYearOf(on, w.startsMonth) : yearFromStart(startYear, w.startsMonth);
    if (!shownYear && w.effective.policy) shownYear = { key: year.key, label: year.label };
    const balances = w.effective.policy ? balancesOf(w, year) : [];
    for (const r of w.rules) if (!types.has(r.leaveTypeId)) types.set(r.leaveTypeId, { id: r.leaveTypeId, code: r.leaveTypeCode, name: r.leaveTypeName, isPaid: r.isPaid });
    rows.push({
      person: w.person,
      policy: w.effective.policy,
      year: w.effective.policy ? { key: year.key, label: year.label, from: year.from, to: year.to } : null,
      balances,
    });
  }
  return { year: shownYear ?? (startYear === null ? null : { key: String(startYear), label: String(startYear) }), leaveTypes: [...types.values()], rows };
}

/**
 * PUT /leave/balances { employeeId, leaveTypeId, yearKey, opening, note }
 * opening null clears HR's number (the route asks for leave remove first).
 * -> { balance } — the balance as it now is.
 */
export async function setOpening(conn, c, body = {}, requestId = null, { source = null, world = null, typeKnown = false } = {}) {
  const problems = [];
  const employeeId = Number(body.employeeId);
  const leaveTypeId = Number(body.leaveTypeId);
  if (!Number.isInteger(employeeId) || employeeId <= 0) problems.push('Choose the person.');
  if (!Number.isInteger(leaveTypeId) || leaveTypeId <= 0) problems.push('Choose the leave type.');
  const clearing = body.opening === null || body.opening === '';
  const opening = clearing ? null : Number(body.opening);
  if (!clearing && (!Number.isFinite(opening) || opening < -366 || opening > 366)) problems.push('The opening balance is a number of days, from -366 to 366.');
  else if (!clearing && Math.abs(opening * 100 - Math.round(opening * 100)) > 1e-6) problems.push('The opening balance has at most two decimals.');
  const note = body.note == null ? null : String(body.note).trim().slice(0, 500) || null;
  if (problems.length) throw invalid('INVALID', problems[0], { problems });
  // An Excel upload hands in the person it has already read, and a leave type it has already checked.
  const w = world && world.employee.id === employeeId ? world : await worldOf(conn, c.companyId, employeeId);
  if (!typeKnown) await leaveTypeRow(conn, c.companyId, leaveTypeId);
  // Without a policy there is no year start to check the key against: '2026' is a calendar year, '2026-27' one from April.
  const year = w.effective.policy ? yearOfKey(body.yearKey, w.startsMonth) : (yearOfKey(body.yearKey, 1) ?? yearOfKey(body.yearKey, 4));
  if (!year) {
    const sample = yearFromStart(Number(todayText().slice(0, 4)), w.startsMonth).key;
    throw invalid('INVALID', `The leave year is written like ${sample}.`);
  }
  const [[current]] = await conn.query(
    'SELECT id, opening_balance, note FROM hrms_leave_balances WHERE company_id = ? AND employee_id = ? AND leave_type_id = ? AND period_key = ? AND deleted_at IS NULL FOR UPDATE',
    [c.companyId, employeeId, leaveTypeId, year.key],
  );
  const before = current ? { opening: Number(current.opening_balance), note: current.note ?? null } : null;
  if (clearing) {
    if (current) {
      await conn.query('UPDATE hrms_leave_balances SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, current.id]);
      await audit(conn, c, 'hrms_leave_balances', current.id, 'DELETE', { ...before, employeeId, leaveTypeId, yearKey: year.key }, null, requestId);
    }
  } else if (current) {
    await conn.query('UPDATE hrms_leave_balances SET opening_balance = ?, closing_balance = ?, note = ? WHERE company_id = ? AND id = ?', [opening, opening, note, c.companyId, current.id]);
    await audit(conn, c, 'hrms_leave_balances', current.id, 'UPDATE', before, { opening, note, ...(source ? { source } : {}) }, requestId);
  } else {
    const [ins] = await conn.query(
      'INSERT INTO hrms_leave_balances (company_id, employee_id, leave_type_id, period_key, opening_balance, closing_balance, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [c.companyId, employeeId, leaveTypeId, year.key, opening, opening, note, c.userId],
    );
    await audit(conn, c, 'hrms_leave_balances', ins.insertId, 'CREATE', null, { employeeId, leaveTypeId, yearKey: year.key, opening, note, ...(source ? { source } : {}) }, requestId);
  }
  if (body.readBack === false) return null;
  const after = await worldOf(conn, c.companyId, employeeId);
  const rule = after.rules.find((r) => r.leaveTypeId === leaveTypeId);
  return { balance: rule ? balanceFor(after, rule, { year, asOf: asOfFor(year) }).balance : null, yearKey: year.key };
}

export default {
  loadPersons, loadWorlds, balancesOf, asOfFor, readAsk, checkAsk, summaryOfAsk, approverChain, employeeIdOfLogin,
  myLeave, previewMine, submitMine, cancelMine, previewForPerson, submitForPerson, cancelByHr, listRequests, requestEmployeeId,
  approvalDetail, readRequest, decide, myApprovals, balancesGrid, setOpening, raiseSystemRequest, cancelSystemRequest,
};
