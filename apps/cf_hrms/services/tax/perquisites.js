/**
 * perquisites.js — the value of perquisites by the year's rules. (TM/CF_HRMS_HIRING_SPEC.md §25.5.)
 * Pure: no database access. HR enters FACTS (hrms_pay_perquisites.facts_json); the value is worked out
 * here, month by month, from the rule `perquisites` of the year (hrms_tax_rules; ruleData.js):
 *   2025-26  section 17(2) of the 1961 Act, rule 3 of the Income-tax Rules 1962 (accommodation as
 *            substituted by Notification 65/2023 from 1-9-2023), statement Form 12BA;
 *   2026-27  section 17(1) of the 2025 Act, rule 15 of the Income-tax Rules 2026, statement Form 123.
 * Nothing below holds a number of the law: amounts, percentages, bands and SBI rates are rule data.
 *
 * FACTS BY KIND (every amount a rupee figure; "perMonth" amounts are for a whole month)
 *   CAR            { ownedBy: 'EMPLOYER' (owned or hired by the employer) | 'EMPLOYEE',
 *                    use: 'MIXED' | 'PERSONAL' | 'OFFICIAL', engine: 'UP_TO_1600' | 'ABOVE_1600' | 'ELECTRIC',
 *                    runningCostsBy: 'EMPLOYER' | 'EMPLOYEE', chauffeur: bool,
 *                    carCost (employer's car, wholly personal use: wear and tear on it),
 *                    hirePerMonth (a hired car, wholly personal: instead of wear and tear),
 *                    actualCostPerMonth (running + chauffeur paid by the employer: wholly personal use, or
 *                    the employee's own car), recoveredPerMonth, officialRecords: bool (needed for OFFICIAL) }
 *   ACCOMMODATION  { type: 'OWNED' | 'LEASED' | 'HOTEL', population: 'ABOVE_40L' | '15L_TO_40L' | 'UP_TO_15L',
 *                    leaseRentPerMonth (LEASED), hotelChargesPerMonth (HOTEL), furnitureCost | furnitureHirePerMonth,
 *                    rentRecoveredPerMonth, salaryPerMonth (optional: else the payroll's salary of the month) }
 *   LOAN           { purpose: 'HOUSING' | 'CAR' | 'PERSONAL' | 'EDUCATION' | 'OTHER', amount, ratePct (charged),
 *                    principalPerMonth (repaid each month from the first month-end), balances: { 'YYYY-MM': amount }
 *                    (the outstanding on the last day of a month, wins over the schedule), medical: bool
 *                    (treatment of a disease in rule 3A / rule 18: no value), sbiRatePct (optional: the
 *                    company's choice within SBI's published range; else the rule's) }
 *   GIFT           { amount }                         (in the month of from_date)
 *   CREDIT_CARD    { amount, officialAmount, recovered }   (official use only with the records the rule asks)
 *   CLUB           { amount, officialAmount, recovered }
 *   OTHER          { valuePerMonth | amount, recovered, nature }
 *
 * AGGREGATES: gifts are valued on the year's total (nil below the threshold, the whole amount at or
 * above it — the common reading; some read it as the excess only: said on the line); loans are nil when
 * all the person's loans together are at or under the small-loan limit.
 * SPECIFIED EMPLOYEE: a car is taxable only for a director, a person with a substantial interest, or an
 * employee whose monetary salary is above the rule's limit (s.17(2)(iii) / 17(1)(c)): when the year's
 * salary is known and not above it (and facts.director is not set), the car is nil, said.
 */

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const r0 = (v) => Math.round(Number(v) || 0);
const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const inr = (v) => `₹${Math.round(Number(v) || 0).toLocaleString('en-IN')}`;

export const KINDS = ['CAR', 'ACCOMMODATION', 'LOAN', 'GIFT', 'CREDIT_CARD', 'CLUB', 'OTHER'];

/** The perquisite statement's row (Form 12BA; Form 123 lists the same natures). */
export const STATEMENT_ROW = {
  ACCOMMODATION: { row: 1, nature: 'Accommodation' },
  CAR: { row: 2, nature: 'Cars / Other automotive' },
  LOAN: { row: 5, nature: 'Interest free or concessional loans' },
  GIFT: { row: 10, nature: 'Gifts, vouchers, etc.' },
  CREDIT_CARD: { row: 11, nature: 'Credit card expenses' },
  CLUB: { row: 12, nature: 'Club expenses' },
  OTHER: { row: 20, nature: 'Other benefits or amenities' },
};

const daysIn = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).getUTCDate(); };
/** The share of month m inside [from, to] (dates 'YYYY-MM-DD'; to null = open). */
export function monthShare(m, from, to) {
  const first = `${m}-01`;
  const last = `${m}-${String(daysIn(m)).padStart(2, '0')}`;
  const a = from > first ? from : first;
  const b = to && to < last ? to : last;
  if (b < a) return 0;
  const d = (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000 + 1;
  return d / daysIn(m);
}

function carMonthly(f, R, lines) {
  const car = R.car;
  const small = f.engine === 'UP_TO_1600' || (f.engine === 'ELECTRIC' && car.electricAsSmall);
  const size = small ? 'small' : 'large';
  const sizeWords = f.engine === 'ELECTRIC' ? (car.electricAsSmall ? 'electric (valued as up to 1.6 litres)' : 'electric (no rule for it this year: valued as above 1.6 litres)') : small ? 'engine up to 1.6 litres' : 'engine above 1.6 litres';
  const chauffeur = f.chauffeur ? car.chauffeur : 0;
  const rec = num(f.recoveredPerMonth);
  if (f.use === 'OFFICIAL') {
    if (f.officialRecords) { lines.push(`Wholly official use, with the journey records and the employer's certificate: no value (${R.rule}).`); return 0; }
    lines.push('Official use is claimed but the journey records and certificate are not confirmed: valued as mixed use.');
  }
  if ((f.ownedBy ?? 'EMPLOYER') === 'EMPLOYER') {
    if (f.use === 'PERSONAL') {
      const wear = f.hirePerMonth != null && f.hirePerMonth !== '' ? num(f.hirePerMonth) : num(f.carCost) * car.wearAndTearPct / 100 / 12;
      const v = Math.max(0, num(f.actualCostPerMonth) + wear - rec);
      lines.push(`Wholly personal use: running and chauffeur ${inr(f.actualCostPerMonth)} + ${f.hirePerMonth != null && f.hirePerMonth !== '' ? `hire ${inr(wear)}` : `wear and tear ${car.wearAndTearPct}% a year of ${inr(f.carCost)} = ${inr(wear)}`} − recovered ${inr(rec)} = ${inr(v)} a month.`);
      return v;
    }
    const by = f.runningCostsBy === 'EMPLOYEE' ? 'employeePays' : 'employerPays';
    const base = car.mixed[size][by];
    lines.push(`Mixed use, ${sizeWords}, running costs paid by the ${by === 'employerPays' ? 'employer' : 'employee'}: ${inr(base)} a month${chauffeur ? ` + chauffeur ${inr(chauffeur)}` : ''}${rec ? ' (the fixed amounts are not reduced by what is recovered)' : ''}.`);
    return base + chauffeur;
  }
  // The employee's own car, the expenses met by the employer.
  const actual = num(f.actualCostPerMonth);
  if (f.use === 'PERSONAL') { lines.push(`The employee's own car, wholly personal use: the expenses paid by the employer ${inr(actual)} a month are taxable in full.`); return actual; }
  const less = car.mixed[size].employerPays + chauffeur;
  const v = Math.max(0, actual - less);
  lines.push(`The employee's own car, mixed use: expenses paid ${inr(actual)} − ${inr(car.mixed[size].employerPays)}${chauffeur ? ` − chauffeur ${inr(chauffeur)}` : ''} = ${inr(v)} a month.`);
  return v;
}

function accommodationMonthly(f, R, salary, lines, m) {
  const A = R.accommodation;
  const rec = num(f.rentRecoveredPerMonth);
  let v;
  if (f.type === 'HOTEL') {
    const atPct = salary * A.hotelPct / 100;
    v = Math.min(atPct, num(f.hotelChargesPerMonth));
    if (!lines.length) lines.push(`Hotel: the lower of ${A.hotelPct}% of salary and the charges paid (nil for a stay of ${A.hotelFreeDays} days or less on transfer — not counted here).`);
  } else if (f.type === 'LEASED') {
    const atPct = salary * A.leasedPct / 100;
    v = Math.min(atPct, num(f.leaseRentPerMonth));
    if (!lines.length) lines.push(`Leased by the employer: the lower of the lease rent ${inr(f.leaseRentPerMonth)} and ${A.leasedPct}% of salary.`);
  } else {
    const band = A.bands.find((b) => b.key === f.population) ?? A.bands[A.bands.length - 1];
    v = salary * band.pct / 100;
    if (!lines.length) lines.push(`Owned by the employer, ${band.words} (${A.census} census): ${band.pct}% of salary.`);
  }
  const furniture = f.furnitureHirePerMonth != null && f.furnitureHirePerMonth !== '' ? num(f.furnitureHirePerMonth) : num(f.furnitureCost) * A.furniturePct / 100 / 12;
  if (furniture && lines.length === 1) lines.push(`Furniture: ${f.furnitureHirePerMonth != null && f.furnitureHirePerMonth !== '' ? `hire ${inr(furniture)} a month` : `${A.furniturePct}% a year of ${inr(f.furnitureCost)} = ${inr(furniture)} a month`}.`);
  const out = Math.max(0, v + furniture - rec);
  lines.push(`${m}: salary ${inr(salary)} → ${inr(v)}${furniture ? ` + furniture ${inr(furniture)}` : ''}${rec ? ` − rent paid ${inr(rec)}` : ''} = ${inr(out)}.`);
  return out;
}

/** The loan's outstanding on the last day of month m. */
export function loanBalance(f, m, startMonth) {
  if (f.balances && f.balances[m] != null && f.balances[m] !== '') return Math.max(0, num(f.balances[m]));
  if (m < startMonth) return 0;
  const [y1, m1] = startMonth.split('-').map(Number);
  const [y2, m2] = m.split('-').map(Number);
  const k = (y2 - y1) * 12 + (m2 - m1) + 1; // month-ends since the loan was given, this one included
  return Math.max(0, num(f.amount) - num(f.principalPerMonth) * k);
}

/**
 * The value of a person's perquisites in a year.
 * @param entries  [{ id, kind, label, fromDate, toDate, facts }]
 * @param ctx      { rule (the value of rule 'perquisites'), months (the year's 'YYYY-MM' list),
 *                   salaryByMonth?: { 'YYYY-MM': salary for accommodation }, annualMonetarySalary?: number }
 * @returns {{ items: [{ id, kind, label, nature, row, byMonth, value, recovered, taxable, lines }], byMonth, total }}
 */
export function valuePerquisites(entries, ctx) {
  const R = ctx.rule;
  const months = ctx.months;
  const items = [];
  const gifts = entries.filter((e) => e.kind === 'GIFT');
  const giftTotal = gifts.reduce((s, e) => s + num(e.facts?.amount), 0);
  const loans = entries.filter((e) => e.kind === 'LOAN');
  const loanTotal = loans.reduce((s, e) => s + num(e.facts?.amount), 0);
  const notSpecified = ctx.annualMonetarySalary != null && R.specifiedEmployee && ctx.annualMonetarySalary <= R.specifiedEmployee.monetarySalaryAbove;

  for (const e of entries) {
    const f = e.facts ?? {};
    const lines = [];
    const byMonth = {};
    let recovered = 0;
    const end = e.toDate ?? `${months[11]}-31`;
    const live = months.filter((m) => monthShare(m, e.fromDate, end) > 0);
    if (e.kind === 'CAR') {
      if (notSpecified && !f.director) {
        lines.push(`Not taxable: the salary of the year ${inr(ctx.annualMonetarySalary)} is not above ${inr(R.specifiedEmployee.monetarySalaryAbove)} and the person is not a director (${R.specifiedEmployee.section}).`);
      } else {
        const per = carMonthly(f, R, lines);
        for (const m of live) byMonth[m] = r2(per * monthShare(m, e.fromDate, end));
        if ((f.ownedBy ?? 'EMPLOYER') === 'EMPLOYER' && f.use === 'PERSONAL') recovered = r2(num(f.recoveredPerMonth) * live.length);
      }
    } else if (e.kind === 'ACCOMMODATION') {
      for (const m of live) {
        const salary = f.salaryPerMonth != null && f.salaryPerMonth !== '' ? num(f.salaryPerMonth) : num(ctx.salaryByMonth?.[m]);
        byMonth[m] = r2(accommodationMonthly(f, R, salary, lines, m) * monthShare(m, e.fromDate, end));
      }
      recovered = r2(num(f.rentRecoveredPerMonth) * live.length);
      if (!live.some((m) => num(ctx.salaryByMonth?.[m]) || num(f.salaryPerMonth))) lines.push('No salary known for these months: the value is nil until the payroll has them (or type the salary).');
    } else if (e.kind === 'LOAN') {
      const L = R.loan;
      const sbi = f.sbiRatePct != null && f.sbiRatePct !== '' ? num(f.sbiRatePct) : num(L.sbiRates[f.purpose ?? 'OTHER'] ?? L.sbiRates.OTHER);
      const gap = Math.max(0, sbi - num(f.ratePct));
      if (f.medical && L.medicalExempt) lines.push(`For medical treatment of a disease in ${L.medicalRule}: no value (except any part reimbursed by insurance and not repaid).`);
      else if (loanTotal <= L.smallLoansUpTo) lines.push(`All loans together ${inr(loanTotal)} are not above ${inr(L.smallLoansUpTo)}: no value.`);
      else {
        const startMonth = String(e.fromDate).slice(0, 7);
        lines.push(`SBI rate ${sbi}%${f.sbiRatePct != null && f.sbiRatePct !== '' ? ' (the company\'s choice)' : ` (${f.purpose ?? 'OTHER'} loans on ${L.sbiRateDate})`} − rate charged ${num(f.ratePct)}% = ${gap}% a year on the outstanding at each month-end.`);
        for (const m of live) {
          const bal = loanBalance(f, m, startMonth);
          byMonth[m] = r2(bal * gap / 100 / 12);
          if (bal) lines.push(`${m}: ${inr(bal)} × ${gap}% ÷ 12 = ${inr(byMonth[m])}.`);
        }
      }
    } else if (e.kind === 'GIFT') {
      const m = String(e.fromDate).slice(0, 7);
      if (giftTotal < R.gift.nilBelow) lines.push(`Gifts of the year together ${inr(giftTotal)} are below ${inr(R.gift.nilBelow)}: no value.`);
      else { byMonth[m] = r2(num(f.amount)); lines.push(`Gifts of the year together ${inr(giftTotal)} are not below ${inr(R.gift.nilBelow)}: the whole amount counts (${R.gift.note}).`); }
    } else if (e.kind === 'CREDIT_CARD' || e.kind === 'CLUB') {
      const m = String(e.fromDate).slice(0, 7);
      const v = Math.max(0, num(f.amount) - num(f.officialAmount));
      recovered = num(f.recovered);
      byMonth[m] = r2(Math.max(0, v - recovered));
      lines.push(`${e.kind === 'CLUB' ? 'Club' : 'Credit card'} expenses paid by the employer ${inr(f.amount)}${num(f.officialAmount) ? ` − official use with records ${inr(f.officialAmount)}` : ''}${recovered ? ` − recovered ${inr(recovered)}` : ''} = ${inr(byMonth[m])}.`);
    } else {
      recovered = num(f.recovered);
      if (f.valuePerMonth != null && f.valuePerMonth !== '') {
        for (const m of live) byMonth[m] = r2(num(f.valuePerMonth) * monthShare(m, e.fromDate, end));
        const tot = Object.values(byMonth).reduce((a, b) => a + b, 0);
        const cut = Math.min(recovered, tot);
        if (cut) { let left = cut; for (const m of [...live].reverse()) { const t = Math.min(left, byMonth[m]); byMonth[m] = r2(byMonth[m] - t); left -= t; } }
        lines.push(`${inr(f.valuePerMonth)} a month as valued by HR${recovered ? `, − recovered ${inr(recovered)}` : ''}.`);
      } else {
        const m = String(e.fromDate).slice(0, 7);
        byMonth[m] = r2(Math.max(0, num(f.amount) - recovered));
        lines.push(`${inr(f.amount)} as valued by HR${recovered ? ` − recovered ${inr(recovered)}` : ''}.`);
      }
    }
    const taxable = r0(Object.values(byMonth).reduce((a, b) => a + b, 0));
    const row = STATEMENT_ROW[e.kind] ?? STATEMENT_ROW.OTHER;
    items.push({
      id: e.id ?? null, kind: e.kind, label: e.label ?? null, nature: e.kind === 'OTHER' && f.nature ? String(f.nature) : row.nature, row: row.row,
      byMonth, value: r0(taxable + recovered), recovered: r0(recovered), taxable, lines,
    });
  }
  const byMonth = {};
  for (const m of months) byMonth[m] = r0(items.reduce((s, it) => s + num(it.byMonth[m]), 0));
  return { items, byMonth, total: r0(items.reduce((s, it) => s + it.taxable, 0)) };
}

/** What the perquisite statement prints (Form 12BA / Form 123): one row per nature. */
export function statementRows(items) {
  const rows = new Map();
  for (const it of items) {
    if (!it.taxable && !it.value) continue;
    const k = `${it.row}|${it.nature}`;
    const cur = rows.get(k) ?? { row: it.row, nature: it.nature, value: 0, recovered: 0, taxable: 0 };
    cur.value += it.value; cur.recovered += it.recovered; cur.taxable += it.taxable;
    rows.set(k, cur);
  }
  return [...rows.values()].sort((a, b) => a.row - b.row);
}

/** Checks the facts of a kind; [] = fine. */
export function factProblems(kind, f = {}) {
  const p = [];
  const amt = (k, label, required = false) => {
    const v = f[k];
    if (v === undefined || v === null || v === '') { if (required) p.push(`${label}: give an amount.`); return; }
    if (!Number.isFinite(Number(v)) || Number(v) < 0) p.push(`${label}: “${String(v).slice(0, 20)}” is not an amount.`);
  };
  const oneOf = (k, list, label, required = true) => { if (f[k] == null || f[k] === '') { if (required) p.push(`${label}: choose one.`); } else if (!list.includes(f[k])) p.push(`${label}: one of ${list.join(', ')}.`); };
  if (kind === 'CAR') {
    oneOf('ownedBy', ['EMPLOYER', 'EMPLOYEE'], 'Whose car'); oneOf('use', ['MIXED', 'PERSONAL', 'OFFICIAL'], 'Use'); oneOf('engine', ['UP_TO_1600', 'ABOVE_1600', 'ELECTRIC'], 'Engine');
    if (f.ownedBy !== 'EMPLOYEE' && f.use === 'MIXED') oneOf('runningCostsBy', ['EMPLOYER', 'EMPLOYEE'], 'Who pays the running costs');
    amt('carCost', 'Cost of the car'); amt('hirePerMonth', 'Hire a month'); amt('actualCostPerMonth', 'Expenses a month', f.ownedBy === 'EMPLOYEE' || f.use === 'PERSONAL'); amt('recoveredPerMonth', 'Recovered a month');
  } else if (kind === 'ACCOMMODATION') {
    oneOf('type', ['OWNED', 'LEASED', 'HOTEL'], 'Accommodation');
    if (f.type === 'OWNED') oneOf('population', ['ABOVE_40L', '15L_TO_40L', 'UP_TO_15L'], 'Population of the city');
    amt('leaseRentPerMonth', 'Lease rent a month', f.type === 'LEASED'); amt('hotelChargesPerMonth', 'Hotel charges a month', f.type === 'HOTEL');
    amt('furnitureCost', 'Cost of the furniture'); amt('furnitureHirePerMonth', 'Furniture hire a month'); amt('rentRecoveredPerMonth', 'Rent paid by the employee a month'); amt('salaryPerMonth', 'Salary a month');
  } else if (kind === 'LOAN') {
    oneOf('purpose', ['HOUSING', 'CAR', 'PERSONAL', 'EDUCATION', 'OTHER'], 'Purpose'); amt('amount', 'Loan amount', true); amt('ratePct', 'Interest charged (% a year)'); amt('principalPerMonth', 'Repaid a month'); amt('sbiRatePct', 'SBI rate (% a year)');
    if (Number(f.ratePct) > 100 || Number(f.sbiRatePct) > 100) p.push('A rate is a percentage a year, at most 100.');
    for (const [m, v] of Object.entries(f.balances ?? {})) { if (!/^\d{4}-\d{2}$/.test(m)) p.push(`Balances: “${m}” is not a month.`); else if (v !== '' && v != null && (!Number.isFinite(Number(v)) || Number(v) < 0)) p.push(`Balance of ${m}: not an amount.`); }
  } else if (kind === 'GIFT') amt('amount', 'Value of the gift', true);
  else if (kind === 'CREDIT_CARD' || kind === 'CLUB') { amt('amount', 'Paid by the employer', true); amt('officialAmount', 'Of which official'); amt('recovered', 'Recovered'); }
  else if (kind === 'OTHER') { if ((f.valuePerMonth == null || f.valuePerMonth === '') && (f.amount == null || f.amount === '')) p.push('Give the value: a month, or for the year.'); amt('valuePerMonth', 'Value a month'); amt('amount', 'Value'); amt('recovered', 'Recovered'); }
  else p.push(`“${kind}” is not a kind of perquisite.`);
  return p;
}

export default { KINDS, STATEMENT_ROW, valuePerquisites, statementRows, factProblems, monthShare, loanBalance };
