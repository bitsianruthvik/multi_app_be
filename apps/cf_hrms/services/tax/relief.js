/**
 * relief.js — relief when salary is paid in arrears (or in advance): the Form 10E / Form 39 worksheet.
 * (TM/CF_HRMS_HIRING_SPEC.md §25.5 "Arrears and relief".) Pure: no database access.
 *
 * THE LAW (rule key `relief_arrears` in hrms_tax_rules says it by year):
 *   to 2025-26  section 89(1), rule 21A(2) of the 1962 Rules, particulars in Form 10E (rule 21AA);
 *               the employer may give it in TDS on Form 10E particulars (section 192(2A)).
 *   from 2026-27 section 157(1) of the 2025 Act, rule 73 (Table Sl. 1) of the 2026 Rules, particulars
 *               in Form No. 39 (rule 73(3)); the employer side is section 392(4)(a)(ii) / rule 73(4).
 *   The arithmetic is the same in both:
 *     A = tax on the total income of the year of receipt − tax on it as reduced by the arrears
 *     for each earlier year the arrears relate to:
 *       E = tax on that year's total income as increased by its arrears − tax on that year's total income
 *     B = the sum of E;   relief = A − B when A > B, else nil.
 *   Each earlier year is worked with ITS OWN rates (the rule computes "as if the total income so
 *   increased were the total income of that year"), in the regime the person was in that year.
 *   Relief is not excluded by the new regime (section 89 / 157 is not in the 115BAC(2) / 202(2) lists).
 *
 * taxOnTotalIncome(rules, totalIncome, { dateOfBirth }) — the engine's tax (rebate, surcharge, cess,
 *   rounding) on a TOTAL income: the income is handed in as "other income", so no standard deduction
 *   or other step changes it.
 * worksheet({ receipt, earlier }) — the rows of the form from the taxes already worked out.
 */
import { computeTax } from './engine.js';

const r0 = (v) => Math.round(Number(v) || 0);

/** The tax of a year (one regime's rules) on a total income, as the engine works it. */
export function taxOnTotalIncome(rules, totalIncome, { dateOfBirth } = {}) {
  const income = Math.max(0, r0(totalIncome));
  const c = computeTax({ year: rules.year, regime: rules.regime, dateOfBirth: dateOfBirth ?? undefined, otherIncome: income }, rules);
  return c.totalTax;
}

/**
 * @param receipt  { year, totalIncome (INCLUDING the arrears), arrears, taxWith, taxWithout }
 * @param earlier  [{ year, arrears, totalIncome, taxWithout, taxWith, regime, how: 'ENGINE' | 'TYPED' | 'MISSING' }]
 *                 a year with how 'MISSING' has no figures yet: the worksheet is incomplete
 * @returns {{ complete, missing[], rows, table, totals, a, b, relief, sentence }}
 */
export function worksheet({ receipt, earlier }) {
  const missing = earlier.filter((e) => e.how === 'MISSING').map((e) => e.year);
  const table = earlier
    .slice()
    .sort((x, y) => x.year.localeCompare(y.year))
    .map((e) => {
      const ok = e.how !== 'MISSING';
      const increased = ok ? r0(e.totalIncome) + r0(e.arrears) : null;
      return {
        year: e.year, regime: e.regime ?? null, how: e.how, arrears: r0(e.arrears),
        totalIncome: ok ? r0(e.totalIncome) : null, increasedIncome: increased,
        taxWithout: ok ? r0(e.taxWithout) : null, taxWith: ok ? r0(e.taxWith) : null,
        difference: ok ? r0(e.taxWith) - r0(e.taxWithout) : null,
      };
    });
  const arrearsTotal = table.reduce((s, t) => s + t.arrears, 0);
  const reduced = r0(receipt.totalIncome) - arrearsTotal;
  const a = r0(receipt.taxWith) - r0(receipt.taxWithout);
  const b = table.reduce((s, t) => s + (t.difference ?? 0), 0);
  const complete = missing.length === 0;
  const relief = complete && a > b ? a - b : 0;
  const rows = {
    totalIncomeExcluding: reduced, arrears: arrearsTotal, totalIncomeIncluding: r0(receipt.totalIncome),
    taxOnIncluding: r0(receipt.taxWith), taxOnExcluding: r0(receipt.taxWithout), taxOnArrears: a, taxPerTable: b, relief,
  };
  let sentence;
  if (!complete) sentence = `Not finished: type the total income and the tax for ${missing.join(', ')} (no tax rules for ${missing.length === 1 ? 'that year' : 'those years'} here).`;
  else if (relief > 0) sentence = `Relief of ₹${relief.toLocaleString('en-IN')}: the arrears cost ₹${a.toLocaleString('en-IN')} of tax in ${receipt.year}, and would have cost ₹${b.toLocaleString('en-IN')} in the years they belong to.`;
  else sentence = `No relief: the arrears cost ₹${a.toLocaleString('en-IN')} of tax in ${receipt.year}, not more than the ₹${b.toLocaleString('en-IN')} they would have cost in their own years.`;
  return { complete, missing, rows, table, totals: { arrears: arrearsTotal, difference: b }, a, b, relief, sentence };
}

export default { taxOnTotalIncome, worksheet };
