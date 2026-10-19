/**
 * project.js — the year's tax projected from the months paid and the months to come,
 * and this month's TDS. Pure (the caller reads the payroll and the declarations).
 *
 *   projectYear(input, rules) → { computation, projectedTax, tdsSoFar, previousEmployerTds,
 *                                 monthsLeft, balance, thisMonthTds, schedule[], excess, lines[] }
 *
 * THE RULE (section 192(1)/(3) of the 1961 Act, section 392 of the 2025 Act; CBDT
 * Circular 24/2022 paras 3.8 and 9.4): the tax on the year's estimated salary is deducted
 * in equal monthly parts, and any excess or shortfall of earlier months is made good by
 * changing the later deductions of the same year. So, every month:
 *
 *   this month's TDS = (projected tax − TDS already deducted this year
 *                       − TDS of the previous employer this year) ÷ months left (this one included)
 *   rounded to the nearest rupee, and never below 0.
 *
 * Refunds and over-deduction: TDS can only be deducted, never paid back by the employer.
 * When the balance is negative (a pay cut, a late declaration, a joiner whose previous
 * employer deducted too much), this month's TDS is 0 and the rest of the year's TDS is 0;
 * the over-deduction (`excess`) stays with the department, shows in Form 16/130 and in
 * Form 26AS/168, and the employee gets it back as a refund when filing the return.
 * The employer may only reduce later deductions of the same year (192(3)), which is
 * exactly what the formula does.
 *
 * One-time items (bonus, arrears) are added to the year's projection; their tax is spread
 * over the months left like the rest (no separate lump-sum TDS).
 *
 * Declarations and proofs: while the proofs window is open (proofsStatus 'OPEN', the
 * default) the declarations count; once it is CLOSED only what was proved counts, so an
 * unproven declaration drops out of the projection and the remaining months' TDS rises.
 */
import { computeTax, inr, roundTo } from './engine.js';

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const HRA_SALARY_CODES = ['BASIC', 'DA'];

/** Adds up components by code, keeping the first name / taxable / exemptRule seen. */
function aggregate(lists) {
  const map = new Map();
  for (const c of lists.flat()) {
    const code = String(c.code ?? c.name ?? '').toUpperCase();
    const cur = map.get(code);
    if (cur) cur.amount += n(c.amount);
    else map.set(code, { code, name: c.name ?? code, amount: n(c.amount), taxable: c.taxable ?? 'YES', exemptRule: c.exemptRule ?? null });
  }
  return [...map.values()];
}

/**
 * input = {
 *   year, regime, ageBand | dateOfBirth, resident, employerType,
 *   paidMonths:      [{ month: 'YYYY-MM', components: [...], tdsDeducted }],
 *   remainingMonths: [{ month, components: [...] }]          — this month first, then the rest
 *   oneTime:         [{ month, code, name, amount, taxable, exemptRule }],
 *   declarations:    { deductions: {...}, exemptions: { hra: { rentPerMonth | rentPaid: [{ month, amount }], city | metro }, lta, ... } },
 *   proofs:          the same shape, what HR verified,
 *   proofsStatus:    'OPEN' (declarations count) | 'CLOSED' (only proofs count),
 *   professionalTax, otherIncome, previousEmployer: { taxableSalary, tds, pt }, perquisites,
 * }
 * Only the months employed are given: a mid-year joiner's year starts at the joining month.
 */
export function projectYear(input, rules) {
  const paid = input.paidMonths ?? [];
  const remaining = input.remainingMonths ?? [];
  if (!remaining.length) throw new Error('There are no months left in the year to deduct from (remainingMonths is empty).');
  const oneTime = input.oneTime ?? [];
  const closed = String(input.proofsStatus ?? 'OPEN').toUpperCase() === 'CLOSED';
  const claims = (closed ? input.proofs : input.declarations) ?? {};

  const months = [...paid, ...remaining];
  const exemptions = { ...(claims.exemptions ?? {}) };
  if (exemptions.hra) {
    const h = exemptions.hra;
    const rentFor = (m) => {
      if (Array.isArray(h.rentPaid)) return n(h.rentPaid.find((r) => r.month === m)?.amount);
      return n(h.rentPerMonth);
    };
    exemptions.hra = {
      city: h.city, metro: h.metro,
      months: months.map((m) => {
        const comps = [...(m.components ?? []), ...oneTime.filter((o) => o.month === m.month)];
        return {
          month: m.month,
          rentPaid: rentFor(m.month),
          basic: comps.filter((c) => HRA_SALARY_CODES.includes(String(c.code).toUpperCase())).reduce((a, c) => a + n(c.amount), 0),
          hraReceived: comps.filter((c) => String(c.exemptRule ?? '').toUpperCase() === 'HRA').reduce((a, c) => a + n(c.amount), 0),
        };
      }),
    };
  }

  const components = aggregate([...months.map((m) => m.components ?? []), oneTime]);
  const computation = computeTax({
    year: input.year, regime: input.regime ?? 'NEW', ageBand: input.ageBand, dateOfBirth: input.dateOfBirth, age: input.age,
    resident: input.resident, employerType: input.employerType, salaryForLimits: input.salaryForLimits,
    salary: { components }, perquisites: input.perquisites, exemptions, deductions: claims.deductions ?? {},
    professionalTax: input.professionalTax, otherIncome: input.otherIncome, previousEmployer: input.previousEmployer,
  }, rules);

  const projectedTax = computation.totalTax;
  const tdsSoFar = Math.round(paid.reduce((a, m) => a + n(m.tdsDeducted), 0));
  const previousEmployerTds = Math.round(n(input.previousEmployer?.tds));
  const monthsLeft = remaining.length;
  const balance = projectedTax - tdsSoFar - previousEmployerTds;
  const step = rules.has('tds_rounding') ? n(rules.get('tds_rounding').monthlyTdsTo) || 1 : 1;
  const roundTds = (x) => (step <= 1 ? Math.round(x) : roundTo(x, step));
  const thisMonthTds = balance > 0 ? Math.max(0, roundTds(balance / monthsLeft)) : 0;
  const excess = balance < 0 ? -balance : 0;
  // If nothing changes, the same amount each month; the last month takes the rupees of rounding.
  const schedule = remaining.map((m, i) => ({
    month: m.month,
    tds: balance <= 0 ? 0 : i < monthsLeft - 1 ? thisMonthTds : Math.max(0, balance - thisMonthTds * (monthsLeft - 1)),
  }));

  const lines = [
    { label: `Projected tax for the year (${paid.length} month(s) paid, ${monthsLeft} to come${oneTime.length ? `, ${oneTime.length} one-time item(s)` : ''}; ${closed ? 'proofs only' : 'declarations'})`, amount: projectedTax },
    { label: 'TDS already deducted this year', amount: -tdsSoFar },
    ...(previousEmployerTds ? [{ label: `TDS by the previous employer (${computation.forms.previousEmployer.label})`, amount: -previousEmployerTds }] : []),
    { label: 'Still to deduct', amount: balance },
    { label: balance > 0 ? `This month: ${inr(balance)} ÷ ${monthsLeft} month(s) left, to the rupee` : `This month: nothing — ${excess ? `${inr(excess)} more than the year's tax is already deducted; it comes back as a refund on the return` : 'the year\'s tax is already deducted'}`, amount: thisMonthTds },
  ];

  return { computation, projectedTax, tdsSoFar, previousEmployerTds, monthsLeft, balance, thisMonthTds, schedule, excess, proofsStatus: closed ? 'CLOSED' : 'OPEN', lines };
}
