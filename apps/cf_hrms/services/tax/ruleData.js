/**
 * ruleData.js — the seed of hrms_tax_rules: every rate, slab, limit, threshold and form
 * number the tax engine uses, by tax year and regime, each with its source.
 * (TM/CF_HRMS_HIRING_SPEC.md §25.) Read by scripts/seed-tax-rules.mjs (writes the table)
 * and by the tests (which build the same rules without a database).
 *
 * The engine never holds a number of its own: a new year is a new block here (or rows
 * typed into the table), never a code change. See services/tax/index.js.
 *
 * verified = 1 only where the number was read in an official or primary text:
 *   - the Income-tax Act, 2025 as published (Gazette of India, 21 Aug 2025, No. 35);
 *   - the Finance Act, 2026 (No. 4 of 2026, Gazette 30 Mar 2026) and the Memorandum to
 *     the Finance Bill, 2026;
 *   - the Income-tax Rules, 2026 (G.S.R. 198(E), 20 Mar 2026) as notified;
 *   - incometax.gov.in pages and the CBDT e-filing validation rules for AY 2026-27;
 *   - CBDT Circular 24/2022 (TRACES), PIB releases.
 * verified = 0 where it could not be (the reason is in source_note). Read 2026-10-19.
 *
 * Year naming: '2025-26' = financial year 2025-26 = assessment year 2026-27, under the
 * Income-tax Act, 1961. '2026-27' = tax year 2026-27, the first under the Income-tax
 * Act, 2025 (in force 1 April 2026).
 */

/* ── Sources ───────────────────────────────────────────────────────────── */
const URL = {
  itdSalaried: 'https://www.incometax.gov.in/iec/foportal/help/individual/return-applicable-1',
  itr1Rules: 'https://www.incometax.gov.in/iec/foportal/sites/default/files/2026-05/CBDT_e-Filing_ITR%201_Validation%20Rules_AY%202026-27.pdf',
  memo2026: 'https://www.indiabudget.gov.in/doc/memo.pdf',
  circular24of2022: 'https://traces61contents.tdscpc.gov.in/docs/circular-24-2022.pdf',
  pibLeave: 'https://www.pib.gov.in/PressReleasePage.aspx?PRID=1927265',
  tracesForms: 'https://traces61contents.tdscpc.gov.in/en/forms.html',
  sec288B: 'https://www.incometaxindia.gov.in/w/section-288b-49',
  act2025: 'https://egazette.gov.in/WriteReadData/2025/265620.pdf',
  financeAct2026: 'https://egazette.gov.in/WriteReadData/2026/271439.pdf',
  rules2026: 'https://www.incometax.gov.in/iec/foportal/sites/default/files/2026-03/En-Notified-IT-Rules-2026-20-03-2026.pdf',
  art276: 'https://legislative.gov.in/constitution-of-india/',
};

/* ── Shared shapes ─────────────────────────────────────────────────────── */
const NEW_SLABS = [
  { upTo: 400000, rate: 0 }, { upTo: 800000, rate: 5 }, { upTo: 1200000, rate: 10 }, { upTo: 1600000, rate: 15 },
  { upTo: 2000000, rate: 20 }, { upTo: 2400000, rate: 25 }, { upTo: null, rate: 30 },
];
const OLD_SLABS = {
  BELOW_60: [{ upTo: 250000, rate: 0 }, { upTo: 500000, rate: 5 }, { upTo: 1000000, rate: 20 }, { upTo: null, rate: 30 }],
  AGE_60_TO_80: [{ upTo: 300000, rate: 0 }, { upTo: 500000, rate: 5 }, { upTo: 1000000, rate: 20 }, { upTo: null, rate: 30 }],
  AGE_80_PLUS: [{ upTo: 500000, rate: 0 }, { upTo: 1000000, rate: 20 }, { upTo: null, rate: 30 }],
};
const SURCHARGE_BANDS = [{ above: 5000000, rate: 10 }, { above: 10000000, rate: 15 }, { above: 20000000, rate: 25 }, { above: 50000000, rate: 37 }];

/**
 * One year's rows. `law` holds the section names that year's law uses, so a screen and
 * the worksheet say "section 123 (was 80C)" from 2026-27 and "section 80C" before.
 */
function yearRows(year, law, src) {
  const rows = [];
  const add = (regime, rule_key, value, [source_note, source_url, verified = 1]) => rows.push({ tax_year: year, regime, rule_key, value, source_note, source_url, verified });
  const both = (rule_key, value, s) => { add('OLD', rule_key, value, s); add('NEW', rule_key, value, s); };

  add('NEW', 'regime', { default: true, name: `New regime (${law.newRegime})`, section: law.newRegime }, src.regimeNew);
  add('OLD', 'regime', { default: false, name: `Old regime (opted out under ${law.optOut})`, section: law.optOut }, src.regimeOld);

  add('NEW', 'slabs', { byAge: { ALL: NEW_SLABS } }, src.slabsNew);
  add('OLD', 'slabs', { byAge: OLD_SLABS }, src.slabsOld);

  add('NEW', 'standard_deduction', { amount: 75000, section: law.std }, src.std);
  add('OLD', 'standard_deduction', { amount: 50000, section: law.std }, src.std);

  add('NEW', 'rebate', { section: law.rebate, incomeLimit: 1200000, maxRebate: 60000, marginalRelief: true, residentOnly: true }, src.rebateNew);
  add('OLD', 'rebate', { section: law.rebate, incomeLimit: 500000, maxRebate: 12500, marginalRelief: false, residentOnly: true }, src.rebateOld);

  add('NEW', 'surcharge', { bands: SURCHARGE_BANDS, maxRate: 25, marginalRelief: true }, src.surchargeNew);
  add('OLD', 'surcharge', { bands: SURCHARGE_BANDS, maxRate: null, marginalRelief: true }, src.surchargeOld);

  both('cess', { rate: 4, name: 'Health and Education Cess' }, src.cess);

  const ded = (key, oldValue, sOld, sNew, newRefusal) => {
    add('OLD', key, { allowed: true, ...oldValue }, sOld);
    add('NEW', key, { allowed: false, section: oldValue.section, label: oldValue.label, refusal: newRefusal }, sNew);
  };
  const notNew = (what) => `${what} is not allowed in the new regime (${law.newRegimeExclusion}). It counts only if the old regime is chosen.`;

  ded('ded_80c', { section: law.s80c, label: `${law.s80c} — PF, PPF, ELSS, life insurance, tuition fees, home-loan principal, NSC, pension plans (80C + 80CCC + 80CCD(1) together)`, limit: 150000 }, src.s80c, src.newRefusals, notNew('80C'));
  ded('ded_80ccd1b', { section: law.s80ccd1b, label: `${law.s80ccd1b} — own NPS contribution, over and above 80C`, limit: 50000 }, src.s80ccd1b, src.newRefusals, notNew('80CCD(1B)'));
  add('OLD', 'ded_80ccd2', { allowed: true, section: law.s80ccd2, label: `${law.s80ccd2} — employer's NPS contribution`, pctGovt: 14, pctOther: 10, salaryBasis: 'Basic + DA' }, src.s80ccd2);
  add('NEW', 'ded_80ccd2', { allowed: true, section: law.s80ccd2, label: `${law.s80ccd2} — employer's NPS contribution`, pctGovt: 14, pctOther: 14, salaryBasis: 'Basic + DA' }, src.s80ccd2);
  ded('ded_80d', { section: law.s80d, label: `${law.s80d} — health insurance`, selfFamily: 25000, selfFamilySenior: 50000, parents: 25000, parentsSenior: 50000, preventiveWithin: 5000 }, src.s80d, src.newRefusals, notNew('80D (health insurance)'));
  ded('ded_24b', { section: law.s24b, label: `${law.s24b} — interest on a home loan, self-occupied house`, selfOccupiedLimit: 200000 }, src.s24b, src.newRefusals, notNew('Home-loan interest on a self-occupied house'));
  ded('ded_80e', { section: law.s80e, label: `${law.s80e} — interest on an education loan`, limit: null, years: 8 }, src.s80e, src.newRefusals, notNew('80E (education-loan interest)'));
  ded('ded_80tta', { section: law.s80tta, label: `${law.s80tta} — savings-bank interest`, limit: 10000, notForSeniors: true }, src.s80tt, src.newRefusals, notNew('80TTA'));
  ded('ded_80ttb', { section: law.s80ttb, label: `${law.s80ttb} — deposit interest of a senior citizen`, limit: 50000, seniorsOnly: true }, src.s80tt, src.newRefusals, notNew('80TTB'));
  ded('ded_80g', { section: law.s80g, label: `${law.s80g} — donations (the qualifying amount, worked out by the employee)`, passThrough: true }, src.s80g, src.newRefusals, notNew('80G (donations)'));

  ded('exempt_hra', { section: law.hra, label: `HRA exemption (${law.hra})`, metros: law.hraMetros, metroPct: 50, otherPct: 40, rentOverPctOfSalary: 10, salaryBasis: 'Basic + DA' }, src.hra, src.newRefusals, notNew('The HRA exemption'));
  ded('exempt_lta', { section: law.lta, label: `Leave travel (${law.lta})`, journeysPerBlock: 2, blockYears: 4, firstBlockStart: 2022, note: 'Actual fare only (the class the employee is entitled to, shortest route); two journeys in a block of four calendar years.' }, src.lta, src.newRefusals, notNew('The leave travel exemption'));
  both('exempt_gratuity', { allowed: true, section: law.gratuity, label: `Gratuity (${law.gratuity})`, cap: 2000000, note: 'Non-government employee: least of actual, the formula, and the cap (less what was exempted before).' }, src.gratuity);
  both('exempt_leave_encashment', { allowed: true, section: law.leave, label: `Leave encashment on retirement (${law.leave})`, cap: 2500000, note: 'Non-government employee: least of the four limbs; the cap is for a lifetime, across employers.' }, src.leave);

  add('OLD', 'professional_tax', { allowed: true, section: law.pt, label: `Professional tax (${law.pt})`, maxPerYear: 2500 }, src.pt);
  add('NEW', 'professional_tax', { allowed: false, section: law.pt, label: `Professional tax (${law.pt})`, maxPerYear: 2500, refusal: `Professional tax is not deductible in the new regime (${law.newRegimeExclusion}). It is still deducted from pay; it just does not lower the tax.` }, src.pt);

  both('forms', law.forms, src.forms);
  both('rounding', { taxableIncomeTo: 10, taxPayableTo: 10, section: law.rounding }, src.rounding);
  both('tds_rounding', { monthlyTdsTo: 1 }, ['Monthly TDS to the nearest rupee: the common practice of TDS software and the TRACES statements. The law rounds the year\'s tax payable to ₹10 (rounding rule); no official text found that sets the rounding of a monthly instalment.', URL.circular24of2022, 0]);
  return rows;
}

/* ── 2025-26 (FY 2025-26 = AY 2026-27), Income-tax Act, 1961 ─────────────── */
const ROWS_2025_26 = yearRows('2025-26', {
  newRegime: 'section 115BAC(1A)', optOut: 'section 115BAC(6)', newRegimeExclusion: 'section 115BAC(2)',
  std: 'section 16(ia)', rebate: 'section 87A', pt: 'section 16(iii)', rounding: 'sections 288A and 288B',
  s80c: 'section 80C', s80ccd1b: 'section 80CCD(1B)', s80ccd2: 'section 80CCD(2)', s80d: 'section 80D', s24b: 'section 24(b)',
  s80e: 'section 80E', s80tta: 'section 80TTA', s80ttb: 'section 80TTB', s80g: 'section 80G',
  hra: 'section 10(13A), rule 2A', lta: 'section 10(5), rule 2B', gratuity: 'section 10(10)(iii)', leave: 'section 10(10AA)(ii)',
  hraMetros: ['Mumbai', 'Delhi', 'Kolkata', 'Chennai'],
  forms: {
    act: 'Income-tax Act, 1961', rules: 'Income-tax Rules, 1962', salaryTdsSection: '192',
    certificate: { number: '16', label: 'Form 16' },
    quarterlyReturn: { number: '24Q', label: 'Form 24Q' },
    declaration: { number: '12BB', label: 'Form 12BB' },
    perquisites: { number: '12BA', label: 'Form 12BA' },
    previousEmployer: { number: '12B', label: 'Form 12B' },
    annualStatement: { number: '26AS', label: 'Form 26AS (with the AIS)' },
  },
}, {
  regimeNew: ['Rates in section 115BAC(1A) are the default rates unless the option under 115BAC(6) is exercised — Memorandum to the Finance Bill 2026, Part A.I, para 2.', URL.memo2026],
  regimeOld: ['Opting out of the new regime (section 115BAC(6)); a salaried person chooses each year with the return — Memorandum to the Finance Bill 2026, Part A.I.', URL.memo2026],
  slabsNew: ['incometax.gov.in › Salaried individuals for AY 2026-27 (new regime u/s 115BAC); the same table in the Memorandum to the Finance Bill 2026, Part A.I.', URL.itdSalaried],
  slabsOld: ['incometax.gov.in › Salaried individuals for AY 2026-27 (old regime, below 60 / 60–80 / 80+); First Schedule Part I-A per the Memorandum to the Finance Bill 2026.', URL.itdSalaried],
  std: ['CBDT ITR-1 validation rules AY 2026-27: standard deduction u/s 16(ia) up to ₹75,000 (new regime) / ₹50,000 (old regime).', URL.itr1Rules],
  rebateNew: ['Section 87A as amended by the Finance Act 2025: up to ₹60,000 where total income ≤ ₹12,00,000 (incometax.gov.in AY 2026-27); marginal relief — CBDT ITR-1 validation rule 191: no rebate above ₹12,70,590.', URL.itr1Rules],
  rebateOld: ['Section 87A, old regime: up to ₹12,500 where total income ≤ ₹5,00,000, no marginal relief (incometax.gov.in AY 2026-27; ITR-1 validation rule 192).', URL.itdSalaried],
  surchargeNew: ['incometax.gov.in AY 2026-27: 10% > ₹50 L, 15% > ₹1 Cr, 25% > ₹2 Cr, capped at 25% in the new regime; marginal relief at each threshold. Memorandum to the Finance Bill 2026, Part A.I(1).', URL.itdSalaried],
  surchargeOld: ['incometax.gov.in AY 2026-27: 10% > ₹50 L, 15% > ₹1 Cr, 25% > ₹2 Cr, 37% > ₹5 Cr (old regime); marginal relief at each threshold.', URL.itdSalaried],
  cess: ['Memorandum to the Finance Bill 2026, Part A.I(3): Health and Education Cess 4% of income-tax including surcharge for AY 2026-27; no marginal relief on cess.', URL.memo2026],
  s80c: ['incometax.gov.in AY 2026-27: 80C (with 80CCC and 80CCD(1)) combined ₹1,50,000, old regime only.', URL.itdSalaried],
  s80ccd1b: ['incometax.gov.in AY 2026-27: 80CCD(1B) ₹50,000 over and above 80C, old regime only.', URL.itdSalaried],
  s80ccd2: ['incometax.gov.in AY 2026-27: 80CCD(2) — old regime 10% of salary (PSU/others) or 14% (Central/State Govt); new regime 14% for all employers.', URL.itdSalaried],
  s80d: ['incometax.gov.in AY 2026-27: 80D ₹25,000 self/family (₹50,000 if a senior is covered), ₹25,000 parents (₹50,000 senior), preventive check-up ₹5,000 within these.', URL.itdSalaried],
  s24b: ['incometax.gov.in AY 2026-27: 24(b) interest on a self-occupied house ₹2,00,000 (loan on/after 1-4-1999), old regime.', URL.itdSalaried],
  s80e: ['CBDT Circular 24/2022 para 5.5.7: 80E interest on a higher-education loan, no monetary limit, the first year and seven following. Provision unchanged since.', URL.circular24of2022],
  s80tt: ['incometax.gov.in AY 2026-27: 80TTA ₹10,000 savings interest (not seniors); 80TTB ₹50,000 deposit interest (resident seniors); old regime.', URL.itdSalaried],
  s80g: ['80G is a pass-through (the qualifying amount the employee works out). New regime refused: CBDT ITR-1 validation rule 156.', URL.itr1Rules],
  newRefusals: ['Section 115BAC(2): new-regime income is computed without these. CBDT ITR-1 validation rules AY 2026-27 (rules 153–175) refuse each in the new regime.', URL.itr1Rules],
  hra: ['CBDT Circular 24/2022 para 5.3.10 (rule 2A): least of HRA received, rent − 10% of salary, 50% of salary in Mumbai/Delhi/Kolkata/Chennai else 40%; salary = Basic + DA. ITR-1 validation rules 261–263 (AY 2026-27).', URL.circular24of2022],
  lta: ['CBDT Circular 24/2022 para 5.3.1: section 10(5) subject to rule 2B; two journeys in a block of four calendar years (block 2022–2025), actual fare only.', URL.circular24of2022],
  gratuity: ['CBDT Circular 24/2022 para 5.3.2: ₹20 lakh w.e.f. 29-3-2018 (Notification 16/2019); ITR-1 validation rule 67 (AY 2026-27): ₹20,00,000 for non-government employers.', URL.circular24of2022],
  leave: ['PIB 24-5-2023: leave encashment exemption for non-government employees raised to ₹25 lakh w.e.f. 1-4-2023 (Notification 31/2023); ITR-1 validation rule 69 (AY 2026-27).', URL.pibLeave],
  pt: ['Section 16(iii): tax on employment within Article 276(2) of the Constitution (at most ₹2,500 a year) — CBDT Circular 24/2022 para 5.4.3. New regime: ITR-1 validation rule 168 (must be 0). Note: the ITR utility accepts up to ₹5,000 (validation rule 37 of ITR-2).', URL.circular24of2022],
  forms: ['Form 16 (rule 31), 24Q (rule 31A), 12BA (rule 26A(2)), 12B (rule 26A(1)) — TRACES forms page; Form 12BB under section 192 and Form 26AS/AIS — incometax.gov.in AY 2026-27.', URL.tracesForms],
  rounding: ['Total income rounded to the nearest ₹10 (section 288A; CBDT Circular 24/2022 para 9.1); any amount payable or refundable to the nearest ₹10, 5 and above up (section 288B).', URL.sec288B],
});

/* ── 2026-27 (tax year 2026-27), Income-tax Act, 2025 ───────────────────── */
const ROWS_2026_27 = yearRows('2026-27', {
  newRegime: 'section 202(1), was 115BAC(1A)', optOut: 'section 202(4), was 115BAC(6)', newRegimeExclusion: 'section 202(2), was 115BAC(2)',
  std: 'section 19(1) Table Sl. 2, was 16(ia)', rebate: 'section 156, was 87A', pt: 'section 19(1) Table Sl. 1, was 16(iii)', rounding: 'section 516, was 288A/288B',
  s80c: 'section 123, was 80C', s80ccd1b: 'section 124(3), was 80CCD(1B)', s80ccd2: 'section 124(1)–(2), was 80CCD(2)', s80d: 'section 126, was 80D',
  s24b: 'section 22(2), was 24(b)', s80e: 'section 129, was 80E', s80tta: 'section 153(2)(a), was 80TTA', s80ttb: 'section 153(2)(b), was 80TTB', s80g: 'section 133, was 80G',
  hra: 'Schedule III Sl. 11 and rule 279, was 10(13A) and rule 2A', lta: 'Schedule III Sl. 8 and rule 278, was 10(5) and rule 2B',
  gratuity: 'section 19(1) Table Sl. 6, was 10(10)(iii)', leave: 'section 19(1) Table Sl. 14, was 10(10AA)(ii)',
  hraMetros: ['Mumbai', 'Kolkata', 'Delhi', 'Chennai', 'Hyderabad', 'Pune', 'Ahmedabad', 'Bengaluru'],
  forms: {
    act: 'Income-tax Act, 2025', rules: 'Income-tax Rules, 2026', salaryTdsSection: '392',
    certificate: { number: '130', label: 'Form 130 (was Form 16)' },
    quarterlyReturn: { number: '138', label: 'Form 138 (was Form 24Q)' },
    declaration: { number: '124', label: 'Form 124 (was Form 12BB)' },
    perquisites: { number: '123', label: 'Form 123 (was Form 12BA)' },
    previousEmployer: { number: '122', label: 'Form 122 (was Form 12B)' },
    annualStatement: { number: '168', label: 'Form 168 — Annual Information Statement (was Form 26AS)' },
  },
}, {
  regimeNew: ['Income-tax Act 2025 section 202(1): the default rates unless the option under 202(4) is exercised (a salaried person: with the return). Memorandum to the Finance Bill 2026, Part A.II, para 2.', URL.act2025],
  regimeOld: ['Income-tax Act 2025 section 202(4)(b); rates then in Part I-B of the First Schedule (Finance Act 2026).', URL.act2025],
  slabsNew: ['Income-tax Act 2025 section 202(1) Table (Gazette 21-8-2025); unchanged for tax year 2026-27 — Memorandum to the Finance Bill 2026, Part A.II.', URL.act2025],
  slabsOld: ['Finance Act 2026 (No. 4 of 2026), First Schedule Part I-B, Paragraph A (I)–(III): below 60, 60–80, 80 and above.', URL.financeAct2026],
  std: ['Income-tax Act 2025 section 19(1) Table Sl. 2: ₹75,000 or the salary if less where tax is under 202(1); ₹50,000 in any other case.', URL.act2025],
  rebateNew: ['Income-tax Act 2025 section 156(2)–(3): 100% of tax or ₹60,000 where income ≤ ₹12 lakh; above it, the tax over (income − ₹12 lakh) is given up (marginal relief).', URL.act2025],
  rebateOld: ['Income-tax Act 2025 section 156(1): 100% of tax or ₹12,500 where total income ≤ ₹5,00,000.', URL.act2025],
  surchargeNew: ['Finance Act 2026 First Schedule (Part I-B para A(4), Part III) and Memorandum Part A.II: 10% / 15% / 25%; for income under section 202 the 37% band does not apply (restricted to 25%); marginal relief.', URL.financeAct2026],
  surchargeOld: ['Finance Act 2026 First Schedule Part I-B, Paragraph A(4): 10% > ₹50 L, 15% > ₹1 Cr, 25% > ₹2 Cr, 37% > ₹5 Cr; marginal relief (para 5).', URL.financeAct2026],
  cess: ['Finance Act 2026 section 2 (Health and Education Cess at 4% of income-tax and surcharge); Memorandum Part A.II: no marginal relief on cess.', URL.financeAct2026],
  s80c: ['Income-tax Act 2025 section 123: the aggregate of the sums in Schedule XV up to ₹1,50,000.', URL.act2025],
  s80ccd1b: ['Income-tax Act 2025 section 124(3): own NPS contribution up to ₹50,000 (not again under section 123).', URL.act2025],
  s80ccd2: ['Income-tax Act 2025 section 124(1): 14% (Central/State Govt employer) or 10% (other) of salary; 124(2): 14% for all where tax is under 202(1).', URL.act2025],
  s80d: ['Income-tax Act 2025 section 126(2)–(8): ₹25,000 self/family, ₹25,000 parents, ₹50,000 where the person is a senior citizen; preventive check-up ₹5,000 within.', URL.act2025],
  s24b: ['Income-tax Act 2025 section 22(2): self-occupied interest at most ₹2 lakh; Finance Act 2026 s.38 makes it include prior-period interest.', URL.financeAct2026],
  s80e: ['Income-tax Act 2025 section 129: education-loan interest, the initial tax year and seven following, no monetary limit.', URL.act2025],
  s80tt: ['Income-tax Act 2025 section 153(2): ₹10,000 savings interest (not a senior citizen); ₹50,000 deposit interest (senior citizen).', URL.act2025],
  s80g: ['Income-tax Act 2025 section 133 (donations); a pass-through amount. Refused in the new regime by section 202(2)(a)(xii).', URL.act2025],
  newRefusals: ['Income-tax Act 2025 section 202(2)(a): new-regime income is computed without Schedule III Sl. 8 (LTA) and 11 (HRA), section 19(1) Sl. 1 (professional tax), 22(1)(b) for a self-occupied house, and Chapter VIII other than 124(1)–(2), 125(2), 146.', URL.act2025],
  hra: ['Income-tax Rules 2026 rule 279: least of HRA received, rent − one-tenth of salary, 50% of salary in Mumbai, Kolkata, Delhi, Chennai, Hyderabad, Pune, Ahmedabad and Bengaluru, else 40%; salary = Basic + DA.', URL.rules2026],
  lta: ['Income-tax Act 2025 Schedule III Sl. 8; Income-tax Rules 2026 rule 278: actual fare, two journeys in a block of four calendar years commencing 2022.', URL.rules2026],
  gratuity: ['Income-tax Act 2025 section 19(1) Table Sl. 6(b): "amount specified by the Central Government, by notification". No notification under the 2025 Act found; ₹20,00,000 is CARRIED from the 1961 Act notification (16/2019). Check before use.', URL.act2025, 0],
  leave: ['Income-tax Act 2025 section 19(1) Table Sl. 14 and 19(2)(f): the limit is "specified by the Central Government, by notification". No notification under the 2025 Act found; ₹25,00,000 is CARRIED from Notification 31/2023. Check before use.', URL.act2025, 0],
  pt: ['Income-tax Act 2025 section 19(1) Table Sl. 1: tax on employment under Article 276(2) of the Constitution (at most ₹2,500 a year); not in the new regime (202(2)(a)(iv)).', URL.act2025],
  forms: ['Income-tax Rules 2026: Form 122 and 123 (rule 204), 124 (rule 205, claims under section 392(5)(b)), 130 (rule 215, certificate under section 395 for salary under 392), 138 (rule 219, quarterly statement under 397(3)(b)), 168 (rule 245, Annual Information Statement). Corrigendum notifications to the Rules (e.g. 64/2026) not checked.', URL.rules2026],
  rounding: ['Income-tax Act 2025 section 516: total income and any amount payable or refundable rounded to the nearest multiple of ₹10 (5 and above up), paise ignored.', URL.act2025],
});

/** Every seed row: { tax_year, regime, rule_key, value, source_note, source_url, verified }. */
export const TAX_RULE_ROWS = [...ROWS_2025_26, ...ROWS_2026_27];

/** The years the seed covers. */
export const SEEDED_YEARS = ['2025-26', '2026-27'];
