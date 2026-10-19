/**
 * process.js — punches -> days. (TM/CF_HRMS_HIRING_SPEC.md §28.2.)
 *
 * For each person and date: their shift that day (the position's default shift — a roster
 * comes later), its window (start/end, crossing midnight), the grace and rules of their
 * ATTENDANCE POLICY, approved leave (§22, half-day aware), approved short permission and
 * on-duty -> first IN and last OUT inside the window, worked minutes, late-by, early-by,
 * overtime, a missing punch -> a status and the day's three fractions:
 *
 *   present_value + leave_value + absent_value = 1 on a working day   (0 on a day off / UNKNOWN)
 *   PRESENT · HALF_DAY · ABSENT · LEAVE · WEEKLY_OFF · HOLIDAY · UNKNOWN (no data yet)
 *   A half-day leave + a half day worked = PRESENT (0.5 + 0.5).
 *
 * RE-RUNNABLE. Any range may be processed again; the result depends only on what is stored.
 * SOURCE PRECEDENCE — a row is never overwritten by something of lower rank:
 *   REGULARIZATION (an approved request) > MANUAL (HR by hand) > IMPORT (a daily-status file)
 *   > BIOMETRIC (from punches) = SYSTEM (leave, holiday, absence by rule).
 *   Processing writes BIOMETRIC / SYSTEM rows only; it replaces an IMPORT row only to mark
 *   approved leave. A CLOSED month is never written. Nothing before "live from" is written,
 *   and nothing after today.
 *
 * Then the month's late marks are counted again and the penalties reconciled (penalties.js).
 *
 * computeDay and applySandwich are PURE (the test works them by hand); processRange reads,
 * computes and writes in a fixed number of queries per run.
 */
import { addDays, weekdayOf } from '../leave/days.js';
import { LIVE_ON } from '../positionService.js';
import { loadAttendanceIndex, resolveAttendance, RULE_DEFAULTS } from './policy.js';
import { settingsOf, closedMonths } from './settings.js';
import { wall, day, toMin, fromMin, at, hm, nowIn, utcNow, monthOf, monthsBetween, minutesWords, hoursWords } from './time.js';

/** How far before a shift's start and after its end a punch still belongs to that shift. */
export const BUFFER_BEFORE_MIN = 4 * 60;
export const BUFFER_AFTER_MIN = 8 * 60;
/** Two punches closer than this are one (a double tap on the device). */
export const SAME_PUNCH_MIN = 2;

const r2 = (n) => Math.round(Number(n) * 100) / 100;

/* ══════════════════════════════════════════════════════════════════════════
 * The plan of a day
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * What a date is for a person: working or off, the shift's hours and window.
 * @param shift    { id, graceIn, graceOut, days: Map<weekday, { isWorking, start, end, crosses, breakMinutes }> } | null
 * @param holidays Map<date, name> (full holidays only)
 */
export function planDay(date, shift, holidays = new Map()) {
  const wd = weekdayOf(date);
  const d = shift ? (shift.days.get(wd) ?? { isWorking: wd !== 7, start: null, end: null, crosses: false, breakMinutes: 0 }) : { isWorking: wd !== 7, start: null, end: null, crosses: false, breakMinutes: 0 };
  const holiday = holidays.get(date) ?? null;
  const kind = holiday ? 'HOLIDAY' : (d.isWorking ? 'WORKING' : 'WEEKLY_OFF');
  const plan = { date, kind, holidayName: holiday, shiftId: shift?.id ?? null, graceIn: shift?.graceIn ?? 0, graceOut: shift?.graceOut ?? 0, start: null, end: null, startAt: null, endAt: null, breakMinutes: 0, scheduled: null };
  if (kind === 'WORKING' && d.start && d.end) {
    const crosses = Boolean(d.crosses) || d.end <= d.start;
    plan.start = d.start.slice(0, 5);
    plan.end = d.end.slice(0, 5);
    plan.startAt = at(date, plan.start);
    plan.endAt = at(date, plan.end, crosses ? 1 : 0);
    plan.breakMinutes = Number(d.breakMinutes) || 0;
    plan.scheduled = toMin(plan.endAt) - toMin(plan.startAt) - plan.breakMinutes;
    plan.crosses = crosses;
    plan.windowFrom = fromMin(toMin(plan.startAt) - BUFFER_BEFORE_MIN);
    plan.windowTo = fromMin(Math.min(toMin(plan.endAt) + BUFFER_AFTER_MIN, toMin(plan.startAt) + 22 * 60 - 1));
  } else {
    plan.windowFrom = `${date} 00:00:00`;
    plan.windowTo = `${date} 23:59:59`;
  }
  return plan;
}

/* ══════════════════════════════════════════════════════════════════════════
 * One day (pure)
 * ══════════════════════════════════════════════════════════════════════════ */

const dedupe = (punches) => {
  const out = [];
  for (const p of punches) if (!out.length || toMin(p.at) - toMin(out[out.length - 1].at) >= SAME_PUNCH_MIN) out.push(p);
  return out;
};

/**
 * @param plan        planDay(...)
 * @param punches     [{ id, at: wall-clock, direction }] inside the plan's window, sorted
 * @param leave       { requestId, leaveTypeId, half: null | 'FIRST' | 'SECOND' } | null — approved, not raised by the system
 * @param permissionMinutes  approved short permission that day
 * @param onDuty      approved on-duty that day
 * @param rules       the person's attendance policy rules (RULE_DEFAULTS when none)
 * @param now         wall-clock now ('YYYY-MM-DD HH:MM:SS')
 * @returns the day: { status, inTime, outTime, worked, late, early, overtime, lateMark, missing, present, leave, absent, leaveRequestId, reason, source }
 */
export function computeDay({ plan, punches = [], leave = null, permissionMinutes = 0, onDuty = false, rules = RULE_DEFAULTS, now }) {
  const R = { ...RULE_DEFAULTS, ...(rules ?? {}) };
  const ps = dedupe(punches);
  const out = {
    status: 'UNKNOWN', inTime: null, outTime: null, worked: null, late: 0, early: 0, overtime: 0, lateMark: false, missing: false,
    present: 0, leave: 0, absent: 0, leaveRequestId: null, reason: null, source: ps.length ? 'BIOMETRIC' : 'SYSTEM',
  };
  const first = ps[0] ?? null;
  const last = ps.length >= 2 ? ps[ps.length - 1] : null;
  if (first) out.inTime = first.at;
  if (last) out.outTime = last.at;
  const span = first && last ? toMin(last.at) - toMin(first.at) : null;
  const today = now.slice(0, 10);
  const ot = R.overtime;

  // ── a day off ──
  if (plan.kind !== 'WORKING') {
    out.status = plan.kind;
    out.reason = plan.kind === 'HOLIDAY' ? `${plan.holidayName} — holiday` : 'Weekly off';
    if (span !== null) {
      out.worked = span;
      out.reason = `${out.reason}; worked ${minutesWords(span)}`;
      if (ot) {
        let m = span;
        if (ot.minMinutes && m < ot.minMinutes) m = 0;
        if (ot.maxMinutesPerDay) m = Math.min(m, ot.maxMinutesPerDay);
        out.overtime = m;
      }
    } else if (first) out.reason = `${out.reason}; one punch at ${hm(first.at)}`;
    return out;
  }

  // ── leave for the whole day ──
  if (leave && !leave.half) {
    Object.assign(out, { status: 'LEAVE', leave: 1, leaveRequestId: leave.requestId, reason: 'On approved leave' });
    return out;
  }
  if (leave) out.leaveRequestId = leave.requestId;
  const halfLeave = leave ? 0.5 : 0;

  // ── on duty (outdoor work, approved) ──
  if (onDuty) {
    Object.assign(out, { status: 'PRESENT', present: 1 - halfLeave, leave: halfLeave, reason: 'On duty (approved)' });
    return out;
  }

  const ended = plan.endAt ? now >= fromMin(toMin(plan.endAt) + 60) : today > plan.date;
  const started = plan.startAt ? now >= plan.startAt : today >= plan.date;

  // ── no punch ──
  if (!first) {
    if (!ended) {
      out.status = 'UNKNOWN';
      out.reason = started ? 'Not punched yet' : 'The day has not started';
      if (halfLeave) { out.leave = halfLeave; out.reason = `Half day leave; ${out.reason.toLowerCase()}`; }
      return out;
    }
    if (halfLeave) Object.assign(out, { status: 'HALF_DAY', leave: 0.5, absent: 0.5, reason: 'Half day leave; not present the other half' });
    else Object.assign(out, { status: 'ABSENT', absent: 1, reason: 'No punch and no approved leave' });
    return out;
  }

  // ── late, early ──
  const graceIn = R.graceInMinutes ?? plan.graceIn ?? 0;
  const graceOut = R.graceOutMinutes ?? plan.graceOut ?? 0;
  if (plan.startAt && leave?.half !== 'FIRST') out.late = Math.max(0, toMin(first.at) - toMin(plan.startAt));
  if (plan.endAt && last && leave?.half !== 'SECOND') out.early = Math.max(0, toMin(plan.endAt) - toMin(last.at));
  const permit = Math.max(0, Number(permissionMinutes) || 0);
  const excused = permit > 0 && out.late + out.early <= permit;
  const lateBad = out.late > graceIn;
  const earlyBad = Boolean(R.lateMarks?.includeEarlyOut) && out.early > graceOut;
  out.lateMark = !excused && (lateBad || earlyBad);

  // ── the day still running ──
  if (!last && !ended) {
    Object.assign(out, { status: 'PRESENT', present: 1 - halfLeave, leave: halfLeave, reason: `At work since ${hm(first.at)}${out.late > graceIn ? `, ${minutesWords(out.late)} late` : ''}` });
    return out;
  }

  // ── only one punch ──
  if (!last) {
    out.missing = true;
    const what = first.direction === 'OUT' ? `Only an OUT punch, at ${hm(first.at)}` : (first.direction === 'IN' ? `Only an IN punch, at ${hm(first.at)}` : `Only one punch, at ${hm(first.at)}`);
    const mp = R.missingPunch ?? { treatAs: 'ASK', askWithinDays: null };
    const share = 1 - halfLeave;
    if (mp.treatAs === 'HALF_DAY' && !halfLeave) Object.assign(out, { status: 'HALF_DAY', present: 0.5, absent: 0.5, reason: `${what} — counted as a half day` });
    else if (mp.treatAs === 'ABSENT') Object.assign(out, { status: halfLeave ? 'HALF_DAY' : 'ABSENT', absent: share, leave: halfLeave, reason: `${what} — counted as absent` });
    else {
      const by = mp.askWithinDays ? addDays(plan.date, mp.askWithinDays) : null;
      if (by && today > by) Object.assign(out, { status: halfLeave ? 'HALF_DAY' : 'ABSENT', absent: share, leave: halfLeave, reason: `${what} — not corrected by ${by}, so absent` });
      else Object.assign(out, { status: 'PRESENT', present: share, leave: halfLeave, reason: `${what} — ask for a correction${by ? ` by ${by}` : ''}` });
    }
    if (out.status !== 'PRESENT') out.lateMark = false;
    return out;
  }

  // ── a full day of punches ──
  const brk = plan.breakMinutes && plan.scheduled && span >= plan.scheduled / 2 ? plan.breakMinutes : 0;
  out.worked = Math.max(0, span - brk);
  const counted = out.worked + (excused ? Math.min(permit, out.late + out.early) : 0);
  if (halfLeave) {
    Object.assign(out, { status: 'PRESENT', present: 0.5, leave: 0.5, reason: `Half day leave + half day worked (${minutesWords(out.worked)})` });
  } else {
    const sd = R.shortDay;
    if (sd?.absentBelowHours != null && counted < sd.absentBelowHours * 60) {
      Object.assign(out, { status: 'ABSENT', absent: 1, reason: `Worked ${minutesWords(out.worked)} — under ${hoursWords(sd.absentBelowHours)} is absent` });
      out.lateMark = false;
    } else if (sd?.halfDayBelowHours != null && counted < sd.halfDayBelowHours * 60) {
      Object.assign(out, { status: 'HALF_DAY', present: 0.5, absent: 0.5, reason: `Worked ${minutesWords(out.worked)} — under ${hoursWords(sd.halfDayBelowHours)} is a half day` });
    } else {
      const parts = [`Worked ${minutesWords(out.worked)}`];
      if (out.late > graceIn) parts.push(`${minutesWords(out.late)} late`);
      if (out.early > graceOut) parts.push(`left ${minutesWords(out.early)} early`);
      if (excused && (out.late || out.early)) parts.push('excused by a short permission');
      Object.assign(out, { status: 'PRESENT', present: 1, reason: parts.join(', ') });
    }
  }
  // ── overtime ──
  if (ot && plan.scheduled && out.present > 0) {
    const beyond = out.worked - plan.scheduled;
    let m = beyond >= Math.max(1, ot.afterMinutes || 0) ? beyond : 0;
    if (ot.minMinutes && m < ot.minMinutes) m = 0;
    if (ot.maxMinutesPerDay) m = Math.min(m, ot.maxMinutesPerDay);
    out.overtime = m;
  }
  return out;
}

/**
 * Sandwich (§28.3): weekly offs and holidays with an ABSENT working day on both sides become
 * absent. `days` are one person's computed days in date order (consecutive dates).
 * Changes the days in place; returns the dates it changed.
 */
export function applySandwich(days) {
  const changed = [];
  let i = 0;
  while (i < days.length) {
    const d = days[i];
    if (!(d.result.status === 'WEEKLY_OFF' || d.result.status === 'HOLIDAY') || d.result.worked) { i += 1; continue; }
    let j = i;
    while (j + 1 < days.length && (days[j + 1].result.status === 'WEEKLY_OFF' || days[j + 1].result.status === 'HOLIDAY') && !days[j + 1].result.worked) j += 1;
    const before = days[i - 1];
    const after = days[j + 1];
    const absent = (x) => x && x.result.absent === 1 && x.result.leave === 0;
    if (absent(before) && absent(after) && days[i].rules?.sandwich) {
      for (let k = i; k <= j; k += 1) {
        days[k].result = { ...days[k].result, status: 'ABSENT', absent: 1, reason: `${days[k].result.reason} — counted as absent: between two absent days (sandwich)` };
        changed.push(days[k].date);
      }
    }
    i = j + 1;
  }
  return changed;
}

/* ══════════════════════════════════════════════════════════════════════════
 * Reading what a run needs
 * ══════════════════════════════════════════════════════════════════════════ */

const SEATS_SQL = `
  SELECT wa.employee_id, wa.position_id, COALESCE(p.role_id, wa.role_id) AS role_id, COALESCE(wa.location_id, p.location_id) AS location_id,
         COALESCE(p.department_id, wa.department_id) AS department_id, COALESCE(wa.default_shift_id, p.default_shift_id) AS shift_id
    FROM hrms_work_assignments wa
    LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id AND p.deleted_at IS NULL
   WHERE wa.company_id = ? AND wa.employee_id IN (?) AND wa.deleted_at IS NULL
     AND wa.status IN ('ACTIVE', 'SUSPENDED', 'PLANNED') AND ${LIVE_ON('wa')}
   ORDER BY wa.employee_id, FIELD(wa.status, 'ACTIVE', 'SUSPENDED', 'PLANNED'), wa.is_primary DESC, wa.effective_from DESC, wa.id`;

/** Each person's seat today: role, location, department, shift. */
export async function seatsOf(db, companyId, ids, on) {
  const out = new Map();
  if (!ids.length) return out;
  const [rows] = await db.query(SEATS_SQL, [companyId, ids, on, on]);
  for (const r of rows) if (!out.has(r.employee_id)) out.set(r.employee_id, r);
  return out;
}

/** Shifts with their seven days: Map<shiftId, shift>. */
export async function shiftsOf(db, companyId, shiftIds) {
  const out = new Map();
  if (!shiftIds.length) return out;
  const [rows] = await db.query(
    `SELECT s.id, s.name, s.code, s.grace_in_minutes, s.grace_out_minutes, s.holiday_calendar_id, d.weekday, d.is_working, d.start_time, d.end_time, d.crosses_midnight, d.break_minutes
       FROM hrms_shifts s
       LEFT JOIN hrms_shift_days d ON d.company_id = s.company_id AND d.shift_id = s.id AND d.deleted_at IS NULL
      WHERE s.company_id = ? AND s.id IN (?)`, [companyId, shiftIds]);
  for (const r of rows) {
    const s = out.get(r.id) ?? { id: r.id, name: r.name, code: r.code, graceIn: Number(r.grace_in_minutes) || 0, graceOut: Number(r.grace_out_minutes) || 0, calendarId: r.holiday_calendar_id, days: new Map() };
    if (r.weekday != null) {
      s.days.set(Number(r.weekday), {
        isWorking: Boolean(r.is_working), start: r.start_time ? String(r.start_time).slice(0, 5) : null, end: r.end_time ? String(r.end_time).slice(0, 5) : null,
        crosses: Boolean(r.crosses_midnight), breakMinutes: Number(r.break_minutes) || 0,
      });
    }
    out.set(r.id, s);
  }
  return out;
}

/** Full holidays by calendar: Map<calendarId, [{ date, name, locationId }]>. */
async function holidaysOf(db, companyId, calendarIds, from, to) {
  const out = new Map();
  if (!calendarIds.length) return out;
  const [rows] = await db.query(
    'SELECT calendar_id, location_id, holiday_date, name FROM hrms_holidays WHERE company_id = ? AND calendar_id IN (?) AND deleted_at IS NULL AND is_optional = 0 AND holiday_date BETWEEN ? AND ?',
    [companyId, calendarIds, from, to]);
  for (const r of rows) { const l = out.get(r.calendar_id) ?? []; l.push({ date: day(r.holiday_date), name: r.name, locationId: r.location_id }); out.set(r.calendar_id, l); }
  return out;
}

const byEmployee = (rows, key = 'employee_id') => { const m = new Map(); for (const r of rows) { const l = m.get(r[key]) ?? []; l.push(r); m.set(r[key], l); } return m; };

/**
 * Everything about some people for [from, to]: seats, shifts, holidays, policies, leave,
 * permissions, on-duty, punches. A fixed number of queries.
 */
export async function loadInputs(db, companyId, { from, to, employeeIds = null, on }) {
  const params = [companyId, to, from];
  let where = "e.company_id = ? AND e.deleted_at IS NULL AND (e.date_of_joining IS NULL OR e.date_of_joining <= ?) AND (e.employment_status <> 'EXITED' OR e.exit_date >= ?)";
  if (employeeIds) {
    if (!employeeIds.length) return { people: [] };
    where += ' AND e.id IN (?)'; params.push(employeeIds);
  }
  const [emps] = await db.query(`SELECT e.id, e.employee_code, e.full_name, e.date_of_joining, e.exit_date, e.employment_status FROM hrms_employees e WHERE ${where} ORDER BY e.id`, params);
  const ids = emps.map((e) => e.id);
  if (!ids.length) return { people: [] };
  const seats = await seatsOf(db, companyId, ids, on);
  const shiftIds = [...new Set([...seats.values()].map((s) => s.shift_id).filter(Boolean))];
  const fromWall = `${addDays(from, -1)} 00:00:00`;
  const toWall = `${addDays(to, 2)} 00:00:00`;
  const [shifts, index, [leaves], [regs], [punches]] = await Promise.all([
    shiftsOf(db, companyId, shiftIds),
    loadAttendanceIndex(db, companyId),
    db.query(
      `SELECT r.id, r.employee_id, r.leave_type_id, r.from_date, r.to_date, r.half_day FROM hrms_leave_requests r
        WHERE r.company_id = ? AND r.employee_id IN (?) AND r.deleted_at IS NULL AND r.status = 'APPROVED' AND r.raised_by_system = 0
          AND r.from_date <= ? AND r.to_date >= ?`, [companyId, ids, to, from]),
    db.query(
      `SELECT id, employee_id, kind, attendance_date, permission_minutes FROM hrms_attendance_regularizations
        WHERE company_id = ? AND employee_id IN (?) AND deleted_at IS NULL AND status = 'APPROVED' AND kind IN ('SHORT_PERMISSION', 'ON_DUTY')
          AND attendance_date BETWEEN ? AND ?`, [companyId, ids, from, to]),
    db.query(
      `SELECT id, employee_id, punched_at, direction FROM hrms_attendance_punches
        WHERE company_id = ? AND employee_id IN (?) AND punched_at >= ? AND punched_at < ? ORDER BY employee_id, punched_at, id`, [companyId, ids, fromWall, toWall]),
  ]);
  const calendarIds = [...new Set([...shifts.values()].map((s) => s.calendarId).filter(Boolean))];
  const holidays = await holidaysOf(db, companyId, calendarIds, addDays(from, -1), addDays(to, 1));
  const leavesBy = byEmployee(leaves);
  const regsBy = byEmployee(regs);
  const punchesBy = byEmployee(punches);
  const people = emps.map((e) => {
    const seat = seats.get(e.id) ?? null;
    const shift = seat?.shift_id ? (shifts.get(seat.shift_id) ?? null) : null;
    const hol = new Map();
    for (const h of holidays.get(shift?.calendarId) ?? []) if (h.locationId == null || h.locationId === seat?.location_id) hol.set(h.date, h.name);
    const effective = resolveAttendance(index, seat ? { roleId: seat.role_id, locationId: seat.location_id, departmentId: seat.department_id } : {});
    return {
      employee: { id: e.id, code: e.employee_code, name: e.full_name, joinDate: day(e.date_of_joining), exitDate: day(e.exit_date) },
      seat, shift, holidays: hol, effective, rules: effective.policy ? effective.policy.rules : { ...RULE_DEFAULTS },
      leaves: (leavesBy.get(e.id) ?? []).map((l) => ({ requestId: l.id, leaveTypeId: l.leave_type_id, from: day(l.from_date), to: day(l.to_date), half: l.half_day ?? null })),
      regs: regsBy.get(e.id) ?? [],
      punches: (punchesBy.get(e.id) ?? []).map((p) => ({ id: p.id, at: wall(p.punched_at), direction: p.direction })),
    };
  });
  return { people, index };
}

/** The approved leave on a date, or null. A half day applies to a one-day request only. */
export function leaveOn(person, date) {
  const l = person.leaves.find((x) => x.from <= date && x.to >= date);
  if (!l) return null;
  return { requestId: l.requestId, leaveTypeId: l.leaveTypeId, half: l.half && l.from === l.to ? l.half : null };
}

/**
 * Every day of one person for dates (ascending), each punch used by one day only.
 * @returns [{ date, plan, rules, result }]
 */
export function computePerson(person, dates, now) {
  const used = new Set();
  const out = [];
  for (const date of dates) {
    const plan = planDay(date, person.shift, person.holidays);
    const punches = person.punches.filter((p) => !used.has(p.id) && p.at >= plan.windowFrom && p.at <= plan.windowTo);
    for (const p of punches) used.add(p.id);
    const regs = person.regs.filter((r) => day(r.attendance_date) === date);
    const permissionMinutes = regs.filter((r) => r.kind === 'SHORT_PERMISSION').reduce((s, r) => s + (Number(r.permission_minutes) || 0), 0);
    const onDuty = regs.some((r) => r.kind === 'ON_DUTY');
    const result = computeDay({ plan, punches, leave: plan.kind === 'WORKING' ? leaveOn(person, date) : null, permissionMinutes, onDuty, rules: person.rules, now });
    out.push({ date, plan, rules: person.rules, result, punchIds: punches.map((p) => p.id) });
  }
  applySandwich(out);
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * A run
 * ══════════════════════════════════════════════════════════════════════════ */

const KEEP = new Set(['MANUAL', 'REGULARIZATION']);
const COLS = ['id', 'company_id', 'employee_id', 'attendance_date', 'shift_id', 'status', 'in_time', 'out_time', 'worked_minutes', 'late_minutes', 'early_minutes',
  'overtime_minutes', 'late_mark', 'missing_punch', 'present_value', 'leave_value', 'absent_value', 'leave_request_id', 'policy_id', 'status_reason', 'source', 'processed_at', 'created_by'];

/**
 * Process [from, to] for some people (null = everyone). Re-runnable.
 * @param c { companyId, userId }
 * @returns { from, to, people, daysWritten, kept, skipped: { notLive, closedMonths, future }, penalties }
 */
export async function processRange(conn, c, { from, to, employeeIds = null, kind = 'MANUAL', note = null, now = null } = {}) {
  const companyId = c.companyId;
  const settings = await settingsOf(conn, companyId);
  const nowLocal = now ?? nowIn(settings.defaultTimezone);
  const today = nowLocal.slice(0, 10);
  const report = { from, to, people: 0, daysWritten: 0, kept: 0, skipped: { notLive: false, closedMonths: [], future: false }, penalties: { applied: 0, reversed: 0, reapplied: 0 } };
  if (!settings.liveFrom) { report.skipped.notLive = true; return report; }
  let lo = from < settings.liveFrom ? settings.liveFrom : from;
  let hi = to > today ? today : to;
  if (to > today) report.skipped.future = true;
  if (hi < lo) return report;
  const closed = await closedMonths(conn, companyId);
  report.skipped.closedMonths = monthsBetween(lo, hi).filter((m) => closed.has(m));

  // Computed over a wider range than written, so the sandwich sees the days around the edges.
  const extFrom = (() => { const x = addDays(lo, -10); return x < settings.liveFrom ? settings.liveFrom : x; })();
  const extTo = (() => { const x = addDays(hi, 10); return x > today ? today : x; })();
  const { people } = await loadInputs(conn, companyId, { from: extFrom, to: extTo, employeeIds, on: today });
  if (!people.length) return report;
  const ids = people.map((p) => p.employee.id);
  const [existing] = await conn.query(
    `SELECT id, employee_id, attendance_date, source FROM hrms_attendance_records
      WHERE company_id = ? AND employee_id IN (?) AND deleted_at IS NULL AND attendance_date BETWEEN ? AND ?`, [companyId, ids, lo, hi]);
  const have = new Map(existing.map((r) => [`${r.employee_id}|${day(r.attendance_date)}`, r]));

  const startedAt = utcNow();
  const [run] = await conn.query(
    'INSERT INTO hrms_attendance_runs (company_id, kind, from_date, to_date, started_at, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [companyId, kind, lo, hi, startedAt, note ? String(note).slice(0, 500) : null, c.userId ?? null]);

  const rows = [];
  const processedAt = utcNow();
  for (const person of people) {
    const dates = [];
    for (let d = extFrom; d <= extTo; d = addDays(d, 1)) dates.push(d);
    const days = computePerson(person, dates, nowLocal);
    let any = false;
    for (const d of days) {
      if (d.date < lo || d.date > hi) continue;
      if (closed.has(monthOf(d.date))) continue;
      if (person.employee.joinDate && d.date < person.employee.joinDate) continue;
      if (person.employee.exitDate && d.date > person.employee.exitDate) continue;
      const old = have.get(`${person.employee.id}|${d.date}`);
      if (old && (KEEP.has(old.source) || (old.source === 'IMPORT' && d.result.status !== 'LEAVE'))) { report.kept += 1; continue; }
      const x = d.result;
      rows.push([
        old?.id ?? null, companyId, person.employee.id, d.date, person.shift?.id ?? null, x.status, x.inTime, x.outTime, x.worked, x.late, x.early, x.overtime,
        x.lateMark ? 1 : 0, x.missing ? 1 : 0, r2(x.present), r2(x.leave), r2(x.absent), x.leaveRequestId, person.effective.policy?.id ?? null,
        x.reason ? String(x.reason).slice(0, 300) : null, x.source, processedAt, c.userId ?? null,
      ]);
      any = true;
    }
    if (any) report.people += 1;
  }
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    await conn.query(
      `INSERT INTO hrms_attendance_records (${COLS.join(', ')}) VALUES ${chunk.map(() => `(${COLS.map(() => '?').join(', ')})`).join(', ')}
       ON DUPLICATE KEY UPDATE ${COLS.filter((k) => !['id', 'company_id', 'employee_id', 'attendance_date', 'created_by'].includes(k)).map((k) => `${k} = VALUES(${k})`).join(', ')}`,
      chunk.flat());
  }
  report.daysWritten = rows.length;

  // Late marks counted again for every month touched, and the penalties reconciled.
  const { reconcilePenalties } = await import('./penalties.js');
  const months = monthsBetween(lo, hi).filter((m) => !closed.has(m));
  const pen = await reconcilePenalties(conn, c, { people, months, today });
  report.penalties = pen;
  await conn.query('UPDATE hrms_attendance_runs SET finished_at = ?, days_written = ? WHERE company_id = ? AND id = ?', [utcNow(), rows.length, companyId, run.insertId]);
  return report;
}

/** After a punch batch, a leave decision or a request: process the dates touched for some people. Never throws for "not live". */
export async function reprocess(conn, c, employeeIds, from, to, kind = 'BATCH') {
  if (!employeeIds.length || !from || !to) return null;
  return processRange(conn, c, { from, to, employeeIds: [...new Set(employeeIds.map(Number))], kind });
}

export default { planDay, computeDay, applySandwich, computePerson, loadInputs, processRange, reprocess, leaveOn, seatsOf, shiftsOf };
