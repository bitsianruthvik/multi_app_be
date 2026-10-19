/**
 * payroll_test.mjs — payroll P1 (TM/CF_HRMS_HIRING_SPEC.md §25.2, 2026-10-19).
 *
 *   0. the schema (apply-payroll-schema.mjs reads init.sql §26): a second run plans nothing;
 *   1. formulas (pure): the language, precedence, functions, and the SAFETY cases — nothing is
 *      evaluated as code; plain errors; loops named with their path;
 *   2. structures (pure): "Staff standard" by hand at three CTCs and both PF ceilings, overrides,
 *      not a PF member, a CTC too small for the fixed lines;
 *   3. proration (pure): joining, exit, LOP, half days, a revision in the month, LOP from requests;
 *   4. statutory (pure): PF (ceiling, full wage, none, the ₹25,000 ceiling), ESI (cover, rounding up,
 *      the daily-wage exemption, the periods), Telangana PT slabs, LWF — against hand-worked numbers;
 *   5. one person's month (pure), by hand;
 *   6. the run, on the database (inside one transaction, rolled back): seed; salaries and revisions;
 *      LOP from approved leave; one-time items and TDS; calculate; lock (and STALE); a LOCKED run is
 *      unchanged by every write that is tried; release (payslips, the PDF); the bank file; paid;
 *      re-open (the Owner only, with a reason); arrears of a back-dated revision;
 *   7. rights and self-only: who opens what, PAY_HIDDEN, the self routes, the audit of salary reads;
 *   8. Excel round trips: salaries (revision, correction, refusal) and a run's one-time items;
 *  10. the review of 2026-10-20 (nothing paid twice): months in order (the reviewer's June / August /
 *      September arrears, here July / August / September 2025); the Owner alone removes a run once paid
 *      or re-opened; re-open refused while a later month paid arrears for it; after a re-open the bank
 *      file pays the difference and a person paid too much is recovered in the next run; a second
 *      back-dated revision charges PF only on what is new; negative net, a bank account changed in the
 *      second of the calculation, the payroll settings; audited item and payslip lists; a scoped login
 *      and the payroll Excel; inactive with no exit date; EPS past 58; the look-back reads its window
 *      only. (Pure cases of the same review are in 1 and 5: the formula cap, an inactive statutory
 *      component, arrears of an inactive component, the bank file's formula cells.)
 *   9. nothing is left behind.
 *
 *   node scripts/cf_hrms/payroll_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND: the database part is ONE connection inside ONE transaction (pool.query /
 * getConnection point at it; a route's own transaction is a savepoint), rolled back at the end.
 * Its runs are for 2025 months — Karni's people joined in 2026, so they are in none of them.
 * Local only.
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
import F from '../../apps/cf_hrms/services/payroll/formula.js';
import { breakdown } from '../../apps/cf_hrms/services/payroll/structure.js';
import * as PR from '../../apps/cf_hrms/services/payroll/proration.js';
import * as ST from '../../apps/cf_hrms/services/payroll/statutory.js';
import { computePerson, earningsFor } from '../../apps/cf_hrms/services/payroll/calc.js';
import { READY_MADE_COMPONENTS, SAMPLE_STRUCTURE, STATUTORY_ROWS } from '../../apps/cf_hrms/services/payroll/seed.js';
import { neftCsv } from '../../apps/cf_hrms/services/payroll/bankFile.js';
import { rupeesInWords } from '../../apps/cf_hrms/services/payroll/payslip.js';
import { schemaSteps, PAYROLL_TABLES } from '../../apps/cf_hrms/scripts/apply-payroll-schema.mjs';

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
const throwsLike = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message) ? true : e.message; } };
const started = Date.now();

const TABLES = [...PAYROLL_TABLES, 'hrms_audit_log', 'hrms_employees', 'hrms_employee_identifiers', 'hrms_leave_requests', 'hrms_leave_types', 'users', 'app_user_access', 'roles', 'hrms_access_roles', 'role_capability'];
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

/* ══ 0. the schema ══════════════════════════════════════════════════════ */
section('[0] The schema');
{
  const conn = await mysql.createConnection(dbCfg);
  try {
    ok(PAYROLL_TABLES.length === 12, 'init.sql §26 declares the twelve hrms_pay_* tables (hrms_pay_payments since 2026-10-20)', PAYROLL_TABLES.join(','));
    ok((await schemaSteps(conn)).length === 0, 'apply-payroll-schema: nothing left to do on this database (idempotent)');
    const [cols] = await conn.query("SELECT COLUMN_NAME, DATA_TYPE, NUMERIC_PRECISION, NUMERIC_SCALE, TABLE_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'hrms_pay_%' AND DATA_TYPE = 'decimal' AND COLUMN_NAME NOT LIKE '%days%'");
    ok(cols.length >= 15 && cols.every((c) => Number(c.NUMERIC_PRECISION) === 14 && Number(c.NUMERIC_SCALE) === 2), 'every amount is DECIMAL(14,2)', cols.filter((c) => Number(c.NUMERIC_PRECISION) !== 14).map((c) => `${c.TABLE_NAME}.${c.COLUMN_NAME}`).join(','));
    const [del] = await conn.query("SELECT TABLE_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'hrms_pay_%' AND COLUMN_NAME = 'deleted_at'");
    ok(PAYROLL_TABLES.every((t) => del.some((d) => d.TABLE_NAME === t)), 'every payroll table of §26 is soft-deleted (deleted_at), none is hard-deleted', PAYROLL_TABLES.filter((t) => !del.some((d) => d.TABLE_NAME === t)).join(','));
  } finally { await conn.end(); }
}

/* ══ 1. formulas ════════════════════════════════════════════════════════ */
section('[1] Formulas');
{
  const ev = (s, v = {}) => F.evaluateText(s, v);
  ok(ev('40% of CTC', { CTC: 50000 }) === 20000 && ev('50% * BASIC', { BASIC: 20000 }) === 10000 && ev('1600') === 1600, 'numbers, percent, “of”, references');
  ok(ev('2 + 3 * 4') === 14 && ev('(2 + 3) * 4') === 20 && ev('10 - 4 - 3') === 3 && ev('100 / 4 / 5') === 5 && ev('-5 + 2') === -3 && ev('2 * -3') === -6, 'precedence: × ÷ before + −, left to right, unary minus');
  ok(ev('10 − 3 × 2') === 4 && ev('12 ÷ 4') === 3 && ev('₹1600') === 1600, '× ÷ − typed as in Word, and a rupee sign before a number');
  ok(ev('min(BASIC, 15000)', { BASIC: 20000 }) === 15000 && ev('max(1000, 2000, 1500)') === 2000 && ev('round(1234.5)') === 1235 && ev('round(12.345, 2)') === 12.35 && ev('round(1234.5, -2)') === 1200,
    'min, max (two or more), round to the rupee, to paise, to the hundred');
  ok(ev('round(12% of min(basic, 15000))', { BASIC: 20000 }) === 1800 && ev('pf_ceiling', { PF_CEILING: 25000 }) === 25000, 'codes are not case sensitive; PF_CEILING is a name');
  const safety = [
    ['process.exit()', /“\.” cannot be used|not a component/], ['require("fs")', /cannot be used/], ['constructor', /not a component/], ['__proto__', /not a component/],
    ['this', /not a component/], ['eval(1)', /not something a formula can use/], ['Function("x")', /cannot be used|not something/], ['a = 1', /cannot be used/],
    ['1; 2', /cannot be used/], ['`x`', /cannot be used/], ['[1]', /cannot be used/], ['{}', /cannot be used/], ['sqrt(4)', /not something a formula can use. A formula can use min, max and round/],
    ['BASIC.toString', /cannot be used/], ['x'.repeat(301), /at most 300/], [`${'('.repeat(40)}1${')'.repeat(40)}`, /too many brackets/], ['1 +', /stops too early/], ['(1 + 2', /not closed/],
    ['1 + 2)', /closed that was never opened/], ['15,000', /without commas/], ['1/0', /divides by zero/], ['BASIC HRA', /operator is missing/], ['', /empty/], ['40 %% 2', /% comes after a number|missing/],
    ['min(1)', /two or more/], ['round(1, 2, 3)', /round takes/], ['round(1, 0.5)', /whole number/], ['balance + 1', /whole formula on its own/],
  ];
  const bad = safety.map(([s, re]) => [s, throwsLike(() => ev(s, { BASIC: 1, HRA: 1 }), re)]).filter(([, r]) => r !== true);
  ok(!bad.length, `the safety cases: ${safety.length} formulas that must be refused in words, never run`, JSON.stringify(bad.slice(0, 4)));
  ok(!globalThis.__pwned, 'nothing a formula said ran');
  const L = (code, formula, inCtc = true) => ({ code, name: code, formula, inCtc });
  const loop = F.checkLines([L('A', 'B + 1'), L('B', 'C * 2'), L('C', 'A')]);
  ok(loop.problems.length === 1 && /loop: A → B → C → A/.test(loop.problems[0]), 'a loop of three is found and named with its path', loop.problems[0]);
  ok(/loop: A → A/.test(F.checkLines([L('A', 'A + 1')]).problems[0] ?? ''), 'a line that uses itself is a loop');
  ok(/balance line uses every other line/.test(F.checkLines([L('A', 'S / 2'), L('S', 'balance')]).problems[0] ?? ''), 'a line that uses the balance line is a loop, said so');
  ok(/DA is not a line of this structure/.test(F.checkLines([L('HRA', '50% of DA')]).problems[0] ?? ''), 'a code that is not in the structure is named');
  ok(/Only one line can be the balance/.test(F.checkLines([L('A', 'balance'), L('B', 'balance')]).problems.join(' ')), 'two balance lines are refused');
  ok(/for a line that is part of CTC/.test(F.checkLines([L('D', 'balance', false)]).problems[0] ?? ''), 'a deduction cannot be the balance');
  const order = F.checkLines([L('SPECIAL', 'balance'), L('HRA', '50% of BASIC'), L('BASIC', '40% of CTC')]).order;
  ok(order.indexOf('BASIC') < order.indexOf('HRA') && order.indexOf('HRA') < order.indexOf('SPECIAL'), 'lines are worked out in the order of what they use, not as typed');
  ok(/PF_CEILING is not known here/.test(F.evaluateLines([L('PF', '12% of min(1, PF_CEILING)')], 12000).problems[0] ?? ''), 'PF_CEILING without the settings of the day: said, not guessed');
  // Review 12: a formula line has a cap — never a raw database error.
  const huge = F.evaluateLines([L('BASIC', '99999999 * 99999999'), L('SPECIAL', 'balance')], 600000);
  ok(throwsLike(() => ev('99999999 * 99999999'), /1,000 crore/) === true && !huge.ok && /1,000 crore/.test(huge.problems[0] ?? '') && F.evaluateLines([L('BASIC', 'balance')], 1e11 * 12).problems.some((p) => /1,000 crore/.test(p)),
    'review 12: a line of ₹1,000 crore or more a month (a formula, or the balance) is refused in words', JSON.stringify(huge.problems));
}

/* ══ 2. structures ═════════════════════════════════════════════════════ */
section('[2] Structures');
const COMPS = new Map(READY_MADE_COMPONENTS.map((k, i) => [i + 1, { id: i + 1, ...k, inPfWage: Boolean(k.inPfWage), inEsiWage: Boolean(k.inEsiWage), prorateOnLop: Boolean(k.prorateOnLop), status: 'ACTIVE' }]));
const idOf = (code) => [...COMPS.values()].find((k) => k.code === code).id;
const STAFF = SAMPLE_STRUCTURE.lines.map(([code, formula], i) => ({ componentId: idOf(code), formula, sortOrder: (i + 1) * 10 }));
const amounts = (b) => Object.fromEntries(b.lines.map((l) => [l.code, l.monthly]));
{
  const v15 = { PF_CEILING: 15000, ESI_CEILING: 21000 };
  const a = breakdown(STAFF, COMPS, 600000, {}, { vars: v15 });
  ok(a.ok && JSON.stringify(amounts(a)) === JSON.stringify({ BASIC: 20000, HRA: 10000, CONVEYANCE: 1600, MEDICAL: 1250, PF_ER: 1800, SPECIAL: 15350 }) && a.monthlyCtc === 50000 && a.totals.ctcLines === 50000,
    'Staff standard at ₹6,00,000: Basic 20,000 · HRA 10,000 · 1,600 · 1,250 · employer PF 12% of 15,000 = 1,800 · Special 15,350 = 50,000 a month', JSON.stringify(amounts(a)));
  const a25 = breakdown(STAFF, COMPS, 600000, {}, { vars: { PF_CEILING: 25000 } });
  ok(amounts(a25).PF_ER === 2400 && amounts(a25).SPECIAL === 14750, 'with the ₹25,000 ceiling: employer PF 12% of 20,000 = 2,400, Special 14,750');
  const low = breakdown(STAFF, COMPS, 180000, {}, { vars: v15 });
  ok(JSON.stringify(amounts(low)) === JSON.stringify({ BASIC: 6000, HRA: 3000, CONVEYANCE: 1600, MEDICAL: 1250, PF_ER: 720, SPECIAL: 2430 }), 'at ₹1,80,000: 6,000 · 3,000 · 1,600 · 1,250 · 720 · 2,430', JSON.stringify(amounts(low)));
  const odd = breakdown(STAFF, COMPS, 543210, {}, { vars: v15 });
  ok(odd.ok && Math.abs(odd.totals.ctcLines - odd.monthlyCtc) < 0.001 && odd.monthlyCtc === 45267.5, 'an odd CTC: every line to the rupee, the balance takes the paise — the lines add up to the monthly CTC exactly', `${odd.totals.ctcLines} ${odd.monthlyCtc}`);
  const over = breakdown(STAFF, COMPS, 600000, { [idOf('HRA')]: 5000 }, { vars: v15 });
  ok(amounts(over).HRA === 5000 && amounts(over).SPECIAL === 20350 && over.lines.find((l) => l.code === 'HRA').overridden, 'an override replaces the formula; the balance follows (Special 20,350)');
  const none = breakdown(STAFF, COMPS, 600000, {}, { pfMode: 'NONE', vars: v15 });
  ok(amounts(none).PF_ER === 0 && amounts(none).SPECIAL === 17150, 'not a PF member: no employer PF in the CTC, Special 17,150');
  const tiny = breakdown(STAFF, COMPS, 60000, {}, { vars: v15 });
  ok(tiny.ok && amounts(tiny).SPECIAL === -1090 && /add up to more than the monthly CTC/.test(tiny.warnings[0] ?? ''), 'a CTC too small for the fixed lines: the balance goes below zero, with a warning', JSON.stringify(tiny.warnings));
  ok(a.lines.find((l) => l.code === 'BASIC').annual === 240000, 'each line also a year');
}

/* ══ 3. proration ══════════════════════════════════════════════════════ */
section('[3] Proration');
{
  const S1 = { id: 1, effectiveFrom: '2025-01-01', effectiveTo: null };
  const full = PR.monthDays({ month: '2026-09', joiningDate: '2025-01-01', salaries: [S1] });
  ok(full.daysInMonth === 30 && full.employedDays === 30 && full.payableDays === 30 && full.segments.length === 1 && !full.joinedMid && !full.leftMid, 'a full month: 30 of 30 days');
  const join = PR.monthDays({ month: '2026-09', joiningDate: '2026-09-16', salaries: [{ id: 2, effectiveFrom: '2026-09-16' }] });
  ok(join.employedDays === 15 && join.payableDays === 15 && join.joinedMid, 'joined on the 16th: 15 days');
  const exit = PR.monthDays({ month: '2026-09', joiningDate: '2025-01-01', exitDate: '2026-09-10', salaries: [S1] });
  ok(exit.employedDays === 10 && exit.leftMid, 'left on the 10th: 10 days');
  const lop = PR.monthDays({ month: '2026-09', joiningDate: '2025-01-01', salaries: [S1], lopDays: [{ date: '2026-09-07', amount: 1 }, { date: '2026-09-08', amount: 1 }, { date: '2026-09-09', amount: 0.5 }, { date: '2026-09-09', amount: 0.5 }, { date: '2026-09-09', amount: 0.5 }, { date: '2026-10-01', amount: 1 }] });
  ok(lop.lopDays === 3 && lop.payableDays === 27 && lop.lopDates.length === 3, 'LOP: 2 days + two half days on one date (= 1, never more than a day) = 3; other months ignored → 27 payable', JSON.stringify(lop.lopDates));
  const split = PR.monthDays({ month: '2026-09', joiningDate: '2025-01-01', salaries: [{ id: 1, effectiveFrom: '2025-01-01', effectiveTo: '2026-09-14' }, { id: 3, effectiveFrom: '2026-09-15' }], lopDays: [{ date: '2026-09-20', amount: 1 }] });
  ok(split.segments.length === 2 && split.segments[0].days === 14 && split.segments[1].days === 16 && split.segments[1].lop === 1 && split.segments[0].lop === 0, 'a revision on the 15th: two segments of 14 and 16 days, the LOP day in the second');
  const p = PR.prorate([{ days: 30, payable: 28, monthly: 20000 }], 30, true);
  ok(Math.round(p.amount) === 18667 && /20,000 × 28\/30 days/.test(p.basis), '₹20,000 with 2 LOP days of 30: 18,666.67 → 18,667, said as “20,000 × 28/30 days”', p.basis);
  ok(PR.prorate([{ days: 30, payable: 28, monthly: 1250 }], 30, false).amount === 1250, 'a component not prorated on LOP stays whole');
  ok(Math.round(PR.prorate([{ days: 14, payable: 14, monthly: 30000 }, { days: 16, payable: 15, monthly: 36000 }], 30, true).amount) === 32000, 'two salaries in a month: 30,000 × 14/30 + 36,000 × 15/30 = 32,000');
  const req = PR.lopFromRequests([
    { status: 'APPROVED', isPaid: false, daysJson: JSON.stringify([{ date: '2026-09-07', counts: true, amount: 1 }, { date: '2026-09-06', counts: false, amount: 0 }]) },
    { status: 'APPROVED', isPaid: true, daysJson: [{ date: '2026-09-10', amount: 1 }] },
    { status: 'PENDING', isPaid: false, daysJson: [{ date: '2026-09-11', amount: 1 }] },
    { status: 'APPROVED', isPaid: false, from: '2026-09-21', to: '2026-09-21', halfDay: 'FIRST' },
  ]);
  ok(JSON.stringify(req) === JSON.stringify([{ date: '2026-09-07', amount: 1 }, { date: '2026-09-21', amount: 0.5 }]), 'LOP from leave: approved unpaid only (not a paid type, not pending), the counted days, a half day as 0.5', JSON.stringify(req));
  ok(PR.monthBounds('2024-02').days === 29 && PR.monthBounds('2026-02').days === 28 && PR.monthBounds('2026-07').label === 'July 2026', 'months: February in a leap year');
}

/* ══ 4. statutory ══════════════════════════════════════════════════════ */
section('[4] Statutory, by hand');
const SET = (kind, from) => ({ ...STATUTORY_ROWS.filter((r) => r.kind === kind && r.effectiveFrom <= from).pop().settings });
{
  const PF15 = SET('PF', '2026-04-01');
  const PF25 = SET('PF', '2026-10-01');
  const a = ST.pfFor({ pfWage: 20000, settings: PF15 });
  ok(a.base === 15000 && a.employee === 1800 && a.employer === 1800 && a.eps === 1250 && a.epf === 550 && a.edli === 75 && a.admin === 75,
    'PF on ₹20,000, ceiling 15,000: base 15,000; employee 1,800; employer 1,800 = EPS 1,250 (8.33% = 1,249.50 → nearest) + EPF 550; EDLI 75; admin 75', JSON.stringify(a));
  const b = ST.pfFor({ pfWage: 12345, settings: PF15 });
  ok(b.employee === 1481 && b.eps === 1028 && b.epf === 453, 'PF on ₹12,345: 1,481.40 → 1,481; EPS 1,028.34 → 1,028; EPF 453', JSON.stringify(b));
  const f = ST.pfFor({ pfWage: 30000, mode: 'FULL', settings: PF15 });
  ok(f.employee === 3600 && f.employer === 3600 && f.eps === 1250 && f.epf === 2350, 'PF on the full wage ₹30,000: 3,600 each; EPS still on 15,000 only (1,250), EPF 2,350');
  ok(ST.pfFor({ pfWage: 30000, mode: 'NONE', settings: PF15 }).employee === 0, 'not a PF member: nothing');
  const c25 = ST.pfFor({ pfWage: 30000, settings: PF25 });
  ok(PF25.wageCeiling === 25000 && c25.base === 25000 && c25.employee === 3000 && c25.eps === 2083 && c25.epf === 917, 'from 17 Sep 2026, ceiling ₹25,000: on ₹30,000 base 25,000, 3,000 each, EPS 2,082.50 → 2,083, EPF 917', JSON.stringify(c25));
  const ESI = SET('ESI', '2026-04-01');
  const e1 = ST.esiFor({ esiWage: 18000, covered: true, payableDays: 30, settings: ESI });
  ok(e1.employee === 135 && e1.employer === 585, 'ESI on ₹18,000: employee 135, employer 585');
  const e2 = ST.esiFor({ esiWage: 15500, covered: true, payableDays: 30, settings: ESI });
  ok(e2.employee === 117 && e2.employer === 504, 'ESI on ₹15,500: 116.25 → 117 and 503.75 → 504 (to the next higher rupee)');
  const e3 = ST.esiFor({ esiWage: 4000, covered: true, payableDays: 30, settings: ESI });
  ok(e3.employee === 0 && e3.employer === 130 && e3.exempt, 'ESI at ₹133.33 a day (≤ ₹176): the employee pays nothing, the employer 130');
  ok(ST.esiFor({ esiWage: 18000, covered: false, payableDays: 30, settings: ESI }).employer === 0, 'not covered: nothing');
  ok(ST.esiCovered({ rateAtStart: 21000, settings: ESI }) && !ST.esiCovered({ rateAtStart: 21001, settings: ESI }), 'covered at a wage of ₹21,000, not at ₹21,001');
  const p1 = ST.esiPeriodOf('2026-09', ESI); const p2 = ST.esiPeriodOf('2027-02', ESI); const p3 = ST.esiPeriodOf('2026-10', ESI);
  ok(p1.from === '2026-04-01' && p1.to === '2026-09-30' && p2.from === '2026-10-01' && p2.to === '2027-03-31' && p3.from === '2026-10-01', 'contribution periods: Apr–Sep, and Oct–Mar across the year');
  const PT = SET('PT', '2026-04-01');
  const pt = [0, 15000, 15001, 20000, 20001, 90000].map((g) => ST.ptFor({ gross: g, settings: PT }).amount);
  ok(JSON.stringify(pt) === JSON.stringify([0, 0, 150, 150, 200, 200]), 'Telangana PT: nil to 15,000; 150 from 15,001 to 20,000; 200 above', JSON.stringify(pt));
  const LWF = SET('LWF', '2026-04-01');
  ok(ST.lwfFor({ month: '2026-12', paid: true, settings: LWF }).employee === 2 && ST.lwfFor({ month: '2026-12', paid: true, settings: LWF }).employer === 5
    && ST.lwfFor({ month: '2026-09', paid: true, settings: LWF }).employee === 0 && ST.lwfFor({ month: '2026-12', paid: false, settings: LWF }).employee === 0, 'Telangana LWF: ₹2 and ₹5 in December, nothing in other months or without pay');
  ok(STATUTORY_ROWS.every((r) => r.source && r.sourceUrl && /^https:\/\//.test(r.sourceUrl)) && STATUTORY_ROWS.filter((r) => r.verification === 'UNVERIFIED').map((r) => r.kind).join() === 'LWF,LWF',
    'every seeded value has its source and URL; only LWF (the December timing) is UNVERIFIED');
}

/* ══ 5. one person's month ═════════════════════════════════════════════ */
section('[5] One person’s month, by hand');
const BYCODE = new Map([...COMPS.values()].map((k) => [k.code, k]));
const SETTINGS = (from) => ({ PF: SET('PF', from), ESI: SET('ESI', from), PT: SET('PT', from), LWF: SET('LWF', from) });
const month = (ctc, { lop = [], joiningDate = '2025-01-01', exitDate = null, m = '2026-09', oneTime = [], tds = 0, arrears = [], covered = false } = {}) => {
  const b = breakdown(STAFF, COMPS, ctc, {}, { vars: { PF_CEILING: 15000 } });
  const days = PR.monthDays({ month: m, joiningDate, exitDate, salaries: [{ id: 1, effectiveFrom: '2025-01-01' }], lopDays: lop });
  for (const g of days.segments) g.amounts = amounts(b);
  return computePerson({ month: m, days, components: BYCODE, oneTime, tds, arrears, pfMode: 'CEILING', esiCovered: covered, settings: SETTINGS(`${m}-01`) });
};
{
  const a = month(600000);
  ok(a.gross === 48200 && a.pfWage === 20000 && a.deductions === 2000 && a.netPay === 46200 && a.employer === 1800,
    '₹6,00,000, a full month: gross 48,200; PF 1,800 + PT 200; net 46,200; employer PF 1,800', JSON.stringify({ g: a.gross, d: a.deductions, n: a.netPay, e: a.employer }));
  const l = month(600000, { lop: [{ date: '2026-09-07', amount: 1 }, { date: '2026-09-08', amount: 1 }] });
  const L = Object.fromEntries(l.lines.map((x) => [x.code, x.amount]));
  ok(L.BASIC === 18667 && L.HRA === 9333 && L.CONVEYANCE === 1493 && L.MEDICAL === 1167 && L.SPECIAL === 14327 && l.gross === 44987 && l.netPay === 42987,
    'with 2 LOP days: 18,667 · 9,333 · 1,493 · 1,167 · 14,327 = 44,987; PF 1,800, PT 200; net 42,987', JSON.stringify(L));
  const low = month(180000, { covered: true });
  const W = Object.fromEntries(low.lines.map((x) => [x.code, x.amount]));
  ok(low.gross === 14280 && W.PF_EE === 720 && W.PF_ER === 720 && W.ESI_EE === 108 && W.ESI_ER === 465 && !W.PT && low.netPay === 13452,
    '₹1,80,000, covered by ESI: gross 14,280; PF 720; ESI 107.10 → 108 and 464.10 → 465; no PT; net 13,452', JSON.stringify(W));
  const extra = month(600000, { oneTime: [{ code: 'BONUS', amount: 5000, note: 'Diwali' }, { code: 'LOAN', amount: 1000 }], tds: 2500 });
  const X = Object.fromEntries(extra.lines.map((x) => [x.code, x.amount]));
  ok(extra.gross === 53200 && X.BONUS === 5000 && X.LOAN === 1000 && X.TDS === 2500 && extra.netPay === 53200 - 1800 - 200 - 1000 - 2500 && extra.pfWage === 20000,
    'a bonus 5,000 (not PF wage), a loan recovery 1,000 and TDS 2,500: net 47,700', JSON.stringify(X));
  const dec = month(600000, { m: '2026-12' });
  ok(dec.lines.some((x) => x.code === 'LWF_EE' && x.amount === 2) && dec.lines.some((x) => x.code === 'LWF_ER' && x.amount === 5) && dec.netPay === 48200 - 2400 - 200 - 2,
    'December 2026: LWF ₹2 from the pay and ₹5 by the company; PF now on the ₹25,000 ceiling (2,400); net 45,598', String(dec.netPay));
  const neg = month(600000, { oneTime: [{ code: 'OTHER_DED', amount: 60000 }] });
  ok(neg.netPay < 0 && /more than the pay/.test(neg.warnings[0] ?? ''), 'deductions above the pay: said');
  ok(rupeesInWords(46200) === 'Forty-six thousand two hundred rupees only' && rupeesInWords(1234567) === 'Twelve lakh thirty-four thousand five hundred and sixty-seven rupees only', 'net pay in words, the Indian way');
  const csv = neftCsv({ month: '2026-09' }, [
    { employee: { code: 'E1', name: 'Asha "Rao"' }, net: 46200, bank: { account: '123456789012', ifsc: 'SBIN0001234' } },
    { employee: { code: 'E2', name: 'No Bank' }, net: 1000, bank: {} },
    { employee: { code: 'E3', name: 'Bad Ifsc' }, net: 1000, bank: { account: '1', ifsc: 'XX' } },
    { employee: { code: 'E4', name: 'Nothing' }, net: 0, bank: { account: '1', ifsc: 'SBIN0001234' } },
  ], { debitAccountNo: '999', narration: 'Salary' });
  ok(csv.rows === 1 && csv.total === 46200 && csv.skipped.length === 3 && csv.csv.split('\r\n')[1] === '1,NEFT,Asha Rao,123456789012,SBIN0001234,46200.00,Salary September 2026,E1,999', 'the NEFT file: one row per person paid; no bank, a bad IFSC, no pay: skipped with why', csv.csv.split('\r\n')[1]);

  // Review 11: nothing in the bank file is read as a formula by Excel.
  const evil = neftCsv({ month: '2026-09' }, [{ employee: { code: '=HYPERLINK("x")', name: '-2+3 Rao' }, net: 100, bank: { account: '@SUM(1)', ifsc: 'SBIN0001234' } }], { debitAccountNo: '+91' });
  const cells = evil.csv.split('\r\n')[1];
  ok(/,'-2 3 Rao,/.test(cells) && cells.includes(",'@SUM(1),") && cells.includes(`"'=HYPERLINK(""x"")"`) && cells.endsWith(",'+91"),
    'review 11: a name, account, code or debit account starting with = + - @ gets a leading apostrophe', cells);

  // Review 6: an INACTIVE statutory component — no line, and not counted in the totals either.
  const noPfEe = new Map([...BYCODE].map(([k, v]) => [k, k === 'PF_EE' ? { ...v, status: 'INACTIVE' } : v]));
  const b6 = PR.monthDays({ month: '2026-09', joiningDate: '2025-01-01', salaries: [{ id: 1, effectiveFrom: '2025-01-01' }] });
  for (const g of b6.segments) g.amounts = amounts(breakdown(STAFF, COMPS, 600000, {}, { vars: { PF_CEILING: 15000 } }));
  const k6 = computePerson({ month: '2026-09', days: b6, components: noPfEe, oneTime: [], tds: 0, arrears: [], pfMode: 'CEILING', esiCovered: false, settings: SETTINGS('2026-09-01') });
  ok(!k6.lines.some((l) => l.code === 'PF_EE') && k6.pf.employee === 0 && k6.pf.employer === 1800 && k6.netPay === 48000 && k6.warnings.some((w) => /PF \(employee\) of 1,800 is due, but its component is inactive/.test(w)),
    'review 6: PF (employee) inactive — no line, pf.employee 0 for the totals, said in the warnings; employer PF still 1,800', JSON.stringify({ pf: k6.pf.employee, w: k6.warnings }));

  // Review 7: arrears recompute a past month with a component made INACTIVE since, when that month paid it.
  const offConv = new Map([...BYCODE].map(([k, v]) => [k, k === 'CONVEYANCE' ? { ...v, status: 'INACTIVE' } : v]));
  const e7 = earningsFor({ days: b6, components: offConv, paidCodes: new Set(['BASIC', 'HRA', 'CONVEYANCE', 'MEDICAL', 'SPECIAL']) });
  const e7none = earningsFor({ days: b6, components: offConv, paidCodes: new Set(['BASIC', 'HRA', 'MEDICAL', 'SPECIAL']) });
  ok(e7.total === 48200 && e7none.total === 46600, 'review 7: a month that paid Conveyance still counts it after Conveyance is made inactive (48,200, not 46,600)', `${e7.total} / ${e7none.total}`);
}

/* ══ the database part: one transaction, rolled back ═══════════════════ */
const real = { query: pool.query.bind(pool), execute: pool.execute.bind(pool), getConnection: pool.getConnection.bind(pool) };
const db = await real.getConnection();
await db.beginTransaction();
let depth = 0;
let spy = null; // section 10: sees the SQL the routes send
const inside = {
  query: (...a) => { if (spy) spy(a[0], a[1]); return db.query(...a); },
  execute: (...a) => db.execute(...a),
  beginTransaction: async () => { depth += 1; await db.query(`SAVEPOINT zz_pay_${depth}`); },
  commit: async () => { if (depth > 0) { await db.query(`RELEASE SAVEPOINT zz_pay_${depth}`); depth -= 1; } },
  rollback: async () => { if (depth > 0) { await db.query(`ROLLBACK TO SAVEPOINT zz_pay_${depth}`); depth -= 1; } },
  release: () => {},
};
pool.query = inside.query;
pool.execute = inside.execute;
pool.getConnection = async () => inside;

const TAG = `ZZPY${Date.now().toString(36).toUpperCase().slice(-5)}`;
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
  console.log(`\npayroll_test — ${company.name} (${COMPANY}), run tag ${TAG}`);
  // Earlier runs of these months (somebody's demo): out of the way, inside the transaction. Months are
  // paid in order, so every run before them goes too.
  await db.query("UPDATE hrms_pay_runs SET deleted_at = NOW() WHERE company_id = ? AND period_month <= '2025-12' AND deleted_at IS NULL", [COMPANY]);

  /* ── logins and the in-process server ───────────────────────────────── */
  await setupAccess(db, COMPANY, { apply: true });
  const roleByKey = Object.fromEntries((await q('SELECT role_id, template_key FROM hrms_access_roles WHERE company_id = ? AND deleted_at IS NULL AND template_key IS NOT NULL', [COMPANY])).map((r) => [r.template_key, r.role_id]));
  const catalog = await ensureCatalog(db, { apply: true });
  // A role of our own: payroll view, and NOT pay view.
  const noPayRole = await ins('INSERT INTO roles (name, company_id) VALUES (?, ?)', [`${TAG} Payroll clerk`, COMPANY]);
  await db.query("INSERT INTO hrms_access_roles (company_id, role_id, label, scope) VALUES (?, ?, ?, 'COMPANY')", [COMPANY, noPayRole, `${TAG} Payroll clerk`]);
  await setRoleTags(db, { companyId: COMPANY, appId: app.id, roleId: noPayRole, tags: [areaTag('payroll', 'view'), areaTag('payroll', 'edit')], catalog });

  const emp = async (code, joining, exit = null) => ins(
    "INSERT INTO hrms_employees (company_id, employee_code, full_name, date_of_joining, exit_date, employment_type, employment_status) VALUES (?, ?, ?, ?, ?, 'EMPLOYEE', ?)",
    [COMPANY, `${TAG}${code}`, `${TAG} Person ${code}`, joining, exit, exit ? 'EXITED' : 'ACTIVE']);
  const E = { a: await emp('A', '2024-04-01'), b: await emp('B', '2025-07-16'), l: await emp('L', '2024-04-01'), n: await emp('N', '2024-04-01'), x: await emp('X', '2024-04-01', '2025-07-10') };
  const ident = (e, type, value) => db.query('INSERT INTO hrms_employee_identifiers (company_id, employee_id, identifier_type, identifier_value) VALUES (?, ?, ?, ?)', [COMPANY, e, type, value]);
  await ident(E.a, 'BANK_ACCOUNT', '123456789012'); await ident(E.a, 'IFSC', 'SBIN0001234'); await ident(E.a, 'PAN', 'ABCDE1234F');

  const login = async (label, roleId, employeeId = null) => {
    const email = `${TAG.toLowerCase()}.${label.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.test`;
    const id = await ins('INSERT INTO users (name, email, password, role_id, team_id, company_id) VALUES (?, ?, ?, ?, NULL, ?)', [`${TAG} ${label}`, email, 'x', roleId, COMPANY]);
    await db.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [id, app.id, roleId, COMPANY]);
    if (employeeId) await db.query('UPDATE hrms_employees SET user_id = ? WHERE id = ?', [id, employeeId]);
    const roleName = (await one('SELECT name FROM roles WHERE id = ?', [roleId])).name;
    return { id, token: signToken({ id, name: `${TAG} ${label}`, email, role: roleName, company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
  };
  const O = { id: owner.id, token: signToken({ id: owner.id, name: owner.name, email: owner.email, role: 'admin', company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
  const U = {
    HR: await login('HR manager', roleByKey.HR_MANAGER), HRX: await login('HR executive', roleByKey.HR_EXECUTIVE), DH: await login('Department head', roleByKey.DEPARTMENT_HEAD),
    CLERK: await login('Clerk', noPayRole), A: await login('Employee A', roleByKey.EMPLOYEE, E.a), B: await login('Employee B', roleByKey.EMPLOYEE, E.b),
  };
  forgetAccess();
  server = express();
  server.use(express.json({ limit: '20mb' }));
  server.use(cookieParser());
  server.use('/api', appContext);
  hrmsApp.register(server);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  server.close = () => new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${listener.address().port}/api`;
  const call = async (who, method, url, body) => {
    const res = await fetch(`${base}/${company.slug}/cf_hrms${url}`, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  const must = async (who, method, url, body) => {
    const r = await call(who, method, url, body);
    if (r.status !== 200) throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };

  /* ══ 6. the run ═══════════════════════════════════════════════════════ */
  section('[6] Setup, salaries and the run');
  const seeded = await must(U.HR, 'POST', '/payroll/setup');
  const again = await must(U.HR, 'POST', '/payroll/setup');
  // A company set up before a ready-made component was added gets only the new one (NPS_ER, P3a).
  const hadSeed = !seeded.created.structure && seeded.created.statutory.length === 0 && seeded.created.components.every((code) => code === 'NPS_ER');
  ok((hadSeed || (seeded.created.components.length === READY_MADE_COMPONENTS.length && seeded.created.structure === 'Staff standard' && seeded.created.statutory.length === 9))
    && again.created.components.length === 0 && !again.created.structure && again.created.statutory.length === 0, `setup: ${READY_MADE_COMPONENTS.length} components, Staff standard, 9 statutory rows — a second run adds nothing`, JSON.stringify(seeded.created));
  const comps = (await must(U.HR, 'GET', '/payroll/components')).components;
  const C = Object.fromEntries(comps.map((k) => [k.code, k]));
  const staff = (await must(U.HR, 'GET', '/payroll/structures')).structures.find((s) => s.code === 'STAFF_STD');
  ok(staff && staff.lines.length === 6 && staff.lines.find((l) => l.code === 'PF_ER').formula === 'round(12% of min(BASIC, PF_CEILING))', 'the sample structure is there, its formulas as seeded');
  const prev = await must(U.HR, 'POST', '/payroll/structures/preview', { lines: staff.lines.map((l) => ({ componentId: l.componentId, formula: l.formula })), annualCtc: 600000, on: '2026-07-01' });
  ok(prev.ok && prev.lines.find((l) => l.code === 'SPECIAL').monthly === 15350 && prev.vars.PF_CEILING === 15000, 'the live preview: Special 15,350 with the ceiling of the day (15,000)');
  const badS = await call(U.HR, 'POST', '/payroll/structures', { code: `${TAG}S`, name: 'Loop', lines: [{ componentId: C.BASIC.id, formula: 'HRA' }, { componentId: C.HRA.id, formula: 'BASIC' }] });
  ok(badS.status === 422 && /loop/.test(JSON.stringify(badS.json.problems)), 'a structure with a loop is refused, in words');
  const pfLine = await call(U.HR, 'POST', '/payroll/structures', { code: `${TAG}T`, name: 'PT line', lines: [{ componentId: C.PT.id, formula: '200' }] });
  ok(pfLine.status === 422 && /worked out by the run/.test(JSON.stringify(pfLine.json.problems)), 'professional tax is worked out by the run, not a line of a structure');
  const del = await call(U.HR, 'DELETE', `/payroll/components/${C.BASIC.id}`);
  ok(del.status === 409 && /in use by/.test(del.json.message), 'a component a structure uses cannot be removed', del.json?.message);
  ok((await call(U.HR, 'DELETE', `/payroll/components/${C.PF_EE.id}`)).status === 409, 'a component worked out by law cannot be removed');
  const renamed = await call(U.HR, 'PUT', `/payroll/components/${C.BASIC.id}`, { code: 'BASICPAY' });
  ok(renamed.status === 422 && /Keep the code/.test(JSON.stringify(renamed.json)), 'the code of a component formulas use cannot change');

  const salary = (employeeId, annualCtc, effectiveFrom, extra = {}) => call(U.HR, 'POST', '/payroll/salaries', { employeeId, annualCtc, structureId: staff.id, effectiveFrom, reason: 'Test', ...extra });
  const sA = await salary(E.a, 600000, '2025-04-01');
  const sB = await salary(E.b, 180000, '2025-07-16');
  const sL = await salary(E.l, 600000, '2025-04-01');
  const sX = await salary(E.x, 600000, '2025-04-01');
  ok([sA, sB, sL, sX].every((r) => r.status === 200), 'salaries for four people', JSON.stringify([sA, sB, sL, sX].map((r) => r.json?.problems ?? r.status)));
  const early = await salary(E.b, 180000, '2025-07-01');
  ok(early.status === 422, 'a salary before the person joined is refused', JSON.stringify(early.json?.problems));
  const same = await salary(E.a, 650000, '2025-04-01');
  ok(same.status === 422 && /latest/.test(JSON.stringify(same.json.problems)), 'a revision on or before the latest salary is refused (correct that one instead)');

  // LOP: two approved days of an unpaid type in July; a pending one and an approved paid one do not count.
  const lwp = await ins("INSERT INTO hrms_leave_types (company_id, code, name, unit, is_paid, status) VALUES (?, ?, ?, 'DAY', 0, 'ACTIVE')", [COMPANY, `${TAG}LWP`, `${TAG} LWP`]);
  const paidType = await ins("INSERT INTO hrms_leave_types (company_id, code, name, unit, is_paid, status) VALUES (?, ?, ?, 'DAY', 1, 'ACTIVE')", [COMPANY, `${TAG}CL`, `${TAG} CL`]);
  const leave = (e, type, from, to, status, days) => db.query('INSERT INTO hrms_leave_requests (company_id, employee_id, leave_type_id, from_date, to_date, quantity, status, days_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [COMPANY, e, type, from, to, days.length, status, JSON.stringify(days.map((d) => ({ date: d, counts: true, amount: 1 })))]);
  await leave(E.l, lwp, '2025-07-07', '2025-07-08', 'APPROVED', ['2025-07-07', '2025-07-08']);
  await leave(E.l, lwp, '2025-07-21', '2025-07-21', 'PENDING', ['2025-07-21']);
  await leave(E.l, paidType, '2025-07-22', '2025-07-22', 'APPROVED', ['2025-07-22']);

  const jul = (await must(U.HR, 'POST', '/payroll/runs', { month: '2025-07' })).run;
  ok(jul.status === 'DRAFT' && (await call(U.HR, 'POST', '/payroll/runs', { month: '2025-07' })).status === 409, 'a run for July 2025; a second one for the same month is refused');
  ok((await call(U.HR, 'POST', '/payroll/runs', { month: '2099-01' })).status === 422, 'a month that has not started is refused');
  await must(U.HR, 'POST', `/payroll/runs/${jul.id}/items`, { employeeId: E.a, componentId: C.BONUS.id, amount: 5000, note: 'Diwali' });
  await must(U.HR, 'PUT', `/payroll/runs/${jul.id}/people/${E.a}/tds`, { amount: 2500, reason: 'Test: TDS set by hand' });
  ok((await call(U.HR, 'POST', `/payroll/runs/${jul.id}/items`, { employeeId: E.a, componentId: C.PF_EE.id, amount: 1 })).status === 422, 'PF cannot be a one-time item (the run works it out)');
  const calc = await must(U.HR, 'POST', `/payroll/runs/${jul.id}/calculate`);
  const P = Object.fromEntries(calc.people.map((p) => [p.employee.id, p]));
  const linesOf = async (e) => (await must(U.HR, 'GET', `/payroll/runs/${jul.id}/people/${P[e].id}`)).lines;
  const amt = (lines) => Object.fromEntries(lines.map((l) => [l.code, l.amount]));
  ok(calc.run.status === 'CALCULATED' && calc.people.filter((p) => p.employee.code.startsWith(TAG)).length === 5, 'calculated: our five people are in it (the one without a salary too, to say why)');
  const A1 = amt(await linesOf(E.a));
  ok(P[E.a].gross === 53200 && A1.BONUS === 5000 && A1.PF_EE === 1800 && A1.PT === 200 && A1.TDS === 2500 && P[E.a].net === 48700 && P[E.a].tds === 2500,
    'A, ₹6,00,000, July in full: gross 48,200 + bonus 5,000 = 53,200; PF 1,800, PT 200, TDS 2,500; net 48,700', JSON.stringify({ ...A1, net: P[E.a].net }));
  const B1 = amt(await linesOf(E.b));
  ok(P[E.b].employedDays === 16 && B1.BASIC === 3097 && B1.HRA === 1548 && B1.CONVEYANCE === 826 && B1.MEDICAL === 645 && B1.SPECIAL === 1254 && P[E.b].gross === 7370
    && B1.PF_EE === 372 && B1.ESI_EE === 56 && B1.ESI_ER === 240 && !B1.PT && P[E.b].net === 6942 && P[E.b].esiCovered && P[E.b].warnings.some((w) => w.code === 'JOINED_MID'),
  'B, ₹1,80,000, joined 16 Jul: 16/31 days → gross 7,370; PF 371.64 → 372; ESI covered 55.28 → 56 and 239.53 → 240; no PT; net 6,942', JSON.stringify({ ...B1, net: P[E.b].net }));
  const L1 = amt(await linesOf(E.l));
  ok(P[E.l].lopDays === 2 && P[E.l].payableDays === 29 && P[E.l].gross === 45091 && L1.BASIC === 18710 && P[E.l].net === 43091 && P[E.l].warnings.some((w) => w.code === 'LOP'),
    'L, 2 approved LOP days (a pending one and a paid leave do not count): 29/31 → gross 45,091; net 43,091', JSON.stringify({ lop: P[E.l].lopDays, gross: P[E.l].gross, net: P[E.l].net }));
  ok(P[E.x].employedDays === 10 && P[E.x].gross === 15549 && P[E.x].net === 15549 - 774 - 150 && P[E.x].warnings.some((w) => w.code === 'LEFT_MID'), 'X, left on 10 Jul: 10/31 → gross 15,549; PF 774; PT 150', JSON.stringify(P[E.x]));
  ok(!P[E.n].included && P[E.n].warnings[0].code === 'NO_SALARY', 'N has no salary: in the run, not paid, and said why');
  ok(P[E.a].warnings.every((w) => !['NO_BANK', 'NO_PAN'].includes(w.code)) && P[E.b].warnings.some((w) => w.code === 'NO_BANK') && P[E.b].warnings.some((w) => w.code === 'NO_PAN'), 'warnings: no bank, no PAN — only where they are missing');
  ok(calc.run.totals.statutoryFrom.PF === '2025-04-01' && calc.run.totals.unverifiedSettings.includes('LWF'), 'the run says which statutory rows it used, and that LWF is unverified');

  // Lock: refused while something changed since the calculation.
  await new Promise((r) => { setTimeout(r, 1100); });
  await must(U.HR, 'POST', `/payroll/runs/${jul.id}/items`, { employeeId: E.l, componentId: C.OVERTIME.id, amount: 1200 });
  const stale = await call(U.HR, 'POST', `/payroll/runs/${jul.id}/lock`);
  ok(stale.status === 409 && stale.json.code === 'STALE' && /one-time item/.test(stale.json.message), 'lock is refused when an item changed after the calculation: calculate again', stale.json?.message);
  await must(U.HR, 'POST', `/payroll/runs/${jul.id}/calculate`);
  const locked = await must(U.HR, 'POST', `/payroll/runs/${jul.id}/lock`);
  ok(locked.run.status === 'LOCKED' && locked.can.release && !locked.can.calculate, 'locked');

  // A LOCKED run is never changed: every write is refused and nothing moves.
  const snap = async () => JSON.stringify(await q('SELECT id, amount, deleted_at FROM hrms_pay_run_lines WHERE company_id = ? AND run_id = ? ORDER BY id', [COMPANY, jul.id]))
    + JSON.stringify(await q('SELECT id, net_pay, deleted_at FROM hrms_pay_run_people WHERE company_id = ? AND run_id = ? ORDER BY id', [COMPANY, jul.id]))
    + JSON.stringify(await q('SELECT id, amount, deleted_at FROM hrms_pay_items WHERE company_id = ? AND run_id = ? ORDER BY id', [COMPANY, jul.id]));
  const frozen = await snap();
  const item = (await must(U.HR, 'GET', `/payroll/runs/${jul.id}/items`)).items[0];
  const tries = [
    await call(U.HR, 'POST', `/payroll/runs/${jul.id}/calculate`), await call(U.HR, 'POST', `/payroll/runs/${jul.id}/items`, { employeeId: E.a, componentId: C.BONUS.id, amount: 1 }),
    await call(U.HR, 'PUT', `/payroll/items/${item.id}`, { amount: 1 }), await call(U.HR, 'DELETE', `/payroll/items/${item.id}`), await call(U.HR, 'PUT', `/payroll/runs/${jul.id}/people/${E.a}/tds`, { amount: 9 }),
    await call(U.HR, 'DELETE', `/payroll/runs/${jul.id}`), await call(U.HR, 'PUT', `/payroll/salaries/${sA.json.salary.id}`, { annualCtc: 1 }),
  ];
  const pfRow = (await must(U.HR, 'GET', '/payroll/statutory')).settings.find((s) => s.kind === 'PF' && s.effectiveFrom === '2025-04-01');
  tries.push(await call(U.HR, 'PUT', `/payroll/statutory/${pfRow.id}`, { settings: { ...pfRow.settings, wageCeiling: 1 } }));
  ok(tries.every((t) => t.status === 409 || t.status === 422) && tries.slice(0, 6).every((t) => t.json.code === 'WRONG_STATUS') && tries[6].json.code === 'PAID_ON' && /add a new row/.test(tries[7].json.problems?.[0] ?? ''),
    'a locked run: calculate, items, TDS, remove — refused; the salary it paid on is not corrected; the statutory values it used are not changed', JSON.stringify(tries.map((t) => `${t.status} ${t.json?.code}`)));
  ok((await snap()) === frozen, 'and after all that, the locked run is exactly as it was (lines, people, items)');
  const verifiedOnly = await call(U.HR, 'PUT', `/payroll/statutory/${pfRow.id}`, { verification: 'VERIFIED', note: 'Checked by the CA' });
  ok(verifiedOnly.status === 200, 'its source and “checked” can still be changed');

  const bank = await must(U.HR, 'GET', `/payroll/runs/${jul.id}/bank-file`);
  const csvText = Buffer.from(bank.contentBase64, 'base64').toString('utf8');
  ok(bank.rows === 1 && csvText.includes('123456789012,SBIN0001234,48700.00') && bank.skipped.some((s) => s.code === `${TAG}B` && /no bank/.test(s.why)), 'the bank file: A at 48,700 with the full account; the rest skipped with why');
  const rel = await must(U.HR, 'POST', `/payroll/runs/${jul.id}/release`);
  const ours = (await must(U.HR, 'GET', `/payroll/runs/${jul.id}/payslips`)).payslips.filter((p) => p.employee.code.startsWith(TAG));
  ok(rel.run.status === 'RELEASED' && ours.length === 4 && ours.every((p) => p.status === 'RELEASED'), 'released: a payslip for each of the four paid (not for N)');
  const slipA = ours.find((p) => p.employee.id === E.a);
  const pdf = await must(U.HR, 'GET', `/payroll/payslips/${slipA.id}/file`);
  const bytes = Buffer.from(pdf.contentBase64, 'base64');
  ok(pdf.mimeType === 'application/pdf' && bytes.subarray(0, 5).toString() === '%PDF-' && bytes.length > 2000, 'the payslip PDF', `${bytes.length} bytes`);
  const snapRow = await one('SELECT snapshot_json FROM hrms_pay_payslips WHERE id = ?', [slipA.id]);
  const S = typeof snapRow.snapshot_json === 'string' ? JSON.parse(snapRow.snapshot_json) : snapRow.snapshot_json;
  ok(S.totals.net === 48700 && S.employee.pan === 'XXXXXX234F' && S.employee.bankAccount === 'XXXXXXXX9012' && S.tds === 2500 && S.ytd.net === 48700 && S.days.payable === 31,
    'the snapshot: net 48,700; PAN and bank masked; TDS of the month; year to date', JSON.stringify({ pan: S.employee.pan, bank: S.employee.bankAccount, ytd: S.ytd }));
  const paid = await must(U.HR, 'POST', `/payroll/runs/${jul.id}/paid`, { note: 'NEFT batch 17' });
  ok(paid.run.status === 'PAID' && paid.run.paidNote === 'NEFT batch 17', 'marked paid');
  const notOwner = await call(U.HR, 'POST', `/payroll/runs/${jul.id}/reopen`, { reason: 'A mistake in a bonus' });
  const noReason = await call(O, 'POST', `/payroll/runs/${jul.id}/reopen`, { reason: '' });
  ok(notOwner.status === 409 && notOwner.json.code === 'OWNER_ONLY' && noReason.status === 422, 're-open: refused for HR (the Owner only) and for the Owner without a reason');
  const reopened = await must(O, 'POST', `/payroll/runs/${jul.id}/reopen`, { reason: 'Bonus of A was wrong' });
  const withdrawn = await q("SELECT status FROM hrms_pay_payslips WHERE company_id = ? AND run_id = ? AND employee_id IN (?)", [COMPANY, jul.id, [E.a, E.b, E.l, E.x]]);
  const audited = await one("SELECT after_json FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_pay_runs' AND entity_id = ? ORDER BY id DESC LIMIT 1", [COMPANY, jul.id]);
  ok(reopened.run.status === 'CALCULATED' && reopened.run.reopenCount === 1 && withdrawn.every((w) => w.status === 'WITHDRAWN') && /Bonus of A was wrong/.test(JSON.stringify(audited.after_json)),
    'the Owner re-opens with a reason: back to calculated, payslips withdrawn, the reason in the audit');
  await must(U.HR, 'PUT', `/payroll/items/${item.id}`, { amount: 6000 });
  await must(U.HR, 'POST', `/payroll/runs/${jul.id}/calculate`);
  await must(U.HR, 'POST', `/payroll/runs/${jul.id}/lock`);
  await must(U.HR, 'POST', `/payroll/runs/${jul.id}/release`);
  const v2 = await one("SELECT version, net_pay FROM hrms_pay_payslips WHERE company_id = ? AND run_id = ? AND employee_id = ? AND status = 'RELEASED'", [COMPANY, jul.id, E.a]);
  ok(v2 && Number(v2.version) === 2 && Number(v2.net_pay) === 49700, 'released again: version 2 of the payslip, with the corrected bonus (net 49,700)');

  // Arrears: A's raise to ₹7,20,000, dated back to 1 July — after July was paid.
  const raise = await salary(E.a, 720000, '2025-07-01', { reason: 'Annual revision' });
  ok(raise.status === 200 && raise.json.arrearsFor.includes('2025-07') && /arrears/.test(raise.json.note), 'a revision dated back over July is accepted, and says the next run pays the arrears', JSON.stringify(raise.json));
  const aug = (await must(U.HR, 'POST', '/payroll/runs', { month: '2025-08' })).run;
  const augCalc = await must(U.HR, 'POST', `/payroll/runs/${aug.id}/calculate`);
  const PA = augCalc.people.find((p) => p.employee.id === E.a);
  const augLines = (await must(U.HR, 'GET', `/payroll/runs/${aug.id}/people/${PA.id}`)).lines;
  const arrear = augLines.find((l) => l.code === 'ARREARS');
  ok(arrear && arrear.amount === 10000 && arrear.forMonth === '2025-07' && PA.gross === 68200 && PA.net === 66200 && PA.warnings.some((w) => w.code === 'ARREARS'),
    'August: arrears for July = 58,200 due − 48,200 paid = 10,000; gross 58,200 + 10,000 = 68,200; PF 1,800 (Basic already over the ceiling), PT 200; net 66,200', JSON.stringify({ arrear, gross: PA.gross, net: PA.net }));
  const others = augCalc.people.filter((p) => [E.b, E.l].includes(p.employee.id));
  ok(others.every((p) => !p.warnings.some((w) => w.code === 'ARREARS')), 'nobody else has arrears: their salaries did not change');
  ok((await call(U.HR, 'PUT', `/payroll/salaries/${sA.json.salary.id}`, { annualCtc: 610000 })).json?.code === 'PAID_ON', 'the old salary of A stays as paid: corrected only by a revision');

  /* ══ 7. rights and self-only ══════════════════════════════════════════ */
  section('[7] Rights and self-only');
  {
    const st = async (who, method, url, body) => (await call(who, method, url, body)).status;
    ok(await st(U.HRX, 'POST', `/payroll/runs/${aug.id}/calculate`) === 200 && await st(U.HRX, 'DELETE', `/payroll/runs/${aug.id}`) === 403 && await st(U.HRX, 'GET', '/payroll/salaries') === 200,
      'HR executive: payroll view and edit with pay view — calculates, reads salaries; cannot remove a run');
    ok(await st(U.DH, 'GET', '/payroll/components') === 403 && await st(U.DH, 'GET', '/payroll/runs') === 403, 'Department head: no payroll');
    const clerk = await call(U.CLERK, 'GET', '/payroll/runs');
    ok(await st(U.CLERK, 'GET', '/payroll/components') === 200 && await st(U.CLERK, 'GET', '/payroll/structures') === 200 && clerk.status === 403 && clerk.json.code === 'PAY_HIDDEN'
      && await st(U.CLERK, 'GET', `/payroll/salaries/${E.a}`) === 403 && await st(U.CLERK, 'POST', `/payroll/runs/${aug.id}/calculate`) === 403,
    'payroll view without pay view: components and structures yes; runs, salaries and calculating no (PAY_HIDDEN)', JSON.stringify(clerk.json));
    ok(await st(U.A, 'GET', '/payroll/components') === 403 && await st(U.A, 'GET', `/payroll/salaries/${E.a}`) === 403, 'an employee login: no HR payroll route, not even for their own salary');
    const auditBefore = Number((await one("SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_pay_salary_read'", [COMPANY])).n);
    const mine = await must(U.A, 'GET', '/user/me/pay');
    const auditMine = Number((await one("SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_pay_salary_read'", [COMPANY])).n);
    ok(mine.salary.annualCtc === 720000 && mine.salary.monthlyCtc === 60000 && mine.salary.effectiveFrom === '2025-07-01' && mine.salary.lines.length === 6 && mine.history.length === 2 && mine.employee.name.includes(TAG),
      'My pay: my CTC a year and a month, from when, the components, the history', JSON.stringify(mine.salary).slice(0, 200));
    ok(auditMine === auditBefore, 'reading my own pay writes no audit row');
    await must(U.HR, 'GET', `/payroll/salaries/${E.b}`);
    const row = await one("SELECT entity_id, actor_user_id, action FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_pay_salary_read' ORDER BY id DESC LIMIT 1", [COMPANY]);
    ok(row.entity_id === E.b && row.actor_user_id === U.HR.id && row.action === 'READ', 'HR reading B’s salary writes a READ row naming B and the reader');
    await must(U.HR, 'GET', '/payroll/salaries');
    const listRow = await one("SELECT entity_id, after_json FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_pay_salary_read' ORDER BY id DESC LIMIT 1", [COMPANY]);
    const listed = typeof listRow.after_json === 'string' ? JSON.parse(listRow.after_json) : listRow.after_json;
    ok(listRow.entity_id === 0 && listed.employeeIds.includes(E.a) && listed.employeeIds.includes(E.b), 'the salaries list writes one READ row naming everybody on it');
    const slips = await must(U.A, 'GET', '/user/me/payslips');
    ok(slips.payslips.length === 1 && slips.payslips[0].month === '2025-07' && slips.payslips[0].net === 49700, 'My payslips: the released July payslip (the withdrawn one is not shown)');
    const file = await call(U.A, 'GET', `/user/me/payslips/${slips.payslips[0].id}/file`);
    ok(file.status === 200 && Buffer.from(file.json.contentBase64, 'base64').subarray(0, 5).toString() === '%PDF-', 'and its PDF');
    const theirs = await one("SELECT id FROM hrms_pay_payslips WHERE company_id = ? AND employee_id = ? AND status = 'RELEASED'", [COMPANY, E.b]);
    ok((await call(U.A, 'GET', `/user/me/payslips/${theirs.id}/file`)).status === 404, 'another person’s payslip reads as not found');
    ok((await call(U.B, 'GET', '/user/me/pay')).json.salary.annualCtc === 180000, 'B sees B’s salary, from the login — no id is taken from the client');
    const noLink = await call(U.HR, 'GET', '/user/me/pay');
    ok(noLink.status === 403 && noLink.json.code === 'NOT_LINKED', 'a login with no employee has no pay of its own');
  }

  /* ══ 8. Excel ══════════════════════════════════════════════════════════ */
  section('[8] Excel round trips');
  {
    const ents = (await must(U.HR, 'GET', '/excel/entities')).filter((e) => e.entity.startsWith('pay-'));
    const clerkEnts = (await must(U.CLERK, 'GET', '/excel/entities')).filter((e) => e.entity.startsWith('pay-'));
    ok(ents.length === 2 && ents.every((e) => e.canDownload && e.canUpload) && clerkEnts.every((e) => !e.canDownload), 'two payroll files; without pay view neither opens');
    const dl = await must(U.HR, 'GET', '/excel/pay-salaries/workbook');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(dl.contentBase64, 'base64'));
    const ws = wb.getWorksheet('Data');
    const header = ws.getRow(1).values;
    const col = (h) => header.indexOf(h);
    let rowB = null; let rowN = null; let rowL = null;
    ws.eachRow((r, n) => { if (r.getCell(col('Employee code')).value === `${TAG}B`) rowB = n; if (r.getCell(col('Employee code')).value === `${TAG}N`) rowN = n; if (r.getCell(col('Employee code')).value === `${TAG}L`) rowL = n; });
    ok(rowB && Number(ws.getCell(rowB, col('CTC a year')).value) === 180000 && ws.getCell(rowB, col('Structure')).value === 'Staff standard', 'the download: one row a person, with today’s salary');
    ws.getCell(rowB, col('CTC a year')).value = 240000; ws.getCell(rowB, col('Effective from')).value = new Date(Date.UTC(2025, 8, 1)); ws.getCell(rowB, col('Reason')).value = 'Promotion';
    ws.getCell(rowN, col('CTC a year')).value = 300000; ws.getCell(rowN, col('Structure')).value = 'Staff standard'; ws.getCell(rowN, col('Effective from')).value = new Date(Date.UTC(2025, 3, 1));
    ws.getCell(rowL, col('CTC a year')).value = 650000; ws.getCell(rowL, col('Effective from')).value = new Date(Date.UTC(2025, 0, 1));
    const file = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
    const pv = await must(U.HR, 'POST', '/excel/pay-salaries/preview', { fileName: 's.xlsx', contentBase64: file });
    const prob = pv.rows.find((r) => r.action === 'PROBLEM');
    ok(pv.summary.change === 2 && pv.summary.problems === 1 && /A revision starts after it/.test(prob.problems[0]), 'preview: B revised, N given a salary; L dated before its latest salary is a problem', JSON.stringify(pv.summary));
    const ap = await must(U.HR, 'POST', '/excel/pay-salaries/apply', { fileName: 's.xlsx', contentBase64: file, expect: { add: 0, change: 2 }, skipProblemRows: true });
    const bNow = await must(U.HR, 'GET', `/payroll/salaries/${E.b}`);
    const nNow = await must(U.HR, 'GET', `/payroll/salaries/${E.n}`);
    ok(ap.changed === 2 && bNow.history.length === 2 && bNow.history[0].annualCtc === 240000 && bNow.history[0].effectiveFrom === '2025-09-01' && bNow.history[1].effectiveTo === '2025-08-31' && nNow.history.length === 1,
      'applied: B’s revision from 1 Sep (the old one ends 31 Aug); N has a salary', JSON.stringify(bNow.history.map((h) => [h.effectiveFrom, h.effectiveTo, h.annualCtc])));
    // A correction: same day, a salary no locked run paid on.
    const dl2 = await must(U.HR, 'GET', '/excel/pay-salaries/workbook');
    const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(Buffer.from(dl2.contentBase64, 'base64'));
    const ws2 = wb2.getWorksheet('Data');
    let rN = null; ws2.eachRow((r, n) => { if (r.getCell(col('Employee code')).value === `${TAG}N`) rN = n; });
    ws2.getCell(rN, col('CTC a year')).value = 310000;
    const f2 = Buffer.from(await wb2.xlsx.writeBuffer()).toString('base64');
    await must(U.HR, 'POST', '/excel/pay-salaries/apply', { fileName: 's2.xlsx', contentBase64: f2, expect: { add: 0, change: 1 } });
    const n2 = await must(U.HR, 'GET', `/payroll/salaries/${E.n}`);
    ok(n2.history.length === 1 && n2.history[0].annualCtc === 310000, 'the same Effective from: a correction in place, not a new revision');

    const items = await must(U.HR, 'GET', `/excel/pay-items/workbook?runId=${aug.id}`);
    const wi = new ExcelJS.Workbook(); await wi.xlsx.load(Buffer.from(items.contentBase64, 'base64'));
    const wsi = wi.getWorksheet('Data');
    const hi = wsi.getRow(1).values.map((v) => (typeof v === 'string' ? v.replace(/\s*★\s*$/, '').trim() : v));
    const last = wsi.lastRow.number + 1;
    wsi.getCell(last, hi.indexOf('Employee')).value = `${TAG}B — ${TAG} Person B`;
    wsi.getCell(last, hi.indexOf('Component')).value = 'BONUS — Bonus';
    wsi.getCell(last, hi.indexOf('Amount')).value = 1000;
    wsi.getCell(last, hi.indexOf('Note')).value = 'Excel bonus';
    const fi = Buffer.from(await wi.xlsx.writeBuffer()).toString('base64');
    const pvi = await must(U.HR, 'POST', `/excel/pay-items/preview?runId=${aug.id}`, { fileName: 'i.xlsx', contentBase64: fi });
    const api = await must(U.HR, 'POST', `/excel/pay-items/apply?runId=${aug.id}`, { fileName: 'i.xlsx', contentBase64: fi, expect: { add: 1, change: 0 } });
    const got = (await must(U.HR, 'GET', `/payroll/runs/${aug.id}/items`)).items.find((i) => i.note === 'Excel bonus');
    ok(pvi.summary.add === 1 && api.added === 1 && got?.amount === 1000 && got.employee.id === E.b, 'one-time items: a new row is a new item of the run', JSON.stringify(pvi.summary));
    const julFile = await call(U.HR, 'POST', `/excel/pay-items/preview?runId=${jul.id}`, { fileName: 'i.xlsx', contentBase64: fi });
    ok(julFile.status === 200 && /released: its items cannot be changed/.test(julFile.json.fileProblems.join(' ')), 'the items file of a released run is refused whole');
  }

  /* ══ 10. the review of 2026-10-20: nothing is paid twice ═══════════════ */
  section('[10] Nothing paid twice (the review of 2026-10-20)');
  {
    const csvOf = (f) => Buffer.from(f?.contentBase64 ?? '', 'base64').toString('utf8');
    // A step that moves the story on: a refusal is a failure, said, and the section goes on (each check says what it needs).
    const go = async (who, method, url, body) => {
      const r = await call(who, method, url, body);
      if (r.status !== 200) ok(false, `step ${method} ${url}`, `${r.status} ${r.json?.message ?? ''}`);
      return r.json ?? {};
    };
    const payments = async (runId, e) => q("SELECT kind, amount FROM hrms_pay_payments WHERE company_id = ? AND run_id = ? AND employee_id = ? AND deleted_at IS NULL ORDER BY id", [COMPANY, runId, e]);
    const lastRead = async () => {
      const r = await one("SELECT after_json FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_pay_salary_read' ORDER BY id DESC LIMIT 1", [COMPANY]);
      return typeof r?.after_json === 'string' ? JSON.parse(r.after_json) : r?.after_json ?? {};
    };

    // Review 2c, the reviewer's case: July was paid (A 48,700), re-opened, the bonus corrected, locked and released again.
    const julBank = await go(U.HR, 'GET', `/payroll/runs/${jul.id}/bank-file`);
    const julCsv = csvOf(julBank);
    ok(julBank.difference && julBank.rows === 1 && julBank.total === 1000 && julCsv.includes('123456789012,SBIN0001234,1000.00') && !julCsv.includes('49700.00') && /difference/.test(julBank.fileName),
      'review 2c: after a re-open the bank file pays A only the difference (49,700 − 48,700 paid = 1,000), never the full net again', julCsv.split('\r\n')[1]);
    await go(U.HR, 'POST', `/payroll/runs/${jul.id}/paid`, { note: 'The difference of the bonus' });
    const paidA = await payments(jul.id, E.a);
    const julRow = await one('SELECT ever_paid, reopen_count FROM hrms_pay_runs WHERE id = ?', [jul.id]);
    ok(paidA.map((p) => `${p.kind} ${Number(p.amount)}`).join(', ') === 'PAID 48700, PAID 1000' && Number(julRow.ever_paid) === 1,
      'review 2c / 2a: what was paid is kept per person per run (A: 48,700, then 1,000); the run is marked ever paid', JSON.stringify(paidA));

    // Review 1, the reviewer's case (July paid, A's raise back-dated to July; August pays July's arrears; September must not pay them again).
    const sep = (await go(U.HR, 'POST', '/payroll/runs', { month: '2025-09' }))?.run ?? {};
    const sepEarly = await call(U.HR, 'POST', `/payroll/runs/${sep.id}/calculate`);
    ok(sepEarly.status === 409 && sepEarly.json.code === 'EARLIER_OPEN' && /Lock August 2025 first\./.test(sepEarly.json.message),
      'review 1: September is not calculated while August (which pays July’s arrears) is open — “Lock August 2025 first.”', sepEarly.json?.message);
    const gap = await call(U.HR, 'POST', '/payroll/runs', { month: '2025-11' });
    ok(gap.status === 409 && gap.json.code === 'MONTH_MISSING' && /Create October 2025 first/.test(gap.json.message), 'review 1: November cannot be made while October has no run — months in order', gap.json?.message);
    if (gap.status === 200) await call(O, 'DELETE', `/payroll/runs/${gap.json.run.id}`); // (made all the same: out of the way)
    await go(U.HR, 'POST', `/payroll/runs/${aug.id}/calculate`);
    await go(U.HR, 'POST', `/payroll/runs/${aug.id}/lock`);
    const sepCalc = await go(U.HR, 'POST', `/payroll/runs/${sep.id}/calculate`);
    const sepA = sepCalc.people?.find((p) => p.employee.id === E.a);
    const sepALines = (await go(U.HR, 'GET', `/payroll/runs/${sep.id}/people/${sepA?.id}`))?.lines ?? [];
    ok(!sepALines.some((l) => l.code === 'ARREARS') && !sepA?.warnings.some((w) => w.code === 'ARREARS'), 'review 1: with August locked, September does not pay July’s arrears a second time', JSON.stringify(sepALines.map((l) => l.code)));
    await go(O, 'POST', `/payroll/runs/${aug.id}/reopen`, { reason: 'Review test: August again' });
    const sepLockEarly = await call(U.HR, 'POST', `/payroll/runs/${sep.id}/lock`);
    ok(sepLockEarly.status === 409 && sepLockEarly.json.code === 'EARLIER_OPEN' && /Lock August 2025 first/.test(sepLockEarly.json.message), 'review 1: nor is September locked while August is re-opened', sepLockEarly.json?.message);
    await go(U.HR, 'POST', `/payroll/runs/${aug.id}/calculate`);
    await go(U.HR, 'POST', `/payroll/runs/${aug.id}/lock`);
    const sepStale = await call(U.HR, 'POST', `/payroll/runs/${sep.id}/lock`);
    ok(sepStale.status === 409 && sepStale.json.code === 'STALE' && /earlier month/.test(sepStale.json.message), 'review 1: August locked again after September was calculated: September calculates again first', sepStale.json?.message);
    await go(U.HR, 'POST', `/payroll/runs/${sep.id}/calculate`);
    await go(U.HR, 'POST', `/payroll/runs/${sep.id}/lock`);

    // Review 2b, the reviewer's case: re-opening July would re-pay what August paid as July's arrears.
    const julRe = await call(O, 'POST', `/payroll/runs/${jul.id}/reopen`, { reason: 'Review test: a mistake in July' });
    ok(julRe.status === 409 && julRe.json.code === 'LATER_PAID_ARREARS' && /August 2025 payroll paid arrears for July 2025/.test(julRe.json.message) && /latest month backwards/.test(julRe.json.message),
      'review 2b: July is not re-opened while August (locked) paid arrears for it — the message names August', julRe.json?.message);

    // People for what follows: P (two revisions), Q (58 in October), I (inactive with no exit date).
    const P = await emp('P', '2024-04-01');
    const Q = await emp('Q', '2024-04-01');
    const I = await emp('I', '2024-04-01');
    await db.query("UPDATE hrms_employees SET date_of_birth = '1967-10-10' WHERE id = ?", [Q]);
    await db.query("UPDATE hrms_employees SET employment_status = 'INACTIVE' WHERE id = ?", [I]);
    for (const e of [P, Q, I]) ok((await salary(e, 360000, '2025-04-01')).status === 200, 'a salary of ₹3,60,000 from April 2025');

    // From the latest month backwards: September, August, then July.
    await go(O, 'POST', `/payroll/runs/${sep.id}/reopen`, { reason: 'Review test: September' });
    await go(O, 'POST', `/payroll/runs/${aug.id}/reopen`, { reason: 'Review test: August' });
    const julOpen = await call(O, 'POST', `/payroll/runs/${jul.id}/reopen`, { reason: 'Review test: July, after September and August' });
    ok(julOpen.status === 200 && julOpen.json?.run?.everPaid && julOpen.json?.can?.remove === true, 'review 2b: with September and August re-opened first, July re-opens (the Owner may remove it)');

    // Review 2c, a recovery: L's July now has a loan recovery of 2,000; A's July is at the new salary.
    await go(U.HR, 'POST', `/payroll/runs/${jul.id}/items`, { employeeId: E.l, componentId: C.LOAN.id, amount: 2000, note: 'Review test: loan' });
    await go(U.HR, 'POST', `/payroll/runs/${jul.id}/calculate`);
    await go(U.HR, 'POST', `/payroll/runs/${jul.id}/lock`);
    await go(U.HR, 'POST', `/payroll/runs/${jul.id}/release`);
    const julBank2 = await go(U.HR, 'GET', `/payroll/runs/${jul.id}/bank-file`);
    ok(julBank2.difference && julBank2.rows === 1 && csvOf(julBank2).includes('123456789012,SBIN0001234,10000.00') && julBank2.recover?.length === 1 && julBank2.recover?.[0]?.code === `${TAG}L` && julBank2.recover?.[0]?.amount === 2000
      && julBank2.skipped?.some((s) => s.code === `${TAG}L` && /recovered in the next run/.test(s.why)),
    'review 2c: July again — A gets only the difference (59,700 − 49,700 = 10,000); L, now due 2,000 less, is not in the file: recovered in the next run', JSON.stringify({ rows: julBank2.rows, total: julBank2.total, recover: julBank2.recover }));
    const julPaid = await go(U.HR, 'POST', `/payroll/runs/${jul.id}/paid`, {});
    const augItems = (await go(U.HR, 'GET', `/payroll/runs/${aug.id}/items`))?.items ?? [];
    const rec = augItems.find((i) => i.employee.id === E.l && i.recovers === '2025-07');
    ok(julPaid.payments?.recoveries.length === 1 && julPaid.payments?.recoveries[0].amount === 2000 && julPaid.payments?.recoveries[0].inMonth === '2025-08' && rec && rec.amount === 2000 && rec.code === 'OTHER_DED' && /July 2025 was re-opened/.test(rec.note),
      'review 2c: marked paid — the 2,000 becomes a one-time deduction in August (the next open run), made by the payroll and shown on both', JSON.stringify(julPaid.payments));
    const delRec = await call(U.HR, 'DELETE', `/payroll/items/${rec?.id}`);
    ok(delRec.status === 409 && delRec.json.code === 'RECOVERY', 'review 2c: the recovery cannot be removed by hand');
    const augCalc2 = await go(U.HR, 'POST', `/payroll/runs/${aug.id}/calculate`);
    const augA = augCalc2.people?.find((p) => p.employee.id === E.a);
    const augL = augCalc2.people?.find((p) => p.employee.id === E.l);
    const augALines = (await go(U.HR, 'GET', `/payroll/runs/${aug.id}/people/${augA?.id}`))?.lines ?? [];
    const augLLines = (await go(U.HR, 'GET', `/payroll/runs/${aug.id}/people/${augL?.id}`))?.lines ?? [];
    ok(!augALines.some((l) => l.code === 'ARREARS') && augLLines.some((l) => l.code === 'OTHER_DED' && l.amount === 2000),
      'review 2b/2c: July re-paid at the new salary, so August pays A no July arrears now; L’s August recovers the 2,000', JSON.stringify(augALines.map((l) => l.code)));
    await go(U.HR, 'POST', `/payroll/runs/${aug.id}/lock`);
    await go(U.HR, 'POST', `/payroll/runs/${sep.id}/calculate`);
    await go(U.HR, 'POST', `/payroll/runs/${sep.id}/lock`);

    // October: P's first revision (back to 1 Sep), and the lock's refusals.
    const oct = (await go(U.HR, 'POST', '/payroll/runs', { month: '2025-10' }))?.run ?? {};
    ok((await salary(P, 372000, '2025-09-01', { reason: 'Review: first revision' })).status === 200, 'P: a first revision, ₹3,72,000 from 1 September (paid at ₹3,60,000)');
    await go(U.HR, 'POST', `/payroll/runs/${oct.id}/items`, { employeeId: E.b, componentId: C.OTHER_DED.id, amount: 100000, note: 'Review test: too much' });
    let octCalc = await go(U.HR, 'POST', `/payroll/runs/${oct.id}/calculate`);
    const negLock = await call(U.HR, 'POST', `/payroll/runs/${oct.id}/lock`);
    ok(negLock.status === 409 && negLock.json.code === 'NEGATIVE_NET' && negLock.json?.message?.includes(`${TAG} Person B`), 'review 8: lock is refused while a person’s net pay is below zero (named)', negLock.json?.message);
    const unlock = async (r) => { if (r.status === 200) await call(O, 'POST', `/payroll/runs/${oct.id}/reopen`, { reason: 'Review test: locked all the same' }); };
    await unlock(negLock);
    const bigItem = ((await go(U.HR, 'GET', `/payroll/runs/${oct.id}/items`))?.items ?? []).find((i) => i.amount === 100000);
    const readItems = await lastRead();
    ok(/one-time items of payroll 2025-10/.test(readItems.what ?? '') && (readItems.employeeIds ?? [E.b]).includes(E.b), 'review 10: the list of a run’s one-time items is a read of pay: audited', JSON.stringify(readItems));
    await go(U.HR, 'DELETE', `/payroll/items/${bigItem?.id}`);
    await go(U.HR, 'POST', `/payroll/runs/${oct.id}/calculate`);
    await ident(E.b, 'BANK_ACCOUNT', '998877665544');
    const bankStale = await call(U.HR, 'POST', `/payroll/runs/${oct.id}/lock`);
    ok(bankStale.status === 409 && bankStale.json.code === 'STALE' && /bank account or IFSC/.test(bankStale.json.message), 'review 9: a bank account added in the second of the calculation makes the run stale (the bank file would use the old one)', bankStale.json?.message);
    await unlock(bankStale);
    await go(U.HR, 'POST', `/payroll/runs/${oct.id}/calculate`);
    await go(U.HR, 'PUT', '/payroll/settings', { stateCode: 'TG', narration: 'Salary review' });
    const setStale = await call(U.HR, 'POST', `/payroll/runs/${oct.id}/lock`);
    ok(setStale.status === 409 && /payroll settings/.test(setStale.json.message), 'review 9: the payroll settings (the state) changed: stale', setStale.json?.message);
    await unlock(setStale);
    await go(U.HR, 'POST', `/payroll/runs/${oct.id}/calculate`);
    await go(U.HR, 'POST', `/payroll/runs/${oct.id}/items`, { employeeId: E.b, componentId: C.BONUS.id, amount: 100, note: 'Review test: same second' });
    const sameSecond = await call(U.HR, 'POST', `/payroll/runs/${oct.id}/lock`);
    ok(sameSecond.status === 409 && /one-time item/.test(sameSecond.json.message), 'review 9: an item added in the very second of the calculation is seen (>=, not >)', sameSecond.json?.message);
    await unlock(sameSecond);
    octCalc = await go(U.HR, 'POST', `/payroll/runs/${oct.id}/calculate`);
    const pOct = octCalc.people?.find((p) => p.employee.id === P);
    const pSepArrears = await one("SELECT amount, pf_wage, esi_wage FROM hrms_pay_run_lines WHERE company_id = ? AND run_id = ? AND employee_id = ? AND source = 'ARREARS' AND for_month = '2025-09' AND deleted_at IS NULL", [COMPANY, oct.id, P]);
    ok(pSepArrears && Number(pSepArrears.pf_wage) === 400 && Number(pSepArrears.amount) === 952, 'review 4: October pays P’s September arrears (952) and keeps their PF wage on the line (Basic 12,400 − 12,000 = 400)', JSON.stringify(pSepArrears));
    const qOct = octCalc.people?.find((p) => p.employee.id === Q);
    const iOct = octCalc.people?.find((p) => p.employee.id === I);
    ok(qOct?.warnings.some((w) => w.code === 'EPS_58' && /Turns 58 on 10 Oct/.test(w.text)) && iOct && !iOct.included && iOct.warnings.some((w) => w.code === 'INACTIVE'),
      'needs check: Q turns 58 in October (said); I is inactive with no exit date — not paid, and said why', JSON.stringify({ q: qOct?.warnings, i: iOct?.warnings }));
    ok(pOct?.included, 'P is in October');
    await go(U.HR, 'POST', `/payroll/runs/${oct.id}/lock`);

    // Review 4, the reviewer's case: a second back-dated revision of a month already paid arrears.
    ok((await salary(P, 384000, '2025-09-16', { reason: 'Review: second revision' })).status === 200, 'P: a second revision, ₹3,84,000 from 16 September');
    const nov = (await go(U.HR, 'POST', '/payroll/runs', { month: '2025-11' }))?.run ?? {};
    const looked = [];
    spy = (sql) => { if (/FROM hrms_pay_run_lines l/.test(sql) && /'STRUCTURE','ARREARS'/.test(sql)) looked.push(sql); };
    const novCalc = await go(U.HR, 'POST', `/payroll/runs/${nov.id}/calculate`);
    spy = null;
    ok(looked.length === 1 && !/SELECT id FROM hrms_pay_runs/.test(looked[0]), 'review 5: the arrears look-back reads the lines of its window’s runs only, once', looked[0]?.slice(0, 160));
    const pNov = novCalc.people?.find((p) => p.employee.id === P);
    const pNovLines = (await go(U.HR, 'GET', `/payroll/runs/${nov.id}/people/${pNov?.id}`))?.lines ?? [];
    const pf = pNovLines.find((l) => l.code === 'PF_EE');
    const arrearsMonths = pNovLines.filter((l) => l.code === 'ARREARS').map((l) => l.forMonth).sort().join(',');
    // November's own Basic 12,800; September's new arrears on PF wage 12,600 − (12,000 paid + 400 already paid as arrears) = 200; October's 12,800 − 12,400 = 400.
    ok(arrearsMonths === '2025-09,2025-10' && pf?.amount === 1608 && /incl\. 600 of arrears/.test(pf.basis),
      'review 4: November charges PF on 12,800 + 200 + 400 = 13,400 → 1,608 (not 1,656: September’s first arrears are not charged again)', JSON.stringify({ arrearsMonths, pf }));
    const qNov = novCalc.people?.find((p) => p.employee.id === Q);
    const qEr = ((await go(U.HR, 'GET', `/payroll/runs/${nov.id}/people/${qNov?.id}`))?.lines ?? []).find((l) => l.code === 'PF_ER');
    ok(qEr && qEr.amount === 1440 && /EPS 0 \+ EPF 1,440/.test(qEr.basis), 'needs check: Q past 58 in November — no EPS, the employer’s 1,440 all EPF', qEr?.basis);

    // Review 10: the payslips of a run are a read of pay too.
    await go(U.HR, 'GET', `/payroll/runs/${jul.id}/payslips`);
    const readSlips = await lastRead();
    ok(/payslips of payroll 2025-07/.test(readSlips.what ?? ''), 'review 10: the list of a run’s payslips is audited', JSON.stringify(readSlips));

    // Review 3: a department-scoped login with payroll and pay view does not download everybody's pay.
    const scopedRole = await ins('INSERT INTO roles (name, company_id) VALUES (?, ?)', [`${TAG} Scoped payroll`, COMPANY]);
    await db.query("INSERT INTO hrms_access_roles (company_id, role_id, label, scope) VALUES (?, ?, ?, 'DEPARTMENT')", [COMPANY, scopedRole, `${TAG} Scoped payroll`]);
    await setRoleTags(db, { companyId: COMPANY, appId: app.id, roleId: scopedRole, tags: [areaTag('payroll', 'view'), areaTag('payroll', 'upload'), 'cf_hrms_pay_view'], catalog });
    const SC = await login('Scoped payroll', scopedRole);
    forgetAccess();
    const scSal = await call(SC, 'GET', '/excel/pay-salaries/workbook');
    const scItems = await call(SC, 'GET', `/excel/pay-items/workbook?runId=${nov.id}`);
    const scEnts = (await go(SC, 'GET', '/excel/entities')).filter((e) => e.entity.startsWith('pay-'));
    ok(scSal.status === 403 && scSal.json.code === 'OUT_OF_SCOPE' && scItems.status === 403 && scEnts.length === 2 && scEnts.every((e) => !e.canDownload && !e.canUpload),
      'review 3: a login scoped to its department cannot download the salaries or the pay items workbook (and the list says so)', JSON.stringify({ s: scSal.status, i: scItems.status, scEnts }));

    // Review 2a, the reviewer's case: November paid, re-opened — HR (with payroll remove) must not remove it and make the month again.
    for (const step of ['lock', 'release', 'paid']) await go(U.HR, 'POST', `/payroll/runs/${nov.id}/${step}`, {});
    const octRe = await call(O, 'POST', `/payroll/runs/${oct.id}/reopen`, { reason: 'Review test: October' });
    ok(octRe.status === 409 && /November 2025 payroll paid arrears for October 2025/.test(octRe.json?.message ?? ''), 'review 2b: October is not re-opened while November (paid) paid its arrears (P)', octRe.json?.message);
    await go(O, 'POST', `/payroll/runs/${nov.id}/reopen`, { reason: 'Review test: November' });
    const delNov = await call(U.HR, 'DELETE', `/payroll/runs/${nov.id}`);
    const hrView = await go(U.HR, 'GET', `/payroll/runs/${nov.id}`);
    const novRow = await one('SELECT ever_paid, reopen_count, deleted_at FROM hrms_pay_runs WHERE id = ?', [nov.id]);
    ok(delNov.status === 409 && delNov.json.code === 'OWNER_ONLY' && /paid once/.test(delNov.json.message) && hrView.can?.remove === false && Number(novRow.ever_paid) === 1 && !novRow.deleted_at,
      'review 2a: a run once paid and re-opened is not removed by HR — the Owner only (and the screen does not offer it); ever_paid is kept through the re-open', delNov.json?.message);
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

section('[9] Nothing is left behind');
{
  const after = await worldCount();
  const moved = Object.keys(before).filter((k) => after[k] !== before[k]);
  ok(moved.length === 0, `every count is what it was (${TABLES.length} tables)`, moved.map((k) => `${k} ${before[k]} -> ${after[k]}`).join('; '));
}

console.log(`\n${passed} passed, ${failed.length} failed  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
