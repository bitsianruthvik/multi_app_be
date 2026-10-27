/**
 * dashboard.js — the management dashboard (TM/CF_HRMS_HIRING_SPEC.md §42.1): five tiles over one month,
 * for the org units, month and shift chosen, each tile only for a login with the right behind it.
 *
 *   headcount     people on the day (the month's last day, or today in the current month) by org unit, kind,
 *                 role and shift; joiners and leavers of the month; the last six months' headcount.
 *                 Needs employees view.
 *   absenteeism   the day (present, absent, on leave, not punched, off) and the month from attendanceMonth():
 *                 absent ÷ (present + absent + leave) — the share of working days lost to absence without
 *                 leave — by day, by org unit and for the last six months. Needs attendance view.
 *   overtime      hours of the month by org unit (attendanceMonth: duty days not double-counted), the last six
 *                 months' hours (the day rows), and the cost — the OVERTIME lines of the payroll runs — only
 *                 with pay view.
 *   manpower      required · filled · vacant · present · short on the day (manpower.js, the same chairs as the
 *                 Manpower report). Needs positions view; present needs attendance view too.
 *   payroll       company cost per run (gross + reimbursements + employer contributions of the people in the
 *                 run) by org unit, and the last six months. Needs payroll view AND the named pay view.
 *
 * SCOPE. A department-scoped login sees only its org units (and below): people, chairs and pay of those.
 * The org unit filter narrows inside that. A person counts in the unit of their seat on the day.
 *
 * FIXED READS (no per-person query, whatever the size): settings, units, shifts, roles, employees with their
 * seat (one query), attendanceMonth() of the month (its own fixed reads), the day rows of the month and the
 * six months' totals (two aggregate reads), the chairs (manpower.js: three), the payroll runs, their people
 * and their overtime lines (three).
 */
import { assertUnitIds } from '../../lib/listFilters.js';
import { invalid } from '../../lib/errors.js';
import { attendanceMonth } from '../attendance/month.js';
import { settingsOf } from '../attendance/settings.js';
import { nowIn, monthStart, monthEnd, addMonths, monthWords, MONTH_RE, day } from '../attendance/time.js';
import { loadManpower, groupManpower, belowOf, visibleUnits, UNITS_SQL } from './manpower.js';

const r1 = (n) => Math.round(Number(n) * 10) / 10;
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const pct = (num, den) => (den > 0 ? r1((num * 100) / den) : null);
const TREND = 6;

/** The seat of each employee: one row per live assignment, the first in the order of process.js SEATS_SQL wins. */
const PEOPLE_SQL = `
  SELECT e.id, e.employee_code, e.full_name, e.date_of_joining, e.exit_date, e.employment_status,
         wa.id AS wa_id, wa.position_id, COALESCE(p.role_id, wa.role_id) AS role_id, COALESCE(p.department_id, wa.department_id) AS department_id,
         COALESCE(wa.default_shift_id, p.default_shift_id) AS shift_id, wa.status AS wa_status, wa.is_primary, wa.effective_from AS wa_from
    FROM hrms_employees e
    LEFT JOIN hrms_work_assignments wa ON wa.company_id = e.company_id AND wa.employee_id = e.id AND wa.deleted_at IS NULL
         AND (wa.status IN ('ACTIVE', 'SUSPENDED', 'PLANNED') OR (e.exit_date IS NOT NULL AND e.exit_date <= ?))
         AND (wa.effective_from IS NULL OR wa.effective_from <= LEAST(COALESCE(e.exit_date, ?), ?))
         AND (wa.effective_to IS NULL OR wa.effective_to >= LEAST(COALESCE(e.exit_date, ?), ?))
    LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id AND p.deleted_at IS NULL
   WHERE e.company_id = ? AND e.deleted_at IS NULL
     AND (e.date_of_joining IS NULL OR e.date_of_joining <= ?)
     AND (e.exit_date IS NULL OR e.exit_date >= ?)
   ORDER BY e.id, FIELD(wa.status, 'ACTIVE', 'SUSPENDED', 'PLANNED', 'ENDED'), wa.is_primary DESC, wa.effective_from DESC, wa.id`;

/**
 * GET /dashboard?month=&department=&shift=
 * @param rights { people, attendance, positions, pay }  what the login may see (the route works it out)
 * @param scopeDeptIds  a department-scoped login's org units, null = the whole company
 */
export async function dashboard(db, c, { month = null, department = null, shift = null, scopeDeptIds = null, rights = {} } = {}) {
  const s = await settingsOf(db, c.companyId);
  const today = nowIn(s.defaultTimezone).slice(0, 10);
  const m = month == null || month === '' ? today.slice(0, 7) : String(month);
  if (!MONTH_RE.test(m)) throw invalid('INVALID', 'The month is written like 2026-10.');
  const from = monthStart(m);
  const to = monthEnd(m);
  const on = today < to ? (today >= from ? today : from) : to;
  const months = Array.from({ length: TREND }, (_, i) => addMonths(m, i - TREND + 1));
  const trendFrom = monthStart(months[0]);
  const unitIds = await assertUnitIds(db, c.companyId, department);
  const shiftId = shift ? Number(shift) : null;
  if (shift && !(Number.isInteger(shiftId) && shiftId > 0)) throw invalid('INVALID', 'The shift filter takes a shift.');

  const [[units], [shifts], [roles], [peopleRows]] = await Promise.all([
    db.query(UNITS_SQL, [c.companyId]),
    db.query('SELECT id, code, name FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY code, id', [c.companyId]),
    db.query('SELECT id, title FROM hrms_roles WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]),
    db.query(PEOPLE_SQL, [on, on, on, on, on, c.companyId, to, trendFrom]),
  ]);
  const below = belowOf(units);
  const visible = visibleUnits(units, below, unitIds, scopeDeptIds);
  const unitOf = new Map(units.map((u) => [u.id, u]));
  const shiftOf = new Map(shifts.map((x) => [x.id, x]));
  const roleOf = new Map(roles.map((x) => [x.id, x.title]));

  // The units the tiles break down by: the selection's top units; while there is only one, its units under it —
  // with the one passed over kept as "<unit> (itself)" for the people and chairs directly in it.
  const breakdownOf = () => {
    const shown = units.filter((u) => !visible || visible.has(u.id));
    const ids = new Set(shown.map((u) => u.id));
    let level = shown.filter((u) => u.parent_department_id == null || !ids.has(u.parent_department_id)).map((u) => u.id);
    const itself = [];
    for (let i = 0; i < 6 && level.length === 1; i += 1) {
      const kids = shown.filter((u) => u.parent_department_id === level[0]).map((u) => u.id);
      if (!kids.length) break;
      itself.push(level[0]);
      level = kids;
    }
    const named = (id) => ({ id, name: unitOf.get(id)?.name ?? '—', kind: unitOf.get(id)?.department_type ?? null });
    return [
      ...itself.map((id) => ({ ...named(id), name: `${named(id).name} (itself)`, itself: true, set: new Set([id]) })),
      ...level.map((id) => ({ ...named(id), itself: false, set: below(id) })),
    ];
  };
  const breakdown = breakdownOf();

  // People with their seat (the first row of each — the query's order is the seat rule).
  const people = new Map();
  for (const r of peopleRows) if (!people.has(r.id)) people.set(r.id, r);
  const inSelection = (p) => (!visible || (p.department_id != null && visible.has(p.department_id))) && (!shiftId || Number(p.shift_id) === shiftId);
  const selected = [...people.values()].filter(inSelection);
  const selectedIds = new Set(selected.map((p) => p.id));
  const employedOn = (p, d) => (!p.date_of_joining || day(p.date_of_joining) <= d) && (!p.exit_date || day(p.exit_date) >= d);

  const out = {
    month: m, label: monthWords(m), on, today, months, live: Boolean(s.liveFrom), liveFrom: s.liveFrom,
    filters: { department: unitIds, shift: shiftId },
    shifts: shifts.map((x) => ({ id: x.id, code: x.code, name: x.name })),
    scope: scopeDeptIds ? 'UNITS' : 'COMPANY',
    breakdown: breakdown.map((b) => ({ id: b.id, name: b.name, kind: b.kind, itself: b.itself })),
    hidden: {},
  };
  const byUnit = (rows, valueOf) => breakdown.map((b) => ({ unitId: b.id, name: b.name, kind: b.kind, itself: b.itself, ...valueOf(rows.filter((x) => b.set.has(Number(x.department_id))), b) }));

  /* ── headcount ── */
  if (rights.people) {
    const now = selected.filter((p) => employedOn(p, on));
    const tally = (keyOf, labelOf) => {
      const mm = new Map();
      for (const p of now) { const k = keyOf(p); const e = mm.get(k) ?? { ...labelOf(p), count: 0 }; e.count += 1; mm.set(k, e); }
      return [...mm.values()].sort((a, b) => b.count - a.count);
    };
    const inMonth = (d) => d && day(d) >= from && day(d) <= to;
    out.headcount = {
      total: now.length,
      byUnit: byUnit(now, (rows) => ({ count: rows.length })),
      byKind: tally((p) => unitOf.get(p.department_id)?.department_type ?? '—', (p) => ({ kind: unitOf.get(p.department_id)?.department_type ?? 'No org unit' })),
      byRole: tally((p) => p.role_id ?? 0, (p) => ({ roleId: p.role_id ?? null, title: roleOf.get(p.role_id) ?? 'No role' })).slice(0, 12),
      byShift: tally((p) => p.shift_id ?? 0, (p) => ({ shiftId: p.shift_id ?? null, name: shiftOf.get(p.shift_id)?.name ?? 'No shift' })),
      joiners: selected.filter((p) => inMonth(p.date_of_joining)).map((p) => ({ employeeId: p.id, name: p.full_name, code: p.employee_code, date: day(p.date_of_joining) })),
      leavers: selected.filter((p) => inMonth(p.exit_date)).map((p) => ({ employeeId: p.id, name: p.full_name, code: p.employee_code, date: day(p.exit_date) })),
      trend: months.map((mo) => { const end = mo === m ? on : monthEnd(mo); return { month: mo, count: selected.filter((p) => employedOn(p, end)).length }; }),
    };
  } else out.hidden.headcount = 'Needs access to employees.';

  /* ── absenteeism and overtime hours (attendance) ── */
  const ids = [...selectedIds];
  if (rights.attendance) {
    const [att, [dayRows], [monthRows]] = await Promise.all([
      attendanceMonth(c.companyId, m, { db }),
      ids.length ? db.query(
        `SELECT employee_id, attendance_date, status, present_value, absent_value, leave_value FROM hrms_attendance_records
          WHERE company_id = ? AND deleted_at IS NULL AND attendance_date BETWEEN ? AND ? AND employee_id IN (?)`, [c.companyId, from, on, ids]) : [[]],
      ids.length ? db.query(
        `SELECT DATE_FORMAT(attendance_date, '%Y-%m') AS m, SUM(present_value) AS p, SUM(absent_value) AS a, SUM(leave_value) AS l, SUM(overtime_minutes) AS ot
           FROM hrms_attendance_records WHERE company_id = ? AND deleted_at IS NULL AND attendance_date BETWEEN ? AND ? AND employee_id IN (?)
          GROUP BY m`, [c.companyId, trendFrom, to, ids]) : [[]],
    ]);
    const mine = att.people.filter((p) => selectedIds.has(p.employeeId)).map((p) => ({ ...p, department_id: people.get(p.employeeId)?.department_id ?? null }));
    const rate = (rows) => {
      const a = rows.reduce((x, p) => x + Number(p.absent || 0), 0);
      const pr = rows.reduce((x, p) => x + Number(p.present || 0), 0);
      const lv = rows.reduce((x, p) => x + Number(p.leave?.paid || 0) + Number(p.leave?.unpaid || 0), 0);
      return { absentDays: r2(a), presentDays: r2(pr), leaveDays: r2(lv), rate: pct(a, a + pr + lv) };
    };
    const todayRows = dayRows.filter((r) => day(r.attendance_date) === on);
    const todayStat = { present: 0, absent: 0, leave: 0, off: 0, notPunched: 0 };
    const rowOf = new Map(todayRows.map((r) => [r.employee_id, r]));
    const employedToday = selected.filter((p) => employedOn(p, on));
    for (const p of employedToday) {
      const r = rowOf.get(p.id);
      if (!r || r.status === 'UNKNOWN') todayStat.notPunched += 1;
      else if (r.status === 'LEAVE') todayStat.leave += 1;
      else if (r.status === 'WEEKLY_OFF' || r.status === 'HOLIDAY') todayStat.off += 1;
      else if (Number(r.present_value) > 0) todayStat.present += 1;
      else todayStat.absent += 1;
    }
    const days = new Map();
    for (const r of dayRows) {
      const d = day(r.attendance_date);
      const e = days.get(d) ?? { date: d, present: 0, absent: 0, leave: 0 };
      e.present += Number(r.present_value) || 0; e.absent += Number(r.absent_value) || 0; e.leave += Number(r.leave_value) || 0;
      days.set(d, e);
    }
    const monthBy = new Map(monthRows.map((r) => [r.m, r]));
    out.absenteeism = {
      live: att.live, status: att.status,
      today: { date: on, people: employedToday.length, ...todayStat, rate: pct(todayStat.absent, todayStat.present + todayStat.absent + todayStat.leave) },
      month: rate(mine),
      byUnit: byUnit(mine, (rows) => rate(rows)),
      daily: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ date: d.date, absent: r2(d.absent), rate: pct(d.absent, d.present + d.absent + d.leave) })),
      trend: months.map((mo) => { const r = monthBy.get(mo); const a = Number(r?.a || 0); const p = Number(r?.p || 0); const l = Number(r?.l || 0); return { month: mo, rate: r ? pct(a, a + p + l) : null, absentDays: r2(a) }; }),
    };
    const otOf = (rows) => ({ hours: r2(rows.reduce((x, p) => x + Number(p.overtime?.minutes || 0), 0) / 60) });
    out.overtime = {
      month: otOf(mine),
      byUnit: byUnit(mine, (rows) => otOf(rows)),
      trend: months.map((mo) => ({ month: mo, hours: r2(Number(monthBy.get(mo)?.ot || 0) / 60), cost: null })),
      cost: null,
    };
  } else {
    out.hidden.absenteeism = 'Needs access to attendance.';
    out.hidden.overtime = 'Needs access to attendance.';
  }

  /* ── manpower ── */
  if (rights.positions) {
    const mp = await loadManpower(db, c.companyId, { on, unitIds, shiftId, scopeDeptIds });
    if (!rights.attendance) mp.known = false;
    const g = groupManpower(mp);
    const top = new Map(g.units.map((u) => [u.id, u]));
    out.manpower = {
      date: mp.on, attendanceKnown: mp.known, totals: g.totals,
      byUnit: breakdown.map((b) => ({ unitId: b.id, name: b.name, kind: b.kind, itself: b.itself, ...((b.itself ? top.get(b.id)?.own : top.get(b.id)?.total) ?? { required: 0, filled: 0, vacant: 0, present: mp.known ? 0 : null, short: 0 }) })),
      byShift: g.shifts.map((x) => ({ shiftId: x.shiftId, name: x.name, ...x.counts })),
    };
  } else out.hidden.manpower = 'Needs access to positions.';

  /* ── payroll cost and overtime cost (pay) ── */
  if (rights.pay) {
    const [runs] = await db.query(
      'SELECT id, period_month, status, people_count, gross_total, employer_total, net_total FROM hrms_pay_runs WHERE company_id = ? AND deleted_at IS NULL AND period_month BETWEEN ? AND ?',
      [c.companyId, months[0], m]);
    const runIds = runs.map((r) => r.id);
    const [[runPeople], [otLines]] = runIds.length ? await Promise.all([
      db.query('SELECT run_id, employee_id, gross, reimbursements, employer_total FROM hrms_pay_run_people WHERE company_id = ? AND run_id IN (?) AND deleted_at IS NULL AND included = 1', [c.companyId, runIds]),
      db.query(
        `SELECT l.run_id, l.employee_id, SUM(l.amount) AS amount FROM hrms_pay_run_lines l
           JOIN hrms_pay_components k ON k.company_id = l.company_id AND k.id = l.component_id AND k.code = 'OVERTIME'
          WHERE l.company_id = ? AND l.run_id IN (?) AND l.deleted_at IS NULL GROUP BY l.run_id, l.employee_id`, [c.companyId, runIds]),
    ]) : [[[]], [[]]];
    const monthOfRun = new Map(runs.map((r) => [r.id, r.period_month]));
    const cost = (x) => Number(x.gross || 0) + Number(x.reimbursements || 0) + Number(x.employer_total || 0);
    const rowsIn = runPeople.filter((x) => selectedIds.has(x.employee_id)).map((x) => ({ ...x, month: monthOfRun.get(x.run_id), department_id: people.get(x.employee_id)?.department_id ?? null }));
    const thisRun = runs.find((r) => r.period_month === m) ?? null;
    const cur = rowsIn.filter((x) => x.month === m);
    out.payroll = {
      run: thisRun ? { id: thisRun.id, status: thisRun.status, people: Number(thisRun.people_count) } : null,
      month: { cost: Math.round(cur.reduce((a, x) => a + cost(x), 0)), gross: Math.round(cur.reduce((a, x) => a + Number(x.gross || 0), 0)), people: cur.length },
      byUnit: byUnit(cur, (rows) => ({ cost: Math.round(rows.reduce((a, x) => a + cost(x), 0)), people: rows.length })),
      trend: months.map((mo) => { const rr = rowsIn.filter((x) => x.month === mo); const run = runs.find((r) => r.period_month === mo); return { month: mo, cost: run ? Math.round(rr.reduce((a, x) => a + cost(x), 0)) : null, status: run?.status ?? null }; }),
    };
    if (out.overtime) {
      const ot = otLines.filter((x) => selectedIds.has(x.employee_id)).map((x) => ({ ...x, month: monthOfRun.get(x.run_id), department_id: people.get(x.employee_id)?.department_id ?? null }));
      const sum = (rows) => Math.round(rows.reduce((a, x) => a + Number(x.amount || 0), 0));
      out.overtime.cost = thisRun ? sum(ot.filter((x) => x.month === m)) : null;
      out.overtime.trend = out.overtime.trend.map((t) => ({ ...t, cost: runs.some((r) => r.period_month === t.month) ? sum(ot.filter((x) => x.month === t.month)) : null }));
      const costBy = new Map(byUnit(ot.filter((x) => x.month === m), (rows) => ({ cost: sum(rows) })).map((x) => [x.unitId, x.cost]));
      out.overtime.byUnit = out.overtime.byUnit.map((x) => ({ ...x, cost: thisRun ? (costBy.get(x.unitId) ?? 0) : null }));
    }
  } else {
    out.hidden.payroll = 'Needs access to payroll and to pay.';
    if (out.overtime) out.overtime.costHidden = true;
  }
  // Each tile's list (the screen builds the links from these).
  out.drill = {
    headcount: 'employees', absenteeism: 'attendance?tab=today', overtime: 'attendance?tab=month', manpower: 'manpower', payroll: out.payroll?.run ? `payroll-runs/${out.payroll.run.id}` : 'payroll-runs',
  };
  return out;
}

export default { dashboard };
