/**
 * services/tax — the CF_HRMS income tax engine for Indian salary TDS
 * (TM/CF_HRMS_HIRING_SPEC.md §25.3). Engine only: P2 wires it into payroll and screens.
 *
 * WHAT IS COMPUTED
 *   computeTax(input, rules)       one person's tax for a year in one regime: gross salary,
 *                                  exemptions (HRA, LTA, gratuity, leave encashment), the previous
 *                                  employer's salary, standard deduction, professional tax, other
 *                                  income, house-property interest, deductions (80C … / s.123 …),
 *                                  taxable income (to ₹10), slab tax, rebate with marginal relief,
 *                                  surcharge with marginal relief and the new-regime 25% cap, cess,
 *                                  total tax (to ₹10) — and `lines`, a worksheet in plain words with
 *                                  each step's rule and source. Claims a regime refuses are listed in
 *                                  `refused` with the reason. NEW is the default regime.
 *   compareRegimes(input, rulesOld, rulesNew)  both regimes, the cheaper (a tie → NEW), the difference.
 *   projectYear(input, rules)      the year projected from paid months + months to come + one-time
 *                                  items, and this month's TDS = (projected tax − TDS so far − previous
 *                                  employer's TDS) ÷ months left, to the rupee, never below 0.
 *   All pure: no database access inside a calculation.
 *
 * WHERE THE RULES LIVE
 *   Table hrms_tax_rules (global, not per company; models/init.sql §27): one row per
 *   (tax_year, regime, rule_key) with value_json, source_note, source_url, verified.
 *   Seeded from ruleData.js by apps/cf_hrms/scripts/seed-tax-rules.mjs (dry run by default).
 *   loadTaxRules(db, year, regime) reads them (rules.js); rulesFromSeed(year, regime) gives
 *   the same from ruleData.js without a database (tests).
 *   Rule keys: regime, slabs, standard_deduction, rebate, surcharge, cess, ded_80c, ded_80ccd1b,
 *   ded_80ccd2, ded_80d, ded_24b, ded_80e, ded_80tta, ded_80ttb, ded_80g, exempt_hra, exempt_lta,
 *   exempt_gratuity, exempt_leave_encashment, professional_tax, forms, rounding, tds_rounding;
 *   the RETURN (itr.js, spec §25.6): house_property, capital_gains, rebate_special, itr_forms,
 *   interest_234, return_filing, regime_option, late_fee.
 *
 * THE RETURN (itr.js): computeReturn — the person's own ITR worked out from the employer part
 *   and what they add (interest, dividends, house property, capital gains, deductions, taxes paid),
 *   both regimes, ITR-1 / ITR-2 by the year's conditions, interest 234A/B/C (estimate), the fee,
 *   payable or refund, and the schedules. Engine additions used only by the return: dividends,
 *   let-out house property (30%, interest, loss set-off / carry forward by regime), capital gains
 *   at special rates (111A / 112 / 112A, the unused nil slab, the 15% surcharge cap) and the
 *   rebate never covering what rebate_special leaves out.
 *
 * HOW TO ADD A YEAR
 *   1. Read that year's Finance Act (First Schedule), the Act's sections and the Rules; note
 *      every change (slabs, rebate, surcharge, limits, HRA cities, form numbers).
 *   2. In ruleData.js add a block like ROWS_2026_27 (copy the last year, change what changed,
 *      cite one source per rule; verified 0 where it is not confirmed) and add it to TAX_RULE_ROWS
 *      and SEEDED_YEARS. A rule whose SHAPE changes (a new kind of limit) needs an engine change
 *      and a test; a changed NUMBER never does.
 *   3. node apps/cf_hrms/scripts/seed-tax-rules.mjs (dry run), then --apply; on prod with
 *      --target=prod after review.
 *   4. Add hand-worked cases for the year to scripts/cf_hrms/tax_test.mjs and run
 *      node scripts/cf_hrms/run.mjs --area=tax.
 *   The screens must say "not reviewed by our CA for <year>" until an Owner ticks it (§25).
 */
export { computeTax, compareRegimes, slabTaxOf, roundTo, inr } from './engine.js';
export { projectYear } from './project.js';
export { computeReturn, selectForm, interestEstimate, engineInput, salaryBlock, monthsOrPart } from './itr.js';
export { loadTaxRules, loadTaxYear, rulesFromRows, rulesFromSeed, ageBandFor, isMetro, yearBounds, REGIMES, AGE_BANDS } from './rules.js';
export { TAX_RULE_ROWS, SEEDED_YEARS } from './ruleData.js';
