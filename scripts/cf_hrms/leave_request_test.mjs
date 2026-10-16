/**
 * leave_request_test.mjs — leave requests and approvals (TM/CF_HRMS_HIRING_SPEC.md §22, 2026-10-16).
 *
 *   0. the schema (apply-leave-requests-schema.mjs): a second run plans nothing;
 *   1. which days count (pure, services/leave/days.js): weekly off, holiday, optional
 *      holiday, days off between with and without the rule, the edges, half a day, no shift;
 *   2. the balance (pure, services/leave/balance.js): every accrual and basis — upfront,
 *      prorated, monthly, per days worked, on request, earned by work, per event, unpaid —
 *      carry forward ALL / CAPPED / NONE, HR's opening, negative allowed, the why line;
 *   3. every BLOCK and NOTE check (pure, on a made-up person);
 *   4. the approver: the chair the main position reports to; a vacant chair walks up;
 *      nobody -> HR; the whole chain;
 *   5. the routes, as real logins: My leave, preview, submit, the wire shapes;
 *      approvals feed and context (teamOff, yearSoFar); approve, reject, cancel — the
 *      approver, above in the chain, HR, the person themselves refused, a peer refused,
 *      another company refused; re-check on approve; HR on the person's behalf;
 *   6. opening balances: PUT, its refusals, the grid; the Excel round trip;
 *   7. nothing is left behind.
 *
 *   node scripts/cf_hrms/leave_request_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND: the whole run is ONE connection inside ONE transaction
 * (pool.query / getConnection point at it; a route's own transaction is a savepoint),
 * rolled back at the end. Local only.
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
import { hrmsAppOf } from '../../apps/cf_hrms/services/accessGrants.js';
import { setupAccess } from '../../apps/cf_hrms/services/accessSetup.js';
import * as POS from '../../apps/cf_hrms/services/positionService.js';
import * as LEAVE from '../../apps/cf_hrms/services/leavePolicyService.js';
import { RULE_DEFAULTS, summaryOf } from '../../apps/cf_hrms/services/leavePolicyRead.js';
import * as DAYS from '../../apps/cf_hrms/services/leave/days.js';
import * as BAL from '../../apps/cf_hrms/services/leave/balance.js';
import * as REQ from '../../apps/cf_hrms/services/leave/requestService.js';
import { schemaSteps } from '../../apps/cf_hrms/scripts/apply-leave-requests-schema.mjs';

const slug = (process.argv.find((a) => a.startsWith('--company=')) || '--company=karni').split('=')[1];
const VERBOSE = process.argv.includes('--verbose');
if (!['localhost', '127.0.0.1', '::1'].includes(String(process.env.DB_HOST ?? 'localhost'))) {
  console.error(`Refusing to run against DB_HOST=${process.env.DB_HOST}. This test is local only.`);
  process.exit(2);
}

let passed = 0;
const failed = [];
const ok = (cond, name, detail = '') => {
  if (cond) { passed += 1; if (VERBOSE) console.log(`  ok    ${name}`); } else { failed.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  return Boolean(cond);
};
const section = (title) => console.log(`\n${title}`);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const keys = (o) => Object.keys(o ?? {});
const codes = (checks, level = null) => checks.filter((c) => !level || c.level === level).map((c) => c.code);

const TABLES = ['hrms_leave_requests', 'hrms_leave_balances', 'hrms_leave_types', 'hrms_leave_policies', 'hrms_leave_policy_rules', 'hrms_leave_policy_assignments',
  'hrms_audit_log', 'hrms_employees', 'hrms_positions', 'hrms_work_assignments', 'hrms_position_reporting_relationships', 'hrms_shifts', 'hrms_shift_days',
  'hrms_holiday_calendars', 'hrms_holidays', 'hrms_roles', 'hrms_departments', 'users', 'app_user_access'];
const dbCfg = { host: process.env.DB_HOST ?? 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306 };
async function worldCount() {
  const conn = await mysql.createConnection(dbCfg);
  try {
    const out = {};
    for (const t of TABLES) {
      const [[r]] = await conn.query(`SELECT COUNT(*) AS n, COALESCE(SUM(deleted_at IS NULL), 0) AS live FROM ${t}`);
      out[t] = `${r.n}/${r.live}`;
    }
    return out;
  } finally { await conn.end(); }
}
const before = await worldCount();

/* ══ 0. the schema (before the transaction: DDL would end it) ═════════════ */
section('[0] The schema');
{
  const conn = await mysql.createConnection(dbCfg);
  try {
    ok((await schemaSteps(conn)).length === 0, 'apply-leave-requests-schema: nothing left to do on this database (idempotent)');
    const [cols] = await conn.query(`SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
      AND ((TABLE_NAME = 'hrms_leave_requests' AND COLUMN_NAME IN ('half_day', 'days_json', 'decision_note', 'decided_by', 'decided_at', 'cancel_note', 'raised_by_hr'))
        OR (TABLE_NAME = 'hrms_leave_balances' AND COLUMN_NAME = 'note'))`);
    ok(cols.length === 8, 'the request columns and the balance note are there', JSON.stringify(cols.map((x) => `${x.t}.${x.c}`)));
  } finally { await conn.end(); }
}

/* ══ 1. which days count (pure) ════════════════════════════════════════════ */
section('[1] Which days count');
const HOL = [{ date: '2026-11-10', name: 'Diwali', isOptional: false }, { date: '2026-11-12', name: 'Holi', isOptional: true }];
const CAL = DAYS.makeCalendar({ shift: { name: 'Day', workingWeekdays: [1, 2, 3, 4, 5, 6] }, holidays: HOL });
{
  // Sat 7 Nov .. Mon 16 Nov 2026: Sun 8, Diwali Tue 10, Sun 15 are days off; Holi Thu 12 is optional (working).
  const without = DAYS.countDays({ from: '2026-11-07', to: '2026-11-16', calendar: CAL, countDaysOffBetween: false });
  const withRule = DAYS.countDays({ from: '2026-11-07', to: '2026-11-16', calendar: CAL, countDaysOffBetween: true });
  const line = (r, d) => r.days.find((x) => x.date === d);
  ok(without.quantity === 7 && without.days.length === 10 && line(without, '2026-11-08').why === 'Sunday — weekly off' && !line(without, '2026-11-08').counts
    && line(without, '2026-11-10').why === 'Diwali — holiday' && line(without, '2026-11-10').amount === 0,
  'a weekly off and a holiday do not count; every date of the range is listed with why', JSON.stringify(without.days.filter((d) => !d.counts)));
  ok(line(without, '2026-11-12').counts && line(without, '2026-11-12').amount === 1 && line(without, '2026-11-12').why === 'Holi — optional holiday, a working day',
    'an optional holiday is a working day, and counts');
  ok(withRule.quantity === 10 && line(withRule, '2026-11-08').counts && /between two leave days — counts under this policy/.test(line(withRule, '2026-11-08').why)
    && line(withRule, '2026-11-10').counts && /^Diwali — holiday, between two leave days/.test(line(withRule, '2026-11-10').why),
  'with countDaysOffBetween, the days off between two leave days count, and say so', JSON.stringify(withRule.days.filter((d) => d.why)));
  const edges = DAYS.countDays({ from: '2026-11-08', to: '2026-11-15', calendar: CAL, countDaysOffBetween: true });
  ok(edges.quantity === 6 && !line(edges, '2026-11-08').counts && !line(edges, '2026-11-15').counts && line(edges, '2026-11-10').counts,
    'days off at the start or end of a range never count, even under the rule', `${edges.quantity}`);
  const half = DAYS.countDays({ from: '2026-11-09', to: '2026-11-09', halfDay: 'FIRST', calendar: CAL });
  ok(half.quantity === 0.5 && half.days[0].amount === 0.5 && half.days[0].why === 'first half of the day' && half.days[0].weekday === 'Monday', 'a half day counts 0.5');
  const offOnly = DAYS.countDays({ from: '2026-11-08', to: '2026-11-08', calendar: CAL });
  ok(offOnly.quantity === 0 && offOnly.days[0].counts === false, 'a range of days off only counts nothing');
  const noShift = DAYS.makeCalendar({ shift: null });
  ok(/Monday to Saturday count as working days and Sunday is the weekly off/.test(noShift.note) && !noShift.isWorking('2026-11-08') && noShift.isWorking('2026-11-07'),
    'no shift: Monday to Saturday working, Sunday off — and the calendar says so', noShift.note);
  const noCal = DAYS.makeCalendar({ shift: { name: 'General', workingWeekdays: [1, 2, 3, 4, 5] }, holidays: [], hasHolidayCalendar: false });
  ok(/no holiday calendar/.test(noCal.note) && !noCal.isWorking('2026-11-07'), 'a shift without a holiday calendar says so; its own weekly offs still apply');
  ok(DAYS.spanText('2026-10-12', '2026-10-15') === '12–15 Oct' && DAYS.spanText('2026-10-28', '2026-11-02') === '28 Oct – 2 Nov' && DAYS.spanText('2026-12-28', '2027-01-02') === '28 Dec 2026 – 2 Jan 2027' && DAYS.spanText('2026-10-12', '2026-10-12') === '12 Oct',
    'dates in words: 12–15 Oct · 28 Oct – 2 Nov · across a year · one day');
  ok(DAYS.workingDaysBetween(CAL, '2026-11-07', '2026-11-16') === 7, 'working days between two dates, by the calendar');
}

/* ══ 2. the balance (pure) ═════════════════════════════════════════════════ */
section('[2] What is available');
const mkRule = (id, code, name, over = {}, isPaid = true) => {
  const r = { ...RULE_DEFAULTS, leaveTypeId: id, leaveTypeCode: code, leaveTypeName: name, isPaid, ...over };
  return { ...r, summary: summaryOf(r, { code, name }) };
};
const Y = BAL.yearFromStart(2026, 4);
{
  ok(Y.key === '2026-27' && Y.from === '2026-04-01' && Y.to === '2027-03-31' && BAL.yearFromStart(2026, 1).key === '2026' && BAL.yearFromStart(2026, 1).to === '2026-12-31'
    && BAL.leaveYearOf('2027-02-10', 4).key === '2026-27' && BAL.leaveYearOf('2026-03-31', 4).key === '2025-26' && BAL.yearOfKey('2026', 4) === null && BAL.yearOfKey('2026-27', 4).from === '2026-04-01',
  'the leave year from the policy’s first month: 2026-27 from April, 2026 from January; a key of the wrong shape is refused');
  const B = (rule, o = {}) => BAL.balanceOf({ rule, year: Y, startsMonth: 4, joinDate: '2020-01-01', asOf: '2026-10-16', calendar: CAL, ...o });
  const up = mkRule(1, 'CL', 'Casual leave', { days: 12 });
  const r1 = B(up, { requests: [{ id: 1, status: 'APPROVED', quantity: 3, from: '2026-06-01' }, { id: 2, status: 'PENDING', quantity: 1, from: '2026-11-02' }, { id: 3, status: 'APPROVED', quantity: 5, from: '2025-06-01' }, { id: 4, status: 'REJECTED', quantity: 2, from: '2026-07-01' }] });
  ok(r1.balance.earned === 12 && r1.balance.taken === 3 && r1.balance.held === 1 && r1.balance.opening === 0 && r1.balance.available === 8 && r1.balance.limited
    && r1.balance.why === '12 a year, given in April · 3 taken · 1 waiting for approval',
  'UPFRONT: the year’s days; taken = approved this year, held = pending; a rejected one and last year’s do not count; the why line', JSON.stringify(r1.balance));
  ok(B(up, { requests: [{ id: 2, status: 'PENDING', quantity: 1, from: '2026-11-02' }], excludeRequestId: 2 }).balance.available === 12, 'a request’s own hold can be left out (on approve)');
  const pro = mkRule(1, 'CL', 'Casual leave', { days: 12, prorateOnJoining: true });
  const rp = B(pro, { joinDate: '2026-07-15' });
  ok(rp.balance.earned === 9 && /9 for the 9 months left after joining \(12 a year\)/.test(rp.balance.why), 'prorated: joined in July, 9 months left -> 9 of 12', rp.balance.why);
  ok(B(pro, { joinDate: '2026-08-20' }).balance.earned === 8 && B(pro, { joinDate: '2025-08-20' }).balance.earned === 12, 'prorated only for somebody who joined inside this year; down to the half day');
  const mon = mkRule(2, 'SL', 'Sick leave', { days: 12, accrual: 'MONTHLY' });
  ok(B(mon).balance.earned === 7 && B(mon, { asOf: '2026-04-01' }).balance.earned === 1 && B(mon, { asOf: null }).balance.earned === 12 && B(mon, { joinDate: '2026-06-10' }).balance.earned === 5
    && /^1 a month, 7 so far/.test(B(mon).balance.why),
  'MONTHLY: days/12 for each month begun up to the month the leave starts (Oct: 7), capped at the year; from the joining month', B(mon).balance.why);
  const pdw = mkRule(3, 'EL', 'Earned leave', { days: 15, accrual: 'PER_DAYS_WORKED', daysWorkedPerLeaveDay: 20 });
  const worked = DAYS.workingDaysBetween(CAL, '2026-04-01', '2026-10-15');
  const rw = B(pdw);
  ok(rw.balance.earned === Math.min(15, Math.floor((worked / 20) * 2) / 2) && rw.info.estimated && /estimated from the shift calendar; there is no attendance yet/.test(rw.balance.why),
    `PER_DAYS_WORKED: ${worked} working days by the calendar ÷ 20, down to the half day — labelled an estimate`, rw.balance.why);
  ok(B(pdw, { asOf: null }).balance.earned === 15, 'PER_DAYS_WORKED is capped at the year’s days');
  const onr = mkRule(4, 'OR', 'Study leave', { days: 10, accrual: 'ON_REQUEST', prorateOnJoining: true });
  ok(B(onr).balance.earned === 10 && B(onr, { joinDate: '2026-10-01' }).balance.earned === 5 && /^Up to 10 a year/.test(B(onr).balance.why), 'ON_REQUEST: the days as a yearly limit, prorated like UPFRONT');
  const ebw = mkRule(5, 'CO', 'Compensatory off', { days: null, accrual: 'EARNED_BY_WORK' });
  const re = B(ebw, { openings: new Map([['2026-27', { opening: 2, note: 'two holidays worked' }]]) });
  ok(B(ebw).balance.earned === 0 && B(ebw).balance.available === 0 && re.balance.available === 2 && /2 opening balance entered by HR/.test(re.balance.why), 'EARNED_BY_WORK: nothing automatic, only what HR enters');
  const ev = mkRule(6, 'ML', 'Maternity leave', { basis: 'PER_EVENT', days: 26, appliesTo: 'WOMEN', maxTimesInService: 2 });
  const e1 = B(ev, { requests: [{ id: 9, status: 'APPROVED', quantity: 26, from: '2023-05-01' }] });
  const e2 = B(ev, { requests: [{ id: 9, status: 'APPROVED', quantity: 26, from: '2023-05-01' }, { id: 10, status: 'APPROVED', quantity: 26, from: '2025-05-01' }] });
  ok(e1.balance.available === 26 && /26 each time · 1 of 2 times used/.test(e1.balance.why) && e2.balance.available === 0 && e2.info.timesUsed === 2,
    'PER_EVENT: the days each occasion; the times in service count every approved request, ever', `${e1.balance.why} | ${e2.balance.why}`);
  const lwp = mkRule(7, 'LWP', 'Leave without pay', { basis: 'UNLIMITED_UNPAID' }, false);
  const rl = B(lwp, { requests: [{ id: 11, status: 'APPROVED', quantity: 4, from: '2026-08-01' }] });
  ok(rl.balance.limited === false && rl.balance.available === null && rl.balance.taken === 4 && /^Unpaid, with no fixed limit · 4 taken$/.test(rl.balance.why), 'UNLIMITED_UNPAID: no limit (available null), what was taken still shows');

  // ── carry forward ──
  const last = [{ id: 20, status: 'APPROVED', quantity: 2, from: '2025-06-01' }];
  const all = mkRule(1, 'CL', 'Casual leave', { days: 12, carryForward: 'ALL' });
  const capped = mkRule(1, 'CL', 'Casual leave', { days: 12, carryForward: 'CAPPED', carryForwardCapDays: 3 });
  const none = mkRule(1, 'CL', 'Casual leave', { days: 12, carryForward: 'NONE' });
  ok(B(all, { requests: last }).balance.opening === 10 && /10 carried from 2025-26/.test(B(all, { requests: last }).balance.why)
    && B(capped, { requests: last }).balance.opening === 3 && B(none, { requests: last }).balance.opening === 0,
  'carry forward: ALL carries last year’s closing (12 − 2 = 10), CAPPED up to its cap (3), NONE nothing', `${B(all, { requests: last }).balance.why}`);
  ok(B(all).balance.opening === 0, 'a previous year with no HR row and no requests carries nothing (it stops there)');
  const hrLast = new Map([['2025-26', { opening: 4, note: null }]]);
  ok(B(all, { openings: hrLast }).balance.opening === 16, 'HR’s opening of last year carries with it: 4 + 12 = 16');
  const hrNow = new Map([['2026-27', { opening: 5, note: null }]]);
  const ro = B(all, { requests: last, openings: hrNow });
  ok(ro.balance.opening === 5 && /^12 a year, given in April · 5 opening balance entered by HR$/.test(ro.balance.why), 'HR’s number for the year wins over what would carry', ro.balance.why);
  const twoBack = [{ id: 21, status: 'APPROVED', quantity: 2, from: '2024-06-01' }, { id: 22, status: 'APPROVED', quantity: 1, from: '2025-06-01' }];
  ok(B(all, { requests: twoBack }).balance.opening === 21, 'the previous year’s closing is computed the same way, back through the years: 2024-25 closes at 10, 2025-26 opens at 10 and closes at 21', `${B(all, { requests: twoBack }).balance.opening}`);
  ok(B(all, { requests: last, joinDate: '2026-05-01' }).balance.opening === 0, 'nothing carries from a year before joining');

  // ── negative ──
  const neg = mkRule(2, 'SL', 'Sick leave', { days: 12, accrual: 'MONTHLY', negativeBalanceAllowed: true });
  ok(B(neg).info.floor === -12 && B(mon).info.floor === 0, 'below 0 only when negativeBalanceAllowed, and not below −(the year’s days)');
  const nb = B(neg, { requests: [{ id: 30, status: 'APPROVED', quantity: 9, from: '2026-05-01' }] });
  ok(nb.balance.available === -2, 'a balance taken before it is earned shows below 0', `${nb.balance.available}`);
}

/* ══ 3. every check (pure, on a made-up person) ═════════════════════════════ */
section('[3] Every BLOCK and NOTE check');
const RULES = [
  mkRule(1, 'CL', 'Casual leave', { days: 12, halfDayAllowed: true, maxDaysAtOnce: 5, minNoticeDays: 3 }),
  mkRule(2, 'SL', 'Sick leave', { days: 12, accrual: 'MONTHLY', proofAfterDays: 2, countDaysOffBetween: true, negativeBalanceAllowed: true }),
  mkRule(3, 'EL', 'Earned leave', { days: 6, waitDaysAfterJoining: 90, allowedInProbation: false }),
  mkRule(6, 'ML', 'Maternity leave', { basis: 'PER_EVENT', days: 26, appliesTo: 'WOMEN', maxTimesInService: 2 }),
  mkRule(7, 'LWP', 'Leave without pay', { basis: 'UNLIMITED_UNPAID' }, false),
];
const mkWorld = (o = {}) => ({
  employee: { id: 1, code: 'X1', name: 'Asha', gender: 'Female', joinDate: '2020-01-01', exitDate: null, status: 'ACTIVE', ...(o.employee ?? {}) },
  person: {}, seat: { assignmentId: 1, positionId: 1, departmentId: 1 },
  effective: o.noPolicy ? { policy: null, from: null, line: 'No leave policy' } : { policy: { id: 1, name: 'Test policy', status: 'ACTIVE' }, from: 'ROLE', line: 'Test policy — from the role' },
  rules: o.noPolicy ? [] : RULES, startsMonth: 4, calendar: o.calendar ?? CAL, openings: o.openings ?? new Map(), requests: o.requests ?? [],
});
const TYPE = (id) => ({ id, name: RULES.find((r) => r.leaveTypeId === id)?.leaveTypeName ?? 'Study leave' });
const check = (ask, o = {}, opts = {}) => REQ.checkAsk(mkWorld(o), TYPE(ask.leaveTypeId ?? 1), { leaveTypeId: 1, halfDay: null, reason: 'x', ...ask }, { askedOn: '2026-11-01', ...opts });
{
  const clean = check({ from: '2026-11-16', to: '2026-11-18' });
  ok(clean.canSubmit && clean.checks.length === 0 && clean.quantity === 3 && clean.before === 12 && clean.after === 9, 'a plain ask: no check, 3 days, 12 -> 9', JSON.stringify(clean.checks));
  const has = (r, code, level) => r.checks.some((c) => c.code === code && c.level === level && c.text && !/[A-Z]{2,}_[A-Z]/.test(c.text));
  ok(has(check({ from: '2026-11-12', to: '2026-11-10' }), 'END_BEFORE_START', 'BLOCK'), 'BLOCK: the last day before the first');
  ok(has(check({ from: '2026-11-09', to: '2026-11-10', halfDay: 'FIRST' }), 'HALF_ON_RANGE', 'BLOCK'), 'BLOCK: a half day on a range');
  ok(has(check({ from: '2026-11-09', to: '2026-11-09', reason: '' }, {}, { mode: 'submit' }), 'NO_REASON', 'BLOCK') && !has(check({ from: '2026-11-09', to: '2026-11-09', reason: '' }), 'NO_REASON', 'BLOCK'),
    'BLOCK: an empty reason — on submit only, not on the preview');
  ok(has(check({ from: '2026-11-09', to: '2026-11-09' }, { noPolicy: true }), 'NO_POLICY', 'BLOCK'), 'BLOCK: no leave policy');
  ok(has(check({ leaveTypeId: 99, from: '2026-11-09', to: '2026-11-09' }), 'NOT_IN_POLICY', 'BLOCK'), 'BLOCK: the type is not in the policy');
  ok(has(check({ leaveTypeId: 3, from: '2026-11-09', to: '2026-11-09', halfDay: 'SECOND' }), 'HALF_NOT_ALLOWED', 'BLOCK') && check({ from: '2026-11-09', to: '2026-11-09', halfDay: 'SECOND' }).canSubmit,
    'BLOCK: a half day where the rule does not allow one (and none where it does)');
  ok(has(check({ from: '2026-11-08', to: '2026-11-08' }), 'NO_DAY_COUNTS', 'BLOCK'), 'BLOCK: no day in the range counts');
  ok(has(check({ leaveTypeId: 6, from: '2026-11-09', to: '2026-11-09' }, { employee: { gender: 'm' } }), 'NOT_FOR_GENDER', 'BLOCK')
    && check({ leaveTypeId: 6, from: '2026-11-09', to: '2026-11-09' }, { employee: { gender: 'woman' } }).canSubmit,
  'BLOCK: for women, asked by a man (gender read from free text: m / woman)');
  const unknown = check({ leaveTypeId: 6, from: '2026-11-09', to: '2026-11-09' }, { employee: { gender: null } });
  ok(has(unknown, 'GENDER_UNKNOWN', 'NOTE') && unknown.canSubmit, 'NOTE, not BLOCK: no gender recorded');
  ok(has(check({ leaveTypeId: 3, from: '2026-11-09', to: '2026-11-09' }, { employee: { joinDate: '2026-10-01' } }), 'WAITING', 'BLOCK'), 'BLOCK: inside the waiting days after joining');
  ok(has(check({ from: '2026-11-09', to: '2026-11-09' }, { employee: { joinDate: '2026-11-20' } }), 'BEFORE_JOINING', 'BLOCK'), 'BLOCK: before joining');
  ok(has(check({ from: '2026-11-09', to: '2026-11-11' }, { employee: { exitDate: '2026-11-10' } }), 'AFTER_EXIT', 'BLOCK'), 'BLOCK: after the exit date');
  ok(has(check({ from: '2026-11-16', to: '2026-11-21' }), 'TOO_LONG', 'BLOCK'), 'BLOCK: more than the longest stretch (6 > 5)');
  const used = [{ id: 40, leaveTypeId: 1, leaveTypeName: 'Casual leave', status: 'APPROVED', quantity: 10, from: '2026-06-01', to: '2026-06-12' }];
  const short = check({ from: '2026-11-16', to: '2026-11-18' }, { requests: used });
  ok(has(short, 'NOT_ENOUGH', 'BLOCK') && /Only 2 days are available in 2026-27\. This asks for 3 days\./.test(short.checks.find((x) => x.code === 'NOT_ENOUGH').text), 'BLOCK: not enough available', JSON.stringify(short.checks));
  const sickNeg = check({ leaveTypeId: 2, from: '2026-11-16', to: '2026-11-25' }, {}, {});
  const sickTooNeg = check({ leaveTypeId: 2, from: '2026-11-16', to: '2026-12-31' });
  ok(sickNeg.canSubmit && sickNeg.after < 0 && has(sickTooNeg, 'NOT_ENOUGH', 'BLOCK'), 'negative allowed: below 0 is fine, below −(the year’s days) is not', `${sickNeg.after} ${sickTooNeg.after}`);
  const twice = [{ id: 41, leaveTypeId: 6, leaveTypeName: 'Maternity leave', status: 'APPROVED', quantity: 26, from: '2022-01-03', to: '2022-02-01' }, { id: 42, leaveTypeId: 6, leaveTypeName: 'Maternity leave', status: 'APPROVED', quantity: 26, from: '2024-01-03', to: '2024-02-01' }];
  ok(has(check({ leaveTypeId: 6, from: '2026-11-09', to: '2026-11-09' }, { requests: twice }), 'TIMES_USED', 'BLOCK'), 'BLOCK: the times in service are used up');
  ok(has(check({ leaveTypeId: 6, from: '2026-11-02', to: '2026-12-10' }), 'NOT_ENOUGH', 'BLOCK'), 'BLOCK: more than one occasion gives');
  const pending = [{ id: 43, leaveTypeId: 1, leaveTypeName: 'Casual leave', status: 'PENDING', quantity: 2, from: '2026-11-17', to: '2026-11-18', halfDay: null }];
  const clash = check({ from: '2026-11-18', to: '2026-11-19' }, { requests: pending });
  ok(has(clash, 'OVERLAP', 'BLOCK') && /Casual leave, 17–18 Nov, waiting for approval/.test(clash.checks.find((x) => x.code === 'OVERLAP').text), 'BLOCK: overlaps a request of theirs', JSON.stringify(clash.checks));
  ok(!has(check({ from: '2026-11-18', to: '2026-11-19' }, { requests: pending }, { excludeRequestId: 43 }), 'OVERLAP', 'BLOCK'), '…not with itself (on approve)');
  const halves = [{ id: 44, leaveTypeId: 1, leaveTypeName: 'Casual leave', status: 'APPROVED', quantity: 0.5, from: '2026-11-19', to: '2026-11-19', halfDay: 'FIRST' }];
  ok(!has(check({ from: '2026-11-19', to: '2026-11-19', halfDay: 'SECOND' }, { requests: halves }), 'OVERLAP', 'BLOCK') && has(check({ from: '2026-11-19', to: '2026-11-19', halfDay: 'FIRST' }, { requests: halves }), 'OVERLAP', 'BLOCK'),
    'the two halves of one day do not overlap; the same half does');
  ok(has(check({ from: '2026-11-09', to: '2026-11-09' }, {}, { askedOn: '2026-11-08' }), 'SHORT_NOTICE', 'NOTE') && check({ from: '2026-11-09', to: '2026-11-09' }, {}, { askedOn: '2026-11-08' }).canSubmit,
    'NOTE: asked fewer than the notice days ahead (it does not stop the request)');
  ok(has(check({ from: '2026-11-16', to: '2026-11-16' }, {}, { askedOn: '2026-11-20' }), 'IN_PAST', 'NOTE'), 'NOTE: dates in the past (recording leave already taken)');
  ok(has(check({ leaveTypeId: 3, from: '2026-11-09', to: '2026-11-09' }), 'PROBATION', 'NOTE'), 'NOTE: not meant for probation (probation is not recorded)');
  const proof = check({ leaveTypeId: 2, from: '2026-11-16', to: '2026-11-18' });
  ok(has(proof, 'PROOF', 'NOTE') && /Bring a medical certificate: it is needed beyond 2 days\./.test(proof.checks.find((x) => x.code === 'PROOF').text), 'NOTE: proof beyond the days — a medical certificate for sick leave');
  ok(has(check({ leaveTypeId: 7, from: '2026-11-09', to: '2026-11-09' }), 'UNPAID', 'NOTE'), 'NOTE: an unpaid type');
  ok(has(check({ from: '2026-11-09', to: '2026-11-09' }, { calendar: DAYS.makeCalendar({ shift: null }) }), 'CALENDAR', 'NOTE'), 'NOTE: no shift, so the default week is used');
  const s = REQ.summaryOfAsk(check({ from: '2026-11-07', to: '2026-11-11' }), TYPE(1), { from: '2026-11-07', to: '2026-11-11' });
  ok(s === '3 days of Casual leave, 7–11 Nov (Sunday is a weekly off, Diwali is a holiday). 9 left after this.', 'the summary sentence', s);
  ok(REQ.summaryOfAsk(check({ from: '2026-11-09', to: '2026-11-09', halfDay: 'FIRST' }), TYPE(1), { from: '2026-11-09', to: '2026-11-09', halfDay: 'FIRST' }) === 'Half a day of Casual leave, 9 Nov (first half). 11.5 left after this.', 'the summary of a half day');
  ok(REQ.summaryOfAsk(check({ leaveTypeId: 7, from: '2026-11-09', to: '2026-11-09' }), TYPE(7), { from: '2026-11-09', to: '2026-11-09' }) === '1 day of Leave without pay, 9 Nov. There is no fixed limit.', 'the summary of an unlimited type');
}

/* ══ the database part: one transaction, rolled back ═════════════════════════ */
const real = { query: pool.query.bind(pool), execute: pool.execute.bind(pool), getConnection: pool.getConnection.bind(pool) };
const db = await real.getConnection();
await db.beginTransaction();
let depth = 0;
const inside = {
  query: (...a) => db.query(...a),
  execute: (...a) => db.execute(...a),
  beginTransaction: async () => { depth += 1; await db.query(`SAVEPOINT zz_lr_${depth}`); },
  commit: async () => { if (depth > 0) { await db.query(`RELEASE SAVEPOINT zz_lr_${depth}`); depth -= 1; } },
  rollback: async () => { if (depth > 0) { await db.query(`ROLLBACK TO SAVEPOINT zz_lr_${depth}`); depth -= 1; } },
  release: () => {},
};
pool.query = inside.query;
pool.execute = inside.execute;
pool.getConnection = async () => inside;

const TAG = `ZZLR${Date.now().toString(36).toUpperCase().slice(-5)}`;
const q = async (sql, params) => (await db.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0] ?? null;
const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;

let server;
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
  const T = POS.today();
  console.log(`\nleave_request_test — ${company.name} (${COMPANY}), run tag ${TAG}, today ${T}`);

  /* ══ fixture ══════════════════════════════════════════════════════════════ */
  // Monday at least three weeks ahead; a holiday on the Tuesday of the next week, an optional one on its Thursday.
  let M0 = DAYS.addDays(T, 21);
  while (DAYS.weekdayOf(M0) !== 1) M0 = DAYS.addDays(M0, 1);
  const day = (n) => DAYS.addDays(M0, n);
  const D0 = DAYS.addDays(T, -800);
  const dept = async (name) => ins("INSERT INTO hrms_departments (company_id, code, name, department_type) VALUES (?, ?, ?, 'Department')", [COMPANY, `${TAG}${name}`, `${TAG} ${name}`]);
  const D = await dept('D');
  const D2 = await dept('D2');
  const roleOf = async (code, title) => ins("INSERT INTO hrms_roles (company_id, role_code, title, role_purpose, status) VALUES (?, ?, ?, 'For a test.', 'ACTIVE')", [COMPANY, `${TAG}${code}`, `${TAG} ${title}`]);
  const R = await roleOf('R', 'Operator');
  const RM = await roleOf('M', 'Supervisor');
  const RT = await roleOf('T', 'Head');
  const calId = await ins('INSERT INTO hrms_holiday_calendars (company_id, name) VALUES (?, ?)', [COMPANY, `${TAG} Calendar`]);
  await db.query('INSERT INTO hrms_holidays (company_id, calendar_id, holiday_date, name, is_optional) VALUES (?, ?, ?, ?, 0), (?, ?, ?, ?, 1)',
    [COMPANY, calId, day(8), `${TAG} Diwali`, COMPANY, calId, day(10), `${TAG} Holi`]);
  const shiftId = await ins("INSERT INTO hrms_shifts (company_id, code, name, status, holiday_calendar_id, week_summary) VALUES (?, ?, ?, 'ACTIVE', ?, 'Mon–Sat')", [COMPANY, `${TAG}S`, `${TAG} Day`, calId]);
  await db.query(`INSERT INTO hrms_shift_days (company_id, shift_id, weekday, is_working) VALUES ${[1, 2, 3, 4, 5, 6, 7].map(() => '(?, ?, ?, ?)').join(', ')}`,
    [1, 2, 3, 4, 5, 6, 7].flatMap((wd) => [COMPANY, shiftId, wd, wd === 7 ? 0 : 1]));
  const pos = async (code, roleId, deptId = D) => ins("INSERT INTO hrms_positions (company_id, position_code, role_id, position_title, department_id, status, default_shift_id) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)",
    [COMPANY, `${TAG}-${code}`, roleId, `${TAG} ${code}`, deptId, shiftId]);
  const P = { t: await pos('T', RT), m: await pos('M', RM), e: await pos('E', R), f: await pos('F', R), v: await pos('V', RM), g: await pos('G', R), n: await pos('N', R), dh: await pos('DH', RM, D2), o: await pos('O', R, D2) };
  const primary = await one("SELECT id FROM hrms_reporting_relationship_types WHERE company_id = ? AND code = 'PRIMARY_MANAGER' AND deleted_at IS NULL", [COMPANY]);
  const line = (from, to) => POS.addPositionReporting(db, hr, from, { toPositionId: to, relationshipTypeId: primary.id, isPrimary: true, effectiveFrom: D0 });
  await line(P.m, P.t); await line(P.e, P.m); await line(P.f, P.m); await line(P.v, P.t); await line(P.g, P.v); await line(P.o, P.dh);
  const emp = async (code, gender) => ins(
    "INSERT INTO hrms_employees (company_id, employee_code, full_name, gender, date_of_joining, employment_type, employment_status) VALUES (?, ?, ?, ?, ?, 'EMPLOYEE', 'ACTIVE')",
    [COMPANY, `${TAG}${code}`, `${TAG} Person ${code}`, gender, D0]);
  const seat = async (employeeId, positionId, roleId, deptId = D) => ins(
    "INSERT INTO hrms_work_assignments (company_id, employee_id, role_id, position_id, department_id, is_primary, status, effective_from) VALUES (?, ?, ?, ?, ?, 1, 'ACTIVE', ?)",
    [COMPANY, employeeId, roleId, positionId, deptId, D0]);
  const E = { t: await emp('T', 'Male'), m: await emp('M', 'Male'), e: await emp('E', 'Female'), f: await emp('F', 'm'), g: await emp('G', 'f'), n: await emp('N', null), dh: await emp('DH', 'Male'), o: await emp('O', 'Female') };
  await seat(E.t, P.t, RT); await seat(E.m, P.m, RM); await seat(E.e, P.e, R); await seat(E.f, P.f, R); await seat(E.g, P.g, R); await seat(E.n, P.n, R);
  await seat(E.dh, P.dh, RM, D2); await seat(E.o, P.o, R, D2);

  // Leave types and one policy (April year), given to the three roles.
  const type = async (code, name, isPaid = true) => (await LEAVE.createLeaveType(db, hr, { code: `${TAG}${code}`, name: `${TAG} ${name}`, isPaid })).type.id;
  const LT = { cl: await type('CL', 'Casual leave'), sl: await type('SL', 'Sick leave'), ml: await type('ML', 'Maternity leave'), lwp: await type('LWP', 'Leave without pay', false) };
  const policy = (await LEAVE.createPolicy(db, hr, { name: `${TAG} Policy`, yearStartsMonth: 4, status: 'ACTIVE' })).policy;
  await LEAVE.updatePolicy(db, hr, policy.id, {
    rules: [
      { leaveTypeId: LT.cl, basis: 'PER_YEAR', days: 12, accrual: 'UPFRONT', halfDayAllowed: true, maxDaysAtOnce: 5, minNoticeDays: 3 },
      { leaveTypeId: LT.sl, basis: 'PER_YEAR', days: 12, accrual: 'UPFRONT', proofAfterDays: 2, countDaysOffBetween: true },
      { leaveTypeId: LT.ml, basis: 'PER_EVENT', days: 26, appliesTo: 'WOMEN', maxTimesInService: 2 },
      { leaveTypeId: LT.lwp, basis: 'UNLIMITED_UNPAID' },
    ],
  });
  for (const roleId of [R, RM, RT]) await LEAVE.putAssignment(db, hr, { scope: 'ROLE', roleId, policyId: policy.id });
  const YK = BAL.leaveYearOf(M0, 4).key;

  /* ══ 4. the approver ══════════════════════════════════════════════════════ */
  section('[4] Who approves');
  {
    const worlds = await REQ.loadWorlds(db, COMPANY, [E.e, E.g, E.n, E.m]);
    const a = await REQ.approverChain(db, COMPANY, worlds.get(E.e));
    const full = await REQ.approverChain(db, COMPANY, worlds.get(E.e), { full: true });
    ok(a.approverId === E.m && full.chain.length === 2 && full.chain[0].employeeIds.includes(E.m) && full.chain[1].employeeIds.includes(E.t),
      'the person in the chair the main position reports to; the whole chain goes up to the top', JSON.stringify(full));
    const g = await REQ.approverChain(db, COMPANY, worlds.get(E.g));
    ok(g.approverId === E.t && g.chain[0].employeeIds.length === 0 && g.chain[0].positionId === P.v, 'a vacant chair: the next chair up approves', JSON.stringify(g));
    const n = await REQ.approverChain(db, COMPANY, worlds.get(E.n));
    ok(n.approverId === null && n.chain.length === 0, 'no manager at all: nobody — it waits for HR');
    const w = worlds.get(E.e);
    ok(w.effective.policy?.id === policy.id && w.rules.length === 4 && w.startsMonth === 4 && w.calendar.hasShift && !w.calendar.isWorking(day(8)) && w.calendar.isWorking(day(10)),
      'a person’s world: the policy of their position, its rules, their shift and its holiday calendar');
  }

  /* ══ logins and the in-process server ════════════════════════════════════ */
  await setupAccess(db, COMPANY, { apply: true });
  const roleByKey = Object.fromEntries((await q('SELECT role_id, template_key FROM hrms_access_roles WHERE company_id = ? AND deleted_at IS NULL AND template_key IS NOT NULL', [COMPANY])).map((r) => [r.template_key, r.role_id]));
  const login = async (label, roleId, employeeId = null) => {
    const email = `${TAG.toLowerCase()}.${label.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.test`;
    const id = await ins('INSERT INTO users (name, email, password, role_id, team_id, company_id) VALUES (?, ?, ?, ?, NULL, ?)', [`${TAG} ${label}`, email, 'x', roleId, COMPANY]);
    await db.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [id, app.id, roleId, COMPANY]);
    if (employeeId) await db.query('UPDATE hrms_employees SET user_id = ? WHERE id = ?', [id, employeeId]);
    const roleName = (await one('SELECT name FROM roles WHERE id = ?', [roleId])).name;
    return { id, name: `${TAG} ${label}`, token: signToken({ id, name: `${TAG} ${label}`, email, role: roleName, company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
  };
  const O = { id: owner.id, token: signToken({ id: owner.id, name: owner.name, email: owner.email, role: 'admin', company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
  const U = {
    E: await login('Employee E', roleByKey.EMPLOYEE, E.e),
    F: await login('Employee F', roleByKey.EMPLOYEE, E.f),
    G: await login('Employee G', roleByKey.EMPLOYEE, E.g),
    N: await login('Employee N', roleByKey.EMPLOYEE, E.n),
    M: await login('Manager M', roleByKey.EMPLOYEE, E.m),
    T: await login('Head T', roleByKey.EMPLOYEE, E.t),
    HR: await login('HR manager', roleByKey.HR_MANAGER),
    HRX: await login('HR executive', roleByKey.HR_EXECUTIVE),
    DH: await login('Department head', roleByKey.DEPARTMENT_HEAD, E.dh),
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
  const base = `http://127.0.0.1:${listener.address().port}/api`;
  const call = async (who, method, url, body, { as = company.slug } = {}) => {
    const res = await fetch(`${base}/${as}/cf_hrms${url}`, {
      method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  const must = async (who, method, url, body) => {
    const r = await call(who, method, url, body);
    if (r.status !== 200) throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  const BALANCE_KEYS = ['leaveTypeId', 'code', 'name', 'isPaid', 'limited', 'opening', 'earned', 'taken', 'held', 'available', 'why', 'rule', 'halfDayAllowed', 'canAsk'];
  const PERSON_KEYS = ['employeeId', 'name', 'employeeCode', 'positionTitle', 'departmentName'];
  const REQUEST_KEYS = ['id', 'person', 'leaveType', 'from', 'to', 'halfDay', 'quantity', 'reason', 'status', 'approver', 'submittedAt', 'decidedAt', 'decidedBy', 'decisionNote', 'cancelNote', 'raisedByHr', 'can'];

  /* ══ 5. the routes ════════════════════════════════════════════════════════ */
  section('[5] My leave, preview, submit');
  const ask = (leaveTypeId, from, to = from, extra = {}) => ({ leaveTypeId, from, to, reason: 'Family function.', ...extra });
  {
    const mine = await call(U.E, 'GET', '/user/me/leave');
    ok(mine.status === 200 && same(keys(mine.json), ['year', 'policy', 'balances', 'requests', 'approver', 'calendarNote'])
      && mine.json.balances.length === 4 && mine.json.balances.every((b) => BALANCE_KEYS.every((k) => k in b)) && same(keys(mine.json.approver), PERSON_KEYS)
      && mine.json.approver.employeeId === E.m && mine.json.policy.policy.id === policy.id && mine.json.calendarNote === null && same(keys(mine.json.year), ['key', 'label', 'from', 'to']),
    'GET /user/me/leave -> { year, policy, balances: Balance[], requests, approver: Person, calendarNote }', JSON.stringify(mine.json).slice(0, 500));
    const cl = mine.json.balances.find((b) => b.leaveTypeId === LT.cl);
    ok(cl.available === 12 && cl.why === '12 a year, given in April' && cl.halfDayAllowed === true && cl.canAsk === true && /12 days a year/.test(cl.rule), 'the Casual leave card: 12 available, the why line, the rule sentence', JSON.stringify(cl));
    const ml = (await call(U.F, 'GET', '/user/me/leave')).json.balances.find((b) => b.leaveTypeId === LT.ml);
    ok(ml.canAsk === false && /for women only/.test(ml.cannotWhy), 'a type the person cannot use is shown with the reason', JSON.stringify(ml));
    const ofYear = await call(U.E, 'GET', `/user/me/leave?year=${YK}`);
    const badYear = await call(U.E, 'GET', '/user/me/leave?year=2026');
    ok(ofYear.status === 200 && ofYear.json.year.key === YK && badYear.status === 422 && /written like/.test(badYear.json.message), '?year= a key of the person’s year; another shape is refused in words');
    const nobody = await call(U.HR, 'GET', '/user/me/leave');
    ok(nobody.status === 403 && nobody.json.code === 'NOT_LINKED', 'a login without an employee has no leave of its own: 403 NOT_LINKED');

    const pv = await call(U.E, 'POST', '/user/me/leave/preview', ask(LT.cl, day(0), day(2)));
    ok(pv.status === 200 && same(keys(pv.json), ['days', 'quantity', 'balance', 'checks', 'approver', 'canSubmit', 'summary']) && pv.json.quantity === 3 && pv.json.canSubmit
      && pv.json.balance.before === 12 && pv.json.balance.after === 9 && pv.json.approver.employeeId === E.m && pv.json.days.length === 3
      && same(keys(pv.json.days[0]), ['date', 'weekday', 'counts', 'amount', 'why']) && /^3 days of .* Casual leave, .*\. 9 left after this\.$/.test(pv.json.summary),
    'POST /user/me/leave/preview -> Preview: the days, 12 -> 9, the approver, the summary', JSON.stringify(pv.json).slice(0, 400));
    const pvHol = await call(U.E, 'POST', '/user/me/leave/preview', ask(LT.cl, day(7), day(11)));
    ok(pvHol.json.quantity === 4 && pvHol.json.days.find((d) => d.date === day(8)).why === `${TAG} Diwali — holiday` && pvHol.json.days.find((d) => d.date === day(10)).counts,
      'the person’s own calendar: the shift’s holiday does not count, the optional holiday does', JSON.stringify(pvHol.json.days));
    const pvSick = await call(U.E, 'POST', '/user/me/leave/preview', ask(LT.sl, day(5), day(7)));
    ok(pvSick.json.quantity === 3 && pvSick.json.days.find((d) => d.date === day(6)).counts && codes(pvSick.json.checks).includes('PROOF'), 'sick leave across a Sunday counts it (the rule); proof beyond 2 days is a note');
    const noReason = await call(U.E, 'POST', '/user/me/leave', ask(LT.cl, day(0), day(2), { reason: '  ' }));
    ok(noReason.status === 422 && noReason.json.code === 'INVALID' && noReason.json.problems.length === 1 && /reason/.test(noReason.json.problems[0]), 'submit without a reason: 422 INVALID, problems = the BLOCK lines', JSON.stringify(noReason.json));
    const bad = await call(U.E, 'POST', '/user/me/leave/preview', { leaveTypeId: LT.cl, from: 'soon' });
    ok(bad.status === 422 && /first day must be a date/.test(bad.json.message), 'a body that cannot be read: 422 in words');
  }
  const r1 = (await must(U.E, 'POST', '/user/me/leave', ask(LT.cl, day(0), day(2)))).request;
  const rF = (await must(U.F, 'POST', '/user/me/leave', ask(LT.cl, day(1), day(1)))).request;
  const rS = (await must(U.E, 'POST', '/user/me/leave', ask(LT.sl, day(5), day(7), { reason: 'Fever.' }))).request;
  {
    ok(same(keys(r1), REQUEST_KEYS) && r1.status === 'PENDING' && r1.quantity === 3 && r1.approver.employeeId === E.m && r1.person.employeeId === E.e && r1.raisedByHr === false
      && JSON.stringify(r1.can) === JSON.stringify({ approve: false, reject: false, cancel: true }) && r1.reason === 'Family function.',
    'POST /user/me/leave -> { request }: PENDING, its approver, the person may cancel and not approve', JSON.stringify(r1));
    const row = await one('SELECT status, days_json, half_day, raised_by_hr, created_by FROM hrms_leave_requests WHERE id = ?', [r1.id]);
    const daysJson = typeof row.days_json === 'string' ? JSON.parse(row.days_json) : row.days_json;
    ok(row.status === 'PENDING' && daysJson.length === 3 && row.raised_by_hr === 0 && row.created_by === U.E.id, 'the counted days are kept as decided at submit');
    const audited = await one("SELECT action FROM hrms_audit_log WHERE entity_type = 'hrms_leave_requests' AND entity_id = ? ORDER BY id", [r1.id]);
    ok(audited?.action === 'CREATE', 'and it is in the audit log');
    const again = await call(U.E, 'POST', '/user/me/leave', ask(LT.cl, day(2), day(3)));
    ok(again.status === 422 && again.json.problems.some((p) => /already leave on these days/.test(p)), 'an overlapping second request is refused', JSON.stringify(again.json));
    const mineNow = (await must(U.E, 'GET', '/user/me/leave')).balances.find((b) => b.leaveTypeId === LT.cl);
    ok(mineNow.held === 3 && mineNow.available === 9 && /3 waiting for approval/.test(mineNow.why), 'the request holds its days');
  }

  section('[5b] Approvals: the feed and the context');
  {
    const feed = await call(U.M, 'GET', '/user/me/approvals');
    const item = feed.json?.items?.find((i) => i.id === r1.id);
    ok(feed.status === 200 && same(keys(feed.json), ['items', 'counts']) && feed.json.counts.pending === 3 && feed.json.items.length === 3
      && same(keys(item), ['kind', 'id', 'person', 'title', 'when', 'submittedAt', 'waitingDays', 'flags', 'status']) && item.kind === 'LEAVE' && item.status === 'PENDING'
      && /Casual leave · 3 days$/.test(item.title) && item.waitingDays === 0 && Array.isArray(item.flags),
    'GET /user/me/approvals -> the three requests waiting for the manager, with { kind, id, person, title, when, waitingDays, flags, status }', JSON.stringify(feed.json).slice(0, 500));
    ok(feed.json.items.find((i) => i.id === rS.id).flags.some((f) => /medical certificate/.test(f)), 'a flag carries the note in words (the medical certificate)');
    ok((await must(U.T, 'GET', '/user/me/approvals')).counts.pending === 0 && (await must(U.E, 'GET', '/user/me/approvals')).items.length === 0,
      'the feed is what waits for THIS login: not the manager above, not the person');
    const det = await call(U.M, 'GET', `/user/me/approvals/leave/${r1.id}`);
    const ctxt = det.json?.context;
    ok(det.status === 200 && same(keys(det.json), ['request', 'context']) && same(keys(ctxt), ['balance', 'checks', 'days', 'yearSoFar', 'teamOff', 'policyLine', 'ruleSentence', 'noticeDays'])
      && ctxt.balance.available === 12 && ctxt.days.length === 3 && ctxt.policyLine === `${TAG} Policy — from the role` && /12 days a year/.test(ctxt.ruleSentence) && ctxt.noticeDays === DAYS.daysBetween(T, day(0)),
    'GET /user/me/approvals/leave/:id -> { request, context }: the balance before it (without its own hold), the days, the policy line and rule, the notice', JSON.stringify(ctxt).slice(0, 500));
    ok(ctxt.teamOff.length === 1 && ctxt.teamOff[0].person.employeeId === E.f && same(keys(ctxt.teamOff[0]), ['person', 'from', 'to', 'leaveTypeName', 'status']) && ctxt.teamOff[0].status === 'PENDING',
      'teamOff: the other person with the same approver who is off on one of these days', JSON.stringify(ctxt.teamOff));
    ok(ctxt.yearSoFar.length === 1 && ctxt.yearSoFar[0].quantity === 3 && /Sick leave/.test(ctxt.yearSoFar[0].leaveTypeName) && same(keys(ctxt.yearSoFar[0]), ['leaveTypeName', 'quantity', 'from', 'to', 'status']),
      'yearSoFar: this person’s other leave this year', JSON.stringify(ctxt.yearSoFar));
    ok(JSON.stringify(det.json.request.can) === JSON.stringify({ approve: true, reject: true, cancel: false }), 'the approver may approve and reject');
    const peer = await call(U.F, 'GET', `/user/me/approvals/leave/${r1.id}`);
    const own = await call(U.E, 'GET', `/user/me/approvals/leave/${r1.id}`);
    ok(peer.status === 403 && peer.json.code === 'NOT_YOUR_APPROVAL' && own.status === 403, 'a peer cannot open it; nor can the person through approvals (it is in My leave)');
  }

  section('[5c] Approve, reject, cancel — who may');
  {
    const ownApprove = await call(U.E, 'POST', `/user/me/approvals/leave/${r1.id}/approve`, {});
    ok(ownApprove.status === 403 && ownApprove.json.code === 'OWN_REQUEST', 'the person cannot approve their own request', JSON.stringify(ownApprove.json));
    const peer = await call(U.F, 'POST', `/user/me/approvals/leave/${r1.id}/approve`, {});
    ok(peer.status === 403 && peer.json.code === 'NOT_YOUR_APPROVAL', 'a peer cannot approve it');
    const noNote = await call(U.M, 'POST', `/user/me/approvals/leave/${rS.id}/reject`, {});
    ok(noNote.status === 422 && noNote.json.code === 'NOTE_NEEDED', 'a rejection needs a note');
    const rej = await call(U.M, 'POST', `/user/me/approvals/leave/${rS.id}/reject`, { note: 'Please see the doctor first.' });
    ok(rej.status === 200 && rej.json.request.status === 'REJECTED' && rej.json.request.decisionNote === 'Please see the doctor first.' && rej.json.request.decidedBy === U.M.name && rej.json.request.decidedAt,
      'the approver rejects with a note: REJECTED, decidedBy the login, decidedAt', JSON.stringify(rej.json));
    const ap = await call(U.M, 'POST', `/user/me/approvals/leave/${r1.id}/approve`, { note: 'Enjoy.' });
    ok(ap.status === 200 && ap.json.request.status === 'APPROVED' && JSON.stringify(ap.json.request.can) === JSON.stringify({ approve: false, reject: false, cancel: false }),
      'the approver approves: APPROVED', JSON.stringify(ap.json));
    const twice = await call(U.M, 'POST', `/user/me/approvals/leave/${r1.id}/approve`, {});
    ok(twice.status === 409 && twice.json.code === 'NOT_PENDING' && /already approved/.test(twice.json.message), 'approving twice: 409, in words');
    const above = await call(U.T, 'POST', `/user/me/approvals/leave/${rF.id}/approve`, {});
    ok(above.status === 200 && above.json.request.status === 'APPROVED' && above.json.request.decidedBy === U.T.name, 'somebody above the approver in the same chain may decide it', JSON.stringify(above.json));
    const audits = await q("SELECT action FROM hrms_audit_log WHERE entity_type = 'hrms_leave_requests' AND entity_id IN (?) ORDER BY id", [[r1.id, rS.id]]);
    ok(audits.map((a) => a.action).join(',') === 'CREATE,CREATE,UPDATE,APPROVE', 'each decision writes the audit log (APPROVE for an approval)', audits.map((a) => a.action).join(','));
    const bal = (await must(U.E, 'GET', '/user/me/leave')).balances.find((b) => b.leaveTypeId === LT.cl);
    ok(bal.taken === 3 && bal.held === 0 && bal.available === 9, 'approved: the days are taken');
    const decided = await must(U.M, 'GET', '/user/me/approvals?status=DECIDED');
    ok(decided.items.some((i) => i.id === r1.id && i.status === 'APPROVED') && decided.items.some((i) => i.id === rS.id && i.status === 'REJECTED') && decided.counts.pending === 0,
      'the Decided tab: what this login decided');

    // Nobody above: it waits for HR.
    const rN = (await must(U.N, 'POST', '/user/me/leave', ask(LT.cl, day(14), day(14)))).request;
    ok(rN.approver === null, 'nobody in the chain: no approver, it waits for HR');
    const hrFeed = await must(U.HR, 'GET', '/user/me/approvals');
    ok(hrFeed.items.some((i) => i.id === rN.id) && !hrFeed.items.some((i) => i.id === r1.id), 'HR (leave edit) sees what waits for HR in its approvals');
    ok(!(await must(U.HRX, 'GET', '/user/me/approvals')).items.some((i) => i.id === rN.id), 'without leave edit, it does not');
    const mN = await call(U.M, 'POST', `/user/me/approvals/leave/${rN.id}/approve`, {});
    ok(mN.status === 403, 'a manager of another branch cannot decide it');
    const hrOk = await call(U.HR, 'POST', `/leave/requests/${rN.id}/approve`, { note: 'ok' });
    ok(hrOk.status === 200 && hrOk.json.request.status === 'APPROVED', 'HR approves it on the HR route');
    const hrxNo = await call(U.HRX, 'POST', `/leave/requests/${rN.id}/reject`, { note: 'x' });
    ok(hrxNo.status === 403 && hrxNo.json.code === 'FORBIDDEN', 'an HR executive (leave view only) cannot decide: 403');

    // A vacant chair walks up.
    const rG = (await must(U.G, 'POST', '/user/me/leave', ask(LT.cl, day(14), day(15)))).request;
    ok(rG.approver?.employeeId === E.t && (await must(U.T, 'GET', '/user/me/approvals')).items.some((i) => i.id === rG.id), 'a vacant chair above: the next one up gets it in their approvals');

    // Cancel.
    const rC = (await must(U.E, 'POST', '/user/me/leave', ask(LT.cl, day(21), day(21)))).request;
    const otherCancel = await call(U.F, 'POST', `/user/me/leave/${rC.id}/cancel`, {});
    ok(otherCancel.status === 404, 'another person’s request reads as not found on My leave');
    const c1 = await call(U.E, 'POST', `/user/me/leave/${rC.id}/cancel`, { note: 'Plans changed.' });
    ok(c1.status === 200 && c1.json.request.status === 'CANCELLED' && c1.json.request.cancelNote === 'Plans changed.', 'the person cancels a pending request');
    const c2 = await call(U.E, 'POST', `/user/me/leave/${r1.id}/cancel`, {});
    ok(c2.status === 200 && c2.json.request.status === 'CANCELLED', 'the person cancels an approved request whose first day is ahead');
    const relBal = (await must(U.E, 'GET', '/user/me/leave')).balances.find((b) => b.leaveTypeId === LT.cl);
    ok(relBal.taken === 0 && relBal.available === 12, 'cancelling releases the days');
    const c3 = await call(U.E, 'POST', `/user/me/leave/${r1.id}/cancel`, {});
    ok(c3.status === 409, 'a cancelled request cannot be cancelled again');

    // HR on the person's behalf, for days already taken.
    let past = DAYS.addDays(T, -7);
    while (DAYS.weekdayOf(past) === 7) past = DAYS.addDays(past, -1);
    const hrPv = await call(U.HR, 'POST', '/leave/requests/preview', { employeeId: E.e, ...ask(LT.cl, past) });
    ok(hrPv.status === 200 && codes(hrPv.json.checks).includes('IN_PAST') && hrPv.json.canSubmit, 'HR previews for a person: a past date is a note, not a block', JSON.stringify(hrPv.json.checks));
    const hrAsk = await call(U.HR, 'POST', '/leave/requests', { employeeId: E.e, ...ask(LT.cl, past, past, { reason: 'Recorded late.' }) });
    ok(hrAsk.status === 200 && hrAsk.json.request.raisedByHr === true && hrAsk.json.request.approver.employeeId === E.m, 'HR asks on the person’s behalf: raisedByHr, the same approver', JSON.stringify(hrAsk.json).slice(0, 300));
    const rP = hrAsk.json.request;
    await must(U.M, 'POST', `/user/me/approvals/leave/${rP.id}/approve`, {});
    const late = await call(U.E, 'POST', `/user/me/leave/${rP.id}/cancel`, {});
    ok(late.status === 409 && late.json.code === 'ALREADY_STARTED', 'the person cannot cancel approved leave that has started', JSON.stringify(late.json));
    const hrNoNote = await call(U.HR, 'POST', `/leave/requests/${rP.id}/cancel`, {});
    const hrCancel = await call(U.HR, 'POST', `/leave/requests/${rP.id}/cancel`, { note: 'Entered by mistake.' });
    ok(hrNoNote.status === 422 && hrNoNote.json.code === 'NOTE_NEEDED' && hrCancel.status === 200 && hrCancel.json.request.status === 'CANCELLED', 'HR cancels any time, with a note');

    // Re-check on approve: the balance moved since the request was made.
    const rR = (await must(U.E, 'POST', '/user/me/leave', ask(LT.cl, day(22), day(23)))).request;
    const lower = await call(U.HR, 'PUT', '/leave/balances', { employeeId: E.e, leaveTypeId: LT.cl, yearKey: YK, opening: -11, note: 'Taken before the app.' });
    ok(lower.status === 200 && lower.json.balance.opening === -11 && lower.json.balance.available === -1 && /-11 opening balance entered by HR/.test(lower.json.balance.why), 'PUT /leave/balances: HR’s opening, and the balance as it now is', JSON.stringify(lower.json));
    const recheck = await call(U.M, 'POST', `/user/me/approvals/leave/${rR.id}/approve`, {});
    ok(recheck.status === 422 && recheck.json.problems.some((p) => /Only 1 day is available/.test(p)), 'approve re-runs the checks against the balance as it is then (without its own hold): refused', JSON.stringify(recheck.json));
    const stillPending = await one('SELECT status FROM hrms_leave_requests WHERE id = ?', [rR.id]);
    ok(stillPending.status === 'PENDING', 'and the request is left as it was');
    const clear = await call(U.HR, 'PUT', '/leave/balances', { employeeId: E.e, leaveTypeId: LT.cl, yearKey: YK, opening: null });
    ok(clear.status === 200 && clear.json.balance.opening === 0, 'opening null clears HR’s number (HR manager holds leave remove)');
    const nowOk = await call(U.M, 'POST', `/user/me/approvals/leave/${rR.id}/approve`, {});
    ok(nowOk.status === 200 && nowOk.json.request.status === 'APPROVED', 'with the days back, it is approved');
  }

  section('[5d] HR lists, scope, another company');
  {
    const list = await call(U.HR, 'GET', `/leave/requests?q=${TAG}&status=PENDING,APPROVED`);
    ok(list.status === 200 && same(keys(list.json), ['items', 'total']) && list.json.items.length >= 3 && list.json.items.every((i) => ['PENDING', 'APPROVED'].includes(i.status)) && list.json.items.every((i) => same(keys(i), REQUEST_KEYS)),
      'GET /leave/requests: filtered by status and words', `${list.json?.items?.length}`);
    const byType = await must(U.HR, 'GET', `/leave/requests?q=${TAG}&leaveTypeId=${LT.sl}`);
    ok(byType.items.length === 1 && byType.items[0].id === rS.id, 'filtered by leave type');
    const ranged = await must(U.HR, 'GET', `/leave/requests?q=${TAG}&from=${day(5)}&to=${day(7)}`);
    ok(ranged.items.length >= 1 && ranged.items.every((i) => i.from <= day(7) && i.to >= day(5)), 'filtered by dates (overlapping)');
    const one1 = await call(U.HR, 'GET', `/leave/requests/${r1.id}`);
    ok(one1.status === 200 && same(keys(one1.json), ['request', 'context']), 'GET /leave/requests/:id -> { request, context }');
    const dh = await call(U.DH, 'GET', `/leave/requests?q=${TAG}`);
    const dhOne = await call(U.DH, 'GET', `/leave/requests/${r1.id}`);
    ok(dh.status === 200 && dh.json.items.every((i) => i.person.employeeId === E.o || i.person.employeeId === E.dh) && dhOne.status === 403 && dhOne.json.code === 'OUT_OF_SCOPE',
      'a department head sees only the requests of their own department; another one is 403 OUT_OF_SCOPE', `${dh.json?.items?.length} ${dhOne.status}`);
    const dhApprove = await call(U.DH, 'POST', `/leave/requests/${r1.id}/approve`, {});
    ok(dhApprove.status === 403, 'leave view alone cannot decide');
    if (THEM) {
      const t1 = await call(THEM, 'GET', `/leave/requests/${r1.id}`, undefined, { as: THEM.slug });
      const t2 = await call(THEM, 'POST', `/leave/requests/${rF.id}/cancel`, { note: 'x' }, { as: THEM.slug });
      const t3 = await call(THEM, 'GET', `/leave/requests?q=${TAG}`, undefined, { as: THEM.slug });
      ok(t1.status === 404 && t2.status === 404 && t3.status === 200 && t3.json.items.length === 0, 'another company: not found, and not in its list', `${t1.status} ${t2.status}`);
      const t4 = await call(THEM, 'PUT', '/leave/balances', { employeeId: E.e, leaveTypeId: LT.cl, yearKey: YK, opening: 3 }, { as: THEM.slug });
      ok(t4.status === 404, 'another company cannot enter our opening balances', `${t4.status} ${JSON.stringify(t4.json)}`);
    }
  }

  /* ══ 6. opening balances ══════════════════════════════════════════════════ */
  section('[6] Opening balances: PUT, the grid, Excel');
  {
    const wrongKey = await call(U.HR, 'PUT', '/leave/balances', { employeeId: E.f, leaveTypeId: LT.cl, yearKey: '2026', opening: 2 });
    const notNumber = await call(U.HR, 'PUT', '/leave/balances', { employeeId: E.f, leaveTypeId: LT.cl, yearKey: YK, opening: 'many' });
    const dhPut = await call(U.DH, 'PUT', '/leave/balances', { employeeId: E.o, leaveTypeId: LT.cl, yearKey: YK, opening: 2 });
    const hrxClear = await call(U.HRX, 'PUT', '/leave/balances', { employeeId: E.f, leaveTypeId: LT.cl, yearKey: YK, opening: null });
    ok(wrongKey.status === 422 && /written like 20\d\d-\d\d/.test(wrongKey.json.message) && notNumber.status === 422 && dhPut.status === 403 && hrxClear.status === 403,
      'refused: a year of the wrong shape, not a number, without leave edit, clearing without leave remove', `${wrongKey.status} ${notNumber.status} ${dhPut.status} ${hrxClear.status}`);
    const put = await must(U.HR, 'PUT', '/leave/balances', { employeeId: E.f, leaveTypeId: LT.cl, yearKey: YK, opening: 2.5, note: 'From the old register.' });
    const row = await one('SELECT opening_balance, note, period_key FROM hrms_leave_balances WHERE employee_id = ? AND leave_type_id = ? AND deleted_at IS NULL', [E.f, LT.cl]);
    ok(put.balance.opening === 2.5 && Number(row.opening_balance) === 2.5 && row.note === 'From the old register.' && row.period_key === YK && put.yearKey === YK, 'an opening is stored per person, leave type and year, with its note');
    const grid = await call(U.HR, 'GET', `/leave/balances?q=${TAG}&year=${YK}`);
    const fRow = grid.json?.rows?.find((r) => r.person.employeeId === E.f);
    ok(grid.status === 200 && same(keys(grid.json), ['year', 'leaveTypes', 'rows']) && grid.json.leaveTypes.length === 4 && grid.json.rows.length === 8
      && fRow.balances.find((b) => b.leaveTypeId === LT.cl).opening === 2.5 && fRow.year.key === YK && fRow.policy.id === policy.id,
    'GET /leave/balances: person × type, for a year', JSON.stringify(grid.json).slice(0, 300));
    const dhGrid = await must(U.DH, 'GET', `/leave/balances?q=${TAG}`);
    ok(dhGrid.rows.length === 2 && dhGrid.rows.every((r) => [E.o, E.dh].includes(r.person.employeeId)), 'a department head’s grid is their department');

    // Excel round trip.
    const file = await call(U.HR, 'GET', `/excel/leave-balances/workbook?q=${TAG}&year=${YK}`);
    ok(file.status === 200 && file.json.rows === 8, 'the leave-balances workbook: one row per person', `${file.status} ${file.json?.rows}`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(file.json.contentBase64, 'base64'));
    const ws = wb.getWorksheet('Data');
    const head = new Map();
    ws.getRow(1).eachCell((cell, col) => head.set(String(cell.value).replace(/\s*★\s*$/, ''), col));
    const clCol = head.get(`Opening — ${TAG} Casual leave`);
    const nameCol = head.get('Name');
    ok(head.has('Employee code') && head.has('Name') && clCol && head.get(`Opening — ${TAG} Sick leave`), 'columns: Employee code · Name · one Opening column per leave type', [...head.keys()].join(' | '));
    const rowOf = (name) => { for (let r = 2; r <= ws.rowCount; r += 1) if (String(ws.getCell(r, nameCol).value) === name) return r; return null; };
    const rowF = rowOf(`${TAG} Person F`);
    const rowE = rowOf(`${TAG} Person E`);
    ok(Number(ws.getCell(rowF, clCol).value) === 2.5, 'the file carries the opening already entered');
    const same0 = await call(U.HR, 'POST', '/excel/leave-balances/preview', { fileName: 'lb.xlsx', contentBase64: file.json.contentBase64 });
    ok(same0.status === 200 && same0.json.summary.same === 8 && same0.json.summary.change === 0, 'uploaded unchanged: all SAME', JSON.stringify(same0.json?.summary));
    ws.getCell(rowE, clCol).value = 4;
    ws.getCell(rowF, clCol).value = 1.5;
    const changed = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
    const pv = await call(U.HR, 'POST', '/excel/leave-balances/preview', { fileName: 'lb.xlsx', contentBase64: changed });
    ok(pv.status === 200 && pv.json.summary.change === 2 && pv.json.summary.problems === 0 && pv.json.rows.find((r) => r.row === rowF).changes[0].from === '2.5', 'two cells changed: two CHANGE rows, from -> to', JSON.stringify(pv.json?.rows?.filter((r) => r.action !== 'SAME')));
    const dhUp = await call(U.DH, 'POST', '/excel/leave-balances/preview', { fileName: 'lb.xlsx', contentBase64: changed });
    ok(dhUp.status === 403, 'uploading needs leave edit');
    const ap = await call(U.HR, 'POST', '/excel/leave-balances/apply', { fileName: 'lb.xlsx', contentBase64: changed, expect: { add: 0, change: 2 } });
    const ope = await q('SELECT employee_id, opening_balance, note FROM hrms_leave_balances WHERE employee_id IN (?) AND leave_type_id = ? AND period_key = ? AND deleted_at IS NULL', [[E.e, E.f], LT.cl, YK]);
    ok(ap.status === 200 && ap.json.changed === 2 && ope.length === 2 && Number(ope.find((o) => o.employee_id === E.e).opening_balance) === 4 && Number(ope.find((o) => o.employee_id === E.f).opening_balance) === 1.5
      && /From the Excel file lb\.xlsx/.test(ope.find((o) => o.employee_id === E.e).note), 'applied: the openings are stored, through the same writer', `${ap.status} ${JSON.stringify(ap.json)}`);
    const again = await call(U.HR, 'GET', `/excel/leave-balances/workbook?q=${TAG}&year=${YK}`);
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(Buffer.from(again.json.contentBase64, 'base64'));
    const ws2 = wb2.getWorksheet('Data');
    ok(Number(ws2.getCell(rowE, clCol).value) === 4, 'the next download carries the new number');
    ws2.getCell(rowE, clCol).value = null;
    const cleared = await call(U.HR, 'POST', '/excel/leave-balances/preview', { fileName: 'lb.xlsx', contentBase64: Buffer.from(await wb2.xlsx.writeBuffer()).toString('base64') });
    ok(cleared.json.summary.problems === 1 && /changed, not cleared, here/.test(cleared.json.rows.find((r) => r.action === 'PROBLEM').problems[0]), 'a number cannot be cleared by Excel (that is on the screen)', JSON.stringify(cleared.json?.summary));
    const stale = await call(U.HR, 'POST', '/excel/leave-balances/preview', { fileName: 'lb.xlsx', contentBase64: changed });
    ok(stale.json.rows.some((r) => r.problems.some((p) => /changed in the app since this file was downloaded/.test(p))), 'an old file over a newer opening: download again');
    const bal = (await must(U.E, 'GET', '/user/me/leave')).balances.find((b) => b.leaveTypeId === LT.cl);
    ok(bal.opening === 4 && /4 opening balance entered by HR/.test(bal.why), 'the person sees the opening HR entered', bal.why);
  }
} catch (err) {
  ok(false, 'the run finished', `${err.message} ${(err.stack ?? '').split('\n').slice(1, 3).join(' ')}`);
} finally {
  if (server?.close) await server.close();
  try { await db.rollback(); } catch { /* nothing to undo */ }
  db.release();
  pool.query = real.query;
  pool.execute = real.execute;
  pool.getConnection = real.getConnection;
  forgetAccess();
}

section('[7] Nothing is left behind');
{
  const after = await worldCount();
  const moved = Object.keys(before).filter((k) => after[k] !== before[k]);
  ok(moved.length === 0, `every count is what it was (${TABLES.length} tables)`, moved.map((k) => `${k} ${before[k]} -> ${after[k]}`).join('; '));
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
