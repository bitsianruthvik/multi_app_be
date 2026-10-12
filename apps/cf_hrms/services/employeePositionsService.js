/**
 * employeePositionsService.js — the positions a person has held, and moving
 * them to another one. (TM/CF_HRMS_HIRING_SPEC.md §10.)
 *
 * A person is put in a position in exactly two places — on the position and on
 * the employee page — and both end in the same call:
 * assignmentService.createAssignment. This file adds no rule of its own about
 * who may sit where; it reads the history and words the move.
 *
 *   GET  /people/employees/:id/positions      every position held, newest first, and how each ended
 *   POST /people/employees/:id/move           { positionId, effectiveFrom?, keepCurrent? }
 *
 * MOVE. The person's current position ends the day BEFORE the new one starts,
 * and the new one begins, in one transaction. A move from today or earlier uses
 * endAssignment (the old one is ENDED, its reporting rows with it). A move on a LATER date
 * only gives the old one its last day — ENDED frees a chair at once, whatever
 * the date, and the person is still sitting in it until then.
 * `keepCurrent: true` is the rare second position: nothing ends, and the new
 * one is not their main position unless they had none.
 *
 * The refusals are the assignment service's own, unchanged: 409 POSITION_FILLED,
 * 409 HIRING_OPEN, 409 EMPLOYEE_LEFT.
 */
import { invalid, notFound, conflict } from '../lib/errors.js';
import { createAssignment, updateAssignment, endAssignment, assertPositionFree } from './assignmentService.js';
import { assertNoOpenHiring } from './hiringRead.js';
import { audit, createEvent } from './peopleService.js';
import { SHIFT_SUMMARY_COLUMNS_SQL, summaryFromRow } from './shiftRead.js';

const pad2 = (n) => String(n).padStart(2, '0');
const dayOf = (v) => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
  return String(v).slice(0, 10);
};
const todayText = () => dayOf(new Date());
const addDays = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
};
const longDay = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
};

async function requireEmployee(db, companyId, id, { lock = false } = {}) {
  const [[row]] = await db.query(
    `SELECT id, employee_code, full_name, employment_status, date_of_joining
       FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, id],
  );
  if (!row) throw notFound('Employee');
  return row;
}

const HELD_SQL = `
  SELECT wa.id, wa.position_id, wa.role_id, wa.department_id, wa.location_id, wa.default_shift_id, wa.is_primary,
         wa.status, wa.effective_from, wa.effective_to, wa.reason,
         p.position_code, COALESCE(p.position_title, pr.title, r.title) AS position_title,
         r.title AS role_title, r.role_code,
         d.name AS department_name, d.code AS department_code, l.name AS location_name,
         s.code AS shift_code, s.name AS shift_name, ${SHIFT_SUMMARY_COLUMNS_SQL('s')}
    FROM hrms_work_assignments wa
    LEFT JOIN hrms_positions p    ON p.company_id = wa.company_id AND p.id = wa.position_id
    LEFT JOIN hrms_roles r        ON r.company_id = wa.company_id AND r.id = wa.role_id
    LEFT JOIN hrms_roles pr       ON pr.company_id = wa.company_id AND pr.id = p.role_id
    LEFT JOIN hrms_departments d  ON d.company_id = wa.company_id AND d.id = COALESCE(wa.department_id, p.department_id)
    LEFT JOIN hrms_locations l    ON l.company_id = wa.company_id AND l.id = COALESCE(wa.location_id, p.location_id)
    LEFT JOIN hrms_shifts s       ON s.company_id = wa.company_id AND s.id = COALESCE(wa.default_shift_id, p.default_shift_id)
   WHERE wa.company_id = ? AND wa.employee_id = ? AND wa.deleted_at IS NULL`;

/**
 * GET /people/employees/:id/positions
 *
 * {
 *   employee: { id, code, name, status },
 *   positions: [{
 *     assignmentId, positionId, positionCode, positionTitle, roleId, roleTitle, roleCode,
 *     departmentId, departmentName, locationName,
 *     shift: { id, code, name, summary } | null,
 *     from, to, isMain,
 *     state: 'CURRENT' | 'COMING' | 'ENDED',
 *     ended: null | { how: 'MOVED' | 'LEFT' | 'ENDED', label, on, movedToPositionCode? },
 *     reason,
 *   }],                                   // newest first
 *   current: [assignmentId],              // held today
 *   can: { move, addSecond },             // false once the person has left
 * }
 *
 * HOW IT ENDED is read, not stored: the person left the company on that day
 * (their closed leaving record), or another position of theirs starts the day
 * after (a move), or it simply ended.
 */
export async function positionsHeld(db, companyId, employeeId, { on } = {}) {
  const asOf = dayOf(on) ?? todayText();
  const employee = await requireEmployee(db, companyId, employeeId);
  const [[rows], [exits]] = await Promise.all([
    db.query(`${HELD_SQL} ORDER BY wa.effective_from DESC, wa.id DESC`, [companyId, employeeId]),
    db.query(
      `SELECT last_working_day, closed_on FROM hrms_employee_exits
        WHERE company_id = ? AND employee_id = ? AND deleted_at IS NULL AND status = 'CLOSED' ORDER BY id DESC`,
      [companyId, employeeId],
    ),
  ]);
  const leftOn = new Set(exits.flatMap((x) => [dayOf(x.last_working_day), dayOf(x.closed_on)]).filter(Boolean));
  const startsOn = new Map();
  for (const r of rows) if (r.effective_from) startsOn.set(dayOf(r.effective_from), [...(startsOn.get(dayOf(r.effective_from)) ?? []), r]);

  const positions = rows.map((r) => {
    const from = dayOf(r.effective_from);
    const to = dayOf(r.effective_to);
    const over = r.status === 'ENDED' || (to != null && to < asOf);
    const state = over ? 'ENDED' : (from != null && from > asOf ? 'COMING' : 'CURRENT');
    let ended = null;
    if (over) {
      const next = to ? (startsOn.get(addDays(to, 1)) ?? []).find((n) => n.id !== r.id) : null;
      if (to && leftOn.has(to) && employee.employment_status === 'EXITED') {
        ended = { how: 'LEFT', label: 'Left the company', on: to };
      } else if (next) {
        const where = next.position_code ?? next.position_title ?? next.role_title ?? null;
        ended = { how: 'MOVED', label: where ? `Moved to ${where}` : 'Moved to another position', on: to, movedToPositionCode: next.position_code ?? null };
      } else {
        ended = { how: 'ENDED', label: 'Ended', on: to };
      }
    }
    return {
      assignmentId: r.id,
      positionId: r.position_id ?? null,
      positionCode: r.position_code ?? null,
      positionTitle: r.position_title ?? null,
      roleId: r.role_id ?? null,
      roleTitle: r.role_title ?? null,
      roleCode: r.role_code ?? null,
      departmentId: r.department_id ?? null,
      departmentName: r.department_name ?? null,
      locationName: r.location_name ?? null,
      shift: r.shift_code == null && r.shift_name == null ? null
        : { id: r.default_shift_id ?? null, code: r.shift_code ?? null, name: r.shift_name ?? null, summary: summaryFromRow(r, 'shift_') },
      from,
      to,
      isMain: Boolean(r.is_primary),
      state,
      ended,
      reason: r.reason ?? null,
    };
  });
  const left = employee.employment_status === 'EXITED';
  return {
    employee: { id: employee.id, code: employee.employee_code, name: employee.full_name, status: employee.employment_status },
    positions,
    current: positions.filter((p) => p.state === 'CURRENT').map((p) => p.assignmentId),
    can: { move: !left, addSecond: !left },
  };
}

/**
 * POST /people/employees/:id/move  { positionId, effectiveFrom?, keepCurrent? }
 *
 * Returns { moved: { assignmentId, positionId, positionCode, from, endedAssignmentId, endedOn, keptCurrent }, ...positionsHeld }.
 */
export async function moveEmployee(db, c, employeeId, body = {}, requestId = null) {
  const { companyId } = c;
  const employee = await requireEmployee(db, companyId, employeeId, { lock: true });
  if (employee.employment_status === 'EXITED') {
    throw conflict('EMPLOYEE_LEFT', `${employee.full_name} has left the company and cannot be given new work.`, { detail: { employeeId } });
  }

  const problems = [];
  const positionId = Number(body.positionId);
  if (!Number.isInteger(positionId) || positionId <= 0) problems.push('Choose the position to move to.');
  let from = todayText();
  if (body.effectiveFrom != null && body.effectiveFrom !== '') {
    const text = String(body.effectiveFrom).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) problems.push('The start date must be a date as YYYY-MM-DD.');
    else from = text;
  }
  if (body.keepCurrent !== undefined && ![true, false, 0, 1, '0', '1', 'true', 'false'].includes(body.keepCurrent)) problems.push('Keep the current position: yes or no.');
  if (problems.length) throw invalid('INVALID', problems[0], { problems });
  const keepCurrent = [true, 1, '1', 'true'].includes(body.keepCurrent);

  const [[position]] = await db.query(
    `SELECT p.id, p.position_code, p.role_id, p.department_id, p.location_id, p.default_shift_id, p.status,
            COALESCE(p.position_title, r.title) AS title
       FROM hrms_positions p LEFT JOIN hrms_roles r ON r.company_id = p.company_id AND r.id = p.role_id
      WHERE p.company_id = ? AND p.id = ? AND p.deleted_at IS NULL`,
    [companyId, positionId],
  );
  if (!position) throw notFound('Position');
  const positionName = `${position.title ?? 'that position'}${position.position_code ? ` (${position.position_code})` : ''}`;
  if (position.status === 'CLOSED') throw conflict('POSITION_CLOSED', `${positionName} is closed. Reopen it first, or choose another position.`);

  // What the person holds on the day the new position starts.
  const [held] = await db.query(
    `SELECT wa.id, wa.position_id, wa.is_primary, wa.effective_from, wa.effective_to, p.position_code
       FROM hrms_work_assignments wa
       LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id
      WHERE wa.company_id = ? AND wa.employee_id = ? AND wa.deleted_at IS NULL AND wa.status <> 'ENDED'
        AND (wa.effective_to IS NULL OR wa.effective_to >= ?)
      ORDER BY wa.is_primary DESC, wa.effective_from DESC, wa.id DESC
      FOR UPDATE`,
    [companyId, employeeId, from],
  );
  if (held.some((h) => h.position_id === positionId)) {
    throw conflict('ALREADY_THERE', `${employee.full_name} is already in ${positionName}.`);
  }
  // The position that ends: the main one, else the only one. `fromAssignmentId` names it when a person holds two.
  let leaving = null;
  if (!keepCurrent && held.length) {
    if (body.fromAssignmentId != null && body.fromAssignmentId !== '') {
      leaving = held.find((h) => h.id === Number(body.fromAssignmentId)) ?? null;
      if (!leaving) throw invalid('INVALID', 'The position to move from is not one this person holds on that date.');
    } else {
      leaving = held[0];
    }
    const started = dayOf(leaving.effective_from);
    if (started && started >= from) {
      throw invalid('INVALID', `${employee.full_name} started in ${leaving.position_code ?? 'the current position'} on ${longDay(started)}. The move must be on a later date.`, {
        problems: [`The current position started on ${longDay(started)}. Choose a later date for the move.`],
      });
    }
  }
  const hasMain = held.some((h) => h.is_primary && h.id !== leaving?.id);

  const endedOn = leaving ? addDays(from, -1) : null;
  const later = from > todayText();
  // Everything that can refuse the move is asked BEFORE anything is written, so a refusal moves nobody —
  // also for a caller that catches it and carries on in the same transaction.
  await assertNoOpenHiring(db, companyId, positionId);
  await assertPositionFree(db, companyId, positionId, { from, to: null });
  // The old one first, so the new main position does not meet the old one on the same day.
  if (leaving && later) await updateAssignment(db, c, leaving.id, { effectiveTo: endedOn });
  else if (leaving) await endAssignment(db, c, leaving.id, { effectiveTo: endedOn });

  const { assignment } = await createAssignment(db, c, {
    employeeId,
    roleId: position.role_id,
    positionId,
    departmentId: position.department_id,
    locationId: position.location_id,
    defaultShiftId: position.default_shift_id,
    isPrimary: !hasMain,
    // ACTIVE with a start date, as an appointment through hiring is: the dates say when.
    status: 'ACTIVE',
    effectiveFrom: from,
    reason: keepCurrent ? 'A second position' : (leaving ? `Moved from ${leaving.position_code ?? 'another position'}` : 'Put in this position'),
  });

  await audit(db, c, 'hrms_work_assignments', assignment.id, 'CREATE', leaving ? { endedAssignmentId: leaving.id, endedOn } : null,
    { employeeId, positionId, positionCode: position.position_code ?? null, effectiveFrom: from, keepCurrent, by: 'MOVE' }, requestId);
  await createEvent(db, c, employeeId, {
    eventType: 'ASSIGNMENT_CHANGE',
    eventDate: from,
    summary: keepCurrent
      ? `Also given ${positionName}.`
      : (leaving ? `Moved from ${leaving.position_code ?? 'another position'} to ${positionName}.` : `Put in ${positionName}.`),
    details: { positionId, fromAssignmentId: leaving?.id ?? null, keepCurrent },
    workAssignmentId: assignment.id,
  }, requestId);

  return {
    moved: {
      assignmentId: assignment.id,
      positionId,
      positionCode: position.position_code ?? null,
      from,
      endedAssignmentId: leaving?.id ?? null,
      endedOn,
      keptCurrent: keepCurrent,
    },
    ...(await positionsHeld(db, companyId, employeeId)),
  };
}

export default { positionsHeld, moveEmployee };
