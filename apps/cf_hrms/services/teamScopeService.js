/**
 * teamScopeService.js — what an employee login may change.
 * (TM/CF_HRMS_HIRING_SPEC.md §7.)
 *
 * For the positions BELOW them a manager may change the position's
 * responsibilities and KPIs (KRAs stay fixed at the role) and the position's
 * shift. Nothing else, and for nobody else: not their own position, not the
 * other chairs of their card, not anybody above them, not anything outside
 * their slice of the chart.
 *
 * THREE THINGS THIS FILE IS CAREFUL ABOUT.
 *
 * 1. ONE DEFINITION OF "BELOW ME". It is selfOrgChartService.loadMySlice — the
 *    computation the employee's own chart is drawn from — and its canChange().
 *    Nothing here walks a reporting line.
 *
 * 2. THE CHECK RUNS ON EVERY CALL, on the server, from the session's user id
 *    -> their employee -> the positions they hold today. No id the client sends
 *    takes part in deciding who the caller is; the id in the URL is only what
 *    is being asked ABOUT.
 *
 * 3. THE SAME SERVICES AS THE HR ROUTES. Each write below checks the scope and
 *    then calls the very function `routes/positions.js` calls — so validation,
 *    the KRA refusal (422 KRA_FIXED_AT_ROLE) and the audit row, with the
 *    acting user on it, are identical by construction.
 *
 * REFUSALS
 *   403 NOT_YOUR_TEAM  the caller has no team (no employee record, has left, in
 *                      no position today), or the position is not below them
 *   404 NOT_FOUND      the position does not exist in the caller's company —
 *                      another company's position reads exactly like this, so
 *                      the answer says nothing about what exists elsewhere
 */
import { HrmsError, invalid, notFound } from '../lib/errors.js';
import { requirePosition, updatePosition, today } from './positionService.js';
import {
  positionJobContent, seatAddLine, seatChangeLine, seatSwitchOffLine, seatUndoLine,
  employeeJobContent, personAddLine, personChangeLine, personSwitchOffLine, personUndoLine, seatHeldOn,
} from './jobContentService.js';
import { audit } from './peopleService.js';
import { loadMySlice } from './selfOrgChartService.js';
import { summaryFromRow } from './shiftRead.js';

const notYours = (message, detail = undefined) => new HrmsError(403, 'NOT_YOUR_TEAM', message, detail ? { detail } : {});

/** The caller's slice as of TODAY, or 403 when they have no team at all. */
async function mySlice(db, c) {
  const slice = await loadMySlice(db, c, { on: today() });
  if (!slice.linked) throw notYours('You have no team to change: this login is not in a position on the organisation chart.');
  if (slice.employee.employment_status === 'EXITED') throw notYours('You have no team to change: you have left the company.');
  return slice;
}

/**
 * THE GATE. Who the caller is (403 if nobody with a team), then whether the
 * position exists in their company (404), then whether it is below them (403).
 */
export async function assertInMyTeam(db, c, positionId) {
  const slice = await mySlice(db, c);
  await requirePosition(db, c.companyId, positionId);
  if (slice.canChange(positionId)) return slice;
  const relation = slice.relationOf(Number(positionId));
  const sentence = {
    SELF: 'This is your own position. You can change the positions that report to you, not your own.',
    SAME_CARD: 'This position is beside yours, not below it. You can change the positions that report to you.',
    MANAGER: 'This position is above yours. You can change the positions that report to you.',
    DOTTED_MANAGER: 'This position is above yours. You can change the positions that report to you.',
  }[relation] ?? 'This position is not in your team. You can change the positions that report to you.';
  throw notYours(sentence, { positionId: Number(positionId) });
}

/* ── responsibilities and KPIs: the four position job-content writers, and their read ── */

export async function teamJobContent(db, c, positionId, { on } = {}) {
  await assertInMyTeam(db, c, positionId);
  return positionJobContent(db, c.companyId, positionId, { on });
}
export async function teamAddLine(db, c, positionId, body = {}) {
  await assertInMyTeam(db, c, positionId);
  return seatAddLine(db, c, positionId, body);
}
export async function teamChangeLine(db, c, positionId, body = {}) {
  await assertInMyTeam(db, c, positionId);
  return seatChangeLine(db, c, positionId, body);
}
export async function teamSwitchOffLine(db, c, positionId, body = {}) {
  await assertInMyTeam(db, c, positionId);
  return seatSwitchOffLine(db, c, positionId, body);
}
export async function teamUndoLine(db, c, positionId, body = {}) {
  await assertInMyTeam(db, c, positionId);
  return seatUndoLine(db, c, positionId, body);
}

/* ── a PERSON's own job content (spec §16.2): the same rule, by the position they hold today ── */

/**
 * A person below me: they hold, today, a position I may change. My own job,
 * a card-mate's, my manager's: 403 with a sentence. A person in no position
 * today has no team place at all (403); one who does not exist here, 404.
 */
export async function assertPersonInMyTeam(db, c, employeeId) {
  const slice = await mySlice(db, c);
  const [[e]] = await db.query('SELECT id FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, employeeId]);
  if (!e) throw notFound('Employee');
  const seat = await seatHeldOn(db, c.companyId, Number(employeeId), today());
  if (seat && slice.canChange(seat.position_id)) return slice;
  if (Number(employeeId) === Number(slice.employee?.id)) {
    throw notYours('This is your own job. You can change the jobs of the people who report to you, not your own.', { employeeId: Number(employeeId) });
  }
  const relation = seat ? slice.relationOf(Number(seat.position_id)) : null;
  const sentence = {
    SELF: 'This person shares your position. You can change the jobs of the people who report to you.',
    SAME_CARD: 'This person works beside you, not below you. You can change the jobs of the people who report to you.',
    MANAGER: 'This person is above you. You can change the jobs of the people who report to you.',
    DOTTED_MANAGER: 'This person is above you. You can change the jobs of the people who report to you.',
  }[relation] ?? 'This person is not in your team. You can change the jobs of the people who report to you.';
  throw notYours(sentence, { employeeId: Number(employeeId) });
}

export async function teamPersonJobContent(db, c, employeeId, { on } = {}) {
  await assertPersonInMyTeam(db, c, employeeId);
  return employeeJobContent(db, c.companyId, employeeId, { on });
}
export async function teamPersonAddLine(db, c, employeeId, body = {}) {
  await assertPersonInMyTeam(db, c, employeeId);
  return personAddLine(db, c, employeeId, body);
}
export async function teamPersonChangeLine(db, c, employeeId, body = {}) {
  await assertPersonInMyTeam(db, c, employeeId);
  return personChangeLine(db, c, employeeId, body);
}
export async function teamPersonSwitchOffLine(db, c, employeeId, body = {}) {
  await assertPersonInMyTeam(db, c, employeeId);
  return personSwitchOffLine(db, c, employeeId, body);
}
export async function teamPersonUndoLine(db, c, employeeId, body = {}) {
  await assertPersonInMyTeam(db, c, employeeId);
  return personUndoLine(db, c, employeeId, body);
}

/* ── the shift ─────────────────────────────────────────────────────────────── */

/** GET /user/me/team/shifts — the shifts a team's position can be put on. Only for somebody who has a team. */
export async function teamShifts(db, c) {
  await mySlice(db, c);
  const [rows] = await db.query(
    `SELECT id, code, name, week_summary, start_time, end_time FROM hrms_shifts
      WHERE company_id = ? AND deleted_at IS NULL AND status = 'ACTIVE' ORDER BY code, id`,
    [c.companyId],
  );
  return { shifts: rows.map((r) => ({ id: r.id, code: r.code, name: r.name, summary: summaryFromRow(r) })) };
}

/**
 * PUT /user/me/team/positions/:id/shift { shiftId } — the position update with
 * `defaultShiftId` and nothing else: whatever else the body carries is not
 * passed on. The person in the position moves to the shift with it, as on the
 * HR route.
 */
export async function teamChangeShift(db, c, positionId, body = {}) {
  await assertInMyTeam(db, c, positionId);
  const shiftId = Number(body.shiftId);
  if (!Number.isInteger(shiftId) || shiftId <= 0) throw invalid('INVALID', 'Choose the shift to put this position on.', { problems: ['Choose the shift to put this position on.'] });
  const [[shift]] = await db.query("SELECT id FROM hrms_shifts WHERE company_id = ? AND id = ? AND deleted_at IS NULL AND status = 'ACTIVE'", [c.companyId, shiftId]);
  if (!shift) throw notFound('That shift');
  const before = await requirePosition(db, c.companyId, positionId);
  const result = await updatePosition(db, c, positionId, { defaultShiftId: shiftId });
  await audit(db, c, 'hrms_positions', Number(positionId), 'UPDATE',
    { defaultShiftId: before.default_shift_id }, { defaultShiftId: shiftId, occupantsMovedToShift: result.occupantsMovedToShift, by: 'TEAM' });
  return result;
}

export default {
  assertInMyTeam, teamJobContent, teamAddLine, teamChangeLine, teamSwitchOffLine, teamUndoLine, teamShifts, teamChangeShift,
  assertPersonInMyTeam, teamPersonJobContent, teamPersonAddLine, teamPersonChangeLine, teamPersonSwitchOffLine, teamPersonUndoLine,
};
