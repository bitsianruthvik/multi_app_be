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
  notif45: 'https://www.incometax.gov.in/iec/foportal/sites/default/files/2026-04/Notification%20No.45_2026.pdf',
  s71: 'https://www.incometaxindia.gov.in/w/section-71-128',
  s115bac: 'https://www.incometaxindia.gov.in/w/section-115bac-7',
  s112A: 'https://www.incometaxindia.gov.in/w/section-112a-65',
  s87A: 'https://www.incometaxindia.gov.in/w/section-87a-30',
  s234C: 'https://www.incometaxindia.gov.in/w/section-234c-40',
  s139: 'https://www.incometaxindia.gov.in/w/section-139-93',
  rules2026Gazette: 'https://www.incometaxindia.gov.in/documents/d/guest/en-notified-it-rules-2026-20-03-2026-pdf',
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

  add('NEW', 'surcharge', { bands: SURCHARGE_BANDS, maxRate: 25, marginalRelief: true, dividendCap: 15 }, src.surchargeNew);
  add('OLD', 'surcharge', { bands: SURCHARGE_BANDS, maxRate: null, marginalRelief: true, dividendCap: 15 }, src.surchargeOld);

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

  /* ── The RETURN's rules (the ITR helper, §25.6): what the employer side never needs ── */
  const r = law.ret;
  const hp = { section: r.hp, standardDeductionPct: 30, standardDeductionSection: r.hp30, interestSection: r.hpInterest, carryForwardYears: 8, carryForwardNote: r.hpCarry };
  add('OLD', 'house_property', { ...hp, lossSetOffAllowed: true, lossSetOffLimit: 200000, lossSetOffSection: r.hpSetOff, carryForwardAllowed: true }, src.hpOld);
  add('NEW', 'house_property', { ...hp, lossSetOffAllowed: false, lossSetOffLimit: 0, lossSetOffSection: r.hpSetOff, carryForwardAllowed: r.hpNewCarry, lossRefusal: r.hpNewRefusal }, src.hpNew);
  both('capital_gains', {
    stcgEquity: { section: r.s111A, rate: 20 }, ltcgEquity: { section: r.s112A, rate: 12.5, exemption: 125000 }, ltcgOther: { section: r.s112, rate: 12.5 },
    basicExemptionAdjust: true, shortfallSection: r.shortfall, surchargeCap: 15,
  }, src.cg);
  add('NEW', 'rebate_special', { excluded: ['111A', '112', '112A'], names: r.cgNames, text: r.rebateSpecialNew }, src.rebateSpecialNew);
  add('OLD', 'rebate_special', { excluded: ['112A'], names: r.cgNames, text: r.rebateSpecialOld }, src.rebateSpecialOld);
  both('itr_forms', {
    published: r.formsPublished, note: r.formsNote,
    ITR1: { name: r.itr1Name, maxTotalIncome: 5000000, maxHouseProperties: r.itr1MaxHouses, ltcg112aMax: 125000, ltcg112aSection: r.s112A, agriculturalIncomeMax: 5000, residentOnly: true },
    ITR2: { name: r.itr2Name },
  }, src.itrForms);
  both('interest_234', {
    sections: r.interestSections, ratePerMonth: 1, roundBaseDownTo: 100, roundingRule: r.rule119A,
    advanceTaxThreshold: 10000, thresholdSection: r.s208, bPct: 90, seniorExempt: true,
    seniorNote: `A resident senior citizen with no business income pays no advance tax (${r.s207}), so no interest under ${r.interestSections.b} or ${r.interestSections.c}.`,
    cgNote: `${r.interestSections.c}: tax on capital gains or dividends that came after an instalment date counts only from the next instalment (proviso); this estimate counts all income from the start of the year, so it may be higher than the portal's.`,
    instalments: [{ by: '06-15', cumPct: 15, safePct: 12, months: 3 }, { by: '09-15', cumPct: 45, safePct: 36, months: 3 }, { by: '12-15', cumPct: 75, safePct: 75, months: 3 }, { by: '03-15', cumPct: 100, safePct: 100, months: 1 }],
  }, src.interest);
  both('return_filing', { dueDate: r.dueDate, dueSection: r.dueSection, filedFrom: r.filedFrom }, src.due);
  both('regime_option', {
    oldRegimeNeedsDueDate: true, oldRegimeSection: r.oldRegimeSection,
    oldRegimeNote: `After the due date only the new regime can be used (${r.oldRegimeSection}).`,
  }, src.regimeOption);
  both('late_fee', { section: r.s234F, fee: 5000, smallIncomeFee: 1000, smallIncomeLimit: 500000 }, src.lateFee);
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
  ret: {
    hp: 'sections 22–24', hp30: 'section 24(a)', hpInterest: 'section 24(b)', hpSetOff: 'section 71(3A)',
    hpCarry: 'section 71B: against house-property income only, for 8 years, in a return filed by the due date',
    hpNewCarry: false, hpNewRefusal: 'in the new regime a house-property loss is not set off against any other head (section 115BAC(2)(ii)(b)) and is not carried forward — it is "deemed to have been given full effect" (section 115BAC(3)).',
    s111A: 'section 111A', s112A: 'section 112A', s112: 'section 112', shortfall: 'provisos to sections 111A(1), 112(1) and 112A(2)', cgNames: { '111A': '111A', 112: '112', '112A': '112A' },
    rebateSpecialNew: 'section 87A second proviso (Finance Act 2025): in the new regime the rebate cannot exceed the tax at the slab rates of section 115BAC(1A), so it never covers tax at special rates (111A, 112, 112A).',
    rebateSpecialOld: 'section 112A(6): the rebate under section 87A is not given on tax on section 112A gains.',
    formsPublished: true, formsNote: 'ITR-1 and ITR-2 for AY 2026-27 (income of FY 2025-26), Income-tax Act 1961, filed in 2026.',
    itr1Name: 'ITR-1 (Sahaj)', itr2Name: 'ITR-2', itr1MaxHouses: 2,
    interestSections: { a: 'section 234A', b: 'section 234B', c: 'section 234C' }, rule119A: 'rule 119A', s208: 'section 208', s207: 'section 207(2)',
    dueDate: '2026-07-31', dueSection: 'section 139(1) Explanation 2', filedFrom: '2026-04-01', oldRegimeSection: 'section 115BAC(6) proviso', s234F: 'section 234F',
  },
}, {
  regimeNew: ['Rates in section 115BAC(1A) are the default rates unless the option under 115BAC(6) is exercised — Memorandum to the Finance Bill 2026, Part A.I, para 2.', URL.memo2026],
  regimeOld: ['Opting out of the new regime (section 115BAC(6)); a salaried person chooses each year with the return — Memorandum to the Finance Bill 2026, Part A.I.', URL.memo2026],
  slabsNew: ['incometax.gov.in › Salaried individuals for AY 2026-27 (new regime u/s 115BAC); the same table in the Memorandum to the Finance Bill 2026, Part A.I.', URL.itdSalaried],
  slabsOld: ['incometax.gov.in › Salaried individuals for AY 2026-27 (old regime, below 60 / 60–80 / 80+); First Schedule Part I-A per the Memorandum to the Finance Bill 2026.', URL.itdSalaried],
  std: ['CBDT ITR-1 validation rules AY 2026-27: standard deduction u/s 16(ia) up to ₹75,000 (new regime) / ₹50,000 (old regime).', URL.itr1Rules],
  rebateNew: ['Section 87A as amended by the Finance Act 2025: up to ₹60,000 where total income ≤ ₹12,00,000 (incometax.gov.in AY 2026-27); marginal relief — CBDT ITR-1 validation rule 191: no rebate above ₹12,70,590.', URL.itr1Rules],
  rebateOld: ['Section 87A, old regime: up to ₹12,500 where total income ≤ ₹5,00,000, no marginal relief (incometax.gov.in AY 2026-27; ITR-1 validation rule 192).', URL.itdSalaried],
  surchargeNew: ['incometax.gov.in AY 2026-27: 10% > ₹50 L, 15% > ₹1 Cr, 25% > ₹2 Cr, capped at 25% in the new regime; marginal relief at each threshold. Memorandum to the Finance Bill 2026, Part A.I(1). Dividend cap: surcharge on the income-tax on dividend income (and 111A/112/112A gains) at most 15% — Finance Act 2026 First Schedule Part I-A, Paragraph F (since Finance Act 2022).', URL.itdSalaried],
  surchargeOld: ['incometax.gov.in AY 2026-27: 10% > ₹50 L, 15% > ₹1 Cr, 25% > ₹2 Cr, 37% > ₹5 Cr (old regime); marginal relief at each threshold. Dividend cap: surcharge on the income-tax on dividend income (and 111A/112/112A gains) at most 15% — Finance Act 2026 First Schedule Part I-A, Paragraph F (since Finance Act 2022).', URL.itdSalaried],
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
  hpOld: ['Section 24(a) 30% of the annual value, 24(b) interest (let out: in full; self-occupied ₹2,00,000); section 71(3A) loss set off against other heads at most ₹2,00,000; section 71B carry forward 8 years against house-property income.', URL.s71],
  hpNew: ['Section 115BAC(2)(i): no 24(b) for a self-occupied house; (2)(ii)(b): no set-off of a house-property loss with any other head; (3): such loss deemed given full effect (not carried forward). ITR-1 validation rule 160 / ITR-2 rule 264 (AY 2026-27).', URL.s115bac],
  cg: ['Section 111A: 20% for transfers on/after 23-7-2024; 112A: 12.5% on gains above ₹1,25,000; 112: 12.5% (land/building bought before 23-7-2024 may use 20% with indexation — not modelled); the resident basic-exemption shortfall provisos. Surcharge cap of 15% on these gains (First Schedule) not re-read.', URL.s112A],
  rebateSpecialNew: ['Section 87A second proviso (Finance Act 2025, w.e.f. 1-4-2026): the rebate shall not exceed the tax at the rates of 115BAC(1A); Memorandum to the Finance Bill 2025: no rebate on tax at special rates (111A, 112 …). The ₹12 lakh limit is on total income incl. gains (ITR-2 validation rule 484).', URL.s87A],
  rebateSpecialOld: ['Section 112A(6): the 87A rebate is allowed from the tax on total income as reduced by the tax on 112A gains; no bar for 111A / 112 tax in the old regime.', URL.s112A],
  itrForms: ['Notification 45/2026 (ITR-1, 30-3-2026): resident other than RNOR, total income up to ₹50 lakh, salary, TWO house properties, other sources, LTCG u/s 112A up to ₹1.25 lakh, agricultural income up to ₹5,000; not for a director, unlisted shares, foreign assets, 194N TDS, deferred ESOP tax; no STCG, no losses brought or carried forward (portal help). ITR-2: Notification 46/2026.', URL.notif45],
  interest: ['Sections 234A, 234B (advance tax below 90% of assessed tax, 1% a month from 1 April), 234C (15/45/75/100% by 15 Jun/Sep/Dec/Mar, 12%/36% safe, 3/3/3/1 months), 208 (₹10,000), 207(2) (resident senior, no business). Rule 119A (base down to ₹100, part month = month) not read in the 1962 text; the 2026 Rules (rule 269) say the same.', URL.s234C],
  due: ['Section 139(1) Explanation 2 as substituted by the Finance Act 2026 s.5: "any other assessee" 31 July → 31-7-2026 for AY 2026-27; no extension for non-audit cases found (Circular 7/2026 extends audit cases only).', URL.s139],
  regimeOption: ['Section 115BAC(6) proviso: a person without business income leaves the new regime only in a return filed by the due date under 139(1). Not re-read in the Act text for this release.', URL.s115bac, 0],
  lateFee: ['Section 234F: ₹5,000 for a return after the due date, ₹1,000 if total income does not exceed ₹5 lakh. Not re-read in the Act text for this release.', URL.s139, 0],
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
  ret: {
    hp: 'sections 20–22, was 22–24', hp30: 'section 22(1)(a), was 24(a)', hpInterest: 'section 22(1)(b), was 24(b)', hpSetOff: 'section 109(1)(b), was 71(3A)',
    hpCarry: 'section 110, was 71B: against house-property income only, for 8 tax years',
    hpNewCarry: false, hpNewRefusal: 'in the new regime a house-property loss is not set off against any other head (section 202(2)(b)(ii)) and is not carried forward — it is "deemed to have been given full effect" (section 202(3)).',
    s111A: 'section 196, was 111A', s112A: 'section 198, was 112A', s112: 'section 197, was 112', shortfall: 'sections 196(2), 197(2), 198(3)', cgNames: { '111A': '196 (was 111A)', 112: '197 (was 112)', '112A': '198 (was 112A)' },
    rebateSpecialNew: 'section 156(3), was 87A: in the new regime the rebate cannot exceed the tax at the rates of section 202(1), so it never covers tax at special rates (sections 196, 197, 198).',
    rebateSpecialOld: 'section 198(7), was 112A(6): the rebate under section 156 is not given on tax on section 198 gains.',
    formsPublished: false, formsNote: 'Income-tax Rules 2026 rule 164 keeps the names (ITR-1 Sahaj, ITR-2 …) and sets who may use them for the tax year from 1 April 2026; the forms themselves, their JSON schemas and utilities are not published yet (to be notified before the due date; filed from April 2027).',
    itr1Name: 'ITR-1 (Sahaj)', itr2Name: 'ITR-2', itr1MaxHouses: 2,
    interestSections: { a: 'section 423 (was 234A)', b: 'section 424 (was 234B)', c: 'section 425 (was 234C)' }, rule119A: 'rule 269 (was 119A)', s208: 'section 404 (was 208)', s207: 'section 403(3) (was 207(2))',
    dueDate: '2027-07-31', dueSection: 'section 263(1)(c), was 139(1)', filedFrom: '2027-04-01', oldRegimeSection: 'section 202(4), was 115BAC(6)', s234F: 'the late fee of the 2025 Act (was 234F)',
  },
}, {
  regimeNew: ['Income-tax Act 2025 section 202(1): the default rates unless the option under 202(4) is exercised (a salaried person: with the return). Memorandum to the Finance Bill 2026, Part A.II, para 2.', URL.act2025],
  regimeOld: ['Income-tax Act 2025 section 202(4)(b); rates then in Part I-B of the First Schedule (Finance Act 2026).', URL.act2025],
  slabsNew: ['Income-tax Act 2025 section 202(1) Table (Gazette 21-8-2025); unchanged for tax year 2026-27 — Memorandum to the Finance Bill 2026, Part A.II.', URL.act2025],
  slabsOld: ['Finance Act 2026 (No. 4 of 2026), First Schedule Part I-B, Paragraph A (I)–(III): below 60, 60–80, 80 and above.', URL.financeAct2026],
  std: ['Income-tax Act 2025 section 19(1) Table Sl. 2: ₹75,000 or the salary if less where tax is under 202(1); ₹50,000 in any other case.', URL.act2025],
  rebateNew: ['Income-tax Act 2025 section 156(2)–(3): 100% of tax or ₹60,000 where income ≤ ₹12 lakh; above it, the tax over (income − ₹12 lakh) is given up (marginal relief).', URL.act2025],
  rebateOld: ['Income-tax Act 2025 section 156(1): 100% of tax or ₹12,500 where total income ≤ ₹5,00,000.', URL.act2025],
  surchargeNew: ['Finance Act 2026 First Schedule (Part I-B para A(4), Part III) and Memorandum Part A.II: 10% / 15% / 25%; for income under section 202 the 37% band does not apply (restricted to 25%); marginal relief. Dividend cap: surcharge on the income-tax on dividend income (and gains under s.196/197/198) at most 15% — Part I-B, Paragraph F, and s.3(4)(b) table.', URL.financeAct2026],
  surchargeOld: ['Finance Act 2026 First Schedule Part I-B, Paragraph A(4): 10% > ₹50 L, 15% > ₹1 Cr, 25% > ₹2 Cr, 37% > ₹5 Cr; marginal relief (para 5). Dividend cap: surcharge on the income-tax on dividend income (and gains under s.196/197/198) at most 15% — Part I-B, Paragraph F.', URL.financeAct2026],
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
  hpOld: ['Income-tax Act 2025 s.21(3) (municipal taxes paid), s.22(1)(a) 30%, 22(1)(b) interest, 22(2) self-occupied ₹2,00,000; s.109(1)(b) loss set off against other heads up to 200000; s.110 carry forward 8 tax years.', URL.act2025],
  hpNew: ['Income-tax Act 2025 s.202(2)(a)(v): no s.22(1)(b) interest for a self-occupied house; 202(2)(b)(ii): no set-off of a house-property loss with any other head; 202(3): deemed given full effect.', URL.act2025],
  cg: ['Income-tax Act 2025 s.196 (was 111A) 20%, s.197 (was 112) 12.5%, s.198 (was 112A) 12.5% above 125000; shortfall s.196(2), 197(2), 198(3). Surcharge cap 15% carried from the 1961 Schedule (not re-read).', URL.act2025],
  rebateSpecialNew: ['Income-tax Act 2025 s.156(2)–(3): new regime rebate up to 60000 where total income ≤ 12 lakh, with marginal relief, and not exceeding the tax at the rates of s.202(1).', URL.act2025],
  rebateSpecialOld: ['Income-tax Act 2025 s.198(7) (was 112A(6)): the s.156 rebate from the tax on total income as reduced by the tax on s.198 gains.', URL.act2025],
  itrForms: ['Income-tax Rules 2026 rule 164(2)–(4): ITR-1 for a resident other than RNOR, at most two house properties, LTCG u/s 198 up to 125000, agricultural income up to 5000, total income up to fifty lakh; not a director, no unlisted shares, no foreign assets/income; ITR-2 otherwise (no business income). Forms and schemas not yet published (portal FAQ Q11).', URL.rules2026Gazette],
  interest: ['Income-tax Act 2025 s.423 (was 234A), s.424 (was 234B; below 90% of assessed tax, from 1 April), s.425 (was 234C; 15/45/75/100%, 12%/36% safe, CG and dividend carve-out), s.404 (₹10,000), s.403(3) (resident senior); Rules 2026 rule 269: part month = month, amount down to a multiple of 100.', URL.act2025],
  due: ['Income-tax Act 2025 s.263(1)(c) as substituted by the Finance Act 2026 s.66: "any other assessee" 31st July → 31-7-2027 for tax year 2026-27.', URL.financeAct2026],
  regimeOption: ['Income-tax Act 2025 s.202(4): the option to leave the new regime, for a person without business income, with the return filed by the due date. Carried from the 1961 rule; not re-read.', URL.act2025, 0],
  lateFee: ['The late-filing fee of the 2025 Act (was 234F: ₹5,000, ₹1,000 if income ≤ ₹5 lakh). Its section and amounts not read in the 2025 Act — carried from the 1961 Act.', URL.act2025, 0],
});

/* ── PAYROLL's rules (income tax in payroll, §25.4 P2): no PAN, declarations, deposit, return ──
 * Read 2026-10-20. The same in both regimes of a year (they are about deducting, not about the tax). */
const PAYROLL_URL = {
  rules2026: URL.rules2026,
  act2025: URL.act2025,
  circular24of2022: URL.circular24of2022,
  protean: 'https://tinpan.proteantech.in/downloads/e-tds/eTDS-download-regular.html',
};
function payrollRows(year, p) {
  const rows = [];
  const both = (rule_key, value, [source_note, source_url, verified = 1]) => {
    for (const regime of ['OLD', 'NEW']) rows.push({ tax_year: year, regime, rule_key, value, source_note, source_url, verified });
  };
  // No PAN: the year's tax at the higher of the average rate and 20% (a salary has no rate of its own);
  // nothing when the income is below the taxable limit (the tax worked out is nil).
  both('tds_no_pan', { rate: 20, section: p.noPanSection, method: 'AVERAGE_RATE_OR_RATE', nilWhenNoTax: true, returnRemark: 'C' }, p.noPanSrc);
  both('declarations', { form: p.declForm, landlordPanAbove: 100000, landlordPanSection: p.declSection, lenderPanRequired: 'when the lender is not a financial institution or the employer' }, p.declSrc);
  both('tds_deposit', { dueDay: 7, marchDue: '04-30', section: p.depositSection }, p.depositSrc);
  both('tds_return', {
    form: p.returnForm, quarterDue: { Q1: '07-31', Q2: '10-31', Q3: '01-31', Q4: '05-31' }, section: p.returnSection,
    sectionCode: p.sectionCode, higherRateRemark: 'C', certificateDue: '06-15', certificateSection: p.certSection,
    rpu: p.rpu, fileFormat: p.fileFormat,
  }, p.returnSrc);
  return rows;
}
const PAYROLL_ROWS = [
  ...payrollRows('2025-26', {
    noPanSection: 'section 206AA', declForm: 'Form 12BB (rule 26C)', declSection: 'rule 26C, section 192(2D)', depositSection: 'rule 30(2)', returnForm: 'Form 24Q', returnSection: 'rule 31A',
    sectionCode: '92B', certSection: 'rule 31 (Form 16)', rpu: 'Protean RPU 6.0 (statements up to FY 2025-26)', fileFormat: 'File Format for Form No. 24Q, Version 7.5 (Q4) — the ^-delimited text the FVU 9.5 validates',
    noPanSrc: ['CBDT Circular 24/2022 para 4.9.2 (salary): where income computed for TDS is below the taxable limit no tax is deducted; else the average rate, and 20% if the average rate is below 20%. Section 206AA. Cess: para 4.9 is silent; para 2.3 adds 4% cess to income tax (the "no cess on 20%" reading is only in secondary sources — not used).', PAYROLL_URL.circular24of2022],
    declSrc: ['Form 12BB (rule 26C) as reproduced in CBDT Circular 24/2022 Annexure IIa: landlord PAN when the aggregate rent paid in the year exceeds ₹1,00,000; lender name, address and PAN for home-loan interest.', PAYROLL_URL.circular24of2022],
    depositSrc: ['Rule 30(2) of the 1962 Rules (CBDT Circular 24/2022 para 4.4): TDS on salary deposited by the 7th of the next month; for March by 30 April.', PAYROLL_URL.circular24of2022],
    returnSrc: ['Rule 31A: Form 24Q quarterly — 31 Jul, 31 Oct, 31 Jan, 31 May; section code 92B (non-government employees); Form 16 by 15 June (Circular 24/2022 paras 4.6, 4.10.1). Protean e-TDS downloads page: RPU 6.0 / FVU 9.5 up to FY 2025-26.', PAYROLL_URL.protean],
  }),
  ...payrollRows('2026-27', {
    noPanSection: 'section 397(2)(b)(i), was 206AA', declForm: 'Form 124 (rule 205), was 12BB', declSection: 'rule 205(2), section 392(5)(b)', depositSection: 'rule 218(2), was rule 30', returnForm: 'Form 138 (was 24Q)', returnSection: 'rule 219, was 31A',
    sectionCode: '1002', certSection: 'rule 215 (Form 130)', rpu: 'Protean RPU 1.2 (tax year 2026-27 onward)', fileFormat: 'File Format for Form Number 138 (24Q) Q1 to Q3, Version 1.2 (22-07-2026); the Q4 format (Annexure II) is "expected to be released soon" on the Protean page',
    noPanSrc: ['Income-tax Act 2025 section 397(2)(b)(i): no PAN → the higher of the rate in the provision, the rates in force, or 20%. Salary has no rate of its own (section 392(1): the average rate), so the 1961 method of Circular 24/2022 para 4.9.2 (average rate vs 20%, nil below the taxable limit) is carried; no 2026 salary circular found. Form 138 Annexure I remark "C" for the higher rate under 397(2).', PAYROLL_URL.act2025],
    declSrc: ['Income-tax Rules 2026 rule 205(2) and Form 124 Note 3: name, address and PAN of the landlord where the aggregate rent paid in the tax year exceeds ₹1,00,000 (and the relationship, and Aadhaar on the form); lender name, address and PAN for interest under house property.', PAYROLL_URL.rules2026],
    depositSrc: ['Income-tax Rules 2026 rule 218(2): a deductor other than a government office pays within 7 days from the end of the month; for March by 30 April.', PAYROLL_URL.rules2026],
    returnSrc: ['Income-tax Rules 2026 rule 219: Form 138 due 31 Jul, 31 Oct, 31 Jan and 31 May; rule 215: Form 130 by 15 June. Section code 1002 (payments to employees other than Govt. employees, s.392) — Protean file format for Form 138 v1.2, Annexure 2. RPU 1.2 / FVU 1.2 for tax year 2026-27 (Protean e-TDS downloads page).', PAYROLL_URL.protean],
  }),
];

/* ── PAYROLL EXTRAS' rules (P3a, §25.5): relief for arrears (Form 10E / Form 39), perquisites ──
 * Read 2026-10-20. The same in both regimes of a year (relief u/s 89 / 157 is not excluded by the new
 * regime: it is not in the lists of section 115BAC(2) / 202(2)). */
const EXTRAS_URL = {
  rules2026: URL.rules2026,
  act2025: URL.act2025,
  circular24of2022: URL.circular24of2022,
  rule21A: 'https://www.incometaxindia.gov.in/w/rule-21a',
  form10eHelp: 'https://www.incometax.gov.in/iec/foportal/help/statutory-forms/popular-form/form10e-um',
};
function extrasRows(year, x) {
  const rows = [];
  const both = (rule_key, value, [source_note, source_url, verified = 1]) => {
    for (const regime of ['OLD', 'NEW']) rows.push({ tax_year: year, regime, rule_key, value, source_note, source_url, verified });
  };
  both('relief_arrears', x.relief, x.reliefSrc);
  if (x.perquisites) both('perquisites', x.perquisites, x.perquisitesSrc);
  return rows;
}
const ACCOMMODATION_BANDS = [
  { key: 'ABOVE_40L', words: 'a city of more than 40 lakh people', pct: 10 },
  { key: '15L_TO_40L', words: 'a city of more than 15 lakh and up to 40 lakh people', pct: 7.5 },
  { key: 'UP_TO_15L', words: 'any other place', pct: 5 },
];
const SBI_URL = 'https://sbi.bank.in/web/business/information/interest-rates-perquisite-calculation';
const EXTRAS_ROWS = [
  ...extrasRows('2025-26', {
    perquisites: {
      section: 'section 17(2)', rule: 'rule 3 of the Income-tax Rules, 1962', statement: 'Form 12BA',
      specifiedEmployee: { monetarySalaryAbove: 400000, section: 'section 17(2)(iii), rule 3C (Notification 133/2025)' },
      car: { mixed: { small: { employerPays: 1800, employeePays: 600 }, large: { employerPays: 2400, employeePays: 900 } }, chauffeur: 900, wearAndTearPct: 10, electricAsSmall: false, otherConveyanceLess: 900 },
      accommodation: { census: 2011, bands: ACCOMMODATION_BANDS, leasedPct: 10, hotelPct: 24, hotelFreeDays: 15, furniturePct: 10, transferDays: 90 },
      loan: { smallLoansUpTo: 20000, medicalExempt: true, medicalRule: 'rule 3A', sbiRateDate: '2025-04-01', sbiRates: { HOUSING: 8.25, CAR: 9.2, PERSONAL: 10.3, EDUCATION: 9.9, OTHER: 10.3 },
        sbiNote: 'SBI publishes ranges (by credit score or scheme); these are the LOWEST rate of each range on 1-4-2025 (home 8.25%, car 9.20–10.15%, personal 10.30–15.30%, education 9.90–10.90%). Set the rate the company uses on a loan where it differs.' },
      gift: { nilBelow: 5000, note: 'the whole amount once the year\'s gifts reach the threshold — the common reading; some read it as only the excess' },
      meal: { perMeal: 50 },
    },
    perquisitesSrc: ['Rule 3 of the 1962 Rules as in CBDT Circular 24/2022 (car Table II: ₹1,800 / ₹2,400 employer pays, ₹600 / ₹900 employee pays, chauffeur ₹900, wear and tear 10%; loans at the SBI rate on the 1st day of the year on the month-end balance, nil up to ₹20,000 and for rule 3A diseases; gifts nil below ₹5,000; credit card and club less official use and recovery). Accommodation as substituted by Notification 65/2023 from 1-9-2023 (2011 census: 10% > 40 lakh, 7.5% 15–40 lakh, 5% else; leased: lower of rent and 10%; hotel 24%; furniture 10%) — read in CBDT Circular 3/2025 on a THIRD-PARTY copy (the official PDF refused to open). Specified-employee limit ₹4,00,000 (rule 3C, Notification 133/2025) from a secondary source only. SBI rates on 1-4-2025 from SBI\'s perquisite-rate page (' + SBI_URL + '). Not verified: the accommodation table and rule 3C were not read on an official site; the gift threshold reading.', URL.circular24of2022, 0],
    relief: {
      section: 'section 89(1)', rule: 'rule 21A(2) of the Income-tax Rules, 1962', formNumber: '10E', formLabel: 'Form 10E', formRule: 'rule 21AA',
      employerSection: 'section 192(2A)', newRegimeAllowed: true,
      employerNote: 'The employer may give this relief in the TDS when the employee furnishes these particulars in Form 10E (section 192(2A), rule 21AA). The employee files Form 10E online on the e-filing portal before the return; without it the relief claimed in the return is not allowed.',
    },
    reliefSrc: ['Rule 21A(2)(a)–(d) of the 1962 Rules (incometaxindia.gov.in): tax on the additional salary in the year of receipt (total income − the same income reduced by it) less the aggregate, for each year it relates to, of tax on that year\'s total income increased by it − tax on that year\'s total income; relief when the first is more. Rule 21AA: particulars in Form 10E to the employer; s.192(2A) via CBDT Circular 24/2022 paras 3.5.1–3.5.2. Form 10E filing before the return: incometax.gov.in Form 10E help. Annexure I / Table "A" wording read on a third-party copy of the pre-2024 form (the official PDF did not open); the form was amended by the IT (Eighth Amendment) Rules 2024 — check the portal\'s current form.', EXTRAS_URL.rule21A],
  }),
  ...extrasRows('2026-27', {
    perquisites: {
      section: 'section 17(1), was 17(2)', rule: 'rule 15 of the Income-tax Rules, 2026, was rule 3', statement: 'Form 123 (was Form 12BA)',
      specifiedEmployee: { monetarySalaryAbove: 400000, section: 'section 17(1)(c), rule 17' },
      car: { mixed: { small: { employerPays: 5000, employeePays: 2000 }, large: { employerPays: 7000, employeePays: 3000 } }, chauffeur: 3000, wearAndTearPct: 10, electricAsSmall: true, otherConveyanceLess: 3000 },
      accommodation: { census: 2011, bands: ACCOMMODATION_BANDS, leasedPct: 10, hotelPct: 24, hotelFreeDays: 15, furniturePct: 10, transferDays: 90 },
      loan: { smallLoansUpTo: 200000, medicalExempt: true, medicalRule: 'rule 18', sbiRateDate: '2026-04-01', sbiRates: { HOUSING: 7.25, CAR: 8.7, PERSONAL: 10, EDUCATION: 8.9, OTHER: 10 },
        sbiNote: 'SBI publishes ranges (by credit score or scheme); these are the LOWEST rate of each range on 1-4-2026 (home 7.25%, car 8.70–9.85%, personal 10.00–15.00%, education 8.90–9.90%). Set the rate the company uses on a loan where it differs.' },
      gift: { nilBelow: 15000, note: 'the whole amount once the year\'s gifts reach the threshold — the common reading; some read it as only the excess' },
      meal: { perMeal: 200 },
    },
    perquisitesSrc: ['Income-tax Act 2025 s.17(1); Income-tax Rules 2026 rule 15 (G.S.R. 198(E), Gazette pp. 1541–1547): Table II car ₹5,000 / ₹7,000 (up to 1.6 L or ELECTRIC / above) employer pays, ₹2,000 / ₹3,000 employee pays, chauffeur ₹3,000, wear and tear 10% (15(3)(d)); Table I accommodation 10% / 7.5% / 5% by 2011 population (> 40 lakh, 15–40 lakh, else), leased lower of rent and 10%, hotel 24%, furniture 10% (15(2)(e)); Table IV loans at the SBI rate on the 1st day of the tax year on the month-end balance, nil up to ₹2,00,000 and for rule 18 diseases; gifts nil below ₹15,000; credit card and club less official use (15(5)(b)) and recovery; meals ₹200. Specified employee ₹4,00,000 (rule 17). SBI rates on 1-4-2026: SBI\'s perquisite-rate page (' + SBI_URL + '); SBI gives ranges — the lowest is seeded.', URL.rules2026, 1],
    relief: {
      section: 'section 157(1), was 89(1)', rule: 'rule 73 (Table Sl. 1) of the Income-tax Rules, 2026, was rule 21A', formNumber: '39', formLabel: 'Form No. 39 (was Form 10E)', formRule: 'rule 73(3)',
      employerSection: 'section 392(4)(a)(ii), was 192(2A)', newRegimeAllowed: true,
      employerNote: 'The employer may take this relief into account in the TDS when the employee furnishes the particulars of Form No. 39 (section 392(4)(a)(ii); rule 73(4)). To claim it the employee furnishes Form No. 39 on or before the due date of the return (rule 73(3), section 263(1)(c)).',
    },
    reliefSrc: ['Income-tax Act 2025 s.157 ("Relief when salary, etc., is paid in arrears or in advance"); s.202(2) does not list it. Income-tax Rules 2026 rule 73 Table Sl. 1: relief = A − B where A = C − D (tax on total income of the relevant tax year − tax on it reduced by the additional salary) and B = the sum of E = F − G for each earlier tax year (tax on that year\'s income increased by it − tax on that year\'s income); rule 73(3) Form No. 39 by the due date u/s 263(1)(c); rule 73(4) to the employer; s.392(4)(a)(ii). Form No. 39 Part B item 3 rows (i) A–G and (ii)–(viii) read in the notified Rules.', EXTRAS_URL.rules2026],
  }),
];

/* ── PAYROLL EXIT's rules (P3b, §25.5): employer retirement contributions above the limit; the full and final ──
 * Read 2026-10-20. The same in both regimes of a year (a perquisite; gratuity and leave encashment are not in the
 * new regime's exclusions — s.115BAC(2) / s.202(2) list neither). */
const EXIT_URL = {
  rule3B: 'https://www.incometaxindia.gov.in/w/rule-3b-2',
  act2025: URL.act2025,
  rules2026: URL.rules2026,
  gratuityAct: 'https://labour.gov.in/sites/default/files/the_payment_of_gratuity_act_1972.pdf',
};
function exitRows(year, x) {
  const rows = [];
  const both = (rule_key, value, [source_note, source_url, verified = 1]) => {
    for (const regime of ['OLD', 'NEW']) rows.push({ tax_year: year, regime, rule_key, value, source_note, source_url, verified });
  };
  both('retirement_contributions', x.retirement, x.retirementSrc);
  both('final_settlement', x.settlement, x.settlementSrc);
  return rows;
}
const SETTLEMENT = (exemptGratuity, exemptLeave) => ({
  gratuity: {
    eligibleYears: 5, daysPerYear: 15, divisor: 26, partYearMoreThanMonths: 6, actCeiling: 2000000,
    act: 'Payment of Gratuity Act 1972 s.4 (Code on Social Security 2020 s.53 from 21-11-2025)', exemptSection: exemptGratuity,
    notApplied: 'Not applied: the Code\'s 1-year eligibility of a fixed-term employee and its 50% wage rule (s.2(88)) — the wage is the components marked "in the gratuity wage".',
  },
  leaveEncashment: { averageMonths: 10, daysPerYear: 30, exemptSection: exemptLeave },
});
const EXIT_ROWS = [
  ...exitRows('2025-26', {
    retirement: {
      limit: 750000, section: 'section 17(2)(vii)', accretionSection: 'section 17(2)(viia)', accretionRule: 'rule 3B',
      funds: 'recognised provident fund, NPS (s.80CCD(1)), approved superannuation fund', statementRow: { contribution: 17, accretion: 18 },
      pfCounts: 'the employer\'s whole PF line (EPF and EPS): CHECK with the CA whether the EPS share counts',
    },
    retirementSrc: ['Rule 3B of the Income-tax Rules 1962 (incometaxindia.gov.in, read 2026-10-20): TP = (PC/2) × R + (PC1 + TP1) × R, R = I / Favg, PC the contribution "in excess of seven lakh fifty thousand rupees" to the funds of s.17(2)(vii) (Finance Act 2020, from AY 2021-22); TP1 and PC1 from 1-4-2020; the part of TP1 + PC1 above the opening balance ignored (not applied here). The s.17(2)(vii) text itself was read only through rule 3B.', EXIT_URL.rule3B, 1],
    settlement: SETTLEMENT('section 10(10)(ii) (covered by the Gratuity Act) / 10(10)(iii)', 'section 10(10AA)(ii)'),
    settlementSrc: ['Payment of Gratuity Act 1972 s.4(1) five years, s.4(2) fifteen days\' wages a completed year or part of it above six months, monthly wage ÷ 26 × 15, s.4(3) ceiling ₹20,00,000 (S.O. 1420(E), 29-3-2018); from 21-11-2025 the Code on Social Security 2020 s.53 (S.O. 5319(E)). Leave encashment limbs of s.10(10AA)(ii): 10 months\' average salary, leave at most 30 days a year of service. NOT VERIFIED: the Act, the Code and the notifications were read on secondary sources only (labour.gov.in did not open).', EXIT_URL.gratuityAct, 0],
  }),
  ...exitRows('2026-27', {
    retirement: {
      limit: 750000, section: 'section 17(1)(h) (was 17(2)(vii))', accretionSection: 'section 17(1)(i) (was 17(2)(viia))', accretionRule: 'rule 16 of the 2026 Rules (was rule 3B)',
      funds: 'recognised provident fund, the scheme of s.124(1) (NPS), approved superannuation fund', statementRow: { contribution: 17, accretion: 18 },
      pfCounts: 'the employer\'s whole PF line (EPF and EPS): CHECK with the CA whether the EPS share counts',
    },
    retirementSrc: ['Income-tax Act 2025 s.17(1)(h): the aggregate contribution "in excess of ₹750000 in a tax year" by the employer to a recognised provident fund, the scheme of s.124(1) and an approved superannuation fund; s.17(1)(i) the annual accretion on it; Income-tax Rules 2026 rule 16: TP = (PC/2) × R + (PC1 + TP1) × R, R = I / F(avg.) (the printed PC reads "₹750000 lakhs" — a typo). Read in the official gazette PDFs.', EXIT_URL.rules2026, 1],
    settlement: SETTLEMENT('section 19(1) Table Sl. 5 (Gratuity Act) / Sl. 6, was 10(10)', 'section 19(1) Table Sl. 14, was 10(10AA)(ii)'),
    settlementSrc: ['Income-tax Act 2025 s.19(1) Table Sl. 5 (gratuity under the Payment of Gratuity Act 1972, "as per section 4(2) and (3)" — the Act still names the repealed 1972 Act), Sl. 6, Sl. 14 (leave encashment: ten months\' average salary, leave at most 30 days a year), read in the official PDF. The gratuity formula and ceiling: Payment of Gratuity Act s.4 / Code on Social Security 2020 s.53 (in force 21-11-2025, S.O. 5319(E)) — secondary sources only. NOT VERIFIED.', EXIT_URL.act2025, 0],
  }),
];

/** Every seed row: { tax_year, regime, rule_key, value, source_note, source_url, verified }. */
export const TAX_RULE_ROWS = [...ROWS_2025_26, ...ROWS_2026_27, ...PAYROLL_ROWS, ...EXTRAS_ROWS, ...EXIT_ROWS];

/** The years the seed covers. */
export const SEEDED_YEARS = ['2025-26', '2026-27'];
