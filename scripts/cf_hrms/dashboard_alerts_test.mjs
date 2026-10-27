/**
 * dashboard_alerts_test.mjs — Karni's requirements round (TM/CF_HRMS_HIRING_SPEC.md §42, 2026-10-27).
 *
 *   0. the schema (apply-dashboard-alerts-schema.mjs): four tables with company_id and deleted_at, the two
 *      duty components; a second run plans nothing;
 *   1. pure: the duty rules (reading, refusals, sentences), one day's duty, the phone numbers, the digest;
 *   2. the dashboard against hand-made data: headcount (by unit, kind, role, shift, joiners, leavers, trend),
 *      absenteeism (the day, the month, by unit, by day), overtime hours and cost, manpower, payroll cost —
 *      and a fixed number of reads;
 *   3. the manpower report: "and below", one or more units, a shift, a day to come, the Excel file;
 *   4. absence alerts: who is listed (punch, leave, half-day leave, on duty, a day set by hand, not joined),
 *      one digest per recipient (HR, the resolved manager, both at once), in-app + email queued, SMS / WhatsApp
 *      stubs send nothing, idempotent per day and shift (a second send, a whole pass), the settings respected
 *      (managers off, channels, the delay, off, too late), the screen and the bell over HTTP;
 *   5. Sunday and festival duty: the month (amounts, wage days, comp-off, no double overtime), comp-off into an
 *      EARNED_BY_WORK balance, the person's month and the muster, and a payroll run (SUNDAY_DUTY, FESTIVAL_DUTY);
 *   6. rights and scope: a department head, a positions-only role, an employee, settings by a scoped login;
 *   7. tenant isolation;
 *   8. nothing is left behind.
 *
 *   node scripts/cf_hrms/dashboard_alerts_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND: one connection, one transaction (pool.query / getConnection point at it), rolled back
 * at the end. Local only. Uses August and September 2025 with "live from" 2025-08-01 inside the transaction.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import mysql from 'mysql2/promise';
import ExcelJS from 'exceljs';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import hrmsApp from '../../apps/cf_hrms/app.js';
import { forgetAccess } from '../../apps/cf_hrms/lib/accessContext.js';
import { hrmsAppOf, ensureCatalog, setRoleTags } from '../../apps/cf_hrms/services/accessGrants.js';
import { setupAccess } from '../../apps/cf_hrms/services/accessSetup.js';
import { areaTag } from '../../apps/cf_hrms/lib/access.js';
import * as POS from '../../apps/cf_hrms/services/positionService.js';
import * as LEAVE from '../../apps/cf_hrms/services/leavePolicyService.js';
import * as REQ from '../../apps/cf_hrms/services/leave/requestService.js';
import * as BAL from '../../apps/cf_hrms/services/leave/balance.js';
import * as POL from '../../apps/cf_hrms/services/attendance/policy.js';
import * as PUN from '../../apps/cf_hrms/services/attendance/punches.js';
import { attendanceMonth } from '../../apps/cf_hrms/services/attendance/month.js';
import { dutyOfDay } from '../../apps/cf_hrms/services/attendance/duty.js';
import { CHANNELS, registerProvider, normalisePhone } from '../../apps/cf_hrms/services/attendance/channels.js';
import * as ALERT from '../../apps/cf_hrms/services/attendance/absenceAlerts.js';
import { dashboard } from '../../apps/cf_hrms/services/dashboard/dashboard.js';
import { manpowerReport } from '../../apps/cf_hrms/services/dashboard/manpower.js';
import { schemaSteps, alertTables, DUTY_CODES } from '../../apps/cf_hrms/scripts/apply-dashboard-alerts-schema.mjs';

const slug = (process.argv.find((a) => a.startsWith('--company=')) || '--company=karni').split('=')[1];
const VERBOSE = process.argv.includes('--verbose');
if (!['localhost', '127.0.0.1', '::1'].includes(String(process.env.DB_HOST ?? 'localhost'))) {
  console.error(`Refusing to run against DB_HOST=${process.env.DB_HOST}. This test is local only.`);
  process.exit(2);
}
process.env.CF_HRMS_COMPLIANCE_MAIL = 'off';

let passed = 0;
const failed = [];
const ok = (cond, name, detail = '') => {
  if (cond) { passed += 1; if (VERBOSE) console.log(`  ok    ${name}`); } else { failed.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  return Boolean(cond);
};
const section = (title) => console.log(`\n${title}`);
const J = (x) => JSON.stringify(x);
const t0 = Date.now();

const TABLES = ['hrms_absence_alert_settings', 'hrms_absence_alert_runs', 'hrms_notifications', 'hrms_alert_deliveries', 'hrms_compliance_emails', 'hrms_attendance_records',
  'hrms_attendance_punches', 'hrms_attendance_settings', 'hrms_attendance_policies', 'hrms_attendance_policy_assignments', 'hrms_attendance_months', 'hrms_attendance_regularizations',
  'hrms_leave_requests', 'hrms_leave_types', 'hrms_leave_policies', 'hrms_pay_runs', 'hrms_pay_run_people', 'hrms_pay_run_lines', 'hrms_pay_salaries', 'hrms_pay_structures',
  'hrms_pay_components', 'hrms_audit_log', 'hrms_employees', 'hrms_positions', 'hrms_work_assignments', 'hrms_departments', 'hrms_roles', 'hrms_shifts', 'hrms_shift_days',
  'hrms_holidays', 'hrms_holiday_calendars', 'hrms_position_reporting_relationships', 'users', 'app_user_access', 'roles'];
const dbCfg = { host: process.env.DB_HOST ?? 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306 };
async function worldCount() {
  const conn = await mysql.createConnection(dbCfg);
  try {
    const out = {};
    for (const t of TABLES) { const [[r]] = await conn.query(`SELECT COUNT(*) AS n FROM ${t}`); out[t] = Number(r.n); }
    return out;
  } finally { await conn.end(); }
}
const before = await worldCount();

/* ══ 0. the schema ═════════════════════════════════════════════════════════ */
section('[0] The schema');
{
  const conn = await mysql.createConnection(dbCfg);
  try {
    ok((await schemaSteps(conn)).length === 0, 'apply-dashboard-alerts-schema: nothing left to do here (tables and the duty components are there)');
    const t = alertTables();
    ok(t.length === 4 && t.every((x) => /\bcompany_id\b/.test(x.sql) && /\bdeleted_at\b/.test(x.sql)), 'init.sql §43: four tables, each with company_id and deleted_at', t.map((x) => x.table).join());
    ok(DUTY_CODES.join() === 'SUNDAY_DUTY,FESTIVAL_DUTY', 'the two ready-made duty components');
  } finally { await conn.end(); }
}

/* ══ 1. pure ═══════════════════════════════════════════════════════════════ */
section('[1] Duty rules, one day, phones, the digest');
{
  const problems = [];
  const r = POL.readRules({
    overtime: { afterMinutes: 30, rateMultiplier: 2 },
    weeklyOffDuty: { pay: 'PER_HOUR', amount: 60, minHours: 4, compOffDays: 0.5 },
    holidayDuty: { pay: 'DAY_WAGE', wageMultiple: 2, compOffDays: 1 },
  }, problems);
  ok(problems.length === 0 && r.weeklyOffDuty.pay === 'PER_HOUR' && r.weeklyOffDuty.amount === 60 && r.weeklyOffDuty.minHours === 4 && r.holidayDuty.wageMultiple === 2 && r.holidayDuty.compOffDays === 1 && !r.holidayDuty.alsoOvertime,
    'duty rules read clean', J([problems, r.weeklyOffDuty, r.holidayDuty]));
  const s = POL.sentencesOf(r);
  ok(s.includes('Work on a weekly off (at least 4 hours): ₹60 an hour as Sunday duty allowance, and half a day of comp-off.')
    && s.includes('Work on a festival holiday: twice the day’s wage as festival duty allowance, and a whole day of comp-off.')
    && s.some((x) => /paid as duty \(below\), not as overtime\.$/.test(x)), 'the sentences say it, and overtime says duty days are not overtime', J(s));
  const p2 = [];
  POL.readRules({ weeklyOffDuty: { pay: 'PER_DAY' }, holidayDuty: { pay: 'BONUS' } }, p2);
  const p3 = [];
  POL.readRules({ weeklyOffDuty: {}, holidayDuty: { pay: 'DAY_WAGE', wageMultiple: 9 } }, p3);
  ok(p2.some((x) => /amount/.test(x)) && p2.some((x) => /choose how it is paid/.test(x)) && p3.some((x) => /an allowance, a comp-off, or both/.test(x)) && p3.some((x) => /0\.5 to 5/.test(x)),
    'refused in words: no amount, an unknown way to pay, nothing chosen, a multiple out of range', J([p2, p3]));
  ok(POL.sentencesOf({ overtime: { afterMinutes: 0, rateMultiplier: 2 } }).some((x) => /Work on a weekly off or holiday is all overtime\./.test(x)), 'without duty rules the overtime sentence is as before');
  const rules = { weeklyOffDuty: r.weeklyOffDuty, holidayDuty: r.holidayDuty };
  const d1 = dutyOfDay({ status: 'WEEKLY_OFF', worked_minutes: 450, attendance_date: '2025-08-03' }, rules);
  const d2 = dutyOfDay({ status: 'WEEKLY_OFF', worked_minutes: 200, attendance_date: '2025-08-10' }, rules);
  const d3 = dutyOfDay({ status: 'HOLIDAY', worked_minutes: 60, attendance_date: '2025-08-15' }, rules);
  const d4 = dutyOfDay({ status: 'PRESENT', worked_minutes: 600, attendance_date: '2025-08-04' }, rules);
  ok(d1.kind === 'SUNDAY' && d1.hours === 7.5 && d1.amount === 450 && d1.compOff === 0.5 && d2 === null && d3.kind === 'FESTIVAL' && d3.wageDays === 2 && d3.amount === 0 && d3.compOff === 1 && d4 === null,
    'a day: 7.5 h on a weekly off → ₹450 and ½ comp-off; under 4 h → none; a holiday → 2 wage days and 1 comp-off; a working day → none', J([d1, d2, d3, d4]));
  ok(normalisePhone('98765 43210') === '+919876543210' && normalisePhone('+14155550100') === '+14155550100' && normalisePhone('12') === null, 'phones: ten digits → +91; E.164 kept; junk → none');
  const persons = new Map([[1, { departmentName: 'Printing' }]]);
  const dg = ALERT.digestOf({ companyName: 'X', check: { runKey: '2025-09-02:9', date: '2025-09-02', shiftId: 9, shiftName: 'Day', start: '09:00', dueAt: '2025-09-02 09:35:00' },
    listed: [{ person: { employee: { id: 1, name: 'A B', code: 'E1' } }, why: 'not punched in' }], persons, forWhom: 'MANAGER' });
  ok(dg.title === '1 not punched in — Day, Tue 2 Sep' && /A B \(E1\) — Printing/.test(dg.text) && dg.dedupeKey === 'ABSENCE:2025-09-02:9' && /report to you/.test(dg.intro) && dg.link === 'attendance?tab=today&date=2025-09-02',
    'the digest: one title for the shift, a line per person with their unit, one key per run', J(dg));
}

/* ══ the database part: one transaction, rolled back ═════════════════════ */
const real = { query: pool.query.bind(pool), execute: pool.execute.bind(pool), getConnection: pool.getConnection.bind(pool) };
const db = await real.getConnection();
await db.beginTransaction();
let depth = 0;
const inside = {
  query: (...a) => db.query(...a),
  execute: (...a) => db.execute(...a),
  beginTransaction: async () => { depth += 1; await db.query(`SAVEPOINT zz_da_${depth}`); },
  commit: async () => { if (depth > 0) { await db.query(`RELEASE SAVEPOINT zz_da_${depth}`); depth -= 1; } },
  rollback: async () => { if (depth > 0) { await db.query(`ROLLBACK TO SAVEPOINT zz_da_${depth}`); depth -= 1; } },
  release: () => {},
};
pool.query = inside.query;
pool.execute = inside.execute;
pool.getConnection = async () => inside;

const TAG = `ZZDA${Date.now().toString(36).toUpperCase().slice(-5)}`;
const q = async (sql, params) => (await db.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0] ?? null;
const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
const IST = (d, hhmm) => new Date(`${d}T${hhmm}:00+05:30`);

let server;
const fakeSms = { name: 'fake', calls: 0, on: false, configured() { return this.on; }, async send() { this.calls += 1; return { status: 'SENT' }; } };
try {
  const company = await one('SELECT id, name, slug FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
  if (!company) throw new Error(`No company "${slug}".`);
  const COMPANY = company.id;
  const app = await hrmsAppOf(db, COMPANY);
  const owner = await one(
    `SELECT u.id, u.email, u.name FROM users u JOIN app_user_access aua ON aua.user_id = u.id AND aua.app_id = ? AND aua.deleted_at IS NULL JOIN roles r ON r.id = aua.role_id
      WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [app.id, COMPANY]);
  if (!owner) throw new Error('This company has no Owner login.');
  const hr = { companyId: COMPANY, userId: owner.id, owner: true };
  const other = await one(
    `SELECT co.id, co.name, co.slug, a.id AS app_id FROM companies co JOIN apps a ON a.company_id = co.id AND a.slug = 'cf_hrms' AND a.deleted_at IS NULL
      WHERE co.id <> ? AND co.deleted_at IS NULL ORDER BY co.id LIMIT 1`, [COMPANY]);
  console.log(`\ndashboard_alerts_test — ${company.name} (${COMPANY}), run tag ${TAG}`);

  /* ══ fixture ═══════════════════════════════════════════════════════════ */
  await db.query(`INSERT INTO hrms_attendance_settings (company_id, live_from, web_punch_enabled) VALUES (?, '2025-08-01', 0)
                  ON DUPLICATE KEY UPDATE live_from = '2025-08-01'`, [COMPANY]);
  await db.query("DELETE FROM hrms_attendance_months WHERE company_id = ? AND period_month IN ('2025-08', '2025-09')", [COMPANY]);
  await db.query("UPDATE hrms_pay_runs SET deleted_at = NOW() WHERE company_id = ? AND deleted_at IS NULL AND period_month BETWEEN '2025-04' AND '2025-09'", [COMPANY]);
  await db.query('DELETE FROM hrms_absence_alert_settings WHERE company_id = ?', [COMPANY]);

  const unit = async (name, kind, parent = null) => ins('INSERT INTO hrms_departments (company_id, code, name, department_type, parent_department_id) VALUES (?, ?, ?, ?, ?)', [COMPANY, `${TAG}${name}`, `${TAG} ${name}`, kind, parent]);
  const U = {};
  U.R = await unit('R', 'Department');
  U.A = await unit('A', 'Section', U.R);
  U.A1 = await unit('A1', 'Machine', U.A);
  U.B = await unit('B', 'Section', U.R);
  U.Q = await unit('Q', 'Department');
  const roleOf = async (code) => ins("INSERT INTO hrms_roles (company_id, role_code, title, role_purpose, status) VALUES (?, ?, ?, 'For a test.', 'ACTIVE')", [COMPANY, `${TAG}${code}`, `${TAG} ${code}`]);
  const R = {};
  for (const k of ['RA', 'RB', 'RC', 'RM', 'RS', 'RD']) R[k] = await roleOf(k);
  const calId = await ins('INSERT INTO hrms_holiday_calendars (company_id, name) VALUES (?, ?)', [COMPANY, `${TAG} Calendar`]);
  await db.query('INSERT INTO hrms_holidays (company_id, calendar_id, holiday_date, name, is_optional) VALUES (?, ?, ?, ?, 0)', [COMPANY, calId, '2025-08-15', `${TAG} Independence Day`]);
  const shiftOf = async (code, start, end, cross = false) => {
    const id = await ins("INSERT INTO hrms_shifts (company_id, code, name, status, holiday_calendar_id, grace_in_minutes, grace_out_minutes, start_time, end_time, crosses_midnight) VALUES (?, ?, ?, 'ACTIVE', ?, 5, 5, ?, ?, ?)",
      [COMPANY, `${TAG}${code}`, `${TAG} ${code}`, calId, start, end, cross ? 1 : 0]);
    await db.query(`INSERT INTO hrms_shift_days (company_id, shift_id, weekday, is_working, start_time, end_time, crosses_midnight, break_minutes) VALUES ${[1, 2, 3, 4, 5, 6, 7].map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      [1, 2, 3, 4, 5, 6, 7].flatMap((wd) => [COMPANY, id, wd, wd === 7 ? 0 : 1, wd === 7 ? null : start, wd === 7 ? null : end, cross && wd !== 7 ? 1 : 0, wd === 7 ? 0 : 60]));
    return id;
  };
  const SD = await shiftOf('D', '09:00', '18:00');
  const SN = await shiftOf('N', '21:00', '06:00', true);
  const SAL = await shiftOf('AL', '09:00', '18:00');
  const pos = async (code, roleId, deptId, shiftId) => ins("INSERT INTO hrms_positions (company_id, position_code, role_id, position_title, department_id, status, default_shift_id) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)",
    [COMPANY, `${TAG}-${code}`, roleId, `${TAG} ${code}`, deptId, shiftId]);
  const emp = async (code, joining = '2024-01-01', extra = {}) => ins(
    "INSERT INTO hrms_employees (company_id, employee_code, full_name, gender, date_of_joining, employment_type, employment_status, exit_date, phone) VALUES (?, ?, ?, 'Male', ?, 'EMPLOYEE', ?, ?, ?)",
    [COMPANY, `${TAG}${code}`, `${TAG} Person ${code}`, joining, extra.exit ? 'EXITED' : 'ACTIVE', extra.exit ?? null, extra.phone ?? null]);
  const seat = (employeeId, positionId, roleId, deptId, from = '2024-01-01', to = null) => ins(
    "INSERT INTO hrms_work_assignments (company_id, employee_id, role_id, position_id, department_id, is_primary, status, effective_from, effective_to) VALUES (?, ?, ?, ?, ?, 1, 'ACTIVE', ?, ?)",
    [COMPANY, employeeId, roleId, positionId, deptId, from, to]);

  // The dashboard's people: R > A (> A1), B. Six chairs, four people on 30 Sep 2025.
  const P = {
    p1: await pos('P1', R.RA, U.A, SD), p2: await pos('P2', R.RA, U.A, SD), p3: await pos('P3', R.RB, U.A1, SD), p4: await pos('P4', R.RB, U.A1, SN),
    p5: await pos('P5', R.RC, U.B, SD), p6: await pos('P6', R.RC, U.B, SD),
  };
  const E = {
    e1: await emp('E1'), e2: await emp('E2'), e3: await emp('E3'), e4: await emp('E4', '2025-09-10'), e5: await emp('E5', '2024-01-01', { exit: '2025-09-15' }),
  };
  await seat(E.e1, P.p1, R.RA, U.A); await seat(E.e2, P.p2, R.RA, U.A); await seat(E.e3, P.p3, R.RB, U.A1);
  await seat(E.e4, P.p5, R.RC, U.B, '2025-09-10'); await seat(E.e5, P.p6, R.RC, U.B, '2024-01-01', '2025-09-15');
  const rec = (employeeId, date, status, v = {}) => ins(
    `INSERT INTO hrms_attendance_records (company_id, employee_id, attendance_date, shift_id, status, present_value, absent_value, leave_value, worked_minutes, overtime_minutes, policy_id, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [COMPANY, employeeId, date, v.shift ?? SD, status, v.present ?? 0, v.absent ?? 0, v.leave ?? 0, v.worked ?? null, v.ot ?? 0, v.policy ?? null, v.source ?? 'MANUAL']);
  await rec(E.e1, '2025-09-01', 'PRESENT', { present: 1, worked: 600, ot: 90 });
  await rec(E.e1, '2025-09-02', 'ABSENT', { absent: 1 });
  await rec(E.e1, '2025-09-30', 'PRESENT', { present: 1, worked: 540 });
  await rec(E.e2, '2025-09-30', 'ABSENT', { absent: 1 });
  await rec(E.e3, '2025-09-30', 'LEAVE', { leave: 1 });
  // September's payroll for two of them (gross + reimbursements + employer = cost), and e1's overtime line.
  const otComp = await one("SELECT id FROM hrms_pay_components WHERE company_id = ? AND code = 'OVERTIME' AND deleted_at IS NULL", [COMPANY]);
  const run9 = await ins("INSERT INTO hrms_pay_runs (company_id, period_month, status, people_count) VALUES (?, '2025-09', 'CALCULATED', 2)", [COMPANY]);
  const rp1 = await ins('INSERT INTO hrms_pay_run_people (company_id, run_id, employee_id, days_in_month, gross, reimbursements, employer_total, included) VALUES (?, ?, ?, 30, 20000, 0, 1000, 1)', [COMPANY, run9, E.e1]);
  await ins('INSERT INTO hrms_pay_run_people (company_id, run_id, employee_id, days_in_month, gross, reimbursements, employer_total, included) VALUES (?, ?, ?, 30, 15000, 500, 0, 1)', [COMPANY, run9, E.e4]);
  if (otComp) await ins("INSERT INTO hrms_pay_run_lines (company_id, run_id, run_person_id, employee_id, component_id, kind, amount, source) VALUES (?, ?, ?, ?, ?, 'EARNING', 750, 'ONE_TIME')", [COMPANY, run9, rp1, E.e1, otComp.id]);

  /* ══ logins and the in-process server ═══════════════════════════════════ */
  await setupAccess(db, COMPANY, { apply: true });
  const roleByKey = Object.fromEntries((await q('SELECT role_id, template_key FROM hrms_access_roles WHERE company_id = ? AND deleted_at IS NULL AND template_key IS NOT NULL', [COMPANY])).map((r) => [r.template_key, r.role_id]));
  const catalog = await ensureCatalog(db, { apply: true });
  const posRole = await ins('INSERT INTO roles (name, company_id) VALUES (?, ?)', [`${TAG} Planner`, COMPANY]);
  await db.query("INSERT INTO hrms_access_roles (company_id, role_id, label, scope) VALUES (?, ?, ?, 'COMPANY')", [COMPANY, posRole, `${TAG} Planner`]);
  await setRoleTags(db, { companyId: COMPANY, appId: app.id, roleId: posRole, tags: [areaTag('positions', 'view')], catalog });
  const login = async (label, roleId, employeeId = null) => {
    const email = `${TAG.toLowerCase()}.${label.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.test`;
    const id = await ins('INSERT INTO users (name, email, password, role_id, team_id, company_id) VALUES (?, ?, ?, ?, NULL, ?)', [`${TAG} ${label}`, email, 'x', roleId, COMPANY]);
    await db.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [id, app.id, roleId, COMPANY]);
    if (employeeId) await db.query('UPDATE hrms_employees SET user_id = ? WHERE id = ?', [id, employeeId]);
    const roleName = (await one('SELECT name FROM roles WHERE id = ?', [roleId])).name;
    return { id, email, token: signToken({ id, name: `${TAG} ${label}`, email, role: roleName, company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
  };

  // Absence alerts' people (unit Q, shift AL): two managers, seven staff.
  const AP = {
    m1: await pos('M1', R.RM, U.Q, SAL), m2: await pos('M2', R.RM, U.Q, SAL),
    a1: await pos('A1', R.RS, U.Q, SAL), a2: await pos('A2', R.RS, U.Q, SAL), a3: await pos('A3', R.RS, U.Q, SAL), a4: await pos('A4', R.RS, U.Q, SAL),
    a5: await pos('A5', R.RS, U.Q, SAL), a6: await pos('A6', R.RS, U.Q, SAL), a7: await pos('A7', R.RS, U.Q, SAL), d1: await pos('D1', R.RD, U.Q, SD),
  };
  const AE = {};
  for (const k of ['m1', 'm2', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'd1']) AE[k] = await emp(k.toUpperCase(), k === 'a7' ? '2025-09-05' : '2024-01-01', { phone: k === 'm1' ? '98765 43210' : null });
  for (const k of Object.keys(AE)) await seat(AE[k], AP[k], k.startsWith('m') ? R.RM : (k === 'd1' ? R.RD : R.RS), U.Q, k === 'a7' ? '2025-09-05' : '2024-01-01');
  const primary = await one("SELECT id FROM hrms_reporting_relationship_types WHERE company_id = ? AND code = 'PRIMARY_MANAGER' AND deleted_at IS NULL", [COMPANY]);
  for (const k of ['a1', 'a2', 'a3', 'a4', 'a6', 'a7', 'd1']) await POS.addPositionReporting(db, hr, AP[k], { toPositionId: AP.m1, relationshipTypeId: primary.id, isPrimary: true, effectiveFrom: '2024-01-01' });
  await POS.addPositionReporting(db, hr, AP.a5, { toPositionId: AP.m2, relationshipTypeId: primary.id, isPrimary: true, effectiveFrom: '2024-01-01' });

  const UL = {
    HR: await login('HR', roleByKey.HR_MANAGER), DH: await login('DH', roleByKey.DEPARTMENT_HEAD, E.e1), EMP: await login('EMP', roleByKey.EMPLOYEE, E.e2),
    PLAN: await login('Planner', posRole), M1: await login('M1', roleByKey.EMPLOYEE, AE.m1), M2: await login('M2', roleByKey.HR_MANAGER, AE.m2),
  };
  let THEM = null;
  if (other) {
    const theirAdmin = await one("SELECT u.id, u.email, u.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1", [other.id]);
    if (theirAdmin) {
      await db.query('INSERT IGNORE INTO app_user_access (user_id, app_id, role_id, company_id) SELECT ?, ?, role_id, ? FROM users WHERE id = ?', [theirAdmin.id, other.app_id, other.id, theirAdmin.id]);
      THEM = { id: theirAdmin.id, token: signToken({ id: theirAdmin.id, name: theirAdmin.name, email: theirAdmin.email, role: 'admin', company: other.slug, companyId: other.id, company_id: other.id, uiPermissions: [] }), slug: other.slug };
    }
  }
  forgetAccess();
  server = express();
  server.use(express.json({ limit: '20mb' }));
  server.use(cookieParser());
  server.use('/api', appContext);
  hrmsApp.register(server);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  server.close = () => new Promise((resolve) => listener.close(resolve));
  const root = `http://127.0.0.1:${listener.address().port}`;
  const call = async (who, method, url, body, { as = company.slug } = {}) => {
    const res = await fetch(`${root}/api/${as}/cf_hrms${url}`, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, json };
  };

  /* ══ 2. the dashboard ═══════════════════════════════════════════════════ */
  section('[2] The dashboard against hand-made data (September 2025, org unit R)');
  const ALL = { people: true, attendance: true, positions: true, pay: true };
  {
    let reads = 0;
    const counting = { query: (...a) => { reads += 1; return db.query(...a); } };
    const d = await dashboard(counting, hr, { month: '2025-09', department: String(U.R), rights: ALL });
    const reads1 = reads;
    reads = 0;
    await dashboard(counting, hr, { month: '2025-08', rights: ALL });
    ok(reads1 > 0 && reads1 <= 40 && reads <= 40, `a fixed number of reads, whatever the size (${reads1} for 6 people, ${reads} for the whole company)`);
    const name = (id) => `${TAG} ${Object.keys(U).find((k) => U[k] === id)}`;
    ok(d.on === '2025-09-30' && d.breakdown.map((b) => b.name).join('|') === `${TAG} R (itself)|${TAG} A|${TAG} B`, 'the day is the month’s last; the tiles break down by R’s units, R’s own chairs first', J(d.breakdown));
    const h = d.headcount;
    ok(h.total === 4 && J(h.byUnit.map((x) => x.count)) === J([0, 3, 1]), 'headcount 4: A (and A1) 3, B 1', J(h.byUnit));
    ok(J(h.byKind.map((x) => `${x.kind}:${x.count}`).sort()) === J(['Machine:1', 'Section:3']) && h.byShift.length === 1 && h.byShift[0].count === 4
      && h.byRole.find((x) => x.roleId === R.RA)?.count === 2, 'by kind (Section 3, Machine 1), by shift (Day 4), by role (RA 2)', J([h.byKind, h.byShift]));
    ok(h.joiners.length === 1 && h.joiners[0].employeeId === E.e4 && h.leavers.length === 1 && h.leavers[0].employeeId === E.e5 && h.trend.length === 6 && h.trend[4].count === 4 && h.trend[5].count === 4,
      'joiners: E4 (10 Sep); leavers: E5 (15 Sep); six months of headcount', J([h.joiners, h.leavers, h.trend]));
    const a = d.absenteeism;
    ok(J(a.today) === J({ date: '2025-09-30', people: 4, present: 1, absent: 1, leave: 1, off: 0, notPunched: 1, rate: 33.3 }), 'the day: 1 in, 1 absent, 1 on leave, 1 not punched — 33.3 %', J(a.today));
    ok(a.month.rate === 40 && a.month.absentDays === 2 && a.month.presentDays === 2 && a.month.leaveDays === 1 && a.byUnit.find((x) => x.unitId === U.A).rate === 40 && a.byUnit.find((x) => x.unitId === U.B).rate === null,
      'the month (attendanceMonth): 2 absent ÷ (2 + 2 + 1) = 40 %; A 40 %, B nothing recorded', J([a.month, a.byUnit]));
    ok(J(a.daily) === J([{ date: '2025-09-01', absent: 0, rate: 0 }, { date: '2025-09-02', absent: 1, rate: 100 }, { date: '2025-09-30', absent: 1, rate: 33.3 }]) && a.trend[5].rate === 40 && a.trend[4].rate === null,
      'by day, and the six months', J([a.daily, a.trend]));
    ok(d.overtime.month.hours === 1.5 && d.overtime.byUnit.find((x) => x.unitId === U.A).hours === 1.5 && d.overtime.trend[5].hours === 1.5 && d.overtime.cost === 750
      && d.overtime.byUnit.find((x) => x.unitId === U.A).cost === 750 && d.overtime.byUnit.find((x) => x.unitId === U.B).cost === 0, 'overtime: 1.5 h in A; the run’s OVERTIME line ₹750', J(d.overtime));
    const mp = d.manpower;
    ok(J(mp.totals) === J({ required: 6, filled: 4, vacant: 2, present: 1, leave: 1, absent: 1, off: 0, notPunched: 1, short: 5 }), 'manpower: 6 chairs, 4 filled, 1 present — 5 short', J(mp.totals));
    ok(mp.byUnit.find((x) => x.unitId === U.A).short === 3 && mp.byUnit.find((x) => x.unitId === U.B).short === 2 && mp.byShift.find((x) => x.shiftId === SN).vacant === 1, 'by unit (A 3 short, B 2) and shift (night: 1 vacant)', J(mp.byUnit));
    const pay = d.payroll;
    ok(pay.month.cost === 36500 && pay.run.status === 'CALCULATED' && pay.byUnit.find((x) => x.unitId === U.A).cost === 21000 && pay.byUnit.find((x) => x.unitId === U.B).cost === 15500 && pay.trend[5].cost === 36500 && pay.trend[4].cost === null,
      'payroll cost: 21,000 + 15,500 = 36,500 (gross + reimbursements + employer); A 21,000, B 15,500; no run in August', J(pay));
    ok(d.drill.manpower === 'manpower' && d.drill.payroll === `payroll-runs/${run9}`, 'each tile names the list behind it');
    const dn = await dashboard(db, hr, { month: '2025-09', department: String(U.R), shift: String(SN), rights: ALL });
    ok(dn.headcount.total === 0 && dn.manpower.totals.required === 1 && dn.manpower.totals.vacant === 1, 'the shift filter: night — nobody, one vacant chair', J(dn.manpower.totals));
    const http = await call(UL.HR, 'GET', `/dashboard?month=2025-09&department=${U.R}`);
    ok(http.status === 200 && http.json.headcount.total === 4 && http.json.payroll.month.cost === 36500, 'over HTTP: an HR manager sees every tile');
    ok((await call(UL.HR, 'GET', '/dashboard?month=2025-13')).status === 422 && (await call(UL.HR, 'GET', '/dashboard?department=abc')).status === 422, 'a wrong month or org unit: refused in words');
  }

  /* ══ 3. the manpower report ═════════════════════════════════════════════ */
  section('[3] Manpower: "and below", units, a shift, a day to come, Excel');
  {
    const m = await manpowerReport(db, hr, { date: '2025-09-30', department: String(U.R) });
    const u = (id) => m.units.find((x) => x.id === id);
    ok(m.units.map((x) => x.id).join() === [U.R, U.A, U.A1, U.B].join() && u(U.R).depth === 0 && u(U.A1).depth === 2 && u(U.A1).kind === 'Machine', 'tree order, depth and kind', J(m.units.map((x) => [x.name, x.depth, x.kind])));
    ok(u(U.A).own.required === 2 && u(U.A).total.required === 4 && u(U.A).total.filled === 3 && u(U.A).total.present === 1 && u(U.A).total.short === 3
      && u(U.A1).total.required === 2 && u(U.A1).total.leave === 1 && u(U.R).total.required === 6 && u(U.R).total.short === 5, '"and below": A owns 2, rolls up 4 (3 filled, 1 present, 3 short); R rolls up 6', J([u(U.A), u(U.R).total]));
    ok(m.roles.find((x) => x.roleId === R.RB).counts.vacant === 1 && m.shifts.find((x) => x.shiftId === SD).counts.required === 5, 'by role (RB: 1 vacant) and shift (Day: 5 chairs)');
    ok(m.positions.find((p) => p.id === P.p6).state === 'VACANT' && m.positions.find((p) => p.id === P.p5).state === 'NOT_PUNCHED' && m.positions.find((p) => p.id === P.p3).state === 'LEAVE', 'each chair: E5’s left (vacant), E4 not punched, E3 on leave');
    const two = await manpowerReport(db, hr, { date: '2025-09-30', department: `${U.A1},${U.B}` });
    ok(two.totals.required === 4 && two.units.map((x) => x.id).join() === [U.A1, U.B].join(), 'one or more units: A1 and B — 4 chairs');
    const n = await manpowerReport(db, hr, { date: '2025-09-30', department: String(U.R), shift: String(SN) });
    ok(n.totals.required === 1 && n.totals.vacant === 1 && n.units.every((x) => [U.R, U.A, U.A1].includes(x.id)), 'a shift: night — the one chair in A1');
    const fut = await manpowerReport(db, hr, { date: '2099-01-01', department: String(U.R) });
    ok(fut.attendanceKnown === false && fut.totals.present === null && fut.totals.short === fut.totals.vacant && /still to come/.test(fut.note), 'a day to come: present unknown, short = vacant, said', J(fut.totals));
    const aug = await manpowerReport(db, hr, { date: '2025-07-01', department: String(U.R) });
    ok(aug.attendanceKnown === false && /not live/.test(aug.note), 'a day before attendance was live: said');
    const wb = await call(UL.HR, 'GET', `/dashboard/manpower/workbook?date=2025-09-30&department=${U.R}`);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(wb.json.contentBase64, 'base64'));
    const sheet = book.getWorksheet('By org unit');
    const rowR = sheet.getRow(4).values;
    ok(wb.status === 200 && book.worksheets.map((w) => w.name).join() === 'By org unit,By role,By shift,Positions' && rowR[1] === 'Department' && rowR[4] === 6 && rowR[12] === 5,
      'the Excel file: four sheets; R’s row says Department, 6 required, 5 short', J(rowR));
  }

  /* ══ 4. absence alerts ══════════════════════════════════════════════════ */
  section('[4] Absence alerts: who, one digest per recipient, channels, once per day and shift, settings');
  registerProvider('SMS', fakeSms);
  {
    // 2 Sep 2025 (Tuesday), shift AL 09:00 + 5 grace.
    const D = '2025-09-02';
    const code = async (id) => (await one('SELECT employee_code FROM hrms_employees WHERE id = ?', [id])).employee_code;
    const punch = async (id, at, direction = 'IN') => PUN.ingestPunches(db, hr, [{ deviceUserId: await code(id), employeeId: id, at, direction }], { source: 'API', process: false });
    await punch(AE.m1, `${D} 08:55:00`); await punch(AE.m2, `${D} 08:57:00`); await punch(AE.a1, `${D} 09:02:00`);
    await punch(AE.a2, '2025-09-01 18:02:00', 'OUT');        // yesterday's OUT: not today's
    const LT = (await LEAVE.createLeaveType(db, hr, { code: `${TAG}CL`, name: `${TAG} Casual`, isPaid: true })).type.id;
    await db.query("INSERT INTO hrms_leave_requests (company_id, employee_id, leave_type_id, from_date, to_date, quantity, status) VALUES (?, ?, ?, ?, ?, 1, 'APPROVED')", [COMPANY, AE.a3, LT, D, D]);
    await db.query("INSERT INTO hrms_leave_requests (company_id, employee_id, leave_type_id, from_date, to_date, quantity, status, half_day) VALUES (?, ?, ?, ?, ?, 0.5, 'APPROVED', 'SECOND')", [COMPANY, AE.a5, LT, D, D]);
    const r4 = await rec(AE.a4, D, 'UNKNOWN', { shift: SAL, source: 'SYSTEM' });
    await db.query("INSERT INTO hrms_attendance_regularizations (company_id, attendance_record_id, employee_id, kind, attendance_date, reason, status) VALUES (?, ?, ?, 'ON_DUTY', ?, 'Customer visit', 'APPROVED')", [COMPANY, r4, AE.a4, D]);
    await rec(AE.a6, D, 'PRESENT', { shift: SAL, present: 1, source: 'MANUAL' });
    // The settings, over HTTP: validation, then on (HR manager templates, managers, every channel).
    ok((await call(UL.HR, 'PUT', '/attendance/alerts/settings', { enabled: true, delayMinutes: 999 })).status === 422, 'a delay over 600 minutes: refused');
    ok((await call(UL.HR, 'PUT', '/attendance/alerts/settings', { enabled: true, channels: { inApp: false, email: false, sms: false, whatsapp: false } })).json?.code === 'INVALID', 'on with no channel: refused');
    ok((await call(UL.DH, 'PUT', '/attendance/alerts/settings', { enabled: true })).status === 403, 'a department-scoped login cannot change them (whole company)');
    const put = await call(UL.HR, 'PUT', '/attendance/alerts/settings', { enabled: true, delayMinutes: 15, hrTemplates: ['HR_MANAGER'], notifyManagers: true, channels: { inApp: true, email: true, sms: true, whatsapp: true } });
    ok(put.status === 200 && put.json.settings.enabled && put.json.settings.delayMinutes === 15, 'HR turns them on: 15 minutes after start + grace');

    const at = (hhmm, d = D) => IST(d, hhmm);
    const early = await ALERT.loadChecks(db, COMPANY, { now: at('09:15') });
    ok(![...early.checks.values()].some((k) => k.shiftId === SAL && k.date === D), 'at 09:15 the 09:00 shift (+5 grace +15) is not due yet');
    const { checks, settings } = await ALERT.loadChecks(db, COMPANY, { now: at('09:30') });
    const check = checks.get(`${D}:${SAL}`);
    const listed = check?.absent.map((x) => x.person.employee.id) ?? [];
    ok(check && check.dueAt === `${D} 09:20:00` && J(listed.sort()) === J([AE.a2, AE.a5].sort()),
      'at 09:30 it is due (09:20): A2 (no punch today) and A5 (second-half leave) are listed — not A1 (punched), A3 (leave), A4 (on duty), A6 (marked by hand), A7 (not joined), the managers (punched)', J(listed));
    ok(check.absent.find((x) => x.person.employee.id === AE.a5).why === 'not punched in (second-half leave only)', 'the half-day leave is said');

    const sent = await ALERT.sendCheck(db, COMPANY, check, { settings, name: company.name });
    const dig = (uid) => sent.digests.find((x) => x.userId === uid);
    ok(sent.absent === 2 && dig(UL.HR.id)?.people.length === 2 && dig(UL.HR.id).forWhom === 'HR', 'HR hears of both, in ONE digest');
    ok(dig(UL.M1.id)?.people.join() === String(AE.a2) && dig(UL.M1.id).forWhom === 'MANAGER', 'the in-charge (A2’s resolved manager, M1) hears of A2 only');
    ok(dig(UL.M2.id)?.people.length === 2 && dig(UL.M2.id).forWhom === 'HR' && sent.digests.filter((x) => x.userId === UL.M2.id).length === 1, 'M2 is HR and A5’s manager: one digest, of everyone');
    ok(!dig(UL.DH.id) && !dig(UL.EMP.id), 'nobody else of the test hears');
    const dels = await q('SELECT user_id, channel, status FROM hrms_alert_deliveries WHERE run_id = ? AND user_id = ?', [sent.runId, UL.M1.id]);
    const st = Object.fromEntries(dels.map((x) => [x.channel, x.status]));
    ok(J(st) === J({ IN_APP: 'SENT', EMAIL: 'QUEUED', SMS: 'NOT_CONFIGURED', WHATSAPP: 'NOT_CONFIGURED' }) && fakeSms.calls === 0, 'M1: in the app, email queued; SMS and WhatsApp: no provider set up — nothing sent', J(st));
    const mails = await q('SELECT to_user_id, status, subject FROM hrms_compliance_emails WHERE company_id = ? AND to_user_id IN (?)', [COMPANY, [UL.HR.id, UL.M1.id, UL.M2.id]]);
    ok(mails.length === 3 && mails.every((x) => x.status === 'QUEUED' && /not punched in/.test(x.subject)), 'three emails in the outbox (QUEUED: no SMTP here, nothing leaves)', J(mails));
    const again = await ALERT.sendCheck(db, COMPANY, check, { settings, name: company.name });
    const pass = await ALERT.alertPass({ now: at('09:40'), companyIds: [COMPANY] });
    const n = await one('SELECT COUNT(*) AS n FROM hrms_alert_deliveries WHERE run_id = ?', [sent.runId]);
    const runs = await one('SELECT COUNT(*) AS n FROM hrms_absence_alert_runs WHERE company_id = ? AND run_key = ?', [COMPANY, check.runKey]);
    ok(again === null && !pass.some((x) => x.runKey === check.runKey) && Number(runs.n) === 1 && Number(n.n) === dels.length * sent.digests.length, 'once per day and shift: a second send and a whole pass after it send nothing (the claim)', J([again, Number(n.n)]));

    // The bell: the AL shift's digest, and the Day shift's from the whole pass (D1 has no punch on 2 Sep either).
    const mine = await call(UL.M1, 'GET', '/notifications');
    const note = mine.json?.items?.find((x) => x.data?.shiftId === SAL);
    ok(mine.status === 200 && mine.json.unread === 2 && mine.json.items.some((x) => x.data?.shiftId === SD && x.data.people.some((y) => y.employeeId === AE.d1)) && note?.kind === 'ABSENCE_DIGEST' && /^1 not punched in — /.test(note.title) && note.data.people[0].employeeId === AE.a2 && note.link === `attendance?tab=today&date=${D}`, 'M1’s bell: two unread digests (one per shift), the AL one with A2 and the link', J(mine.json));
    ok((await call(UL.HR, 'POST', `/notifications/${note.id}/read`, {})).json?.updated === 0, 'another login cannot mark it');
    ok((await call(UL.M1, 'POST', `/notifications/${note.id}/read`, {})).json?.updated === 1 && (await call(UL.M1, 'GET', '/notifications')).json.unread === 1, 'M1 marks it read');

    // Settings respected: managers off, in the app only (3 Sep).
    await ALERT.putAlertSettings(db, hr, { notifyManagers: false, channels: { inApp: true, email: false, sms: false, whatsapp: false } });
    const s3 = await ALERT.alertSettingsOf(db, COMPANY);
    const c3 = (await ALERT.loadChecks(db, COMPANY, { now: at('09:30', '2025-09-03') })).checks.get(`2025-09-03:${SAL}`);
    const r3 = await ALERT.sendCheck(db, COMPANY, c3, { settings: s3, name: company.name });
    const d3 = await q('SELECT DISTINCT channel FROM hrms_alert_deliveries WHERE run_id = ?', [r3.runId]);
    ok(!r3.digests.some((x) => x.userId === UL.M1.id) && r3.digests.some((x) => x.userId === UL.HR.id) && d3.map((x) => x.channel).join() === 'IN_APP', 'managers off and in-app only: M1 hears nothing, HR in the app only', J(d3));
    // The delay; too late; off.
    await ALERT.putAlertSettings(db, hr, { delayMinutes: 60 });
    ok(!(await ALERT.loadChecks(db, COMPANY, { now: at('09:30', '2025-09-04') })).checks.has(`2025-09-04:${SAL}`), 'a 60-minute delay: not due at 09:30');
    ok(!(await ALERT.loadChecks(db, COMPANY, { now: at('15:00', '2025-09-04') })).checks.has(`2025-09-04:${SAL}`)
      && (await ALERT.loadChecks(db, COMPANY, { now: at('15:00', '2025-09-04'), ignoreLate: true })).checks.has(`2025-09-04:${SAL}`), 'more than 4 hours past its time: skipped (the screen still shows it)');
    ok(!(await ALERT.loadChecks(db, COMPANY, { now: at('11:00', '2025-09-07') })).checks.has(`2025-09-07:${SAL}`), 'a Sunday (weekly off): nothing due');
    await ALERT.putAlertSettings(db, hr, { enabled: false });
    ok((await ALERT.alertPass({ now: at('10:30', '2025-09-05'), companyIds: [COMPANY] })).length === 0, 'turned off: a pass does nothing');
    // A provider, once it is set up, is called (and SMS needs a phone number).
    fakeSms.on = true;
    const viaSms = await CHANNELS.SMS.deliver(db, { companyId: COMPANY, recipient: { userId: UL.M1.id, phone: '98765 43210' }, digest: { text: 'x' } });
    const noPhone = await CHANNELS.SMS.deliver(db, { companyId: COMPANY, recipient: { userId: UL.HR.id, phone: null }, digest: { text: 'x' } });
    const wa = await CHANNELS.WHATSAPP.deliver(db, { companyId: COMPANY, recipient: { userId: UL.M1.id, phone: '9876543210' }, digest: { text: 'x' } });
    ok(viaSms.status === 'SENT' && fakeSms.calls === 1 && noPhone.status === 'NO_ADDRESS' && wa.status === 'NOT_CONFIGURED', 'a plugged-in SMS provider sends (+91…); no phone → NO_ADDRESS; WhatsApp still a stub', J([viaSms, noPhone, wa]));
    fakeSms.on = false;
    // The screen.
    const scr = await call(UL.HR, 'GET', '/attendance/alerts');
    ok(scr.status === 200 && scr.json.runs.some((x) => x.id === sent.runId && x.digests === sent.digests.length && x.deliveries.some((d) => d.channel === 'SMS' && d.status === 'NOT_CONFIGURED'))
      && scr.json.channels.find((x) => x.key === 'WHATSAPP').ready === false, 'Attendance › Settings shows the runs, their deliveries and the channels', J(scr.json?.channels));
    ok((await call(UL.EMP, 'GET', '/attendance/alerts')).status === 403, 'an employee cannot open it');
  }
  registerProvider('SMS', null);

  /* ══ 5. Sunday and festival duty ═══════════════════════════════════════ */
  section('[5] Sunday and festival duty: the month, comp-off, the person, the muster, a payroll run');
  {
    const pol = (await POL.createPolicy(db, hr, { name: `${TAG} Duty`, rules: {
      overtime: { afterMinutes: 30, rateMultiplier: 2 },
      weeklyOffDuty: { pay: 'PER_HOUR', amount: 60, minHours: 4, compOffDays: 0.5 },
      holidayDuty: { pay: 'DAY_WAGE', wageMultiple: 2, compOffDays: 1 },
    } })).policy;
    ok(pol.sentences.some((x) => /Sunday duty allowance/.test(x)) && pol.sentences.some((x) => /festival duty allowance/.test(x)), 'a policy with both rules, in words');
    await POL.putAssignment(db, hr, { scope: 'ROLE', targetId: R.RD, policyId: pol.id });
    const d = AE.d1;
    await rec(d, '2025-08-03', 'WEEKLY_OFF', { shift: SD, worked: 480, ot: 480, policy: pol.id });
    await rec(d, '2025-08-04', 'PRESENT', { shift: SD, present: 1, worked: 540, ot: 60, policy: pol.id });
    await rec(d, '2025-08-10', 'WEEKLY_OFF', { shift: SD, worked: 120, ot: 120, policy: pol.id });
    await rec(d, '2025-08-15', 'HOLIDAY', { shift: SD, worked: 300, ot: 300, policy: pol.id });
    const m = await attendanceMonth(COMPANY, '2025-08', { db, employeeIds: [d] });
    const p = m.people[0];
    ok(J(p.duty.sunday) === J({ days: 1, hours: 8, amount: 480 }) && J(p.duty.festival) === J({ days: 1, hours: 5, amount: 0, wageDays: 2 }) && p.duty.compOffDays === 1.5 && p.duty.days.length === 2,
      'the month: Sunday 8 h × ₹60 = ₹480; festival 2 wage days; comp-off ½ + 1 = 1.5 (10 Aug, 2 h, under 4 h: not duty)', J(p.duty));
    ok(p.overtime.minutes === 180 && p.overtime.multiplier === 2 && m.totals.dutyAmount === 480 && m.totals.compOffDays === 1.5, 'overtime: the duty days are not paid twice — 60 + 120 minutes = 3 h', J([p.overtime, m.totals]));
    // Comp-off into the balance: a CO leave type earned by work in d1's leave policy.
    const co = (await LEAVE.createLeaveType(db, hr, { code: `${TAG}CO`, name: `${TAG} Comp-off`, isPaid: true })).type.id;
    const lpol = (await LEAVE.createPolicy(db, hr, { name: `${TAG} Leave`, yearStartsMonth: 4, status: 'ACTIVE' })).policy;
    await LEAVE.updatePolicy(db, hr, lpol.id, { rules: [{ leaveTypeId: co, basis: 'PER_YEAR', accrual: 'EARNED_BY_WORK', expiresAfterDays: 60 }] });
    await LEAVE.putAssignment(db, hr, { scope: 'ROLE', roleId: R.RD, policyId: lpol.id });
    const w = (await REQ.loadWorlds(db, COMPANY, [d], { on: '2025-08-31' })).get(d);
    const bal = REQ.balancesOf(w, BAL.yearFromStart(2025, 4), '2025-08-31').find((b) => b.leaveTypeId === co);
    ok(bal && bal.earned === 1.5 && bal.available === 1.5 && /1\.5 earned by working on a weekly off or a holiday \(2 days, from attendance\)/.test(bal.why), 'comp-off: 1.5 days credited to the EARNED_BY_WORK type', J(bal));
    // The person's month and the muster.
    const pm = await call(UL.HR, 'GET', `/attendance/people/${d}?month=2025-08`);
    const day3 = pm.json?.days?.find((x) => x.date === '2025-08-03');
    ok(pm.status === 200 && day3?.duty?.kind === 'SUNDAY' && day3.duty.amount === 480 && pm.json.summary.duty.festival.wageDays === 2 && pm.json.compOff?.days === 1.5 && pm.json.compOff.leaveTypeName === `${TAG} Comp-off`,
      'the person’s month: 3 Aug marked Sunday duty ₹480, the festival day, comp-off credited to Comp-off', J([day3?.duty, pm.json?.compOff]));
    ok(pm.json.policy.sentences.some((x) => /Sunday duty allowance/.test(x)), 'and the rules in words');
    const mg = await call(UL.HR, 'GET', `/attendance/month?month=2025-08&q=${encodeURIComponent(`${TAG}D1`)}`);
    const row = mg.json?.rows?.[0];
    ok(row && row.cells.find((x) => x.date === '2025-08-15').duty?.kind === 'FESTIVAL' && row.totals.duty.sunday.amount === 480, 'the muster: the festival day marked, the month’s duty in the totals');
    const roll = await call(UL.HR, 'GET', `/attendance/month/workbook?month=2025-08&q=${encodeURIComponent(`${TAG}D1`)}`);
    const rb = new ExcelJS.Workbook();
    await rb.xlsx.load(Buffer.from(roll.json.contentBase64, 'base64'));
    const ws = rb.getWorksheet('Muster roll');
    const head = ws.getRow(3).values;
    const vals = ws.getRow(4).values;
    ok(head.includes('Sunday duty ₹') && vals[head.indexOf('Sunday duty ₹')] === 480 && vals[head.indexOf('Festival wage days')] === 2 && vals[head.indexOf('Comp-off days')] === 1.5 && String(vals[head.indexOf('3 Sun')]) === 'WO+',
      'the muster roll: duty columns, and the day worked marked WO+', J([vals[head.indexOf('3 Sun')]]));
    // A payroll run: close August with this month, pay d1.
    const pr = await call(UL.HR, 'POST', '/payroll/setup');
    const CO = Object.fromEntries((await call(UL.HR, 'GET', '/payroll/components')).json.components.map((k) => [k.code, k]));
    ok(pr.status === 200 && CO.SUNDAY_DUTY?.readyMade && CO.FESTIVAL_DUTY?.kind === 'EARNING' && CO.SUNDAY_DUTY.inEsiWage && !CO.SUNDAY_DUTY.inPfWage, 'the ready-made SUNDAY_DUTY and FESTIVAL_DUTY: earnings, in the ESI wage, not PF');
    const S = (await call(UL.HR, 'POST', '/payroll/structures', { code: `${TAG}S`, name: `${TAG} Half basic`, lines: [
      { componentId: CO.BASIC.id, formula: '50% of CTC' }, { componentId: CO.SPECIAL.id, formula: 'balance' }] })).json.structure;
    const sal = await call(UL.HR, 'POST', '/payroll/salaries', { employeeId: d, annualCtc: 312000, structureId: S.id, effectiveFrom: '2025-04-01', pfMode: 'NONE', reason: 'Test', complianceReason: 'Test' });
    ok(sal.status === 200, 'a salary of ₹26,000 a month (basic ₹13,000)', J(sal.json));
    const snap = await attendanceMonth(COMPANY, '2025-08', { db, employeeIds: [d], fresh: true });
    await db.query("INSERT INTO hrms_attendance_months (company_id, period_month, status, summary_json, closed_at) VALUES (?, '2025-08', 'CLOSED', ?, NOW())", [COMPANY, JSON.stringify({ ...snap, status: 'CLOSED', final: true })]);
    const run = (await call(UL.HR, 'POST', '/payroll/runs', { month: '2025-08' })).json.run;
    const calc = await call(UL.HR, 'POST', `/payroll/runs/${run.id}/calculate`);
    const person = calc.json?.people?.find((x) => x.employee.id === d);
    const lines = person ? (await call(UL.HR, 'GET', `/payroll/runs/${run.id}/people/${person.id}`)).json.lines : [];
    const line = (c) => lines.find((l) => l.code === c);
    ok(calc.status === 200 && line('SUNDAY_DUTY')?.amount === 480 && line('SUNDAY_DUTY').source === 'ATTENDANCE' && /1 weekly off worked \(8 h\)/.test(line('SUNDAY_DUTY').basis),
      'the run: SUNDAY_DUTY ₹480', J(line('SUNDAY_DUTY')));
    ok(line('FESTIVAL_DUTY')?.amount === 1000 && /2 × ₹500 a day/.test(line('FESTIVAL_DUTY').basis), 'FESTIVAL_DUTY: 2 × the day’s wage ₹500 ((BASIC + DA) ÷ 26 ÷ 8 × 8) = ₹1,000', J(line('FESTIVAL_DUTY')));
    ok(line('OVERTIME')?.amount === 375, 'overtime: 3 h × 2 × ₹62.50 = ₹375 (the duty days not again)', J(line('OVERTIME')));
  }

  /* ══ 6. rights and scope ═══════════════════════════════════════════════ */
  section('[6] Rights and scope');
  {
    const dh = await call(UL.DH, 'GET', '/dashboard?month=2025-09');
    ok(dh.status === 200 && dh.json.scope === 'UNITS' && dh.json.headcount.total === 3 && dh.json.hidden.payroll && !dh.json.payroll && dh.json.overtime.costHidden === true,
      'a department head (E1, in A): their units only — 3 people; payroll and overtime cost hidden (no pay view)', J({ hc: dh.json?.headcount?.total, hidden: dh.json?.hidden }));
    ok(dh.json.manpower.totals.required === 4 && J(dh.json.breakdown.map((b) => b.name)) === J([`${TAG} A (itself)`, `${TAG} A1`]), 'their chairs: A and A1 (4)', J(dh.json.breakdown));
    const out = await call(UL.DH, 'GET', `/dashboard/manpower?date=2025-09-30&department=${U.B}`);
    ok(out.status === 200 && out.json.totals.required === 0, 'a unit outside their scope shows nothing');
    const pl = await call(UL.PLAN, 'GET', '/dashboard?month=2025-09');
    ok(pl.status === 200 && pl.json.hidden.headcount && pl.json.hidden.absenteeism && pl.json.manpower && pl.json.manpower.attendanceKnown === false, 'positions view only: the manpower tile, without who came in; the rest hidden in words', J(pl.json?.hidden));
    const plm = await call(UL.PLAN, 'GET', `/dashboard/manpower?date=2025-09-30&department=${U.R}`);
    ok(plm.json.totals.present === null && plm.json.positions.every((p) => ['VACANT', 'FILLED'].includes(p.state)), 'and the manpower report without attendance: chairs only');
    ok((await call(UL.EMP, 'GET', '/dashboard')).status === 403 && (await call(UL.EMP, 'GET', '/dashboard/manpower')).status === 403, 'an employee (self view only): no dashboard, no manpower');
  }

  /* ══ 7. tenant isolation ═══════════════════════════════════════════════ */
  section('[7] Tenant isolation');
  if (THEM) {
    ok((await call(THEM, 'GET', `/dashboard?department=${U.R}`, undefined, { as: THEM.slug })).status === 422, 'another company cannot name this company’s org unit');
    const theirs = await call(THEM, 'GET', '/dashboard', undefined, { as: THEM.slug });
    const theirMp = await call(THEM, 'GET', '/dashboard/manpower', undefined, { as: THEM.slug });
    ok(theirs.status === 200 && !J(theirs.json).includes(TAG) && !J(theirMp.json).includes(TAG), 'their dashboard and manpower hold nothing of this one');
    const tn = await call(THEM, 'GET', '/notifications', undefined, { as: THEM.slug });
    const any = await one('SELECT id FROM hrms_notifications WHERE company_id = ? ORDER BY id DESC LIMIT 1', [COMPANY]);
    ok(tn.status === 200 && !J(tn.json).includes(TAG) && (await call(THEM, 'POST', `/notifications/${any.id}/read`, {}, { as: THEM.slug })).json?.updated === 0, 'nor its notifications; they cannot mark one');
    const theirAlerts = await call(THEM, 'GET', '/attendance/alerts', undefined, { as: THEM.slug });
    ok(theirAlerts.status === 200 && !J(theirAlerts.json).includes(TAG), 'nor its alert runs');
  } else ok(true, 'no second company here: isolation skipped');
} catch (err) {
  ok(false, 'the run finished', `${err.message} ${(err.stack ?? '').split('\n').slice(1, 4).join(' ')}`);
} finally {
  registerProvider('SMS', null);
  if (server?.close) await server.close();
  try { await db.rollback(); } catch { /* nothing */ }
  db.release();
  pool.query = real.query;
  pool.execute = real.execute;
  pool.getConnection = real.getConnection;
  forgetAccess();
}

section('[8] Nothing is left behind');
{
  const after = await worldCount();
  const moved = Object.keys(before).filter((k) => after[k] !== before[k]);
  ok(moved.length === 0, `every count is what it was (${TABLES.length} tables)`, moved.map((k) => `${k} ${before[k]} -> ${after[k]}`).join('; '));
}

console.log(`\n${passed} passed, ${failed.length} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
