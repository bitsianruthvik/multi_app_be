/**
 * fnfMath.js — the arithmetic of a full and final settlement. (TM/CF_HRMS_HIRING_SPEC.md §25.5.) Pure:
 * dates and amounts in, amounts and words out. Every number of the law comes from the rule
 * `final_settlement` of the tax year (hrms_tax_rules; services/tax/ruleData.js), never from here.
 *
 *   serviceLength(joining, lastDay)       completed years, months and days, the last day included
 *   gratuity({ service, wage, rule })     eligible at `eligibleYears` completed years; 15/26 × the last
 *                                         month's wage (Basic + DA: the components "in the gratuity wage")
 *                                         × years, where a part year of MORE than six months counts as a
 *                                         year; at most the Act's ceiling (the employer may pay more: HR
 *                                         types it, the tax exemption still uses the formula)
 *   encashmentExemptFormula({ … })        the limbs of s.10(10AA)(ii) / s.19 Table Sl. 14 that are not the
 *                                         amount received and the cap: 10 months' average salary, and the
 *                                         cash value of the leave at most 30 days a completed year of service
 *   notice({ … })                         the days short of the notice period: recovered from a person who
 *                                         resigned (unless waived), paid to a person the company removed
 */

const r0 = (v) => Math.round(Number(v) || 0);
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const inr = (v) => `₹${Math.round(Number(v) || 0).toLocaleString('en-IN')}`;
const at = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00Z`);

/**
 * Completed years, months and days from the joining date to the last day, BOTH counted: joined
 * 21 Nov 2021, last day 20 Oct 2026 = 4 years 11 months 0 days.
 */
export function serviceLength(joining, lastDay) {
  const a = at(joining);
  const end = at(lastDay);
  end.setUTCDate(end.getUTCDate() + 1); // the day after the last day: service is [joining, lastDay]
  if (end <= a) return { years: 0, months: 0, days: 0, totalMonths: 0, text: 'no service' };
  let years = end.getUTCFullYear() - a.getUTCFullYear();
  let months = end.getUTCMonth() - a.getUTCMonth();
  let days = end.getUTCDate() - a.getUTCDate();
  if (days < 0) {
    months -= 1;
    days += new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 0)).getUTCDate(); // days of the month before `end`
  }
  if (months < 0) { years -= 1; months += 12; }
  const parts = [`${years} year${years === 1 ? '' : 's'}`, `${months} month${months === 1 ? '' : 's'}`, ...(days ? [`${days} day${days === 1 ? '' : 's'}`] : [])];
  return { years, months, days, totalMonths: years * 12 + months, text: parts.join(' ') };
}

/**
 * @param service  serviceLength(...)
 * @param wage     the last month's wage for gratuity (Basic + DA), a whole month
 * @param rule     final_settlement.gratuity: { eligibleYears, daysPerYear, divisor, partYearMoreThanMonths, actCeiling, act }
 * @returns {{ eligible, years, amount, formulaAmount, cappedAt, lines[] }}
 */
export function gratuity({ service, wage, rule }) {
  const lines = [];
  const eligible = service.years >= rule.eligibleYears;
  if (!eligible) {
    lines.push(`Service ${service.text}: gratuity is due after ${rule.eligibleYears} years of continuous service (${rule.act}) — not due.`);
    return { eligible, years: 0, amount: 0, formulaAmount: 0, cappedAt: null, lines };
  }
  const part = service.months > rule.partYearMoreThanMonths || (service.months === rule.partYearMoreThanMonths && service.days > 0);
  const years = service.years + (part ? 1 : 0);
  lines.push(`Service ${service.text}: ${years} year${years === 1 ? '' : 's'} counted${part ? ` (a part year of more than ${rule.partYearMoreThanMonths} months counts as a year)` : service.months || service.days ? ` (a part year of ${rule.partYearMoreThanMonths} months or less does not count)` : ''}.`);
  const formulaAmount = r0(rule.daysPerYear / rule.divisor * Number(wage) * years);
  lines.push(`${rule.daysPerYear}/${rule.divisor} × last month's wage ${inr(wage)} × ${years} = ${inr(formulaAmount)}.`);
  let amount = formulaAmount;
  let cappedAt = null;
  if (rule.actCeiling && amount > rule.actCeiling) {
    amount = rule.actCeiling;
    cappedAt = rule.actCeiling;
    lines.push(`At most ${inr(rule.actCeiling)} under ${rule.act}.`);
  }
  return { eligible, years, amount, formulaAmount, cappedAt, lines };
}

/**
 * The exemption limbs of leave encashment on leaving (non-government employee) other than "received" and
 * the cap, which the tax engine applies: least of
 *   (c) `averageMonths` × the average monthly salary of the last `averageMonths` months, and
 *   (d) the leave encashed, at most `daysPerYear` days for each COMPLETED year of service, at the
 *       average salary ÷ 30 a day.
 * (d) is worked on the days paid out: the leave the person had earned at most 30 days a year less what they
 * took is not kept here — a CA may work it from the leave record (said on the statement).
 * @returns {{ formulaAmount, limbC, limbD, lines[] }}
 */
export function encashmentExemptFormula({ days, completedYears, averageSalary, rule }) {
  const limbC = r0(rule.averageMonths * averageSalary);
  const capDays = rule.daysPerYear * completedYears;
  const counted = Math.min(Number(days) || 0, capDays);
  const limbD = r0(counted * averageSalary / 30);
  return {
    formulaAmount: Math.min(limbC, limbD), limbC, limbD,
    lines: [
      `${rule.averageMonths} months' average salary: ${rule.averageMonths} × ${inr(averageSalary)} = ${inr(limbC)}.`,
      `The leave at most ${rule.daysPerYear} days a completed year (${completedYears} × ${rule.daysPerYear} = ${capDays} days): ${r2(counted)} days × ${inr(averageSalary)} ÷ 30 = ${inr(limbD)}.`,
    ],
  };
}

/**
 * @param requiredDays  the notice period (days)
 * @param servedDays    the days from the notice date to the last working day
 * @param exitType      'RESIGNED' | 'REMOVED'
 * @param waived        HR waives the shortfall (no recovery, no payout)
 * @param dayRate       a day of notice pay (the policy formula)
 * @returns {{ shortDays, action: 'NONE' | 'RECOVER' | 'PAY' | 'WAIVED', amount, line }}
 */
export function notice({ requiredDays, servedDays, exitType, waived = false, dayRate }) {
  const shortDays = Math.max(0, (Number(requiredDays) || 0) - Math.max(0, Number(servedDays) || 0));
  if (!shortDays) return { shortDays: 0, action: 'NONE', amount: 0, line: `Notice of ${requiredDays} days served in full (${servedDays} days).` };
  if (waived) return { shortDays, action: 'WAIVED', amount: 0, line: `${shortDays} days short of the ${requiredDays}-day notice: waived by HR.` };
  const amount = r0(shortDays * dayRate);
  if (exitType === 'REMOVED') return { shortDays, action: 'PAY', amount, line: `The company ended the employment with ${servedDays} of ${requiredDays} days' notice: ${shortDays} days of notice pay at ${inr(dayRate)} a day = ${inr(amount)} paid.` };
  return { shortDays, action: 'RECOVER', amount, line: `Resigned with ${servedDays} of ${requiredDays} days' notice served: ${shortDays} days short at ${inr(dayRate)} a day = ${inr(amount)} recovered.` };
}

/** Days from the notice date to the last working day (the notice date not counted). */
export const servedDays = (noticeDate, lastDay) => Math.max(0, Math.round((at(lastDay) - at(noticeDate)) / 86400000));

export default { serviceLength, gratuity, encashmentExemptFormula, notice, servedDays };
