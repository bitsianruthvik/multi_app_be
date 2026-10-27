/**
 * dashboard.js — the management dashboard and the manpower report (TM/CF_HRMS_HIRING_SPEC.md §42.1, §42.2;
 * services/dashboard/).
 *
 *   GET /dashboard?month=&department=&shift=              the five tiles — each only with its right:
 *                                                         headcount (employees view), absenteeism and overtime
 *                                                         hours (attendance view), manpower (positions view),
 *                                                         payroll and overtime cost (payroll view + pay view)
 *   GET /dashboard/manpower?date=&department=&shift=      required · filled · vacant · present · short by org unit
 *                                                         ("and below"), role and shift; present needs attendance view
 *   GET /dashboard/manpower/workbook?date=&department=&shift=   the same as Excel (base64)
 *
 * `department`: one or more org units, comma-separated, each with everything under it (spec §34.2).
 * A department-scoped login sees its own org units only (people, chairs, pay).
 */
import { Router } from 'express';
import { pool } from '../lib/db.js';
import { PERM, guard, handle, ctx, can } from '../lib/http.js';
import { peopleFilter } from '../services/accessScope.js';
import { dashboard } from '../services/dashboard/dashboard.js';
import { manpowerReport, manpowerWorkbook } from '../services/dashboard/manpower.js';

const router = Router();

const rightsOf = (req) => ({
  people: can(req, PERM.employees.view),
  attendance: can(req, PERM.attendance.view),
  positions: can(req, PERM.positions.view),
  pay: can(req, PERM.payroll.view) && can(req, PERM.payView),
});

router.get('/dashboard', guard([PERM.employees.view, PERM.attendance.view, PERM.positions.view, PERM.payroll.view], {
  note: 'each tile needs its own right (pay tiles: payroll view + cf_hrms_pay_view); narrowed to the login’s org unit',
}), handle(async (req) => dashboard(pool, ctx(req), {
  month: req.query.month, department: req.query.department, shift: req.query.shift, scopeDeptIds: await peopleFilter(req), rights: rightsOf(req),
})));

const manpowerQuery = async (req) => ({ date: req.query.date, department: req.query.department, shift: req.query.shift, scopeDeptIds: await peopleFilter(req) });
// Without attendance view the chairs are shown, who came in is not (manpower.js withoutAttendance).
router.get('/dashboard/manpower', guard(PERM.positions.view, { note: 'present today needs cf_hrms_attendance_view; narrowed to the login’s org unit' }), handle(async (req) => (
  manpowerReport(pool, ctx(req), { ...await manpowerQuery(req), attendance: can(req, PERM.attendance.view) }))));
router.get('/dashboard/manpower/workbook', guard(PERM.positions.view, { note: 'present today needs cf_hrms_attendance_view; narrowed to the login’s org unit' }), handle(async (req) => (
  manpowerWorkbook(pool, ctx(req), { ...await manpowerQuery(req), attendance: can(req, PERM.attendance.view) }))));

export default router;
