/**
 * cf_hrms — overview routes (plan §7). Read-only aggregation over everything
 * else, which is why it was built last: it has nothing to count until the rest
 * exists.
 *
 *   GET /overview/nav-counts   the row-2 badge counts the shell asks for once
 *   GET /overview/home?on=     every figure the Home cockpit renders, in ONE request
 *
 * ONE REQUEST, ONE ROUND TRIP EACH. The cockpit shows seven queues plus a stat
 * strip plus a readiness list; fetching those as seven calls would cost seven
 * round trips, and on TiDB a round trip is ~49ms before any work happens. The
 * sizes are therefore assembled as scalar subqueries inside a single SELECT
 * (`COUNTS`), the seat arithmetic is one derived-table query, and the roles
 * figures come from the service that already owns them. Four queries, issued
 * in parallel, whatever the screen asks for.
 *
 * PERMISSIONS. Neither route carries a `requirePerm`, on purpose: the shell
 * calls nav-counts for every signed-in user and Home is the landing route for
 * every role, so a 403 here would break navigation rather than hide a number.
 * Instead each BLOCK of figures is gated on the way out — a caller without
 * `cf_hrms_leave_view` simply has no leave keys in the response, and a missing
 * key hides its card (§4.1) instead of rendering a misleading zero. That is the
 * same contract fab_erp's /pulse uses.
 *
 * SEATS ARE COUNTED THE ORG CHART'S WAY, NOT THE POSITION LIST'S. A position
 * that works day AND night keeps `sanctioned_headcount = 1` — ONE SEAT — and
 * carries an hrms_manpower_requirements row per shift instead (plan §9.1). Its
 * real strength is Σ(required_count). Summing `sanctioned_headcount` instead,
 * which is what positionService.listPositions does for its filtered StatStrip,
 * reports 114 sanctioned and 101 vacant for Karni where the truth is 169 and
 * 156. The cockpit must agree with the org chart, so the fork below is a copy
 * of orgChartService's — if one changes, change both.
 *
 * Plain lists still go through the generic query API; what lands here is only
 * aggregation across service boundaries.
 */
import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { isPermitted } from '../../../core/middleware/requirePerm.js';
import { pool } from '../lib/db.js';
import { PERM, ctx, handle, dateParam } from '../lib/http.js';
import { rolesOverview } from '../services/roleContentService.js';
import { LIVE_ON, dateText } from '../services/positionService.js';
import { SEAT_TOTALS_SQL } from '../services/seatCount.js';

const router = Router();

const n = (v) => Number(v ?? 0);

/* ══════════════════════════════════════════════════════════════════════════
 * The sizes — one SELECT, one round trip
 * ══════════════════════════════════════════════════════════════════════════
 * Each entry carries its own SQL *and its own parameters*, and the builder
 * flattens them in the same order it concatenates the subqueries. That is the
 * whole reason for the shape: a single SELECT with eighteen `?` in one flat
 * array is one edit away from being silently off by one.
 */
const COUNTS = (companyId, on) => [
  ['openPoints',
    `SELECT COUNT(*) FROM hrms_open_points
      WHERE company_id = ? AND deleted_at IS NULL AND status = 'OPEN'`, [companyId]],

  ['employees',
    `SELECT COUNT(*) FROM hrms_employees
      WHERE company_id = ? AND deleted_at IS NULL AND employment_status <> 'EXITED'`, [companyId]],

  // Someone on the payroll doing no recorded work. PLANNED counts as covered:
  // a joiner whose assignment starts on Monday is not an unanswered question.
  ['employeesNoAssignment',
    `SELECT COUNT(*) FROM hrms_employees e
      WHERE e.company_id = ? AND e.deleted_at IS NULL AND e.employment_status <> 'EXITED'
        AND NOT EXISTS (
          SELECT 1 FROM hrms_work_assignments a
           WHERE a.company_id = e.company_id AND a.employee_id = e.id
             AND a.deleted_at IS NULL AND a.status IN ('ACTIVE','PLANNED')
             AND ${LIVE_ON('a')})`, [companyId, on, on]],

  ['activeAssignments',
    `SELECT COUNT(*) FROM hrms_work_assignments a
      WHERE a.company_id = ? AND a.deleted_at IS NULL AND a.status = 'ACTIVE'
        AND ${LIVE_ON('a')}`, [companyId, on, on]],

  // Attendance is keyed on the PERSON, never on the assignment (init.sql §7c),
  // so both halves of "who still has to be marked" are DISTINCT employees. A
  // person holding three assignments is one row to mark, not three.
  ['attendanceExpected',
    `SELECT COUNT(DISTINCT a.employee_id) FROM hrms_work_assignments a
      WHERE a.company_id = ? AND a.deleted_at IS NULL AND a.status = 'ACTIVE'
        AND ${LIVE_ON('a')}`, [companyId, on, on]],
  ['attendanceMarked',
    `SELECT COUNT(DISTINCT r.employee_id) FROM hrms_attendance_records r
      WHERE r.company_id = ? AND r.deleted_at IS NULL AND r.attendance_date = ?`, [companyId, on]],

  ['leavePending',
    `SELECT COUNT(*) FROM hrms_leave_requests
      WHERE company_id = ? AND deleted_at IS NULL AND status = 'PENDING'`, [companyId]],
  ['regularisationsPending',
    `SELECT COUNT(*) FROM hrms_attendance_regularizations
      WHERE company_id = ? AND deleted_at IS NULL AND status = 'PENDING'`, [companyId]],

  // An expired document is already a problem; this is the window in which it is
  // still cheap to fix, which is why it starts at today and not in the past.
  ['documentsExpiring',
    `SELECT COUNT(*) FROM hrms_employee_documents
      WHERE company_id = ? AND deleted_at IS NULL AND expiry_date IS NOT NULL
        AND expiry_date >= ? AND expiry_date <= DATE_ADD(?, INTERVAL 30 DAY)`, [companyId, on, on]],
  ['documentsExpired',
    `SELECT COUNT(*) FROM hrms_employee_documents
      WHERE company_id = ? AND deleted_at IS NULL AND expiry_date IS NOT NULL
        AND expiry_date < ?`, [companyId, on]],
  ['generatedDocuments',
    `SELECT COUNT(*) FROM hrms_generated_documents
      WHERE company_id = ? AND deleted_at IS NULL`, [companyId]],

  // The model's own sizes — the readiness list on Home, and the neutral badges
  // in row 2.
  ['departments', `SELECT COUNT(*) FROM hrms_departments  WHERE company_id = ? AND deleted_at IS NULL`, [companyId]],
  ['locations',   `SELECT COUNT(*) FROM hrms_locations    WHERE company_id = ? AND deleted_at IS NULL`, [companyId]],
  ['workContexts',`SELECT COUNT(*) FROM hrms_work_contexts WHERE company_id = ? AND deleted_at IS NULL`, [companyId]],
  ['shifts',      `SELECT COUNT(*) FROM hrms_shifts       WHERE company_id = ? AND deleted_at IS NULL`, [companyId]],
  ['leaveTypes',  `SELECT COUNT(*) FROM hrms_leave_types  WHERE company_id = ? AND deleted_at IS NULL`, [companyId]],
  ['contractors', `SELECT COUNT(*) FROM hrms_contractors  WHERE company_id = ? AND deleted_at IS NULL`, [companyId]],
];

async function readCounts(db, companyId, on) {
  const parts = COUNTS(companyId, on);
  const sql = `SELECT ${parts.map(([key, q]) => `(${q}) AS \`${key}\``).join(',\n       ')}`;
  const [[row]] = await db.query(sql, parts.flatMap(([, , params]) => params));
  const out = {};
  for (const [key] of parts) out[key] = n(row[key]);
  return out;
}

/**
 * Sanctioned / filled / vacant across every live, non-CLOSED seat.
 *
 * `eff` is the org chart's `effectiveSanctioned`: Σ(required_count) when the
 * position has live manpower requirements on both a day and a night shift,
 * otherwise `sanctioned_headcount`. A CLOSED seat is excluded — counting its
 * headcount invents vacancies nobody is hiring for.
 */
// The rule lives in services/seatCount.js — see its header for why. This used
// to be a hand-copied fork of orgChartService's, with a comment saying "if one
// changes, change both". They did not both change, and the Positions screen
// disagreed with its own nav badge in production.
const SEATS = SEAT_TOTALS_SQL(LIVE_ON);

async function readSeats(db, companyId, on) {
  const [[row]] = await db.query(SEATS, [companyId, on, on, companyId, on, on, companyId, on, on]);
  return {
    positions: n(row.positions),
    sanctioned: n(row.sanctioned),
    filled: n(row.filled),
    vacantSeats: n(row.vacant),
  };
}

/** The newest joiners, with the role they actually do. Home's one record list. */
const RECENT_PEOPLE = `
  SELECT e.id, e.employee_code, e.full_name, e.date_of_joining, e.employment_status,
         (SELECT r.title
            FROM hrms_work_assignments a
            JOIN hrms_roles r ON r.company_id = a.company_id AND r.id = a.role_id
           WHERE a.company_id = e.company_id AND a.employee_id = e.id
             AND a.deleted_at IS NULL AND a.status = 'ACTIVE'
           ORDER BY a.is_primary DESC, a.id
           LIMIT 1) AS role_title
    FROM hrms_employees e
   WHERE e.company_id = ? AND e.deleted_at IS NULL AND e.employment_status <> 'EXITED'
   ORDER BY e.date_of_joining DESC, e.id DESC
   LIMIT 6`;

async function readRecentPeople(db, companyId) {
  const [rows] = await db.query(RECENT_PEOPLE, [companyId]);
  return rows.map((r) => ({
    id: r.id,
    employeeCode: r.employee_code,
    fullName: r.full_name,
    roleTitle: r.role_title ?? null,
    dateOfJoining: dateText(r.date_of_joining),
    employmentStatus: r.employment_status,
  }));
}

/**
 * Everything the cockpit could show, assembled once, then filtered by what the
 * caller may see. `withPeople` is the only optional query: nav-counts needs
 * three numbers and no rows.
 */
async function collect(req, { withPeople }) {
  const { companyId } = ctx(req);
  const on = dateParam(req.query.on);
  const may = (tag) => isPermitted(req.user, tag);

  const [sizes, seats, roles, people] = await Promise.all([
    readCounts(pool, companyId, on),
    may(PERM.orgView) ? readSeats(pool, companyId, on) : Promise.resolve(null),
    may(PERM.orgView) ? rolesOverview(pool, companyId) : Promise.resolve(null),
    withPeople && may(PERM.peopleView) ? readRecentPeople(pool, companyId) : Promise.resolve(null),
  ]);

  const counts = {};
  const take = (tag, entries) => {
    if (!may(tag)) return;
    for (const [key, value] of Object.entries(entries)) counts[key] = value;
  };

  take(PERM.orgView, {
    openPoints: sizes.openPoints,
    departments: sizes.departments,
    locations: sizes.locations,
    workContexts: sizes.workContexts,
    shifts: sizes.shifts,
    ...(seats ?? {}),
    rolesTotal: roles?.total ?? 0,
    rolesActive: roles?.active ?? 0,
    rolesNoPurpose: roles?.noPurpose ?? 0,
    rolesNoKras: roles?.noKras ?? 0,
  });
  take(PERM.peopleView, {
    employees: sizes.employees,
    employeesNoAssignment: sizes.employeesNoAssignment,
    activeAssignments: sizes.activeAssignments,
    contractors: sizes.contractors,
    documentsExpiring: sizes.documentsExpiring,
    documentsExpired: sizes.documentsExpired,
  });
  take(PERM.attendanceView, {
    attendanceExpected: sizes.attendanceExpected,
    attendanceMarked: sizes.attendanceMarked,
    // Never negative: attendance can be recorded for someone whose assignment
    // has since ended, which would otherwise read as "-2 still to mark".
    attendanceUnmarked: Math.max(0, sizes.attendanceExpected - sizes.attendanceMarked),
    regularisationsPending: sizes.regularisationsPending,
  });
  take(PERM.leaveView, {
    leavePending: sizes.leavePending,
    leaveTypes: sizes.leaveTypes,
  });
  take(PERM.documentsGenerate, { generatedDocuments: sizes.generatedDocuments });

  return { asOf: on, counts, recentPeople: people };
}

/**
 * Row-2 badge counts. Flat `{ key: number }` keyed by the `countKey`s in the
 * frontend's navMeta.ts — the two files are one contract, so a key renamed
 * there is renamed here.
 *
 * Advisory by design: the client swallows a failure and renders no badges, and
 * a key that is absent (because the caller cannot see it) simply has no badge.
 */
router.get('/overview/nav-counts', protect, handle(async (req) => {
  const { counts } = await collect(req, { withPeople: false });
  const badges = {
    vacancies: counts.vacantSeats,
    roles: counts.rolesTotal,
    departments: counts.departments,
    locations: counts.locations,
    workContexts: counts.workContexts,
    employees: counts.employees,
    activeAssignments: counts.activeAssignments,
    documents: counts.generatedDocuments,
    attendanceToMark: counts.attendanceUnmarked,
    pendingLeave: counts.leavePending,
    openPoints: counts.openPoints,
  };
  for (const [key, value] of Object.entries(badges)) {
    if (value === undefined) delete badges[key];
  }
  return badges;
}));

/** Everything Home renders. One request, four queries, no per-card endpoint. */
router.get('/overview/home', protect, handle((req) => collect(req, { withPeople: true })));

export default router;
