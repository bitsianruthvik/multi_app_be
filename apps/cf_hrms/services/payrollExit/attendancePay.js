/**
 * attendancePay.js — attendance into the month's payroll. (TM/CF_HRMS_HIRING_SPEC.md §28.6, §25.5.)
 *
 *   NOT LIVE   attendance is not live in the month (no "live from", or it starts after the month): nothing
 *              changes — LOP from approved unpaid leave, as in P1 (mode LEAVE).
 *   LIVE, CLOSED  the run reads the CLOSED month (attendance/month.js attendanceMonth: the snapshot HR signed
 *              off) — mode ATTENDANCE:
 *                LOP      = unpaid leave + absent LOP + penalty LOP (the month's `lopDays`), each on its date
 *                           (proration needs dates when a salary changes in the month): absent LOP and unpaid
 *                           leave from the day rows, a penalty LOP on its penalty date (or the nearest day with
 *                           room); days before "live from" keep LOP from unpaid leave. When the dates do not add
 *                           up to the snapshot (a day row changed since — it cannot, once closed — or a cap),
 *                           the snapshot wins: the rest is put on, or taken off, the last days, and said.
 *                OVERTIME the month's hours × the policy's multiplier × the hourly rate (the company payroll
 *                           policy's formula, default (BASIC + DA) ÷ 26 ÷ 8) — an OVERTIME earning;
 *                PENALTY  the month's penalty amounts — a deduction (ATT_PENALTY, else OTHER_DED).
 *   LIVE, OPEN calculating is refused: "Close attendance for October 2026 first." — unless HR overrides this
 *              run with a reason ("pay without attendance", hrms_pay_attendance_overrides): then LOP from
 *              unpaid leave, no overtime, no penalties (mode OVERRIDE), and the run says so.
 * The run's "changed since calculation" also watches the month's row (closed / re-opened), "live from" and
 * the override.
 */
import { attendanceMonth } from '../attendance/month.js';
import { settingsOf } from '../attendance/settings.js';
import { refuse, audit, text, stamp } from '../payroll/common.js';
import { monthBounds, addDays } from '../payroll/proration.js';

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const json = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
const day = (v) => (v ? (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10)) : null);

export async function overrideOf(db, companyId, runId) {
  const [[o]] = await db.query('SELECT o.id, o.reason, o.created_at, u.name AS by_name FROM hrms_pay_attendance_overrides o LEFT JOIN users u ON u.id = o.created_by WHERE o.company_id = ? AND o.run_id = ? AND o.deleted_at IS NULL', [companyId, runId]);
  return o ? { id: o.id, reason: o.reason, at: stamp(o.created_at), by: o.by_name ?? null } : null;
}

/** The month's attendance state for a run (no people): { live, liveFrom, status, closedAt, override, mode, message }. */
export async function attendanceState(db, companyId, month, runId = null) {
  const b = monthBounds(month);
  const s = await settingsOf(db, companyId);
  const live = Boolean(s.liveFrom && s.liveFrom <= b.to);
  const [[row]] = await db.query('SELECT status, closed_at FROM hrms_attendance_months WHERE company_id = ? AND period_month = ?', [companyId, month]);
  const status = row?.status ?? 'OPEN';
  const override = runId ? await overrideOf(db, companyId, runId) : null;
  let mode = 'LEAVE';
  let message = 'Attendance is not live: LOP from approved unpaid leave.';
  if (live && status === 'CLOSED') { mode = 'ATTENDANCE'; message = `LOP, overtime and penalties from the closed attendance of ${b.label}.`; } else if (live && override) { mode = 'OVERRIDE'; message = `Paid without attendance (${override.reason}): LOP from approved unpaid leave, no overtime, no penalties.`; } else if (live) { mode = 'REFUSE'; message = `Close attendance for ${b.label} first (Time and leave › Attendance › Close month), or pay this month without attendance, with a reason.`; }
  return { live, liveFrom: s.liveFrom, status, closedAt: stamp(row?.closed_at), override, mode, message, label: b.label };
}

/**
 * For calculateRun. Throws 409 ATTENDANCE_OPEN when live and not closed without an override.
 * @param leaveLop  Map<employeeId, [{ date, amount }]> — LOP from unpaid leave (P1's), for days before "live from"
 * @returns { state, people: Map<employeeId, { lopDates, lopDays, overtime: { minutes, hours, multiplier }, penaltyAmount, note }> | null }
 */
export async function attendanceForRun(db, companyId, month, ids, runId, leaveLop) {
  const state = await attendanceState(db, companyId, month, runId);
  if (state.mode === 'REFUSE') throw refuse('ATTENDANCE_OPEN', state.message, { month });
  if (state.mode !== 'ATTENDANCE' || !ids.length) return { state, people: null };
  const b = monthBounds(month);
  const liveFrom = state.liveFrom > b.from ? state.liveFrom : b.from;
  const m = await attendanceMonth(companyId, month, { db, employeeIds: ids });
  const snap = new Map(m.people.map((p) => [p.employeeId, p]));
  const [[records], [types], [policies], [pens]] = await Promise.all([
    db.query(`SELECT r.employee_id, r.attendance_date, r.absent_value, r.leave_value, r.policy_id, lr.leave_type_id FROM hrms_attendance_records r
                LEFT JOIN hrms_leave_requests lr ON lr.company_id = r.company_id AND lr.id = r.leave_request_id
               WHERE r.company_id = ? AND r.employee_id IN (?) AND r.deleted_at IS NULL AND r.attendance_date BETWEEN ? AND ?`, [companyId, ids, liveFrom, b.to]),
    db.query('SELECT id, is_paid FROM hrms_leave_types WHERE company_id = ?', [companyId]),
    db.query('SELECT id, rules_json FROM hrms_attendance_policies WHERE company_id = ?', [companyId]),
    db.query("SELECT employee_id, penalty_date, quantity FROM hrms_attendance_penalties WHERE company_id = ? AND employee_id IN (?) AND period_month = ? AND status = 'APPLIED' AND action = 'LOP' ORDER BY penalty_date", [companyId, ids, month]),
  ]);
  const paidType = new Map(types.map((t) => [t.id, Boolean(t.is_paid)]));
  const absentIsLop = new Map(policies.map((p) => [p.id, (json(p.rules_json) ?? {}).absentIsLop !== false]));
  const people = new Map();
  for (const id of ids) {
    const p = snap.get(id);
    const byDate = new Map();
    const add = (date, amount) => { if (amount > 0) byDate.set(date, r2((byDate.get(date) ?? 0) + amount)); };
    for (const d of (leaveLop.get(id) ?? []).filter((x) => x.date < liveFrom)) add(d.date, Number(d.amount) || 0);
    if (!p) {
      people.set(id, { lopDates: [...byDate.entries()].map(([date, amount]) => ({ date, amount })), lopDays: 0, overtime: { minutes: 0, hours: 0, multiplier: null }, penaltyAmount: 0, note: 'NOT_IN_MONTH' });
      continue;
    }
    for (const r of records.filter((x) => x.employee_id === id)) {
      const date = day(r.attendance_date);
      if (Number(r.absent_value) > 0 && (r.policy_id == null || absentIsLop.get(r.policy_id) !== false)) add(date, Number(r.absent_value));
      if (Number(r.leave_value) > 0 && r.leave_type_id && paidType.get(r.leave_type_id) === false) add(date, Number(r.leave_value));
    }
    // Penalty LOP: on its date, or the nearest later (then earlier) day of the month with room (a day is at most 1).
    const from = liveFrom;
    const to = b.to;
    for (const x of pens.filter((q) => q.employee_id === id)) {
      let left = Number(x.quantity) || 0;
      const start = day(x.penalty_date);
      const order = [];
      for (let d = start; d <= to; d = addDays(d, 1)) order.push(d);
      for (let d = addDays(start, -1); d >= from; d = addDays(d, -1)) order.push(d);
      for (const d of order) {
        if (left <= 0) break;
        const room = r2(1 - (byDate.get(d) ?? 0));
        if (room <= 0) continue;
        const t = Math.min(room, left);
        add(d, t);
        left = r2(left - t);
      }
    }
    // The snapshot's LOP of the live days wins (with the leave LOP before "live from" on top).
    const before = r2([...byDate.entries()].filter(([d]) => d < liveFrom).reduce((s, [, a]) => s + a, 0));
    const datedLive = r2([...byDate.entries()].filter(([d]) => d >= liveFrom).reduce((s, [, a]) => s + a, 0));
    let note = null;
    let diff = r2(Number(p.lopDays) - datedLive);
    if (Math.abs(diff) >= 0.01) {
      note = `The day rows give ${datedLive} LOP day(s), the closed month ${p.lopDays}: the closed month is used.`;
      const days = [];
      for (let d = to; d >= from; d = addDays(d, -1)) days.push(d);
      for (const d of days) {
        if (Math.abs(diff) < 0.01) break;
        const cur = byDate.get(d) ?? 0;
        const t = diff > 0 ? Math.min(diff, r2(1 - cur)) : -Math.min(-diff, cur);
        if (!t) continue;
        byDate.set(d, r2(cur + t));
        diff = r2(diff - t);
      }
    }
    people.set(id, {
      lopDates: [...byDate.entries()].filter(([, a]) => a > 0).sort(([x], [y]) => x.localeCompare(y)).map(([date, amount]) => ({ date, amount })),
      lopDays: r2(Number(p.lopDays) + before), overtime: p.overtime ?? { minutes: 0, hours: 0, multiplier: null }, penaltyAmount: r2(p.penalties?.amount ?? 0), note,
      parts: { unpaidLeave: p.leave?.unpaid ?? 0, absentLop: p.absentLop ?? 0, penaltyLop: p.penalties?.lopDays ?? 0 },
    });
  }
  return { state, people };
}

/** POST /payroll/runs/:id/attendance-override { reason } — pay this month without attendance. */
export async function setOverride(db, c, run, body = {}, requestId = null) {
  const reason = text(body.reason, 500);
  if (!reason || reason.length < 5) throw refuse('REASON_NEEDED', 'Say why this month is paid without attendance. The reason is kept with the run.');
  const old = await overrideOf(db, c.companyId, run.id);
  if (old) await db.query('UPDATE hrms_pay_attendance_overrides SET deleted_at = NOW() WHERE id = ?', [old.id]);
  const [ins] = await db.query('INSERT INTO hrms_pay_attendance_overrides (company_id, run_id, reason, created_by) VALUES (?, ?, ?, ?)', [c.companyId, run.id, reason, c.userId]);
  await audit(db, c, 'hrms_pay_attendance_overrides', ins.insertId, old ? 'UPDATE' : 'CREATE', old ? { reason: old.reason } : null, { runId: run.id, month: run.period_month, reason }, requestId);
  return { override: await overrideOf(db, c.companyId, run.id) };
}

export async function clearOverride(db, c, run, requestId = null) {
  const old = await overrideOf(db, c.companyId, run.id);
  if (!old) return { cleared: 0 };
  await db.query('UPDATE hrms_pay_attendance_overrides SET deleted_at = NOW() WHERE id = ?', [old.id]);
  await audit(db, c, 'hrms_pay_attendance_overrides', old.id, 'DELETE', { runId: run.id, reason: old.reason }, null, requestId);
  return { cleared: 1 };
}

export default { attendanceState, attendanceForRun, setOverride, clearOverride, overrideOf };
