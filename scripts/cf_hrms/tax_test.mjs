/**
 * tax_test.mjs — the income tax engine (apps/cf_hrms/services/tax; TM/CF_HRMS_HIRING_SPEC.md §25.3).
 *
 * Every expected number is worked out by hand in the comment above its check, the way a
 * CA's worksheet would, from the rules in services/tax/ruleData.js (sources there).
 * Y1 = 2025-26 (FY 2025-26 / AY 2026-27, Income-tax Act 1961); Y2 = 2026-27 (Act 2025).
 *
 * Slabs used below:
 *   NEW  0–4 L nil · 4–8 L 5% (20,000) · 8–12 L 10% (cum 60,000) · 12–16 L 15% (cum 1,20,000)
 *        · 16–20 L 20% (cum 2,00,000) · 20–24 L 25% (cum 3,00,000) · above 24 L 30%
 *   OLD  below 60: 2.5–5 L 5% (12,500) · 5–10 L 20% (cum 1,12,500) · above 10 L 30%
 *        60–80: 3–5 L 5% (10,000) · 5–10 L 20% (cum 1,10,000) · 80+: 5–10 L 20% (1,00,000)
 *   Standard deduction NEW 75,000 / OLD 50,000. Cess 4%. Taxable income and total tax to ₹10.
 *
 *   0. pure helpers (rounding, ₹ format, age bands, cities)
 *   1. rebate and its marginal relief (both years)
 *   2. surcharge at 50 L / 1 Cr / 2 Cr / 5 Cr, its marginal relief, the new-regime 25% cap
 *   3. exemptions (HRA metro vs not, by month; LTA; gratuity), deductions (80C cap, 80CCD(2),
 *      80D, 24(b), 80TTA/TTB), refusals in the new regime, age bands, non-resident
 *   4. regime comparison (old wins, new wins)
 *   5. projection and monthly TDS (mid-year joiner + previous employer, revision, bonus,
 *      over-deduction, proofs window closed)
 *   6. the table: schema, seed idempotent, loader = seed (local DB)
 *
 *   node scripts/cf_hrms/tax_test.mjs [--verbose]
 */
import mysql from 'mysql2/promise';
import * as TAX from '../../apps/cf_hrms/services/tax/index.js';
import { schemaSteps } from '../../apps/cf_hrms/scripts/apply-tax-schema.mjs';
import { seedPlan } from '../../apps/cf_hrms/scripts/seed-tax-rules.mjs';

const VERBOSE = process.argv.includes('--verbose');
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
const R = { [Y1]: { OLD: TAX.rulesFromSeed(Y1, 'OLD'), NEW: TAX.rulesFromSeed(Y1, 'NEW') }, [Y2]: { OLD: TAX.rulesFromSeed(Y2, 'OLD'), NEW: TAX.rulesFromSeed(Y2, 'NEW') } };
const tax = (year, regime, input) => TAX.computeTax({ year, regime, ...input }, R[year][regime]);
/** One taxable component of `amount` (Basic). */
const pay = (amount) => ({ salary: { components: [{ code: 'BASIC', name: 'Basic', amount }] } });
const show = (r) => `taxable ${r.taxableIncome} slab ${r.slabTax} rebate ${r.rebate} sur ${r.surcharge} cess ${r.cess} total ${r.totalTax}`;

/* ══ 0. helpers ═════════════════════════════════════════════════════════ */
section('[0] Helpers');
// 288A/288B and s.516: paise ignored, then the nearest ₹10, 5 and above up.
ok(TAX.roundTo(12345) === 12350 && TAX.roundTo(12344) === 12340 && TAX.roundTo(12345.99) === 12350 && TAX.roundTo(12344.99) === 12340 && TAX.roundTo(12340) === 12340,
  'roundTo ₹10: 12,345 → 12,350; 12,344 → 12,340; 12,344.99 → 12,340 (paise ignored)');
ok(TAX.inr(1234567) === '₹12,34,567' && TAX.inr(500) === '₹500' && TAX.inr(100000) === '₹1,00,000', 'inr: Indian grouping', TAX.inr(1234567));
// CBDT ITR validation AY 2026-27: a senior is born on or before 01.04.1966.
ok(TAX.ageBandFor({ dateOfBirth: '1966-04-01' }, Y1) === 'AGE_60_TO_80' && TAX.ageBandFor({ dateOfBirth: '1966-04-02' }, Y1) === 'BELOW_60'
  && TAX.ageBandFor({ dateOfBirth: '1946-04-01' }, Y1) === 'AGE_80_PLUS' && TAX.ageBandFor({ dateOfBirth: '1946-04-02' }, Y1) === 'AGE_60_TO_80'
  && TAX.ageBandFor({ dateOfBirth: '1967-04-01' }, Y2) === 'AGE_60_TO_80', 'age band: 60 on the day before the birthday (born 1 Apr 1966 → senior for 2025-26)');
ok(!TAX.isMetro('Bangalore', R[Y1].OLD.get('exempt_hra').metros) && TAX.isMetro('Bangalore', R[Y2].OLD.get('exempt_hra').metros)
  && TAX.isMetro('Bombay', R[Y1].OLD.get('exempt_hra').metros) && !TAX.isMetro('Hyderabad', R[Y1].OLD.get('exempt_hra').metros) && TAX.isMetro('hyderabad', R[Y2].OLD.get('exempt_hra').metros),
  'HRA cities: 4 in 2025-26 (rule 2A), 8 in 2026-27 (rule 279); old names understood');
ok(R[Y1].NEW.get('regime').default === true && R[Y1].OLD.get('regime').default === false, 'the NEW regime is the default');
{
  const r = TAX.computeTax({ year: Y1, ...pay(1000000) }, R[Y1].NEW);
  ok(r.regime === 'NEW', 'no regime given → NEW');
  const e = caught(() => TAX.computeTax({ year: Y1, ...pay(1000000) }, R[Y1].OLD));
  ok(e && /NEW/.test(e.message), 'no regime given with OLD rules → a plain error, never a silent switch', e?.message);
  const e2 = caught(() => TAX.rulesFromSeed('2024-25', 'NEW'));
  ok(e2 && /No tax rules for 2024-25/.test(e2.message), 'a year with no rules → "No tax rules for 2024-25 …", never a guess', e2?.message);
}

/* ══ 1. rebate ══════════════════════════════════════════════════════════ */
section('[1] Rebate and marginal relief');
for (const Y of [Y1, Y2]) {
  // NEW, gross 12,75,000 − std 75,000 = taxable 12,00,000; slab 20,000 + 40,000 = 60,000;
  // rebate (≤ 12 L) 60,000 → tax 0; cess 0; total 0.
  let r = tax(Y, 'NEW', pay(1275000));
  ok(r.taxableIncome === 1200000 && r.slabTax === 60000 && r.rebate === 60000 && r.totalTax === 0, `${Y} NEW at 12,00,000: rebate 60,000, no tax`, show(r));
  // NEW, gross 12,85,000 → taxable 12,10,000; slab 60,000 + 10,000×15% = 61,500;
  // income over 12 L = 10,000 < 61,500 → marginal relief 51,500 → tax 10,000; cess 400; total 10,400.
  r = tax(Y, 'NEW', pay(1285000));
  ok(r.slabTax === 61500 && r.rebate === 51500 && r.marginalReliefs.rebate === 51500 && r.cess === 400 && r.totalTax === 10400, `${Y} NEW at 12,10,000: marginal relief 51,500 → 10,400`, show(r));
}
{
  // NEW Y1, taxable 12,50,000: slab 60,000 + 50,000×15% = 67,500; over 12 L = 50,000; relief 17,500 →
  // 50,000; cess 2,000; total 52,000.
  let r = tax(Y1, 'NEW', pay(1325000));
  ok(r.taxAfterRebate === 50000 && r.totalTax === 52000, 'Y1 NEW at 12,50,000: tax = the income above 12 L (50,000) → 52,000', show(r));
  // NEW Y1, taxable 12,70,580: slab 60,000 + 70,580×15% = 60,000 + 10,587 = 70,587; over 12 L 70,580 →
  // relief 7 → 70,580; cess 2,823.20 → 2,823; 73,403 → ₹10: 73,400.
  r = tax(Y1, 'NEW', pay(1345580));
  ok(r.rebate === 7 && r.totalTax === 73400, 'Y1 NEW at 12,70,580: the last ₹7 of relief → 73,400', show(r));
  // NEW Y1, taxable 12,70,590 (CBDT validation rule 191: no rebate above this): slab 70,588.50 → 70,589;
  // over 12 L 70,590 > 70,589 → no relief; cess 2,823.56 → 2,824; 73,413 → 73,410.
  r = tax(Y1, 'NEW', pay(1345590));
  ok(r.rebate === 0 && r.slabTax === 70589 && r.totalTax === 73410, 'Y1 NEW at 12,70,590: relief has run out → 73,410', show(r));
  // NEW Y1, taxable 12,80,000: slab 60,000 + 12,000 = 72,000; over 12 L 80,000 → no relief; cess 2,880 → 74,880.
  r = tax(Y1, 'NEW', pay(1355000));
  ok(r.rebate === 0 && r.totalTax === 74880, 'Y1 NEW at 12,80,000: full tax 74,880', show(r));
  // OLD Y1, gross 5,50,000 − 50,000 = 5,00,000; slab 12,500; rebate 12,500 → 0.
  r = tax(Y1, 'OLD', pay(550000));
  ok(r.slabTax === 12500 && r.rebate === 12500 && r.totalTax === 0, 'Y1 OLD at 5,00,000: rebate 12,500, no tax', show(r));
  // OLD Y1, gross 5,50,010 → 5,00,010; slab 12,500 + 10×20% = 12,502; NO rebate and NO marginal relief
  // in the old regime; cess 500.08 → 500; 13,002 → ₹10: 13,000.
  r = tax(Y1, 'OLD', pay(550010));
  ok(r.rebate === 0 && r.slabTax === 12502 && r.totalTax === 13000, 'Y1 OLD at 5,00,010: no rebate, no marginal relief → 13,000', show(r));
  // OLD Y2: same rule in section 156(1).
  r = tax(Y2, 'OLD', pay(550000));
  ok(r.totalTax === 0 && /section 156/.test(r.lines.find((l) => l.rule === 'rebate')?.label ?? ''), 'Y2 OLD at 5,00,000: rebate under section 156 (was 87A)', show(r));
  // Non-resident, NEW Y1, taxable 12,00,000: no rebate; 60,000 + cess 2,400 = 62,400.
  r = tax(Y1, 'NEW', { ...pay(1275000), resident: false });
  ok(r.rebate === 0 && r.totalTax === 62400, 'a non-resident gets no rebate → 62,400', show(r));
}

/* ══ 2. surcharge ═══════════════════════════════════════════════════════ */
section('[2] Surcharge, its marginal relief, the new-regime cap');
{
  // NEW Y1, taxable 50,00,000: 3,00,000 + 26,00,000×30% = 10,80,000; no surcharge (not above 50 L);
  // cess 43,200 → 11,23,200.
  let r = tax(Y1, 'NEW', pay(5075000));
  ok(r.slabTax === 1080000 && r.surcharge === 0 && r.totalTax === 1123200, 'NEW at 50,00,000: no surcharge → 11,23,200', show(r));
  // NEW Y1, taxable 50,10,000: tax 10,83,000; surcharge 10% = 1,08,300; limit = tax at 50 L (10,80,000)
  // + 10,000 = 10,90,000; tax + surcharge 11,91,300 → relief 1,01,300 → surcharge 7,000;
  // cess 4% of 10,90,000 = 43,600; total 11,33,600.
  r = tax(Y1, 'NEW', pay(5085000));
  ok(r.surcharge === 7000 && r.marginalReliefs.surcharge === 101300 && r.totalTax === 1133600, 'NEW at 50,10,000: relief 1,01,300, surcharge 7,000 → 11,33,600', show(r));
  // NEW Y1, taxable 60,00,000: 3,00,000 + 36,00,000×30% = 13,80,000; surcharge 1,38,000 (limit 20,80,000 not hit);
  // cess 60,720; total 15,78,720.
  r = tax(Y1, 'NEW', pay(6075000));
  ok(r.surcharge === 138000 && r.marginalReliefs.surcharge === 0 && r.totalTax === 1578720, 'NEW at 60,00,000: full 10% → 15,78,720', show(r));
  // NEW Y1, taxable 1,00,00,000: 3,00,000 + 76,00,000×30% = 25,80,000; 10% = 2,58,000 → 28,38,000;
  // cess 1,13,520; total 29,51,520.
  r = tax(Y1, 'NEW', pay(10075000));
  ok(r.surchargeRate === 10 && r.totalTax === 2951520, 'NEW at 1 Cr: still 10% → 29,51,520', show(r));
  // NEW Y1, taxable 1,00,10,000: tax 25,83,000; 15% = 3,87,450; limit 28,38,000 + 10,000 = 28,48,000;
  // relief 25,83,000 + 3,87,450 − 28,48,000 = 1,22,450 → surcharge 2,65,000; cess 1,13,920; total 29,61,920.
  r = tax(Y1, 'NEW', pay(10085000));
  ok(r.surchargeRate === 15 && r.surcharge === 265000 && r.totalTax === 2961920, 'NEW at 1,00,10,000: 15% with relief → 29,61,920', show(r));
  // NEW Y1, taxable 2,00,00,000: 3,00,000 + 1,76,00,000×30% = 55,80,000; 15% = 8,37,000 → 64,17,000;
  // cess 2,56,680; total 66,73,680.
  r = tax(Y1, 'NEW', pay(20075000));
  ok(r.totalTax === 6673680, 'NEW at 2 Cr: 15% → 66,73,680', show(r));
  // NEW Y1/Y2, taxable 2,00,10,000: tax 55,83,000; 25% = 13,95,750; limit 64,17,000 + 10,000 = 64,27,000;
  // relief 5,51,750 → surcharge 8,44,000; cess 2,57,080; total 66,84,080.
  for (const Y of [Y1, Y2]) {
    r = tax(Y, 'NEW', pay(20085000));
    ok(r.surchargeRate === 25 && r.surcharge === 844000 && r.totalTax === 6684080, `${Y} NEW at 2,00,10,000: 25% with relief → 66,84,080`, show(r));
  }
  // NEW Y1, taxable 5,00,00,000: 3,00,000 + 4,76,00,000×30% = 1,45,80,000; 25% = 36,45,000;
  // cess 7,29,000; total 1,89,54,000.
  r = tax(Y1, 'NEW', pay(50075000));
  ok(r.totalTax === 18954000, 'NEW at 5 Cr: 25% → 1,89,54,000', show(r));
  // NEW Y1, taxable 5,00,10,000: the NEW regime is capped at 25% — no 37% band, so no step and no relief:
  // tax 1,45,83,000; 25% = 36,45,750; cess 7,29,150; total 1,89,57,900.
  r = tax(Y1, 'NEW', pay(50085000));
  ok(r.surchargeRate === 25 && r.marginalReliefs.surcharge === 0 && r.totalTax === 18957900, 'NEW at 5,00,10,000: capped at 25%, no relief needed → 1,89,57,900', show(r));
  // OLD Y1, taxable 5,00,00,000: 1,12,500 + 4,90,00,000×30% = 1,48,12,500; 25% = 37,03,125 → 1,85,15,625;
  // cess 7,40,625; total 1,92,56,250.
  r = tax(Y1, 'OLD', pay(50050000));
  ok(r.totalTax === 19256250, 'OLD at 5 Cr: 25% → 1,92,56,250', show(r));
  // OLD Y1/Y2, taxable 5,00,10,000: tax 1,48,15,500; 37% = 54,81,735; limit 1,85,15,625 + 10,000 = 1,85,25,625;
  // relief 1,48,15,500 + 54,81,735 − 1,85,25,625 = 17,71,610 → surcharge 37,10,125; cess 7,41,025; total 1,92,66,650.
  for (const Y of [Y1, Y2]) {
    r = tax(Y, 'OLD', pay(50060000));
    ok(r.surchargeRate === 37 && r.marginalReliefs.surcharge === 1771610 && r.surcharge === 3710125 && r.totalTax === 19266650, `${Y} OLD at 5,00,10,000: 37% with relief → 1,92,66,650`, show(r));
  }
  // At 6 Cr: OLD 1,12,500 + 5,90,00,000×30% = 1,78,12,500; 37% = 65,90,625 → 2,44,03,125; cess 9,76,125 → 2,53,79,250.
  //          NEW 3,00,000 + 5,76,00,000×30% = 1,75,80,000; 25% (cap) = 43,95,000 → 2,19,75,000; cess 8,79,000 → 2,28,54,000.
  const o = tax(Y1, 'OLD', pay(60050000));
  const nw = tax(Y1, 'NEW', pay(60075000));
  ok(o.surchargeRate === 37 && o.totalTax === 25379250 && nw.surchargeRate === 25 && nw.totalTax === 22854000, 'at 6 Cr: OLD 37% → 2,53,79,250; NEW capped at 25% → 2,28,54,000', `${show(o)} | ${show(nw)}`);

  // Dividends: the surcharge on the tax on dividend income is at most 15% (Finance Act 2026, First
  // Schedule Part I-A / I-B, Paragraph F). The dividends' tax = the top slice of the slab income.
  // NEW, salary 2,50,75,000 − 75,000 = 2,50,00,000 + dividends 50,00,000 = taxable 3,00,00,000.
  //   Slab tax 3,00,000 + 2,76,00,000×30% = 85,80,000. Dividends' tax (top slice) 50,00,000×30% = 15,00,000.
  //   Surcharge 25%: (85,80,000 − 15,00,000)×25% = 17,70,000 + 15,00,000×15% = 2,25,000 → 19,95,000
  //   (21,45,000 without the cap). Marginal relief at 2 Cr: limit 55,80,000×1.15 + 1,00,00,000 = 1,64,17,000 — not hit.
  //   Cess 4% of 1,05,75,000 = 4,23,000; total 1,09,98,000.
  for (const Y of [Y1, Y2]) {
    r = tax(Y, 'NEW', { ...pay(25075000), otherIncome: { dividends: 5000000 } });
    ok(r.taxableIncome === 30000000 && r.surchargeRate === 25 && r.surchargeDividend.tax === 1500000 && r.surchargeDividend.rate === 15 && r.surcharge === 1995000 && r.totalTax === 10998000,
      `${Y} NEW 3 Cr with 50 L dividends: surcharge 25% on the rest, 15% on the dividends' 15,00,000 → 19,95,000; total 1,09,98,000`, show(r));
  }
  //   Without dividends the same 3 Cr pays the full 25%: 85,80,000×25% = 21,45,000; cess 4,29,000; total 1,11,54,000.
  r = tax(Y1, 'NEW', pay(30075000));
  ok(r.surcharge === 2145000 && r.totalTax === 11154000 && r.surchargeDividend.tax === 0, 'the same 3 Cr as salary only: the full 25% → 1,11,54,000', show(r));
  // OLD, salary 5,00,50,000 − 50,000 = 5,00,00,000 + dividends 1,00,00,000 = taxable 6,00,00,000.
  //   Slab tax 1,12,500 + 5,90,00,000×30% = 1,78,12,500. Dividends' tax 1,00,00,000×30% = 30,00,000.
  //   Surcharge 37%: 1,48,12,500×37% = 54,80,625 + 30,00,000×15% = 4,50,000 → 59,30,625.
  //   Relief at 5 Cr: limit 1,48,12,500×1.25 + 1,00,00,000 = 2,85,15,625; 2,37,43,125 is below — none.
  //   Cess 4% of 2,37,43,125 = 9,49,725; total 2,46,92,850.
  r = tax(Y1, 'OLD', { ...pay(50050000), otherIncome: { dividends: 10000000 } });
  ok(r.surchargeRate === 37 && r.surchargeDividend.tax === 3000000 && r.surcharge === 5930625 && r.totalTax === 24692850,
    'OLD 6 Cr with 1 Cr dividends: 37% on the rest, 15% on the dividends\' 30,00,000 → surcharge 59,30,625; total 2,46,92,850', show(r));
  // Between 1 and 2 Cr the band is 15% already — the cap changes nothing.
  //   NEW 1,00,75,000 − 75,000 + 50,00,000 dividends = 1,50,00,000: 3,00,000 + 1,26,00,000×30% = 40,80,000;
  //   15% = 6,12,000; cess 1,87,680; total 48,79,680.
  r = tax(Y1, 'NEW', { ...pay(10075000), otherIncome: { dividends: 5000000 } });
  ok(r.surchargeRate === 15 && r.surcharge === 612000 && r.totalTax === 4879680 && r.surchargeDividend.tax === 0, 'NEW 1.5 Cr with dividends: 15% band, the cap changes nothing → 48,79,680', show(r));
}

/* ══ 3. exemptions, deductions, refusals ════════════════════════════════ */
section('[3] Exemptions, deductions, refusals, age bands');
const hraPay = { salary: { components: [
  { code: 'BASIC', name: 'Basic', amount: 600000 }, { code: 'HRA', name: 'HRA', amount: 300000, taxable: 'PARTLY', exemptRule: 'HRA' }, { code: 'SPL', name: 'Special allowance', amount: 300000 },
] } };
{
  // OLD Y1, Mumbai. Basic 6,00,000, HRA 3,00,000, special 3,00,000 → gross 12,00,000. Rent 30,000 × 12 = 3,60,000.
  // HRA least of: received 3,00,000; rent − 10% of Basic = 3,60,000 − 60,000 = 3,00,000; 50% of Basic = 3,00,000 → 3,00,000.
  // Net 9,00,000 − std 50,000 − PT 2,500 = 8,47,500 − 80C 1,50,000 = 6,97,500.
  // Tax 12,500 + 1,97,500×20% = 52,000; cess 2,080; total 54,080.
  const base = { ...hraPay, professionalTax: 2500, deductions: { '80C': 150000 } };
  let r = tax(Y1, 'OLD', { ...base, exemptions: { hra: { rentPaid: 360000, city: 'Mumbai' } } });
  ok(r.exemptions[0]?.exempt === 300000 && r.taxableIncome === 697500 && r.totalTax === 54080, 'HRA Mumbai (metro, 50%): exempt 3,00,000 → 54,080', show(r));
  // Same in Hyderabad, 2025-26 (not a rule-2A city): 40% of Basic = 2,40,000 → exempt 2,40,000.
  // Net 9,60,000 − 50,000 − 2,500 − 1,50,000 = 7,57,500; tax 12,500 + 2,57,500×20% = 64,000; cess 2,560 → 66,560.
  r = tax(Y1, 'OLD', { ...base, exemptions: { hra: { rentPaid: 360000, city: 'Hyderabad' } } });
  ok(r.exemptions[0]?.exempt === 240000 && r.totalTax === 66560, 'HRA Hyderabad 2025-26 (40%): exempt 2,40,000 → 66,560', show(r));
  // Same in Hyderabad, 2026-27 (rule 279 lists it): 50% → exempt 3,00,000 → 54,080, as Mumbai.
  r = tax(Y2, 'OLD', { ...base, exemptions: { hra: { rentPaid: 360000, city: 'Hyderabad' } } });
  ok(r.exemptions[0]?.exempt === 300000 && r.totalTax === 54080, 'HRA Hyderabad 2026-27 (one of the 8 cities): exempt 3,00,000 → 54,080', show(r));
  // A wrong metro flag does not beat the city: warning.
  r = tax(Y1, 'OLD', { ...base, exemptions: { hra: { rentPaid: 360000, city: 'Hyderabad', metro: true } } });
  ok(r.exemptions[0]?.exempt === 240000 && r.warnings.some((w) => /Hyderabad is not a 50% city in 2025-26/.test(w)), 'metro: true with Hyderabad in 2025-26 → the city decides, said in a warning', r.warnings.join(' | '));
}
{
  // 80C capped. OLD Y1: salary 10,00,000 − 50,000 = 9,50,000; 80C claimed 2,00,000 → 1,50,000; 80CCD(1B) 50,000.
  // Taxable 7,50,000; tax 12,500 + 2,50,000×20% = 62,500; cess 2,500; total 65,000.
  const r = tax(Y1, 'OLD', { ...pay(1000000), deductions: { '80C': 200000, '80CCD1B': 50000 } });
  const c = r.deductions.find((d) => d.key === 'ded_80c');
  ok(c?.claimed === 200000 && c?.allowed === 150000 && r.taxableIncome === 750000 && r.totalTax === 65000, '80C 2,00,000 capped at 1,50,000 (+ 80CCD(1B) 50,000) → 65,000', show(r));
  const r2 = tax(Y2, 'OLD', { ...pay(1000000), deductions: { '80C': 200000, '80CCD1B': 50000 } });
  ok(r2.totalTax === 65000 && /section 123, was 80C/.test(r2.deductions[0].section), '2026-27: the same under section 123 (was 80C)', r2.deductions[0]?.section);
}
{
  // 80CCD(2) in the NEW regime. Basic 10,00,000, special 10,00,000, employer NPS 1,50,000 (taxable, 17(1)) → gross 21,50,000.
  // 80CCD(2) at most 14% of Basic + DA = 1,40,000 (new regime, any employer).
  // Taxable 21,50,000 − 75,000 − 1,40,000 = 19,35,000; tax 1,20,000 + 3,35,000×20% = 1,87,000; cess 7,480; total 1,94,480.
  const comps = { salary: { components: [{ code: 'BASIC', name: 'Basic', amount: 1000000 }, { code: 'SPL', name: 'Special', amount: 1000000 }, { code: 'NPS_ER', name: 'Employer NPS', amount: 150000 }] }, deductions: { '80CCD2': 150000 } };
  let r = tax(Y1, 'NEW', comps);
  ok(r.deductions[0]?.allowed === 140000 && r.taxableIncome === 1935000 && r.totalTax === 194480 && !r.refused.length, '80CCD(2) in the NEW regime: 14% of Basic = 1,40,000 → 1,94,480', show(r));
  // OLD, private employer: 10% = 1,00,000; taxable 21,50,000 − 50,000 − 1,00,000 = 20,00,000;
  // tax 1,12,500 + 10,00,000×30% = 4,12,500; cess 16,500; total 4,29,000.
  r = tax(Y1, 'OLD', comps);
  ok(r.deductions[0]?.allowed === 100000 && r.totalTax === 429000, '80CCD(2) OLD, private employer: 10% = 1,00,000 → 4,29,000', show(r));
  // OLD, government employer: 14% = 1,40,000; taxable 19,60,000; tax 1,12,500 + 9,60,000×30% = 4,00,500; cess 16,020 → 4,16,520.
  r = tax(Y1, 'OLD', { ...comps, employerType: 'GOVT' });
  ok(r.deductions[0]?.allowed === 140000 && r.totalTax === 416520, '80CCD(2) OLD, government employer: 14% → 4,16,520', show(r));
}
{
  // New regime refuses the old-regime-only claims, each with a plain reason, and the tax ignores them:
  // taxable = 12,00,000 − 75,000 = 11,25,000 → 52,500 → rebate → 0.
  const r = tax(Y1, 'NEW', { ...hraPay, professionalTax: 2500, otherIncome: 0, exemptions: { hra: { rentPaid: 360000, city: 'Mumbai' }, lta: { claimed: 30000, received: 30000 } },
    deductions: { '80C': 150000, '80D': { selfFamily: 25000 }, '24B': 200000, '80CCD1B': 50000 } });
  const keys = r.refused.map((x) => x.key).sort().join(',');
  ok(keys === 'ded_24b,ded_80c,ded_80ccd1b,ded_80d,exempt_hra,exempt_lta,professional_tax', 'NEW refuses HRA, LTA, PT, 80C, 80CCD(1B), 80D, 24(b)', keys);
  ok(r.refused.every((x) => /not (allowed|deductible) in the new regime \(section 115BAC\(2\)\)/.test(x.reason)) && r.taxableIncome === 1125000 && r.totalTax === 0,
    '… each with the reason "not allowed in the new regime (section 115BAC(2))", and none of them counted', r.refused.map((x) => x.reason).join(' | '));
  const r2 = tax(Y2, 'NEW', { ...pay(1000000), deductions: { '80C': 150000 } });
  ok(/section 202\(2\), was 115BAC\(2\)/.test(r2.refused[0]?.reason ?? ''), '2026-27: the reason names section 202(2)', r2.refused[0]?.reason);
}
{
  // Age bands, OLD Y1, gross 10,50,000 − 50,000 = taxable 10,00,000:
  //   below 60: 1,12,500 + cess 4,500 = 1,17,000; 60–80: 1,10,000 + 4,400 = 1,14,400; 80+: 1,00,000 + 4,000 = 1,04,000.
  const a = tax(Y1, 'OLD', { ...pay(1050000), dateOfBirth: '1980-06-01' });
  const b = tax(Y1, 'OLD', { ...pay(1050000), dateOfBirth: '1960-05-10' });
  const c = tax(Y1, 'OLD', { ...pay(1050000), dateOfBirth: '1945-01-01' });
  ok(a.totalTax === 117000 && b.totalTax === 114400 && c.totalTax === 104000, 'OLD by age: 1,17,000 / 1,14,400 / 1,04,000', `${a.totalTax} ${b.totalTax} ${c.totalTax}`);
  // Y2, 80+ (born 1946-03-01): the same 1,04,000 from Finance Act 2026 Part I-B.
  const d = tax(Y2, 'OLD', { ...pay(1050000), dateOfBirth: '1946-03-01' });
  ok(d.ageBand === 'AGE_80_PLUS' && d.totalTax === 104000, '2026-27 OLD 80+: 1,04,000', show(d));
  // NEW has one table for all ages: taxable 9,75,000 → 20,000 + 17,500 = 37,500 → rebate → 0.
  ok(tax(Y1, 'NEW', { ...pay(1050000), dateOfBirth: '1945-01-01' }).totalTax === 0, 'NEW ignores age (one table)');
}
{
  // 80TTA, OLD Y1, below 60: salary 8,00,000 − 50,000 = 7,50,000 + savings interest 15,000 = 7,65,000;
  // 80TTA 10,000 → 7,55,000; tax 12,500 + 2,55,000×20% = 63,500; cess 2,540; total 66,040.
  const r = tax(Y1, 'OLD', { ...pay(800000), otherIncome: { savingsInterest: 15000 } });
  ok(r.deductions.find((x) => x.key === 'ded_80tta')?.allowed === 10000 && r.totalTax === 66040, '80TTA: savings interest 15,000 → 10,000 → 66,040', show(r));
  // 80TTB, OLD Y1, 60–80: 7,50,000 + deposit interest 60,000 = 8,10,000; 80TTB 50,000 → 7,60,000;
  // tax 10,000 + 2,60,000×20% = 62,000; cess 2,480; total 64,480. No 80TTA for a senior.
  const s = tax(Y1, 'OLD', { ...pay(800000), dateOfBirth: '1962-01-01', otherIncome: { depositInterest: 60000 } });
  ok(s.deductions.find((x) => x.key === 'ded_80ttb')?.allowed === 50000 && !s.deductions.some((x) => x.key === 'ded_80tta') && s.totalTax === 64480, '80TTB for a senior: 50,000 → 64,480', show(s));
}
{
  // 80D, OLD Y1: taxable before 80D 10,00,000; self/family 30,000 (cap 25,000), parents (senior) 60,000 (cap 50,000) → 75,000.
  // 9,25,000; tax 12,500 + 4,25,000×20% = 97,500; cess 3,900; total 1,01,400.
  const r = tax(Y1, 'OLD', { ...pay(1050000), deductions: { '80D': { selfFamily: 30000, parents: 60000, parentsSenior: true } } });
  ok(r.deductions[0]?.allowed === 75000 && r.totalTax === 101400, '80D: 25,000 + 50,000 (senior parents) → 1,01,400', show(r));
  // 24(b), OLD Y1: salary 12,50,000 − 50,000 = 12,00,000; interest 3,00,000 → loss at most 2,00,000 → 10,00,000;
  // tax 1,12,500 + cess 4,500 = 1,17,000.
  const h = tax(Y1, 'OLD', { ...pay(1250000), deductions: { '24B': 300000 } });
  ok(h.houseProperty === -200000 && h.totalTax === 117000, '24(b): interest 3,00,000 → at most 2,00,000 → 1,17,000', show(h));
  // Deductions never exceed the gross total income: salary 1,50,000 − 50,000 = 1,00,000; 80C 1,50,000 → cut to 1,00,000 → taxable 0.
  const z = tax(Y1, 'OLD', { ...pay(150000), deductions: { '80C': 150000 } });
  ok(z.totalDeductions === 100000 && z.taxableIncome === 0 && z.totalTax === 0, 'deductions cut to the gross total income', show(z));
}
{
  // Rounding of taxable income, OLD Y1: 7,72,505 − 50,000 = 7,22,505 → 7,22,510; tax 12,500 + 2,22,510×20% = 57,002;
  // cess 2,280.08 → 2,280; 59,282 → ₹10: 59,280. And 7,72,504 → 7,22,504 → 7,22,500 → 57,000 + 2,280 = 59,280.
  const a = tax(Y1, 'OLD', pay(772505));
  const b = tax(Y1, 'OLD', pay(772504));
  ok(a.taxableIncome === 722510 && a.totalBeforeRounding === 59282 && a.totalTax === 59280 && b.taxableIncome === 722500 && b.totalTax === 59280,
    'taxable 7,22,505 → 7,22,510 and 7,22,504 → 7,22,500; tax 59,282 → 59,280', `${show(a)} | ${show(b)}`);
}
{
  // LTA, OLD Y1: Basic 6,00,000, LTA 50,000, special 3,50,000 = 10,00,000; fare 40,000 → exempt 40,000.
  // 9,60,000 − 50,000 = 9,10,000; tax 12,500 + 4,10,000×20% = 94,500; cess 3,780; total 98,280.
  const comps = { salary: { components: [{ code: 'BASIC', amount: 600000 }, { code: 'LTA', name: 'LTA', amount: 50000, taxable: 'PARTLY', exemptRule: 'LTA' }, { code: 'SPL', amount: 350000 }] } };
  const r = tax(Y1, 'OLD', { ...comps, exemptions: { lta: { claimed: 40000 } } });
  ok(r.exemptions[0]?.exempt === 40000 && r.totalTax === 98280, 'LTA: fare 40,000 of 50,000 received → exempt 40,000 → 98,280', show(r));
  const used = tax(Y1, 'OLD', { ...comps, exemptions: { lta: { claimed: 40000, journeysUsedInBlock: 2 } } });
  ok(used.exemptions[0]?.exempt === 0, 'LTA: two journeys already used in the block → nothing exempt');
}
{
  // Gratuity, OLD Y1: gratuity 25,00,000 (formula 22,00,000) + Basic 10,00,000 = 35,00,000; exempt least of
  // 25,00,000 / 22,00,000 / cap 20,00,000 = 20,00,000 → 15,00,000 − 50,000 = 14,50,000;
  // tax 1,12,500 + 4,50,000×30% = 2,47,500; cess 9,900; total 2,57,400.
  const comps = { salary: { components: [{ code: 'BASIC', amount: 1000000 }, { code: 'GRATUITY', name: 'Gratuity', amount: 2500000, taxable: 'PARTLY', exemptRule: 'GRATUITY' }] }, exemptions: { gratuity: { formulaAmount: 2200000 } } };
  const r = tax(Y1, 'OLD', comps);
  ok(r.exemptions[0]?.exempt === 2000000 && r.totalTax === 257400 && !r.warnings.length, 'gratuity capped at 20,00,000 → 2,57,400', show(r));
  // NEW keeps the gratuity exemption: 15,00,000 − 75,000 = 14,25,000 → 60,000 + 2,25,000×15% = 93,750; cess 3,750 → 97,500.
  // 2026-27: the cap is carried, NOT verified → a warning on the result.
  const n2 = tax(Y2, 'NEW', comps);
  ok(n2.exemptions[0]?.exempt === 2000000 && n2.totalTax === 97500 && n2.warnings.some((w) => /not confirmed/.test(w)) && n2.unverifiedRules.includes('exempt_gratuity'),
    'gratuity in the NEW regime 2026-27: exempt, and the unverified cap is warned about', n2.warnings.join(' | '));
}
{
  // The worksheet: every amount line of the result names its rule and source; forms by year.
  const r = tax(Y2, 'NEW', pay(1285000));
  ok(r.lines.filter((l) => l.rule).every((l) => l.source && l.url), 'every ruled line carries its source and URL');
  ok(r.forms.certificate.label === 'Form 130 (was Form 16)' && r.forms.salaryTdsSection === '392' && R[Y1].NEW.get('forms').certificate.label === 'Form 16' && R[Y2].OLD.get('forms').perquisites.number === '123',
    'forms by year: Form 16 / s.192 in 2025-26; Form 130 (was Form 16), Form 123 (was 12BA), s.392 in 2026-27');
}

/* ══ 4. regime comparison ═══════════════════════════════════════════════ */
section('[4] Regime comparison');
{
  // OLD wins. Gross 15,00,000 (Basic 6 L, HRA 3 L, special 6 L), rent 3,60,000 Mumbai, PT 2,500,
  // 80C 1,50,000, 80CCD(1B) 50,000, 80D 25,000, home-loan interest 2,00,000.
  // OLD: 15,00,000 − HRA 3,00,000 = 12,00,000 − 50,000 − 2,500 = 11,47,500 − 2,00,000 = 9,47,500 − 2,25,000 = 7,22,500;
  //      tax 12,500 + 2,22,500×20% = 57,000; cess 2,280; total 59,280.
  // NEW: 15,00,000 − 75,000 = 14,25,000; tax 60,000 + 2,25,000×15% = 93,750; cess 3,750; total 97,500.
  // OLD cheaper by 38,220.
  const c = TAX.compareRegimes({ year: Y1, salary: { components: [{ code: 'BASIC', amount: 600000 }, { code: 'HRA', amount: 300000, taxable: 'PARTLY', exemptRule: 'HRA' }, { code: 'SPL', amount: 600000 }] },
    exemptions: { hra: { rentPaid: 360000, city: 'Mumbai' } }, professionalTax: 2500, deductions: { '80C': 150000, '80CCD1B': 50000, '80D': { selfFamily: 25000 }, '24B': 200000 } }, R[Y1].OLD, R[Y1].NEW);
  ok(c.old.totalTax === 59280 && c.new.totalTax === 97500 && c.cheaper === 'OLD' && c.difference === 38220, 'heavy deductions: OLD 59,280 vs NEW 97,500 → OLD by 38,220', c.sentence);
  // NEW wins. Gross 15,00,000, only 80C 1,50,000 and PT 2,500.
  // OLD: 15,00,000 − 50,000 − 2,500 − 1,50,000 = 12,97,500; tax 1,12,500 + 2,97,500×30% = 2,01,750; cess 8,070 → 2,09,820.
  // NEW: 97,500 (as above). NEW cheaper by 1,12,320.
  const d = TAX.compareRegimes({ year: Y2, ...pay(1500000), professionalTax: 2500, deductions: { '80C': 150000 } }, R[Y2].OLD, R[Y2].NEW);
  ok(d.old.totalTax === 209820 && d.new.totalTax === 97500 && d.cheaper === 'NEW' && d.difference === 112320 && /new regime costs ₹1,12,320 less/.test(d.sentence), '2026-27, few deductions: NEW by 1,12,320', d.sentence);
  // A tie goes to NEW: taxable 5,00,000 OLD (0) vs 4,75,000 NEW (0).
  const t = TAX.compareRegimes({ year: Y1, ...pay(550000) }, R[Y1].OLD, R[Y1].NEW);
  ok(t.cheaper === 'NEW' && t.difference === 0, 'a tie (both 0) → NEW, the default', t.sentence);
}

/* ══ 5. projection and monthly TDS ══════════════════════════════════════ */
section('[5] Projection and monthly TDS');
const months = (from, count, comps) => {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  for (let i = 0; i < count; i += 1) { out.push({ month: `${y}-${String(m).padStart(2, '0')}`, components: comps }); m += 1; if (m > 12) { m = 1; y += 1; } }
  return out;
};
const salary = (basic, spl) => [{ code: 'BASIC', name: 'Basic', amount: basic }, { code: 'SPL', name: 'Special', amount: spl }];
{
  // Mid-year joiner with a previous employer, NEW Y1. Joined 1 Oct 2025 at 1,50,000 a month (Oct–Mar = 9,00,000).
  // Previous employer (Form 12B): salary 6,00,000, TDS 10,000.
  // Year: 9,00,000 + 6,00,000 − 75,000 = 14,25,000 → 93,750 + cess 3,750 = 97,500.
  // October: (97,500 − 0 − 10,000) ÷ 6 = 14,583.33 → 14,583; the last month takes 87,500 − 5×14,583 = 14,585.
  const base = { year: Y1, regime: 'NEW', previousEmployer: { taxableSalary: 600000, tds: 10000 } };
  const oct = TAX.projectYear({ ...base, paidMonths: [], remainingMonths: months('2025-10', 6, salary(75000, 75000)) }, R[Y1].NEW);
  ok(oct.projectedTax === 97500 && oct.thisMonthTds === 14583 && oct.schedule[5].tds === 14585 && oct.schedule.reduce((a, s) => a + s.tds, 0) === 87500,
    'joiner in October with a previous employer: 14,583 a month, the last 14,585, 87,500 in all', `${oct.projectedTax} ${oct.thisMonthTds} ${JSON.stringify(oct.schedule.map((s) => s.tds))}`);
  // December: paid Oct and Nov, 14,583 each = 29,166; (97,500 − 29,166 − 10,000) ÷ 4 = 58,334 ÷ 4 = 14,583.50 → 14,584.
  const paid = months('2025-10', 2, salary(75000, 75000)).map((m) => ({ ...m, tdsDeducted: 14583 }));
  const dec = TAX.projectYear({ ...base, paidMonths: paid, remainingMonths: months('2025-12', 4, salary(75000, 75000)) }, R[Y1].NEW);
  ok(dec.tdsSoFar === 29166 && dec.balance === 58334 && dec.thisMonthTds === 14584, 'December: 58,334 ÷ 4 = 14,583.50 → 14,584 (to the rupee)', `${dec.balance} ${dec.thisMonthTds}`);
  // OLD, the same joiner, PT 1,200 here (6 × 200) + 1,500 at the previous employer = 2,700 → at most 2,500:
  // 15,00,000 − 50,000 − 2,500 = 14,47,500; tax 1,12,500 + 4,47,500×30% = 2,46,750; cess 9,870; total 2,56,620.
  const old = TAX.projectYear({ ...base, regime: 'OLD', professionalTax: 1200, previousEmployer: { taxableSalary: 600000, tds: 10000, pt: 1500 }, paidMonths: [], remainingMonths: months('2025-10', 6, salary(75000, 75000)) }, R[Y1].OLD);
  ok(old.computation.professionalTax === 2500 && old.projectedTax === 256620, 'OLD joiner: professional tax of both employers capped at 2,500 → 2,56,620', `${old.computation.professionalTax} ${old.projectedTax}`);
}
{
  // Mid-year revision, NEW Y1. 1,00,000 a month from April: year 12,00,000 − 75,000 = 11,25,000 → 52,500 → rebate → 0,
  // so April–September deducted 0. Revised to 1,50,000 from October: 6×1,00,000 + 6×1,50,000 = 15,00,000 → 97,500;
  // October: 97,500 ÷ 6 = 16,250.
  const apr = TAX.projectYear({ year: Y1, paidMonths: [], remainingMonths: months('2025-04', 12, salary(50000, 50000)) }, R[Y1].NEW);
  ok(apr.projectedTax === 0 && apr.thisMonthTds === 0, 'before the revision: 12,00,000 a year → no tax, no TDS');
  const paid = months('2025-04', 6, salary(50000, 50000)).map((m) => ({ ...m, tdsDeducted: 0 }));
  const oct = TAX.projectYear({ year: Y1, paidMonths: paid, remainingMonths: months('2025-10', 6, salary(75000, 75000)) }, R[Y1].NEW);
  ok(oct.projectedTax === 97500 && oct.thisMonthTds === 16250, 'after the revision: 97,500 ÷ 6 = 16,250 a month', `${oct.projectedTax} ${oct.thisMonthTds}`);
  // + a one-time bonus of 2,00,000 in December: 17,00,000 − 75,000 = 16,25,000; tax 1,20,000 + 25,000×20% = 1,25,000;
  // cess 5,000 → 1,30,000; October: 1,30,000 ÷ 6 = 21,666.67 → 21,667.
  const bonus = TAX.projectYear({ year: Y1, paidMonths: paid, remainingMonths: months('2025-10', 6, salary(75000, 75000)), oneTime: [{ month: '2025-12', code: 'BONUS', name: 'Bonus', amount: 200000 }] }, R[Y1].NEW);
  ok(bonus.projectedTax === 130000 && bonus.thisMonthTds === 21667, 'with a 2,00,000 bonus in December: 1,30,000 ÷ 6 → 21,667', `${bonus.projectedTax} ${bonus.thisMonthTds}`);
  // Over-deduction: 1,20,000 already deducted, the year now comes to 97,500 → this month 0, excess 22,500 (a refund on the return).
  const over = TAX.projectYear({ year: Y1, paidMonths: paid.map((m) => ({ ...m, tdsDeducted: 20000 })), remainingMonths: months('2025-10', 6, salary(75000, 75000)) }, R[Y1].NEW);
  ok(over.thisMonthTds === 0 && over.excess === 22500 && over.schedule.every((s) => s.tds === 0) && /refund/.test(over.lines.at(-1).label), 'over-deducted: 0 this month and after, 22,500 excess → refund', `${over.balance} ${over.excess}`);
  const e = caught(() => TAX.projectYear({ year: Y1, paidMonths: paid, remainingMonths: [] }, R[Y1].NEW));
  ok(e && /no months left/.test(e.message), 'no months left → a plain error', e?.message);
}
{
  // Proofs window, OLD Y1, 1,00,000 a month all year. Declared 80C 1,50,000; proved 50,000.
  // April (declarations): 12,00,000 − 50,000 − 1,50,000 = 10,00,000 → 1,17,000 → ÷ 12 = 9,750.
  const year12 = months('2025-04', 12, salary(50000, 50000));
  const claims = { declarations: { deductions: { '80C': 150000 } }, proofs: { deductions: { '80C': 50000 } } };
  const apr = TAX.projectYear({ year: Y1, regime: 'OLD', ...claims, paidMonths: [], remainingMonths: year12 }, R[Y1].OLD);
  ok(apr.projectedTax === 117000 && apr.thisMonthTds === 9750, 'proofs window open: the declaration counts → 9,750 a month', `${apr.projectedTax} ${apr.thisMonthTds}`);
  // January, window CLOSED: only 50,000 proved → 11,00,000; tax 1,12,500 + 30,000 = 1,42,500; cess 5,700 → 1,48,200.
  // Paid April–December 9 × 9,750 = 87,750; (1,48,200 − 87,750) ÷ 3 = 60,450 ÷ 3 = 20,150.
  const jan = TAX.projectYear({ year: Y1, regime: 'OLD', ...claims, proofsStatus: 'CLOSED', paidMonths: year12.slice(0, 9).map((m) => ({ ...m, tdsDeducted: 9750 })), remainingMonths: year12.slice(9) }, R[Y1].OLD);
  ok(jan.projectedTax === 148200 && jan.thisMonthTds === 20150, 'proofs window closed: the unproven 1,00,000 drops → 20,150 a month for Jan–Mar', `${jan.projectedTax} ${jan.thisMonthTds}`);
}
{
  // HRA month by month in the projection, OLD Y1, Mumbai. Each month Basic 50,000, HRA 25,000, special 25,000.
  // Rent 4,000 a month April–September (below 10% of Basic = 5,000 → 0 exempt), 30,000 October–March:
  //   per month least of 25,000 / 30,000 − 5,000 = 25,000 / 50% × 50,000 = 25,000 → 25,000 × 6 = 1,50,000.
  // (Worked on the year instead: rent 2,04,000 − 60,000 = 1,44,000 — the month-by-month rule gives more.)
  // 12,00,000 − 1,50,000 = 10,50,000 − 50,000 = 10,00,000 → 1,17,000 → ÷ 12 = 9,750.
  const comps = [{ code: 'BASIC', amount: 50000 }, { code: 'HRA', name: 'HRA', amount: 25000, taxable: 'PARTLY', exemptRule: 'HRA' }, { code: 'SPL', amount: 25000 }];
  const rent = months('2025-04', 12, []).map((m, i) => ({ month: m.month, amount: i < 6 ? 4000 : 30000 }));
  const p = TAX.projectYear({ year: Y1, regime: 'OLD', declarations: { exemptions: { hra: { rentPaid: rent, city: 'Mumbai' } } }, paidMonths: [], remainingMonths: months('2025-04', 12, comps) }, R[Y1].OLD);
  ok(p.computation.exemptions[0]?.exempt === 150000 && p.projectedTax === 117000 && p.thisMonthTds === 9750, 'HRA by month: 1,50,000 exempt (not 1,44,000 on the year) → 9,750 a month', `${p.computation.exemptions[0]?.exempt} ${p.projectedTax}`);
}

/* ══ 6. the table ═══════════════════════════════════════════════════════ */
section('[6] The table (local DB)');
if (!['localhost', '127.0.0.1', '::1'].includes(String(process.env.DB_HOST ?? 'localhost'))) {
  console.log(`  skipped: DB_HOST=${process.env.DB_HOST} is not local`);
} else {
  const conn = await mysql.createConnection({ host: 'localhost', user: process.env.DB_USER ?? 'root', password: process.env.DB_PASSWORD ?? '1234', database: process.env.DB_NAME ?? 'sqldb', port: Number(process.env.DB_PORT) || 3306 });
  try {
    ok((await schemaSteps(conn)).length === 0, 'apply-tax-schema: hrms_tax_rules is there, nothing left to do (run it with --apply once)');
    const plan = await seedPlan(conn);
    ok(plan.insert.length === 0 && plan.update.length === 0, 'seed-tax-rules: the table equals the seed (idempotent; run --apply once)', `insert ${plan.insert.length}, update ${plan.update.length}`);
    for (const Y of [Y1, Y2]) for (const g of ['OLD', 'NEW']) {
      const db = await TAX.loadTaxRules(conn, Y, g);
      const fromDb = TAX.computeTax({ year: Y, regime: g, ...pay(5085000) }, db).totalTax;
      const fromSeed = TAX.computeTax({ year: Y, regime: g, ...pay(5085000) }, R[Y][g]).totalTax;
      ok(fromDb === fromSeed && db.unverified.join() === R[Y][g].unverified.join(), `loader ${Y} ${g}: the DB rules give the seed's answer (${fromDb})`);
    }
  } finally {
    await conn.end();
  }
}

/* ══ the unverified rules, said ═════════════════════════════════════════ */
const unverified = TAX.TAX_RULE_ROWS.filter((r) => !r.verified).map((r) => `${r.tax_year} ${r.regime} ${r.rule_key}`);
console.log(`\n  rules not verified from an official source: ${unverified.length ? unverified.join('; ') : 'none'}`);
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log(failed.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
process.exit(0);
