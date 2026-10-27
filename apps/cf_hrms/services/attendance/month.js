/**
 * month.js — a company's attendance month, and closing it. (TM/CF_HRMS_HIRING_SPEC.md §28.6.)
 *
 * ═══ FOR PAYROLL ═══════════════════════════════════════════════════════════════════════════
 *
 *   import { attendanceMonth } from '../attendance/month.js';
 *   const m = await attendanceMonth(companyId, '2026-10', { db, employeeIds });   // db: a pool or a connection; optional
 *
 *   m = {
 *     month: '2026-10', from: '2026-10-01', to: '2026-10-31', calendarDays: 31,
 *     live: boolean,            // attendance is live for (part of) this month — else read LOP from unpaid leave as before (§25.2)
 *     liveFrom: 'YYYY-MM-DD' | null,
 *     status: 'OPEN' | 'CLOSED', closedAt: ISO | null,
 *     final: boolean,           // true = CLOSED: these are the numbers HR signed off (a snapshot, never recomputed)
 *     people: [{
 *       employeeId, employeeCode, name,
 *       daysInEmployment,       // calendar days of the month the person was employed (joining / exit)
 *       recordedDays,           // days with a row; unknownDays = daysInEmployment - (days with a known status)
 *       present,                // days present (a half day counts 0.5; on-duty counts)
 *       halfDays,               // count of HALF_DAY days
 *       absent,                 // absent days (incl. half-day absences as 0.5, and sandwich days)
 *       absentLop,              // the absent days that are loss of pay under the person's policy (absentIsLop)
 *       leave: { paid, unpaid, byType: [{ leaveTypeId, code, name, isPaid, days }] },   // approved leave days (penalties NOT included)
 *       weeklyOffs, holidays,   // days off (a sandwiched day off is absent, not here)
 *       unknownDays,
 *       overtime: { minutes, hours, multiplier },   // multiplier from the policy (null = no overtime); amount = hourly rate × hours × multiplier — payroll's sum
 *       penalties: { leaveDays, lopDays, amount, warnings },   // APPLIED penalties of the month
 *       lopDays,                // = unpaid leave + absentLop + penalties.lopDays  ← what payroll deducts
 *       payableDays,            // = daysInEmployment - lopDays
 *       ncpDays,                // = lopDays (non-contributory period, PF ECR)
 *       esiDays,                // = payableDays (days wages are paid for, ESI return)
 *       lateMarks, earlyMinutes, lateMinutes,
 *       duty: {                 // spec §42.4 — work on a weekly off / a festival holiday, by the policy's duty rules
 *         sunday:   { days, hours, amount },            // amount → SUNDAY_DUTY
 *         festival: { days, hours, amount, wageDays },  // amount + wageDays × the day's wage → FESTIVAL_DUTY (payroll's sum)
 *         compOffDays,                                  // credited to an EARNED_BY_WORK leave type (leave/balance.js)
 *         days: [{ date, kind: SUNDAY | FESTIVAL, hours, amount, wageDays, compOff }],
 *       },                      // (a month closed before 2026-10-27 has no `duty`: read it as none)
 *     }],
 *     totals: { people, present, absentLop, lopDays, overtimeMinutes, penaltyAmount, dutyAmount, dutyDays, compOffDays },
 *   }
 *
 * Payroll reads CLOSED months (final: true). Until attendance is live payroll keeps reading LOP from
 * unpaid leave (§25.2). `attendanceMonth` reads only; it never processes or writes.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * CLOSING (HR, attendance edit): processes the month one last time, stores the summary
 * (summary_json) and locks the month — nothing in it is processed, corrected or waived again.
 * RE-OPENING: the Owner only, with a reason. Both are audited.
 */
import { pool } from '../../lib/db.js';
import { HrmsError, invalid, conflict } from '../../lib/errors.js';
import { audit } from '../peopleService.js';
import { loadInputs } from './process.js';
import { settingsOf } from './settings.js';
import { MONTH_RE, monthStart, monthEnd, daysInMonth, monthWords, day, nowIn } from './time.js';
import { emptyDuty, dutyOfDay, addDuty } from './duty.js';

export { emptyDuty, dutyOfDay };

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const json = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };

/** Days of [from, to] the person was employed. */
function employedDays(from, to, joinDate, exitDate) {
  const a = joinDate && joinDate > from ? joinDate : from;
  const b = exitDate && exitDate < to ? exitDate : to;
  if (b < a) return 0;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;
}

/** The summary, computed from the stored days (not the snapshot). */
async function compute(db, companyId, month, { employeeIds = null } = {}) {
  const from = monthStart(month);
  const to = monthEnd(month);
  const settings = await settingsOf(db, companyId);
  const today = nowIn(settings.defaultTimezone).slice(0, 10);
  // The summary reads the stored days: the people and their policy are enough (no punches, no leave).
  const { people } = await loadInputs(db, companyId, { from, to, employeeIds, on: today < to ? today : to, summaryOnly: true });
  const ids = people.map((p) => p.employee.id);
  const base = { month, from, to, calendarDays: daysInMonth(month), live: Boolean(settings.liveFrom && settings.liveFrom <= to), liveFrom: settings.liveFrom };
  if (!ids.length) return { ...base, people: [], totals: { people: 0, present: 0, absentLop: 0, lopDays: 0, overtimeMinutes: 0, penaltyAmount: 0, dutyAmount: 0, dutyDays: 0, compOffDays: 0 } };
  const [[records], [penalties], [types]] = await Promise.all([
    db.query(
      `SELECT r.employee_id, r.attendance_date, r.status, r.present_value, r.leave_value, r.absent_value, r.overtime_minutes, r.late_mark, r.late_minutes, r.early_minutes,
              r.worked_minutes, r.policy_id, lr.leave_type_id
         FROM hrms_attendance_records r
         LEFT JOIN hrms_leave_requests lr ON lr.company_id = r.company_id AND lr.id = r.leave_request_id
        WHERE r.company_id = ? AND r.employee_id IN (?) AND r.deleted_at IS NULL AND r.attendance_date BETWEEN ? AND ?`, [companyId, ids, from, to]),
    db.query("SELECT employee_id, action, quantity, amount FROM hrms_attendance_penalties WHERE company_id = ? AND employee_id IN (?) AND period_month = ? AND status = 'APPLIED'", [companyId, ids, month]),
    db.query('SELECT id, code, name, is_paid FROM hrms_leave_types WHERE company_id = ?', [companyId]),
  ]);
  const typeOf = new Map(types.map((t) => [t.id, t]));
  const [policies] = await db.query('SELECT id, rules_json FROM hrms_attendance_policies WHERE company_id = ?', [companyId]);
  const rulesOf = new Map(policies.map((p) => [p.id, json(p.rules_json) ?? {}]));
  const totals = { people: 0, present: 0, absentLop: 0, lopDays: 0, overtimeMinutes: 0, penaltyAmount: 0, dutyAmount: 0, dutyDays: 0, compOffDays: 0 };
  // Grouped once by person (a filter per person over every row was people × rows).
  const group = (rows) => { const m = new Map(); for (const r of rows) { const l = m.get(r.employee_id); if (l) l.push(r); else m.set(r.employee_id, [r]); } return m; };
  const recordsBy = group(records);
  const penaltiesBy = group(penalties);
  const out = people.map((person) => {
    const id = person.employee.id;
    const mine = (recordsBy.get(id) ?? []).filter((r) => (!person.employee.joinDate || day(r.attendance_date) >= person.employee.joinDate) && (!person.employee.exitDate || day(r.attendance_date) <= person.employee.exitDate));
    const p = {
      employeeId: id, employeeCode: person.employee.code, name: person.employee.name,
      daysInEmployment: employedDays(from, to, person.employee.joinDate, person.employee.exitDate),
      recordedDays: mine.length, present: 0, halfDays: 0, absent: 0, absentLop: 0,
      leave: { paid: 0, unpaid: 0, byType: [] }, weeklyOffs: 0, holidays: 0, unknownDays: 0,
      overtime: { minutes: 0, hours: 0, multiplier: person.rules?.overtime?.rateMultiplier ?? null },
      penalties: { leaveDays: 0, lopDays: 0, amount: 0, warnings: 0 }, lopDays: 0, payableDays: 0, ncpDays: 0, esiDays: 0,
      lateMarks: 0, lateMinutes: 0, earlyMinutes: 0,
      duty: emptyDuty(),
    };
    const byType = new Map();
    let known = 0;
    for (const r of mine) {
      if (r.status !== 'UNKNOWN') known += 1;
      p.present += Number(r.present_value);
      p.absent += Number(r.absent_value);
      const rules = r.policy_id ? (rulesOf.get(r.policy_id) ?? {}) : {};
      if (rules.absentIsLop !== false) p.absentLop += Number(r.absent_value);
      if (r.status === 'HALF_DAY') p.halfDays += 1;
      if (r.status === 'WEEKLY_OFF') p.weeklyOffs += 1;
      if (r.status === 'HOLIDAY') p.holidays += 1;
      // Sunday / festival duty (spec §42.4): a day off worked, under the rule of the policy the day was processed with.
      const d = dutyOfDay(r, rules);
      if (d) addDuty(p.duty, d);
      p.overtime.minutes += d && !d.alsoOvertime ? 0 : (Number(r.overtime_minutes) || 0);
      if (r.late_mark) p.lateMarks += 1;
      p.lateMinutes += Number(r.late_minutes) || 0;
      p.earlyMinutes += Number(r.early_minutes) || 0;
      const lv = Number(r.leave_value);
      if (lv > 0) {
        const t = typeOf.get(r.leave_type_id) ?? { id: null, code: null, name: 'Leave', is_paid: 1 };
        const k = t.id ?? 0;
        const e = byType.get(k) ?? { leaveTypeId: t.id, code: t.code, name: t.name, isPaid: Boolean(t.is_paid), days: 0 };
        e.days = r2(e.days + lv);
        byType.set(k, e);
        if (t.is_paid) p.leave.paid += lv; else p.leave.unpaid += lv;
      }
    }
    for (const x of penaltiesBy.get(id) ?? []) {
      if (x.action === 'LEAVE') p.penalties.leaveDays += Number(x.quantity);
      else if (x.action === 'LOP') p.penalties.lopDays += Number(x.quantity);
      else if (x.action === 'AMOUNT') p.penalties.amount += Number(x.amount);
      else p.penalties.warnings += 1;
    }
    p.unknownDays = Math.max(0, p.daysInEmployment - known);
    p.leave.byType = [...byType.values()];
    for (const k of ['present', 'absent', 'absentLop']) p[k] = r2(p[k]);
    p.leave.paid = r2(p.leave.paid); p.leave.unpaid = r2(p.leave.unpaid);
    p.penalties.leaveDays = r2(p.penalties.leaveDays); p.penalties.lopDays = r2(p.penalties.lopDays); p.penalties.amount = r2(p.penalties.amount);
    p.overtime.hours = r2(p.overtime.minutes / 60);
    p.lopDays = r2(Math.min(p.daysInEmployment, p.leave.unpaid + p.absentLop + p.penalties.lopDays));
    p.payableDays = r2(p.daysInEmployment - p.lopDays);
    p.ncpDays = p.lopDays;
    p.esiDays = p.payableDays;
    totals.people += 1; totals.present += p.present; totals.absentLop += p.absentLop; totals.lopDays += p.lopDays;
    totals.overtimeMinutes += p.overtime.minutes; totals.penaltyAmount += p.penalties.amount;
    totals.dutyAmount += p.duty.sunday.amount + p.duty.festival.amount; totals.dutyDays += p.duty.sunday.days + p.duty.festival.days; totals.compOffDays += p.duty.compOffDays;
    return p;
  });
  for (const k of ['present', 'absentLop', 'lopDays', 'penaltyAmount', 'dutyAmount', 'compOffDays']) totals[k] = r2(totals[k]);
  return { ...base, people: out, totals };
}

async function monthRow(db, companyId, month, { lock = false } = {}) {
  const [[r]] = await db.query(`SELECT * FROM hrms_attendance_months WHERE company_id = ? AND period_month = ?${lock ? ' FOR UPDATE' : ''}`, [companyId, month]);
  return r ?? null;
}

/**
 * THE FUNCTION PAYROLL CALLS. See the shape at the top of this file.
 * @param companyId number
 * @param month 'YYYY-MM'
 * @param opts { db = pool, employeeIds = null, fresh = false }  fresh: compute even when closed (the close itself)
 */
export async function attendanceMonth(companyId, month, { db = pool, employeeIds = null, fresh = false } = {}) {
  if (!MONTH_RE.test(String(month ?? ''))) throw invalid('INVALID', 'The month is written like 2026-10.');
  const row = await monthRow(db, companyId, month);
  if (row?.status === 'CLOSED' && row.summary_json && !fresh) {
    const snap = json(row.summary_json);
    const ids = employeeIds ? new Set(employeeIds.map(Number)) : null;
    return { ...snap, people: ids ? snap.people.filter((p) => ids.has(p.employeeId)) : snap.people, status: 'CLOSED', final: true, closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null };
  }
  const m = await compute(db, companyId, month, { employeeIds });
  return { ...m, status: row?.status ?? 'OPEN', final: false, closedAt: null };
}

/** GET /attendance/months?year= — each month's state. */
export async function listMonths(db, c, { year = null } = {}) {
  const y = /^\d{4}$/.test(String(year ?? '')) ? String(year) : nowIn().slice(0, 4);
  const [rows] = await db.query(
    `SELECT m.*, cu.name AS closed_by_name, ou.name AS reopened_by_name FROM hrms_attendance_months m
       LEFT JOIN users cu ON cu.id = m.closed_by LEFT JOIN users ou ON ou.id = m.reopened_by
      WHERE m.company_id = ? AND m.period_month LIKE ?`, [c.companyId, `${y}-%`]);
  const by = new Map(rows.map((r) => [r.period_month, r]));
  const s = await settingsOf(db, c.companyId);
  const months = [];
  for (let i = 1; i <= 12; i += 1) {
    const month = `${y}-${String(i).padStart(2, '0')}`;
    const r = by.get(month);
    months.push({
      month, label: monthWords(month), status: r?.status ?? 'OPEN', live: Boolean(s.liveFrom && s.liveFrom <= monthEnd(month)),
      closedAt: r?.closed_at ? new Date(r.closed_at).toISOString() : null, closedBy: r?.closed_by_name ?? null,
      reopenedAt: r?.reopened_at ? new Date(r.reopened_at).toISOString() : null, reopenedBy: r?.reopened_by_name ?? null, reopenReason: r?.reopen_reason ?? null,
      totals: r?.summary_json ? json(r.summary_json)?.totals ?? null : null,
    });
  }
  return { year: Number(y), months };
}

/** POST /attendance/months/:month/close — process it once more, keep the summary, lock it. */
export async function closeMonth(conn, c, month, requestId = null) {
  if (!MONTH_RE.test(String(month ?? ''))) throw invalid('INVALID', 'The month is written like 2026-10.');
  const s = await settingsOf(conn, c.companyId);
  const today = nowIn(s.defaultTimezone).slice(0, 10);
  if (monthEnd(month) >= today) throw conflict('NOT_OVER', `${monthWords(month)} is not over yet. Close it once its last day has passed.`);
  if (!s.liveFrom || s.liveFrom > monthEnd(month)) throw conflict('NOT_LIVE', `Attendance was not live in ${monthWords(month)}, so there is nothing to close.`);
  const row = await monthRow(conn, c.companyId, month, { lock: true });
  if (row?.status === 'CLOSED') throw conflict('ALREADY_CLOSED', `${monthWords(month)} is closed already.`);
  const { processRange } = await import('./process.js');
  await processRange(conn, c, { from: monthStart(month), to: monthEnd(month), kind: 'MANUAL', note: `close ${month}` });
  const summary = await attendanceMonth(c.companyId, month, { db: conn, fresh: true });
  const [[pending]] = await conn.query("SELECT COUNT(*) AS n FROM hrms_attendance_regularizations WHERE company_id = ? AND status = 'PENDING' AND deleted_at IS NULL AND attendance_date BETWEEN ? AND ?",
    [c.companyId, monthStart(month), monthEnd(month)]);
  const snap = { ...summary, status: 'CLOSED', final: true };
  await conn.query(
    `INSERT INTO hrms_attendance_months (company_id, period_month, status, summary_json, closed_at, closed_by, created_by) VALUES (?, ?, 'CLOSED', ?, NOW(), ?, ?)
     ON DUPLICATE KEY UPDATE status = 'CLOSED', summary_json = VALUES(summary_json), closed_at = NOW(), closed_by = VALUES(closed_by)`,
    [c.companyId, month, JSON.stringify(snap), c.userId, c.userId]);
  const fresh = await monthRow(conn, c.companyId, month);
  await audit(conn, c, 'hrms_attendance_months', fresh.id, 'APPROVE', { status: row?.status ?? 'OPEN' }, { status: 'CLOSED', totals: summary.totals, pendingRequests: Number(pending.n) }, requestId);
  return { month: (await listMonths(conn, c, { year: month.slice(0, 4) })).months.find((m) => m.month === month), pendingRequests: Number(pending.n) };
}

/** POST /attendance/months/:month/reopen { reason } — the Owner only (the route checks). */
export async function reopenMonth(conn, c, month, body = {}, requestId = null) {
  if (!c.owner) throw new HrmsError(403, 'OWNER_ONLY', 'Only the Owner re-opens a closed month.');
  const reason = String(body.reason ?? '').trim().slice(0, 500);
  if (!reason) throw invalid('REASON_NEEDED', 'Say why the month is re-opened (payroll may already have read it).');
  const row = await monthRow(conn, c.companyId, month, { lock: true });
  if (row?.status !== 'CLOSED') throw conflict('NOT_CLOSED', `${monthWords(month)} is not closed.`);
  await conn.query("UPDATE hrms_attendance_months SET status = 'OPEN', reopened_at = NOW(), reopened_by = ?, reopen_reason = ? WHERE company_id = ? AND id = ?", [c.userId, reason, c.companyId, row.id]);
  await audit(conn, c, 'hrms_attendance_months', row.id, 'UPDATE', { status: 'CLOSED' }, { status: 'OPEN', reason }, requestId);
  return { month: (await listMonths(conn, c, { year: month.slice(0, 4) })).months.find((m) => m.month === month) };
}

export default { attendanceMonth, listMonths, closeMonth, reopenMonth, dutyOfDay, emptyDuty };
