/**
 * accessScope.js — "only my department and below". (TM/CF_HRMS_HIRING_SPEC.md §12.3.)
 *
 * An access role has a scope. COMPANY: the rights it holds apply everywhere.
 * DEPARTMENT: they apply to the login's own department and its sub-departments
 * — the department of the position their linked employee holds today.
 *
 * ONE FUNCTION ANSWERS IT: scopeOf(req) -> { all: true } or
 * { all: false, departmentIds: Set, rootIds, employeeId, departmentNames }.
 * Everything below is that answer applied to a thing: a position, an employee,
 * a department, a hiring, a work assignment, or a row that hangs off one.
 *
 * WHAT IS SCOPED
 *   - every WRITE on a position (job content, shift, reporting lines, moving a
 *     person, adding and removing one) and on an employee: the target must be
 *     inside the scope, else 403 OUT_OF_SCOPE;
 *   - PEOPLE DATA: the employees list and every read of one employee, a
 *     person's work, leaving and positions held, and hirings (a candidate is a
 *     person, and a hiring is on a position);
 *   - a department itself, for a scoped login that holds the right to change
 *     departments: only inside its own tree, and never its own top — or the
 *     right to move a department would be the right to move the fence.
 * WHAT IS NOT: the structure. The org chart, departments, roles and positions
 * are read company-wide by anyone who holds that area's `view`, so a department
 * head can see where they sit.
 *
 * A scoped login with no linked employee, or whose employee holds no position
 * today, has an EMPTY scope: it sees the structure, sees no people, changes
 * nothing.
 *
 * For { all: true } every check returns at once and costs no query.
 * `cf_hrms_self_view`'s team rule (teamScopeService.js) is separate and unchanged.
 */
import { pool } from '../lib/db.js';
import { HrmsError } from '../lib/errors.js';
import { accessOf } from '../lib/accessContext.js';

const pad2 = (n) => String(n).padStart(2, '0');
const todayText = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

const ALL = Object.freeze({ all: true });

/** An assignment that puts a person in a department on a date: not deleted, not ended, in date. */
const HOLDS_ON = (wa) => `${wa}.deleted_at IS NULL AND ${wa}.status <> 'ENDED'
  AND (${wa}.effective_from IS NULL OR ${wa}.effective_from <= ?) AND (${wa}.effective_to IS NULL OR ${wa}.effective_to >= ?)`;

/**
 * The scope of a login, from its ids — for a caller that has no request
 * (GET /access/me builds the sentence from it; tests ask it directly).
 */
export async function scopeFor(db, { companyId, userId, scope, owner = false }) {
  if (owner || scope !== 'DEPARTMENT') return ALL;
  const on = todayText();
  const [[employee]] = await db.query(
    'SELECT id FROM hrms_employees WHERE company_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1',
    [companyId, userId],
  );
  const empty = { all: false, departmentIds: new Set(), rootIds: [], employeeId: employee?.id ?? null, departmentNames: [] };
  if (!employee) return empty;
  const [[held], [departments]] = await Promise.all([
    db.query(
      `SELECT DISTINCT COALESCE(p.department_id, wa.department_id) AS department_id
         FROM hrms_work_assignments wa
         LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id AND p.deleted_at IS NULL
        WHERE wa.company_id = ? AND wa.employee_id = ? AND ${HOLDS_ON('wa')}`,
      [companyId, employee.id, on, on],
    ),
    db.query('SELECT id, name, parent_department_id FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
  ]);
  const byId = new Map(departments.map((d) => [d.id, d]));
  const rootIds = [...new Set(held.map((h) => h.department_id).filter((id) => id != null && byId.has(id)))];
  if (!rootIds.length) return empty;
  const childrenOf = new Map();
  for (const d of departments) {
    if (d.parent_department_id == null) continue;
    childrenOf.set(d.parent_department_id, [...(childrenOf.get(d.parent_department_id) ?? []), d.id]);
  }
  const departmentIds = new Set();
  const walk = [...rootIds];
  // The set is its own guard against a loop in bad data: nothing is visited twice.
  while (walk.length) {
    const id = walk.pop();
    if (departmentIds.has(id)) continue;
    departmentIds.add(id);
    walk.push(...(childrenOf.get(id) ?? []));
  }
  return { all: false, departmentIds, rootIds, employeeId: employee.id, departmentNames: rootIds.map((id) => byId.get(id).name) };
}

/** The scope of this request. Asked once per request, however many checks follow. */
export async function scopeOf(req, db = pool) {
  if (req.hrmsScope) return req.hrmsScope;
  const access = req.hrmsAccess ?? await accessOf(req);
  // No access row at all: nothing, rather than everything.
  const scope = !access
    ? { all: false, departmentIds: new Set(), rootIds: [], employeeId: null, departmentNames: [] }
    : await scopeFor(db, {
      companyId: Number(req.user?.companyId ?? req.user?.company_id), userId: Number(req.user?.id), scope: access.scope, owner: access.owner,
    });
  req.hrmsScope = scope;
  return scope;
}

const outOfScope = (what) => new HrmsError(403, 'OUT_OF_SCOPE', `${what} is outside your org unit. Your access covers your org unit and everything under it.`);
const inside = (scope, departmentId) => departmentId != null && scope.departmentIds.has(Number(departmentId));
const companyOf = (req) => Number(req.user?.companyId ?? req.user?.company_id);
const asId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

/* ── departments ─────────────────────────────────────────────────────────── */

export async function assertDepartmentInScope(req, departmentId, what = 'That org unit') {
  const scope = await scopeOf(req);
  if (scope.all) return;
  if (!inside(scope, departmentId)) throw outOfScope(what);
}

/**
 * A department being changed by a scoped login: it must be inside the scope and
 * must not be the top of it, and a new parent must be inside too.
 */
export async function assertDepartmentWrite(req, departmentId, body = {}) {
  const scope = await scopeOf(req);
  if (scope.all) return;
  if (departmentId != null) {
    if (!inside(scope, departmentId)) throw outOfScope('That org unit');
    if (scope.rootIds.includes(Number(departmentId))) {
      throw new HrmsError(403, 'OUT_OF_SCOPE', 'This is your own org unit. Changing it, moving it or removing it needs somebody whose access covers the whole company.');
    }
  }
  const parentGiven = Object.prototype.hasOwnProperty.call(body ?? {}, 'parentId');
  if (departmentId == null || parentGiven) {
    if (!inside(scope, asId(body?.parentId))) throw outOfScope('The org unit this would sit under');
  }
}

/* ── positions ───────────────────────────────────────────────────────────── */

const POSITION_ROW = {
  position: ['hrms_positions', 'id'],
  positionContext: ['hrms_position_work_contexts', 'position_id'],
  positionReporting: ['hrms_position_reporting_relationships', 'from_position_id'],
  positionOverride: ['hrms_position_content_overrides', 'position_id'],
  hiring: ['hrms_hirings', 'position_id'],
};

async function departmentOfPosition(db, companyId, kind, rowId) {
  const [table, column] = POSITION_ROW[kind];
  const sql = kind === 'position'
    ? 'SELECT p.id, p.department_id FROM hrms_positions p WHERE p.company_id = ? AND p.id = ?'
    : `SELECT p.id, p.department_id FROM ${table} x JOIN hrms_positions p ON p.company_id = x.company_id AND p.id = x.${column} WHERE x.company_id = ? AND x.id = ?`;
  const [[row]] = await db.query(sql, [companyId, rowId]);
  return row ?? null;
}

/**
 * A position, or a row that hangs off one (`kind`), must be inside the scope.
 * A row that does not exist is left to the service, which answers 404 in its
 * own words — for a scoped login too, so "not found" and "not yours" are told
 * apart only for things that exist in this company.
 */
export async function assertPositionInScope(req, rowId, kind = 'position') {
  const scope = await scopeOf(req);
  if (scope.all) return;
  const id = asId(rowId);
  if (id == null) return;
  const row = await departmentOfPosition(pool, companyOf(req), kind, id);
  if (!row) return;
  if (!inside(scope, row.department_id)) throw outOfScope(kind === 'hiring' ? 'That hiring’s position' : 'That position');
}

/** A new position, or a position being given another department: the department named must be inside. */
export async function assertPositionBody(req, body = {}, { creating = false } = {}) {
  const scope = await scopeOf(req);
  if (scope.all) return;
  const given = Object.prototype.hasOwnProperty.call(body ?? {}, 'departmentId');
  if (!creating && !given) return;
  if (!inside(scope, asId(body?.departmentId))) {
    throw new HrmsError(403, 'OUT_OF_SCOPE', 'Choose an org unit inside your own. Your access covers your org unit and everything under it.');
  }
}

/* ── employees ───────────────────────────────────────────────────────────── */

const EMPLOYEE_ROW = {
  employee: null,
  identifier: 'hrms_employee_identifiers',
  employeeDocument: 'hrms_employee_documents',
  assignment: 'hrms_work_assignments',
  leaveRequest: 'hrms_leave_requests',
  // §28: an attendance request (regularization) and a penalty both hang off a person.
  attendanceRequest: 'hrms_attendance_regularizations',
  attendancePenalty: 'hrms_attendance_penalties',
};
const ASSIGNMENT_ROW = {
  assignmentContext: 'hrms_work_assignment_contexts',
  assignmentReporting: 'hrms_assignment_reporting_relationships',
  assignmentOverride: 'hrms_work_assignment_content_overrides',
};

async function employeeIdOf(db, companyId, kind, rowId) {
  if (kind === 'employee') return rowId;
  if (EMPLOYEE_ROW[kind]) {
    const [[row]] = await db.query(`SELECT employee_id FROM ${EMPLOYEE_ROW[kind]} WHERE company_id = ? AND id = ?`, [companyId, rowId]);
    return row?.employee_id ?? null;
  }
  const [[row]] = await db.query(
    `SELECT wa.employee_id FROM ${ASSIGNMENT_ROW[kind]} x
       JOIN hrms_work_assignments wa ON wa.company_id = x.company_id AND wa.id = x.work_assignment_id
      WHERE x.company_id = ? AND x.id = ?`,
    [companyId, rowId],
  );
  return row?.employee_id ?? null;
}

/** Is this employee in a position inside the scope today? */
async function employeeInside(db, companyId, scope, employeeId) {
  if (!scope.departmentIds.size) return false;
  const on = todayText();
  const [[row]] = await db.query(
    `SELECT 1 AS ok
       FROM hrms_work_assignments wa
       LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id AND p.deleted_at IS NULL
      WHERE wa.company_id = ? AND wa.employee_id = ? AND ${HOLDS_ON('wa')}
        AND COALESCE(p.department_id, wa.department_id) IN (?)
      LIMIT 1`,
    [companyId, employeeId, on, on, [...scope.departmentIds]],
  );
  return Boolean(row);
}

/**
 * An employee, or a row that hangs off one (`kind`), must be a person whose
 * current position is inside the scope. Reads and writes alike.
 */
export async function assertEmployeeInScope(req, rowId, kind = 'employee') {
  const scope = await scopeOf(req);
  if (scope.all) return;
  const id = asId(rowId);
  if (id == null) return;
  const companyId = companyOf(req);
  const employeeId = await employeeIdOf(pool, companyId, kind, id);
  if (employeeId == null) return;
  const [[exists]] = await pool.query('SELECT id FROM hrms_employees WHERE company_id = ? AND id = ?', [companyId, employeeId]);
  if (!exists) return;
  if (!(await employeeInside(pool, companyId, scope, employeeId))) throw outOfScope('That person');
}

/**
 * What a list of people is limited to: null for the whole company, else the
 * department ids (possibly none — then the list is empty).
 */
export async function peopleFilter(req) {
  const scope = await scopeOf(req);
  return scope.all ? null : [...scope.departmentIds];
}

/** For a scoped login: adding a person outright is not inside any department. */
export async function assertCompanyWide(req, sentence) {
  const scope = await scopeOf(req);
  if (!scope.all) throw new HrmsError(403, 'OUT_OF_SCOPE', sentence);
}

/**
 * SQL for "this employee is inside the scope today", for a list query:
 * `AND ${EMPLOYEE_IN_DEPARTMENTS_SQL('e')}` with params [on, on, departmentIds].
 */
export const EMPLOYEE_IN_DEPARTMENTS_SQL = (e = 'e') => `EXISTS (
  SELECT 1 FROM hrms_work_assignments swa
    LEFT JOIN hrms_positions sp ON sp.company_id = swa.company_id AND sp.id = swa.position_id AND sp.deleted_at IS NULL
   WHERE swa.company_id = ${e}.company_id AND swa.employee_id = ${e}.id AND ${HOLDS_ON('swa')}
     AND COALESCE(sp.department_id, swa.department_id) IN (?))`;
export const scopeToday = todayText;

export default {
  scopeFor, scopeOf, assertDepartmentInScope, assertDepartmentWrite, assertPositionInScope, assertPositionBody,
  assertEmployeeInScope, peopleFilter, assertCompanyWide, EMPLOYEE_IN_DEPARTMENTS_SQL,
};
