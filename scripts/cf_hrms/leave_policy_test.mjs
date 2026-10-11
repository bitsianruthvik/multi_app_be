/**
 * leave_policy_test.mjs — leave types, leave policies and where they apply (2026-10-11).
 * Contract: TM/CF_HRMS_HIRING_SPEC.md §8.
 *
 *   1. THE SENTENCE: the server-written summary of a rule, as exact strings,
 *      for every basis, every way of earning, every carry-forward and the
 *      limits — and that a field which does not apply says nothing;
 *   2. a rule read from a body: every problem names its leave type; what a
 *      combination makes meaningless is cleared, not kept;
 *   3. the starting points: their shape, their caution, that making a policy
 *      from one creates the leave types the company lacks (once);
 *   4. policies: create, copy, edit; the rule set replaced whole or not at all;
 *   5. where a policy applies: role beats location beats company; removing one
 *      falls back; only an ACTIVE policy can be assigned; an assigned policy
 *      cannot be archived, drafted or deleted; `usedBy`; the reads that carry it;
 *   6. leave types and their refusals;
 *   7. another company; 8. permissions, through the real middleware.
 *
 *   node scripts/cf_hrms/leave_policy_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND. Every write is in a transaction that is ROLLED BACK —
 * no policy, leave type or assignment made here survives. The end re-reads
 * every hrms_ row count of both companies used.
 *
 * Local only — it refuses a non-local DB_HOST.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import hrmsApp from '../../apps/cf_hrms/app.js';
import * as LEAVE from '../../apps/cf_hrms/services/leavePolicyService.js';
import { summaryOf, resolveEffective, RULE_DEFAULTS } from '../../apps/cf_hrms/services/leavePolicyRead.js';
import { TEMPLATE_NOTE, LEAVE_TYPES_OFFERED, TEMPLATES } from '../../apps/cf_hrms/services/leavePolicyTemplates.js';
import * as POS from '../../apps/cf_hrms/services/positionService.js';
import * as ORG from '../../apps/cf_hrms/services/organisationService.js';
import { getRole } from '../../apps/cf_hrms/services/roleContentService.js';
import { getPositionCard } from '../../apps/cf_hrms/services/orgChartService.js';
import { myPlace } from '../../apps/cf_hrms/services/selfService.js';

const slug = (process.argv.find((a) => a.startsWith('--company=')) || '--company=karni').split('=')[1];
const VERBOSE = process.argv.includes('--verbose');
if (!['localhost', '127.0.0.1', '::1'].includes(String(process.env.DB_HOST ?? 'localhost'))) {
  console.error(`Refusing to run against DB_HOST=${process.env.DB_HOST}. This test is local only.`);
  process.exit(2);
}

let passed = 0;
const failed = [];
const skipped = [];
const ok = (cond, name, detail = '') => {
  if (cond) { passed += 1; if (VERBOSE) console.log(`  ok    ${name}`); } else { failed.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  return Boolean(cond);
};
const skip = (name, reason) => { skipped.push(`${name}: ${reason}`); };
const section = (title) => console.log(`\n${title}`);
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const refused = (e, status, code) => Boolean(e) && e.status === status && e.code === code;
const why = (e) => (e ? `${e.status ?? '?'} ${e.code ?? ''} ${e.message ?? ''} ${JSON.stringify(e.problems ?? '')}` : 'nothing was thrown');

const [[company]] = await pool.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
if (!company) { console.error(`No company "${slug}".`); process.exit(2); }
const COMPANY = company.id;
const TAG = `ZZLV${Date.now().toString(36).toUpperCase().slice(-5)}`;
const [[adminUser]] = await pool.query(
  `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [COMPANY]);
const c = { companyId: COMPANY, userId: adminUser?.id ?? null };
const [[other]] = await pool.query('SELECT id, name FROM companies WHERE id <> ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
const OTHER = other.id;

const hrmsTables = (await pool.query(
  "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'hrms\\_%' ORDER BY TABLE_NAME"))[0].map((r) => r.t);
const snapshot = async () => {
  const out = {};
  for (const t of hrmsTables) {
    const [[r]] = await pool.query(`SELECT COUNT(*) AS total, SUM(deleted_at IS NULL) AS live FROM ${t} WHERE company_id IN (?, ?)`, [COMPANY, OTHER]);
    out[t] = `${r.total}/${r.live ?? 0}`;
  }
  return out;
};
const baseline = await snapshot();
console.log(`leave_policy_test — ${company.name} (${COMPANY}), run tag ${TAG}; the other company is ${other.name} (${OTHER})`);

async function rolledBack(fn) {
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    await fn(db);
  } finally {
    try { await db.rollback(); } catch { /* nothing to undo */ }
    db.release();
  }
}

/* ══ 1. the sentence ══════════════════════════════════════════════════════ */
section('[1] The sentence the server writes for a rule');
{
  const SICK = { code: 'SL', name: 'Sick leave' };
  const says = (rule, expected, type = null) => {
    const got = summaryOf(rule, type);
    ok(got === expected, expected, `got: ${got}`);
  };
  // ── so many days a year, by each way of earning ──
  says({ days: 7 }, '7 days a year, all given at the start of the year. Unused days lapse at the year end.');
  says({ days: 12, accrual: 'MONTHLY' }, '12 days a year, earned a day each month. Unused days lapse at the year end.');
  says({ days: 15, accrual: 'MONTHLY' }, '15 days a year, earned 1.25 days each month. Unused days lapse at the year end.');
  says({ days: 6, accrual: 'MONTHLY' }, '6 days a year, earned half a day each month. Unused days lapse at the year end.');
  says({ days: 24, accrual: 'MONTHLY' }, '24 days a year, earned 2 days each month. Unused days lapse at the year end.');
  says({ days: 1 }, '1 day a year, all given at the start of the year. Unused days lapse at the year end.');
  says({ accrual: 'PER_DAYS_WORKED', daysWorkedPerLeaveDay: 20 }, 'One day for every 20 days worked. Unused days lapse at the year end.');
  says({ accrual: 'PER_DAYS_WORKED', daysWorkedPerLeaveDay: 20, days: 18 }, 'One day for every 20 days worked, up to 18 days a year. Unused days lapse at the year end.');
  says({ accrual: 'EARNED_BY_WORK' }, 'Earned by working on a holiday or a weekly off.');
  says({ accrual: 'EARNED_BY_WORK', expiresAfterDays: 60 }, 'Earned by working on a holiday or a weekly off. Must be used within 60 days of earning it.');
  says({ accrual: 'EARNED_BY_WORK', days: 12, expiresAfterDays: 30, encashable: true }, 'Earned by working on a holiday or a weekly off, up to 12 days a year. Must be used within 30 days of earning it. Unused days can be paid out.');
  says({ days: 5, accrual: 'ON_REQUEST' }, 'Up to 5 days a year, given when it is asked for.');
  // ── each time it happens ──
  says({ basis: 'PER_EVENT', days: 3 }, '3 days each time it is needed.');
  says({ basis: 'PER_EVENT', days: 182, appliesTo: 'WOMEN' }, '182 days each time it is needed. For women.');
  says({ basis: 'PER_EVENT', days: 5, appliesTo: 'MEN' }, '5 days each time it is needed. For men.');
  says({ basis: 'PER_EVENT', days: 5, maxTimesInService: 1 }, '5 days, once in the whole of a person’s service.');
  says({ basis: 'PER_EVENT', days: 182, maxTimesInService: 2, appliesTo: 'WOMEN' }, '182 days each time, up to twice in a person’s service. For women.');
  says({ basis: 'PER_EVENT', days: 1, maxTimesInService: 3 }, '1 day each time, up to 3 times in a person’s service.');
  // ── unpaid, no limit ──
  says({ basis: 'UNLIMITED_UNPAID' }, 'Unpaid leave with no fixed limit, given when it is asked for.');
  says({ basis: 'UNLIMITED_UNPAID', minNoticeDays: 3, maxDaysAtOnce: 30 }, 'Unpaid leave with no fixed limit, given when it is asked for. No more than 30 days at a stretch. Ask 3 days ahead.');
  // ── what happens to what is left ──
  says({ days: 15, accrual: 'MONTHLY', carryForward: 'CAPPED', carryForwardCapDays: 45 }, '15 days a year, earned 1.25 days each month. Up to 45 unused days carry forward to the next year.');
  says({ days: 15, carryForward: 'CAPPED', carryForwardCapDays: 1 }, '15 days a year, all given at the start of the year. Up to 1 unused day carries forward to the next year.');
  says({ days: 15, carryForward: 'ALL' }, '15 days a year, all given at the start of the year. All unused days carry forward to the next year.');
  says({ days: 15, carryForward: 'CAPPED', carryForwardCapDays: 30, encashable: true }, '15 days a year, all given at the start of the year. Up to 30 unused days carry forward to the next year. Unused days can be paid out.');
  says({ days: 15, carryForward: 'ALL', encashable: true, encashCapDays: 10 }, '15 days a year, all given at the start of the year. All unused days carry forward to the next year. Up to 10 unused days can be paid out.');
  says({ days: 15, encashable: true, encashCapDays: 1 }, '15 days a year, all given at the start of the year. Unused days lapse at the year end. Up to 1 unused day can be paid out.');
  // ── when it starts ──
  says({ days: 12, prorateOnJoining: true }, '12 days a year, all given at the start of the year. Someone who joins part-way through the year gets a share for the months left. Unused days lapse at the year end.');
  says({ days: 12, allowedInProbation: false }, '12 days a year, all given at the start of the year. Not during probation. Unused days lapse at the year end.');
  says({ days: 12, waitDaysAfterJoining: 90 }, '12 days a year, all given at the start of the year. Can be taken after 90 days in the job. Unused days lapse at the year end.');
  says({ days: 12, waitDaysAfterJoining: 30, allowedInProbation: false }, '12 days a year, all given at the start of the year. Not during probation, and not in the first 30 days in the job. Unused days lapse at the year end.');
  // ── the rules when taking it ──
  says({ days: 12, accrual: 'MONTHLY', proofAfterDays: 2 }, '12 days a year, earned a day each month. Unused days lapse at the year end. A medical certificate is needed beyond 2 days.', SICK);
  says({ days: 12, accrual: 'MONTHLY', proofAfterDays: 2 }, '12 days a year, earned a day each month. Unused days lapse at the year end. Proof is needed beyond 2 days.', { code: 'CL', name: 'Casual leave' });
  says({ days: 7, proofAfterDays: 0 }, '7 days a year, all given at the start of the year. Unused days lapse at the year end. A medical certificate is needed every time.', { code: 'MED', name: 'Medical leave' });
  says({ basis: 'PER_EVENT', days: 3, proofAfterDays: 1 }, '3 days each time it is needed. Proof is needed beyond 1 day.');
  says({ days: 12, halfDayAllowed: true }, '12 days a year, all given at the start of the year. Unused days lapse at the year end. Half days can be taken.');
  says({ days: 12, maxDaysAtOnce: 3, minNoticeDays: 1 }, '12 days a year, all given at the start of the year. Unused days lapse at the year end. No more than 3 days at a stretch. Ask 1 day ahead.');
  says({ days: 12, countDaysOffBetween: true }, '12 days a year, all given at the start of the year. Unused days lapse at the year end. A weekly off or holiday between two leave days counts as leave.');
  says({ days: 12, accrual: 'MONTHLY', negativeBalanceAllowed: true }, '12 days a year, earned a day each month. Unused days lapse at the year end. Can be taken before it has been earned.');
  // ── everything at once, in its order ──
  says({
    days: 18, accrual: 'MONTHLY', appliesTo: 'WOMEN', allowedInProbation: false, carryForward: 'CAPPED', carryForwardCapDays: 30, encashable: true, encashCapDays: 15,
    maxDaysAtOnce: 10, minNoticeDays: 7, halfDayAllowed: true, countDaysOffBetween: true, proofAfterDays: 3, negativeBalanceAllowed: true,
  }, '18 days a year, earned 1.5 days each month. For women. Not during probation. Up to 30 unused days carry forward to the next year. Up to 15 unused days can be paid out. '
    + 'No more than 10 days at a stretch. Ask 7 days ahead. Half days can be taken. A weekly off or holiday between two leave days counts as leave. Proof is needed beyond 3 days. Can be taken before it has been earned.');
  // ── a field that does not apply says nothing, whatever it holds ──
  says({ basis: 'PER_EVENT', days: 3, accrual: 'MONTHLY', carryForward: 'ALL', encashable: true, prorateOnJoining: true, halfDayAllowed: true, expiresAfterDays: 9, negativeBalanceAllowed: true, daysWorkedPerLeaveDay: 20 },
    '3 days each time it is needed.');
  says({ basis: 'UNLIMITED_UNPAID', days: 99, carryForward: 'CAPPED', carryForwardCapDays: 5, encashable: true, maxTimesInService: 2, prorateOnJoining: true }, 'Unpaid leave with no fixed limit, given when it is asked for.');
  says({ days: 12, accrual: 'MONTHLY', prorateOnJoining: true, maxTimesInService: 1, expiresAfterDays: 30 }, '12 days a year, earned a day each month. Unused days lapse at the year end.');
  says({ days: 5, accrual: 'ON_REQUEST', carryForward: 'ALL', encashable: true }, 'Up to 5 days a year, given when it is asked for.');
  says({ accrual: 'EARNED_BY_WORK', carryForward: 'ALL' }, 'Earned by working on a holiday or a weekly off.');
  const all = [RULE_DEFAULTS, { days: 12 }, { basis: 'PER_EVENT', days: 3 }, { basis: 'UNLIMITED_UNPAID' }, { accrual: 'PER_DAYS_WORKED' }].map((r) => summaryOf(r));
  ok(all.every((s) => s.length > 0 && !/undefined|null|NaN|[A-Z]{2,}_/.test(s) && /\.$/.test(s)), 'no summary ever prints a code, "null" or "undefined", and each ends in a full stop — also for a rule with nothing filled in', all.join(' | '));
}

/* ══ 2. a rule from a body ════════════════════════════════════════════════ */
section('[2] A rule read from a body: problems by leave type; what does not apply is cleared');
{
  const read = (input, name = 'Casual leave') => { const problems = []; return { rule: LEAVE.readRule(input, name, problems), problems }; };
  const good = read({ days: 12, accrual: 'monthly', halfDayAllowed: true });
  ok(good.problems.length === 0 && good.rule.basis === 'PER_YEAR' && good.rule.accrual === 'MONTHLY' && good.rule.days === 12 && good.rule.allowedInProbation === true && good.rule.carryForward === 'NONE',
    'a plain rule is taken, with the defaults for what was not sent');
  const cases = [
    ['no days on a yearly rule', { accrual: 'UPFRONT' }, /^Casual leave: say how many days a year\.$/],
    ['no days on an each-time rule', { basis: 'PER_EVENT' }, /^Casual leave: say how many days it is each time\.$/],
    ['days worked missing', { accrual: 'PER_DAYS_WORKED' }, /^Casual leave: say how many days worked earn one day of leave\.$/],
    ['a basis nobody knows', { basis: 'WEEKLY', days: 3 }, /^Casual leave: choose whether it is so many days a year/],
    ['a way of earning nobody knows', { days: 3, accrual: 'DAILY' }, /^Casual leave: choose how it is earned\.$/],
    ['carry forward capped with no cap', { days: 12, carryForward: 'CAPPED' }, /^Casual leave: say how many unused days carry forward, or choose that they lapse\.$/],
    ['days that are not a number', { days: 'twelve' }, /^Casual leave: the number of days must be a number above 0\.$/],
    ['zero days', { days: 0 }, /^Casual leave: the number of days must be a number above 0\.$/],
    ['a stretch longer than the year gives', { days: 7, maxDaysAtOnce: 10 }, /^Casual leave: the longest stretch \(10 days\) is more than the 7 days it gives in a year\.$/],
    ['proof asked for beyond all of it', { days: 7, proofAfterDays: 7 }, /^Casual leave: proof is asked for beyond 7 days, which is all 7 days of it/],
    ['who it is for', { days: 7, appliesTo: 'CHILDREN' }, /^Casual leave: choose who it is for: anyone, women or men\.$/],
    ['notice that is not a whole number', { days: 7, minNoticeDays: 1.5 }, /^Casual leave: the notice must be a whole number from 0 to 365\.$/],
  ];
  for (const [label, input, pattern] of cases) {
    const { problems } = read(input);
    ok(problems.length === 1 && pattern.test(problems[0]), `${label}: one problem, naming the leave type`, JSON.stringify(problems));
  }
  const several = read({ basis: 'PER_YEAR', days: -1, accrual: 'x', carryForward: 'y', appliesTo: 'z', minNoticeDays: 'soon' }, 'Earned leave');
  ok(several.problems.length === 5 && several.problems.every((p) => p.startsWith('Earned leave: ')), 'five things wrong in one rule: five problems, each starting with its leave type', JSON.stringify(several.problems));
  const event = read({ basis: 'PER_EVENT', days: 3, accrual: 'MONTHLY', carryForward: 'CAPPED', carryForwardCapDays: 9, encashable: true, encashCapDays: 4, prorateOnJoining: true, halfDayAllowed: true, expiresAfterDays: 10, negativeBalanceAllowed: true, daysWorkedPerLeaveDay: 20, maxTimesInService: 2 }, 'Bereavement leave');
  ok(event.problems.length === 0 && event.rule.accrual === 'ON_REQUEST' && event.rule.carryForward === 'NONE' && event.rule.carryForwardCapDays === null && event.rule.encashable === false && event.rule.encashCapDays === null
    && event.rule.prorateOnJoining === false && event.rule.halfDayAllowed === false && event.rule.expiresAfterDays === null && event.rule.negativeBalanceAllowed === false && event.rule.daysWorkedPerLeaveDay === null
    && event.rule.maxTimesInService === 2 && event.rule.days === 3, 'an each-time rule sent with leftovers of a yearly one: accepted, and everything that does not apply is cleared');
  const unpaid = read({ basis: 'UNLIMITED_UNPAID', days: 30, accrual: 'UPFRONT', maxTimesInService: 3, carryForward: 'ALL', minNoticeDays: 2 }, 'Leave without pay');
  ok(unpaid.problems.length === 0 && unpaid.rule.days === null && unpaid.rule.accrual === 'ON_REQUEST' && unpaid.rule.maxTimesInService === null && unpaid.rule.carryForward === 'NONE' && unpaid.rule.minNoticeDays === 2,
    'unpaid without a limit: days, earning, carry forward and "times in service" are cleared; the notice stays');
  const yearly = read({ days: 12, accrual: 'MONTHLY', carryForward: 'NONE', carryForwardCapDays: 20, encashable: false, encashCapDays: 5, maxTimesInService: 1, expiresAfterDays: 30, prorateOnJoining: true });
  ok(yearly.rule.carryForwardCapDays === null && yearly.rule.encashCapDays === null && yearly.rule.maxTimesInService === null && yearly.rule.expiresAfterDays === null && yearly.rule.prorateOnJoining === false,
    'a cap with nothing to cap, a pay-out limit with no pay-out, pro-rating on leave earned monthly: cleared');
}

/* ══ 3. the starting points ═══════════════════════════════════════════════ */
section('[3] Starting points: their shape, their caution, the leave types they create');
{
  const t = LEAVE.listTemplates();
  ok(t.note === TEMPLATE_NOTE && /starting points/i.test(t.note) && /not legal advice/.test(t.note) && /state/.test(t.note), 'GET /leave/policy-templates carries the caution: starting points, check your state’s rules, not legal advice', t.note);
  ok(JSON.stringify(t.templates.map((x) => x.key)) === JSON.stringify(['SHOP_FLOOR', 'OFFICE_STAFF', 'MANAGEMENT', 'TRAINEE', 'BLANK']) && t.templates.every((x) => x.name && x.description && Array.isArray(x.rules)),
    'five of them: Shop floor, Office staff, Management, Trainee / probationer, Blank');
  const by = Object.fromEntries(t.templates.map((x) => [x.key, x]));
  const codes = (k) => by[k].rules.map((r) => r.leaveTypeCode).join(' ');
  ok(codes('SHOP_FLOOR') === 'EL CL SL CO BL LWP' && codes('OFFICE_STAFF') === 'CL SL EL ML PL BL MRL LWP' && codes('MANAGEMENT') === codes('OFFICE_STAFF') && codes('TRAINEE') === 'CL SL LWP' && by.BLANK.rules.length === 0,
    'each grants the leave types the spec lists; Blank grants none');
  const rule = (k, code) => by[k].rules.find((r) => r.leaveTypeCode === code);
  ok(rule('SHOP_FLOOR', 'EL').summary === 'One day for every 20 days worked. Up to 30 unused days carry forward to the next year. Unused days can be paid out.'
    && rule('SHOP_FLOOR', 'SL').summary === '7 days a year, all given at the start of the year. Unused days lapse at the year end. A medical certificate is needed beyond 2 days.'
    && rule('SHOP_FLOOR', 'CO').summary === 'Earned by working on a holiday or a weekly off. Must be used within 60 days of earning it.'
    && rule('OFFICE_STAFF', 'EL').summary === '15 days a year, earned 1.25 days each month. Not during probation. Up to 45 unused days carry forward to the next year. Unused days can be paid out.'
    && rule('MANAGEMENT', 'EL').summary === '21 days a year, earned 1.75 days each month. Not during probation. Up to 60 unused days carry forward to the next year. Unused days can be paid out.'
    && rule('OFFICE_STAFF', 'ML').summary === '182 days each time it is needed. For women.' && rule('OFFICE_STAFF', 'MRL').summary === '5 days, once in the whole of a person’s service.'
    && rule('TRAINEE', 'CL').summary === '6 days a year, earned half a day each month. Unused days lapse at the year end.' && rule('OFFICE_STAFF', 'LWP').summary === 'Unpaid leave with no fixed limit, given when it is asked for.',
  'their rules read as the spec describes them, each with its sentence');
  ok(t.templates.flatMap((x) => x.rules).every((r) => r.leaveTypeName && typeof r.isPaid === 'boolean' && r.summary.length > 0 && r.sortOrder > 0 && 'basis' in r && 'carryForward' in r)
    && TEMPLATES.flatMap((x) => x.rules).every((r) => LEAVE_TYPES_OFFERED.some((o) => o.code === r.type)) && LEAVE_TYPES_OFFERED.length === 9, 'every template rule is a whole Rule, and names one of the nine leave types offered');
}

await rolledBack(async (db) => {
  const typesBefore = (await LEAVE.listLeaveTypes(db, COMPANY)).types;
  const had = new Set(typesBefore.map((x) => x.code.toUpperCase()));
  const made = (await LEAVE.createPolicy(db, c, { name: `${TAG} Shop floor`, fromTemplate: 'SHOP_FLOOR' })).policy;
  const typesAfter = (await LEAVE.listLeaveTypes(db, COMPANY)).types;
  const needed = ['EL', 'CL', 'SL', 'CO', 'BL', 'LWP'];
  ok(typesAfter.length === typesBefore.length + needed.filter((k) => !had.has(k)).length && needed.every((k) => typesAfter.some((x) => x.code === k))
    && typesAfter.find((x) => x.code === 'LWP').isPaid === false && typesAfter.find((x) => x.code === 'CL').name === (typesBefore.find((x) => x.code === 'CL')?.name ?? 'Casual leave'),
  'a policy from "Shop floor" creates the leave types the company did not have — and only those');
  ok(made.status === 'DRAFT' && made.rules.length === 6 && made.headline === 'Earned · Casual 7 · Sick 7 · Compensatory off · Bereavement · Leave without pay' && made.yearStartsMonth === 1 && made.code === null
    && JSON.stringify(made.leaveTypes[1]) === JSON.stringify({ code: 'CL', name: typesAfter.find((x) => x.code === 'CL').name, days: 7, basis: 'PER_YEAR' })
    && JSON.stringify(made.usedBy) === JSON.stringify({ company: false, locations: 0, roles: 0, positions: 0 }) && made.rules.every((r) => r.id > 0 && r.leaveTypeId > 0 && r.summary),
  'it starts as a DRAFT with the template’s six rules, a headline, and nobody using it', made.headline);
  const office = (await LEAVE.createPolicy(db, c, { name: `${TAG} Office`, fromTemplate: 'office_staff', yearStartsMonth: 4, status: 'ACTIVE', code: `${TAG}OF` })).policy;
  const typesThen = (await LEAVE.listLeaveTypes(db, COMPANY)).types;
  ok(office.headline === 'Casual 12 · Sick 12 · Earned 15 · Maternity · Paternity · Bereavement · Marriage · Leave without pay' && office.yearStartsMonth === 4 && office.status === 'ACTIVE' && office.code === `${TAG}OF`
    && typesThen.filter((x) => ['CL', 'SL', 'EL', 'BL', 'LWP'].includes(x.code)).length === 5 && typesThen.length === typesAfter.length + ['ML', 'PL', 'MRL'].filter((k) => !had.has(k)).length,
  'a second policy reuses the leave types that now exist and adds only the new ones; the leave year and status sent are kept', office.headline);
  const blank = (await LEAVE.createPolicy(db, c, { name: `${TAG} Blank`, fromTemplate: 'BLANK' })).policy;
  ok(blank.rules.length === 0 && blank.headline === '' && blank.description === null, 'Blank has no rules');
  ok(refused(await caught(() => LEAVE.createPolicy(db, c, { name: `${TAG} X`, fromTemplate: 'UNION_AGREEMENT' })), 422, 'INVALID')
    && refused(await caught(() => LEAVE.createPolicy(db, c, { name: `${TAG} X`, fromTemplate: 'BLANK', copyOf: made.id })), 422, 'INVALID')
    && refused(await caught(() => LEAVE.createPolicy(db, c, { fromTemplate: 'BLANK' })), 422, 'INVALID')
    && refused(await caught(() => LEAVE.createPolicy(db, c, { name: `${TAG} shop FLOOR` })), 409, 'DUPLICATE')
    && refused(await caught(() => LEAVE.createPolicy(db, c, { name: `${TAG} Y`, code: `${TAG}of` })), 409, 'DUPLICATE'),
  'a starting point that does not exist, a template AND a copy, no name: 422; a name or code already used: 409');

  /* ══ 4. copy, edit, replace the rule set ═══════════════════════════════ */
  section('[4] Policies: copy, edit, and the rule set replaced whole or not at all');
  const copy = (await LEAVE.createPolicy(db, c, { name: `${TAG} Office (copy)`, copyOf: office.id })).policy;
  const strip = (rules) => rules.map(({ id, ...rest }) => rest);
  ok(copy.id !== office.id && copy.status === 'DRAFT' && copy.yearStartsMonth === 4 && JSON.stringify(strip(copy.rules)) === JSON.stringify(strip(office.rules)) && copy.rules.every((r, i) => r.id !== office.rules[i].id),
    'copyOf makes a new DRAFT with the same rules (its own rows) and the same leave year');
  ok(refused(await caught(() => LEAVE.createPolicy(db, c, { name: `${TAG} Z`, copyOf: 999999999 })), 404, 'NOT_FOUND'), 'copying a policy that does not exist: 404');

  const typeId = (code) => typesThen.find((x) => x.code === code).id;
  const before = (await LEAVE.getPolicy(db, COMPANY, copy.id)).policy;
  const badSet = await caught(() => LEAVE.updatePolicy(db, c, copy.id, {
    name: `${TAG} Renamed and broken`,
    rules: [{ leaveTypeId: typeId('CL'), days: 10 }, { leaveTypeId: typeId('SL') }, { leaveTypeId: typeId('CL'), days: 3 }, { leaveTypeId: 999999999, days: 2 }, { leaveTypeId: typeId('EL'), accrual: 'PER_DAYS_WORKED' }],
  }));
  ok(refused(badSet, 422, 'INVALID') && badSet.problems.length === 4
    && badSet.problems.some((p) => /^Sick leave: say how many days a year\.$/.test(p)) && badSet.problems.some((p) => /^Casual leave is in the policy twice/.test(p))
    && badSet.problems.some((p) => /^Leave type 4 of the list is not one of this company/.test(p)) && badSet.problems.some((p) => /^Earned leave: say how many days worked/.test(p)),
  'a rule set with four things wrong: 422 INVALID with four problems — which leave type, what is wrong', why(badSet));
  const untouched = (await LEAVE.getPolicy(db, COMPANY, copy.id)).policy;
  ok(JSON.stringify(untouched) === JSON.stringify(before), 'and NOTHING of that save was kept: not the name, not one rule');

  const saved = (await LEAVE.updatePolicy(db, c, copy.id, {
    name: `${TAG} Two types`, description: 'Cut down.', yearStartsMonth: 1,
    rules: [{ leaveTypeId: typeId('SL'), days: 10, accrual: 'MONTHLY', proofAfterDays: 3, sortOrder: 2 }, { leaveTypeId: typeId('CL'), days: 8, halfDayAllowed: true, sortOrder: 1 }],
  })).policy;
  ok(saved.name === `${TAG} Two types` && saved.description === 'Cut down.' && saved.yearStartsMonth === 1 && saved.rules.length === 2 && saved.rules.map((r) => r.leaveTypeCode).join(' ') === 'CL SL'
    && saved.headline === 'Casual 8 · Sick 10' && saved.rules[1].summary === '10 days a year, earned 0.83 days each month. Unused days lapse at the year end. A medical certificate is needed beyond 3 days.',
  'a good save REPLACES the set: eight rules become two, in their order, each with its sentence', `${saved.headline} / ${saved.rules[1]?.summary}`);
  ok(Number((await db.query('SELECT COUNT(*) AS n FROM hrms_leave_policy_rules WHERE policy_id = ?', [copy.id]))[0][0].n) === 2, 'two rule rows are left in the database');
  const metaOnly = (await LEAVE.updatePolicy(db, c, copy.id, { description: '' })).policy;
  ok(metaOnly.description === null && metaOnly.rules.length === 2 && metaOnly.name === `${TAG} Two types`, 'a save without `rules` leaves the rules alone');
  const cleared = (await LEAVE.updatePolicy(db, c, copy.id, { rules: [] })).policy;
  ok(cleared.rules.length === 0 && cleared.headline === '', '`rules: []` empties the policy');
  ok(refused(await caught(() => LEAVE.updatePolicy(db, c, copy.id, { rules: 'CL' })), 422, 'INVALID') && refused(await caught(() => LEAVE.updatePolicy(db, c, copy.id, { yearStartsMonth: 13, status: 'LIVE', name: '' })), 422, 'INVALID')
    && refused(await caught(() => LEAVE.updatePolicy(db, c, copy.id, { name: `${TAG} Office` })), 409, 'DUPLICATE') && refused(await caught(() => LEAVE.updatePolicy(db, c, 999999999, { name: 'x' })), 404, 'NOT_FOUND'),
  'rules that are not a list, a month 13, a status nobody knows: 422; another policy’s name: 409; no such policy: 404');
  const preview = await LEAVE.previewRuleSummary(db, COMPANY, { rule: { leaveTypeId: typeId('SL'), days: 12, accrual: 'MONTHLY', proofAfterDays: 2 } });
  const previewBad = await LEAVE.previewRuleSummary(db, COMPANY, { rule: { leaveTypeId: typeId('EL'), accrual: 'PER_DAYS_WORKED' } });
  ok(preview.summary === '12 days a year, earned a day each month. Unused days lapse at the year end. A medical certificate is needed beyond 2 days.' && preview.problems.length === 0
    && previewBad.problems.length === 1 && /^Earned leave: /.test(previewBad.problems[0]) && typeof previewBad.summary === 'string' && previewBad.summary.length > 0,
  'POST /leave/policies/preview-summary: the sentence as it is typed, and the problems — an unfinished rule still gets a sentence', `${preview.summary} / ${previewBad.summary}`);

  /* ══ 5. where a policy applies ═════════════════════════════════════════ */
  section('[5] Where it applies: role beats location beats company');
  const location = await ORG.createLocation(db, c, { code: `${TAG}L`, name: `${TAG} Unit`, locationType: 'UNIT' });
  const roleA = (await db.query("INSERT INTO hrms_roles (company_id, role_code, title, status, created_by) VALUES (?, ?, ?, 'ACTIVE', ?)", [COMPANY, `${TAG}RA`, `${TAG} Role A`, c.userId]))[0].insertId;
  const roleB = (await db.query("INSERT INTO hrms_roles (company_id, role_code, title, status, created_by) VALUES (?, ?, ?, 'ACTIVE', ?)", [COMPANY, `${TAG}RB`, `${TAG} Role B`, c.userId]))[0].insertId;
  const p1 = (await POS.createPosition(db, c, { roleId: roleA, locationId: location.id, positionCode: `${TAG}-1`, status: 'ACTIVE' })).position;   // role A at the unit
  const p2 = (await POS.createPosition(db, c, { roleId: roleB, locationId: location.id, positionCode: `${TAG}-2`, status: 'ACTIVE' })).position;   // role B at the unit
  const p3 = (await POS.createPosition(db, c, { roleId: roleB, positionCode: `${TAG}-3`, status: 'ACTIVE' })).position;                             // role B, nowhere
  const [[live]] = await db.query("SELECT COUNT(*) AS n FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL AND status <> 'CLOSED'", [COMPANY]);
  const total = Number(live.n);
  const eff = async (p) => (await LEAVE.policyFor(db, COMPANY, { positionId: p.id })).effective;
  const none = { policy: null, from: null, line: 'No leave policy' };
  const start = await LEAVE.getAssignments(db, COMPANY);
  const already = { company: start.company.policy, unassigned: start.unassignedPositions };

  const mk = async (name) => (await LEAVE.createPolicy(db, c, { name: `${TAG} ${name}`, fromTemplate: 'TRAINEE', status: 'ACTIVE' })).policy;
  const forCompany = await mk('For the company');
  const forLocation = await mk('For the unit');
  const forRole = await mk('For role A');
  const ref = (p) => ({ id: p.id, name: p.name, status: 'ACTIVE' });

  if (already.company) skip('"No leave policy" before anything is assigned', 'this company already has a default policy');
  else ok(JSON.stringify(await eff(p1)) === JSON.stringify(none) && JSON.stringify(await eff(p3)) === JSON.stringify(none), 'with nothing assigned a position has "No leave policy"');

  const put = (body) => LEAVE.putAssignment(db, c, body);
  const afterCompany = (await put({ scope: 'COMPANY', policyId: forCompany.id })).assignments;
  const line1 = { policy: ref(forCompany), from: 'COMPANY', line: `${forCompany.name} — the company default` };
  ok(JSON.stringify(afterCompany.company.policy) === JSON.stringify(ref(forCompany)) && afterCompany.unassignedPositions === 0
    && [await eff(p1), await eff(p2), await eff(p3)].every((e) => JSON.stringify(e) === JSON.stringify(line1)),
  'the company default reaches every position: "<policy> — the company default"; nobody is left without');

  const afterLocation = (await put({ scope: 'LOCATION', locationId: location.id, policyId: forLocation.id })).assignments;
  const line2 = { policy: ref(forLocation), from: 'LOCATION', line: `${forLocation.name} — from ${TAG} Unit` };
  ok(JSON.stringify(await eff(p1)) === JSON.stringify(line2) && JSON.stringify(await eff(p2)) === JSON.stringify(line2) && JSON.stringify(await eff(p3)) === JSON.stringify(line1),
    'a LOCATION’s policy beats the company’s for positions there: "<policy> — from <location>"; a position elsewhere keeps the default');
  const locRow = afterLocation.locations.find((l) => l.locationId === location.id);
  ok(JSON.stringify(locRow) === JSON.stringify({ locationId: location.id, name: `${TAG} Unit`, policy: ref(forLocation), effective: line2 })
    && afterLocation.locations.filter((l) => l.locationId !== location.id).every((l) => l.policy === null && l.effective.from === 'COMPANY'),
  'GET /leave/assignments: the location with its own policy and its effective line; every other location follows the company', JSON.stringify(locRow));

  const afterRole = (await put({ scope: 'ROLE', roleId: roleA, policyId: forRole.id })).assignments;
  const line3 = { policy: ref(forRole), from: 'ROLE', line: `${forRole.name} — from the role` };
  ok(JSON.stringify(await eff(p1)) === JSON.stringify(line3) && JSON.stringify(await eff(p2)) === JSON.stringify(line2) && JSON.stringify(await eff(p3)) === JSON.stringify(line1),
    'a ROLE’s policy beats the location’s: "<policy> — from the role"; the other role at the same location still gets the location’s');
  ok(JSON.stringify(afterRole.roles.filter((r) => [roleA, roleB].includes(r.roleId))) === JSON.stringify([{ roleId: roleA, title: `${TAG} Role A`, positionCount: 1, policy: ref(forRole) }]),
    'the roles list holds only roles WITH a policy of their own, each with its position count', JSON.stringify(afterRole.roles.slice(0, 2)));
  ok(JSON.stringify(Object.keys(afterRole)) === JSON.stringify(['company', 'locations', 'roles', 'unassignedPositions']), 'the answer is { company, locations, roles, unassignedPositions }');
  ok(JSON.stringify((await LEAVE.policyFor(db, COMPANY, { roleId: roleA, locationId: location.id })).effective) === JSON.stringify(line3)
    && JSON.stringify((await LEAVE.policyFor(db, COMPANY, { roleId: roleB, locationId: location.id })).effective) === JSON.stringify(line2)
    && JSON.stringify((await LEAVE.policyFor(db, COMPANY, { roleId: roleB })).effective) === JSON.stringify(line1)
    && JSON.stringify((await LEAVE.policyFor(db, COMPANY, { locationId: location.id })).effective) === JSON.stringify(line2),
  'GET /leave/policy-for?roleId=&locationId= answers the same as by position');
  ok(refused(await caught(() => LEAVE.policyFor(db, COMPANY, {})), 422, 'INVALID') && refused(await caught(() => LEAVE.policyFor(db, COMPANY, { positionId: 999999999 })), 404, 'NOT_FOUND')
    && refused(await caught(() => LEAVE.policyFor(db, COMPANY, { positionId: 'x' })), 422, 'INVALID'), 'asked about nothing: 422; about a position that does not exist: 404');
  // The one function, on an index built by hand: the order is role, location, company, none.
  const index = { company: { id: 1, name: 'C', status: 'ACTIVE' }, byLocation: new Map([[5, { id: 2, name: 'L', status: 'ACTIVE' }]]), byRole: new Map([[9, { id: 3, name: 'R', status: 'ACTIVE' }]]), locationName: new Map([[5, 'Unit 2']]) };
  ok(resolveEffective(index, { roleId: 9, locationId: 5 }).line === 'R — from the role' && resolveEffective(index, { roleId: 8, locationId: 5 }).line === 'L — from Unit 2'
    && resolveEffective(index, { roleId: 8, locationId: 6 }).line === 'C — the company default' && resolveEffective({ ...index, company: null }, {}).line === 'No leave policy',
  'resolveEffective on its own: "R — from the role", "L — from Unit 2", "C — the company default", "No leave policy"');

  // ── usedBy ──
  const listed = (await LEAVE.listPolicies(db, COMPANY)).policies;
  const used = (p) => listed.find((x) => x.id === p.id).usedBy;
  ok(JSON.stringify(used(forRole)) === JSON.stringify({ company: false, locations: 0, roles: 1, positions: 1 })
    && JSON.stringify(used(forLocation)) === JSON.stringify({ company: false, locations: 1, roles: 0, positions: 1 })
    && used(forCompany).company === true && used(forCompany).locations === 0 && used(forCompany).roles === 0
    && listed.reduce((t, x) => t + x.usedBy.positions, 0) === total,
  `usedBy: the role’s policy 1 role / 1 position, the location’s 1 location / 1 position, the default the rest — and the positions of all policies add up to the company’s ${total}`,
  JSON.stringify([used(forRole), used(forLocation), used(forCompany)]));
  ok(JSON.stringify((await LEAVE.getPolicy(db, COMPANY, forRole.id)).policy.usedBy) === JSON.stringify(used(forRole)) && listed.every((x) => !('rules' in x) && typeof x.headline === 'string'),
    'GET /leave/policies/:id says the same; the list carries summaries, not rules');

  // ── the reads that carry it ──
  ok(JSON.stringify((await POS.getPosition(db, COMPANY, p1.id)).position.leavePolicy) === JSON.stringify(line3) && JSON.stringify((await POS.getPosition(db, COMPANY, p3.id)).position.leavePolicy) === JSON.stringify(line1),
    'GET /positions/:id carries leavePolicy: Effective');
  ok(JSON.stringify((await getPositionCard(db, COMPANY, p2.id, {})).leavePolicy) === JSON.stringify(line2), 'the position card carries it');
  ok(JSON.stringify((await getRole(db, COMPANY, roleA)).leavePolicy) === JSON.stringify({ own: ref(forRole) }) && JSON.stringify((await getRole(db, COMPANY, roleB)).leavePolicy) === JSON.stringify({ own: null }),
    'the role detail carries leavePolicy: { own } — the role’s own policy, or null when it follows the location');
  const [[person]] = await db.query(
    `SELECT e.user_id, wa.id AS assignment_id FROM hrms_employees e JOIN hrms_work_assignments wa ON wa.employee_id = e.id AND wa.deleted_at IS NULL AND wa.status = 'ACTIVE' AND wa.is_primary = 1
      WHERE e.company_id = ? AND e.deleted_at IS NULL AND e.user_id IS NOT NULL ORDER BY e.id LIMIT 1`, [COMPANY]);
  if (person) {
    const mine = await myPlace(db, { companyId: COMPANY, userId: person.user_id }, {});
    ok(mine.leavePolicy.policy !== null && typeof mine.leavePolicy.line === 'string' && Array.isArray(mine.leavePolicy.rules) && mine.leavePolicy.rules.length === 3
      && mine.leavePolicy.rules.every((r) => r.summary && r.leaveTypeName) && ['ROLE', 'LOCATION', 'COMPANY'].includes(mine.leavePolicy.from),
    '/user/me/place carries the person’s own leave policy WITH its rules and their sentences', JSON.stringify({ line: mine.leavePolicy.line, rules: mine.leavePolicy.rules?.length }));
    await db.query('UPDATE hrms_work_assignments SET role_id = ?, position_id = ? WHERE id = ?', [roleA, p1.id, person.assignment_id]);
    const moved = await myPlace(db, { companyId: COMPANY, userId: person.user_id }, {});
    ok(JSON.stringify({ policy: moved.leavePolicy.policy, from: moved.leavePolicy.from, line: moved.leavePolicy.line }) === JSON.stringify(line3), 'and it follows their position: put in role A’s position, it is role A’s policy');
  } else skip('/user/me/place', 'no employee with a login and a primary assignment');

  // ── falling back ──
  await put({ scope: 'ROLE', roleId: roleA, policyId: null });
  ok(JSON.stringify(await eff(p1)) === JSON.stringify(line2) && (await LEAVE.getAssignments(db, COMPANY)).roles.every((r) => r.roleId !== roleA), 'remove the role’s assignment: its position falls back to the location’s');
  await put({ scope: 'LOCATION', locationId: location.id, policyId: null });
  ok(JSON.stringify(await eff(p1)) === JSON.stringify(line1) && JSON.stringify(await eff(p2)) === JSON.stringify(line1), 'remove the location’s: back to the company default');
  const afterNone = (await put({ scope: 'COMPANY', policyId: null })).assignments;
  if (!already.company) ok(JSON.stringify(await eff(p1)) === JSON.stringify(none) && afterNone.company.policy === null && afterNone.unassignedPositions === total, `remove the default: "No leave policy", and all ${total} positions are counted as having none`);
  ok(JSON.stringify((await put({ scope: 'COMPANY', policyId: null })).assignments.company) === JSON.stringify(afterNone.company), 'removing what is not there is not an error');
  // The same target again replaces, it does not add.
  await put({ scope: 'ROLE', roleId: roleA, policyId: forRole.id });
  await put({ scope: 'ROLE', roleId: roleA, policyId: forLocation.id });
  ok(Number((await db.query("SELECT COUNT(*) AS n FROM hrms_leave_policy_assignments WHERE company_id = ? AND role_id = ? AND deleted_at IS NULL", [COMPANY, roleA]))[0][0].n) === 1
    && (await eff(p1)).policy.id === forLocation.id, 'assigning a role again REPLACES its policy: one live row');
  const dbDup = await caught(() => db.query("INSERT INTO hrms_leave_policy_assignments (company_id, scope, role_id, policy_id) VALUES (?, 'ROLE', ?, ?)", [COMPANY, roleA, forRole.id]));
  ok(dbDup?.errno === 1062, 'and the database refuses a second live assignment for one target (uq_hlpa_target)', dbDup?.code ?? 'accepted');

  // ── what can and cannot be assigned ──
  const draft = (await LEAVE.createPolicy(db, c, { name: `${TAG} Draft`, fromTemplate: 'BLANK' })).policy;
  const archived = (await LEAVE.createPolicy(db, c, { name: `${TAG} Archived`, fromTemplate: 'BLANK', status: 'ARCHIVED' })).policy;
  const asDraft = await caught(() => put({ scope: 'COMPANY', policyId: draft.id }));
  const asArchived = await caught(() => put({ scope: 'ROLE', roleId: roleB, policyId: archived.id }));
  ok(refused(asDraft, 422, 'INVALID') && /still a draft/.test(asDraft.message) && refused(asArchived, 422, 'INVALID') && /archived/.test(asArchived.message), 'only an ACTIVE policy can be applied: a draft or an archived one is 422, saying which', `${why(asDraft)} | ${why(asArchived)}`);
  for (const [label, body, status, code] of [
    ['no scope', { policyId: forRole.id }, 422, 'INVALID'], ['a location scope with no location', { scope: 'LOCATION', policyId: forRole.id }, 422, 'INVALID'],
    ['a role that does not exist', { scope: 'ROLE', roleId: 999999999, policyId: forRole.id }, 404, 'NOT_FOUND'], ['a policy that does not exist', { scope: 'COMPANY', policyId: 999999999 }, 404, 'NOT_FOUND'],
    ['no policyId at all', { scope: 'COMPANY' }, 422, 'INVALID'],
  ]) ok(refused(await caught(() => put(body)), status, code), `${label}: ${status}`);

  await put({ scope: 'COMPANY', policyId: forCompany.id });
  await put({ scope: 'LOCATION', locationId: location.id, policyId: forCompany.id });
  for (const [label, fn] of [
    ['archive it', () => LEAVE.updatePolicy(db, c, forCompany.id, { status: 'ARCHIVED' })],
    ['put it back to draft', () => LEAVE.updatePolicy(db, c, forCompany.id, { status: 'DRAFT' })],
    ['delete it', () => LEAVE.deletePolicy(db, c, forCompany.id)],
  ]) {
    const e = await caught(fn);
    ok(refused(e, 409, 'IN_USE') && e.problems.length === 2 && e.problems[0] === 'It is the company default.' && e.problems[1] === `The location ${TAG} Unit uses it.`, `an assigned policy — ${label}: 409 IN_USE, saying where it is used`, why(e));
  }
  ok((await LEAVE.updatePolicy(db, c, forCompany.id, { name: `${TAG} Still editable`, rules: [] })).policy.status === 'ACTIVE', 'its name and rules can still be changed while it is in use');
  await put({ scope: 'COMPANY', policyId: null });
  await put({ scope: 'LOCATION', locationId: location.id, policyId: null });
  ok((await LEAVE.updatePolicy(db, c, forCompany.id, { status: 'ARCHIVED' })).policy.status === 'ARCHIVED' && (await LEAVE.deletePolicy(db, c, forCompany.id)).ok === true
    && refused(await caught(() => LEAVE.getPolicy(db, COMPANY, forCompany.id)), 404, 'NOT_FOUND') && (await LEAVE.createPolicy(db, c, { name: `${TAG} Still editable` })).policy.id !== forCompany.id,
  'once it applies nowhere it can be archived and deleted, and its name is free again');

  /* ══ 6. leave types ════════════════════════════════════════════════════ */
  section('[6] Leave types');
  const made2 = (await LEAVE.createLeaveType(db, c, { code: `${TAG}T`, name: `${TAG} Study leave`, isPaid: false })).type;
  ok(JSON.stringify(Object.keys(made2)) === JSON.stringify(['id', 'code', 'name', 'unit', 'isPaid', 'status', 'policyCount']) && made2.unit === 'DAY' && made2.isPaid === false && made2.status === 'ACTIVE' && made2.policyCount === 0,
    'POST /leave/types -> { type: { id, code, name, unit, isPaid, status, policyCount } }');
  ok(refused(await caught(() => LEAVE.createLeaveType(db, c, { code: `${TAG}t`, name: 'x' })), 409, 'DUPLICATE') && refused(await caught(() => LEAVE.createLeaveType(db, c, { code: 'has space', name: '' })), 422, 'INVALID')
    && refused(await caught(() => LEAVE.updateLeaveType(db, c, made2.id, { unit: 'WEEK' })), 422, 'INVALID'), 'a code already used: 409; a bad code, no name, a unit nobody knows: 422');
  const edited = (await LEAVE.updateLeaveType(db, c, made2.id, { name: `${TAG} Study`, isPaid: true, status: 'INACTIVE' })).type;
  ok(edited.name === `${TAG} Study` && edited.isPaid === true && edited.status === 'INACTIVE' && edited.code === `${TAG}T`, 'PUT /leave/types/:id changes what was sent');
  const holder = (await LEAVE.createPolicy(db, c, { name: `${TAG} Holder` })).policy;
  const withType = (await LEAVE.updatePolicy(db, c, holder.id, { rules: [{ leaveTypeId: made2.id, basis: 'PER_EVENT', days: 10 }] })).policy;
  ok(withType.rules[0].leaveTypeName === `${TAG} Study` && withType.rules[0].isPaid === true && withType.headline === `${TAG} Study` && (await LEAVE.listLeaveTypes(db, COMPANY)).types.find((x) => x.id === made2.id).policyCount === 1,
    'a company’s own leave type goes into a policy; the type says one policy grants it');
  const inUse = await caught(() => LEAVE.deleteLeaveType(db, c, made2.id));
  ok(refused(inUse, 409, 'IN_USE') && inUse.problems.length === 1 && inUse.problems[0] === `The policy ${TAG} Holder grants ${TAG} Study.` && inUse.detail.policyIds[0] === holder.id, 'deleting a leave type a policy grants: 409 IN_USE, naming the policy', why(inUse));
  await LEAVE.deletePolicy(db, c, holder.id);
  ok((await LEAVE.deleteLeaveType(db, c, made2.id)).ok === true && (await LEAVE.listLeaveTypes(db, COMPANY)).types.every((x) => x.id !== made2.id) && refused(await caught(() => LEAVE.deleteLeaveType(db, c, made2.id)), 404, 'NOT_FOUND'),
    'with the policy gone the leave type is deleted; twice is 404');
  const [[entitlement]] = await db.query("SELECT COUNT(*) AS n FROM hrms_leave_types WHERE company_id = ? AND annual_entitlement IS NOT NULL AND code IN ('CL','SL','EL','ML','PL','CO','BL','MRL','LWP') AND created_by = ?", [COMPANY, c.userId]);
  ok(Number(entitlement.n) === 0 && !('annualEntitlement' in made2), 'nothing here writes or returns annual_entitlement: the quantity lives in the policy');

  /* ══ 7. another company ════════════════════════════════════════════════ */
  section('[7] Another company cannot reach a policy, a leave type or an assignment');
  const there = { ...c, companyId: OTHER };
  const anyType = (await LEAVE.listLeaveTypes(db, COMPANY)).types[0];
  for (const [name, fn] of [
    ['read a policy', () => LEAVE.getPolicy(db, OTHER, forRole.id)], ['edit a policy', () => LEAVE.updatePolicy(db, there, forRole.id, { name: 'x' })],
    ['delete a policy', () => LEAVE.deletePolicy(db, there, forRole.id)], ['copy a policy', () => LEAVE.createPolicy(db, there, { name: `${TAG} stolen`, copyOf: forRole.id })],
    ['apply this company’s policy as their default', () => LEAVE.putAssignment(db, there, { scope: 'COMPANY', policyId: forRole.id })],
    ['apply a policy to this company’s role', () => LEAVE.putAssignment(db, there, { scope: 'ROLE', roleId: roleA, policyId: null })],
    ['ask about this company’s position', () => LEAVE.policyFor(db, OTHER, { positionId: p1.id })],
    ['edit a leave type', () => LEAVE.updateLeaveType(db, there, anyType.id, { name: 'x' })], ['delete a leave type', () => LEAVE.deleteLeaveType(db, there, anyType.id)],
  ]) ok(refused(await caught(fn), 404, 'NOT_FOUND'), `${name}: 404`);
  const theirRule = await caught(async () => {
    const theirs = (await LEAVE.createPolicy(db, there, { name: `${TAG} Theirs` })).policy;
    await LEAVE.updatePolicy(db, there, theirs.id, { rules: [{ leaveTypeId: anyType.id, days: 5 }] });
  });
  ok(refused(theirRule, 422, 'INVALID') && /not one of this company/.test(theirRule.problems[0]), 'their policy cannot grant this company’s leave type (422)', why(theirRule));
  ok((await LEAVE.listPolicies(db, OTHER)).policies.every((x) => x.id !== forRole.id) && (await LEAVE.listLeaveTypes(db, OTHER)).types.every((x) => x.id !== anyType.id)
    && (await LEAVE.getPolicy(db, COMPANY, forRole.id)).policy.name === forRole.name, 'none of it is in their lists, and nothing here changed');
});

/* ══ 8. permissions ═══════════════════════════════════════════════════════ */
section('[8] Permissions, over HTTP');
{
  const server = express();
  server.use(express.json({ limit: '50mb' }));
  server.use(cookieParser());
  server.use('/api', appContext);
  hrmsApp.register(server);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  const base = `http://127.0.0.1:${listener.address().port}/api`;
  const tokenFor = async (where) => {
    const [[u]] = await pool.query(
      `SELECT u.id, u.email, u.company_id, co.slug, r.name AS role FROM users u
         JOIN companies co ON co.id = u.company_id LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.deleted_at IS NULL AND ${where} ORDER BY u.id LIMIT 1`);
    return u ? { ...u, token: signToken({ id: u.id, email: u.email, role: u.role, company: u.slug, companyId: u.company_id, company_id: u.company_id, uiPermissions: [] }) } : null;
  };
  const call = async (who, method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  try {
    const hasApp = "EXISTS (SELECT 1 FROM app_user_access x JOIN apps a ON a.id = x.app_id WHERE x.user_id = u.id AND x.deleted_at IS NULL AND a.slug = 'cf_hrms')";
    const admin = await tokenFor(`u.company_id = ${COMPANY} AND LOWER(r.name) = 'admin' AND ${hasApp}`);
    const employee = await tokenFor(`u.company_id = ${COMPANY} AND r.name = 'Employee' AND ${hasApp} AND EXISTS (SELECT 1 FROM hrms_employees e WHERE e.user_id = u.id AND e.deleted_at IS NULL)`);
    const outsider = await tokenFor(`u.company_id <> ${COMPANY} AND LOWER(r.name) = 'admin' AND ${hasApp}`);
    const api = `/${slug}/cf_hrms`;
    const ROUTES = [
      ['GET', '/leave/types'], ['POST', '/leave/types', { code: 'X', name: 'x' }], ['PUT', '/leave/types/1', { name: 'x' }], ['DELETE', '/leave/types/1'],
      ['GET', '/leave/policies'], ['GET', '/leave/policies/1'], ['POST', '/leave/policies', { name: 'x', fromTemplate: 'OFFICE_STAFF' }], ['PUT', '/leave/policies/1', { rules: [] }],
      ['DELETE', '/leave/policies/1'], ['POST', '/leave/policies/preview-summary', { rule: { days: 3 } }], ['GET', '/leave/policy-templates'],
      ['GET', '/leave/assignments'], ['PUT', '/leave/assignments', { scope: 'COMPANY', policyId: null }], ['GET', '/leave/policy-for?positionId=1'], ['GET', '/leave/status'],
    ];
    for (const [who, label] of [[employee, 'an Employee login'], [outsider, 'an admin of another company']]) {
      if (!who) { skip(label, 'no such login with access to the app'); continue; }
      const wrong = [];
      for (const [method, url, body] of ROUTES) { const r = await call(who, method, `${api}${url}`, body); if (r.status !== 403) wrong.push(`${method} ${url} ${r.status}`); }
      ok(wrong.length === 0, `${label} gets 403 from all ${ROUTES.length} leave routes`, wrong.join('; '));
    }
    if (employee) {
      const mine = await call(employee, 'GET', `${api}/user/me/place`);
      ok(mine.status === 200 && 'leavePolicy' in mine.json && 'line' in mine.json.leavePolicy && Array.isArray(mine.json.leavePolicy.rules), 'the one thing an employee can read is their OWN policy, on /user/me/place: leavePolicy { policy, from, line, rules }', JSON.stringify(mine.json?.leavePolicy)?.slice(0, 120));
    }
    ok((await call(null, 'GET', `${api}/leave/policies`)).status === 401, 'no token at all: 401');
    if (admin) {
      const [templates, policies, types, assignments, status] = [await call(admin, 'GET', `${api}/leave/policy-templates`), await call(admin, 'GET', `${api}/leave/policies`), await call(admin, 'GET', `${api}/leave/types`),
        await call(admin, 'GET', `${api}/leave/assignments`), await call(admin, 'GET', `${api}/leave/status`)];
      ok(templates.status === 200 && templates.json.templates.length === 5 && typeof templates.json.note === 'string' && policies.status === 200 && Array.isArray(policies.json.policies)
        && types.status === 200 && Array.isArray(types.json.types) && assignments.status === 200 && 'unassignedPositions' in assignments.json && 'company' in assignments.json
        && status.status === 200 && status.json.implemented === false && Array.isArray(status.json.items),
      'an admin: templates, policies, leave types and assignments answer in the spec’s shapes; the old /leave/status stub still answers as it did');
      const preview = await call(admin, 'POST', `${api}/leave/policies/preview-summary`, { rule: { leaveTypeName: 'Casual leave', days: 12, accrual: 'MONTHLY' } });
      ok(preview.status === 200 && preview.json.summary === '12 days a year, earned a day each month. Unused days lapse at the year end.' && preview.json.problems.length === 0, 'preview-summary over HTTP writes the sentence');
      const bad = await call(admin, 'PUT', `${api}/leave/assignments`, { scope: 'NOWHERE', policyId: 1 });
      ok(bad.status === 422 && bad.json.code === 'INVALID' && Array.isArray(bad.json.problems) && (await call(admin, 'GET', `${api}/leave/policies/999999999`)).status === 404, 'an error is { code, message, problems[] }; a policy that does not exist is 404');
    } else skip('an admin login', 'this company has no admin login with access to the app');
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
}

section('[end] The tenant is as it was found');
{
  const after = await snapshot();
  const moved = Object.keys(baseline).filter((k) => after[k] !== baseline[k]);
  ok(moved.length === 0, `every hrms_ table of both companies holds what it started with (${hrmsTables.length} tables)`, moved.map((k) => `${k} ${baseline[k]} -> ${after[k]}`).join('; '));
  const [[left]] = await pool.query(
    'SELECT (SELECT COUNT(*) FROM hrms_leave_policies WHERE name LIKE ?) AS policies, (SELECT COUNT(*) FROM hrms_leave_types WHERE name LIKE ? OR code LIKE ?) AS types', [`${TAG}%`, `${TAG}%`, `${TAG}%`]);
  ok(Number(left.policies) === 0 && Number(left.types) === 0
    && after.hrms_leave_policies === baseline.hrms_leave_policies && after.hrms_leave_types === baseline.hrms_leave_types && after.hrms_leave_policy_assignments === baseline.hrms_leave_policy_assignments,
  'no policy, leave type or assignment made by this run is left');
}

console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped`);
if (skipped.length) for (const s of skipped) console.log(`  skipped — ${s}`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
