/**
 * leave_rules_test.mjs — the leave rule additions of Karni's executive policy
 * (TM/CF_HRMS_HIRING_SPEC.md §23, 2026-10-16).
 *
 *   0. the schema (apply-leave-rules-schema.mjs): a second run plans nothing;
 *   1. the sentences and the save rules of every new field: HALF_YEARLY, the joining
 *      cut-off, credit in arrears, the notice by length, "cannot be next to"; plain
 *      problems; what does not apply is cleared;
 *   2. the balance (pure): half-yearly credits; the cut-off on the 15th vs the 16th;
 *      credit in arrears; the policy's effective date, with the half-year running on it
 *      given in full;
 *   3. the checks (pure): notice tiers at 2, 5 and 10 days; not-with across a weekend and
 *      overlapping, either rule naming the other; the 90 days' wait and what was earned
 *      in it; the attendance note;
 *   4. the policy service: effectiveFrom and the new fields saved and read back, old fields
 *      unchanged, refusals in words (one transaction, rolled back);
 *   5. a worked check against Karni's own policy (KPPL/HR/POL/004, as the setup script made
 *      it locally) for a person who joined 2025-06-10 and one who joined 2026-10-20 — the
 *      numbers worked out by hand from the policy document.
 *
 *   node scripts/cf_hrms/leave_rules_test.mjs [--company=karni] [--verbose]
 *
 * Local only. Writes only inside a transaction that is rolled back.
 */
import mysql from 'mysql2/promise';
import { pool } from '../../db.js';
import * as LEAVE from '../../apps/cf_hrms/services/leavePolicyService.js';
import { RULE_DEFAULTS, summaryOf, noticeForQuantity, rulesOfPolicies } from '../../apps/cf_hrms/services/leavePolicyRead.js';
import * as DAYS from '../../apps/cf_hrms/services/leave/days.js';
import * as BAL from '../../apps/cf_hrms/services/leave/balance.js';
import * as REQ from '../../apps/cf_hrms/services/leave/requestService.js';
import { schemaSteps } from '../../apps/cf_hrms/scripts/apply-leave-rules-schema.mjs';

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
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const codes = (checks, level = null) => checks.filter((c) => !level || c.level === level).map((c) => c.code);
const dbCfg = { host: process.env.DB_HOST ?? 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306 };

/* ══ 0. the schema ══════════════════════════════════════════════════════════ */
section('[0] The schema');
{
  const conn = await mysql.createConnection(dbCfg);
  try {
    ok((await schemaSteps(conn)).length === 0, 'apply-leave-rules-schema: nothing left to do on this database (idempotent)');
    const [cols] = await conn.query(`SELECT CONCAT(TABLE_NAME, '.', COLUMN_NAME) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
      AND ((TABLE_NAME = 'hrms_leave_policies' AND COLUMN_NAME = 'effective_from')
        OR (TABLE_NAME = 'hrms_leave_policy_rules' AND COLUMN_NAME IN ('joining_cutoff_day', 'credit_in_arrears', 'notice_tiers_json', 'not_with_json')))`);
    ok(cols.length === 5, 'effective_from and the four rule columns are there', JSON.stringify(cols.map((x) => x.c)));
  } finally { await conn.end(); }
}

/* ══ 1. sentences and the save rules ═══════════════════════════════════════ */
section('[1] Sentences and the save rules');
const NAMES = new Map([[1, 'Casual leave'], [2, 'Sick leave'], [3, 'Earned leave'], [4, 'Maternity leave'], [5, 'Leave without pay']]);
const read = (input, name = 'Earned leave', id = 3) => { const problems = []; const rule = LEAVE.readRule(input, name, problems, { leaveTypeId: id, typeNames: NAMES }); return { rule, problems }; };
{
  const hy = read({ basis: 'PER_YEAR', accrual: 'HALF_YEARLY', days: 6, prorateOnJoining: true, joiningCutoffDay: 15 }, 'Sick leave', 2);
  ok(hy.problems.length === 0 && summaryOf(hy.rule, { code: 'SL', name: 'Sick leave' })
    === '6 days a year, given in two parts: 3 days at the start of the year and 3 days at the start of its 7th month. Someone who joins part-way through a half-year gets a share for the months left in it. Someone who joins after the 15th of a month gets nothing for that month. Unused days lapse at the year end.',
  'HALF_YEARLY, prorated, cut-off 15: the sentence', summaryOf(hy.rule));
  const arr = read({ basis: 'PER_YEAR', accrual: 'MONTHLY', days: 15, creditInArrears: true });
  ok(summaryOf(arr.rule) === '15 days a year, earned 1.25 days each month and credited at the start of the next month. Unused days lapse at the year end.', 'credit in arrears: the sentence', summaryOf(arr.rule));
  const mc = read({ basis: 'PER_YEAR', accrual: 'MONTHLY', days: 12, joiningCutoffDay: 15 });
  ok(mc.rule.joiningCutoffDay === 15 && /Someone who joins after the 15th of a month gets nothing for that month\./.test(summaryOf(mc.rule)), 'MONTHLY keeps the cut-off without prorating (it always skips a late joining month)');
  const up = read({ basis: 'PER_YEAR', accrual: 'UPFRONT', days: 12, joiningCutoffDay: 15 });
  ok(up.rule.joiningCutoffDay === null && !/15th/.test(summaryOf(up.rule)), 'UPFRONT without prorating: the cut-off means nothing, so it is cleared');
  ok(read({ basis: 'PER_YEAR', accrual: 'UPFRONT', days: 12, creditInArrears: true }).rule.creditInArrears === false, 'credit in arrears is cleared where it does not apply (only MONTHLY)');
  ok(read({ basis: 'PER_EVENT', days: 5, joiningCutoffDay: 10, creditInArrears: true }).rule.joiningCutoffDay === null, 'per-event leave keeps no cut-off');
  const tiers = read({ basis: 'PER_YEAR', accrual: 'MONTHLY', days: 15, minNoticeDays: 3, noticeTiers: [{ upToDays: 3, days: 7 }, { upToDays: 7, days: 30 }, { days: 45 }] });
  ok(tiers.problems.length === 0 && tiers.rule.minNoticeDays === 0 && JSON.stringify(tiers.rule.noticeTiers) === '[{"upToDays":3,"days":7},{"upToDays":7,"days":30},{"upToDays":null,"days":45}]'
    && /Ask 7 days ahead for up to 3 days, 30 days ahead for up to 7 days, and 45 days ahead for anything longer\./.test(summaryOf(tiers.rule)),
  'the notice by length: saved in order, replaces the one notice (cleared), and its sentence', summaryOf(tiers.rule));
  ok(noticeForQuantity(tiers.rule.noticeTiers, 2) === 7 && noticeForQuantity(tiers.rule.noticeTiers, 3) === 7 && noticeForQuantity(tiers.rule.noticeTiers, 3.5) === 30
    && noticeForQuantity(tiers.rule.noticeTiers, 7) === 30 && noticeForQuantity(tiers.rule.noticeTiers, 10) === 45, 'the tier picked: up to 3 -> 7, 3.5..7 -> 30, longer -> 45');
  const nw = read({ basis: 'PER_YEAR', accrual: 'MONTHLY', days: 6, notWithLeaveTypeIds: [3, 2, 2] }, 'Casual leave', 1);
  ok(nw.problems.length === 0 && JSON.stringify(nw.rule.notWithLeaveTypeIds) === '[2,3]'
    && /Cannot be taken next to Sick leave or Earned leave, even with only days off between\./.test(summaryOf(nw.rule, null, { typeNames: NAMES })),
  '"cannot be next to": ids kept once, in order; the sentence names them', summaryOf(nw.rule, null, { typeNames: NAMES }));
  const bad = (input, re, name) => { const r = read(input); ok(r.problems.some((p) => re.test(p) && /^Earned leave: /.test(p) && !/[A-Z]{2,}_[A-Z]/.test(p)), name, JSON.stringify(r.problems)); };
  bad({ basis: 'PER_YEAR', accrual: 'MONTHLY', days: 6, joiningCutoffDay: 0 }, /day of the month .* whole number from 1 to 30/, 'a cut-off of 0 is refused in words');
  bad({ basis: 'PER_YEAR', accrual: 'MONTHLY', days: 6, joiningCutoffDay: 31 }, /from 1 to 30/, 'a cut-off of 31 is refused');
  bad({ basis: 'PER_YEAR', accrual: 'MONTHLY', days: 6, noticeTiers: [{ upToDays: 7, days: 30 }, { upToDays: 3, days: 7 }, { days: 45 }] }, /go from the shortest leave to the longest/, 'notice steps out of order are refused');
  bad({ basis: 'PER_YEAR', accrual: 'MONTHLY', days: 6, noticeTiers: [{ upToDays: 3, days: 7 }, { upToDays: 7, days: 30 }] }, /last step .* anything longer/, 'the last notice step must be open');
  bad({ basis: 'PER_YEAR', accrual: 'MONTHLY', days: 6, noticeTiers: [{ days: 7 }, { days: 45 }] }, /step 1 .* needs the length it is for/, 'only the last notice step may be open');
  bad({ basis: 'PER_YEAR', accrual: 'MONTHLY', days: 6, noticeTiers: [{ upToDays: 3 }, { days: 45 }] }, /step 1 .* needs the days ahead/, 'a notice step needs its days ahead');
  bad({ basis: 'PER_YEAR', accrual: 'MONTHLY', days: 6, noticeTiers: [{ upToDays: 3, days: 400 }, { days: 45 }] }, /days ahead of step 1 .* from 0 to 365/, 'a notice of 400 days is refused');
  bad({ basis: 'PER_YEAR', accrual: 'MONTHLY', days: 6, notWithLeaveTypeIds: [3] }, /cannot be "not next to" itself/, 'a leave type cannot be "not next to" itself');
  bad({ basis: 'PER_YEAR', accrual: 'MONTHLY', days: 6, notWithLeaveTypeIds: [99] }, /not one of this company’s leave types/, 'an unknown leave type is refused');
  bad({ basis: 'PER_YEAR', accrual: 'HALF_YEARLY' }, /say how many days a year/, 'HALF_YEARLY needs the days');
  // Old rules: the new fields are off and every old sentence stands.
  const old = read({ basis: 'PER_YEAR', accrual: 'MONTHLY', days: 12, minNoticeDays: 3 });
  ok(old.rule.joiningCutoffDay === null && old.rule.creditInArrears === false && old.rule.noticeTiers === null && Array.isArray(old.rule.notWithLeaveTypeIds) && old.rule.notWithLeaveTypeIds.length === 0
    && summaryOf(old.rule) === '12 days a year, earned a day each month. Unused days lapse at the year end. Ask 3 days ahead.', 'an old rule: the new fields are off, its sentence is unchanged', summaryOf(old.rule));
}

/* ══ 2. the balance (pure) ═════════════════════════════════════════════════ */
section('[2] The balance');
const mkRule = (id, code, name, over = {}, isPaid = true) => {
  const r = { ...RULE_DEFAULTS, leaveTypeId: id, leaveTypeCode: code, leaveTypeName: name, isPaid, ...over };
  return { ...r, summary: summaryOf(r, { code, name }, { typeNames: NAMES }) };
};
const Y26 = BAL.yearFromStart(2026, 1);
const Y27 = BAL.yearFromStart(2027, 1);
const earned = (rule, o) => BAL.balanceOf({ rule, year: Y27, startsMonth: 1, joinDate: '2020-01-01', asOf: '2027-10-16', ...o }).balance.earned;
{
  const sl = mkRule(2, 'SL', 'Sick leave', { accrual: 'HALF_YEARLY', days: 6, prorateOnJoining: true, joiningCutoffDay: 15 });
  ok(earned(sl, { asOf: '2027-01-01' }) === 3 && earned(sl, { asOf: '2027-06-30' }) === 3 && earned(sl, { asOf: '2027-07-01' }) === 6 && earned(sl, { asOf: null }) === 6,
    'HALF_YEARLY: 3 on 1 January, 3 more on 1 July (6 for the whole year)');
  const why = BAL.balanceOf({ rule: sl, year: Y27, joinDate: '2020-01-01', asOf: '2027-03-10' }).balance.why;
  ok(why === '6 a year, half on 1 January and half on 1 July, 3 so far', 'HALF_YEARLY: the why line', why);
  const YA = BAL.yearFromStart(2027, 4);
  ok(BAL.balanceOf({ rule: sl, year: YA, startsMonth: 4, joinDate: '2020-01-01', asOf: '2027-09-30' }).balance.earned === 3
    && BAL.balanceOf({ rule: sl, year: YA, startsMonth: 4, joinDate: '2020-01-01', asOf: '2027-10-01' }).balance.earned === 6, 'a year from April: the halves start in April and October');

  // ── the joining cut-off: the 15th counts the month, the 16th does not ──
  ok(earned(sl, { joinDate: '2027-08-15', asOf: '2027-08-20' }) === 2.5 && earned(sl, { joinDate: '2027-08-16', asOf: '2027-08-20' }) === 2,
    'HALF_YEARLY prorated: joined 15 Aug -> Aug..Dec = 5 months x 0.5 = 2.5; joined 16 Aug -> 4 months = 2', `${earned(sl, { joinDate: '2027-08-15', asOf: '2027-08-20' })} ${earned(sl, { joinDate: '2027-08-16', asOf: '2027-08-20' })}`);
  ok(earned(sl, { joinDate: '2027-03-15', asOf: null }) === 5 && earned(sl, { joinDate: '2027-03-16', asOf: null }) === 4.5, 'joined in the first half: the share for the months left in it, then the second half in full');
  ok(earned(sl, { joinDate: '2027-08-16', asOf: '2027-08-15' }) === 0, 'nothing before the joining date');
  const slNoPro = mkRule(2, 'SL', 'Sick leave', { accrual: 'HALF_YEARLY', days: 6 });
  ok(earned(slNoPro, { joinDate: '2027-08-16', asOf: '2027-08-20' }) === 3, 'HALF_YEARLY without prorating: a joiner gets the half in full');
  const cl = mkRule(1, 'CL', 'Casual leave', { accrual: 'MONTHLY', days: 6, joiningCutoffDay: 15 });
  ok(earned(cl, { joinDate: '2027-05-15', asOf: '2027-05-20' }) === 0.5 && earned(cl, { joinDate: '2027-05-16', asOf: '2027-05-20' }) === 0 && earned(cl, { joinDate: '2027-05-16', asOf: '2027-06-01' }) === 0.5,
    'MONTHLY with the cut-off: joined on the 15th earns May; on the 16th May is skipped and June is the first');
  const upPro = mkRule(1, 'CL', 'Casual leave', { days: 12, prorateOnJoining: true, joiningCutoffDay: 15 });
  ok(earned(upPro, { joinDate: '2027-07-15' }) === 6 && earned(upPro, { joinDate: '2027-07-16' }) === 5, 'UPFRONT prorated with the cut-off: July counts on the 15th (6), not on the 16th (5)');
  const upOld = mkRule(1, 'CL', 'Casual leave', { days: 12, prorateOnJoining: true });
  ok(earned(upOld, { joinDate: '2027-07-16' }) === 6, 'without a cut-off the joining month counts, as before');

  // ── credit in arrears ──
  const el = mkRule(3, 'EL', 'Earned leave', { accrual: 'MONTHLY', days: 15, creditInArrears: true });
  const elAdv = mkRule(3, 'EL', 'Earned leave', { accrual: 'MONTHLY', days: 15 });
  ok(earned(el, { joinDate: '2027-01-10', asOf: '2027-03-15' }) === 2.5 && earned(elAdv, { joinDate: '2027-01-10', asOf: '2027-03-15' }) === 3.75,
    'in arrears: on 15 Mar the January and February credits are in (2.5); given in advance March is in too (3.75)');
  ok(earned(el, { joinDate: '2027-05-10', asOf: '2027-05-31' }) === 0 && earned(el, { joinDate: '2027-05-10', asOf: '2027-06-01' }) === 1.25, 'a joining month is credited on the 1st of the next');
  ok(earned(el, { asOf: '2027-01-01' }) === 1.25 && earned(el, { asOf: null }) === 15, 'the December credit comes on 1 January and opens the new year; a whole year still gives 15');
  ok(BAL.balanceOf({ rule: el, year: BAL.yearFromStart(2028, 1), joinDate: '2027-05-10', asOf: '2028-01-01' }).balance.earned === 1.25, '… also for a joiner of the year before');
  ok(/^1\.25 a month, credited at the start of the next month, 2\.5 so far$/.test(BAL.balanceOf({ rule: el, year: Y27, joinDate: '2027-01-10', asOf: '2027-03-15' }).balance.why), 'in arrears: the why line');

  // ── the policy's effective date ──
  const E = '2026-10-01';
  const at26 = (rule, asOf, joinDate = '2020-01-01') => BAL.balanceOf({ rule, year: Y26, joinDate, asOf, effectiveFrom: E }).balance;
  const cl6 = mkRule(1, 'CL', 'Casual leave', { accrual: 'MONTHLY', days: 6 });
  ok(at26(cl6, '2026-09-30').earned === 0 && at26(cl6, '2026-10-16').earned === 0.5 && at26(cl6, '2026-12-31').earned === 1.5, 'MONTHLY from the effective date: nothing in September, Oct 0.5, by December 1.5');
  ok(/^0\.5 a month from 1 Oct 2026, when the policy takes effect, 0\.5 so far$/.test(at26(cl6, '2026-10-16').why), 'the why line says from when', at26(cl6, '2026-10-16').why);
  ok(at26(el, '2026-10-16').earned === 0 && at26(el, '2026-11-01').earned === 1.25 && at26(el, '2026-12-31').earned === 2.5, 'in arrears from the effective date: October is credited on 1 Nov (September never is)');
  ok(at26(sl, '2026-10-16').earned === 3 && at26(sl, null).earned === 3 && /3 for the half-year running on 1 Oct 2026, when the policy takes effect/.test(at26(sl, '2026-10-16').why),
    'HALF_YEARLY: the half running on the effective date is given in full (3 — the July credit); January’s is not', at26(sl, '2026-10-16').why);
  ok(at26(sl, '2026-10-16', '2026-08-10').earned === 2.5, 'a joiner of that same half before the policy: their joining share (Aug..Dec = 2.5), as if it were in force');
  ok(at26(sl, '2026-11-01', '2026-10-20').earned === 1, 'a joiner after the effective date: the joining rule (Oct after the 15th skipped: Nov, Dec = 1)');
  ok(at26(upOld, '2026-10-16').earned === 3, 'UPFRONT from the effective date: the share of the months left (Oct..Dec = 3 of 12)');
  ok(BAL.balanceOf({ rule: cl6, year: BAL.yearFromStart(2025, 1), joinDate: '2020-01-01', asOf: '2025-12-01', effectiveFrom: E }).balance.earned === 0, 'a year before the effective date earns nothing');
  ok(BAL.balanceOf({ rule: el, year: Y27, joinDate: '2020-01-01', asOf: '2027-01-01', effectiveFrom: E }).balance.earned === 1.25
    && BAL.balanceOf({ rule: sl, year: Y27, joinDate: '2020-01-01', asOf: '2027-01-01', effectiveFrom: E }).balance.earned === 3, 'the year after: counted in full (December’s EL in on 1 January, SL 3)');
  const carry = mkRule(1, 'CL', 'Casual leave', { accrual: 'MONTHLY', days: 6, carryForward: 'ALL' });
  ok(BAL.balanceOf({ rule: carry, year: Y27, joinDate: '2020-01-01', asOf: '2027-01-05', effectiveFrom: E, requests: [{ id: 1, status: 'APPROVED', quantity: 0.5, from: '2026-11-02' }] }).balance.opening === 1,
    'carry forward counts only what was earned from the effective date (1.5 − 0.5 = 1)');
}

/* ══ 3. the checks (pure) ══════════════════════════════════════════════════ */
section('[3] The checks');
// Monday to Friday: Saturday and Sunday are the weekly offs. A holiday on Wednesday 18 Nov 2026.
const CAL5 = DAYS.makeCalendar({ shift: { name: 'Office', workingWeekdays: [1, 2, 3, 4, 5] }, holidays: [{ date: '2026-11-18', name: 'Guru Nanak Jayanti', isOptional: false }] });
const TIERS = [{ upToDays: 3, days: 7 }, { upToDays: 7, days: 30 }, { upToDays: null, days: 45 }];
const RULES = [
  mkRule(1, 'CL', 'Casual leave', { accrual: 'MONTHLY', days: 6, halfDayAllowed: true, maxDaysAtOnce: 2, minNoticeDays: 1, notWithLeaveTypeIds: [2, 3], waitDaysAfterJoining: 90 }),
  mkRule(2, 'SL', 'Sick leave', { accrual: 'HALF_YEARLY', days: 6, prorateOnJoining: true, joiningCutoffDay: 15, halfDayAllowed: true, proofAfterDays: 2 }),
  mkRule(3, 'EL', 'Earned leave', { accrual: 'MONTHLY', days: 15, creditInArrears: true, noticeTiers: TIERS, waitDaysAfterJoining: 90, halfDayAllowed: true,
    notes: 'Credited only for a month with 20 or more present days. Paid out only at exit, when the notice period has been served.' }),
  mkRule(4, 'ML', 'Maternity leave', { basis: 'PER_EVENT', accrual: 'ON_REQUEST', days: 182, appliesTo: 'WOMEN', maxTimesInService: 2, countDaysOffBetween: true, proofAfterDays: 0,
    notes: 'Only for a woman who has worked at least 80 days in the 12 months before the expected delivery date. Tell HR in writing.' }),
  mkRule(5, 'LOP', 'Leave without pay', { basis: 'UNLIMITED_UNPAID', halfDayAllowed: true, notes: 'Taken when no leave of the right type is left.' }, false),
];
const mkWorld = (o = {}) => ({
  employee: { id: 1, code: 'X1', name: 'Asha', gender: 'Female', joinDate: '2020-01-01', exitDate: null, status: 'ACTIVE', ...(o.employee ?? {}) },
  person: {}, seat: { assignmentId: 1, positionId: 1, departmentId: 1 },
  effective: { policy: { id: 1, name: 'Test policy', status: 'ACTIVE' }, from: 'ROLE', line: 'Test policy — from the role' },
  rules: o.rules ?? RULES, startsMonth: 1, effectiveFrom: o.effectiveFrom ?? null, calendar: o.calendar ?? CAL5,
  // Enough opening balance that "not enough" never gets in the way of what is tested.
  openings: o.openings ?? new Map([1, 2, 3].map((id) => [id, new Map([['2026', { opening: 60, note: null }], ['2027', { opening: 60, note: null }]])])),
  requests: o.requests ?? [],
});
const TYPE = (id) => ({ id, name: NAMES.get(id) });
const check = (ask, o = {}, opts = {}) => REQ.checkAsk(mkWorld(o), TYPE(ask.leaveTypeId ?? 1), { leaveTypeId: 1, halfDay: null, reason: 'x', ...ask }, { askedOn: '2026-11-01', ...opts });
{
  // ── notice by length: asked on 1 Nov, 8 days ahead of Mon 9 Nov ──
  const el2 = check({ leaveTypeId: 3, from: '2026-11-09', to: '2026-11-10' });
  const el5 = check({ leaveTypeId: 3, from: '2026-11-09', to: '2026-11-13' });
  const el10 = check({ leaveTypeId: 3, from: '2026-11-09', to: '2026-11-23' });
  const text = (r) => r.checks.find((c) => c.code === 'SHORT_NOTICE')?.text ?? '';
  ok(el2.quantity === 2 && !codes(el2.checks).includes('SHORT_NOTICE'), '2 days, asked 8 days ahead: the tier asks 7 — no note', JSON.stringify(el2.checks));
  ok(el5.quantity === 5 && text(el5) === 'Asked 8 days ahead. For 5 days the policy asks for 30 days ahead.' && el5.canSubmit, '5 days: the tier asks 30 — a NOTE, not a block', text(el5));
  ok(el10.quantity === 10 && text(el10) === 'Asked 8 days ahead. For 10 days the policy asks for 45 days ahead.', '10 days (a holiday and two weekends do not count): the tier asks 45', `${el10.quantity} ${text(el10)}`);
  const el2late = check({ leaveTypeId: 3, from: '2026-11-03', to: '2026-11-04' });
  ok(text(el2late) === 'Asked 2 days ahead. For 2 days the policy asks for 7 days ahead.', '2 days asked 2 days ahead: the 7-day tier, as a NOTE', text(el2late));

  // ── not with: CL may not touch SL or EL ──
  const elWeek = [{ id: 50, leaveTypeId: 3, leaveTypeName: 'Earned leave', status: 'APPROVED', quantity: 5, from: '2026-11-09', to: '2026-11-13', halfDay: null }];
  const monAfter = check({ from: '2026-11-16', to: '2026-11-16' }, { requests: elWeek });
  const nwText = monAfter.checks.find((c) => c.code === 'NOT_WITH')?.text ?? '';
  ok(codes(monAfter.checks, 'BLOCK').includes('NOT_WITH') && !monAfter.canSubmit
    && nwText === 'Casual leave cannot be taken next to Earned leave. There is Earned leave, 9–13 Nov, approved, next to these dates with only days off between.',
  'BLOCK: CL on the Monday after an EL week — only the weekend between', nwText);
  ok(!codes(check({ from: '2026-11-17', to: '2026-11-17' }, { requests: elWeek }).checks).includes('NOT_WITH'), 'a working day between: no block');
  ok(codes(check({ from: '2026-11-06', to: '2026-11-06' }, { requests: elWeek }).checks, 'BLOCK').includes('NOT_WITH'), '… the Friday before (the weekend between) is blocked too');
  const over = check({ from: '2026-11-12', to: '2026-11-13' }, { requests: elWeek });
  ok(codes(over.checks, 'BLOCK').includes('NOT_WITH') && codes(over.checks, 'BLOCK').includes('OVERLAP') && /on these days\.$/.test(over.checks.find((c) => c.code === 'NOT_WITH').text), 'overlapping: NOT_WITH as well as OVERLAP');
  const slTue = [{ id: 51, leaveTypeId: 2, leaveTypeName: 'Sick leave', status: 'PENDING', quantity: 1, from: '2026-11-17', to: '2026-11-17', halfDay: null }];
  ok(codes(check({ from: '2026-11-19', to: '2026-11-19' }, { requests: slTue }).checks, 'BLOCK').includes('NOT_WITH'), 'a holiday between is a day off too: a pending SL on Tue, CL on Thu after the Wednesday holiday is blocked');
  const clMon = [{ id: 52, leaveTypeId: 1, leaveTypeName: 'Casual leave', status: 'APPROVED', quantity: 1, from: '2026-11-16', to: '2026-11-16', halfDay: null }];
  const elAfterCl = check({ leaveTypeId: 3, from: '2026-11-09', to: '2026-11-13' }, { requests: clMon });
  ok(codes(elAfterCl.checks, 'BLOCK').includes('NOT_WITH'), 'either way round: EL next to a CL is blocked by the CL rule naming EL', JSON.stringify(elAfterCl.checks));
  ok(!codes(check({ from: '2026-11-16', to: '2026-11-16' }, { requests: [{ ...elWeek[0], status: 'REJECTED' }] }).checks).includes('NOT_WITH')
    && !codes(check({ leaveTypeId: 5, from: '2026-11-16', to: '2026-11-16' }, { requests: elWeek }).checks).includes('NOT_WITH'),
  'a rejected request does not count; a type no rule names (LOP) is free');
  ok(!codes(check({ from: '2026-11-16', to: '2026-11-16' }, { requests: elWeek }, { excludeRequestId: 50 }).checks).includes('NOT_WITH'), 'a request is never next to itself (on approve)');

  // ── the 90 days' wait, and what was earned in it ──
  const joiner = { employee: { joinDate: '2027-01-01' }, openings: new Map() };
  const inWait = REQ.checkAsk(mkWorld(joiner), TYPE(1), { leaveTypeId: 1, from: '2027-03-31', to: '2027-03-31', halfDay: null, reason: 'x' }, { askedOn: '2027-03-20' });
  const elInWait = REQ.checkAsk(mkWorld(joiner), TYPE(3), { leaveTypeId: 3, from: '2027-03-31', to: '2027-03-31', halfDay: null, reason: 'x' }, { askedOn: '2027-03-20' });
  ok(codes(inWait.checks, 'BLOCK').includes('WAITING') && codes(elInWait.checks, 'BLOCK').includes('WAITING')
    && /can be taken after 90 days in the job, from 1 Apr 2027/.test(inWait.checks.find((c) => c.code === 'WAITING').text),
  'inside the 90 days (joined 1 Jan 2027): CL and EL are blocked, from 1 Apr 2027');
  ok(inWait.before === 1.5 && elInWait.before === 2.5, 'what the three probation months earned: CL 1.5 (Jan–Mar), EL 2.5 so far (Jan, Feb credited; March comes on 1 Apr)', `${inWait.before} ${elInWait.before}`);
  const after = REQ.checkAsk(mkWorld(joiner), TYPE(1), { leaveTypeId: 1, from: '2027-04-01', to: '2027-04-01', halfDay: null, reason: 'x' }, { askedOn: '2027-03-25' });
  const elAfter = REQ.checkAsk(mkWorld(joiner), TYPE(3), { leaveTypeId: 3, from: '2027-04-01', to: '2027-04-01', halfDay: null, reason: 'x' }, { askedOn: '2027-03-20' });
  ok(!codes(after.checks).includes('WAITING') && after.canSubmit && after.before === 2 && !codes(elAfter.checks).includes('WAITING') && elAfter.before === 3.75,
    'from 1 Apr the wait is over: EL 3.75 (the three probation months), CL 2 (the probation 1.5 + April’s 0.5, given on 1 Apr)', `${after.before} ${elAfter.before} ${JSON.stringify(after.checks)}`);

  // ── the attendance note ──
  const att = el2.checks.find((c) => c.code === 'ATTENDANCE');
  ok(att?.level === 'NOTE' && att.text === 'Attendance is not recorded yet, so this is assumed and must be checked by HR: Credited only for a month with 20 or more present days.',
    'EL: a NOTE from the rule’s note — only its attendance sentence', att?.text);
  const ml = check({ leaveTypeId: 4, from: '2026-11-09', to: '2026-11-09' });
  ok(/^Attendance is not recorded yet, so this is assumed and must be checked by HR: Only for a woman who has worked at least 80 days/.test(ml.checks.find((c) => c.code === 'ATTENDANCE')?.text ?? ''), 'ML: the 80 days worked, as a NOTE');
  ok(!codes(check({ leaveTypeId: 5, from: '2026-11-09', to: '2026-11-09' }).checks).includes('ATTENDANCE') && !codes(check({ from: '2026-11-09', to: '2026-11-09' }).checks).includes('ATTENDANCE'),
    'no note for a rule whose note says nothing of attendance, or that has none');
  const elApprove = REQ.checkAsk(mkWorld(), TYPE(3), { leaveTypeId: 3, from: '2026-11-09', to: '2026-11-10', halfDay: null, reason: 'x' }, { mode: 'approve', askedOn: '2026-11-01' });
  ok(codes(elApprove.checks, 'NOTE').includes('ATTENDANCE'), 'the note shows on approve too (the same checks re-run)');
}

/* ══ 4. the policy service (one transaction, rolled back) ═════════════════════ */
section('[4] The policy service');
const conn = await pool.getConnection();
await conn.beginTransaction();
try {
  const [[company]] = await conn.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
  if (!company) throw new Error(`No company "${slug}".`);
  const COMPANY = company.id;
  const [[owner]] = await conn.query(
    `SELECT u.id FROM users u JOIN app_user_access aua ON aua.user_id = u.id AND aua.deleted_at IS NULL
       JOIN apps a ON a.id = aua.app_id AND a.slug = 'cf_hrms' AND a.company_id = u.company_id JOIN roles r ON r.id = aua.role_id
      WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [COMPANY]);
  const c = { companyId: COMPANY, userId: owner?.id ?? null };
  const TAG = `ZZLRT${Date.now().toString(36).toUpperCase().slice(-4)}`;
  const t1 = (await LEAVE.createLeaveType(conn, c, { code: `${TAG}A`, name: `${TAG} Casual` })).type;
  const t2 = (await LEAVE.createLeaveType(conn, c, { code: `${TAG}B`, name: `${TAG} Earned` })).type;
  const made = (await LEAVE.createPolicy(conn, c, { name: `${TAG} policy`, code: `${TAG}/HR/POL/1`, effectiveFrom: '2026-10-01' })).policy;
  ok(made.code === `${TAG}/HR/POL/1` && made.effectiveFrom === '2026-10-01', 'a policy code may carry slashes; effectiveFrom is saved and read back', JSON.stringify({ code: made.code, effectiveFrom: made.effectiveFrom }));
  const saved = (await LEAVE.updatePolicy(conn, c, made.id, {
    rules: [
      { leaveTypeId: t1.id, basis: 'PER_YEAR', accrual: 'MONTHLY', days: 6, notWithLeaveTypeIds: [t2.id], joiningCutoffDay: 15 },
      { leaveTypeId: t2.id, basis: 'PER_YEAR', accrual: 'MONTHLY', days: 15, creditInArrears: true, noticeTiers: TIERS },
    ],
  })).policy;
  const [ra, rb] = saved.rules;
  ok(JSON.stringify(ra.notWithLeaveTypeIds) === JSON.stringify([t2.id]) && ra.joiningCutoffDay === 15 && rb.creditInArrears === true
    && JSON.stringify(rb.noticeTiers) === JSON.stringify(TIERS) && rb.minNoticeDays === 0,
  'the new rule fields are saved and read back', JSON.stringify({ ra, rb }));
  ok(new RegExp(`Cannot be taken next to ${TAG} Earned, even with only days off between\\.`).test(ra.summary), 'the read sentence names the other leave type', ra.summary);
  const OLD_KEYS = ['id', 'leaveTypeId', 'leaveTypeCode', 'leaveTypeName', 'isPaid', 'sortOrder', 'basis', 'days', 'accrual', 'daysWorkedPerLeaveDay', 'prorateOnJoining', 'allowedInProbation',
    'waitDaysAfterJoining', 'carryForward', 'carryForwardCapDays', 'encashable', 'encashCapDays', 'maxDaysAtOnce', 'minNoticeDays', 'halfDayAllowed', 'countDaysOffBetween', 'proofAfterDays',
    'appliesTo', 'maxTimesInService', 'expiresAfterDays', 'negativeBalanceAllowed', 'notes'];
  const NEW_KEYS = ['joiningCutoffDay', 'creditInArrears', 'noticeTiers', 'notWithLeaveTypeIds', 'minPresentDaysForCredit']; // §28.4 added the last
  ok(JSON.stringify(Object.keys(ra)) === JSON.stringify([...OLD_KEYS, ...NEW_KEYS, 'summary']), 'a rule: the old fields in their order, then the new ones, then the sentence', JSON.stringify(Object.keys(ra)));
  const e1 = await caught(() => LEAVE.updatePolicy(conn, c, made.id, { rules: [{ leaveTypeId: t1.id, basis: 'PER_YEAR', accrual: 'MONTHLY', days: 6, notWithLeaveTypeIds: [t1.id] }] }));
  ok(e1?.status === 422 && e1.problems?.some((p) => p === `${TAG} Casual: it cannot be "not next to" itself.`), '422: not next to itself, in words, by leave type', JSON.stringify(e1?.problems));
  const e2 = await caught(() => LEAVE.updatePolicy(conn, c, made.id, { effectiveFrom: '2026-02-30' }));
  ok(e2?.status === 422 && /takes effect must be a date/.test(JSON.stringify(e2.problems ?? e2.message)), '422: an effective date that is not a date', JSON.stringify(e2?.problems));
  const cleared = (await LEAVE.updatePolicy(conn, c, made.id, { effectiveFrom: null })).policy;
  ok(cleared.effectiveFrom === null, 'the effective date can be cleared (from the start)');
  const copy = (await LEAVE.createPolicy(conn, c, { name: `${TAG} copy`, copyOf: made.id })).policy;
  ok(JSON.stringify(copy.rules.map((r) => [r.notWithLeaveTypeIds, r.noticeTiers, r.creditInArrears, r.joiningCutoffDay])) === JSON.stringify(saved.rules.map((r) => [r.notWithLeaveTypeIds, r.noticeTiers, r.creditInArrears, r.joiningCutoffDay])),
    'a copied policy keeps the new fields');
  const prev = await LEAVE.previewRuleSummary(conn, COMPANY, { rule: { leaveTypeId: t1.id, basis: 'PER_YEAR', accrual: 'HALF_YEARLY', days: 6, notWithLeaveTypeIds: [t2.id] } });
  ok(prev.problems.length === 0 && /given in two parts/.test(prev.summary) && new RegExp(`next to ${TAG} Earned`).test(prev.summary), 'preview-summary: the new sentences as the editor types', prev.summary);
} catch (err) {
  ok(false, 'the service part finished', `${err.message} ${(err.stack ?? '').split('\n').slice(1, 3).join(' ')}`);
} finally {
  await conn.rollback().catch(() => {});
  conn.release();
}

/* ══ 5. Karni's own policy — a worked check ═════════════════════════════════ */
section('[5] Karni’s policy (KPPL/HR/POL/004), worked by hand');
{
  const [[company]] = await pool.query('SELECT id FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
  const [[p]] = company ? await pool.query("SELECT id, year_starts_month, effective_from FROM hrms_leave_policies WHERE company_id = ? AND code = 'KPPL/HR/POL/004' AND deleted_at IS NULL", [company.id]) : [[null]];
  if (!ok(Boolean(p), 'the policy is there locally (made by setup-karni-exec-leave.mjs --apply)')) {
    console.log('  (run apps/cf_hrms/scripts/setup-karni-exec-leave.mjs --apply first)');
  } else {
    const rules = (await rulesOfPolicies(pool, company.id, [p.id])).get(p.id);
    const eff = String(p.effective_from).slice(0, 10);
    ok(eff === '2026-10-01' && Number(p.year_starts_month) === 1 && rules.map((r) => r.leaveTypeCode).join(' ') === 'CL SL EL ML LOP', 'calendar year, effective 1 Oct 2026, CL SL EL ML LOP');
    // No shift recorded: Monday to Saturday working, Sunday off — the document's factory week.
    const world = (joinDate) => ({
      employee: { id: 1, code: 'K1', name: 'Exec', gender: 'Female', joinDate, exitDate: null, status: 'ACTIVE' },
      person: {}, seat: null, effective: { policy: { id: p.id, name: 'Leave policy — Executives', status: 'ACTIVE' }, from: 'ROLE', line: '' },
      rules, startsMonth: 1, effectiveFrom: eff, calendar: DAYS.makeCalendar({ shift: null }), openings: new Map(), requests: [],
    });
    const avail = (joinDate, yearStart, asOf) => Object.fromEntries(REQ.balancesOf(world(joinDate), BAL.yearFromStart(yearStart, 1), asOf).map((b) => [b.code, b.available]));
    const want = (got, exp, name) => ok(Object.keys(exp).every((k) => got[k] === exp[k]), name, `got ${JSON.stringify(got)}`);
    // A — joined 10 Jun 2025, long past probation. Credits count from 1 Oct 2026.
    want(avail('2025-06-10', 2026, '2026-10-16'), { CL: 0.5, SL: 3, EL: 0, ML: 182, LOP: null },
      'A (joined 2025-06-10) on 16 Oct 2026: CL 0.5 (October’s, at its start) · SL 3 (the July half, in full) · EL 0 (October’s comes on 1 Nov) · ML 182 · LOP no limit');
    want(avail('2025-06-10', 2026, '2026-12-31'), { CL: 1.5, SL: 3, EL: 2.5 }, 'A on 31 Dec 2026: CL 1.5 (Oct–Dec) · SL 3 · EL 2.5 (Oct, Nov; December’s comes on 1 Jan)');
    want(avail('2025-06-10', 2027, '2027-01-01'), { CL: 0.5, SL: 3, EL: 1.25 }, 'A on 1 Jan 2027: all 2026 leave lapsed · CL 0.5 · SL 3 · EL 1.25 (December 2026’s)');
    want(avail('2025-06-10', 2027, '2027-07-01'), { CL: 3.5, SL: 6, EL: 8.75 }, 'A on 1 Jul 2027: CL 3.5 (Jan–Jul) · SL 6 · EL 8.75 (7 credits: Dec–Jun)');
    want(avail('2025-06-10', 2027, '2027-12-31'), { CL: 6, SL: 6, EL: 15 }, 'A on 31 Dec 2027: the full year — CL 6 · SL 6 · EL 15');
    // B — joined 20 Oct 2026 (after the 15th), probation to 18 Jan 2027.
    want(avail('2026-10-20', 2026, '2026-12-15'), { CL: 1.5, SL: 1, EL: 2.5 },
      'B (joined 2026-10-20) on 15 Dec 2026: CL 1.5 (Oct–Dec) · SL 1 (Nov, Dec — October skipped, joined after the 15th) · EL 2.5 (Oct, Nov credited) — attendance assumed');
    const bw = world('2026-10-20');
    const clB = REQ.checkAsk(bw, { id: rules[0].leaveTypeId, name: 'Casual leave' }, { leaveTypeId: rules[0].leaveTypeId, from: '2026-12-15', to: '2026-12-15', halfDay: null, reason: 'x' }, { askedOn: '2026-12-10' });
    const slB = REQ.checkAsk(bw, { id: rules[1].leaveTypeId, name: 'Sick leave' }, { leaveTypeId: rules[1].leaveTypeId, from: '2026-12-15', to: '2026-12-15', halfDay: null, reason: 'x' }, { askedOn: '2026-12-15' });
    ok(codes(clB.checks, 'BLOCK').includes('WAITING') && /from 18 Jan 2027/.test(clB.checks.find((c) => c.code === 'WAITING').text) && slB.canSubmit,
      'B in December: CL (and EL) wait until 18 Jan 2027; SL can be taken in probation');
    want(avail('2026-10-20', 2027, '2027-01-19'), { CL: 0.5, SL: 3, EL: 1.25 }, 'B on 19 Jan 2027 (probation over): CL 0.5 · SL 3 · EL 1.25 (December 2026’s) — the 2026 credits lapsed on 31 Dec');
    const ask = (halfDay) => REQ.checkAsk(bw, { id: rules[0].leaveTypeId, name: 'Casual leave' }, { leaveTypeId: rules[0].leaveTypeId, from: '2027-01-19', to: '2027-01-19', halfDay, reason: 'x' }, { askedOn: '2027-01-15' });
    const half = ask('FIRST');
    const full = ask(null);
    ok(half.canSubmit && half.before === 0.5 && half.after === 0 && codes(full.checks, 'BLOCK').includes('NOT_ENOUGH'),
      'B on 19 Jan 2027: half a CL day can be asked (0.5 -> 0); a whole day is more than there is', `${JSON.stringify(half.checks)} ${JSON.stringify(full.checks)}`);
  }
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
