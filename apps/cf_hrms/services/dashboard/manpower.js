/**
 * manpower.js — the manpower report (TM/CF_HRMS_HIRING_SPEC.md §42.2): required · filled · vacant · present ·
 * short, by org unit ("and below", each unit with its kind), by role and by shift, for any date.
 *
 * THE NUMBERS, one chair at a time (services/seatCount.js is the seat rule — a position is ONE chair):
 *   required   the live positions (not CLOSED, in date on the day)
 *   filled     a chair a live work assignment holds on the day; vacant = required − filled
 *   present    a filled chair whose person's day is PRESENT or HALF_DAY (attendance live on that day, the day
 *              not after today); otherwise the occupant is counted as on leave, absent, off (weekly off,
 *              holiday) or not punched (no day row yet)
 *   short      required − present − off: every chair with nobody in it today that should have somebody —
 *              vacant chairs, people absent, on leave or not punched. Without attendance for the day
 *              (not live, or a day still to come) present is not known: short = vacant.
 * A unit's `own` counts its own chairs; `total` counts it and everything under it.
 *
 * FIXED READS whatever the size: settings, units, shifts, positions with their occupant (one query), the
 * occupants' day rows. `loadManpower` is shared with the dashboard (dashboard.js).
 */
import ExcelJS from 'exceljs';
import { LIVE_ON } from '../positionService.js';
import { HOLDS_SEAT_SQL } from '../seatCount.js';
import { buildOrgTree } from '../orgTree.js';
import { assertUnitIds } from '../../lib/listFilters.js';
import { invalid } from '../../lib/errors.js';
import { settingsOf } from '../attendance/settings.js';
import { nowIn } from '../attendance/time.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const STATES = ['VACANT', 'PRESENT', 'LEAVE', 'ABSENT', 'OFF', 'NOT_PUNCHED', 'FILLED'];
const zero = () => ({ required: 0, filled: 0, vacant: 0, present: 0, leave: 0, absent: 0, off: 0, notPunched: 0, short: 0 });

const POSITIONS_SQL = `
  SELECT p.id, p.position_code, COALESCE(p.position_title, r.title) AS title, p.role_id, r.title AS role_title, r.role_code,
         p.department_id, p.default_shift_id, occ.employee_id, occ.n AS occupants, e.full_name, e.employee_code
    FROM hrms_positions p
    LEFT JOIN hrms_roles r ON r.company_id = p.company_id AND r.id = p.role_id
    LEFT JOIN (
      SELECT wa.position_id, MIN(wa.employee_id) AS employee_id, COUNT(*) AS n
        FROM hrms_work_assignments wa
       WHERE wa.company_id = ? AND ${HOLDS_SEAT_SQL('wa')} AND ${LIVE_ON('wa')}
       GROUP BY wa.position_id
    ) occ ON occ.position_id = p.id
    LEFT JOIN hrms_employees e ON e.company_id = p.company_id AND e.id = occ.employee_id
   WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status <> 'CLOSED' AND ${LIVE_ON('p')}`;

export const UNITS_SQL = 'SELECT id, code, name, department_type, parent_department_id, sort_order FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL';

/** "and below" sets over the units: Map<unitId, Set<unitId>>, lazily. */
export function belowOf(units) {
  const kids = new Map();
  for (const u of units) if (u.parent_department_id != null) kids.set(u.parent_department_id, [...(kids.get(u.parent_department_id) ?? []), u.id]);
  const memo = new Map();
  return (id) => {
    if (memo.has(id)) return memo.get(id);
    const out = new Set();
    const walk = [id];
    while (walk.length) { const x = walk.pop(); if (out.has(x)) continue; out.add(x); walk.push(...(kids.get(x) ?? [])); }
    memo.set(id, out);
    return out;
  };
}

/**
 * The units a login may see under a filter: Set<unitId> | null (= every unit).
 * @param rootIds  the filter's units (each with everything under it), [] = none
 * @param scopeDeptIds a department-scoped login's units (already "and below"), null = whole company
 */
export function visibleUnits(units, below, rootIds, scopeDeptIds) {
  let set = null;
  if (rootIds.length) { set = new Set(); for (const id of rootIds) for (const x of below(id)) set.add(x); }
  if (scopeDeptIds) {
    const scope = new Set(scopeDeptIds.map(Number));
    set = set ? new Set([...set].filter((x) => scope.has(x))) : scope;
  }
  return set;
}

function stateOf(p, rec, known) {
  if (!p.employee_id) return 'VACANT';
  if (!known) return 'FILLED';
  if (!rec || rec.status === 'UNKNOWN') return 'NOT_PUNCHED';
  if (rec.status === 'PRESENT' || rec.status === 'HALF_DAY' || Number(rec.present_value) > 0) return 'PRESENT';
  if (rec.status === 'LEAVE') return 'LEAVE';
  if (rec.status === 'WEEKLY_OFF' || rec.status === 'HOLIDAY') return 'OFF';
  return 'ABSENT';
}

function count(c, state) {
  c.required += 1;
  if (state === 'VACANT') c.vacant += 1; else c.filled += 1;
  if (state === 'PRESENT') c.present += 1;
  if (state === 'LEAVE') c.leave += 1;
  if (state === 'ABSENT') c.absent += 1;
  if (state === 'OFF') c.off += 1;
  if (state === 'NOT_PUNCHED') c.notPunched += 1;
}
const finish = (c, known) => ({ ...c, present: known ? c.present : null, short: known ? Math.max(0, c.required - c.present - c.off) : c.vacant });

/**
 * The chairs of a day with their state, for some units and a shift. A fixed number of reads.
 * @returns { on, today, known, live, liveFrom, units (rows), below, visible, shifts: Map, positions: [{ …, state }] }
 */
export async function loadManpower(db, companyId, { on = null, unitIds = [], shiftId = null, scopeDeptIds = null } = {}) {
  const s = await settingsOf(db, companyId);
  const today = nowIn(s.defaultTimezone).slice(0, 10);
  const date = on && DATE_RE.test(String(on)) ? String(on) : today;
  const [[units], [shifts], [positions]] = await Promise.all([
    db.query(UNITS_SQL, [companyId]),
    db.query('SELECT id, code, name FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
    db.query(POSITIONS_SQL, [companyId, date, date, companyId, date, date]),
  ]);
  const below = belowOf(units);
  const visible = visibleUnits(units, below, unitIds, scopeDeptIds);
  const shiftMap = new Map(shifts.map((x) => [x.id, x]));
  const mine = positions.filter((p) => (!visible || (p.department_id != null && visible.has(p.department_id))) && (!shiftId || Number(p.default_shift_id) === Number(shiftId)));
  const live = Boolean(s.liveFrom && s.liveFrom <= date);
  const known = live && date <= today;
  const occupantIds = [...new Set(mine.map((p) => p.employee_id).filter(Boolean))];
  const [recs] = known && occupantIds.length ? await db.query(
    'SELECT employee_id, status, present_value, source FROM hrms_attendance_records WHERE company_id = ? AND attendance_date = ? AND deleted_at IS NULL AND employee_id IN (?)',
    [companyId, date, occupantIds]) : [[]];
  const recOf = new Map(recs.map((r) => [r.employee_id, r]));
  const unitOf = new Map(units.map((u) => [u.id, u]));
  return {
    on: date, today, known, live, liveFrom: s.liveFrom, units, below, visible, shifts: shiftMap,
    positions: mine.map((p) => {
      const u = unitOf.get(p.department_id);
      const sh = shiftMap.get(p.default_shift_id);
      return {
        id: p.id, code: p.position_code ?? null, title: p.title, roleId: p.role_id, roleTitle: p.role_title ?? null, roleCode: p.role_code ?? null,
        unitId: p.department_id ?? null, unitName: u?.name ?? null, kind: u?.department_type ?? null, shiftId: p.default_shift_id ?? null, shiftName: sh?.name ?? null,
        employeeId: p.employee_id ?? null, employeeName: p.full_name ?? null, employeeCode: p.employee_code ?? null, overFilled: Number(p.occupants) > 1,
        state: stateOf(p, recOf.get(p.employee_id), known),
      };
    }),
  };
}

/** Group chairs into rows: by unit (own and "and below", in tree order), by role, by shift. Pure. */
export function groupManpower(mp) {
  const known = mp.known;
  const own = new Map();
  for (const p of mp.positions) {
    const k = p.unitId ?? 0;
    if (!own.has(k)) own.set(k, zero());
    count(own.get(k), p.state);
  }
  const tree = buildOrgTree({ units: mp.units });
  const units = [];
  for (const e of tree.units) {
    if (mp.visible && !mp.visible.has(e.id)) continue;
    const total = zero();
    for (const x of mp.below(e.id)) {
      if (mp.visible && !mp.visible.has(x)) continue;
      const o = own.get(x);
      if (o) for (const k of Object.keys(total)) total[k] += o[k];
    }
    if (!total.required) continue;
    units.push({
      id: e.id, code: e.row.code ?? null, name: e.row.name, kind: e.row.department_type ?? null, parentId: e.row.parent_department_id ?? null,
      depth: e.depth, path: e.path, own: finish(own.get(e.id) ?? zero(), known), total: finish(total, known),
    });
  }
  // Depth relative to the shallowest unit shown, so a filtered report starts at the left edge.
  const minDepth = units.length ? Math.min(...units.map((u) => u.depth)) : 0;
  for (const u of units) u.depth -= minDepth;
  const groupBy = (keyOf, labelOf) => {
    const m = new Map();
    for (const p of mp.positions) {
      const k = keyOf(p);
      if (!m.has(k)) m.set(k, { ...labelOf(p), counts: zero() });
      count(m.get(k).counts, p.state);
    }
    return [...m.values()].map((g) => ({ ...g, counts: finish(g.counts, known) }));
  };
  const roles = groupBy((p) => p.roleId ?? 0, (p) => ({ roleId: p.roleId ?? null, title: p.roleTitle ?? 'No role', code: p.roleCode }))
    .sort((a, b) => b.counts.short - a.counts.short || String(a.title).localeCompare(String(b.title)));
  const shifts = groupBy((p) => p.shiftId ?? 0, (p) => ({ shiftId: p.shiftId ?? null, name: p.shiftName ?? 'No shift', code: p.shiftId ? (mp.shifts.get(p.shiftId)?.code ?? null) : null }))
    .sort((a, b) => String(a.code ?? 'zz').localeCompare(String(b.code ?? 'zz')));
  const totals = zero();
  for (const p of mp.positions) count(totals, p.state);
  return { totals: finish(totals, known), units, roles, shifts };
}

/** GET /dashboard/manpower?date=&department=&shift= */
export async function manpowerReport(db, c, { date = null, department = null, shift = null, scopeDeptIds = null, attendance = true } = {}) {
  if (date && !DATE_RE.test(String(date))) throw invalid('INVALID', 'The date is written like 2026-10-27.');
  const unitIds = await assertUnitIds(db, c.companyId, department);
  const shiftId = shift ? Number(shift) : null;
  if (shift && !(Number.isInteger(shiftId) && shiftId > 0)) throw invalid('INVALID', 'The shift filter takes a shift.');
  const mp = await loadManpower(db, c.companyId, { on: date, unitIds, shiftId, scopeDeptIds });
  // A login without attendance view sees the chairs, not who came in.
  if (!attendance) { mp.known = false; for (const p of mp.positions) if (p.state !== 'VACANT') p.state = 'FILLED'; }
  const g = groupManpower(mp);
  const order = { VACANT: 0, NOT_PUNCHED: 1, ABSENT: 2, LEAVE: 3, OFF: 4, FILLED: 5, PRESENT: 6 };
  return {
    date: mp.on, today: mp.today, live: mp.live, liveFrom: mp.liveFrom, attendanceKnown: mp.known,
    note: mp.known ? null : (!attendance ? 'Who came in is shown with access to attendance: short = vacant.'
      : (mp.live ? 'A day still to come: who is present is not known yet, so short = vacant.' : 'Attendance is not live for this day: who is present is not known, so short = vacant.')),
    filters: { department: unitIds, shift: shiftId },
    shiftsAll: [...mp.shifts.values()].map((x) => ({ id: x.id, code: x.code, name: x.name })),
    ...g,
    positions: mp.positions.sort((a, b) => order[a.state] - order[b.state] || String(a.unitName).localeCompare(String(b.unitName)) || String(a.code).localeCompare(String(b.code), undefined, { numeric: true })),
  };
}

const STATE_WORDS = { VACANT: 'Vacant', PRESENT: 'Present', LEAVE: 'On leave', ABSENT: 'Absent', OFF: 'Day off', NOT_PUNCHED: 'Not punched', FILLED: 'Filled' };

/** GET /dashboard/manpower/workbook — the same report as Excel (four sheets). */
export async function manpowerWorkbook(db, c, query = {}) {
  const r = await manpowerReport(db, c, query);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CF HRMS';
  const head = ['Required', 'Filled', 'Vacant', 'Present', 'On leave', 'Absent', 'Not punched', 'Day off', 'Short'];
  const nums = (k) => [k.required, k.filled, k.vacant, k.present ?? '', k.leave, k.absent, k.notPunched, k.off, k.short];
  const sheet = (name, cols) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 3 }] });
    ws.addRow([`Manpower on ${r.date}${r.note ? ` — ${r.note}` : ''}`]);
    ws.getRow(1).font = { bold: true, size: 13 };
    ws.addRow(['Short = required − present − day off (without attendance for the day: the vacant chairs). A unit counts itself and everything under it.']);
    ws.addRow(cols);
    ws.getRow(3).font = { bold: true };
    return ws;
  };
  const u = sheet('By org unit', ['Kind', 'Org unit', 'Code', ...head, 'Own chairs']);
  for (const x of r.units) u.addRow([x.kind ?? '', `${'  '.repeat(x.depth)}${x.name}`, x.code ?? '', ...nums(x.total), x.own.required]);
  u.addRow(['', 'Total', '', ...nums(r.totals)]);
  u.getColumn(2).width = 36;
  const ro = sheet('By role', ['Role', 'Code', ...head]);
  for (const x of r.roles) ro.addRow([x.title, x.code ?? '', ...nums(x.counts)]);
  ro.getColumn(1).width = 34;
  const sh = sheet('By shift', ['Shift', 'Code', ...head]);
  for (const x of r.shifts) sh.addRow([x.name, x.code ?? '', ...nums(x.counts)]);
  sh.getColumn(1).width = 24;
  const ps = sheet('Positions', ['Position', 'Title', 'Role', 'Kind', 'Org unit', 'Shift', 'Person', 'Code', 'Today']);
  for (const p of r.positions) ps.addRow([p.code ?? '', p.title ?? '', p.roleTitle ?? '', p.kind ?? '', p.unitName ?? '', p.shiftName ?? '', p.employeeName ?? '', p.employeeCode ?? '', STATE_WORDS[p.state]]);
  for (const i of [2, 3, 5, 7]) ps.getColumn(i).width = 26;
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { fileName: `manpower-${r.date}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: buffer.toString('base64'), rows: r.positions.length };
}

export default { loadManpower, groupManpower, manpowerReport, manpowerWorkbook, belowOf, visibleUnits };
