/**
 * exitService.js — leaving: notice, and closing an employee.
 * (TM/CF_HRMS_HIRING_SPEC.md §4.)
 *
 * AN EMPLOYEE IS NEVER DELETED.
 *
 *   start     ACTIVE -> NOTICE. Who decided (RESIGNED / REMOVED), why, the day
 *             notice was given, the last working day. The person stays in their
 *             position and in every count.
 *   edit      the same fields, while the record is open.
 *   withdraw  the notice is taken back: NOTICE -> ACTIVE. The record is kept.
 *   close     NOTICE -> EXITED, in ONE transaction: exit_date = the last working
 *             day; every open work assignment of the person ended on that day
 *             (reporting rows and context links with it, by assignmentService);
 *             an EXIT employment event; the linked login's access removed. The
 *             position becomes vacant. The employee code is never reused and
 *             the record stays readable.
 *
 * Every write is on the caller's connection, inside the route's transaction,
 * and every step is audited.
 *
 * ── THE LOGIN (spec §4.4) ─────────────────────────────────────────────────
 * The platform has no "disabled" flag on a user: `users` holds name, email,
 * password, role, team, company, deleted_at and preferences, and the login
 * controller (core/auth/authController.js) reads the row by email alone — it
 * does not even look at deleted_at. So nothing on the user row can stop a
 * sign-in without changing the platform's login for every app.
 *
 * What the platform DOES check, on every request to an app, is the user's
 * `app_user_access` row (core/middleware/authmiddleware.js): no live row, 403
 * "You do not have access to this app". So closing an employee soft-deletes
 * that ONE user's access rows in this company. The password still verifies,
 * but there is nothing the person can open, and a token they already hold
 * stops working at once — which a block at the login form would not do.
 *
 * It is reversible and narrow: only `deleted_at` on rows of that user id in
 * this company; the user row is never touched; the ids of the rows are in the
 * audit row of the close (`accessRowIds`), and clearing `deleted_at` on them
 * gives the access back. No other user's row is read or written.
 *
 * ── A REPLACEMENT ─────────────────────────────────────────────────────────
 * A hiring may be started on the position of somebody on notice, and the new
 * person appointed from a day after their last working day (hiringService).
 * From then on the notice cannot be withdrawn, nor the last day moved to or
 * past the day the new person starts: two people would hold one position.
 */
import { invalid, notFound, conflict, assertNoProblems } from '../lib/errors.js';
import { audit, createEvent, getEmployee } from './peopleService.js';
import { endAssignment, deleteAssignment } from './assignmentService.js';
import { HOLDS_SEAT_SQL } from './seatCount.js';
import {
  EXIT_TYPES, exitTypeOf, exitReasonOf, shapeExit, isoDay, todayIso, shortDay, daysBetween,
} from './exitRead.js';

const DEFAULT_NOTICE_DAYS = 30;

const has = (o, k) => Object.prototype.hasOwnProperty.call(o ?? {}, k);
const clean = (v) => (v === null || v === undefined ? null : (String(v).trim() || null));
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function requireEmployee(conn, companyId, employeeId, { lock = false } = {}) {
  const [[e]] = await conn.query(
    `SELECT id, employee_code, full_name, employment_status, date_of_joining, exit_date, user_id
       FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, employeeId],
  );
  if (!e) throw notFound('That employee');
  return e;
}

async function openExit(conn, companyId, employeeId, { lock = false } = {}) {
  const [[x]] = await conn.query(
    `SELECT * FROM hrms_employee_exits
      WHERE company_id = ? AND employee_id = ? AND status = 'OPEN' AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, employeeId],
  );
  return x ?? null;
}

/** The company's notice period for a confirmed employee; 30 days when it has saved no hiring settings. */
async function noticeDays(conn, companyId) {
  const [[s]] = await conn.query('SELECT notice_days_confirmed FROM hrms_hiring_settings WHERE company_id = ?', [companyId]);
  return s ? Number(s.notice_days_confirmed) : DEFAULT_NOTICE_DAYS;
}

/** `{ employee, exit }` — the employee as GET /people/employees/:id returns them, and the record just written. */
async function answer(conn, companyId, employeeId, exitId) {
  const [[row]] = await conn.query('SELECT * FROM hrms_employee_exits WHERE company_id = ? AND id = ?', [companyId, exitId]);
  const detail = await getEmployee(conn, companyId, employeeId);
  return { employee: detail.employee, exit: shapeExit(row) };
}

/**
 * Reads and checks the fields of a leaving record. `current` is the open
 * record on an edit (only what was sent changes); null on a start.
 */
async function readFields(conn, companyId, employee, body, current = null) {
  const problems = [];
  const today = todayIso();
  const pick = (key, col) => (has(body, key) ? body[key] : current?.[col]);
  const pickDay = (key, col) => (has(body, key) ? clean(body[key])?.slice(0, 10) ?? null : isoDay(current?.[col]));

  const exitType = String(pick('exitType', 'exit_type') ?? '').trim().toUpperCase();
  const reasonCode = String(pick('reasonCode', 'reason_code') ?? '').trim().toUpperCase();
  const note = clean(has(body, 'note') ? body.note : current?.note);
  let noticeDate = pickDay('noticeDate', 'notice_date') ?? (current || has(body, 'noticeDate') ? null : today);
  let lastWorkingDay = pickDay('lastWorkingDay', 'last_working_day');

  const type = exitTypeOf(exitType);
  if (!type) problems.push('Say who decided: the employee resigned, or we ended the employment.');
  const reason = type ? exitReasonOf(exitType, reasonCode) : null;
  if (type && !reason) problems.push(reasonCode ? 'That reason does not go with that choice. Pick one from the list.' : 'Pick a reason.');
  if (reason?.noteRequired && !note) problems.push('Add a note saying what the reason is.');
  if (note && note.length > 1000) problems.push('The note is up to 1000 characters.');

  if (!noticeDate || !isDay(noticeDate)) { problems.push('The notice date needs a date as YYYY-MM-DD.'); noticeDate = null; }
  else if (noticeDate > today) problems.push('The notice date cannot be in the future.');
  else if (isoDay(employee.date_of_joining) && noticeDate < isoDay(employee.date_of_joining)) problems.push('The notice date is before the person joined.');

  // Not sent on a start: the notice date plus the company's notice period.
  if (!lastWorkingDay && noticeDate && !current) lastWorkingDay = addDays(noticeDate, await noticeDays(conn, companyId));
  if (!lastWorkingDay || !isDay(lastWorkingDay)) problems.push('The last working day needs a date as YYYY-MM-DD.');
  else if (noticeDate && lastWorkingDay < noticeDate) problems.push('The last working day cannot be before the notice date.');

  assertNoProblems(problems, 'This cannot be saved yet.');
  return { exitType, reasonCode, note, noticeDate, lastWorkingDay };
}

/**
 * Somebody ELSE holding, or due to hold, one of this person's positions — the
 * replacement appointed while they serve their notice. Earliest first.
 */
async function successorOf(conn, companyId, employeeId) {
  const [[row]] = await conn.query(
    `SELECT s.id, s.effective_from, e.full_name, p.position_code
       FROM hrms_work_assignments mine
       JOIN hrms_work_assignments s ON s.company_id = mine.company_id AND s.position_id = mine.position_id
            AND s.employee_id <> mine.employee_id AND ${HOLDS_SEAT_SQL('s')}
       JOIN hrms_employees e ON e.company_id = s.company_id AND e.id = s.employee_id
       JOIN hrms_positions p ON p.company_id = s.company_id AND p.id = s.position_id
      WHERE mine.company_id = ? AND mine.employee_id = ? AND ${HOLDS_SEAT_SQL('mine')}
      ORDER BY s.effective_from, s.id LIMIT 1`,
    [companyId, employeeId],
  );
  return row ?? null;
}

const successorRefusal = (employee, successor, what) => conflict(
  'POSITION_FILLED',
  `${successor.full_name} has been appointed to ${employee.full_name}'s position from ${shortDay(successor.effective_from)}, so ${what}. End that appointment first.`,
  { detail: { successor: { assignmentId: successor.id, name: successor.full_name, from: isoDay(successor.effective_from) } } },
);

/* ══════════════════════════════════════════════════════════════════════════
 * start / edit / withdraw
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * POST /people/employees/:id/exit { exitType, reasonCode, note?, noticeDate, lastWorkingDay }
 * 409 ALREADY_LEFT · 409 EXIT_OPEN · 422 INVALID with problems[].
 */
export async function startExit(conn, c, employeeId, body = {}, requestId = null) {
  const employee = await requireEmployee(conn, c.companyId, employeeId, { lock: true });
  if (employee.employment_status === 'EXITED') {
    throw conflict('ALREADY_LEFT', `${employee.full_name} has already left${employee.exit_date ? ` (on ${shortDay(employee.exit_date)})` : ''}.`);
  }
  const open = await openExit(conn, c.companyId, employeeId);
  if (open) {
    throw conflict('EXIT_OPEN', `${employee.full_name} is already on notice, with ${shortDay(open.last_working_day)} as the last working day. Change that record, or cancel the notice first.`,
      { existing: { id: open.id }, detail: { exitId: open.id } });
  }

  const f = await readFields(conn, c.companyId, employee, body);
  const [ins] = await conn.query(
    `INSERT INTO hrms_employee_exits (company_id, employee_id, exit_type, reason_code, note, notice_date, last_working_day, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
    [c.companyId, employeeId, f.exitType, f.reasonCode, f.note, f.noticeDate, f.lastWorkingDay, c.userId],
  );
  await conn.query("UPDATE hrms_employees SET employment_status = 'NOTICE' WHERE company_id = ? AND id = ?", [c.companyId, employeeId]);

  const type = exitTypeOf(f.exitType);
  const reason = exitReasonOf(f.exitType, f.reasonCode);
  await createEvent(conn, c, employeeId, {
    eventType: 'OTHER',
    eventDate: f.noticeDate,
    summary: `On notice: ${type.short} (${reason.label.toLowerCase()}). Last working day ${shortDay(f.lastWorkingDay)}.`,
    details: { exitId: ins.insertId, exitType: f.exitType, reasonCode: f.reasonCode, lastWorkingDay: f.lastWorkingDay },
  }, requestId);
  await audit(conn, c, 'hrms_employee_exits', ins.insertId, 'CREATE', { employmentStatus: employee.employment_status },
    { employeeId: Number(employeeId), exitType: f.exitType, reasonCode: f.reasonCode, noticeDate: f.noticeDate, lastWorkingDay: f.lastWorkingDay, employmentStatus: 'NOTICE' }, requestId);
  return answer(conn, c.companyId, employeeId, ins.insertId);
}

/** PUT /people/employees/:id/exit — any of the same fields, while the record is open. */
export async function updateExit(conn, c, employeeId, body = {}, requestId = null) {
  const employee = await requireEmployee(conn, c.companyId, employeeId, { lock: true });
  const open = await openExit(conn, c.companyId, employeeId, { lock: true });
  if (!open) throw conflict('NO_EXIT_OPEN', `${employee.full_name} is not on notice, so there is nothing to change.`);

  const f = await readFields(conn, c.companyId, employee, body, open);
  if (f.lastWorkingDay !== isoDay(open.last_working_day)) {
    const successor = await successorOf(conn, c.companyId, employeeId);
    if (successor && f.lastWorkingDay >= isoDay(successor.effective_from)) throw successorRefusal(employee, successor, 'the last working day must stay before that');
  }
  await conn.query(
    `UPDATE hrms_employee_exits SET exit_type = ?, reason_code = ?, note = ?, notice_date = ?, last_working_day = ?
      WHERE company_id = ? AND id = ?`,
    [f.exitType, f.reasonCode, f.note, f.noticeDate, f.lastWorkingDay, c.companyId, open.id],
  );
  await audit(conn, c, 'hrms_employee_exits', open.id, 'UPDATE',
    { exitType: open.exit_type, reasonCode: open.reason_code, noticeDate: isoDay(open.notice_date), lastWorkingDay: isoDay(open.last_working_day) },
    { exitType: f.exitType, reasonCode: f.reasonCode, noticeDate: f.noticeDate, lastWorkingDay: f.lastWorkingDay }, requestId);
  return answer(conn, c.companyId, employeeId, open.id);
}

/** POST /people/employees/:id/exit/withdraw { note? } — the notice is taken back; the record is kept as WITHDRAWN. */
export async function withdrawExit(conn, c, employeeId, body = {}, requestId = null) {
  const employee = await requireEmployee(conn, c.companyId, employeeId, { lock: true });
  const open = await openExit(conn, c.companyId, employeeId, { lock: true });
  if (!open) throw conflict('NO_EXIT_OPEN', `${employee.full_name} is not on notice, so there is no notice to cancel.`);
  const note = clean(body.note);
  if (note && note.length > 1000) throw invalid('INVALID', 'The note is up to 1000 characters.', { problems: ['The note is up to 1000 characters.'] });

  const successor = await successorOf(conn, c.companyId, employeeId);
  if (successor) throw successorRefusal(employee, successor, 'the notice cannot be cancelled');

  const today = todayIso();
  await conn.query("UPDATE hrms_employee_exits SET status = 'WITHDRAWN', withdrawn_on = ?, withdraw_note = ? WHERE company_id = ? AND id = ?",
    [today, note, c.companyId, open.id]);
  await conn.query("UPDATE hrms_employees SET employment_status = 'ACTIVE' WHERE company_id = ? AND id = ?", [c.companyId, employeeId]);
  await createEvent(conn, c, employeeId, {
    eventType: 'OTHER', eventDate: today, summary: 'Notice cancelled. Continues in employment.', details: { exitId: open.id },
  }, requestId);
  await audit(conn, c, 'hrms_employee_exits', open.id, 'UPDATE', { status: 'OPEN', employmentStatus: 'NOTICE' },
    { status: 'WITHDRAWN', withdrawnOn: today, employmentStatus: 'ACTIVE' }, requestId);
  return answer(conn, c.companyId, employeeId, open.id);
}

/* ══════════════════════════════════════════════════════════════════════════
 * close — one transaction
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Removes ONE user's access to this company's apps (see the header). Returns
 * the ids of the rows it soft-deleted — empty when the employee has no login,
 * or the login had no access left.
 */
async function removeAccess(conn, companyId, userId) {
  if (!userId) return [];
  const [rows] = await conn.query(
    'SELECT id FROM app_user_access WHERE user_id = ? AND company_id = ? AND deleted_at IS NULL FOR UPDATE',
    [userId, companyId],
  );
  const ids = rows.map((r) => r.id);
  if (ids.length) await conn.query('UPDATE app_user_access SET deleted_at = NOW() WHERE id IN (?) AND user_id = ? AND company_id = ?', [ids, userId, companyId]);
  return ids;
}

/**
 * POST /people/employees/:id/exit/close { lastWorkingDay?, note? }
 *
 * A last working day that has not come yet is not closed by accident: the body
 * must then carry today's date or an earlier one ("end the notice early"),
 * else 422 NOT_READY.
 *
 * @returns { employee, exit, endedAssignments, vacatedPositions: [{ positionId, positionCode, roleTitle }], loginDisabled }
 */
export async function closeExit(conn, c, employeeId, body = {}, requestId = null) {
  const employee = await requireEmployee(conn, c.companyId, employeeId, { lock: true });
  const open = await openExit(conn, c.companyId, employeeId, { lock: true });
  if (!open) {
    if (employee.employment_status === 'EXITED') throw conflict('ALREADY_LEFT', `${employee.full_name} has already left.`);
    throw conflict('NO_EXIT_OPEN', `${employee.full_name} is not on notice. Start the leaving first.`);
  }

  const today = todayIso();
  const note = clean(body.note);
  const sent = clean(body.lastWorkingDay)?.slice(0, 10) ?? null;
  const lastWorkingDay = sent ?? isoDay(open.last_working_day);
  const noticeDate = isoDay(open.notice_date);
  const problems = [];
  if (sent && !isDay(sent)) problems.push('The last working day needs a date as YYYY-MM-DD.');
  else if (lastWorkingDay < noticeDate) problems.push('The last working day cannot be before the notice date.');
  if (note && note.length > 1000) problems.push('The note is up to 1000 characters.');
  assertNoProblems(problems, 'This employee cannot be closed yet.');
  if (lastWorkingDay > today) {
    const left = daysBetween(today, lastWorkingDay);
    throw invalid('NOT_READY',
      `The last working day is ${shortDay(lastWorkingDay)}, ${left} day${left === 1 ? '' : 's'} from now. To end the notice early, give today's date or an earlier one as the last working day.`,
      { problems: [`The last working day (${shortDay(lastWorkingDay)}) has not come yet.`], detail: { lastWorkingDay, today } });
  }

  // 1. Every job the person still holds ends on the last working day. One that
  //    had not started by then never happened: it is removed, not ended.
  const [assignments] = await conn.query(
    `SELECT wa.id, wa.position_id, wa.effective_from, p.position_code, COALESCE(p.position_title, r.title) AS role_title
       FROM hrms_work_assignments wa
       LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id
       LEFT JOIN hrms_roles r ON r.company_id = wa.company_id AND r.id = COALESCE(p.role_id, wa.role_id)
      WHERE wa.company_id = ? AND wa.employee_id = ? AND wa.deleted_at IS NULL AND wa.status <> 'ENDED'
      ORDER BY wa.is_primary DESC, wa.id`,
    [c.companyId, employeeId],
  );
  const vacated = new Map();
  for (const a of assignments) {
    if (isoDay(a.effective_from) && isoDay(a.effective_from) > lastWorkingDay) await deleteAssignment(conn, c, a.id);
    else await endAssignment(conn, c, a.id, { effectiveTo: lastWorkingDay });
    if (a.position_id != null && !vacated.has(a.position_id)) {
      vacated.set(a.position_id, { positionId: a.position_id, positionCode: a.position_code ?? null, roleTitle: a.role_title ?? null });
    }
  }

  // 2. The employee, and the record.
  await conn.query("UPDATE hrms_employees SET employment_status = 'EXITED', exit_date = ? WHERE company_id = ? AND id = ?",
    [lastWorkingDay, c.companyId, employeeId]);
  await conn.query(
    "UPDATE hrms_employee_exits SET status = 'CLOSED', last_working_day = ?, closed_on = ?, close_note = ?, closed_by = ? WHERE company_id = ? AND id = ?",
    [lastWorkingDay, today, note, c.userId, c.companyId, open.id],
  );

  // 3. Their file.
  const type = exitTypeOf(open.exit_type);
  const reason = exitReasonOf(open.exit_type, open.reason_code);
  await createEvent(conn, c, employeeId, {
    eventType: 'EXIT',
    eventDate: lastWorkingDay,
    summary: `${employee.full_name} left: ${type?.short ?? 'left'}${reason ? ` (${reason.label.toLowerCase()})` : ''}.`,
    details: { exitId: open.id, exitType: open.exit_type, reasonCode: open.reason_code, exitDate: lastWorkingDay, endedAssignments: assignments.length },
  }, requestId);

  // 4. Their login.
  const accessRowIds = await removeAccess(conn, c.companyId, employee.user_id);

  await audit(conn, c, 'hrms_employee_exits', open.id, 'UPDATE', { status: 'OPEN', employmentStatus: employee.employment_status },
    {
      status: 'CLOSED', employmentStatus: 'EXITED', exitDate: lastWorkingDay, closedOn: today,
      endedAssignmentIds: assignments.map((a) => a.id), vacatedPositionIds: [...vacated.keys()],
      // What undoes the login change: clear deleted_at on exactly these app_user_access rows.
      login: { userId: employee.user_id ?? null, accessRowIds },
    }, requestId);

  return {
    ...(await answer(conn, c.companyId, employeeId, open.id)),
    endedAssignments: assignments.length,
    vacatedPositions: [...vacated.values()],
    loginDisabled: accessRowIds.length > 0,
  };
}

/** GET /people/employees/:id/exits — the history, newest first. */
export async function listExits(db, companyId, employeeId) {
  await requireEmployee(db, companyId, employeeId);
  const [rows] = await db.query(
    'SELECT * FROM hrms_employee_exits WHERE company_id = ? AND employee_id = ? AND deleted_at IS NULL ORDER BY id DESC',
    [companyId, employeeId],
  );
  return { exits: rows.map((r) => shapeExit(r)) };
}

export default { startExit, updateExit, withdrawExit, closeExit, listExits, EXIT_TYPES };
