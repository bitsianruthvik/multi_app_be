/**
 * requests.js — asking to correct attendance, and deciding it. (TM/CF_HRMS_HIRING_SPEC.md §28.5.)
 *
 * Three kinds, one table (hrms_attendance_regularizations, init.sql §7d + §28b):
 *   CORRECTION        a day: mark it present / a half day, or fix the in / out time
 *   SHORT_PERMISSION  up to the policy's minutes, so many times a month; it excuses a late
 *                     arrival or an early exit on that day
 *   ON_DUTY           outdoor work / on duty: the day is present
 * A request is against the day's attendance row (one is made, UNKNOWN, when there is none yet).
 *
 * WHO DECIDES — exactly like leave (§22.4): the person in the chair their main position reports
 * to (vacant -> the next chair up; nobody -> HR), anybody above that approver, or a login with
 * attendance EDIT inside its department scope. Nobody decides their own.
 * APPROVING is the only path that edits a day after the fact: a CORRECTION writes the day with
 * source REGULARIZATION (processing never overwrites it); a permission or an on-duty is read by
 * processing. Either way the day is processed again and the month's late marks recounted — a
 * penalty the request removes the cause of is REVERSED (penalties.js).
 */
import { HrmsError, invalid, notFound, conflict } from '../../lib/errors.js';
import { audit } from '../peopleService.js';
import { loadWorlds, loadPersons, approverChain, employeeIdOfLogin } from '../leave/requestService.js';
import { EMPLOYEE_IN_DEPARTMENTS_SQL } from '../accessScope.js';
import { addDays, dayText, isDate } from '../leave/days.js';
import { settingsOf } from './settings.js';
import { loadInputs, planDay, computeDay, processRange } from './process.js';
import { leaveTypeNames, sentencesOf } from './policy.js';
import { wall, day, nowIn, hm, at, toMin, monthOf, monthStart, monthEnd, monthWords, minutesWords } from './time.js';

export const KINDS = ['CORRECTION', 'SHORT_PERMISSION', 'ON_DUTY'];
const KIND_WORDS = { CORRECTION: 'Correct a day', SHORT_PERMISSION: 'Short permission', ON_DUTY: 'On duty' };
const STATUS_WORDS = { PENDING: 'waiting for approval', APPROVED: 'approved', REJECTED: 'rejected', CANCELLED: 'cancelled' };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const iso = (v) => (v == null ? null : new Date(v).toISOString());

/* ══ reading a request ═════════════════════════════════════════════════════ */

export function readAsk(body = {}) {
  const problems = [];
  const kind = String(body.kind ?? 'CORRECTION').toUpperCase();
  if (!KINDS.includes(kind)) problems.push('Choose: correct a day, short permission, or on duty.');
  const date = String(body.date ?? '').slice(0, 10);
  if (!isDate(date)) problems.push('Choose the date.');
  const reason = String(body.reason ?? '').trim().slice(0, 2000);
  if (!reason) problems.push('Write the reason.');
  const out = { kind, date, reason, status: null, inTime: null, outTime: null, minutes: null };
  if (kind === 'CORRECTION') {
    const st = body.status == null || body.status === '' ? null : String(body.status).toUpperCase();
    if (st !== null && !['PRESENT', 'HALF_DAY'].includes(st)) problems.push('A correction marks the day present or a half day.');
    out.status = st;
    for (const k of ['inTime', 'outTime']) {
      const v = body[k] == null || body[k] === '' ? null : String(body[k]).slice(0, 5);
      if (v !== null && !HHMM.test(v)) problems.push(`The ${k === 'inTime' ? 'in' : 'out'} time is HH:MM.`);
      out[k] = v;
    }
    if (!out.status && !out.inTime && !out.outTime) problems.push('Say what to correct: the in time, the out time, or mark the day present.');
  }
  if (kind === 'SHORT_PERMISSION') {
    const m = Number(body.minutes);
    if (!Number.isInteger(m) || m < 5 || m > 480) problems.push('A short permission is a number of minutes (5 to 480).');
    out.minutes = Number.isInteger(m) ? m : null;
  }
  if (problems.length) throw invalid('INVALID', problems[0], { problems });
  return out;
}

const SELECT = `
  SELECT g.*, e.full_name, e.employee_code, u.name AS decided_by_name
    FROM hrms_attendance_regularizations g
    JOIN hrms_employees e ON e.company_id = g.company_id AND e.id = g.employee_id
    LEFT JOIN users u ON u.id = g.decided_by
   WHERE g.company_id = ? AND g.deleted_at IS NULL`;

function titleOf(r) {
  if (r.kind === 'SHORT_PERMISSION') return `Short permission · ${minutesWords(r.permission_minutes)}`;
  if (r.kind === 'ON_DUTY') return 'On duty';
  const parts = [];
  if (r.requested_status) parts.push(r.requested_status === 'HALF_DAY' ? 'half day' : 'present');
  if (r.requested_in_time) parts.push(`in ${hm(wall(r.requested_in_time))}`);
  if (r.requested_out_time) parts.push(`out ${hm(wall(r.requested_out_time))}`);
  return `Correct a day · ${parts.join(', ')}`;
}

function shape(r, persons, can = { approve: false, reject: false, cancel: false }) {
  return {
    id: r.id, kind: r.kind, kindWords: KIND_WORDS[r.kind] ?? r.kind, title: titleOf(r),
    person: persons.get(r.employee_id) ?? { employeeId: r.employee_id, name: r.full_name, employeeCode: r.employee_code, positionTitle: null, departmentName: null },
    date: day(r.attendance_date), requestedStatus: r.requested_status ?? null,
    inTime: r.requested_in_time ? wall(r.requested_in_time) : null, outTime: r.requested_out_time ? wall(r.requested_out_time) : null,
    minutes: r.permission_minutes ?? null, reason: r.reason, status: r.status,
    approver: r.approver_employee_id ? (persons.get(r.approver_employee_id) ?? null) : null,
    submittedAt: iso(r.created_at), decidedAt: r.reviewed_at ? iso(r.reviewed_at) : null, decidedBy: r.decided_by_name ?? null,
    decisionNote: r.decision_note ?? null, raisedByHr: Boolean(r.raised_by_hr), can,
  };
}

/* ══ submit ════════════════════════════════════════════════════════════════ */

/** The day's attendance row, made UNKNOWN when there is none (a request hangs off a row). */
async function recordFor(conn, companyId, employeeId, date, userId) {
  const [[r]] = await conn.query('SELECT id FROM hrms_attendance_records WHERE company_id = ? AND employee_id = ? AND attendance_date = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [companyId, employeeId, date]);
  if (r) return r.id;
  const [ins] = await conn.query("INSERT INTO hrms_attendance_records (company_id, employee_id, attendance_date, status, source, status_reason, created_by) VALUES (?, ?, ?, 'UNKNOWN', 'SYSTEM', 'A request was made for this day', ?)",
    [companyId, employeeId, date, userId ?? null]);
  return ins.insertId;
}

/** Every refusal of an ask, in words (empty = it may be sent). */
async function problemsOf(conn, companyId, employeeId, ask, { excludeId = null } = {}) {
  const s = await settingsOf(conn, companyId);
  const out = [];
  const today = nowIn(s.defaultTimezone).slice(0, 10);
  if (!s.liveFrom) return ['Attendance is not live yet, so there is nothing to correct.'];
  if (ask.date < s.liveFrom) out.push(`Attendance is recorded from ${dayText(s.liveFrom, true)}. This date is before it.`);
  if (ask.kind === 'CORRECTION' && ask.date > today) out.push('A day can be corrected once it has come.');
  if (ask.kind !== 'CORRECTION' && ask.date > addDays(today, 31)) out.push('Ask at most a month ahead.');
  const [[m]] = await conn.query("SELECT status FROM hrms_attendance_months WHERE company_id = ? AND period_month = ?", [companyId, monthOf(ask.date)]);
  if (m?.status === 'CLOSED') out.push(`${monthWords(monthOf(ask.date))} is closed for payroll. Ask HR.`);
  const [[dup]] = await conn.query("SELECT id FROM hrms_attendance_regularizations WHERE company_id = ? AND employee_id = ? AND attendance_date = ? AND kind = ? AND status = 'PENDING' AND deleted_at IS NULL AND (? IS NULL OR id <> ?)",
    [companyId, employeeId, ask.date, ask.kind, excludeId, excludeId]);
  if (dup) out.push(`There is already a ${KIND_WORDS[ask.kind].toLowerCase()} request for ${dayText(ask.date, true)} waiting for approval.`);
  if (ask.kind === 'SHORT_PERMISSION') {
    const { people } = await loadInputs(conn, companyId, { from: ask.date, to: ask.date, employeeIds: [employeeId], on: today });
    const sp = people[0]?.rules?.shortPermission;
    if (!sp) out.push('Your attendance policy has no short permission.');
    else {
      if (ask.minutes > sp.maxMinutes) out.push(`A short permission is at most ${minutesWords(sp.maxMinutes)}.`);
      const [[n]] = await conn.query(
        `SELECT COUNT(*) AS n FROM hrms_attendance_regularizations WHERE company_id = ? AND employee_id = ? AND kind = 'SHORT_PERMISSION' AND status IN ('PENDING', 'APPROVED')
          AND deleted_at IS NULL AND attendance_date BETWEEN ? AND ? AND (? IS NULL OR id <> ?)`,
        [companyId, employeeId, monthStart(monthOf(ask.date)), monthEnd(monthOf(ask.date)), excludeId, excludeId]);
      if (Number(n.n) >= sp.perMonth) out.push(`Short permission is ${sp.perMonth === 1 ? 'once' : `${sp.perMonth} times`} a month, and ${monthWords(monthOf(ask.date))}'s is used.`);
    }
  }
  return out;
}

/** The requested in / out as wall-clock times on the day's shift (an out before the in is the next day). */
function wallTimes(ask, plan) {
  const inAt = ask.inTime ? at(ask.date, ask.inTime) : null;
  let outAt = ask.outTime ? at(ask.date, ask.outTime) : null;
  const ref = inAt ?? plan.startAt;
  if (outAt && ref && outAt <= ref) outAt = at(ask.date, ask.outTime, 1);
  return { inAt, outAt };
}

export async function submitFor(conn, c, employeeId, body = {}, { raisedByHr = false, requestId = null } = {}) {
  const ask = readAsk(body);
  await conn.query('SELECT id FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, employeeId]);
  const problems = await problemsOf(conn, c.companyId, employeeId, ask);
  if (problems.length) throw invalid('INVALID', problems[0], { problems });
  const w = (await loadWorlds(conn, c.companyId, [employeeId])).get(employeeId);
  if (!w) throw notFound('That employee');
  const { approverId } = await approverChain(conn, c.companyId, w);
  const recordId = await recordFor(conn, c.companyId, employeeId, ask.date, c.userId);
  let inAt = null; let outAt = null;
  if (ask.kind === 'CORRECTION' && (ask.inTime || ask.outTime)) {
    const { people } = await loadInputs(conn, c.companyId, { from: ask.date, to: ask.date, employeeIds: [employeeId], on: ask.date });
    ({ inAt, outAt } = wallTimes(ask, planDay(ask.date, people[0]?.shift ?? null, people[0]?.holidays ?? new Map())));
  }
  const [ins] = await conn.query(
    `INSERT INTO hrms_attendance_regularizations (company_id, attendance_record_id, kind, employee_id, attendance_date, requested_by_employee_id, requested_status,
       requested_in_time, requested_out_time, permission_minutes, reason, status, approver_employee_id, raised_by_hr, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
    [c.companyId, recordId, ask.kind, employeeId, ask.date, raisedByHr ? null : employeeId, ask.status, inAt, outAt, ask.minutes, ask.reason, approverId, raisedByHr ? 1 : 0, c.userId]);
  await audit(conn, c, 'hrms_attendance_regularizations', ins.insertId, 'CREATE', null, { ...ask, employeeId, approverEmployeeId: approverId, raisedByHr }, requestId);
  return { request: (await readRows(conn, c, [ins.insertId], { userId: c.userId, employeeId: raisedByHr ? null : employeeId, hr: null }))[0] };
}

async function myEmployeeId(db, c) {
  const id = await employeeIdOfLogin(db, c);
  if (!id) throw new HrmsError(403, 'NOT_LINKED', 'This login is not linked to an employee, so it has no attendance of its own.');
  return id;
}

export async function submitMine(conn, c, body, requestId) {
  return submitFor(conn, c, await myEmployeeId(conn, c), body, { requestId });
}

export async function cancelMine(conn, c, id, requestId = null) {
  const me = await myEmployeeId(conn, c);
  const [[r]] = await conn.query('SELECT id, employee_id, status FROM hrms_attendance_regularizations WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, id]);
  if (!r || r.employee_id !== me) throw notFound('That request');
  if (r.status !== 'PENDING') throw conflict('NOT_PENDING', `This request is already ${STATUS_WORDS[r.status]}.`);
  await conn.query("UPDATE hrms_attendance_regularizations SET status = 'CANCELLED' WHERE company_id = ? AND id = ?", [c.companyId, id]);
  await audit(conn, c, 'hrms_attendance_regularizations', id, 'UPDATE', { status: 'PENDING' }, { status: 'CANCELLED' }, requestId);
  return { request: (await readRows(conn, c, [id], { userId: c.userId, employeeId: me, hr: null }))[0] };
}

/* ══ who may decide ════════════════════════════════════════════════════════ */

/** The employees of `ids` HR's attendance rights reach. */
async function hrIdsOf(db, companyId, viewer, ids) {
  if (!viewer?.hr || !ids.length) return new Set();
  if (viewer.hr.all) return new Set(ids);
  const depts = [...(viewer.hr.departmentIds ?? [])];
  if (!depts.length) return new Set();
  const on = new Date().toISOString().slice(0, 10);
  const [rows] = await db.query(`SELECT e.id FROM hrms_employees e WHERE e.company_id = ? AND e.id IN (?) AND ${EMPLOYEE_IN_DEPARTMENTS_SQL('e')}`, [companyId, ids, on, on, depts]);
  return new Set(rows.map((r) => r.id));
}

async function isAbove(db, companyId, employeeId, approverId, viewerEmployeeId) {
  if (viewerEmployeeId == null) return false;
  if (approverId != null && approverId === viewerEmployeeId) return true;
  const w = (await loadWorlds(db, companyId, [employeeId])).get(employeeId);
  if (!w) return false;
  const { chain } = await approverChain(db, companyId, w, { full: true });
  const at0 = approverId == null ? 0 : chain.findIndex((x) => x.employeeIds.includes(approverId));
  return chain.slice(Math.max(0, at0)).some((x) => x.employeeIds.includes(viewerEmployeeId));
}

async function reachOf(db, c, row, viewer) {
  const own = viewer.employeeId != null && row.employee_id === viewer.employeeId;
  const hr = (await hrIdsOf(db, c.companyId, viewer, [row.employee_id])).has(row.employee_id);
  const above = !own && !hr ? await isAbove(db, c.companyId, row.employee_id, row.approver_employee_id ?? null, viewer.employeeId) : false;
  return { own, hr, above, decider: !own && (hr || above) };
}

async function readRows(db, c, ids, viewer) {
  if (!ids.length) return [];
  const [rows] = await db.query(`${SELECT} AND g.id IN (?) ORDER BY g.attendance_date DESC, g.id DESC`, [c.companyId, ids]);
  const persons = await loadPersons(db, c.companyId, rows.flatMap((r) => [r.employee_id, r.approver_employee_id]));
  const hrIds = await hrIdsOf(db, c.companyId, viewer, [...new Set(rows.map((r) => r.employee_id))]);
  return rows.map((r) => {
    const own = viewer?.employeeId != null && r.employee_id === viewer.employeeId;
    const decider = !own && (hrIds.has(r.employee_id) || (r.approver_employee_id != null && r.approver_employee_id === viewer?.employeeId));
    const pending = r.status === 'PENDING';
    return shape(r, persons, { approve: pending && decider, reject: pending && decider, cancel: pending && own });
  });
}

/* ══ the approvals feed and context ════════════════════════════════════════ */

/** ApprovalItems of kind ATTENDANCE for this login. */
export async function myApprovals(db, c, viewer, { status = 'PENDING' } = {}) {
  const me = viewer.employeeId ?? -1;
  const on = new Date().toISOString().slice(0, 10);
  let hrSql = '0';
  const hrParams = [];
  if (viewer.hr?.all) hrSql = '1';
  else if (viewer.hr?.departmentIds?.size) { hrSql = EMPLOYEE_IN_DEPARTMENTS_SQL('e'); hrParams.push(on, on, [...viewer.hr.departmentIds]); }
  const waiting = `g.status = 'PENDING' AND g.employee_id <> ? AND (g.approver_employee_id = ? OR (g.approver_employee_id IS NULL AND ${hrSql}))`;
  const decided = String(status).toUpperCase() === 'DECIDED';
  const [[rows], [[count]]] = await Promise.all([
    decided
      ? db.query(`${SELECT} AND g.status IN ('APPROVED', 'REJECTED') AND (g.decided_by = ? OR g.approver_employee_id = ?) ORDER BY COALESCE(g.reviewed_at, g.updated_at) DESC LIMIT 200`, [c.companyId, c.userId ?? -1, me])
      : db.query(`${SELECT} AND ${waiting} ORDER BY g.created_at, g.id LIMIT 500`, [c.companyId, me, me, ...hrParams]),
    db.query(`SELECT COUNT(*) AS n FROM hrms_attendance_regularizations g JOIN hrms_employees e ON e.company_id = g.company_id AND e.id = g.employee_id WHERE g.company_id = ? AND g.deleted_at IS NULL AND ${waiting}`, [c.companyId, me, me, ...hrParams]),
  ]);
  const persons = await loadPersons(db, c.companyId, rows.map((r) => r.employee_id));
  const now = Date.now();
  const items = rows.map((r) => ({
    kind: 'ATTENDANCE', id: r.id, person: persons.get(r.employee_id), title: titleOf(r), when: dayText(day(r.attendance_date), true),
    submittedAt: iso(r.created_at), waitingDays: Math.max(0, Math.floor(((r.reviewed_at ? new Date(r.reviewed_at).getTime() : now) - new Date(r.created_at).getTime()) / 86400000)),
    flags: r.raised_by_hr ? ['Asked by HR on their behalf'] : [], status: r.status,
  }));
  return { items, counts: { pending: Number(count?.n ?? 0) } };
}

/** { request, context } — the day's punches and row, the policy, this month's late marks, earlier requests. */
async function contextOf(db, c, row, request) {
  const date = day(row.attendance_date);
  const month = monthOf(date);
  const [[punches], [[rec]], [marks], [earlier], names] = await Promise.all([
    db.query("SELECT punched_at, direction, method, source FROM hrms_attendance_punches WHERE company_id = ? AND employee_id = ? AND punched_at >= ? AND punched_at < ? ORDER BY punched_at",
      [c.companyId, row.employee_id, `${addDays(date, -1)} 12:00:00`, `${addDays(date, 1)} 14:00:00`]),
    db.query('SELECT status, in_time, out_time, worked_minutes, late_minutes, early_minutes, status_reason, source FROM hrms_attendance_records WHERE company_id = ? AND employee_id = ? AND attendance_date = ? AND deleted_at IS NULL LIMIT 1', [c.companyId, row.employee_id, date]),
    db.query('SELECT attendance_date, late_minutes FROM hrms_attendance_records WHERE company_id = ? AND employee_id = ? AND deleted_at IS NULL AND late_mark = 1 AND attendance_date BETWEEN ? AND ? ORDER BY attendance_date',
      [c.companyId, row.employee_id, monthStart(month), monthEnd(month)]),
    db.query(`${SELECT} AND g.employee_id = ? AND g.id <> ? AND g.attendance_date BETWEEN ? AND ? ORDER BY g.attendance_date`, [c.companyId, row.employee_id, row.id, monthStart(month), monthEnd(month)]),
    leaveTypeNames(db, c.companyId),
  ]);
  const { people } = await loadInputs(db, c.companyId, { from: date, to: date, employeeIds: [row.employee_id], on: new Date().toISOString().slice(0, 10) });
  const p = people[0];
  // The punches of THIS day: inside its shift's window (a night shift runs into the next morning).
  const win = planDay(date, p?.shift ?? null, p?.holidays ?? new Map());
  const dayPunches = punches.filter((x) => wall(x.punched_at) >= win.windowFrom && wall(x.punched_at) <= win.windowTo);
  return {
    request,
    context: {
      day: rec ? { status: rec.status, inTime: wall(rec.in_time), outTime: wall(rec.out_time), workedMinutes: rec.worked_minutes, lateMinutes: rec.late_minutes, earlyMinutes: rec.early_minutes, why: rec.status_reason, source: rec.source } : null,
      shift: p?.shift ? { name: p.shift.name, plan: (() => { const pl = planDay(date, p.shift, p.holidays); return pl.start ? `${pl.start}–${pl.end}${pl.crosses ? ' (ends next day)' : ''}` : (pl.kind === 'WORKING' ? 'flexible hours' : pl.kind === 'HOLIDAY' ? `${pl.holidayName} — holiday` : 'weekly off'); })() } : null,
      punches: dayPunches.map((x) => ({ at: wall(x.punched_at), direction: x.direction, method: x.method, source: x.source })),
      policyLine: p?.effective?.line ?? 'No attendance policy',
      policySentences: p ? sentencesOf(p.rules, { typeNames: names }) : [],
      lateMarksThisMonth: marks.map((m) => ({ date: day(m.attendance_date), minutes: m.late_minutes })),
      earlierThisMonth: earlier.map((e) => ({ id: e.id, kind: e.kind, title: titleOf(e), date: day(e.attendance_date), status: e.status })),
    },
  };
}

export async function approvalDetail(db, c, viewer, id) {
  const [[row]] = await db.query(`${SELECT} AND g.id = ?`, [c.companyId, id]);
  if (!row) throw notFound('That request');
  const reach = await reachOf(db, c, row, viewer);
  if (!reach.decider && row.decided_by !== c.userId) throw new HrmsError(403, 'NOT_YOUR_APPROVAL', reach.own ? 'This is your own request. It is in My attendance.' : 'This request is not waiting for you.');
  const [request] = await readRows(db, c, [id], viewer);
  request.can = { approve: row.status === 'PENDING' && reach.decider, reject: row.status === 'PENDING' && reach.decider, cancel: false };
  return contextOf(db, c, row, request);
}

/** HR's read (the scope gate ran first). */
export async function readRequest(db, c, viewer, id) {
  const [[row]] = await db.query(`${SELECT} AND g.id = ?`, [c.companyId, id]);
  if (!row) throw notFound('That request');
  const [request] = await readRows(db, c, [id], viewer);
  return contextOf(db, c, row, request);
}

export async function requestEmployeeId(db, companyId, id) {
  const [[r]] = await db.query('SELECT employee_id FROM hrms_attendance_regularizations WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  return r?.employee_id ?? null;
}

/** GET /attendance/requests?status=&q=&month= — HR. */
export async function listRequests(db, c, query = {}, scopeDeptIds = null, viewer = null) {
  const where = [];
  const params = [c.companyId];
  const st = String(query.status ?? '').toUpperCase().split(',').filter((s) => STATUS_WORDS[s]);
  if (st.length) { where.push('g.status IN (?)'); params.push(st); }
  if (/^\d{4}-\d{2}$/.test(String(query.month ?? ''))) { where.push('g.attendance_date BETWEEN ? AND ?'); params.push(monthStart(query.month), monthEnd(query.month)); }
  if (query.q) { where.push('(e.full_name LIKE ? OR e.employee_code LIKE ?)'); const like = `%${String(query.q).slice(0, 100)}%`; params.push(like, like); }
  if (scopeDeptIds) {
    if (!scopeDeptIds.length) return { items: [] };
    const on = new Date().toISOString().slice(0, 10);
    where.push(EMPLOYEE_IN_DEPARTMENTS_SQL('e')); params.push(on, on, scopeDeptIds);
  }
  const [rows] = await db.query(`${SELECT} ${where.length ? `AND ${where.join(' AND ')}` : ''} ORDER BY FIELD(g.status, 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'), g.attendance_date DESC LIMIT 1000`, params);
  return { items: await readRows(db, c, rows.map((r) => r.id), viewer) };
}

/* ══ deciding ══════════════════════════════════════════════════════════════ */

/**
 * POST …/approve | …/reject. The approver, anybody above them, or HR — never the person.
 * Approving applies the request to the day and processes it again (penalties follow).
 */
export async function decide(conn, c, viewer, id, verdict, body = {}, requestId = null) {
  const [[row]] = await conn.query(`${SELECT} AND g.id = ? FOR UPDATE`, [c.companyId, id]);
  if (!row) throw notFound('That request');
  const reach = await reachOf(conn, c, row, viewer);
  if (reach.own) throw new HrmsError(403, 'OWN_REQUEST', 'Nobody decides their own request. It goes to your manager.');
  if (!reach.decider) throw new HrmsError(403, 'NOT_YOUR_APPROVAL', 'This request is not waiting for you. Its approver, a manager above them, or HR decides it.');
  if (row.status !== 'PENDING') throw conflict('NOT_PENDING', `This request is already ${STATUS_WORDS[row.status]}.`);
  const note = String(body.note ?? '').trim().slice(0, 2000);
  if (verdict === 'REJECT' && !note) throw invalid('NOTE_NEEDED', 'Say why it is rejected.');
  const date = day(row.attendance_date);
  if (verdict === 'APPROVE') {
    const ask = { kind: row.kind, date, minutes: row.permission_minutes };
    const problems = (await problemsOf(conn, c.companyId, row.employee_id, ask, { excludeId: row.id })).filter((p) => !/already a .* request/.test(p));
    if (problems.length) throw invalid('INVALID', 'This request cannot be approved as it stands.', { problems });
  }
  const status = verdict === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  await conn.query('UPDATE hrms_attendance_regularizations SET status = ?, reviewed_by_employee_id = ?, reviewed_at = NOW(), decided_by = ?, decision_note = ? WHERE company_id = ? AND id = ?',
    [status, viewer.employeeId ?? null, c.userId, note || null, c.companyId, id]);
  await audit(conn, c, 'hrms_attendance_regularizations', id, verdict === 'APPROVE' ? 'APPROVE' : 'UPDATE', { status: 'PENDING' }, { status, note: note || null }, requestId);
  let processed = null;
  if (verdict === 'APPROVE') {
    if (row.kind === 'CORRECTION') await applyCorrection(conn, c, row, requestId);
    processed = await processRange(conn, c, { from: date, to: date, employeeIds: [row.employee_id], kind: 'REQUEST', note: `request ${id}` });
  }
  const [request] = await readRows(conn, c, [id], viewer);
  return { request, processed };
}

/** A CORRECTION approved: the day as the person asked, source REGULARIZATION. */
async function applyCorrection(conn, c, row, requestId) {
  const date = day(row.attendance_date);
  const s = await settingsOf(conn, c.companyId);
  const { people } = await loadInputs(conn, c.companyId, { from: date, to: date, employeeIds: [row.employee_id], on: date });
  const person = people[0];
  const plan = planDay(date, person?.shift ?? null, person?.holidays ?? new Map());
  const [[before]] = await conn.query('SELECT * FROM hrms_attendance_records WHERE company_id = ? AND id = ?', [c.companyId, row.attendance_record_id]);
  const inAt = row.requested_in_time ? wall(row.requested_in_time) : wall(before?.in_time);
  const outAt = row.requested_out_time ? wall(row.requested_out_time) : wall(before?.out_time);
  const punches = [inAt, outAt].filter(Boolean).sort().map((a, i) => ({ id: -1 - i, at: a, direction: i === 0 ? 'IN' : 'OUT' }));
  let x = computeDay({ plan, punches, leave: null, rules: person?.rules, now: nowIn(s.defaultTimezone) });
  if (row.requested_status === 'PRESENT' && x.present < 1) x = { ...x, status: 'PRESENT', present: 1, absent: 0, leave: 0, missing: false, lateMark: false };
  if (row.requested_status === 'HALF_DAY') x = { ...x, status: 'HALF_DAY', present: 0.5, absent: 0.5, leave: 0, missing: false, lateMark: false };
  const reason = `Corrected by an approved request: ${row.reason}`.slice(0, 300);
  await conn.query(
    `UPDATE hrms_attendance_records SET status = ?, in_time = ?, out_time = ?, worked_minutes = ?, late_minutes = ?, early_minutes = ?, overtime_minutes = ?, late_mark = ?, missing_punch = ?,
            present_value = ?, leave_value = ?, absent_value = ?, regularization_id = ?, policy_id = ?, status_reason = ?, source = 'REGULARIZATION', shift_id = ?, processed_at = UTC_TIMESTAMP()
      WHERE company_id = ? AND id = ?`,
    [x.status, x.inTime, x.outTime, x.worked, x.late, x.early, x.overtime, x.lateMark ? 1 : 0, x.missing ? 1 : 0, x.present, x.leave, x.absent, row.id,
      person?.effective?.policy?.id ?? null, reason, person?.shift?.id ?? null, c.companyId, row.attendance_record_id]);
  await audit(conn, c, 'hrms_attendance_records', row.attendance_record_id, 'UPDATE',
    before ? { status: before.status, inTime: wall(before.in_time), outTime: wall(before.out_time), source: before.source } : null,
    { status: x.status, inTime: x.inTime, outTime: x.outTime, source: 'REGULARIZATION', regularizationId: row.id }, requestId);
}

/**
 * PUT /attendance/days { employeeId, date, status, inTime?, outTime?, note } — HR sets a day by
 * hand (source MANUAL: processing keeps it). status null gives the day back to processing.
 */
export async function setDayByHand(conn, c, body = {}, requestId = null) {
  const employeeId = Number(body.employeeId);
  const date = String(body.date ?? '').slice(0, 10);
  const problems = [];
  if (!Number.isInteger(employeeId) || employeeId <= 0) problems.push('Choose the person.');
  if (!isDate(date)) problems.push('Choose the date.');
  const FR = { PRESENT: [1, 0, 0], HALF_DAY: [0.5, 0, 0.5], ABSENT: [0, 0, 1], LEAVE: [0, 1, 0], WEEKLY_OFF: [0, 0, 0], HOLIDAY: [0, 0, 0] };
  const status = body.status == null || body.status === '' ? null : String(body.status).toUpperCase();
  if (status !== null && !FR[status]) problems.push('Status is present, half day, absent, leave, weekly off or holiday.');
  const note = String(body.note ?? '').trim().slice(0, 250);
  if (status !== null && !note) problems.push('Say why the day is set by hand.');
  for (const k of ['inTime', 'outTime']) if (body[k] && !HHMM.test(String(body[k]).slice(0, 5))) problems.push(`The ${k === 'inTime' ? 'in' : 'out'} time is HH:MM.`);
  if (problems.length) throw invalid('INVALID', problems[0], { problems });
  const s = await settingsOf(conn, c.companyId);
  if (!s.liveFrom || date < s.liveFrom) throw invalid('NOT_LIVE', s.liveFrom ? `Attendance is recorded from ${dayText(s.liveFrom, true)}.` : 'Attendance is not live yet.');
  if (date > nowIn(s.defaultTimezone).slice(0, 10)) throw invalid('INVALID', 'A day in the future cannot be set.');
  const [[m]] = await conn.query("SELECT status FROM hrms_attendance_months WHERE company_id = ? AND period_month = ?", [c.companyId, monthOf(date)]);
  if (m?.status === 'CLOSED') throw conflict('MONTH_CLOSED', `${monthWords(monthOf(date))} is closed. The Owner re-opens it first.`);
  const recordId = await recordFor(conn, c.companyId, employeeId, date, c.userId);
  const [[before]] = await conn.query('SELECT status, source, in_time, out_time FROM hrms_attendance_records WHERE company_id = ? AND id = ?', [c.companyId, recordId]);
  if (status === null) {
    await conn.query("UPDATE hrms_attendance_records SET source = 'SYSTEM' WHERE company_id = ? AND id = ?", [c.companyId, recordId]);
  } else {
    const inAt = body.inTime ? at(date, String(body.inTime).slice(0, 5)) : null;
    let outAt = body.outTime ? at(date, String(body.outTime).slice(0, 5)) : null;
    if (inAt && outAt && outAt <= inAt) outAt = at(date, String(body.outTime).slice(0, 5), 1);
    const worked = inAt && outAt ? toMin(outAt) - toMin(inAt) : null;
    const [pv, lv, av] = FR[status];
    await conn.query(
      `UPDATE hrms_attendance_records SET status = ?, in_time = ?, out_time = ?, worked_minutes = ?, late_minutes = 0, early_minutes = 0, overtime_minutes = 0, late_mark = 0, missing_punch = 0,
              present_value = ?, leave_value = ?, absent_value = ?, status_reason = ?, source = 'MANUAL', processed_at = UTC_TIMESTAMP() WHERE company_id = ? AND id = ?`,
      [status, inAt, outAt, worked, pv, lv, av, `Set by HR: ${note}`.slice(0, 300), c.companyId, recordId]);
  }
  await audit(conn, c, 'hrms_attendance_records', recordId, 'UPDATE', before ? { status: before.status, source: before.source } : null, { status: status ?? '(back to processing)', source: status ? 'MANUAL' : 'SYSTEM', note }, requestId);
  const processed = await processRange(conn, c, { from: date, to: date, employeeIds: [employeeId], kind: 'MANUAL', note: 'set by hand' });
  return { ok: true, processed };
}

export default { KINDS, readAsk, submitFor, submitMine, cancelMine, myApprovals, approvalDetail, readRequest, listRequests, decide, requestEmployeeId, setDayByHand };
export { toMin };
