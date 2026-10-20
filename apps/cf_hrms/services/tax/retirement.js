/**
 * retirement.js — the employer's contributions to the person's retirement funds above the year's limit,
 * a perquisite. Pure. The numbers and the words come from the rule `retirement_contributions` of the year
 * (hrms_tax_rules; ruleData.js):
 *   to 2025-26   section 17(2)(vii): the employer's contributions in the year to a recognised provident
 *                fund, the NPS (s.80CCD(1)) and an approved superannuation fund, together, above ₹7,50,000
 *                — the excess is a perquisite; section 17(2)(viia): the annual accretion (interest,
 *                dividend …) on that excess, by rule 3B;
 *   from 2026-27 the same under the 2025 Act (the clause and the rule are in the rule row's words).
 * Both regimes: a perquisite, not an exemption the new regime takes away.
 *
 * RULE 3B (the accretion of the year):  TP = (PC ÷ 2) × R + (PC1 + TP1) × R
 *   PC   the excess contribution of THIS year (worked out here)
 *   PC1  the excess contributions of the years before, together (typed by HR — the payroll has no older years)
 *   TP1  the accretion taxed in the years before, together (typed)
 *   R    I ÷ Favg: the fund's income of the year ÷ the average of its opening and closing balance — typed
 *        as a rate (%), or worked out from the three figures when HR has them
 * Without R the accretion is not valued, and the line says so.
 */

const r0 = (v) => Math.round(Number(v) || 0);
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const inr = (v) => `₹${Math.round(Number(v) || 0).toLocaleString('en-IN')}`;

/**
 * @param contributions { pf, nps, superannuation } — the employer's, for the year (paid and projected)
 * @param rule          retirement_contributions: { limit, section, accretionSection, accretionRule, … }
 * @param facts         { previousExcess (PC1), previousAccretion (TP1), ratePct | fundIncome + fundOpening + fundClosing } | null
 * @returns {{ total, excess, accretion, rate, perquisites: [{ name, value, kind }], lines[] }}
 */
export function retirementPerquisite({ contributions = {}, rule, facts = null }) {
  const pf = r0(contributions.pf);
  const nps = r0(contributions.nps);
  const sa = r0(contributions.superannuation);
  const total = pf + nps + sa;
  const lines = [];
  const perquisites = [];
  const excess = Math.max(0, total - rule.limit);
  const pc1 = n(facts?.previousExcess);
  const tp1 = n(facts?.previousAccretion);
  if (!total && !pc1) return { total, excess: 0, accretion: 0, rate: null, perquisites, lines };
  lines.push(`Employer's contributions this year: PF ${inr(pf)} + NPS ${inr(nps)} + superannuation ${inr(sa)} = ${inr(total)}; ${excess ? `${inr(excess)} above` : 'not above'} the ${inr(rule.limit)} of ${rule.section}.`);
  if (excess) perquisites.push({ name: `Employer's contributions to PF, NPS and superannuation above ${inr(rule.limit)} (${rule.section})`, value: excess, kind: 'CONTRIBUTION' });
  let accretion = 0;
  let rate = null;
  if (facts && facts.ratePct != null && facts.ratePct !== '') rate = n(facts.ratePct) / 100;
  else if (facts && n(facts.fundOpening) + n(facts.fundClosing) > 0) rate = n(facts.fundIncome) / ((n(facts.fundOpening) + n(facts.fundClosing)) / 2);
  if (excess || pc1) {
    if (rate == null) {
      lines.push(`The accretion on the excess (${rule.accretionSection}, ${rule.accretionRule}) is not valued: the fund's rate of income for the year is not entered.`);
    } else {
      accretion = r0((excess / 2) * rate + (pc1 + tp1) * rate);
      lines.push(`Accretion (${rule.accretionSection}, ${rule.accretionRule}): (${inr(excess)} ÷ 2 + ${inr(pc1)} + ${inr(tp1)}) × ${(rate * 100).toFixed(2)}% = ${inr(accretion)}.`);
      if (accretion) perquisites.push({ name: `Accretion on the contributions above ${inr(rule.limit)} (${rule.accretionSection})`, value: accretion, kind: 'ACCRETION' });
    }
  }
  return { total, excess, accretion, rate, perquisites, lines };
}

export default { retirementPerquisite };
