/**
 * assignmentService.js — work assignments, their contexts, their ACTUAL
 * reporting and their content overlays. (Plan §5.6, §7.)
 *
 * THE WORK ASSIGNMENT IS THE CENTRE OF THIS APP. Not the employee row, not the
 * org chart box. It is the record of what one person is actually doing now:
 * one employee, one required Role, an OPTIONAL Position, an allocation, a
 * department/location, work contexts, a default shift, effective dates — and
 * its own set of managers.
 *
 * FOUR THINGS THIS FILE EXISTS TO PROTECT
 *
 * 1. Position is optional; Role is required. An SME has real responsibilities
 *    long before it writes down sanctioned seats. A screen or a service that
 *    demands a position is modelling a company that does not exist yet.
 *
 * 2. One employee, many concurrent assignments. Nothing here is keyed on "the"
 *    assignment. `is_primary` picks one for display and defaults; it does not
 *    make the others lesser.
 *
 * 3. `allocation_percent` is ADVISORY. It is reported and an overload is
 *    flagged, and it is never a reason to refuse a write. A company may decide
 *    its people are 130% committed; that is a fact about the company, and an
 *    HRMS that hides it by refusing the row is worse than useless.
 *
 * 4. Reporting is orthogonal to Role (v1.1 §13, taxonomy §17). A second manager
 *    is another ROW on the same assignment — never a second Role, Position or
 *    Work Assignment. Partial authority is a SCOPE on the row. A new assignment
 *    is created only when the WORK is materially distinct. `reportingResolver.js`
 *    is the only place that resolves the set, and it never flattens it.
 *
 * SERVICE RULES (TiDB has no CHECK constraints and none of these fit one):
 *   - role_id is validated against positions.role_id when a position is named,
 *     unless `allowRoleException: true` is passed with a reason;
 *   - an employee holds at most one is_primary assignment at a time;
 *   - at most one live relationship of a type whose allow_multiple = 0;
 *   - a manager may not be the assignment itself, nor another assignment of the
 *     same employee, nor the employee themselves;
 *   - exactly one definition FK on an override row, agreeing with content_type;
 *   - effective-dated rows are ENDED, not overwritten;
 *   - ending an assignment ENDS its reporting rows and context links rather
 *     than deleting them.
 */
import { notFound, conflict, assertNoProblems } from '../lib/errors.js';
import {
  dateText, today, blank, bool, readDate, readText, readEnum, readInt,
  previousDay, LIVE_ON, SCOPE_TYPES,
  readContentOverride, shapeOverride,
} from './positionService.js';
import { assignmentRelationships, resolveReporting } from './reportingResolver.js';

export const ASSIGNMENT_STATUSES = ['PLANNED', 'ACTIVE', 'SUSPENDED', 'ENDED'];
/** Statuses that put a person on the job today. ENDED and PLANNED do not. */
const LIVE_STATUSES = ['ACTIVE', 'SUSPENDED'];

async function exists(db, companyId, table, id, label, problems) {
  if (id == null) return null;
  const [[row]] = await db.query(`SELECT * FROM ${table} WHERE company_id = ? AND id = ? AND deleted_at IS NULL`, [companyId, id]);
  if (!row) problems.push(`That ${label} does not exist in this company.`);
  return row ?? null;
}

export async function requireAssignment(db, companyId, id, { lock = false } = {}) {
  const [[a]] = await db.query(
    `SELECT * FROM hrms_work_assignments WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, id],
  );
  if (!a) throw notFound('Work assignment');
  return a;
}

/* ══════════════════════════════════════════════════════════════════════════
 * Reading assignments
 * ══════════════════════════════════════════════════════════════════════════ */

const ASSIGNMENT_SELECT = `
  SELECT wa.*,
         e.employee_code, e.full_name, e.employment_status,
         r.role_code, r.title AS role_title,
         p.position_code, COALESCE(p.position_title, pr.title) AS position_title, p.role_id AS position_role_id,
         d.name AS department_name, l.name AS location_name,
         s.code AS shift_code, s.name AS shift_name,
         (SELECT COUNT(*) FROM hrms_assignment_reporting_relationships ar
           WHERE ar.company_id = wa.company_id AND ar.work_assignment_id = wa.id AND ar.deleted_at IS NULL
             AND (ar.effective_from IS NULL OR ar.effective_from <= ?)
             AND (ar.effective_to IS NULL OR ar.effective_to >= ?)) AS actual_manager_count,
         (SELECT COUNT(*) FROM hrms_position_reporting_relationships rr
           WHERE rr.company_id = wa.company_id AND rr.from_position_id = wa.position_id AND rr.deleted_at IS NULL
             AND (rr.effective_from IS NULL OR rr.effective_from <= ?)
             AND (rr.effective_to IS NULL OR rr.effective_to >= ?)) AS formal_manager_count,
         (SELECT COUNT(*) FROM hrms_work_assignment_contexts wc
           WHERE wc.company_id = wa.company_id AND wc.work_assignment_id = wa.id AND wc.deleted_at IS NULL) AS context_count,
         (SELECT COUNT(*) FROM hrms_work_assignment_content_overrides o
           WHERE o.company_id = wa.company_id AND o.work_assignment_id = wa.id AND o.deleted_at IS NULL) AS override_count
    FROM hrms_work_assignments wa
    JOIN hrms_employees e ON e.company_id = wa.company_id AND e.id = wa.employee_id
    LEFT JOIN hrms_roles r ON r.company_id = wa.company_id AND r.id = wa.role_id
    LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id
    LEFT JOIN hrms_roles pr ON pr.company_id = wa.company_id AND pr.id = p.role_id
    LEFT JOIN hrms_departments d ON d.company_id = wa.company_id AND d.id = wa.department_id
    LEFT JOIN hrms_locations l ON l.company_id = wa.company_id AND l.id = wa.location_id
    LEFT JOIN hrms_shifts s ON s.company_id = wa.company_id AND s.id = wa.default_shift_id`;

function shapeAssignment(a, on) {
  const actual = Number(a.actual_manager_count ?? 0);
  const formal = Number(a.formal_manager_count ?? 0);
  return {
    id: a.id,
    employeeId: a.employee_id,
    employeeCode: a.employee_code,
    employeeName: a.full_name,
    employmentStatus: a.employment_status ?? null,
    roleId: a.role_id,
    roleCode: a.role_code ?? null,
    roleTitle: a.role_title ?? null,
    positionId: a.position_id ?? null,
    positionCode: a.position_code ?? null,
    positionTitle: a.position_title ?? null,
    // True when the assignment's role differs from the seat's role. Recorded,
    // not hidden: it means someone took an explicit exception, and the JD will
    // come from the assignment's role, not the position's.
    roleDiffersFromPosition: a.position_id != null && a.position_role_id != null && a.position_role_id !== a.role_id,
    departmentId: a.department_id ?? null,
    departmentName: a.department_name ?? null,
    locationId: a.location_id ?? null,
    locationName: a.location_name ?? null,
    assignmentTitle: a.assignment_title ?? null,
    allocationPercent: a.allocation_percent == null ? null : Number(a.allocation_percent),
    isPrimary: Boolean(a.is_primary),
    defaultShiftId: a.default_shift_id ?? null,
    shiftCode: a.shift_code ?? null,
    shiftName: a.shift_name ?? null,
    status: a.status,
    effectiveFrom: dateText(a.effective_from),
    effectiveTo: dateText(a.effective_to),
    reason: a.reason ?? null,
    // Counts, not managers. The resolved SET always comes from reportingResolver.
    actualManagerCount: actual,
    inheritedManagerCount: formal,
    managerCount: actual + formal,
    hasNoManager: actual + formal === 0,
    contextCount: Number(a.context_count ?? 0),
    overrideCount: Number(a.override_count ?? 0),
    liveOnDate: LIVE_STATUSES.includes(a.status)
      && (!a.effective_from || dateText(a.effective_from) <= on)
      && (!a.effective_to || dateText(a.effective_to) >= on),
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

/**
 * Allocation totals per employee, over ALL their live assignments — not just
 * the ones this filter shows. A total computed from a filtered list would tell
 * a manager their fitter is 60% committed when the other 65% is simply on
 * another page, which is exactly the wrong answer.
 */
async function allocationTotals(db, companyId, employeeIds, on) {
  if (!employeeIds.length) return new Map();
  const [rows] = await db.query(
    `SELECT employee_id, SUM(COALESCE(allocation_percent, 0)) AS total, COUNT(*) AS n
       FROM hrms_work_assignments
      WHERE company_id = ? AND deleted_at IS NULL AND status IN ('ACTIVE','SUSPENDED')
        AND employee_id IN (${employeeIds.map(() => '?').join(',')})
        AND (effective_from IS NULL OR effective_from <= ?)
        AND (effective_to IS NULL OR effective_to >= ?)
      GROUP BY employee_id`,
    [companyId, ...employeeIds, on, on],
  );
  return new Map(rows.map((r) => [r.employee_id, { total: Number(r.total), assignments: Number(r.n) }]));
}

export async function listAssignments(db, companyId, query = {}) {
  const on = dateText(query.on) || today();
  const where = ['wa.company_id = ?', 'wa.deleted_at IS NULL'];
  const params = [on, on, on, on, companyId];

  if (!blank(query.status)) {
    const statuses = String(query.status).split(',').map((s) => s.trim().toUpperCase()).filter((s) => ASSIGNMENT_STATUSES.includes(s));
    if (statuses.length) { where.push(`wa.status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses); }
  }
  for (const [key, col] of [
    ['employeeId', 'wa.employee_id'], ['roleId', 'wa.role_id'], ['positionId', 'wa.position_id'],
    ['departmentId', 'wa.department_id'], ['locationId', 'wa.location_id'], ['shiftId', 'wa.default_shift_id'],
  ]) {
    if (!blank(query[key])) { where.push(`${col} = ?`); params.push(Number(query[key])); }
  }
  if (bool(query.noPosition)) where.push('wa.position_id IS NULL');
  if (bool(query.primaryOnly)) where.push('wa.is_primary = 1');
  if (bool(query.liveOnly)) {
    where.push(`wa.status IN ('ACTIVE','SUSPENDED') AND ${LIVE_ON('wa')}`);
    params.push(on, on);
  }
  if (!blank(query.search)) {
    where.push('(e.full_name LIKE ? OR e.employee_code LIKE ? OR r.title LIKE ? OR wa.assignment_title LIKE ? OR p.position_code LIKE ?)');
    const like = `%${String(query.search).trim()}%`;
    params.push(like, like, like, like, like);
  }

  const [rows] = await db.query(
    `${ASSIGNMENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.full_name, wa.is_primary DESC, wa.effective_from DESC`,
    params,
  );
  const items = rows.map((a) => shapeAssignment(a, on));

  const totals = await allocationTotals(db, companyId, [...new Set(items.map((i) => i.employeeId))], on);
  for (const i of items) {
    const t = totals.get(i.employeeId);
    i.employeeAllocationTotal = t ? t.total : 0;
    i.employeeAssignmentCount = t ? t.assignments : 0;
    // Advisory. A flag, never a refusal — see the header comment.
    i.employeeOverAllocated = t ? t.total > 100 : false;
  }

  const overAllocatedEmployees = [...totals.entries()].filter(([, t]) => t.total > 100).length;
  return {
    asOf: on,
    items,
    total: items.length,
    totals: {
      assignments: items.length,
      live: items.filter((i) => i.liveOnDate).length,
      noManager: items.filter((i) => i.hasNoManager).length,
      noPosition: items.filter((i) => i.positionId == null).length,
      overAllocatedEmployees,
      roleDiffersFromPosition: items.filter((i) => i.roleDiffersFromPosition).length,
    },
  };
}

export async function getAssignment(db, companyId, id, query = {}) {
  const on = dateText(query.on) || today();
  const [[row]] = await db.query(`${ASSIGNMENT_SELECT} WHERE wa.company_id = ? AND wa.id = ? AND wa.deleted_at IS NULL`, [on, on, on, on, companyId, id]);
  if (!row) throw notFound('Work assignment');
  const assignment = shapeAssignment(row, on);
  const totals = await allocationTotals(db, companyId, [assignment.employeeId], on);
  const t = totals.get(assignment.employeeId);
  assignment.employeeAllocationTotal = t ? t.total : 0;
  assignment.employeeAssignmentCount = t ? t.assignments : 0;
  assignment.employeeOverAllocated = t ? t.total > 100 : false;

  // Sibling assignments: the whole point of this model is that a person has
  // more than one, so the record shows them without a second round trip.
  const [siblings] = await db.query(
    `SELECT wa.id, wa.role_id, r.title AS role_title, wa.position_id, wa.assignment_title,
            wa.allocation_percent, wa.is_primary, wa.status, wa.effective_from, wa.effective_to
       FROM hrms_work_assignments wa
       LEFT JOIN hrms_roles r ON r.company_id = wa.company_id AND r.id = wa.role_id
      WHERE wa.company_id = ? AND wa.employee_id = ? AND wa.deleted_at IS NULL AND wa.id <> ?
      ORDER BY wa.is_primary DESC, wa.effective_from DESC`,
    [companyId, assignment.employeeId, id],
  );
  return {
    asOf: on,
    assignment,
    siblingAssignments: siblings.map((s) => ({
      id: s.id,
      roleId: s.role_id,
      roleTitle: s.role_title,
      positionId: s.position_id,
      assignmentTitle: s.assignment_title,
      allocationPercent: s.allocation_percent == null ? null : Number(s.allocation_percent),
      isPrimary: Boolean(s.is_primary),
      status: s.status,
      effectiveFrom: dateText(s.effective_from),
      effectiveTo: dateText(s.effective_to),
    })),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Writing assignments
 * ══════════════════════════════════════════════════════════════════════════ */

async function readAssignmentBody(db, companyId, body, { partial = false, current = null } = {}) {
  const problems = [];
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  let employeeId = current?.employee_id ?? null;
  if (!partial || has('employeeId')) {
    employeeId = readInt(body.employeeId, 'Employee', problems);
    if (employeeId == null && !partial) problems.push('Choose the person this assignment is for.');
    if (employeeId != null) {
      const emp = await exists(db, companyId, 'hrms_employees', employeeId, 'employee', problems);
      if (emp && emp.employment_status === 'EXITED') {
        problems.push(`${emp.full_name} has exited. Record historical work with effective dates on an existing assignment rather than opening a new one.`);
      }
      out.employee_id = employeeId;
    }
  }

  let roleId = current?.role_id ?? null;
  if (!partial || has('roleId')) {
    roleId = readInt(body.roleId, 'Role', problems);
    // Non-negotiable 5: Role is REQUIRED. Position is not.
    if (roleId == null) problems.push('A work assignment needs a role — that is what says which work this is.');
    if (roleId != null) { await exists(db, companyId, 'hrms_roles', roleId, 'role', problems); out.role_id = roleId; }
  }

  let positionId = current?.position_id ?? null;
  if (!partial || has('positionId')) {
    positionId = readInt(body.positionId, 'Position', problems);
    out.position_id = positionId;
  }

  // Spec rule: "if position_id is present, validate role_id against
  // positions.role_id unless an explicit exception is supported." The exception
  // is supported, and it must be asked for out loud.
  if (positionId != null) {
    const pos = await exists(db, companyId, 'hrms_positions', positionId, 'position', problems);
    if (pos) {
      if (pos.status === 'CLOSED') problems.push('That position is closed. Reopen it, or leave the position blank — a position is optional.');
      if (roleId != null && pos.role_id !== roleId && !bool(body.allowRoleException)) {
        problems.push(
          'This assignment\'s role is not the role that position sanctions. If that is deliberate, resend with allowRoleException and a reason; otherwise pick the position\'s role.',
        );
      }
      if (roleId != null && pos.role_id !== roleId && bool(body.allowRoleException) && blank(body.reason) && blank(current?.reason)) {
        problems.push('A role exception needs a reason, so the next person to read this row knows why.');
      }
    }
  }

  for (const [key, col, table, label] of [
    ['departmentId', 'department_id', 'hrms_departments', 'department'],
    ['locationId', 'location_id', 'hrms_locations', 'location'],
    ['defaultShiftId', 'default_shift_id', 'hrms_shifts', 'shift'],
  ]) {
    if (!partial || has(key)) {
      const v = readInt(body[key], label, problems);
      if (v != null) await exists(db, companyId, table, v, label, problems);
      out[col] = v;
    }
  }

  if (!partial || has('assignmentTitle')) out.assignment_title = readText(body.assignmentTitle, 'Assignment title', 200, problems);
  if (!partial || has('reason')) out.reason = readText(body.reason, 'Reason', 300, problems);

  if (!partial || has('allocationPercent')) {
    const raw = body.allocationPercent;
    if (blank(raw)) out.allocation_percent = null;
    else {
      const n = Number(raw);
      // Advisory, so the only refusals are values that cannot mean anything.
      if (!Number.isFinite(n) || n < 0) problems.push('Allocation cannot be negative.');
      else if (n > 999.99) problems.push('Allocation is recorded as a percentage, up to 999.99.');
      else out.allocation_percent = n;
    }
  }

  if (!partial || has('status')) out.status = readEnum(body.status, 'Status', ASSIGNMENT_STATUSES, problems, current?.status ?? 'ACTIVE');
  if (!partial || has('effectiveFrom')) {
    out.effective_from = readDate(body.effectiveFrom, 'Effective from', problems) ?? (partial ? undefined : today());
    if (out.effective_from === undefined) delete out.effective_from;
  }
  if (!partial || has('effectiveTo')) out.effective_to = readDate(body.effectiveTo, 'Effective to', problems);

  const from = out.effective_from ?? dateText(current?.effective_from) ?? null;
  const to = (has('effectiveTo') || !partial) ? out.effective_to : dateText(current?.effective_to);
  if (from && to && to < from) problems.push('Effective to cannot be before effective from.');

  if (!partial || has('isPrimary')) out.is_primary = bool(body.isPrimary, Boolean(current?.is_primary)) ? 1 : 0;

  assertNoProblems(problems);
  return { data: out, employeeId, effectiveFrom: from, effectiveTo: to };
}

/**
 * One primary assignment per employee at a time. Refused rather than silently
 * applied, because demoting someone's primary job is a decision, not a side
 * effect — `demoteOther: true` performs it explicitly in the same transaction.
 */
async function assertOnePrimary(db, companyId, employeeId, effectiveFrom, effectiveTo, excludeId, demoteOther) {
  const params = [companyId, employeeId, effectiveTo ?? '9999-12-31', effectiveFrom ?? '0001-01-01'];
  let sql = `SELECT wa.id, r.title AS role_title, wa.effective_from, wa.effective_to
               FROM hrms_work_assignments wa
               LEFT JOIN hrms_roles r ON r.company_id = wa.company_id AND r.id = wa.role_id
              WHERE wa.company_id = ? AND wa.employee_id = ? AND wa.deleted_at IS NULL
                AND wa.is_primary = 1 AND wa.status <> 'ENDED'
                AND (wa.effective_from IS NULL OR wa.effective_from <= ?)
                AND (wa.effective_to IS NULL OR wa.effective_to >= ?)`;
  if (excludeId) { sql += ' AND wa.id <> ?'; params.push(excludeId); }
  const [rows] = await db.query(sql, params);
  if (!rows.length) return;
  if (demoteOther) {
    await db.query(
      `UPDATE hrms_work_assignments SET is_primary = 0 WHERE company_id = ? AND id IN (${rows.map(() => '?').join(',')})`,
      [companyId, ...rows.map((r) => r.id)],
    );
    return;
  }
  throw conflict(
    'PRIMARY_EXISTS',
    'This person already has a primary assignment covering these dates. A person has many assignments but only one primary — send demoteOther to move the flag, or leave this one non-primary.',
    { problems: rows.map((r) => `Assignment #${r.id}${r.role_title ? ` (${r.role_title})` : ''} is primary from ${dateText(r.effective_from) ?? 'the start'}${r.effective_to ? ` to ${dateText(r.effective_to)}` : ''}.`) },
  );
}

export async function createAssignment(db, { companyId, userId }, body) {
  const { data, employeeId, effectiveFrom, effectiveTo } = await readAssignmentBody(db, companyId, body);
  if (data.is_primary) await assertOnePrimary(db, companyId, employeeId, effectiveFrom, effectiveTo, null, bool(body.demoteOther));

  // `replacesId` is the honest way to change work that is already live: the old
  // assignment is ENDED the day before the new one starts and the new one is
  // inserted, in one transaction. History keeps both (plan §2 rule 8).
  const replacesId = readInt(body.replacesId, 'Replaces', []);
  if (replacesId) {
    await endAssignment(db, { companyId }, replacesId, { effectiveTo: previousDay(data.effective_from ?? today()) });
  }

  const cols = { company_id: companyId, created_by: userId, ...data };
  const keys = Object.keys(cols);
  const [res] = await db.query(
    `INSERT INTO hrms_work_assignments (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((k) => cols[k]),
  );

  // Contexts may arrive with the assignment — a helper covering four machines
  // is one assignment with four context rows, and making that two requests
  // invites the second one to be forgotten.
  if (Array.isArray(body.workContextIds)) {
    for (const ctxId of body.workContextIds) {
      await addAssignmentContext(db, { companyId, userId }, res.insertId, { workContextId: ctxId });
    }
  }
  return getAssignment(db, companyId, res.insertId);
}

/**
 * Editable: title, allocation, department, location, shift, reason, status,
 * end date, primary flag.
 *
 * NOT editable on a live assignment: employee, role, position, start date.
 * Those say WHAT WORK THIS IS — changing one means the person moved to
 * different work, which is a new assignment with its own dates, not a silent
 * rewrite of history. The refusal says so and points at `replacesId`.
 */
export async function updateAssignment(db, { companyId }, id, body) {
  const current = await requireAssignment(db, companyId, id, { lock: true });
  const problems = [];
  const locked = current.status !== 'PLANNED';
  for (const [key, col, what] of [
    ['employeeId', 'employee_id', 'the person'],
    ['roleId', 'role_id', 'the role'],
    ['positionId', 'position_id', 'the position'],
    ['effectiveFrom', 'effective_from', 'the start date'],
  ]) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const given = key === 'effectiveFrom' ? dateText(body[key]) : (blank(body[key]) ? null : Number(body[key]));
    const currentValue = key === 'effectiveFrom' ? dateText(current[col]) : current[col];
    if (String(given ?? '') !== String(currentValue ?? '') && locked) {
      problems.push(`Changing ${what} makes this a different piece of work. End this assignment and create the new one — send replacesId and history keeps both.`);
    }
  }
  assertNoProblems(problems);

  const { data, employeeId, effectiveFrom, effectiveTo } = await readAssignmentBody(db, companyId, body, { partial: true, current });
  if (data.is_primary) {
    await assertOnePrimary(db, companyId, employeeId ?? current.employee_id, effectiveFrom, effectiveTo, id, bool(body.demoteOther));
  }
  const keys = Object.keys(data);
  if (keys.length) {
    await db.query(
      `UPDATE hrms_work_assignments SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...keys.map((k) => data[k]), companyId, id],
    );
  }
  return getAssignment(db, companyId, id);
}

export async function setAssignmentStatus(db, ctxIds, id, status) {
  const { companyId } = ctxIds;
  await requireAssignment(db, companyId, id, { lock: true });
  const problems = [];
  const next = readEnum(status, 'Status', ASSIGNMENT_STATUSES, problems);
  assertNoProblems(problems);
  if (next === 'ENDED') return endAssignment(db, ctxIds, id, {});
  await db.query('UPDATE hrms_work_assignments SET status = ? WHERE company_id = ? AND id = ?', [next, companyId, id]);
  return getAssignment(db, companyId, id);
}

/**
 * Ending an assignment ENDS its reporting rows and its context links — it does
 * not delete them. Someone reading the history a year from now needs to see
 * that this person reported to that manager while this work was live; a deleted
 * row makes the past look empty rather than finished.
 */
export async function endAssignment(db, { companyId }, id, body = {}) {
  const current = await requireAssignment(db, companyId, id, { lock: true });
  const problems = [];
  const effectiveTo = readDate(body.effectiveTo, 'Effective to', problems) ?? today();
  if (dateText(current.effective_from) && effectiveTo < dateText(current.effective_from)) {
    problems.push('An assignment cannot end before it started.');
  }
  assertNoProblems(problems);

  await db.query(
    "UPDATE hrms_work_assignments SET status = 'ENDED', effective_to = ? WHERE company_id = ? AND id = ?",
    [effectiveTo, companyId, id],
  );
  const [rel] = await db.query(
    `UPDATE hrms_assignment_reporting_relationships SET effective_to = ?
      WHERE company_id = ? AND work_assignment_id = ? AND deleted_at IS NULL
        AND (effective_to IS NULL OR effective_to > ?)`,
    [effectiveTo, companyId, id, effectiveTo],
  );
  const [ctxs] = await db.query(
    `UPDATE hrms_work_assignment_contexts SET effective_to = ?
      WHERE company_id = ? AND work_assignment_id = ? AND deleted_at IS NULL
        AND (effective_to IS NULL OR effective_to > ?)`,
    [effectiveTo, companyId, id, effectiveTo],
  );
  return {
    ok: true,
    id,
    effectiveTo,
    endedReportingRows: rel.affectedRows,
    endedContextLinks: ctxs.affectedRows,
  };
}

/** For a row created by mistake. Anything real is ENDED instead. */
export async function deleteAssignment(db, { companyId }, id) {
  const current = await requireAssignment(db, companyId, id, { lock: true });
  if (current.status === 'ACTIVE' && dateText(current.effective_from) && dateText(current.effective_from) < today()) {
    throw conflict('IN_USE', 'This assignment has already been live. End it instead of deleting it — attendance, rosters and generated documents reference it.');
  }
  await db.query('UPDATE hrms_work_assignments SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [companyId, id]);
  for (const t of ['hrms_assignment_reporting_relationships', 'hrms_work_assignment_contexts', 'hrms_work_assignment_content_overrides']) {
    await db.query(`UPDATE ${t} SET deleted_at = NOW() WHERE company_id = ? AND work_assignment_id = ? AND deleted_at IS NULL`, [companyId, id]);
  }
  return { ok: true, deleted: id };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Assignment work contexts
 * ══════════════════════════════════════════════════════════════════════════ */

export async function listAssignmentContexts(db, companyId, assignmentId) {
  await requireAssignment(db, companyId, assignmentId);
  const [rows] = await db.query(
    `SELECT c.*, wc.name AS context_name, wc.code AS context_code, wc.context_type
       FROM hrms_work_assignment_contexts c
       JOIN hrms_work_contexts wc ON wc.company_id = c.company_id AND wc.id = c.work_context_id
      WHERE c.company_id = ? AND c.work_assignment_id = ? AND c.deleted_at IS NULL
      ORDER BY c.is_primary DESC, wc.name`,
    [companyId, assignmentId],
  );
  return {
    items: rows.map((r) => ({
      id: r.id,
      workAssignmentId: r.work_assignment_id,
      workContextId: r.work_context_id,
      workContextName: r.context_name,
      workContextCode: r.context_code,
      contextType: r.context_type,
      isPrimary: Boolean(r.is_primary),
      effectiveFrom: dateText(r.effective_from),
      effectiveTo: dateText(r.effective_to),
      notes: r.notes ?? null,
    })),
    total: rows.length,
  };
}

export async function addAssignmentContext(db, { companyId, userId }, assignmentId, body) {
  await requireAssignment(db, companyId, assignmentId);
  const problems = [];
  const workContextId = readInt(body.workContextId, 'Work context', problems);
  if (workContextId == null) problems.push('Choose the machine, line, area or project this work covers.');
  if (workContextId != null) await exists(db, companyId, 'hrms_work_contexts', workContextId, 'work context', problems);
  const effectiveFrom = readDate(body.effectiveFrom, 'Effective from', problems);
  const effectiveTo = readDate(body.effectiveTo, 'Effective to', problems);
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) problems.push('Effective to cannot be before effective from.');
  assertNoProblems(problems);

  if (bool(body.isPrimary)) {
    await db.query('UPDATE hrms_work_assignment_contexts SET is_primary = 0 WHERE company_id = ? AND work_assignment_id = ? AND deleted_at IS NULL AND is_primary = 1', [companyId, assignmentId]);
  }
  const [res] = await db.query(
    `INSERT INTO hrms_work_assignment_contexts
       (company_id, work_assignment_id, work_context_id, is_primary, effective_from, effective_to, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, assignmentId, workContextId, bool(body.isPrimary) ? 1 : 0, effectiveFrom, effectiveTo, readText(body.notes, 'Notes', 2000, []), userId],
  );
  return { ok: true, id: res.insertId };
}

export async function removeAssignmentContext(db, { companyId }, id) {
  const [res] = await db.query('UPDATE hrms_work_assignment_contexts SET deleted_at = NOW() WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!res.affectedRows) throw notFound('Assignment work context');
  return { ok: true, id };
}

/* ══════════════════════════════════════════════════════════════════════════
 * ACTUAL reporting — the matrix
 * ══════════════════════════════════════════════════════════════════════════
 * Reads go through reportingResolver.js. Writes live here.
 *
 * Adding a manager is deliberately CHEAP: no role, no position, no second
 * assignment. That is the whole point of v1.1 §13 — a company with a dotted
 * compliance line should reach for this, not invent a "Compliance Role".
 */

export { assignmentRelationships, resolveReporting };

async function requireRelationshipType(db, companyId, id, problems) {
  const [[t]] = await db.query('SELECT * FROM hrms_reporting_relationship_types WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!t) problems.push('That reporting relationship type does not exist in this company.');
  else if (t.status && t.status !== 'ACTIVE') problems.push(`${t.name} is inactive.`);
  return t ?? null;
}

export async function addAssignmentReporting(db, { companyId, userId }, assignmentId, body) {
  const assignment = await requireAssignment(db, companyId, assignmentId);
  const problems = [];

  const managerEmployeeId = readInt(body.managerEmployeeId, 'Manager', problems);
  if (managerEmployeeId == null) problems.push('Choose the manager — a person, never a machine or an area.');
  if (managerEmployeeId === assignment.employee_id) problems.push('A person cannot manage their own work. Choose someone else, or record this as a work context rather than a manager.');
  if (managerEmployeeId != null && managerEmployeeId !== assignment.employee_id) {
    await exists(db, companyId, 'hrms_employees', managerEmployeeId, 'employee', problems);
  }

  const managerWorkAssignmentId = readInt(body.managerWorkAssignmentId, 'Manager assignment', problems);
  if (managerWorkAssignmentId != null) {
    if (managerWorkAssignmentId === assignmentId) problems.push('An assignment cannot report to itself.');
    else {
      const ma = await exists(db, companyId, 'hrms_work_assignments', managerWorkAssignmentId, 'work assignment', problems);
      if (ma && managerEmployeeId != null && ma.employee_id !== managerEmployeeId) {
        problems.push('That assignment belongs to a different person from the manager named.');
      }
      if (ma && ma.employee_id === assignment.employee_id) {
        problems.push('That assignment belongs to the same person. Reporting to another of your own hats is not a reporting line.');
      }
    }
  }

  const relationshipTypeId = readInt(body.relationshipTypeId, 'Relationship type', problems);
  if (relationshipTypeId == null) problems.push('Choose a relationship type — primary, functional, administrative, dotted, project or shift.');
  const type = relationshipTypeId == null ? null : await requireRelationshipType(db, companyId, relationshipTypeId, problems);

  // Scope is what keeps partial authority from becoming a second job.
  const scopeType = readEnum(body.scopeType, 'Scope', SCOPE_TYPES, problems, 'GENERAL');
  const scopeLabel = readText(body.scopeLabel, 'Scope label', 250, problems);
  const scopeWorkContextId = readInt(body.scopeWorkContextId, 'Scope work context', problems);
  if (scopeWorkContextId != null) await exists(db, companyId, 'hrms_work_contexts', scopeWorkContextId, 'work context', problems);
  if (scopeType === 'WORK_CONTEXT' && scopeWorkContextId == null) problems.push('A WORK_CONTEXT scope needs the machine, line or area it applies to.');
  if (scopeType !== 'GENERAL' && blank(scopeLabel) && scopeWorkContextId == null) {
    problems.push('A scoped manager needs a label saying what they cover — "Statutory compliance", "Payroll", "Quality standards".');
  }
  if (scopeType === 'GENERAL' && !blank(scopeLabel)) {
    problems.push('A GENERAL scope covers the whole assignment, so it carries no label. Choose FUNCTION, RESPONSIBILITY, WORK_CONTEXT, PROJECT or OTHER.');
  }

  const effectiveFrom = readDate(body.effectiveFrom, 'Effective from', problems) ?? today();
  const effectiveTo = readDate(body.effectiveTo, 'Effective to', problems);
  if (effectiveTo && effectiveTo < effectiveFrom) problems.push('Effective to cannot be before effective from.');
  assertNoProblems(problems);

  const replacesId = readInt(body.replacesId, 'Replaces', []);
  if (replacesId) await endAssignmentReporting(db, { companyId }, replacesId, { effectiveTo: previousDay(effectiveFrom) });

  // allow_multiple = 0 means one LIVE row of that type. It does NOT make
  // reporting exclusive — a dotted or project row sits beside the primary.
  if (Number(type.allow_multiple) === 0) {
    const params = [companyId, assignmentId, type.id, effectiveTo ?? '9999-12-31', effectiveFrom];
    const [clash] = await db.query(
      `SELECT ar.id, e.full_name, ar.effective_from
         FROM hrms_assignment_reporting_relationships ar
         JOIN hrms_employees e ON e.company_id = ar.company_id AND e.id = ar.manager_employee_id
        WHERE ar.company_id = ? AND ar.work_assignment_id = ? AND ar.relationship_type_id = ? AND ar.deleted_at IS NULL
          AND (ar.effective_from IS NULL OR ar.effective_from <= ?)
          AND (ar.effective_to IS NULL OR ar.effective_to >= ?)`,
      params,
    );
    if (clash.length) {
      throw conflict('TYPE_NOT_MULTIPLE',
        `This assignment already has a live ${type.name} (${clash[0].full_name}). End that row first, or add this manager as a dotted, functional or project line instead — a second manager does not need a second role or a second assignment.`,
        { problems: clash.map((c) => `${type.name}: ${c.full_name}, from ${dateText(c.effective_from) ?? 'the start'} (row #${c.id}).`) });
    }
  }

  const [res] = await db.query(
    `INSERT INTO hrms_assignment_reporting_relationships
       (company_id, work_assignment_id, manager_employee_id, manager_work_assignment_id, relationship_type_id,
        is_primary, scope_type, scope_label, scope_work_context_id, scope_notes, effective_from, effective_to, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, assignmentId, managerEmployeeId, managerWorkAssignmentId, relationshipTypeId,
      bool(body.isPrimary, Number(type.allow_multiple) === 0) ? 1 : 0,
      scopeType, scopeLabel, scopeWorkContextId, readText(body.scopeNotes, 'Scope notes', 2000, []),
      effectiveFrom, effectiveTo, userId],
  );
  return { ok: true, id: res.insertId, replaced: replacesId ?? null };
}

/**
 * Only non-identity fields. Manager, type, scope type and start date make this
 * edge what it is; changing one is a different relationship and must be a new
 * row (plan §2 rule 8).
 */
export async function updateAssignmentReporting(db, { companyId }, id, body) {
  const [[row]] = await db.query('SELECT * FROM hrms_assignment_reporting_relationships WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [companyId, id]);
  if (!row) throw notFound('Reporting relationship');
  const problems = [];
  for (const [key, currentValue, what] of [
    ['managerEmployeeId', row.manager_employee_id, 'the manager'],
    ['relationshipTypeId', row.relationship_type_id, 'the relationship type'],
    ['scopeType', row.scope_type, 'the scope'],
    ['effectiveFrom', dateText(row.effective_from), 'the start date'],
  ]) {
    if (!Object.prototype.hasOwnProperty.call(body, key) || blank(body[key])) continue;
    const given = key === 'effectiveFrom' ? dateText(body[key]) : (key === 'scopeType' ? String(body[key]).toUpperCase() : Number(body[key]));
    if (String(given) !== String(currentValue)) {
      problems.push(`Changing ${what} makes this a different reporting line. End this one and add the new one — send replacesId and history keeps both.`);
    }
  }
  const sets = {};
  if (Object.prototype.hasOwnProperty.call(body, 'isPrimary')) sets.is_primary = bool(body.isPrimary) ? 1 : 0;
  if (Object.prototype.hasOwnProperty.call(body, 'scopeLabel')) sets.scope_label = readText(body.scopeLabel, 'Scope label', 250, problems);
  if (Object.prototype.hasOwnProperty.call(body, 'scopeNotes')) sets.scope_notes = readText(body.scopeNotes, 'Scope notes', 2000, problems);
  if (Object.prototype.hasOwnProperty.call(body, 'managerWorkAssignmentId')) {
    const maId = readInt(body.managerWorkAssignmentId, 'Manager assignment', problems);
    if (maId != null) {
      const ma = await exists(db, companyId, 'hrms_work_assignments', maId, 'work assignment', problems);
      if (ma && ma.employee_id !== row.manager_employee_id) problems.push('That assignment belongs to a different person from this row\'s manager.');
    }
    sets.manager_work_assignment_id = maId;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'effectiveTo')) {
    sets.effective_to = readDate(body.effectiveTo, 'Effective to', problems);
    if (sets.effective_to && dateText(row.effective_from) && sets.effective_to < dateText(row.effective_from)) {
      problems.push('A reporting line cannot end before it started.');
    }
  }
  assertNoProblems(problems);
  const keys = Object.keys(sets);
  if (keys.length) {
    await db.query(`UPDATE hrms_assignment_reporting_relationships SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`, [...keys.map((k) => sets[k]), companyId, id]);
  }
  return { ok: true, id };
}

export async function endAssignmentReporting(db, { companyId }, id, body = {}) {
  const [[row]] = await db.query('SELECT * FROM hrms_assignment_reporting_relationships WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [companyId, id]);
  if (!row) throw notFound('Reporting relationship');
  const problems = [];
  const effectiveTo = readDate(body.effectiveTo, 'Effective to', problems) ?? today();
  if (dateText(row.effective_from) && effectiveTo < dateText(row.effective_from)) problems.push('A reporting line cannot end before it started.');
  assertNoProblems(problems);
  await db.query('UPDATE hrms_assignment_reporting_relationships SET effective_to = ? WHERE company_id = ? AND id = ?', [effectiveTo, companyId, id]);
  return { ok: true, id, effectiveTo };
}

export async function removeAssignmentReporting(db, { companyId }, id) {
  const [res] = await db.query('UPDATE hrms_assignment_reporting_relationships SET deleted_at = NOW() WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!res.affectedRows) throw notFound('Reporting relationship');
  return { ok: true, id };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Assignment content overrides — layer 3, used sparingly
 * ══════════════════════════════════════════════════════════════════════════ */

export async function listAssignmentOverrides(db, companyId, assignmentId) {
  await requireAssignment(db, companyId, assignmentId);
  const [rows] = await db.query(
    `SELECT o.*, COALESCE(k.name, rs.name, kp.name) AS definition_name, pk.name AS parent_kra_name
       FROM hrms_work_assignment_content_overrides o
       LEFT JOIN hrms_kra_definitions            k  ON k.company_id  = o.company_id AND k.id  = o.kra_definition_id
       LEFT JOIN hrms_responsibility_definitions rs ON rs.company_id = o.company_id AND rs.id = o.responsibility_definition_id
       LEFT JOIN hrms_kpi_definitions            kp ON kp.company_id = o.company_id AND kp.id = o.kpi_definition_id
       LEFT JOIN hrms_kra_definitions            pk ON pk.company_id = o.company_id AND pk.id = o.parent_kra_definition_id
      WHERE o.company_id = ? AND o.work_assignment_id = ? AND o.deleted_at IS NULL
      ORDER BY o.content_type, o.action, o.id`,
    [companyId, assignmentId],
  );
  return { items: rows.map(shapeOverride), total: rows.length };
}

export async function addAssignmentOverride(db, { companyId, userId }, assignmentId, body) {
  await requireAssignment(db, companyId, assignmentId);
  const o = await readContentOverride(db, companyId, body);
  const [res] = await db.query(
    `INSERT INTO hrms_work_assignment_content_overrides
       (company_id, work_assignment_id, content_type, kra_definition_id, responsibility_definition_id, kpi_definition_id,
        action, parent_kra_definition_id, override_json, effective_from, effective_to, reason, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, assignmentId, o.contentType, o.kraDefinitionId, o.responsibilityDefinitionId, o.kpiDefinitionId,
      o.action, o.parentKraDefinitionId, o.overrideJson, o.effectiveFrom, o.effectiveTo, o.reason, userId],
  );
  return { ok: true, id: res.insertId };
}

export async function removeAssignmentOverride(db, { companyId }, id) {
  const [res] = await db.query('UPDATE hrms_work_assignment_content_overrides SET deleted_at = NOW() WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!res.affectedRows) throw notFound('Content override');
  return { ok: true, id };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Pickers
 * ══════════════════════════════════════════════════════════════════════════ */

export async function assignmentOptions(db, companyId, query = {}) {
  const on = dateText(query.on) || today();
  const q = (sql, params = [companyId]) => db.query(sql, params).then(([rows]) => rows);
  const [employees, roles, positions, departments, locations, shifts, contexts, types, kras, responsibilities, kpis] = await Promise.all([
    q("SELECT id, employee_code AS code, full_name AS name, employment_status AS status FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL AND employment_status <> 'EXITED' ORDER BY full_name"),
    q('SELECT id, role_code AS code, title AS name, status FROM hrms_roles WHERE company_id = ? AND deleted_at IS NULL ORDER BY title'),
    q(`SELECT p.id, p.position_code AS code, COALESCE(p.position_title, r.title) AS name,
              p.role_id AS roleId, r.title AS roleTitle, p.department_id AS departmentId,
              p.location_id AS locationId, p.default_shift_id AS defaultShiftId, p.status
         FROM hrms_positions p LEFT JOIN hrms_roles r ON r.company_id = p.company_id AND r.id = p.role_id
        WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status <> 'CLOSED' ORDER BY name`),
    q('SELECT id, code, name FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL ORDER BY name'),
    q('SELECT id, code, name FROM hrms_locations WHERE company_id = ? AND deleted_at IS NULL ORDER BY name'),
    q('SELECT id, code, name FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY code'),
    q('SELECT id, code, name, context_type AS contextType FROM hrms_work_contexts WHERE company_id = ? AND deleted_at IS NULL ORDER BY name'),
    q('SELECT id, code, name, is_formal AS isFormal, allow_multiple AS allowMultiple, sort_order FROM hrms_reporting_relationship_types WHERE company_id = ? AND deleted_at IS NULL ORDER BY sort_order, id'),
    q('SELECT id, code, name FROM hrms_kra_definitions WHERE company_id = ? AND deleted_at IS NULL ORDER BY name'),
    q('SELECT id, code, name FROM hrms_responsibility_definitions WHERE company_id = ? AND deleted_at IS NULL ORDER BY name LIMIT 500'),
    q('SELECT id, code, name FROM hrms_kpi_definitions WHERE company_id = ? AND deleted_at IS NULL ORDER BY name'),
  ]);
  return {
    asOf: on,
    kraDefinitions: kras,
    responsibilityDefinitions: responsibilities,
    kpiDefinitions: kpis,
    employees,
    roles,
    positions,
    departments,
    locations,
    shifts,
    workContexts: contexts,
    relationshipTypes: types.map((t) => ({ ...t, isFormal: Boolean(t.isFormal), allowMultiple: Boolean(t.allowMultiple) })),
    scopeTypes: SCOPE_TYPES,
    assignmentStatuses: ASSIGNMENT_STATUSES,
  };
}

/**
 * The manager picker's second half: once a manager is chosen, WHICH OF THEIR
 * ASSIGNMENTS they wear here. Optional by schema and strongly preferred by the
 * model — "reports to Ram Babu as Admin Manager" says more than "reports to Ram
 * Babu", and it is the difference the matrix is made of.
 */
export async function managerAssignments(db, companyId, employeeId, { on } = {}) {
  const asOf = dateText(on) || today();
  const [rows] = await db.query(
    `SELECT wa.id, wa.assignment_title, wa.role_id, r.title AS role_title, wa.position_id,
            p.position_code, COALESCE(p.position_title, pr.title) AS position_title,
            wa.is_primary, wa.status, wa.effective_from, wa.effective_to
       FROM hrms_work_assignments wa
       LEFT JOIN hrms_roles r ON r.company_id = wa.company_id AND r.id = wa.role_id
       LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id
       LEFT JOIN hrms_roles pr ON pr.company_id = wa.company_id AND pr.id = p.role_id
      WHERE wa.company_id = ? AND wa.employee_id = ? AND wa.deleted_at IS NULL AND wa.status <> 'ENDED'
      ORDER BY wa.is_primary DESC, wa.effective_from DESC`,
    [companyId, employeeId],
  );
  return {
    asOf,
    items: rows.map((r) => ({
      id: r.id,
      label: r.assignment_title || r.role_title || r.position_title || `Assignment ${r.id}`,
      roleId: r.role_id,
      roleTitle: r.role_title,
      positionId: r.position_id,
      positionCode: r.position_code,
      positionTitle: r.position_title,
      isPrimary: Boolean(r.is_primary),
      status: r.status,
      effectiveFrom: dateText(r.effective_from),
      effectiveTo: dateText(r.effective_to),
    })),
  };
}


