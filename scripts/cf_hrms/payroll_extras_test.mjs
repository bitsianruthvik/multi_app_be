/**
 * payroll_extras_test.mjs — payroll extras P3a (TM/CF_HRMS_HIRING_SPEC.md §25.5, 2026-10-20).
 *
 *   0. the schema (apply-payroll-extras-schema.mjs reads init.sql §31) and the rules (perquisites,
 *      relief_arrears: both years, with sources; 2025-26 perquisites not verified, said);
 *   1. perquisites, pure, against HAND-WORKED values (below);
 *   2. Form 10E / Form 39 arithmetic, pure (relief.js), and the engine's tax on a total income;
 *   3. the statutory files from a LOCKED April 2025 run, against hand-made lines (below);
 *   4. NPS (employer): a structure with NPS_ER, the TDS of the month by hand;
 *   5. the perquisites register through the routes (accommodation valued on the payroll's salary);
 *   6. the Form 10E worksheet of a person paid arrears in April 2026 for March 2025 and 2025-26;
 *   7. rights: the returns screen without pay view hides the amounts; files, register and 10E need it;
 *      an employee sees only their own 10E;
 *   8. nothing is left behind (every table with company_id AND deleted_at: rows and live rows).
 *
 * HAND-WORKED
 *   Perquisites, 2026-27 rules (rule 15, 2026 Rules):
 *     car, mixed use, above 1.6 L, employer pays, chauffeur, all year: (7,000 + 3,000) × 12 = 1,20,000
 *     the same on 2025-26 rules (rule 3), up to 1.6 L, no chauffeur: 1,800 × 12 = 21,600
 *     car, employee's own, mixed, up to 1.6 L, expenses 9,000 a month: 9,000 − 5,000 = 4,000 × 12 = 48,000
 *     the car of a person whose year's salary is ₹3,00,000 (not a "specified employee"): nil
 *     accommodation owned, > 40 lakh, salary 50,000, rent paid 2,000: 5,000 − 2,000 = 3,000 × 12 = 36,000
 *     accommodation owned, 15–40 lakh: 7.5% × 50,000 = 3,750 × 12 = 45,000
 *     leased, rent 8,000, furniture cost 1,20,000: min(5,000, 8,000) + 1,000 = 6,000 × 12 = 72,000
 *     housing loan 10,00,000 at 2% from 1 Apr 2026, 10,000 repaid a month, SBI 7.25%: month-end balances
 *       9,90,000 … 8,80,000, sum 1,12,20,000 × 5.25% ÷ 12 = 49,087.50 → 49,088
 *     loans of 1,50,000 together in 2026-27 (limit 2,00,000): nil; in 2025-26 (limit 20,000), personal,
 *       interest free, SBI 10.30%, all year: 1,50,000 × 10.30% = 15,450
 *     a medical loan: nil
 *     gifts 10,000 + 4,000 = 14,000 (< 15,000): nil; with 2,000 more = 16,000: all of it, 16,000
 *     credit card 30,000 − official 12,000 − recovered 3,000 = 15,000; club 50,000 all official: nil
 *   (the pure case of [2]) Form 10E / 39, 2026-27 receipt, new regime, total income typed 25,00,000; arrears 10,000 for
 *   March 2025 (2024-25: no rules here — typed: income 9,00,000, tax 15,600 / 18,720) and 1,20,000 for
 *   Apr 2025–Mar 2026 (2025-26 rules: income typed 11,00,000)):
 *     2026-27 tax on 25,00,000: 20,000 + 40,000 + 60,000 + 80,000 + 1,00,000 + 30,000 = 3,30,000 + cess
 *       13,200 = 3,43,200; on 23,70,000: 2,00,000 + 92,500 = 2,92,500 + 11,700 = 3,04,200 → A = 39,000
 *     2025-26 (new regime): on 11,00,000 the rebate → 0; on 12,20,000: 63,000, marginal relief → 20,000
 *       + cess 800 = 20,800 → E = 20,800; 2024-25 typed: 18,720 − 15,600 = 3,120 → B = 23,920
 *     relief = 39,000 − 23,920 = 15,080
 *   Through the payroll (person F: ₹6,00,000 from Feb 2025, back-dated to ₹7,20,000 from March 2025 before
 *   April 2025 is calculated, to ₹8,40,000 from April 2025 after March 2026 is locked):
 *     2026-27 receipt (April 2026 pays 12 × 10,000 for 2025-26), total income typed 25,00,000, 2025-26 income
 *       typed 11,00,000: A = 3,43,200 − tax on 23,80,000 (2,00,000 + 95,000 + cess 11,800 = 3,06,800) = 36,400;
 *       E = 20,800 → relief 15,600 (Form No. 39)
 *     2025-26 receipt (April 2025 pays 10,000 for March 2025, a 2024-25 month: no rules here, typed by the
 *       person: tax 15,600 / 16,600), total income typed 20,00,000: A = 2,08,000 − 2,05,920 = 2,080;
 *       relief 2,080 − 1,000 = 1,080 (Form 10E)
 *   Statutory files, April 2025 (PF ceiling 15,000; structure Basic 50% of CTC, HRA 50% of Basic, Special
 *   the balance; Basic in the PF wage; all three in the ESI wage):
 *     A ₹4,80,000 (40,000 a month): EPF wages 15,000 (capped), EE 1,800, EPS 8.33% = 1,249.50 → 1,250,
 *       ER difference 550; NCP 2 (the run's LOP days); not in ESI; PT 200
 *     B ₹2,04,000 (17,000): EPF wages 8,500, EE 1,020, EPS 708.05 → 708, difference 312; NCP 3 and ESI days
 *       27 from the CLOSED attendance month; ESI wages 17,000; PT 150
 *     C joins 11 April at ₹2,40,000: no UAN, no IP number → listed, left out of the files; PT nil slab
 *     ECR  100000000001#~#RAVI KUMAR#~#40000#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#2#~#0
 *          100000000002#~#SITA DEVI#~#17000#~#8500#~#8500#~#8500#~#1020#~#708#~#312#~#3#~#0
 *     ESI  1000000002 | SITA DEVI | 27 | 17000 | 0 | (blank)
 *   NPS (person N, ₹18,00,000, 2025-26 new regime, April 2025 run): Basic 75,000, HRA 37,500, NPS (employer)
 *     20% of Basic = 15,000, Special 22,500 a month. Year: earnings 16,20,000 + NPS 1,80,000 = 18,00,000 −
 *     75,000 = 17,25,000 − 80CCD(2) at most 14% of Basic 9,00,000 = 1,26,000 → 15,99,000. Tax 20,000 +
 *     40,000 + 59,850 = 1,19,850 + cess 4,794 = 1,24,644 → 1,24,640 ÷ 12 = 10,387. (Without the NPS
 *     handling it would be 15,45,000 → 85,020 ÷ 12 = 7,085.) Old regime: 80CCD(2) at most 10% = 90,000.
 *
 *   node scripts/cf_hrms/payroll_extras_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND: one connection, one transaction (pool.query / getConnection point at it),
 * rolled back. The company's own runs are set aside inside the transaction. Local only.
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
import { schemaSteps, PAYROLL_EXTRAS_TABLES } from '../../apps/cf_hrms/scripts/apply-payroll-extras-schema.mjs';
import { TAX_RULE_ROWS, rulesFromSeed } from '../../apps/cf_hrms/services/tax/index.js';
import { valuePerquisites, statementRows } from '../../apps/cf_hrms/services/tax/perquisites.js';
import { taxOnTotalIncome, worksheet } from '../../apps/cf_hrms/services/tax/relief.js';
import { ecrLine, esiReasonFor, cleanName } from '../../apps/cf_hrms/services/payrollExtras/statutoryReturns.js';
import { yearMonths } from '../../apps/cf_hrms/services/payrollTax/common.js';

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
const started = Date.now();
const dbCfg = { host: process.env.DB_HOST ?? 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306 };

/** Every table with company_id AND deleted_at: rows and live rows. */
async function worldCount() {
  const conn = await mysql.createConnection(dbCfg);
  try {
    const [tables] = await conn.query(`SELECT c1.TABLE_NAME AS t FROM information_schema.COLUMNS c1 JOIN information_schema.COLUMNS c2 ON c2.TABLE_SCHEMA = c1.TABLE_SCHEMA AND c2.TABLE_NAME = c1.TABLE_NAME AND c2.COLUMN_NAME = 'deleted_at'
      JOIN information_schema.TABLES tb ON tb.TABLE_SCHEMA = c1.TABLE_SCHEMA AND tb.TABLE_NAME = c1.TABLE_NAME AND tb.TABLE_TYPE = 'BASE TABLE'
      WHERE c1.TABLE_SCHEMA = DATABASE() AND c1.COLUMN_NAME = 'company_id' ORDER BY c1.TABLE_NAME`);
    const out = {};
    for (const { t } of tables) {
      const [[r]] = await conn.query(`SELECT COUNT(*) AS n, COALESCE(SUM(deleted_at IS NULL), 0) AS live FROM \`${t}\``);
      out[t] = `${r.n}/${r.live}`;
    }
    return out;
  } finally { await conn.end(); }
}
const before = await worldCount();

/* ══ 0. schema and rules ═══════════════════════════════════════════════ */
section('[0] The schema and the rules');
{
  const conn = await mysql.createConnection(dbCfg);
  try {
    ok(PAYROLL_EXTRAS_TABLES.length === 2 && PAYROLL_EXTRAS_TABLES.includes('hrms_pay_perquisites') && PAYROLL_EXTRAS_TABLES.includes('hrms_tax_relief_10e'), 'init.sql §31 declares the register and the 10E worksheet');
    ok((await schemaSteps(conn)).length === 0, 'apply-payroll-extras-schema: nothing left to do (idempotent)');
    const [cols] = await conn.query(`SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?) AND COLUMN_NAME IN ('company_id', 'deleted_at')`, PAYROLL_EXTRAS_TABLES);
    ok(cols.length === 4, 'both tables have company_id and deleted_at');
    const [rules] = await conn.query("SELECT tax_year, regime, rule_key, verified, source_url FROM hrms_tax_rules WHERE rule_key IN ('perquisites', 'relief_arrears') AND deleted_at IS NULL");
    ok(rules.length === 8 && rules.every((r) => r.source_url), 'perquisites and relief_arrears, both years and regimes, seeded with a source', String(rules.length));
    ok(rules.filter((r) => r.rule_key === 'perquisites' && r.tax_year === '2025-26').every((r) => Number(r.verified) === 0) && rules.filter((r) => r.rule_key === 'perquisites' && r.tax_year === '2026-27').every((r) => Number(r.verified) === 1),
      '2025-26 perquisites NOT verified (accommodation read on a third-party copy), 2026-27 verified (rule 15 read)');
    ok(TAX_RULE_ROWS.filter((r) => ['perquisites', 'relief_arrears'].includes(r.rule_key)).length === 8, 'the seed has them');
  } finally { await conn.end(); }
}

/* ══ 1. perquisites, pure ══════════════════════════════════════════════ */
section('[1] Perquisites, by hand');
{
  const P26 = rulesFromSeed('2026-27', 'NEW').get('perquisites');
  const P25 = rulesFromSeed('2025-26', 'NEW').get('perquisites');
  const M26 = yearMonths('2026-27');
  const M25 = yearMonths('2025-26');
  const sal = (months, x) => Object.fromEntries(months.map((m) => [m, x]));
  const val = (entries, rule, months, extra = {}) => valuePerquisites(entries.map((e, i) => ({ id: i + 1, ...e })), { rule, months, salaryByMonth: sal(months, 50000), annualMonetarySalary: 600000, ...extra });
  const car = (facts, fromDate = '2026-04-01') => ({ kind: 'CAR', fromDate, toDate: null, facts });
  let v = val([car({ ownedBy: 'EMPLOYER', use: 'MIXED', engine: 'ABOVE_1600', runningCostsBy: 'EMPLOYER', chauffeur: true })], P26, M26);
  ok(v.total === 120000 && v.byMonth['2026-07'] === 10000, 'car, mixed, above 1.6 L, employer pays, chauffeur (2026-27): 10,000 × 12 = 1,20,000', JSON.stringify(v.items[0].lines));
  v = val([car({ ownedBy: 'EMPLOYER', use: 'MIXED', engine: 'UP_TO_1600', runningCostsBy: 'EMPLOYER' }, '2025-04-01')], P25, M25);
  ok(v.total === 21600, 'the same up to 1.6 L, no chauffeur, on 2025-26 rules (rule 3): 1,800 × 12 = 21,600', String(v.total));
  v = val([car({ ownedBy: 'EMPLOYEE', use: 'MIXED', engine: 'UP_TO_1600', actualCostPerMonth: 9000 })], P26, M26);
  ok(v.total === 48000, 'the employee’s own car, mixed, up to 1.6 L, expenses 9,000: (9,000 − 5,000) × 12 = 48,000', String(v.total));
  v = val([car({ ownedBy: 'EMPLOYER', use: 'MIXED', engine: 'ELECTRIC', runningCostsBy: 'EMPLOYEE' })], P26, M26);
  ok(v.total === 24000, 'an electric car is valued as up to 1.6 L in 2026-27 (employee pays: 2,000 × 12)', String(v.total));
  v = val([car({ ownedBy: 'EMPLOYER', use: 'MIXED', engine: 'ABOVE_1600', runningCostsBy: 'EMPLOYER' })], P26, M26, { annualMonetarySalary: 300000 });
  ok(v.total === 0 && /not above/.test(v.items[0].lines[0]), 'a year’s salary of 3,00,000 (not above 4,00,000): the car is not taxable, said');
  v = val([car({ ownedBy: 'EMPLOYER', use: 'OFFICIAL', engine: 'ABOVE_1600', officialRecords: true })], P26, M26);
  ok(v.total === 0, 'wholly official use with the records: nil');
  v = val([car({ ownedBy: 'EMPLOYER', use: 'MIXED', engine: 'ABOVE_1600', runningCostsBy: 'EMPLOYER' }, '2026-10-16')], P26, M26);
  ok(v.byMonth['2026-10'] === 3613 && v.total === 38613, 'from 16 October: October by its days (7,000 × 16 ÷ 31 = 3,612.90), then 7,000 a month: 38,613', `${v.byMonth['2026-10']} ${v.total}`);

  const acc = (facts) => ({ kind: 'ACCOMMODATION', fromDate: '2026-04-01', toDate: null, facts });
  v = val([acc({ type: 'OWNED', population: 'ABOVE_40L', rentRecoveredPerMonth: 2000 })], P26, M26);
  ok(v.total === 36000 && v.items[0].value === 60000 && v.items[0].recovered === 24000, 'accommodation owned, > 40 lakh, salary 50,000, rent paid 2,000: (5,000 − 2,000) × 12 = 36,000 (value 60,000, recovered 24,000)', JSON.stringify({ t: v.total, v: v.items[0].value, r: v.items[0].recovered }));
  v = val([acc({ type: 'OWNED', population: '15L_TO_40L' })], P26, M26);
  ok(v.total === 45000, 'owned, 15–40 lakh: 7.5% × 50,000 = 3,750 × 12 = 45,000', String(v.total));
  v = val([acc({ type: 'LEASED', leaseRentPerMonth: 8000, furnitureCost: 120000 })], P26, M26);
  ok(v.total === 72000, 'leased, rent 8,000, furniture 1,20,000: (min(5,000, 8,000) + 1,000) × 12 = 72,000', String(v.total));

  const loan = (facts, fromDate = '2026-04-01') => ({ kind: 'LOAN', fromDate, toDate: null, facts });
  v = val([loan({ purpose: 'HOUSING', amount: 1000000, ratePct: 2, principalPerMonth: 10000 })], P26, M26);
  ok(v.total === 49088 && v.byMonth['2026-04'] === 4331 && v.items[0].byMonth['2026-04'] === 4331.25, 'housing loan 10,00,000 at 2%, SBI 7.25%: 1,12,20,000 × 5.25% ÷ 12 = 49,087.50 → 49,088', `${v.total} ${v.items[0].byMonth['2026-04']}`);
  v = val([loan({ purpose: 'PERSONAL', amount: 100000, ratePct: 0 }), loan({ purpose: 'PERSONAL', amount: 50000, ratePct: 0 })], P26, M26);
  ok(v.total === 0 && /not above/.test(v.items[0].lines[0]), 'loans of 1,50,000 together in 2026-27 (up to 2,00,000): nil');
  v = val([loan({ purpose: 'PERSONAL', amount: 150000, ratePct: 0 }, '2025-04-01')], P25, M25);
  ok(v.total === 15450, 'the same 1,50,000 in 2025-26 (limit 20,000), personal, SBI 10.30%: 15,450', String(v.total));
  v = val([loan({ purpose: 'OTHER', amount: 500000, ratePct: 0, medical: true })], P26, M26);
  ok(v.total === 0, 'a loan for medical treatment (rule 18): nil');
  v = val([loan({ purpose: 'HOUSING', amount: 1000000, ratePct: 2, principalPerMonth: 10000, sbiRatePct: 8 })], P26, M26);
  ok(v.total === Math.round(11220000 * 0.06 / 12), 'the company’s own SBI rate on the loan (8%) wins', String(v.total));

  const gift = (amount, fromDate) => ({ kind: 'GIFT', fromDate, toDate: fromDate, facts: { amount } });
  v = val([gift(10000, '2026-10-20'), gift(4000, '2027-01-15')], P26, M26);
  ok(v.total === 0, 'gifts 14,000 in 2026-27 (below 15,000): nil');
  v = val([gift(10000, '2026-10-20'), gift(4000, '2027-01-15'), gift(2000, '2027-03-01')], P26, M26);
  ok(v.total === 16000 && v.byMonth['2026-10'] === 10000, 'gifts 16,000: the whole amount (the common reading, said)');
  v = val([{ kind: 'CREDIT_CARD', fromDate: '2026-06-30', facts: { amount: 30000, officialAmount: 12000, recovered: 3000 } }, { kind: 'CLUB', fromDate: '2026-06-30', facts: { amount: 50000, officialAmount: 50000 } }], P26, M26);
  ok(v.items[0].taxable === 15000 && v.items[1].taxable === 0 && v.total === 15000, 'credit card 30,000 − official 12,000 − recovered 3,000 = 15,000; club all official: nil');
  const rows = statementRows(val([acc({ type: 'OWNED', population: 'ABOVE_40L', rentRecoveredPerMonth: 2000 }), car({ ownedBy: 'EMPLOYER', use: 'MIXED', engine: 'ABOVE_1600', runningCostsBy: 'EMPLOYER', chauffeur: true })], P26, M26).items);
  ok(rows.length === 2 && rows[0].row === 1 && rows[0].value === 60000 && rows[0].recovered === 24000 && rows[0].taxable === 36000 && rows[1].row === 2 && rows[1].taxable === 120000, 'the statement (Form 12BA / 123): accommodation row 1 (60,000 / 24,000 / 36,000), cars row 2');
}

/* ══ 2. Form 10E / 39 arithmetic ═══════════════════════════════════════ */
section('[2] Relief for arrears, by hand');
{
  const N26 = rulesFromSeed('2026-27', 'NEW');
  const N25 = rulesFromSeed('2025-26', 'NEW');
  ok(taxOnTotalIncome(N26, 2500000) === 343200 && taxOnTotalIncome(N26, 2370000) === 304200, '2026-27 new regime: 3,43,200 on 25,00,000; 3,04,200 on 23,70,000');
  ok(taxOnTotalIncome(N25, 1100000) === 0 && taxOnTotalIncome(N25, 1220000) === 20800, '2025-26 new regime: nil on 11,00,000 (rebate); 20,800 on 12,20,000 (marginal relief)');
  const w = worksheet({
    receipt: { year: '2026-27', totalIncome: 2500000, taxWith: 343200, taxWithout: 304200 },
    earlier: [{ year: '2025-26', arrears: 120000, totalIncome: 1100000, taxWithout: 0, taxWith: 20800, how: 'ENGINE' }, { year: '2024-25', arrears: 10000, totalIncome: 900000, taxWithout: 15600, taxWith: 18720, how: 'TYPED' }],
  });
  ok(w.complete && w.a === 39000 && w.b === 23920 && w.relief === 15080 && w.rows.totalIncomeExcluding === 2370000 && w.table[0].year === '2024-25' && w.table[1].difference === 20800, 'relief = 39,000 − (20,800 + 3,120) = 15,080; the table in year order', JSON.stringify(w.rows));
  const none = worksheet({ receipt: { year: '2026-27', totalIncome: 2500000, taxWith: 343200, taxWithout: 304200 }, earlier: [{ year: '2025-26', arrears: 130000, totalIncome: 3000000, taxWithout: 100, taxWith: 50000, how: 'TYPED' }] });
  ok(none.relief === 0 && /No relief/.test(none.sentence), 'when the earlier years’ extra tax is more: no relief, said');
  const inc = worksheet({ receipt: { year: '2026-27', totalIncome: 2500000, taxWith: 343200, taxWithout: 304200 }, earlier: [{ year: '2024-25', arrears: 10000, how: 'MISSING' }] });
  ok(!inc.complete && inc.relief === 0 && inc.missing[0] === '2024-25', 'a year with nothing typed: not finished, no relief, the year named');
}

/* ══ the database part: one transaction, rolled back ═══════════════════ */
const real = { query: pool.query.bind(pool), execute: pool.execute.bind(pool), getConnection: pool.getConnection.bind(pool) };
const db = await real.getConnection();
await db.beginTransaction();
let depth = 0;
const inside = {
  query: (...a) => db.query(...a),
  execute: (...a) => db.execute(...a),
  beginTransaction: async () => { depth += 1; await db.query(`SAVEPOINT zz_pext_${depth}`); },
  commit: async () => { if (depth > 0) { await db.query(`RELEASE SAVEPOINT zz_pext_${depth}`); depth -= 1; } },
  rollback: async () => { if (depth > 0) { await db.query(`ROLLBACK TO SAVEPOINT zz_pext_${depth}`); depth -= 1; } },
  release: () => {},
};
pool.query = inside.query;
pool.execute = inside.execute;
pool.getConnection = async () => inside;

const TAG = `ZZPX${Date.now().toString(36).toUpperCase().slice(-5)}`;
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
  console.log(`\npayroll_extras_test — ${company.name} (${COMPANY}), run tag ${TAG}`);
  // The company's own runs (somebody's demo) and tax setup: out of the way, inside the transaction.
  await db.query('UPDATE hrms_pay_runs SET deleted_at = NOW() WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  await db.query("UPDATE hrms_tax_settings SET deleted_at = NOW() WHERE company_id = ? AND tax_year IN ('2025-26', '2026-27') AND deleted_at IS NULL", [COMPANY]);
  await db.query('UPDATE hrms_pay_perquisites SET deleted_at = NOW() WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  await db.query('UPDATE hrms_tax_relief_10e SET deleted_at = NOW() WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  // P3b: claim types (a flexible balance is paid in March) and the payroll policy of the company: out of the way too.
  await db.query('UPDATE hrms_pay_claim_types SET deleted_at = NOW() WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  await db.query('UPDATE hrms_pay_policy SET deleted_at = NOW() WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);

  await setupAccess(db, COMPANY, { apply: true });
  const roleByKey = Object.fromEntries((await q('SELECT role_id, template_key FROM hrms_access_roles WHERE company_id = ? AND deleted_at IS NULL AND template_key IS NOT NULL', [COMPANY])).map((r) => [r.template_key, r.role_id]));
  const catalog = await ensureCatalog(db, { apply: true });
  const noPayRole = await ins('INSERT INTO roles (name, company_id) VALUES (?, ?)', [`${TAG} Payroll clerk`, COMPANY]);
  await db.query("INSERT INTO hrms_access_roles (company_id, role_id, label, scope) VALUES (?, ?, ?, 'COMPANY')", [COMPANY, noPayRole, `${TAG} Payroll clerk`]);
  await setRoleTags(db, { companyId: COMPANY, appId: app.id, roleId: noPayRole, tags: [areaTag('payroll', 'view'), areaTag('payroll', 'edit')], catalog });

  const emp = async (code, name, joining) => ins(
    "INSERT INTO hrms_employees (company_id, employee_code, full_name, date_of_joining, date_of_birth, employment_type, employment_status) VALUES (?, ?, ?, ?, '1990-05-05', 'EMPLOYEE', 'ACTIVE')",
    [COMPANY, `${TAG}${code}`, name, joining]);
  const E = {
    A: await emp('A', 'Ravi Kumar', '2025-04-01'), B: await emp('B', 'Sita Devi', '2025-04-01'), C: await emp('C', `${TAG} Person C`, '2025-04-11'),
    F: await emp('F', `${TAG} Person F`, '2025-02-01'), N: await emp('N', `${TAG} Person N`, '2025-04-01'),
  };
  const ident = (e, type, v) => db.query('INSERT INTO hrms_employee_identifiers (company_id, employee_id, identifier_type, identifier_value) VALUES (?, ?, ?, ?)', [COMPANY, e, type, v]);
  await ident(E.A, 'UAN', '100000000001'); await ident(E.B, 'UAN', '100000000002'); await ident(E.B, 'ESI', '1000000002');
  for (const [k, pan] of [['A', 'AAAPA1234A'], ['B', 'AAAPB1234B'], ['C', 'AAAPC1234C'], ['F', 'AAAPF1234F'], ['N', 'AAAPN1234N']]) await ident(E[k], 'PAN', pan);

  const login = async (label, roleId, employeeId = null) => {
    const email = `${TAG.toLowerCase()}.${label.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.test`;
    const id = await ins('INSERT INTO users (name, email, password, role_id, team_id, company_id) VALUES (?, ?, ?, ?, NULL, ?)', [`${TAG} ${label}`, email, 'x', roleId, COMPANY]);
    await db.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [id, app.id, roleId, COMPANY]);
    if (employeeId) await db.query('UPDATE hrms_employees SET user_id = ? WHERE id = ?', [id, employeeId]);
    const roleName = (await one('SELECT name FROM roles WHERE id = ?', [roleId])).name;
    return { id, token: signToken({ id, name: `${TAG} ${label}`, email, role: roleName, company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
  };
  const U = {
    HR: await login('HR manager', roleByKey.HR_MANAGER), DH: await login('Department head', roleByKey.DEPARTMENT_HEAD),
    CLERK: await login('Clerk', noPayRole), F: await login('Employee F', roleByKey.EMPLOYEE, E.F), A: await login('Employee A', roleByKey.EMPLOYEE, E.A),
  };
  forgetAccess();
  server = express();
  server.use(express.json({ limit: '40mb' }));
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

  /* ── payroll: components, structures, salaries ─────────────────────── */
  await must(U.HR, 'POST', '/payroll/setup');
  const C = Object.fromEntries((await must(U.HR, 'GET', '/payroll/components')).components.map((k) => [k.code, k]));
  ok(C.NPS_ER && C.NPS_ER.kind === 'EMPLOYER_CONTRIBUTION' && C.NPS_ER.exemptionRule === 'NPS_80CCD2' && C.NPS_ER.readyMade, 'NPS (employer) is a ready-made employer contribution, exemption rule NPS_80CCD2', JSON.stringify(C.NPS_ER));
  const s1 = (await must(U.HR, 'POST', '/payroll/structures', { code: `${TAG}S`, name: `${TAG} Basic half`, lines: [
    { componentId: C.BASIC.id, formula: '50% of CTC' }, { componentId: C.HRA.id, formula: '50% of BASIC' }, { componentId: C.SPECIAL.id, formula: 'balance' }] })).structure;
  const s2 = (await must(U.HR, 'POST', '/payroll/structures', { code: `${TAG}N`, name: `${TAG} With NPS`, lines: [
    { componentId: C.BASIC.id, formula: '50% of CTC' }, { componentId: C.HRA.id, formula: '50% of BASIC' }, { componentId: C.NPS_ER.id, formula: 'round(20% of BASIC)' }, { componentId: C.SPECIAL.id, formula: 'balance' }] })).structure;
  const salary = (e, ctc, from, structureId = s1.id, pfMode = 'CEILING') => must(U.HR, 'POST', '/payroll/salaries', { employeeId: e, annualCtc: ctc, structureId, effectiveFrom: from, pfMode, reason: 'Test' });
  await salary(E.A, 480000, '2025-04-01');
  await salary(E.B, 204000, '2025-04-01');
  await salary(E.C, 240000, '2025-04-11');
  await salary(E.F, 600000, '2025-02-01', s1.id, 'NONE');
  await salary(E.N, 1800000, '2025-04-01', s2.id, 'NONE');

  const runMonth = async (m) => {
    const run = (await must(U.HR, 'POST', '/payroll/runs', { month: m })).run;
    const calc = await must(U.HR, 'POST', `/payroll/runs/${run.id}/calculate`);
    await must(U.HR, 'POST', `/payroll/runs/${run.id}/lock`);
    return { run, calc };
  };
  const P = (r) => Object.fromEntries(r.people.map((p) => [p.employee.id, p]));

  /* ══ 3. statutory files ══════════════════════════════════════════════ */
  section('[3] Statutory files from the locked April 2025 run');
  await runMonth('2025-03');
  await salary(E.F, 720000, '2025-03-01', s1.id, 'NONE');
  // Before April is locked: the files are refused, in words.
  const aprRun = (await must(U.HR, 'POST', '/payroll/runs', { month: '2025-04' })).run;
  const aprCalc = await must(U.HR, 'POST', `/payroll/runs/${aprRun.id}/calculate`);
  const early = await call(U.HR, 'GET', '/payroll/returns/2025-04');
  ok(early.status === 200 && !early.json.ready && /LOCKED/.test(early.json.reason), 'a calculated, not locked run: “made from a LOCKED run. Lock it first.”', early.json?.reason);
  const earlyFile = await call(U.HR, 'GET', '/payroll/returns/2025-04/files/ECR');
  ok(earlyFile.status === 409 && earlyFile.json.code === 'NOT_LOCKED', 'its files: refused (NOT_LOCKED)');
  await must(U.HR, 'POST', `/payroll/runs/${aprRun.id}/lock`);
  const pa = P(aprCalc);
  ok(pa[E.N].tds === 10387, 'NPS: N’s April TDS = 1,24,640 ÷ 12 = 10,387 (the employer’s NPS counted in salary and deducted under 80CCD(2) up to 14% of Basic)', JSON.stringify(pa[E.N].tax ?? pa[E.N].tds));
  // The run's LOP for A: two days (as an approved unpaid leave would give) — the ECR reads the run's LOP days.
  await db.query('UPDATE hrms_pay_run_people SET lop_days = 2 WHERE company_id = ? AND run_id = ? AND employee_id = ? AND deleted_at IS NULL', [COMPANY, aprRun.id, E.A]);
  // B's run paid 27 of 30 days (3 LOP) — what a run reading the closed attendance month pays (P3b review: the files take the RUN's days).
  await db.query('UPDATE hrms_pay_run_people SET lop_days = 3, payable_days = 27 WHERE company_id = ? AND run_id = ? AND employee_id = ? AND deleted_at IS NULL', [COMPANY, aprRun.id, E.B]);
  // Attendance CLOSED for April 2025 with B's NCP 3 / ESI days 27 (live in that month's summary).
  const had = await one('SELECT id FROM hrms_attendance_months WHERE company_id = ? AND period_month = ?', [COMPANY, '2025-04']);
  const summary = JSON.stringify({ month: '2025-04', from: '2025-04-01', to: '2025-04-30', calendarDays: 30, live: true, liveFrom: '2025-04-01', people: [{ employeeId: E.B, ncpDays: 3, esiDays: 27, lopDays: 3, payableDays: 27 }, { employeeId: E.A, ncpDays: 1, esiDays: 29, lopDays: 1, payableDays: 29 }] });
  if (had) await db.query("UPDATE hrms_attendance_months SET status = 'CLOSED', summary_json = ?, closed_at = NOW(), deleted_at = NULL WHERE id = ?", [summary, had.id]);
  else await db.query("INSERT INTO hrms_attendance_months (company_id, period_month, status, summary_json, closed_at) VALUES (?, '2025-04', 'CLOSED', ?, NOW())", [COMPANY, summary]);

  const auditsBefore = Number((await one("SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_pay_salary_read'", [COMPANY])).n);
  const ret = await must(U.HR, 'GET', '/payroll/returns/2025-04');
  const auditsAfter = Number((await one("SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_pay_salary_read'", [COMPANY])).n);
  ok(ret.ready && ret.attendance.used && ret.run.status === 'LOCKED', 'the locked run, with the CLOSED attendance month in use');
  ok(auditsAfter === auditsBefore + 1, 'HR reading the amounts writes one audit row (hrms_pay_salary_read)');
  const row = (list, e) => list.find((r) => r.employee.id === e);
  const rA = row(ret.pf.rows, E.A);
  const rB = row(ret.pf.rows, E.B);
  const expA = '100000000001#~#RAVI KUMAR#~#40000#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#2#~#0';
  const expB = '100000000002#~#SITA DEVI#~#17000#~#8500#~#8500#~#8500#~#1020#~#708#~#312#~#3#~#0';
  ok(rA && ecrLine(rA) === expA && rA.ncpFrom === 'RUN', 'A: EPF wages capped at 15,000, EPS 1,250, ER 550, NCP 2 from the run', rA ? ecrLine(rA) : 'no row');
  ok(rB && ecrLine(rB) === expB && rB.ncpFrom === 'RUN', 'B: 8,500, EE 1,020, EPS 708, ER 312, NCP 3 — the run’s LOP (the run read the closed month)', rB ? ecrLine(rB) : 'no row');
  ok(ret.validation.some((v) => v.level === 'WARNING' && v.kind === 'PF' && v.employee?.id === E.A && /closed attendance has 1 NCP days, the run paid 2/.test(v.what)) && !ret.validation.some((v) => v.kind === 'PF' && v.employee?.id === E.B && /closed attendance has/.test(v.what)),
    'review fix: A’s closed attendance (1 NCP day) differs from the run (2 LOP days) — flagged; B agrees — not flagged');
  const rC = row(ret.pf.rows, E.C);
  ok(rC && !rC.uan && ret.validation.some((v) => v.level === 'ERROR' && v.kind === 'PF' && v.employee?.id === E.C && /no UAN/.test(v.what)), 'C without a UAN: an error, named');
  const ecr = await must(U.HR, 'GET', '/payroll/returns/2025-04/files/ECR');
  const ecrText = Buffer.from(ecr.contentBase64, 'base64').toString('utf8');
  const mine = ecrText.split('\n').filter((l) => l.startsWith('1000000000'));
  ok(ecr.fileName === 'ECR_202504.txt' && ecr.mimeType === 'text/plain' && mine.length === 2 && mine[0] === expA && mine[1] === expB && !/PERSON C/.test(ecrText), 'the ECR file: the two hand-made lines, no header, C left out', JSON.stringify(mine));
  ok(ecrText.split('\n').every((l) => l.split('#~#').length === 11 && l.split('#~#').slice(2).every((x) => /^\d+$/.test(x))), 'every line: 11 fields joined by #~#, whole numbers');

  const eB = row(ret.esi.rows, E.B);
  const eC = row(ret.esi.rows, E.C);
  ok(eB && eB.ip === '1000000002' && eB.days === 27 && eB.wages === 17000 && eB.reason === 0 && !eB.lastWorkingDay && eB.daysFrom === 'RUN', 'ESI, B: IP 1000000002, 27 days (the run’s payable days), wages 17,000, reason 0', JSON.stringify(eB));
  const cRun = await one('SELECT esi_wage, payable_days FROM hrms_pay_run_people WHERE company_id = ? AND run_id = ? AND employee_id = ? AND deleted_at IS NULL', [COMPANY, aprRun.id, E.C]);
  ok(eC && eC.days === 20 && Number(cRun.payable_days) === 20 && eC.wages === Math.round(Number(cRun.esi_wage)) && !eC.ip && ret.validation.some((v) => v.kind === 'ESI' && v.employee?.id === E.C && /no ESI IP number/.test(v.what)), 'ESI, C (joined 11 April): 20 days, the run’s ESI wage; no IP number → an error', JSON.stringify(eC));
  ok(!row(ret.esi.rows, E.A), 'A (₹40,000) is not covered by ESI: not in the ESI file');
  const esi = await must(U.HR, 'GET', '/payroll/returns/2025-04/files/ESI');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(esi.contentBase64, 'base64'));
  const ws = wb.worksheets[0];
  const header = ws.getRow(1).values.slice(1);
  const data = [];
  ws.eachRow((r, i) => { if (i > 1) data.push(r.values.slice(1).map((x) => (x == null ? '' : x))); });
  const bRow = data.find((r) => String(r[0]) === '1000000002');
  ok(header.length === 6 && /^IP Number/.test(header[0]) && /Reason Code/.test(header[4]) && /Last Working Day/.test(header[5]), 'the ESI workbook: the portal’s six columns', JSON.stringify(header));
  ok(bRow && bRow[1] === 'SITA DEVI' && Number(bRow[2]) === 27 && Number(bRow[3]) === 17000 && Number(bRow[4]) === 0 && bRow[5] === '' && !data.some((r) => /PERSON C/.test(String(r[1]))), 'its row for B: 1000000002 | SITA DEVI | 27 | 17000 | 0 | (blank); C left out', JSON.stringify(bRow));
  ok(esiReasonFor({ days: 0, exit: '2025-04-10', monthEnd: '2025-04-30', lopDays: 0 }).reason === 2 && esiReasonFor({ days: 0, exit: '2025-04-10', monthEnd: '2025-04-30', lopDays: 0 }).lastWorkingDay === '2025-04-10'
    && esiReasonFor({ days: 0, exit: null, monthEnd: '2025-04-30', lopDays: 30 }).reason === 1 && esiReasonFor({ days: 0, exit: null, monthEnd: '2025-04-30', lopDays: 30 }).lastWorkingDay === null
    && esiReasonFor({ days: 12, exit: '2025-04-12', monthEnd: '2025-04-30', lopDays: 0 }).reason === 0 && esiReasonFor({ days: 12, exit: '2025-04-12', monthEnd: '2025-04-30', lopDays: 0 }).lastWorkingDay === null,
  'reason codes: left with 0 days → 2 and the last working day; a month of leave → 1, no date; days paid → 0, no date (ESIC’s numbering from 0)');
  ok(cleanName('A. K. Rao-Singh 2') === 'A. K. RAO SINGH' && cleanName('A. K. Rao', { dots: false }) === 'A K RAO', 'names: letters, spaces (and dots for EPFO), upper case');

  const slab = (from) => ret.pt.slabs.find((s) => s.from === from);
  const nilSlab = slab(0);
  ok(slab(15001).employees === 1 && slab(15001).rate === 150 && slab(15001).deducted === 150 && ret.pt.slabs.find((s) => s.upTo === null).employees === 3 && ret.pt.slabs.find((s) => s.upTo === null).deducted === 600 && nilSlab.employees === 1 && nilSlab.deducted === 0,
    'PT (Telangana): nil slab 1 (C); ₹15,001–20,000 at 150: 1 (B); above ₹20,000 at 200: 3 (A, F, N) = 600', JSON.stringify(ret.pt.slabs));
  ok(ret.pt.totals.employees === 5 && ret.pt.totals.deducted === 750 && ret.pt.dueDate === '2025-05-10', 'PT totals: 5 people, ₹750, due 10 May 2025');
  const pt = await must(U.HR, 'GET', '/payroll/returns/2025-04/files/PT');
  const pwb = new ExcelJS.Workbook();
  await pwb.xlsx.load(Buffer.from(pt.contentBase64, 'base64'));
  const prow = [];
  pwb.worksheets[0].eachRow((r) => prow.push(r.values.slice(1)));
  ok(pt.fileName === 'PT_TG_202504.xlsx' && prow.some((r) => /15,001 to/.test(String(r[0])) && r[1] === 1 && r[2] === 150 && r[3] === 150) && prow.some((r) => r[0] === 'Total' && r[1] === 5 && r[3] === 750), 'the PT workbook: the slab rows and the total, as Form V asks');

  /* ══ 4. NPS on the tax sheet ═════════════════════════════════════════ */
  section('[4] NPS (employer) through the tax');
  const sheetN = await must(U.HR, 'GET', `/tax/2025-26/sheet/${E.N}?month=2025-04`);
  const dNew = sheetN.regimes.NEW.computation.deductions.find((d) => d.key === 'ded_80ccd2');
  const dOld = sheetN.regimes.OLD.computation.deductions.find((d) => d.key === 'ded_80ccd2');
  ok(sheetN.regimes.NEW.computation.grossSalary === 1800000 && dNew?.claimed === 180000 && dNew?.allowed === 126000 && sheetN.regimes.NEW.projectedTax === 124640,
    'new regime: gross 18,00,000 incl. NPS 1,80,000; 80CCD(2) 1,26,000 allowed (14% of Basic 9,00,000); tax 1,24,640', JSON.stringify({ g: sheetN.regimes.NEW.computation.grossSalary, d: dNew, t: sheetN.regimes.NEW.projectedTax }));
  ok(dOld?.allowed === 90000, 'old regime: 80CCD(2) at most 10% of Basic = 90,000', JSON.stringify(dOld));

  /* ── the rest of the year, then April 2026 with arrears for F ───────── */
  for (const m of ['2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03']) await runMonth(m);
  await salary(E.F, 840000, '2025-04-01', s1.id, 'NONE');
  const apr26 = await runMonth('2026-04');
  const arrLines = await q("SELECT for_month, amount FROM hrms_pay_run_lines WHERE company_id = ? AND run_id = ? AND employee_id = ? AND source = 'ARREARS' AND deleted_at IS NULL ORDER BY for_month", [COMPANY, apr26.run.id, E.F]);
  const arr25 = await q("SELECT l.for_month, l.amount FROM hrms_pay_run_lines l JOIN hrms_pay_runs r ON r.id = l.run_id WHERE l.company_id = ? AND r.period_month = '2025-04' AND r.deleted_at IS NULL AND l.employee_id = ? AND l.source = 'ARREARS' AND l.deleted_at IS NULL", [COMPANY, E.F]);
  ok(arr25.length === 1 && arr25[0].for_month === '2025-03' && Number(arr25[0].amount) === 10000, 'April 2025 paid F’s arrears for March 2025 (a 2024-25 month): 10,000', JSON.stringify(arr25));
  ok(arrLines.length === 12 && arrLines.every((l) => Number(l.amount) === 10000) && arrLines[0].for_month === '2025-04', 'April 2026 pays F’s arrears: 12 months × 10,000 (April 2025 … March 2026)', JSON.stringify(arrLines.map((l) => `${l.for_month}:${l.amount}`)));

  /* ══ 5. the perquisites register ═════════════════════════════════════ */
  section('[5] The perquisites register');
  const badDate = await call(U.HR, 'POST', '/tax/2025-26/perquisites', { employeeId: E.A, kind: 'ACCOMMODATION', fromDate: '2026-04-01', facts: { type: 'OWNED', population: 'ABOVE_40L' } });
  ok(badDate.status === 422 && /tax year 2025-26/.test(JSON.stringify(badDate.json)), 'a date outside the tax year: refused, in words');
  const badFacts = await call(U.HR, 'POST', '/tax/2025-26/perquisites', { employeeId: E.A, kind: 'ACCOMMODATION', fromDate: '2025-04-01', facts: { type: 'OWNED' } });
  ok(badFacts.status === 422 && /Population/.test(JSON.stringify(badFacts.json)), 'facts missing (the city’s population): refused');
  const prev = await must(U.HR, 'POST', '/tax/2025-26/perquisites/preview', { employeeId: E.A, kind: 'ACCOMMODATION', fromDate: '2025-04-01', facts: { type: 'OWNED', population: 'ABOVE_40L' } });
  ok(prev.valued.taxable === 48000 && prev.salary.byMonth['2025-04'] === 40000, 'preview: owned, > 40 lakh, on the payroll’s salary 40,000 a month → 4,000 × 12 = 48,000 (nothing saved)', JSON.stringify({ t: prev.valued.taxable, s: prev.salary?.byMonth?.['2025-04'] }));
  const added = await must(U.HR, 'POST', '/tax/2025-26/perquisites', { employeeId: E.A, kind: 'ACCOMMODATION', label: 'Flat 4B', fromDate: '2025-04-01', facts: { type: 'OWNED', population: 'ABOVE_40L' } });
  ok(added.valued.taxable === 48000 && added.total === 48000, 'saved: the same value');
  const giftE = await must(U.HR, 'POST', '/tax/2025-26/perquisites', { employeeId: E.A, kind: 'GIFT', label: 'Diwali voucher', fromDate: '2025-10-20', facts: { amount: 6000 } });
  ok(giftE.valued.taxable === 6000 && giftE.total === 54000, 'a gift of 6,000 (2025-26: not below 5,000): taxable; the person’s year 54,000');
  const upd = await must(U.HR, 'PUT', `/tax/perquisites/${giftE.entry.id}`, { facts: { amount: 4000 } });
  ok(upd.valued.taxable === 0 && upd.total === 48000, 'changed to 4,000: below 5,000 → nil');
  const list = await must(U.HR, 'GET', '/tax/2025-26/perquisites');
  const pA = list.people.find((p) => p.employee.id === E.A);
  ok(pA && pA.total === 48000 && pA.entries.length === 2 && pA.entries[0].valued && list.rule && list.source && list.source.verified === false, 'the register: A with two entries, valued; the rule and its source (2025-26 not verified)');
  const { perquisitesAsOf, perquisiteStatement } = await import('../../apps/cf_hrms/services/payrollExtras/perquisites.js');
  const asOf = (await perquisitesAsOf(db, COMPANY, '2025-10', [E.A])).get(E.A);
  ok(asOf && asOf.total === 48000 && asOf.toDate === 28000 && asOf.byMonth['2026-03'] === 4000 && asOf.perquisites.length === 1 && asOf.perquisites[0].value === 48000, 'perquisitesAsOf(October 2025): the year 48,000, to date 28,000, by month — and the engine’s { name, value } input', JSON.stringify({ t: asOf?.total, d: asOf?.toDate }));
  const stmt = await perquisiteStatement(db, COMPANY, '2025-26', E.A);
  ok(stmt.length === 1 && stmt[0].row === 1 && stmt[0].value === 48000 && stmt[0].name === 'Accommodation' && stmt[0].recovered === 0, 'the Form 12BA rows: accommodation (row 1), 48,000');
  await must(U.HR, 'DELETE', `/tax/perquisites/${giftE.entry.id}`);
  ok((await must(U.HR, 'GET', '/tax/2025-26/perquisites')).people.find((p) => p.employee.id === E.A).entries.length === 1, 'removed (soft delete, audited)');
  const audP = await one("SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_pay_perquisites'", [COMPANY]);
  ok(Number(audP.n) >= 4, 'every write of the register is audited');

  /* ══ 6. Form 10E / 39 ════════════════════════════════════════════════ */
  section('[6] Form 10E / Form 39 for F');
  // 2026-27: arrears of 2025-26 (rules here) — the engine works that year.
  const l10 = await must(U.HR, 'GET', '/tax/2026-27/form10e');
  const fRow = l10.people.find((p) => p.employee.id === E.F);
  ok(fRow && fRow.arrears.total === 120000 && fRow.arrears.years.length === 1 && fRow.arrears.years[0].year === '2025-26' && !fRow.worksheet && l10.law.formNumber === '39',
    'the 2026-27 list: F, arrears 1,20,000 for 2025-26; Form No. 39 for 2026-27', JSON.stringify(fRow?.arrears));
  const g26 = await must(U.HR, 'POST', `/tax/2026-27/form10e/${E.F}`, { receipt: { totalIncome: 2500000 }, earlier: { '2025-26': { regime: 'NEW', totalIncome: 1100000 } } });
  const w26 = g26.worksheet.result.worksheet;
  ok(g26.worksheet.status === 'READY' && g26.worksheet.relief === 15600 && w26.a === 36400 && w26.b === 20800 && w26.rows.totalIncomeExcluding === 2380000 && g26.worksheet.result.earlier[0].how === 'ENGINE_TYPED_INCOME',
    '2026-27: A = 3,43,200 − 3,06,800 (on 23,80,000) = 36,400; 2025-26 by the engine with its own rules (20,800); relief 15,600', JSON.stringify({ r: g26.worksheet.relief, a: w26.a, b: w26.b }));
  // 2025-26: arrears of March 2025 (2024-25 — no rules here) — flagged; the person types that year.
  const l25 = await must(U.HR, 'GET', '/tax/2025-26/form10e');
  ok(l25.people.find((p) => p.employee.id === E.F)?.arrears?.years?.[0]?.year === '2024-25' && l25.law.formNumber === '10E', 'the 2025-26 list: F, 10,000 for 2024-25; Form 10E for 2025-26');
  const g25 = await must(U.HR, 'POST', `/tax/2025-26/form10e/${E.F}`, { receipt: { totalIncome: 2000000 } });
  ok(g25.worksheet.status === 'INCOMPLETE' && g25.worksheet.result.worksheet.missing.join() === '2024-25' && g25.worksheet.relief === 0, '2024-25 has no rules here: flagged, the worksheet INCOMPLETE');
  const earlierNoRules = g25.worksheet.result.earlier.find((e) => e.year === '2024-25');
  ok(earlierNoRules.how === 'MISSING' && earlierNoRules.rules === false && earlierNoRules.need.includes('taxWith'), 'it asks for the total income and both taxes of 2024-25');
  const selfPut = await must(U.F, 'PUT', '/user/me/form10e/2025-26', { earlier: { '2024-25': { regime: 'OLD', totalIncome: 900000, taxWithout: 15600, taxWith: 16600 } } });
  const w = selfPut.worksheet.result.worksheet;
  ok(selfPut.worksheet.status === 'READY' && selfPut.worksheet.relief === 1080 && w.a === 2080 && w.b === 1000, 'F types 2024-25 (tax 15,600 / 16,600): 2025-26 A = 2,08,000 − 2,05,920 = 2,080; relief 2,080 − 1,000 = 1,080', JSON.stringify(w.rows));
  ok(selfPut.worksheet.inputs.receipt.totalIncome === 2000000, 'what HR typed before is kept when the person adds theirs');
  const selfReceipt = await must(U.F, 'PUT', '/user/me/form10e/2025-26', { earlier: {}, receipt: { totalIncome: 1 } });
  ok(selfReceipt.worksheet.inputs.receipt.totalIncome === 2000000, 'the person cannot change the receipt year’s figure (HR’s)');
  const mineList = await must(U.F, 'GET', '/user/me/form10e');
  ok(mineList.worksheets.length === 2 && mineList.worksheets[0].year === '2026-27' && mineList.worksheets[0].relief === 15600 && /Form No\. 39/.test(mineList.worksheets[0].form) && mineList.worksheets[1].form === 'Form 10E', 'My tax › Forms: F sees both (Form No. 39 for 2026-27, Form 10E for 2025-26)');
  const pdf = await must(U.F, 'GET', '/user/me/form10e/2026-27/file');
  ok(pdf.mimeType === 'application/pdf' && Buffer.from(pdf.contentBase64, 'base64').subarray(0, 5).toString() === '%PDF-' && /^Form39_2026-27_/.test(pdf.fileName), 'the PDF downloads (Form No. 39 layout)', pdf.fileName);
  const pdf10e = await must(U.F, 'GET', '/user/me/form10e/2025-26/file');
  ok(/^Form10E_2025-26_/.test(pdf10e.fileName) && Buffer.from(pdf10e.contentBase64, 'base64').subarray(0, 5).toString() === '%PDF-', 'and Form 10E for 2025-26', pdf10e.fileName);
  const hrPdf = await must(U.HR, 'GET', `/tax/2026-27/form10e/${E.F}/file`);
  ok(Buffer.from(hrPdf.contentBase64, 'base64').length > 1500, 'HR downloads the same');
  const one10 = await must(U.HR, 'GET', `/tax/2026-27/form10e/${E.F}`);
  ok(one10.kept.relief === 15600 && one10.fresh.worksheet.relief === 15600, 'HR’s view: the kept worksheet and a fresh working agree');
  ok((await call(U.A, 'GET', '/user/me/form10e')).json.worksheets.length === 0 && (await call(U.A, 'PUT', '/user/me/form10e/2026-27', { earlier: {} })).status === 404, 'another employee: no worksheet of theirs, cannot make one');
  const noArrears = await call(U.HR, 'POST', `/tax/2026-27/form10e/${E.A}`, {});
  ok(noArrears.status === 409 && noArrears.json.code === 'NO_ARREARS', 'a person without earlier-year arrears: refused, NO_ARREARS');

  /* ══ 7. rights ═══════════════════════════════════════════════════════ */
  section('[7] Rights');
  const st = async (who, method, url, body) => (await call(who, method, url, body)).status;
  const clerkRet = await call(U.CLERK, 'GET', '/payroll/returns/2025-04');
  ok(clerkRet.status === 200 && clerkRet.json.amountsHidden && clerkRet.json.pf.rows.length === 0 && clerkRet.json.pf.members >= 2 && clerkRet.json.pf.totals === null && !JSON.stringify(clerkRet.json.validation).match(/₹\d/),
    'payroll view without pay view: the counts and the checks, no amounts');
  const clerkFile = await call(U.CLERK, 'GET', '/payroll/returns/2025-04/files/ECR');
  ok(clerkFile.status === 403 && clerkFile.json.code === 'PAY_HIDDEN', 'its files: 403 PAY_HIDDEN');
  ok(await st(U.CLERK, 'GET', '/tax/2025-26/perquisites') === 403 && await st(U.CLERK, 'POST', `/tax/2026-27/form10e/${E.F}`, {}) === 403 && await st(U.CLERK, 'GET', '/tax/2026-27/form10e') === 403, 'the register and Form 10E need pay view');
  ok(await st(U.DH, 'GET', '/payroll/returns/2025-04') === 403 && await st(U.A, 'GET', '/payroll/returns/2025-04') === 403 && await st(U.A, 'GET', '/tax/2025-26/perquisites') === 403 && await st(U.F, 'GET', `/tax/2026-27/form10e/${E.F}/file`) === 403,
    'a department head and employees: none of the HR routes (not even their own through them)');
  ok(await st(U.HR, 'DELETE', `/tax/2026-27/form10e/${E.F}`) === 200 && !(await call(U.F, 'GET', '/user/me/form10e')).json.worksheets.some((x) => x.year === '2026-27'), 'HR removes the 2026-27 worksheet: gone from My tax');
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

section('[8] Nothing is left behind');
{
  const after = await worldCount();
  const moved = Object.keys(before).filter((k) => after[k] !== before[k]);
  ok(moved.length === 0, `every count is what it was (${Object.keys(before).length} tables with company_id and deleted_at)`, moved.map((k) => `${k} ${before[k]} -> ${after[k]}`).join('; '));
}

console.log(`\n${passed} passed, ${failed.length} failed  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
