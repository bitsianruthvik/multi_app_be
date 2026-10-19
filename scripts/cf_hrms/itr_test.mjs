/**
 * itr_test.mjs — the ITR helper (TM/CF_HRMS_HIRING_SPEC.md §25.6, P4 option A):
 * services/tax/itr.js (form, return, interest), the return-level rules in the engine,
 * services/itr/* (employer part, JSON against the official schema, PDF), routes/itr.js (privacy).
 *
 * Every expected number is worked out by hand in the comment above its check, from the rules
 * in services/tax/ruleData.js. Y1 = 2025-26 (AY 2026-27, the 1961 Act).
 *   NEW  0–4 L nil · 4–8 L 5% · 8–12 L 10% · 12–16 L 15% …   std 75,000, rebate ≤ 12 L up to 60,000
 *   OLD  below 60: 2.5–5 L 5% (12,500) · 5–10 L 20% (cum 1,12,500) · above 10 L 30%; std 50,000; rebate ≤ 5 L 12,500
 *   Cess 4%. Total income and the tax to ₹10; the balance payable / refund to ₹10.
 *
 *   [0] schema, privacy by construction (no HR route, not in the generic query API)
 *   [1] form selection
 *   [2] hand-worked returns (salary only both regimes; FD + 80TTA old; let-out loss; LTCG new + rebate; refund)
 *   [3] interest 234A/B/C and the late fee
 *   [4] JSON against the official ITR-1 schema; refusals
 *   [5] the routes in one rolled-back transaction: draft, payslips as the employer part, PDF, JSON, privacy (HR 403)
 *   [6] nothing left behind
 *
 *   node scripts/cf_hrms/itr_test.mjs [--company=karni] [--verbose]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cookieParser from 'cookie-parser';
import mysql from 'mysql2/promise';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import hrmsApp from '../../apps/cf_hrms/app.js';
import { forgetAccess } from '../../apps/cf_hrms/lib/accessContext.js';
import { hrmsAppOf } from '../../apps/cf_hrms/services/accessGrants.js';
import { setupAccess } from '../../apps/cf_hrms/services/accessSetup.js';
import * as TAX from '../../apps/cf_hrms/services/tax/index.js';
import * as ITR from '../../apps/cf_hrms/services/tax/itr.js';
import { returnJson, buildItr1 } from '../../apps/cf_hrms/services/itr/itrJson.js';
import { validate } from '../../apps/cf_hrms/services/itr/jsonSchema.js';
import { schemaSteps } from '../../apps/cf_hrms/scripts/apply-itr-schema.mjs';

const slug = (process.argv.find((a) => a.startsWith('--company=')) || '--company=karni').split('=')[1];
const VERBOSE = process.argv.includes('--verbose');
if (!['localhost', '127.0.0.1', '::1'].includes(String(process.env.DB_HOST ?? 'localhost'))) {
  console.error(`Refusing to run against DB_HOST=${process.env.DB_HOST}. This test is local only.`);
  process.exit(2);
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const H = path.resolve(HERE, '../../apps/cf_hrms');

let passed = 0;
const failed = [];
const ok = (cond, name, detail = '') => {
  if (cond) { passed += 1; if (VERBOSE) console.log(`  ok    ${name}`); } else { failed.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  return Boolean(cond);
};
const section = (t) => console.log(`\n${t}`);
const caught = (fn) => { try { fn(); return null; } catch (e) { return e; } };

const Y1 = '2025-26';
const Y2 = '2026-27';
const R1 = { OLD: TAX.rulesFromSeed(Y1, 'OLD'), NEW: TAX.rulesFromSeed(Y1, 'NEW') };
const R2 = { OLD: TAX.rulesFromSeed(Y2, 'OLD'), NEW: TAX.rulesFromSeed(Y2, 'NEW') };
const ret = (parts, { year = Y1, employer = null, today = '2026-07-20' } = {}) => ITR.computeReturn({ year, parts, employer, today }, year === Y1 ? R1 : R2);

// hrms_audit_log is not counted here: other suites and agents write it at any moment. Inside the
// transaction the count is checked instead (a consistent read), in [5].
const TABLES = ['hrms_itr_returns', 'hrms_employees', 'hrms_pay_payslips', 'hrms_pay_runs', 'hrms_pay_run_people', 'users', 'app_user_access'];
const dbCfg = { host: process.env.DB_HOST ?? 'localhost', user: process.env.DB_USER ?? 'root', password: process.env.DB_PASSWORD ?? '1234', database: process.env.DB_NAME ?? 'sqldb', port: Number(process.env.DB_PORT) || 3306 };
async function worldCount() {
  const conn = await mysql.createConnection(dbCfg);
  try {
    const out = {};
    for (const t of TABLES) { const [[r]] = await conn.query(`SELECT COUNT(*) AS n FROM ${t}`); out[t] = Number(r.n); }
    return out;
  } finally { await conn.end(); }
}
const before = await worldCount();

/* ══ 0. schema and privacy by construction ═══════════════════════════════ */
section('[0] Schema; private by construction');
{
  const conn = await mysql.createConnection(dbCfg);
  try {
    ok((await schemaSteps(conn)).length === 0, 'apply-itr-schema: hrms_itr_returns is there, nothing left to do (run it with --apply once)');
    const [[seeded]] = await conn.query("SELECT COUNT(*) AS n FROM hrms_tax_rules WHERE rule_key IN ('itr_forms','interest_234','return_filing','house_property','capital_gains','rebate_special','regime_option','late_fee') AND deleted_at IS NULL");
    ok(Number(seeded.n) === 32, 'the return rules are seeded (8 rules × 2 regimes × 2 years; seed-tax-rules.mjs --apply)', String(seeded.n));
  } finally { await conn.end(); }
  const resDef = fs.readFileSync(path.join(H, 'resourceDef.json'), 'utf8');
  ok(!resDef.includes('hrms_itr_returns') && !/"itr/i.test(resDef), 'hrms_itr_returns is NOT in resourceDef.json — the generic query API cannot read it');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const touching = walk(H).filter((f) => /\.(m?js)$/.test(f) && fs.readFileSync(f, 'utf8').includes('hrms_itr_returns')).map((f) => path.relative(H, f).replace(/\\/g, '/')).sort();
  ok(JSON.stringify(touching) === JSON.stringify(['routes/itr.js', 'scripts/apply-itr-schema.mjs', 'services/itr/itrService.js']), 'only the ITR service reads or writes the table (routes/itr.js names it in its comment; its schema script makes it)', touching.join(', '));
  const routes = fs.readFileSync(path.join(H, 'routes/itr.js'), 'utf8');
  const paths = [...routes.matchAll(/router\.(get|put|post|delete)\('([^']+)'/g)].map((m) => m[2]);
  ok(paths.length === 7 && paths.every((p) => p.startsWith('/user/me/itr')) && (routes.match(/guard\(PERM\.selfView\)/g) ?? []).length === 7 && !/req\.(params|query|body)\.(employee|user)/i.test(routes),
    'every ITR route is /user/me/itr/…, gated on the self view only, and takes no employee id', paths.join(' '));
}

/* ══ 1. which form ═══════════════════════════════════════════════════════ */
section('[1] Which form');
{
  const base = { employer: { grossSalary: 900000 } };
  let r = ret(base);
  ok(r.form.suggested === 'ITR1' && r.form.form === 'ITR1' && r.form.checks.every((c) => c.ok), 'salary only → ITR-1, every condition holds');
  r = ret({ ...base, income: { capitalGains: { ltcg112A: 125000 } } });
  ok(r.form.suggested === 'ITR1', 'LTCG u/s 112A of exactly ₹1,25,000 → still ITR-1');
  r = ret({ ...base, income: { capitalGains: { ltcg112A: 125010 } } });
  ok(r.form.suggested === 'ITR2' && /long-term equity gains up to ₹1,25,000/.test(r.form.reason), 'LTCG u/s 112A of ₹1,25,010 → ITR-2, with the reason', r.form.reason);
  r = ret({ ...base, income: { capitalGains: { stcg111A: 1000 } } });
  ok(r.form.suggested === 'ITR2', 'any short-term gain → ITR-2');
  const hp = (k) => ({ ...base, income: { houseProperties: Array.from({ length: k }, () => ({ kind: 'LET_OUT', rentReceived: 60000 })) } });
  ok(ret(hp(2)).form.suggested === 'ITR1' && ret(hp(3)).form.suggested === 'ITR2', 'two house properties → ITR-1 (AY 2026-27, Notification 45/2026); three → ITR-2');
  ok(ret({ ...base, personal: { agriculturalIncome: 5000 } }).form.suggested === 'ITR1' && ret({ ...base, personal: { agriculturalIncome: 5001 } }).form.suggested === 'ITR2', 'agricultural income ₹5,000 → ITR-1; ₹5,001 → ITR-2');
  ok(ret({ ...base, personal: { residentialStatus: 'RNOR' } }).form.suggested === 'ITR2' && ret({ ...base, personal: { isDirector: true } }).form.suggested === 'ITR2'
    && ret({ ...base, personal: { unlistedShares: true } }).form.suggested === 'ITR2', 'RNOR, a director, unlisted shares → ITR-2');
  ok(ret({ employer: { grossSalary: 5100000 } }).form.suggested === 'ITR2', 'total income above ₹50 lakh → ITR-2');
  const pick = ret({ ...base, choices: { form: 'ITR2' } });
  ok(pick.form.suggested === 'ITR1' && pick.form.form === 'ITR2', 'the person may pick ITR-2 anyway');
  const bad = ret({ ...base, income: { capitalGains: { stcg111A: 1000 } }, choices: { form: 'ITR1' } });
  ok(bad.form.form === 'ITR2' && /ITR-1 cannot be used/.test(bad.form.note), 'ITR-1 picked when a condition fails → ITR-2, with the reason', bad.form.note);
  const y2 = ret(base, { year: Y2, today: '2027-05-01' });
  ok(y2.form.published === false && y2.form.suggested === 'ITR1' && /not published yet/.test(y2.form.formsNote) && y2.interest.dueDate === '2027-07-31',
    '2026-27 (2025 Act): rule 164 conditions, forms not published, due 31 July 2027');
}

/* ══ 2. hand-worked returns ══════════════════════════════════════════════ */
section('[2] Hand-worked returns');
{
  // (a) Salary only, both regimes. Gross 15,00,000, PT 2,400, TDS 97,500 (typed).
  //   NEW: 15,00,000 − 75,000 = 14,25,000; slab 20,000 + 40,000 + 2,25,000×15% 33,750 = 93,750; cess 3,750; total 97,500.
  //   OLD: 15,00,000 − 50,000 − 2,400 = 14,47,600; 1,12,500 + 4,47,600×30% 1,34,280 = 2,46,780; cess 9,871; 2,56,651 → 2,56,650.
  //   The cheaper is NEW; TDS 97,500 = the tax → nothing to pay, no refund; no interest (assessed 0).
  const a = ret({ employer: { grossSalary: 1500000, professionalTax: 2400, tds: 97500 } });
  ok(a.new.taxableIncome === 1425000 && a.new.totalTax === 97500 && a.old.taxableIncome === 1447600 && a.old.totalTax === 256650,
    '(a) salary only: NEW 97,500, OLD 2,56,650', `${a.new.totalTax} ${a.old.totalTax}`);
  ok(a.regime === 'NEW' && a.payable === 0 && a.refund === 0 && a.interest.total === 0 && a.form.form === 'ITR1', '(a) files NEW (cheaper), nothing to pay, no interest, ITR-1');
  ok(a.salary.grossSalary.source === 'TYPED' && a.salary.tds.source === 'TYPED', '(a) no payslips → the figures are "typed by you"');

  // (b) Salary 8,00,000 + savings interest 18,000 + FD 30,000, 80C 1,50,000, TDS 20,000, OLD regime, filed 20 Jul 2026.
  //   Salary 8,00,000 − 50,000 = 7,50,000; other sources 48,000; GTI 7,98,000.
  //   80C 1,50,000 + 80TTA min(18,000, 10,000) = 10,000 (the FD interest does not count) → 1,60,000; total income 6,38,000.
  //   Tax 12,500 + 1,38,000×20% 27,600 = 40,100 (above 5 L: no rebate); cess 1,604; 41,704 → 41,700.
  const b = ret({ employer: { grossSalary: 800000, tds: 20000 }, income: { savingsInterest: 18000, depositInterest: 30000 }, deductions: { '80C': 150000 }, choices: { regime: 'OLD', filingDate: '2026-07-20' } });
  const tta = b.old.deductions.find((d) => d.key === 'ded_80tta');
  ok(b.regime === 'OLD' && b.old.otherIncome === 48000 && tta?.allowed === 10000 && b.old.totalDeductions === 160000 && b.old.taxableIncome === 638000 && b.old.totalTax === 41700,
    '(b) FD + savings interest, 80TTA 10,000 on savings only, OLD total 41,700', `${tta?.allowed} ${b.old.taxableIncome} ${b.old.totalTax}`);
  ok(b.new.refused.some((x) => x.key === 'ded_80tta' && x.amount === 18000) && b.new.refused.some((x) => x.key === 'ded_80c'), '(b) the new regime refuses 80TTA and 80C, with the amounts');
  //   Interest (assessed tax 41,700 − 20,000 = 21,700 ≥ 10,000, no advance tax):
  //   234C 15% 3,255 → 3,200 × 3% = 96; 45% 9,765 → 9,700 × 3% = 291; 75% 16,275 → 16,200 × 3% = 486; 100% 21,700 × 1% = 217 → 1,090.
  //   234B 21,700 × 1% × 4 months (Apr–Jul) = 868. Not late: no 234A, no fee.
  //   Balance 41,700 + 1,090 + 868 − 20,000 = 23,658 → 23,660 payable.
  ok(b.interest.c === 1090 && b.interest.b === 868 && b.interest.a === 0 && b.interest.fee === 0 && b.payable === 23660,
    '(b) 234C 1,090, 234B 868, payable 23,660', `${b.interest.c} ${b.interest.b} ${b.payable}`);

  // (c) Let-out property with a loss. Salary 12,00,000; rent 1,20,000, municipal tax 10,000, interest 4,00,000.
  //   NAV 1,10,000; 30% 33,000; income 1,10,000 − 33,000 − 4,00,000 = −3,23,000.
  //   OLD: set off 2,00,000, carry forward 1,23,000; salary 11,50,000; GTI 9,50,000;
  //        tax 12,500 + 4,50,000×20% = 1,02,500; cess 4,100; 1,06,600. Form: ITR-2 (a loss carried forward).
  //   NEW: no set-off and nothing carried (115BAC(2)(ii)(b), (3)); salary 11,25,000 ≤ 12 L → slab 52,500, rebate → 0.
  const c = ret({ employer: { grossSalary: 1200000 }, income: { houseProperties: [{ kind: 'LET_OUT', rentReceived: 120000, municipalTaxPaid: 10000, interest: 400000 }] }, choices: { regime: 'OLD' } });
  const h = c.old.houseProperties[0];
  ok(h.netAnnualValue === 110000 && h.standardDeduction === 33000 && h.income === -323000 && c.old.houseProperty === -200000 && c.old.hpLossCarriedForward === 123000 && c.old.totalTax === 106600,
    '(c) OLD: loss 3,23,000, 2,00,000 set off, 1,23,000 carried forward, tax 1,06,600', `${h.income} ${c.old.houseProperty} ${c.old.hpLossCarriedForward} ${c.old.totalTax}`);
  ok(c.new.houseProperty === 0 && c.new.hpLossCarriedForward === 0 && c.new.taxableIncome === 1125000 && c.new.totalTax === 0 && c.new.lines.some((l) => /deemed to have been given full effect/.test(l.label)),
    '(c) NEW: the loss is not set off and lapses; tax 0', `${c.new.taxableIncome} ${c.new.totalTax}`);
  ok(c.form.suggested === 'ITR2' && /carried forward/.test(c.form.reason), '(c) a loss carried forward → ITR-2');
  ok(c.schedules.HP.length === 1 && c.schedules.HP[0].rows.find((x) => /30%/.test(x.label)).amount === -33000, '(c) Schedule HP shows the 30% line');

  // (d) Equity LTCG over the exemption, NEW regime, the rebate rule.
  //   Salary 9,75,000 − 75,000 = 9,00,000 (normal income); LTCG 112A 2,25,000; total income 11,25,000 (≤ 12 L).
  //   Slab tax on 9,00,000: 20,000 + 10,000 = 30,000. 112A: (2,25,000 − 1,25,000) × 12.5% = 12,500.
  //   Rebate: up to 60,000 but never above the tax at the slab rates (87A 2nd proviso) → 30,000.
  //   Tax 12,500; cess 500; total 13,000. ITR-2 (LTCG above 1.25 L).
  const d = ret({ employer: { grossSalary: 975000 }, income: { capitalGains: { ltcg112A: 225000 } } });
  ok(d.new.normalIncome === 900000 && d.new.slabTax === 30000 && d.new.specialRateTax === 12500 && d.new.rebate === 30000 && d.new.totalTax === 13000 && d.form.suggested === 'ITR2',
    '(d) NEW: rebate 30,000 covers the slab tax only; the 12,500 on 112A gains stays → 13,000', `${d.new.slabTax} ${d.new.specialRateTax} ${d.new.rebate} ${d.new.totalTax}`);
  //   OLD on the same: salary 9,25,000 normal; slab 12,500 + 4,25,000×20% = 97,500; 112A 12,500; total income 11,50,000 > 5 L: no rebate;
  //   1,10,000 + cess 4,400 = 1,14,400.
  ok(d.old.slabTax === 97500 && d.old.specialRateTax === 12500 && d.old.rebate === 0 && d.old.totalTax === 114400, '(d) OLD: 1,14,400', `${d.old.totalTax}`);
  //   (d2) Unused nil slab: salary 3,75,000 NEW → normal 3,00,000; LTCG 112A 3,00,000; STCG 111A 50,000. Total income 6,50,000.
  //   Shortfall 4,00,000 − 3,00,000 = 1,00,000: first against 111A (50,000 → 0), then 50,000 off the 112A gain above 1.25 L
  //   (1,75,000 → 1,25,000) × 12.5% = 15,625. Slab tax 0; the rebate covers no special-rate tax → 15,625 + cess 625 = 16,250.
  const d2 = ret({ employer: { grossSalary: 375000 }, income: { capitalGains: { ltcg112A: 300000, stcg111A: 50000 } } });
  ok(d2.new.capitalGains.shortfall === 100000 && d2.new.capitalGains.special.stcg111A.tax === 0 && d2.new.capitalGains.special.ltcg112A.taxable === 125000 && d2.new.totalTax === 16250,
    '(d2) the unused nil slab comes off the 20% gains first, then 12.5%; no rebate on special rates → 16,250', `${JSON.stringify(d2.new.capitalGains.special)} ${d2.new.totalTax}`);
  //   (d3) OLD regime, total income ≤ 5 L: the rebate covers 111A tax but not 112A tax (112A(6)).
  //   Salary 3,00,000 − 50,000 = 2,50,000 normal; STCG 1,00,000; LTCG 112A 1,45,000; total income 4,95,000.
  //   Shortfall 0 (normal = the nil limit 2,50,000). 111A 20,000; 112A (20,000 × 12.5%) 2,500. Rebate min(12,500, 20,000) = 12,500.
  //   Tax 22,500 − 12,500 = 10,000; cess 400; 10,400.
  const d3 = ret({ employer: { grossSalary: 300000 }, income: { capitalGains: { stcg111A: 100000, ltcg112A: 145000 } }, choices: { regime: 'OLD' } });
  ok(d3.old.taxableIncome === 495000 && d3.old.rebatableTax === 20000 && d3.old.rebate === 12500 && d3.old.totalTax === 10400, '(d3) OLD ≤ 5 L: rebate 12,500 against 111A tax, not 112A → 10,400', `${d3.old.rebatableTax} ${d3.old.rebate} ${d3.old.totalTax}`);

  // (e) A TDS refund. Salary 10,00,000 NEW: 9,25,000; slab 32,500; rebate 32,500 → 0. TDS 25,000 + bank TDS 1,000 → refund 26,000.
  const e = ret({ employer: { grossSalary: 1000000, tds: 25000 }, income: { depositInterest: 10000 }, taxes: { otherTds: [{ kind: 'TDS', deductor: 'Bank', amount: 1000, income: 10000 }] } });
  ok(e.new.totalTax === 0 && e.prepaid.total === 26000 && e.refund === 26000 && e.payable === 0 && /refund of ₹26,000/.test(e.sentence), '(e) tax 0, TDS 26,000 → refund 26,000', `${e.new.totalTax} ${e.refund}`);
  ok(e.schedules.TDS.length === 2 && e.schedules.BTTI.at(-1).label === 'Refund', '(e) the TDS schedule lists both deductors; B-TTI ends with the refund');

  // Employer part from payroll: the figures are "from your employer" unless the person types over them.
  const emp = { months: 6, employerName: 'Karni Ltd', grossSalary: 600000, professionalTax: 1200, tds: 5000 };
  const f = ret({ employer: { grossSalary: 999999 } }, { employer: emp });
  ok(f.salary.grossSalary.value === 600000 && f.salary.grossSalary.source === 'EMPLOYER' && f.salary.tds.source === 'EMPLOYER' && f.salary.employerName === 'Karni Ltd', 'payslips → gross, PT, TDS "from your employer" (a typed value does not override)');
  const g = ret({ employer: { useTyped: true, grossSalary: 650000, tds: 6000 } }, { employer: emp });
  ok(g.salary.grossSalary.value === 650000 && g.salary.grossSalary.source === 'TYPED', '"type my Form 16 figures instead" → typed');
  // The old regime after the due date: refused, the new regime applies.
  const late = ret({ employer: { grossSalary: 1500000 }, choices: { regime: 'OLD', filingDate: '2026-09-15' } });
  ok(late.regime === 'NEW' && late.warnings.some((w) => /only in a return filed by 2026-07-31/.test(w)), 'the old regime picked for a late return → the new regime, with the reason');
}

/* ══ 3. interest ════════════════════════════════════════════════════════ */
section('[3] Interest 234A / 234B / 234C and the fee');
{
  // Assessed tax 1,00,000 (tax 1,50,000 − TDS 50,000). Advance: 20,000 on 10 Jun, 30,000 on 10 Sep 2025.
  //   234C: Jun 20,000 ≥ 12% → 0; Sep 50,000 ≥ 36% → 0; Dec 75,000 − 50,000 = 25,000 × 3% = 750; Mar 50,000 × 1% = 500 → 1,250.
  //   234B: 50,000 < 90,000 → 50,000 × 1% × 4 (filed 31 Jul 2026) = 2,000. On time: no 234A.
  const i1 = ITR.interestEstimate({ taxOnIncome: 150000, tdsTcs: 50000, advance: [{ date: '2025-06-10', amount: 20000 }, { date: '2025-09-10', amount: 30000 }], filingDate: '2026-07-31', totalIncome: 1500000 }, R1.NEW, Y1);
  ok(i1.c === 1250 && i1.b === 2000 && i1.a === 0 && i1.fee === 0, '234C 1,250 and 234B 2,000 with two instalments paid', `${i1.c} ${i1.b} ${i1.a}`);
  //   Same, filed 15 Sep 2026 with 10,000 self-assessment tax paid on 5 Aug 2026:
  //   234B: Apr–Aug outstanding 50,000 (Aug starts before the payment) × 5 = 2,500; Sep 40,000 × 1% = 400 → 2,900.
  //   234A: from 1 Aug: base 1,00,000 − 50,000 = 50,000; Aug 500; from 1 Sep 40,000 → 400 → 900. Fee 5,000.
  const i2 = ITR.interestEstimate({ taxOnIncome: 150000, tdsTcs: 50000, advance: [{ date: '2025-06-10', amount: 20000 }, { date: '2025-09-10', amount: 30000 }], selfAssessment: [{ date: '2026-08-05', amount: 10000 }], filingDate: '2026-09-15', totalIncome: 1500000 }, R1.NEW, Y1);
  ok(i2.b === 2900 && i2.a === 900 && i2.fee === 5000 && i2.late, 'late: 234B 2,900, 234A 900, fee 5,000', `${i2.b} ${i2.a} ${i2.fee}`);
  const i3 = ITR.interestEstimate({ taxOnIncome: 150000, tdsTcs: 145000, filingDate: '2026-07-31', totalIncome: 1500000 }, R1.NEW, Y1);
  ok(i3.b === 0 && i3.c === 0 && i3.notes.some((n) => /below ₹10,000/.test(n)), 'tax after TDS below ₹10,000 → no 234B / 234C');
  const i4 = ITR.interestEstimate({ taxOnIncome: 150000, tdsTcs: 50000, filingDate: '2026-07-31', totalIncome: 1500000, exemptFromAdvanceTax: true }, R1.NEW, Y1);
  ok(i4.b === 0 && i4.c === 0 && i4.notes.some((n) => /senior citizen/.test(n)), 'a resident senior with no business income → no advance tax, no 234B / 234C');
  const i5 = ITR.interestEstimate({ taxOnIncome: 0, tdsTcs: 0, filingDate: '2026-08-10', totalIncome: 450000 }, R1.NEW, Y1);
  ok(i5.fee === 1000, 'late with total income ≤ ₹5 lakh → fee ₹1,000');
  ok(ITR.monthsOrPart('2026-04-01', '2026-07-31') === 4 && ITR.monthsOrPart('2026-08-01', '2026-08-01') === 1 && ITR.monthsOrPart('2026-08-01', '2026-09-01') === 2, 'months or part of a month');
}

/* ══ 4. JSON ═════════════════════════════════════════════════════════════ */
section('[4] JSON against the official ITR-1 schema (AY 2026-27 V1.1)');
const FULL_PARTS = {
  personal: { residentialStatus: 'RESIDENT', dateOfBirth: '1990-05-01', fatherName: 'Ramesh Kumar', mobile: '9876543210', email: 'test@example.test', employerCategory: 'OTH', address: { flat: '12-3', area: 'Ameerpet', city: 'Hyderabad', stateCode: '36', pinCode: '500016' } },
  // HRA: worked out from the rent (Schedule 10(13A)): Basic 6,00,000, HRA received 2,40,000, rent 1,60,000, Hyderabad
  // (not a 50% city in 2025-26) → least of 2,40,000; 1,60,000 − 60,000 = 1,00,000; 40% × 6,00,000 = 2,40,000 → 1,00,000.
  employer: { grossSalary: 1500000, professionalTax: 2400, tds: 90000, exemptHra: 100000, tan: 'HYDK12345A', employerName: 'Test employer', basic: 600000, da: 0 },
  income: { savingsInterest: 15000, depositInterest: 40000, houseProperties: [{ kind: 'LET_OUT', name: 'Flat 2', rentReceived: 240000, municipalTaxPaid: 5000, interest: 100000 }], capitalGains: { ltcg112A: 100000, ltcg112ASale: 500000, ltcg112ACost: 400000 } },
  deductions: {
    '80C': 150000, '80CItems': [{ description: 'PPF', documentNo: 'PPF00012345', amount: 100000 }, { description: 'LIC premium', documentNo: 'LIC987654321', amount: 50000 }],
    '80D': { selfFamily: 20000, policies: [{ for: 'SELF_FAMILY', insurer: 'Test Health Insurance', policyNo: 'P/2025/0001', amount: 20000 }] },
    hra: { placeOfWork: 'Hyderabad', rentPaid: 160000, received: 240000 },
  },
  taxes: { paid: [{ kind: 'SELF_ASSESSMENT', bsrCode: '0510308', date: '2026-07-20', challanNo: '12345', amount: 5000 }], otherTds: [{ kind: 'TDS', deductor: 'Bank', tan: 'HYDS12345B', section: '194A', income: 40000, amount: 4000 }] },
  bank: { bankName: 'Test bank', ifsc: 'SBIN0001234', account: '12345678901', type: 'SAVINGS' },
  choices: { regime: 'OLD', filingDate: '2026-07-25' },
};
{
  const full = (parts, year = Y1) => ({ year, result: ret(parts, { year }), parts, draft: { personal: parts.personal ?? {} }, personFull: { name: 'Asha Rani Kumar', pan: 'ABCDE1234F' } });
  const out = returnJson(full(FULL_PARTS), { today: '2026-07-25' });
  const it = out.json.ITR.ITR1;
  ok(out.version.startsWith('V1.1') && out.fileName === 'ABCDE1234F_ITR-1_AY2026-27.json', 'an ITR-1 return → a JSON file, schema V1.1', out.fileName);
  //   Hand-worked (OLD): salary 15,00,000 − HRA 1,00,000 − 50,000 − 2,400 = 13,47,600; HP 2,35,000 − 70,500 − 1,00,000 = 64,500;
  //   OS 55,000; LTCG 1,00,000 (within 1.25 L, ITR-1); GTI incl. LTCG 15,67,100; VI-A 1,50,000 + 20,000 + 10,000 = 1,80,000; total income 13,87,100.
  ok(it.ITR1_IncomeDeductions.IncomeFromSal === 1347600 && it.ITR1_IncomeDeductions.TotalIncomeChargeableUnHP === 64500 && it.ITR1_IncomeDeductions.GrossTotIncomeIncLTCG112A === 1567100
    && it.ITR1_IncomeDeductions.GrossTotIncome === 1467100 && it.ITR1_IncomeDeductions.TotalIncome === 1387100 && it.ITR1_IncomeDeductions.DeductUndChapVIA.TotalChapVIADeductions === 180000
    && it.FilingStatus.OptOutNewTaxRegime === 'Y' && it.FilingStatus.ReturnFileSec === 11 && it.TDSonOthThanSals.TDSonOthThanSal[0].TDSSection === '94A' && it.CreationInfo.SWCreatedBy === 'SW00000000',
  'the JSON carries the hand-worked figures (salary 13,47,600, HP 64,500, total income 13,87,100); 194A → "94A"; no software id is claimed', JSON.stringify(it.ITR1_IncomeDeductions).slice(0, 300));
  const schema = JSON.parse(fs.readFileSync(path.join(H, 'services/itr/schema/ITR-1_AY2026-27_V1.1.json'), 'utf8'));
  ok(validate(schema, out.json).length === 0, 'the JSON validates against the vendored official schema');
  // The validator really validates: a TAN of no TAN city, a missing block, a wrong type.
  const broken = JSON.parse(JSON.stringify(out.json));
  broken.ITR.ITR1.TDSonSalaries.TDSonSalary[0].EmployerOrDeductorOrCollectDetl.TAN = 'ABCD12345E';
  delete broken.ITR.ITR1.Verification;
  broken.ITR.ITR1.ITR1_IncomeDeductions.GrossSalary = '1500000';
  broken.ITR.ITR1.Extra = 1;
  const errs = validate(schema, broken).map((x) => `${x.path} ${x.message}`);
  ok(errs.some((x) => /TAN does not match/.test(x)) && errs.some((x) => /Verification is required/.test(x)) && errs.some((x) => /GrossSalary must be integer/.test(x)) && errs.some((x) => /Extra is not allowed/.test(x)),
    'the validator catches a bad TAN, a missing block, a wrong type and an unknown field', errs.join(' | '));
  const sch = JSON.parse(JSON.stringify(schema)); sch.definitions.ITR.if = {};
  ok(caught(() => validate(sch, {}))?.message.includes('does not know: if'), 'a schema keyword the validator does not know → refused loudly');
  const e1 = caught(() => returnJson(full({ ...FULL_PARTS, personal: { residentialStatus: 'RESIDENT' } })));
  ok(e1?.code === 'NEEDS_MORE' && e1.status === 422 && /father's name/.test(e1.message) && /mobile/.test(e1.message), 'missing personal details → 422 NEEDS_MORE, in words', e1?.message);
  const e2 = caught(() => returnJson(full({ ...FULL_PARTS, employer: { ...FULL_PARTS.employer, tan: 'ABCD12345E' } })));
  ok(e2?.code === 'SCHEMA_INVALID' && e2.status === 422 && e2.problems?.some((p) => /TAN/.test(p)), 'output that fails the schema → 422 SCHEMA_INVALID, not given out', JSON.stringify(e2?.problems));
  const e3 = caught(() => returnJson(full({ ...FULL_PARTS, income: { ...FULL_PARTS.income, capitalGains: { stcg111A: 1000 } } })));
  ok(e3?.code === 'NO_SCHEMA' && e3.status === 409 && /ITR-1 only/.test(e3.message), 'an ITR-2 return → 409 NO_SCHEMA (ITR-2 JSON not built)', e3?.message);
  const e4 = caught(() => returnJson(full(FULL_PARTS, Y2)));
  ok(e4?.code === 'NO_SCHEMA' && /not published yet/.test(e4.message), '2026-27 → 409 NO_SCHEMA (no form or schema published)', e4?.message);
  const n = buildItr1(full({ ...FULL_PARTS, income: { capitalGains: { ltcg112A: 50000 } } }));
  ok(n.missing?.some((m) => /sale value and cost/.test(m)), 'LTCG 112A without the sale value and cost → asked for');

  /* The deduction schedules (CBDT ITR-1 AY 2026-27 validation rules, Category A, old regime). */
  const ID = it.ITR1_IncomeDeductions;
  ok(it.Schedule80C?.TotalAmt === 150000 && it.Schedule80C.Schedule80CDtls.length === 2 && it.Schedule80C.Schedule80CDtls[0].IdentificationNo === 'PPF00012345' && ID.UsrDeductUndChapVIA.Section80C === 150000,
    'Schedule 80C: two lines with their document numbers, total 1,50,000 = the 80C claimed in VI-A (rules 241, 247)', JSON.stringify(it.Schedule80C));
  const h80 = it.Schedule80D?.Sec80DSelfFamSrCtznHealth;
  ok(h80?.SeniorCitizenFlag === 'N' && h80.SelfAndFamily === 20000 && h80.HealthInsPremSlfFam === 20000 && h80.Sec80DSelfFamHIDtls.Sch80DInsDtls[0].PolicyNo === 'P/2025/0001'
    && h80.ParentsSeniorCitizenFlag === 'P' && h80.EligibleAmountOfDedn === 20000 && ID.UsrDeductUndChapVIA.Section80D === 20000,
  'Schedule 80D: not a senior, 1a = 20,000 with the insurer and policy, parents not claimed, eligible 20,000 = VI-A (rules 138, 256)', JSON.stringify(h80));
  const ea = it.ScheduleEA10_13A;
  ok(ea?.Placeofwork === '2' && ea.ActlHRARecv === 240000 && ea.ActlRentPaid === 160000 && ea.BasicSalary === 600000 && ea.ActlRentPaid10Per === 100000 && ea.Sal40Or50Per === 240000
    && ea.EligbleExmpAllwncUs13A === 100000 && ea.DtlsSalUsSec171 === 1500000 && ID.AllwncExemptUs10.AllwncExemptUs10Dtls.find((x) => x.SalNatureDesc === '10(13A)')?.SalOthAmount === 100000,
  'Schedule 10(13A): non-metro, rent − 10% 1,00,000, 40% 2,40,000 → 1,00,000 = the 10(13A) exempt in Schedule S (rule 269)', JSON.stringify(ea));
  const noItems = buildItr1(full({ ...FULL_PARTS, deductions: { ...FULL_PARTS.deductions, '80CItems': [] } }));
  const noHra = buildItr1(full({ ...FULL_PARTS, deductions: { ...FULL_PARTS.deductions, hra: {} } }));
  const noPol = buildItr1(full({ ...FULL_PARTS, deductions: { ...FULL_PARTS.deductions, '80D': { selfFamily: 20000 } } }));
  ok(noItems.missing?.some((m) => /Schedule 80C/.test(m)) && noHra.missing?.some((m) => /Schedule 10\(13A\)/.test(m)) && noPol.missing?.some((m) => /Schedule 80D/.test(m)),
    'old regime: 80C without its lines, HRA without the rent, 80D without the policy → the JSON asks for them', JSON.stringify([noItems.missing, noHra.missing, noPol.missing]));
  const neu = returnJson(full({ ...FULL_PARTS, choices: { regime: 'NEW', filingDate: '2026-07-25' } }), { today: '2026-07-25' }).json.ITR.ITR1;
  ok(!neu.Schedule80C && !neu.Schedule80D && !neu.ScheduleEA10_13A && !neu.ITR1_IncomeDeductions.AllwncExemptUs10.AllwncExemptUs10Dtls?.some((x) => x.SalNatureDesc === '10(13A)'),
    'new regime: no 80C / 80D / 10(13A) schedule and no HRA exemption (rules 156, 165, 173, 255)');

  // 80E and 80G with their schedules (old regime). Donation to a 100%-without-limit fund 10,000 by NEFT;
  // to a trust (50% subject to the qualifying limit) 4,000 by UPI and 1,500 in cash (cash ≤ 2,000) → 2,750.
  // 80G eligible 12,750; 80E interest 30,000.
  const P2 = { ...FULL_PARTS, deductions: { ...FULL_PARTS.deductions,
    '80ELoans': [{ lenderType: 'B', lender: 'Test Bank', loanAccount: 'EDU/123-45', loanDate: '2021-06-01', loanAmount: 800000, outstanding: 450000, interest: 30000 }],
    '80GDonations': [
      { name: 'PM National Relief Fund', pan: 'AAAGP0685F', address: 'South Block', city: 'New Delhi', stateCode: '09', pinCode: '110011', category: 'NO_LIMIT_100', otherMode: 10000, ifsc: 'SBIN0001234', transactionRef: 'NEFT1234' },
      { name: 'Test Trust', pan: 'AAATT1234T', address: '1 Main Road', city: 'Hyderabad', stateCode: '36', pinCode: '500001', category: 'LIMIT_50', otherMode: 4000, cash: 1500, ifsc: 'HDFC0000123', transactionRef: 'UPI998877' },
    ] } };
  const out2 = returnJson(full(P2), { today: '2026-07-25' });
  const it2 = out2.json.ITR.ITR1;
  ok(validate(schema, out2.json).length === 0 && it2.Schedule80E?.TotalInterest80E === 30000 && it2.ITR1_IncomeDeductions.UsrDeductUndChapVIA.Section80E === 30000
    && it2.Schedule80G?.Don100Percent?.TotEligibleDon100Percent === 10000 && it2.Schedule80G.Don50PercentApprReqd?.TotEligibleDon50PercentApprReqd === 2750
    && it2.Schedule80G.TotalDonationsUs80G === 15500 && it2.Schedule80G.TotalEligibleDonationsUs80G === 12750 && it2.ITR1_IncomeDeductions.DeductUndChapVIA.Section80G === 12750,
  'Schedules 80E (30,000) and 80G (10,000 at 100% + 5,500 at 50% = 12,750 eligible) = VI-A, and the JSON validates', JSON.stringify(it2.Schedule80G));
  const cashy = ITR.donationsWorked([{ pan: 'AAATT1234T', category: 'NO_LIMIT_100', cash: 1500, otherMode: 0 }, { pan: 'AAATT1234T', category: 'NO_LIMIT_100', cash: 1000, otherMode: 500 }]);
  ok(cashy[0].eligible === 0 && cashy[1].eligible === 500 && cashy.every((x) => x.cashRefused), 'cash to one donee above ₹2,000 in all is not counted (80G(5D), rules 88 / 327)', JSON.stringify(cashy.map((x) => x.eligible)));
  const noRef = buildItr1(full({ ...P2, deductions: { ...P2.deductions, '80GDonations': [{ ...P2.deductions['80GDonations'][0], ifsc: null }] } }));
  ok(noRef.missing?.some((m) => /IFSC and the transaction reference/.test(m)), 'a non-cash donation without the IFSC and reference → asked for (rule 325)');

  // Deductions above the gross total income: the VI-A parts still add up to the total.
  //   OLD, salary 2,00,000 − 50,000 = GTI 1,50,000. 80C 1,50,000 + 80D 25,000 + 80E 10,000 = 1,85,000 → cut to 1,50,000.
  //   Filled in the order of Chapter VI-A: 80C 1,50,000, then 80D 0, 80E 0 (the later ones are cut first).
  const P3 = { ...FULL_PARTS, employer: { grossSalary: 200000, tan: 'HYDK12345A', employerName: 'Test employer', basic: 100000 }, income: {}, taxes: {},
    deductions: { '80CItems': [{ description: 'PPF', documentNo: 'PPF00012345', amount: 150000 }], '80D': { policies: [{ for: 'SELF_FAMILY', insurer: 'Test Health', policyNo: 'P1', amount: 25000 }] },
      '80ELoans': [{ lenderType: 'B', lender: 'Test Bank', loanAccount: 'EDU1', loanDate: '2021-06-01', loanAmount: 100000, outstanding: 50000, interest: 10000 }] } };
  const out3 = returnJson(full(P3), { today: '2026-07-25' });
  const v3 = out3.json.ITR.ITR1.ITR1_IncomeDeductions.DeductUndChapVIA;
  const sumParts = Object.entries(v3).filter(([k]) => k !== 'TotalChapVIADeductions').reduce((a, [, x]) => a + x, 0);
  ok(v3.TotalChapVIADeductions === 150000 && sumParts === 150000 && v3.Section80C === 150000 && v3.Section80D === 0 && v3.Section80E === 0 && validate(schema, out3.json).length === 0,
    'deductions 1,85,000 above the GTI 1,50,000: VI-A parts 80C 1,50,000 / 80D 0 / 80E 0 add up to the total 1,50,000 (later ones cut first)', JSON.stringify(v3));
  const r3 = ret(P3);
  ok(r3.schedules.VIA.slice(0, -1).reduce((a, x) => a + x.amount, 0) === r3.old.totalDeductions, 'the summary\'s Schedule VI-A rows add up to its total too');
}

/* ══ 4b. 80CCD(2): the limit is a share of Basic + DA, never of the gross ══ */
section('[4b] 80CCD(2) on Basic + DA');
{
  // Gross 20,00,000; Basic 8,00,000 + DA 2,00,000 = 10,00,000; employer NPS 2,00,000.
  //   NEW: at most 14% of 10,00,000 = 1,40,000 (14% of the gross would have allowed all 2,00,000).
  //        20,00,000 − 75,000 − 1,40,000 = 17,85,000; slab 1,20,000 + 1,85,000 × 20% = 1,57,000; cess 6,280 → 1,63,280.
  //   OLD: at most 10% (not a government employer) = 1,00,000.
  const a = ret({ employer: { grossSalary: 2000000, employerNps: 200000, basic: 800000, da: 200000 } });
  const nNps = a.new.deductions.find((d) => d.key === 'ded_80ccd2');
  const oNps = a.old.deductions.find((d) => d.key === 'ded_80ccd2');
  ok(nNps?.allowed === 140000 && oNps?.allowed === 100000 && a.new.taxableIncome === 1785000 && a.new.totalTax === 163280 && a.salary.basicDa.value === 1000000,
    'NEW 14% / OLD 10% of Basic + DA 10,00,000 → 1,40,000 / 1,00,000; NEW tax 1,63,280', `${nNps?.allowed} ${oNps?.allowed} ${a.new.totalTax}`);
  // From payslips: Basic 5,00,000 + DA 1,00,000 → NEW limit 84,000; nothing typed.
  const b = ret({ employer: { employerNps: 100000 } }, { employer: { months: 12, employerName: 'Karni Ltd', grossSalary: 1200000, basic: 500000, da: 100000, hraReceived: 0 } });
  ok(b.salary.basicDa.value === 600000 && b.salary.basicDa.source === 'EMPLOYER' && b.new.deductions.find((d) => d.key === 'ded_80ccd2')?.allowed === 84000,
    'Basic + DA from the released payslips (6,00,000) → NEW limit 84,000', JSON.stringify(b.salary.basicDa));
  const c = ret({ employer: { grossSalary: 2000000, employerNps: 200000 } });
  ok(c.new.deductions.find((d) => d.key === 'ded_80ccd2')?.allowed === 0 && c.warnings.some((w) => /Basic \+ DA, which is not known/.test(w)),
    'no Basic + DA known → 80CCD(2) counts 0 and the return says to type them (the gross is never used)');
}

/* ══ 5. the routes (one transaction, rolled back) ═══════════════════════ */
section('[5] The routes: draft, employer part, PDF, JSON, privacy');
const real = { query: pool.query.bind(pool), execute: pool.execute.bind(pool), getConnection: pool.getConnection.bind(pool) };
const db = await real.getConnection();
await db.beginTransaction();
let depth = 0;
const inside = {
  query: (...a) => db.query(...a),
  execute: (...a) => db.execute(...a),
  beginTransaction: async () => { depth += 1; await db.query(`SAVEPOINT zz_itr_${depth}`); },
  commit: async () => { if (depth > 0) { await db.query(`RELEASE SAVEPOINT zz_itr_${depth}`); depth -= 1; } },
  rollback: async () => { if (depth > 0) { await db.query(`ROLLBACK TO SAVEPOINT zz_itr_${depth}`); depth -= 1; } },
  release: () => {},
};
pool.query = inside.query;
pool.execute = inside.execute;
pool.getConnection = async () => inside;
const TAG = `ZZITR${Date.now().toString(36).toUpperCase().slice(-5)}`;
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
  await setupAccess(db, COMPANY, { apply: true });
  const roleByKey = Object.fromEntries((await q('SELECT role_id, template_key FROM hrms_access_roles WHERE company_id = ? AND deleted_at IS NULL AND template_key IS NOT NULL', [COMPANY])).map((r) => [r.template_key, r.role_id]));
  const emp = (code, name) => ins("INSERT INTO hrms_employees (company_id, employee_code, full_name, date_of_joining, date_of_birth) VALUES (?, ?, ?, '2020-01-01', '1990-05-01')", [COMPANY, `${TAG}${code}`, `${TAG} ${name}`]);
  const E = { a: await emp('A', 'Asha'), b: await emp('B', 'Bala'), h: await emp('H', 'Hari') };
  const login = async (label, roleId, employeeId = null) => {
    const email = `${TAG.toLowerCase()}.${label.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.test`;
    const id = await ins('INSERT INTO users (name, email, password, role_id, team_id, company_id) VALUES (?, ?, ?, ?, NULL, ?)', [`${TAG} ${label}`, email, 'x', roleId, COMPANY]);
    await db.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [id, app.id, roleId, COMPANY]);
    if (employeeId) await db.query('UPDATE hrms_employees SET user_id = ? WHERE id = ?', [id, employeeId]);
    const roleName = (await one('SELECT name FROM roles WHERE id = ?', [roleId])).name;
    return { id, token: signToken({ id, name: `${TAG} ${label}`, email, role: roleName, company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
  };
  const U = { A: await login('Employee A', roleByKey.EMPLOYEE, E.a), B: await login('Employee B', roleByKey.EMPLOYEE, E.b), HR: await login('HR manager', roleByKey.HR_MANAGER), HRL: await login('HR linked', roleByKey.HR_MANAGER, E.h) };
  const O = { id: owner.id, token: signToken({ id: owner.id, name: owner.name, email: owner.email, role: 'admin', company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
  const ownerLinked = await one('SELECT id FROM hrms_employees WHERE company_id = ? AND user_id = ? AND deleted_at IS NULL', [COMPANY, owner.id]);

  // A released payslip of employee A in 2025-26 (the employer part comes from it).
  const runId = await ins("INSERT INTO hrms_pay_runs (company_id, period_month, status) VALUES (?, '2025-09', 'RELEASED')", [COMPANY]);
  const runPersonId = await ins('INSERT INTO hrms_pay_run_people (company_id, run_id, employee_id, days_in_month) VALUES (?, ?, ?, 30)', [COMPANY, runId, E.a]);
  const snapshot = { company: { name: 'Karni', legalName: `${TAG} Employer Ltd` }, earnings: [{ code: 'BASIC', name: 'Basic', amount: 40000 }, { code: 'HRA', name: 'HRA', amount: 20000 }], deductions: [{ code: 'PT', name: 'Professional tax', amount: 200 }, { code: 'PF_EE', name: 'PF', amount: 1800 }], totals: { gross: 60000 }, tds: 3000 };
  await db.query("INSERT INTO hrms_pay_payslips (company_id, run_id, run_person_id, employee_id, period_month, version, status, net_pay, snapshot_json, released_at) VALUES (?, ?, ?, ?, '2025-09', 1, 'RELEASED', 55000, ?, NOW())",
    [COMPANY, runId, runPersonId, E.a, JSON.stringify(snapshot)]);

  forgetAccess();
  server = express();
  server.use(express.json({ limit: '5mb' }));
  server.use(cookieParser());
  server.use('/api', appContext);
  hrmsApp.register(server);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  server.close = () => new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${listener.address().port}/api/${company.slug}/cf_hrms`;
  const call = async (who, method, url, body) => {
    const res = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, json, cache: res.headers.get('cache-control') };
  };
  const auditBefore = Number((await one('SELECT COUNT(*) AS n FROM hrms_audit_log'))?.n);

  const years = await call(U.A, 'GET', '/user/me/itr/years');
  const y1 = years.json?.years?.find((y) => y.year === Y1);
  ok(years.status === 200 && y1 && y1.payslipMonths === 1 && y1.draft === null && y1.jsonAvailable === true && y1.dueDate === '2026-07-31'
    && years.json.years.find((y) => y.year === Y2)?.jsonAvailable === false, 'GET /user/me/itr/years: both years; 2025-26 has 1 payslip month and the JSON; 2026-27 not', JSON.stringify(years.json).slice(0, 400));
  const fresh = await call(U.A, 'GET', `/user/me/itr/${Y1}`);
  ok(fresh.status === 200 && fresh.json.status === 'NEW' && fresh.json.result.salary.grossSalary.value === 60000 && fresh.json.result.salary.grossSalary.source === 'EMPLOYER'
    && fresh.json.result.salary.tds.value === 3000 && fresh.json.result.salary.professionalTax.value === 200 && fresh.json.employer.pfEmployee === 1800 && fresh.json.employer.hraReceived === 20000 && fresh.json.employer.basic === 40000 && fresh.json.result.salary.basicDa.source === 'EMPLOYER'
    && fresh.cache === 'no-store' && /does not file your return/.test(fresh.json.notice),
  'GET a year with no draft: the employer part from the released payslip (gross 60,000, TDS 3,000, PT 200, Basic 40,000), not cached', JSON.stringify(fresh.json?.result?.salary ?? fresh.json).slice(0, 300));
  const put = await call(U.A, 'PUT', `/user/me/itr/${Y1}`, { ...FULL_PARTS, employer: { ...FULL_PARTS.employer, useTyped: true } });
  ok(put.status === 200 && put.json.status === 'DRAFT' && put.json.result.salary.grossSalary.source === 'TYPED' && put.json.result.computation.taxableIncome === 1387100
    && put.json.draft.bank.accountMasked === 'XXXXXXX8901' && !JSON.stringify(put.json.draft).includes('12345678901'),
  'PUT the parts: saved, computed (total income 13,87,100 as hand-worked in [4]), the bank account masked on screen', JSON.stringify(put.json?.draft?.bank ?? put.json));
  const keep = await call(U.A, 'PUT', `/user/me/itr/${Y1}`, { bank: { bankName: 'Test bank', ifsc: 'SBIN0001234', account: '', type: 'SAVINGS' } });
  ok(keep.status === 200 && keep.json.draft.bank.accountMasked === 'XXXXXXX8901', 'an empty account number keeps the saved one (the screen only ever sees it masked)');
  const bad = await call(U.A, 'PUT', `/user/me/itr/${Y1}`, { income: { savingsInterest: -5, houseProperties: [{ kind: 'RENTED' }] }, salary: 1, bank: { ifsc: 'XX' } });
  ok(bad.status === 422 && bad.json.problems.length >= 4 && bad.json.problems.some((p) => /"salary" is not something/.test(p)) && bad.json.problems.some((p) => /cannot be negative/.test(p))
    && bad.json.problems.some((p) => /LET_OUT or SELF_OCCUPIED/.test(p)) && bad.json.problems.some((p) => /IFSC/.test(p)), 'bad parts → 422 with every problem in words', JSON.stringify(bad.json?.problems));
  const pdf = await call(U.A, 'GET', `/user/me/itr/${Y1}/summary.pdf`);
  ok(pdf.status === 200 && pdf.json.mimeType === 'application/pdf' && Buffer.from(pdf.json.contentBase64, 'base64').subarray(0, 5).toString() === '%PDF-' && /summary\.pdf$/.test(pdf.json.fileName), 'GET summary.pdf → a PDF', pdf.json?.fileName);
  // A has no PAN in the fixture → the JSON is refused in words; with a PAN it is built and valid.
  const noPan = await call(U.A, 'GET', `/user/me/itr/${Y1}/return.json`);
  ok(noPan.status === 422 && noPan.json.code === 'NEEDS_MORE' && /PAN/.test(noPan.json.message), 'return.json without a PAN on record → 422 NEEDS_MORE', JSON.stringify(noPan.json));
  await db.query("INSERT INTO hrms_employee_identifiers (company_id, employee_id, identifier_type, identifier_value, valid_from) VALUES (?, ?, 'PAN', 'ABCDE1234F', '2020-01-01')", [COMPANY, E.a]);
  const js = await call(U.A, 'GET', `/user/me/itr/${Y1}/return.json`);
  const parsed = js.status === 200 ? JSON.parse(Buffer.from(js.json.contentBase64, 'base64').toString()) : null;
  ok(js.status === 200 && parsed?.ITR?.ITR1?.PersonalInfo?.PAN === 'ABCDE1234F' && parsed.ITR.ITR1.ITR1_IncomeDeductions.TotalIncome === 1387100 && js.json.version.startsWith('V1.1'),
    'GET return.json → the ITR-1 JSON (validated against V1.1)', JSON.stringify(js.json).slice(0, 300));
  const fin = await call(U.A, 'POST', `/user/me/itr/${Y1}/finalise`);
  ok(fin.status === 200 && fin.json.status === 'FINALISED' && fin.json.employer.grossSalary === 60000, 'finalise keeps a snapshot of the employer part');
  await db.query("UPDATE hrms_pay_payslips SET snapshot_json = JSON_SET(snapshot_json, '$.tds', 9999) WHERE company_id = ? AND employee_id = ?", [COMPANY, E.a]);
  const after = await call(U.A, 'GET', `/user/me/itr/${Y1}`);
  ok(after.json.employer.tds === 3000, 'a finalised return reads its snapshot, not the payslips as they are today');
  const reopen = await call(U.A, 'PUT', `/user/me/itr/${Y1}`, { choices: { regime: 'NEW' } });
  ok(reopen.json.status === 'DRAFT' && reopen.json.employer.tds === 9999, 'a change after finalising: back to DRAFT, the employer part read live again');

  /* privacy */
  const b = await call(U.B, 'GET', `/user/me/itr/${Y1}`);
  ok(b.status === 200 && b.json.status === 'NEW' && b.json.result.salary.grossSalary.value === 0 && !JSON.stringify(b.json).includes('Ameerpet'), 'another employee sees only their own (empty) return, nothing of A\'s');
  const hr = await call(U.HR, 'GET', `/user/me/itr/${Y1}`);
  const hrPut = await call(U.HR, 'PUT', `/user/me/itr/${Y1}`, { income: { savingsInterest: 1 } });
  ok(hr.status === 403 && hrPut.status === 403 && hr.json.code === 'NOT_LINKED', 'HR (every HR right) → 403: no return to read or write', JSON.stringify(hr.json));
  const hrl = await call(U.HRL, 'GET', `/user/me/itr/${Y1}`);
  ok(hrl.status === 200 && hrl.json.status === 'NEW' && !JSON.stringify(hrl.json).includes('Ameerpet'), 'HR with a login of their own sees only THEIR OWN return');
  const own = await call(O, 'GET', `/user/me/itr/${Y1}`);
  ok(ownerLinked ? (own.status === 200 && !JSON.stringify(own.json).includes('Ameerpet')) : (own.status === 403 && own.json.code === 'NOT_LINKED'), 'the Owner → only their own return (403 when not an employee)', `${own.status}`);
  const anon = await call(null, 'GET', `/user/me/itr/${Y1}`);
  ok(anon.status === 401, 'no login → 401');
  const viaQuery = await call(U.HR, 'GET', '/user/me/itr/2025-26?employeeId=' + E.a);
  ok(viaQuery.status === 403, 'an employeeId in the query changes nothing');
  ok(Number((await one('SELECT COUNT(*) AS n FROM hrms_audit_log'))?.n) === auditBefore, 'no audit row carries the return (nothing written to hrms_audit_log)');
  const del = await call(U.A, 'DELETE', `/user/me/itr/${Y1}`);
  const gone = await one('SELECT COUNT(*) AS n FROM hrms_itr_returns WHERE company_id = ? AND employee_id = ?', [COMPANY, E.a]);
  ok(del.status === 200 && del.json.removed === 1 && Number(gone.n) === 0, '"Start again" deletes the draft outright');
  const badYear = await call(U.A, 'GET', '/user/me/itr/2024-25');
  ok(badYear.status === 404 && badYear.json.code === 'NO_RULES', 'a year with no rules → 404 NO_RULES');
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

section('[6] Nothing is left behind');
{
  const after = await worldCount();
  const moved = Object.keys(before).filter((k) => after[k] !== before[k]);
  ok(moved.length === 0, `every count is what it was (${TABLES.join(', ')})`, moved.map((k) => `${k} ${before[k]} -> ${after[k]}`).join('; '));
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
