/**
 * reads.js — what the attendance screens show. (TM/CF_HRMS_HIRING_SPEC.md §28.7.)
 *
 *   today(date)        the board: by department — present, late, absent, on leave, off, not punched
 *   monthGrid(month)   the muster: person × day letters, with each person's month totals
 *   musterWorkbook     the same as an Excel muster roll
 *   personMonth        one person's month: days, punches, penalties, requests, the policy (My attendance,
 *                      HR's view of a person, a manager's view of someone in their team)
 *
 * Reads only. A day with no row is "not punched" (today) or "—" (a past day not processed).
 */
import ExcelJS from 'exceljs';
import { EMPLOYEE_IN_DEPARTMENTS_SQL } from '../accessScope.js';
import { unitIdsAndBelow } from '../../lib/listFilters.js';
import { addDays, weekdayOf, WEEKDAY_NAMES } from '../leave/days.js';
import { loadPersons, loadWorlds, approverChain } from '../leave/requestService.js';
import { attendanceMonth } from './month.js';
import { settingsOf } from './settings.js';
import { loadInputs, planDay } from './process.js';
import { leaveTypeNames, sentencesOf } from './policy.js';
import { listPenalties } from './penalties.js';
import { wall, day, nowIn, monthStart, monthEnd, monthWords, MONTH_RE, minutesWords } from './time.js';

export const LETTER = { PRESENT: 'P', HALF_DAY: 'HD', ABSENT: 'A', LEAVE: 'L', WEEKLY_OFF: 'WO', HOLIDAY: 'H', UNKNOWN: '?' };
export const LEGEND = [
  { letter: 'P', words: 'Present' }, { letter: 'HD', words: 'Half day' }, { letter: 'A', words: 'Absent' }, { letter: 'L', words: 'Leave' },
  { letter: 'WO', words: 'Weekly off' }, { letter: 'H', words: 'Holiday' }, { letter: '?', words: 'Not known yet' }, { letter: '·', words: 'Not processed' },
];

const monthOrNow = (m, tz) => (MONTH_RE.test(String(m ?? '')) ? String(m) : nowIn(tz).slice(0, 7));

/**
 * The employees a list may show: everyone (null), a department scope, or some ids.
 * `departmentId`: one or more org units ("12" or "12,40"), each with everything under it (spec §34.2).
 */
export async function peopleIn(db, companyId, { scopeDeptIds = null, employeeIds = null, departmentId = null, q = null, on }) {
  const where = ["e.company_id = ?", 'e.deleted_at IS NULL', "e.employment_status <> 'EXITED'"];
  const params = [companyId];
  if (employeeIds) { if (!employeeIds.length) return []; where.push('e.id IN (?)'); params.push(employeeIds); }
  if (scopeDeptIds) { if (!scopeDeptIds.length) return []; where.push(EMPLOYEE_IN_DEPARTMENTS_SQL('e')); params.push(on, on, scopeDeptIds); }
  if (departmentId) { where.push(EMPLOYEE_IN_DEPARTMENTS_SQL('e')); params.push(on, on, await unitIdsAndBelow(db, companyId, departmentId)); }
  if (q) { where.push('(e.full_name LIKE ? OR e.employee_code LIKE ?)'); const like = `%${String(q).slice(0, 100)}%`; params.push(like, like); }
  const [rows] = await db.query(`SELECT e.id FROM hrms_employees e WHERE ${where.join(' AND ')} ORDER BY e.full_name, e.id LIMIT 3000`, params);
  return rows.map((r) => r.id);
}

/* ══ Today ══════════════════════════════════════════════════════════════════ */

export async function todayBoard(db, c, { date = null, departmentId = null, scopeDeptIds = null } = {}) {
  const s = await settingsOf(db, c.companyId);
  const now = nowIn(s.defaultTimezone);
  const on = /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? '')) ? String(date) : now.slice(0, 10);
  const ids = await peopleIn(db, c.companyId, { scopeDeptIds, departmentId, on });
  const persons = await loadPersons(db, c.companyId, ids, on);
  const [recs] = ids.length ? await db.query(
    `SELECT employee_id, status, in_time, out_time, late_mark, late_minutes, missing_punch, status_reason FROM hrms_attendance_records
      WHERE company_id = ? AND employee_id IN (?) AND deleted_at IS NULL AND attendance_date = ?`, [c.companyId, ids, on]) : [[]];
  const byId = new Map(recs.map((r) => [r.employee_id, r]));
  const { people } = ids.length ? await loadInputs(db, c.companyId, { from: on, to: on, employeeIds: ids, on }) : { people: [] };
  const planOf = new Map(people.map((p) => [p.employee.id, planDay(on, p.shift, p.holidays)]));
  const groups = new Map();
  const counts = { people: 0, present: 0, late: 0, absent: 0, leave: 0, off: 0, notPunched: 0, missing: 0 };
  for (const id of ids) {
    const person = persons.get(id);
    const r = byId.get(id);
    const plan = planOf.get(id);
    let state;
    if (!r || r.status === 'UNKNOWN') state = plan && plan.kind !== 'WORKING' ? 'OFF' : 'NOT_PUNCHED';
    else if (r.status === 'LEAVE') state = 'LEAVE';
    else if (r.status === 'ABSENT') state = 'ABSENT';
    else if (r.status === 'WEEKLY_OFF' || r.status === 'HOLIDAY') state = 'OFF';
    else if (r.status === 'HALF_DAY') state = 'HALF';
    else state = r.late_mark ? 'LATE' : 'PRESENT';
    counts.people += 1;
    if (state === 'PRESENT' || state === 'LATE' || state === 'HALF') counts.present += 1;
    if (state === 'LATE') counts.late += 1;
    if (state === 'ABSENT') counts.absent += 1;
    if (state === 'LEAVE') counts.leave += 1;
    if (state === 'OFF') counts.off += 1;
    if (state === 'NOT_PUNCHED') counts.notPunched += 1;
    if (r?.missing_punch) counts.missing += 1;
    const dept = person?.departmentName ?? 'No org unit';
    const g = groups.get(dept) ?? { department: dept, counts: { people: 0, present: 0, late: 0, absent: 0, leave: 0, off: 0, notPunched: 0 }, people: [] };
    g.counts.people += 1;
    g.counts[{ PRESENT: 'present', LATE: 'late', HALF: 'present', ABSENT: 'absent', LEAVE: 'leave', OFF: 'off', NOT_PUNCHED: 'notPunched' }[state]] += 1;
    if (state === 'LATE') g.counts.present += 1;
    g.people.push({
      person, state, status: r?.status ?? null, inTime: wall(r?.in_time), outTime: wall(r?.out_time), lateMinutes: r?.late_minutes ?? 0,
      missing: Boolean(r?.missing_punch), why: r?.status_reason ?? (plan?.kind === 'HOLIDAY' ? `${plan.holidayName} — holiday` : plan?.kind === 'WEEKLY_OFF' ? 'Weekly off' : null),
      shift: plan?.start ? `${plan.start}–${plan.end}` : null,
    });
    groups.set(dept, g);
  }
  return { date: on, now, live: Boolean(s.liveFrom && s.liveFrom <= on), liveFrom: s.liveFrom, counts, departments: [...groups.values()].sort((a, b) => a.department.localeCompare(b.department)) };
}

/* ══ Month — the muster ═════════════════════════════════════════════════════ */

export async function monthGrid(db, c, { month = null, departmentId = null, q = null, scopeDeptIds = null, employeeIds = null } = {}) {
  const s = await settingsOf(db, c.companyId);
  const m = monthOrNow(month, s.defaultTimezone);
  const from = monthStart(m);
  const to = monthEnd(m);
  const on = nowIn(s.defaultTimezone).slice(0, 10);
  const ids = await peopleIn(db, c.companyId, { scopeDeptIds, employeeIds, departmentId, q, on });
  const dates = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push({ date: d, day: Number(d.slice(8, 10)), weekday: WEEKDAY_NAMES[weekdayOf(d) - 1].slice(0, 3) });
  if (!ids.length) return { month: m, label: monthWords(m), dates, rows: [], legend: LEGEND, status: 'OPEN', live: Boolean(s.liveFrom) };
  const [[recs], persons, summary] = await Promise.all([
    db.query(
      `SELECT employee_id, attendance_date, status, late_mark, missing_punch, overtime_minutes, in_time, out_time, status_reason, source FROM hrms_attendance_records
        WHERE company_id = ? AND employee_id IN (?) AND deleted_at IS NULL AND attendance_date BETWEEN ? AND ?`, [c.companyId, ids, from, to]),
    loadPersons(db, c.companyId, ids, on),
    attendanceMonth(c.companyId, m, { db, employeeIds: ids }),
  ]);
  const cell = new Map(recs.map((r) => [`${r.employee_id}|${day(r.attendance_date)}`, r]));
  const totals = new Map(summary.people.map((p) => [p.employeeId, p]));
  // Sunday / festival duty days (spec §42.4), from the month's own summary — no read of its own.
  const dutyAt = new Map();
  for (const p of summary.people) for (const d of p.duty?.days ?? []) dutyAt.set(`${p.employeeId}|${d.date}`, d);
  const rows = ids.map((id) => ({
    person: persons.get(id),
    cells: dates.map(({ date }) => {
      const r = cell.get(`${id}|${date}`);
      if (!r) return { date, letter: '·' };
      return {
        date, letter: LETTER[r.status] ?? '?', status: r.status, late: Boolean(r.late_mark), missing: Boolean(r.missing_punch), overtime: Number(r.overtime_minutes) || 0,
        inTime: wall(r.in_time), outTime: wall(r.out_time), why: r.status_reason ?? null, source: r.source,
        duty: dutyAt.get(`${id}|${date}`) ?? null,
      };
    }),
    totals: totals.get(id) ?? null,
  }));
  return { month: m, label: monthWords(m), dates, rows, legend: LEGEND, status: summary.status, final: summary.final, live: summary.live, liveFrom: s.liveFrom };
}

/** GET /attendance/month/workbook — the muster roll. */
export async function musterWorkbook(db, c, query = {}, scopeDeptIds = null) {
  const g = await monthGrid(db, c, { ...query, scopeDeptIds });
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CF HRMS';
  const ws = wb.addWorksheet('Muster roll', { views: [{ state: 'frozen', xSplit: 3, ySplit: 3 }] });
  ws.addRow([`Muster roll — ${g.label}${g.final ? ' (closed)' : ''}`]);
  ws.getRow(1).font = { bold: true, size: 13 };
  ws.addRow(['Legend: ' + g.legend.map((l) => `${l.letter} ${l.words}`).join(' · ') + ' · + worked a weekly off / festival holiday (duty)']);
  const head = ['Code', 'Name', 'Org unit', ...g.dates.map((d) => `${d.day} ${d.weekday}`), 'Present', 'Absent (LOP)', 'Leave paid', 'Leave unpaid', 'Weekly offs', 'Holidays', 'Late marks', 'OT hours', 'Penalty LOP', 'LOP days', 'Payable days',
    'Sunday duty days', 'Sunday duty ₹', 'Festival duty days', 'Festival duty ₹', 'Festival wage days', 'Comp-off days'];
  ws.addRow(head);
  ws.getRow(3).font = { bold: true };
  for (const r of g.rows) {
    const t = r.totals ?? {};
    const du = t.duty ?? {};
    ws.addRow([r.person?.employeeCode ?? '', r.person?.name ?? '', r.person?.departmentName ?? '', ...r.cells.map((x) => (x.letter === '·' ? '' : `${x.letter}${x.late ? '*' : ''}${x.duty ? '+' : ''}`)),
      t.present ?? 0, t.absentLop ?? 0, t.leave?.paid ?? 0, t.leave?.unpaid ?? 0, t.weeklyOffs ?? 0, t.holidays ?? 0, t.lateMarks ?? 0, t.overtime?.hours ?? 0, t.penalties?.lopDays ?? 0, t.lopDays ?? 0, t.payableDays ?? 0,
      du.sunday?.days ?? 0, du.sunday?.amount ?? 0, du.festival?.days ?? 0, du.festival?.amount ?? 0, du.festival?.wageDays ?? 0, du.compOffDays ?? 0]);
  }
  ws.addRow([]);
  ws.addRow(['* a late mark · + a weekly off or festival holiday worked, paid as duty (Sunday / festival duty allowance, comp-off)']);
  ws.getColumn(1).width = 12; ws.getColumn(2).width = 26; ws.getColumn(3).width = 20;
  for (let i = 4; i < 4 + g.dates.length; i += 1) ws.getColumn(i).width = 6;
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { fileName: `muster-roll-${g.month}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: buffer.toString('base64'), rows: g.rows.length };
}

/* ══ One person's month ═════════════════════════════════════════════════════ */

export async function personMonth(db, c, employeeId, { month = null } = {}) {
  const s = await settingsOf(db, c.companyId);
  const now = nowIn(s.defaultTimezone);
  const m = monthOrNow(month, s.defaultTimezone);
  const from = monthStart(m);
  const to = monthEnd(m);
  const [[recs], [punches], [reqs], names, persons] = await Promise.all([
    db.query(`SELECT * FROM hrms_attendance_records WHERE company_id = ? AND employee_id = ? AND deleted_at IS NULL AND attendance_date BETWEEN ? AND ? ORDER BY attendance_date`, [c.companyId, employeeId, from, to]),
    db.query('SELECT punched_at, direction, method, source FROM hrms_attendance_punches WHERE company_id = ? AND employee_id = ? AND punched_at >= ? AND punched_at < ? ORDER BY punched_at',
      [c.companyId, employeeId, `${addDays(from, -1)} 00:00:00`, `${addDays(to, 2)} 00:00:00`]),
    db.query(`SELECT id, kind, attendance_date, status, permission_minutes, requested_status, requested_in_time, requested_out_time, reason, decision_note, created_at
                FROM hrms_attendance_regularizations WHERE company_id = ? AND employee_id = ? AND deleted_at IS NULL AND attendance_date BETWEEN ? AND ? ORDER BY attendance_date DESC, id DESC`,
    [c.companyId, employeeId, from, to]),
    leaveTypeNames(db, c.companyId),
    loadPersons(db, c.companyId, [employeeId]),
  ]);
  const { people } = await loadInputs(db, c.companyId, { from, to, employeeIds: [employeeId], on: now.slice(0, 10) });
  const p = people[0];
  const byDate = new Map(recs.map((r) => [day(r.attendance_date), r]));
  const summaryP = await attendanceMonth(c.companyId, m, { db, employeeIds: [employeeId] });
  const dutyAt = new Map((summaryP.people[0]?.duty?.days ?? []).map((d) => [d.date, d]));
  const punchList = punches.map((x) => ({ at: wall(x.punched_at), direction: x.direction, method: x.method, source: x.source }));
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const r = byDate.get(d);
    const plan = p ? planDay(d, p.shift, p.holidays) : null;
    days.push({
      date: d, weekday: WEEKDAY_NAMES[weekdayOf(d) - 1], letter: r ? (LETTER[r.status] ?? '?') : '·', status: r?.status ?? null,
      inTime: wall(r?.in_time), outTime: wall(r?.out_time), workedMinutes: r?.worked_minutes ?? null, lateMinutes: r?.late_minutes ?? 0, earlyMinutes: r?.early_minutes ?? 0,
      overtimeMinutes: r?.overtime_minutes ?? 0, late: Boolean(r?.late_mark), missing: Boolean(r?.missing_punch), why: r?.status_reason ?? null, source: r?.source ?? null,
      shift: plan ? (plan.start ? `${plan.start}–${plan.end}${plan.crosses ? ' (next day)' : ''}` : (plan.kind === 'WORKING' ? 'Flexible' : plan.kind === 'HOLIDAY' ? plan.holidayName : 'Weekly off')) : null,
      punches: punchList.filter((x) => (plan ? x.at >= plan.windowFrom && x.at <= plan.windowTo : x.at.startsWith(d))),
      future: d > now.slice(0, 10),
      duty: dutyAt.get(d) ?? null,
    });
  }
  const summary = summaryP;
  const penalties = await listPenalties(db, c, { month: m }, null, { employeeIds: [employeeId] });
  let approver = null;
  const w = (await loadWorlds(db, c.companyId, [employeeId])).get(employeeId);
  if (w) { const { approverId } = await approverChain(db, c.companyId, w); if (approverId) approver = (await loadPersons(db, c.companyId, [approverId])).get(approverId) ?? null; }
  // Comp-off (spec §42.4): credited to the person's EARNED_BY_WORK leave type when their leave policy has one; else HR credits it.
  const compOffDays = summary.people[0]?.duty?.compOffDays ?? 0;
  const coRule = (w?.rules ?? []).find((r) => r.accrual === 'EARNED_BY_WORK');
  const compOff = compOffDays > 0 ? {
    days: compOffDays, leaveTypeId: coRule?.leaveTypeId ?? null, leaveTypeName: coRule?.leaveTypeName ?? null,
    note: coRule ? `Credited to ${coRule.leaveTypeName ?? 'comp-off leave'} automatically.` : 'No comp-off leave in this person’s leave policy: HR credits it by hand (an opening balance).',
  } : null;
  const todayPunches = punchList.filter((x) => x.at.startsWith(now.slice(0, 10)));
  return {
    month: m, label: monthWords(m), person: persons.get(employeeId) ?? null, liveFrom: s.liveFrom, live: Boolean(s.liveFrom),
    shift: p?.shift ? { id: p.shift.id, name: p.shift.name } : null,
    policy: { line: p?.effective?.line ?? 'No attendance policy', sentences: p ? sentencesOf(p.rules, { typeNames: names }) : [], shortPermission: p?.rules?.shortPermission ?? null },
    days, summary: summary.people[0] ?? null, status: summary.status, penalties: penalties.items, compOff,
    requests: reqs.map((r) => ({
      id: r.id, kind: r.kind, date: day(r.attendance_date), status: r.status, minutes: r.permission_minutes, requestedStatus: r.requested_status,
      inTime: wall(r.requested_in_time), outTime: wall(r.requested_out_time), reason: r.reason, decisionNote: r.decision_note, submittedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    })),
    approver,
    webPunch: { enabled: s.webPunch.enabled && Boolean(s.liveFrom), needsLocation: s.webPunch.geofences.length > 0, today: todayPunches, next: todayPunches.length % 2 === 0 ? 'IN' : 'OUT' },
    lateWords: summary.people[0] ? `${summary.people[0].lateMarks} late mark${summary.people[0].lateMarks === 1 ? '' : 's'} (${minutesWords(summary.people[0].lateMinutes)} in all)` : null,
  };
}

export default { todayBoard, monthGrid, musterWorkbook, personMonth, LETTER, LEGEND };
