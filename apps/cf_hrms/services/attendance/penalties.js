/**
 * penalties.js — what a rule costs, and taking it back. (TM/CF_HRMS_HIRING_SPEC.md §28.3.)
 *
 * A penalty is a row: person, date, rule, action, quantity / amount, status
 *   APPLIED   the action was taken
 *   WAIVED    HR or the person's manager let it go, with a reason (and its leave came back)
 *   REVERSED  the cause went away (a regularization fixed a late mark) — by re-processing
 *
 * LATE MARKS. Every `count` late marks in a month is one penalty, charged on the date of
 * the count-th mark (`source_key` LATE_MARKS:<month>:<n>). Re-processing counts the marks
 * again and RECONCILES: a block that is still there is left alone (APPLIED or WAIVED stay as
 * they are); a block that is new is applied; a REVERSED one that is back is applied again; an
 * APPLIED one that is gone is REVERSED.
 *
 * THE ACTIONS. LEAVE — a SYSTEM leave request through the §22 request service (APPROVED,
 * raised_by_system) for each leave type in order until one has room; else, with `elseLop`,
 * loss of pay; else a warning. LOP — so many days without pay (payroll reads it from the
 * month). AMOUNT — a fixed deduction. WARNING — recorded only. Waiving or reversing a LEAVE
 * penalty cancels its request, so the balance gets the day back.
 */
import { HrmsError, invalid, notFound, conflict } from '../../lib/errors.js';
import { audit } from '../peopleService.js';
import { raiseSystemRequest, cancelSystemRequest } from '../leave/requestService.js';
import { leaveTypeNames, actionWords } from './policy.js';
import { day, monthStart, monthEnd, monthWords } from './time.js';
import { spanText } from '../leave/days.js';

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const json = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };

/** The penalties a month's late marks call for: [{ key, date, dates }]. Pure. */
export function lateMarkBlocks(markDates, count, month) {
  const out = [];
  if (!count) return out;
  for (let k = 1; k * count <= markDates.length; k += 1) {
    const dates = markDates.slice((k - 1) * count, k * count);
    out.push({ key: `LATE_MARKS:${month}:${k}`, date: dates[dates.length - 1], dates, n: k });
  }
  return out;
}

/** Take the action. Returns the columns of the penalty. */
async function takeAction(conn, c, employeeId, action, { date, why, typeNames }) {
  if (!action || action.type === 'WARNING') return { action: 'WARNING', quantity: 0, amount: 0, leaveTypeId: null, leaveRequestId: null, reason: `${why}: a warning.` };
  if (action.type === 'AMOUNT') return { action: 'AMOUNT', quantity: 0, amount: Number(action.amount) || 0, leaveTypeId: null, leaveRequestId: null, reason: `${why}: ₹${Number(action.amount).toLocaleString('en-IN')} deducted.` };
  const days = Number(action.days) === 0.5 ? 0.5 : 1;
  const dayWords = days === 0.5 ? 'half a day' : 'a day';
  if (action.type === 'LOP') return { action: 'LOP', quantity: days, amount: 0, leaveTypeId: null, leaveRequestId: null, reason: `${why}: ${dayWords} without pay.` };
  const tried = [];
  for (const leaveTypeId of action.leaveTypeIds ?? []) {
    const res = await raiseSystemRequest(conn, c, employeeId, {
      leaveTypeId, from: date, to: date, halfDay: days === 0.5 ? 'FIRST' : null, reason: `${why} — taken by the attendance rules.`,
    });
    if (res.request) return { action: 'LEAVE', quantity: days, amount: 0, leaveTypeId, leaveRequestId: res.request.id, reason: `${why}: ${dayWords} of ${typeNames.get(leaveTypeId) ?? 'leave'} taken.` };
    tried.push(`${typeNames.get(leaveTypeId) ?? 'leave'}: ${res.problems?.[0] ?? 'not possible'}`);
  }
  if (action.elseLop) return { action: 'LOP', quantity: days, amount: 0, leaveTypeId: null, leaveRequestId: null, reason: `${why}: ${dayWords} without pay (no leave could be taken — ${tried.join('; ')}).` };
  return { action: 'WARNING', quantity: 0, amount: 0, leaveTypeId: null, leaveRequestId: null, reason: `${why}: a warning (no leave could be taken — ${tried.join('; ')}).` };
}

async function undoAction(conn, c, row, note) {
  if (row.leave_request_id) {
    const [[r]] = await conn.query('SELECT status FROM hrms_leave_requests WHERE company_id = ? AND id = ?', [c.companyId, row.leave_request_id]);
    if (r && r.status === 'APPROVED') await cancelSystemRequest(conn, c, row.leave_request_id, note);
  }
}

/**
 * Count the late marks of each person in each month (from the stored days) and reconcile.
 * @param people [{ employee: { id }, effective: { policy } , rules }] — from process.loadInputs
 */
export async function reconcilePenalties(conn, c, { people, months }) {
  const out = { applied: 0, reversed: 0, reapplied: 0 };
  if (!people.length || !months.length) return out;
  const ids = people.map((p) => p.employee.id);
  const lo = monthStart(months[0]);
  const hi = monthEnd(months[months.length - 1]);
  const [[marks], [existing], typeNames] = await Promise.all([
    conn.query(
      `SELECT employee_id, attendance_date FROM hrms_attendance_records
        WHERE company_id = ? AND employee_id IN (?) AND deleted_at IS NULL AND late_mark = 1 AND attendance_date BETWEEN ? AND ?
        ORDER BY employee_id, attendance_date`, [c.companyId, ids, lo, hi]),
    conn.query(
      `SELECT * FROM hrms_attendance_penalties WHERE company_id = ? AND employee_id IN (?) AND rule_key = 'LATE_MARKS' AND period_month IN (?)`,
      [c.companyId, ids, months]),
    leaveTypeNames(conn, c.companyId),
  ]);
  for (const person of people) {
    const lm = person.rules?.lateMarks ?? null;
    for (const month of months) {
      const dates = marks.filter((m) => m.employee_id === person.employee.id && day(m.attendance_date).startsWith(month)).map((m) => day(m.attendance_date));
      const want = lm ? lateMarkBlocks(dates, lm.count, month) : [];
      const rows = existing.filter((e) => e.employee_id === person.employee.id && e.period_month === month);
      const byKey = new Map(rows.map((r) => [r.source_key, r]));
      for (const b of want) {
        const why = `${lm.count} late mark${lm.count === 1 ? '' : 's'} in ${monthWords(month)} (${b.dates.map((d) => spanText(d, d)).join(', ')})`;
        const row = byKey.get(b.key);
        if (row && row.status !== 'REVERSED') {
          if (JSON.stringify(json(row.dates_json)) !== JSON.stringify(b.dates)) {
            await conn.query('UPDATE hrms_attendance_penalties SET dates_json = ? WHERE company_id = ? AND id = ?', [JSON.stringify(b.dates), c.companyId, row.id]);
          }
          continue;
        }
        const taken = await takeAction(conn, c, person.employee.id, lm.action, { date: b.date, why, typeNames });
        if (row) {
          await conn.query(
            `UPDATE hrms_attendance_penalties SET status = 'APPLIED', status_note = NULL, penalty_date = ?, action = ?, quantity = ?, amount = ?, leave_type_id = ?, leave_request_id = ?,
                    dates_json = ?, reason = ?, policy_id = ?, decided_by = NULL, decided_at = NULL WHERE company_id = ? AND id = ?`,
            [b.date, taken.action, taken.quantity, taken.amount, taken.leaveTypeId, taken.leaveRequestId, JSON.stringify(b.dates), taken.reason.slice(0, 500), person.effective?.policy?.id ?? null, c.companyId, row.id]);
          await audit(conn, c, 'hrms_attendance_penalties', row.id, 'UPDATE', { status: 'REVERSED' }, { status: 'APPLIED', ...taken }, null);
          out.reapplied += 1;
        } else {
          const [ins] = await conn.query(
            `INSERT INTO hrms_attendance_penalties (company_id, employee_id, penalty_date, period_month, rule_key, source_key, policy_id, action, quantity, amount, leave_type_id, leave_request_id, dates_json, reason, status, created_by)
             VALUES (?, ?, ?, ?, 'LATE_MARKS', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'APPLIED', ?)`,
            [c.companyId, person.employee.id, b.date, month, b.key, person.effective?.policy?.id ?? null, taken.action, taken.quantity, taken.amount, taken.leaveTypeId, taken.leaveRequestId,
              JSON.stringify(b.dates), taken.reason.slice(0, 500), c.userId ?? null]);
          await audit(conn, c, 'hrms_attendance_penalties', ins.insertId, 'CREATE', null, { employeeId: person.employee.id, key: b.key, ...taken }, null);
          out.applied += 1;
        }
      }
      const wanted = new Set(want.map((b) => b.key));
      for (const row of rows) {
        if (row.status !== 'APPLIED' || wanted.has(row.source_key)) continue;
        const note = `The cause went away: ${dates.length} late mark${dates.length === 1 ? '' : 's'} in ${monthWords(month)} now.`;
        await undoAction(conn, c, row, note);
        await conn.query("UPDATE hrms_attendance_penalties SET status = 'REVERSED', status_note = ?, decided_at = NOW(), decided_by = ? WHERE company_id = ? AND id = ?", [note, c.userId ?? null, c.companyId, row.id]);
        await audit(conn, c, 'hrms_attendance_penalties', row.id, 'UPDATE', { status: 'APPLIED' }, { status: 'REVERSED', note }, null);
        out.reversed += 1;
      }
    }
  }
  return out;
}

/* ══ reads and the waive ═══════════════════════════════════════════════════ */

const ACTION_WORDS = { LEAVE: 'Leave taken', LOP: 'Loss of pay', AMOUNT: 'Amount deducted', WARNING: 'Warning' };

export function shapePenalty(r, persons = new Map(), typeNames = new Map()) {
  return {
    id: r.id, person: persons.get(r.employee_id) ?? { employeeId: r.employee_id, name: r.full_name ?? null, employeeCode: r.employee_code ?? null },
    date: day(r.penalty_date), month: r.period_month, rule: r.rule_key, action: r.action, actionWords: ACTION_WORDS[r.action] ?? r.action,
    quantity: r2(r.quantity), amount: r2(r.amount), leaveType: r.leave_type_id ? { id: r.leave_type_id, name: typeNames.get(r.leave_type_id) ?? null } : null,
    leaveRequestId: r.leave_request_id ?? null, dates: json(r.dates_json) ?? [], reason: r.reason, status: r.status, statusNote: r.status_note ?? null,
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
  };
}

/** GET /attendance/penalties?month=&status=&q= */
export async function listPenalties(db, c, query = {}, scopeDeptIds = null, { employeeIds = null } = {}) {
  const { EMPLOYEE_IN_DEPARTMENTS_SQL } = await import('../accessScope.js');
  const where = ['p.company_id = ?'];
  const params = [c.companyId];
  if (/^\d{4}-\d{2}$/.test(String(query.month ?? ''))) { where.push('p.period_month = ?'); params.push(String(query.month)); }
  const st = String(query.status ?? '').toUpperCase();
  if (['APPLIED', 'WAIVED', 'REVERSED'].includes(st)) { where.push('p.status = ?'); params.push(st); }
  if (query.q) { where.push('(e.full_name LIKE ? OR e.employee_code LIKE ?)'); const like = `%${String(query.q).slice(0, 100)}%`; params.push(like, like); }
  if (employeeIds) { if (!employeeIds.length) return { items: [] }; where.push('p.employee_id IN (?)'); params.push(employeeIds); }
  if (scopeDeptIds) {
    if (!scopeDeptIds.length) return { items: [] };
    const on = new Date().toISOString().slice(0, 10);
    where.push(EMPLOYEE_IN_DEPARTMENTS_SQL('e')); params.push(on, on, scopeDeptIds);
  }
  const [[rows], names] = await Promise.all([
    db.query(`SELECT p.*, e.full_name, e.employee_code FROM hrms_attendance_penalties p JOIN hrms_employees e ON e.company_id = p.company_id AND e.id = p.employee_id
               WHERE ${where.join(' AND ')} ORDER BY p.penalty_date DESC, p.id DESC LIMIT 1000`, params),
    leaveTypeNames(db, c.companyId),
  ]);
  const persons = new Map(rows.map((r) => [r.employee_id, { employeeId: r.employee_id, name: r.full_name, employeeCode: r.employee_code }]));
  return { items: rows.map((r) => shapePenalty(r, persons, names)) };
}

export async function penaltyEmployeeId(db, companyId, id) {
  const [[r]] = await db.query('SELECT employee_id FROM hrms_attendance_penalties WHERE company_id = ? AND id = ?', [companyId, id]);
  return r?.employee_id ?? null;
}

/**
 * POST …/penalties/:id/waive { note } — HR (attendance edit, in scope; the route checks) or
 * the person's manager (the team route checks). Needs a reason. Its leave comes back.
 */
export async function waivePenalty(conn, c, id, body = {}, requestId = null) {
  const note = String(body.note ?? '').trim().slice(0, 500);
  if (!note) throw invalid('NOTE_NEEDED', 'Say why the penalty is waived.');
  const [[row]] = await conn.query('SELECT * FROM hrms_attendance_penalties WHERE company_id = ? AND id = ? FOR UPDATE', [c.companyId, id]);
  if (!row) throw notFound('That penalty');
  if (row.status !== 'APPLIED') throw conflict('NOT_APPLIED', `This penalty is already ${row.status.toLowerCase()}.`);
  if (c.employeeId && row.employee_id === c.employeeId) throw new HrmsError(403, 'OWN_PENALTY', 'Nobody waives their own penalty.');
  const [[m]] = await conn.query("SELECT status FROM hrms_attendance_months WHERE company_id = ? AND period_month = ?", [c.companyId, row.period_month]);
  if (m?.status === 'CLOSED') throw conflict('MONTH_CLOSED', `${monthWords(row.period_month)} is closed. The Owner re-opens it first.`);
  await undoAction(conn, c, row, `Penalty waived: ${note}`);
  await conn.query("UPDATE hrms_attendance_penalties SET status = 'WAIVED', status_note = ?, decided_by = ?, decided_at = NOW() WHERE company_id = ? AND id = ?", [note, c.userId, c.companyId, id]);
  await audit(conn, c, 'hrms_attendance_penalties', id, 'UPDATE', { status: 'APPLIED' }, { status: 'WAIVED', note }, requestId);
  const [[fresh]] = await conn.query('SELECT p.*, e.full_name, e.employee_code FROM hrms_attendance_penalties p JOIN hrms_employees e ON e.company_id = p.company_id AND e.id = p.employee_id WHERE p.company_id = ? AND p.id = ?', [c.companyId, id]);
  return { penalty: shapePenalty(fresh, new Map(), await leaveTypeNames(conn, c.companyId)) };
}

export { actionWords };
export default { lateMarkBlocks, reconcilePenalties, listPenalties, waivePenalty, shapePenalty, penaltyEmployeeId };
