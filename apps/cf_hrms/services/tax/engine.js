/**
 * engine.js — the income tax on a salaried person's year, in one regime, from the rules
 * of that year (rules.js). Pure: no database, no clock, no numbers of its own.
 *
 *   computeTax(input, rules)                  one regime, with a worksheet (lines[])
 *   compareRegimes(input, rulesOld, rulesNew) both, the cheaper, the difference
 *
 * The order is the order of the law (and of a CA's worksheet):
 *   gross salary (+ perquisites) − exemptions (HRA, LTA, gratuity, leave encashment)
 *   + previous employer's salary = net salary
 *   − standard deduction − professional tax (old regime) = income from salary
 *   + other income − house-property loss (old regime, self-occupied interest) = gross total income
 *   − Chapter VI-A / VIII deductions (never more than the gross total income)
 *   = taxable income, rounded to the nearest ₹10 (288A / s.516)
 *   slab tax → rebate (87A / s.156, with marginal relief in the new regime)
 *   → surcharge (with marginal relief at each threshold, capped at 25% in the new regime)
 *   → cess 4% → total tax, rounded to the nearest ₹10 (288B / s.516).
 * Every step is in whole rupees (half a rupee up); only the two ₹10 roundings are the law's.
 *
 * A claim that the regime does not allow is not silently dropped: it is listed in
 * `refused` with a plain reason, and the worksheet says so.
 */
import { ageBandFor, isMetro } from './rules.js';

/* ── Small helpers ─────────────────────────────────────────────────────── */
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const rupee = (v) => Math.round(n(v) + 1e-9);
/** Nearest multiple of `step`: paise ignored, 5 and above up (288A/288B, s.516). */
export function roundTo(v, step = 10) {
  const whole = Math.trunc(n(v));
  if (step <= 1) return whole;
  const rest = ((whole % step) + step) % step;
  return rest * 2 >= step ? whole - rest + step : whole - rest;
}
/** ₹ in Indian grouping: 1234567 → "₹12,34,567". */
export function inr(v) {
  const neg = n(v) < 0;
  const s = String(Math.abs(Math.round(n(v))));
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${neg ? '−' : ''}₹${rest ? `${rest},` : ''}${last3}`;
}
const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + n(f(x)), 0);
const HRA_SALARY_CODES = ['BASIC', 'DA'];

/** The tax on `income` by a slab table [{ upTo, rate }], exact (not rounded). */
export function slabTaxOf(income, slabs) {
  let tax = 0;
  let floor = 0;
  for (const s of slabs) {
    const top = s.upTo == null ? Infinity : s.upTo;
    if (income > floor) tax += (Math.min(income, top) - floor) * s.rate / 100;
    floor = top;
    if (income <= top) break;
  }
  return tax;
}

/** Surcharge bands with the regime's cap applied and equal neighbours merged. */
function effectiveBands(rule) {
  const out = [];
  for (const b of rule.bands) {
    const rate = rule.maxRate != null ? Math.min(b.rate, rule.maxRate) : b.rate;
    if (out.length && out[out.length - 1].rate === rate) continue;
    out.push({ above: b.above, rate });
  }
  return out;
}

const DEDUCTION_ALIASES = {
  '80C': 'ded_80c', '80CCC': 'ded_80c', '80CCD1': 'ded_80c', '80CCD1B': 'ded_80ccd1b', '80CCD(1B)': 'ded_80ccd1b',
  '80CCD2': 'ded_80ccd2', '80CCD(2)': 'ded_80ccd2', '80D': 'ded_80d', '24B': 'ded_24b', '24(B)': 'ded_24b',
  '80E': 'ded_80e', '80G': 'ded_80g', '80TTA': 'ded_80tta', '80TTB': 'ded_80ttb',
};

/* ── computeTax ────────────────────────────────────────────────────────── */
/**
 * input = {
 *   year: '2025-26', regime: 'NEW' (the default) | 'OLD',
 *   ageBand | dateOfBirth | age, resident (default true), employerType 'GOVT' | 'OTHER' (default),
 *   salary: { components: [{ code, name, amount, taxable: 'YES'|'PARTLY'|'NO', exemptRule?: 'HRA'|'LTA'|'GRATUITY'|'LEAVE_ENCASHMENT' }] },
 *   perquisites: number | [{ name, value }],                         (s.17(2), taxable in full)
 *   exemptions: {
 *     hra: { rentPaid: number | [{ month, amount }], city? | metro?, basic?, hraReceived? }
 *        | { months: [{ month, rentPaid, basic, hraReceived, city?, metro? }] },
 *     lta: { claimed, received?, journeysUsedInBlock? },
 *     gratuity: { received?, formulaAmount?, exemptedBefore? },
 *     leaveEncashment: { received?, formulaAmount?, exemptedBefore? },
 *   },
 *   professionalTax: number (paid this year to this employer's state),
 *   deductions: { '80C', '80CCD1B', '80CCD2' (employer NPS), '80D': { selfFamily, parents, selfFamilySenior, parentsSenior, preventive },
 *                 '24B' (interest, self-occupied), '80E', '80G' },
 *   otherIncome: number | { savingsInterest, depositInterest, other },
 *   previousEmployer: { taxableSalary, tds, pt },                     (Form 12B / 122)
 *   salaryForLimits?: Basic + DA for 80CCD(2) (default: the BASIC and DA components),
 * }
 */
export function computeTax(input, rules) {
  const year = input.year ?? rules.year;
  const regime = String(input.regime ?? 'NEW').toUpperCase();
  if (year !== rules.year) throw new Error(`The rules are for ${rules.year}, the input for ${year}.`);
  if (regime !== rules.regime) throw new Error(`The rules are for the ${rules.regime} regime, the input asks for ${regime}.`);
  const ageBand = ageBandFor(input, year);
  const senior = ageBand !== 'BELOW_60';
  const resident = input.resident !== false;

  const lines = [];
  const used = new Set();
  const warnings = [];
  const refused = [];
  const line = (label, amount, ruleKey = null, extra = {}) => {
    const src = ruleKey ? rules.source(ruleKey) : null;
    if (ruleKey) used.add(ruleKey);
    lines.push({ label, amount: amount == null ? null : rupee(amount), rule: ruleKey, source: src?.note ?? null, url: src?.url ?? null, verified: src ? src.verified : null, ...extra });
  };
  const refuse = (ruleKey, what, amount) => {
    const r = rules.get(ruleKey);
    used.add(ruleKey);
    const reason = r.refusal ?? `${what} is not allowed in the ${regime === 'NEW' ? 'new' : 'old'} regime.`;
    refused.push({ key: ruleKey, what, amount: rupee(amount), reason });
    line(`Not counted: ${what} ${inr(amount)} — ${reason}`, 0, ruleKey, { refused: true });
  };

  line(`${rules.get('regime').name}, tax year ${year}, ${ageBand === 'BELOW_60' ? 'below 60' : ageBand === 'AGE_60_TO_80' ? '60 to 80' : '80 or older'}${resident ? '' : ', non-resident'}`, null, 'regime');

  /* 1. Salary */
  const components = (input.salary?.components ?? []).map((c) => ({ ...c, code: String(c.code ?? '').toUpperCase(), amount: n(c.amount), taxable: String(c.taxable ?? 'YES').toUpperCase(), exemptRule: c.exemptRule ? String(c.exemptRule).toUpperCase() : null }));
  const counted = components.filter((c) => c.taxable !== 'NO');
  for (const c of counted) line(`${c.name ?? c.code}`, c.amount);
  for (const c of components.filter((x) => x.taxable === 'NO')) line(`${c.name ?? c.code} ${inr(c.amount)} — not taxable, left out`, 0);
  const perqs = Array.isArray(input.perquisites) ? input.perquisites : (n(input.perquisites) ? [{ name: 'Perquisites', value: input.perquisites }] : []);
  for (const p of perqs) line(`Perquisite: ${p.name ?? 'Perquisite'} (section 17(2))`, p.value);
  const grossSalary = rupee(sum(counted, (c) => c.amount) + sum(perqs, (p) => p.value));
  line('Gross salary from this employer', grossSalary);

  const byRule = (rule) => sum(components.filter((c) => c.exemptRule === rule && c.taxable !== 'NO'), (c) => c.amount);
  const basicDa = sum(components.filter((c) => HRA_SALARY_CODES.includes(c.code)), (c) => c.amount);
  const ex = input.exemptions ?? {};
  const exemptions = [];

  /* 1a. HRA */
  if (ex.hra) {
    const rule = rules.get('exempt_hra');
    const periods = Array.isArray(ex.hra.months) && ex.hra.months.length
      ? ex.hra.months
      : [{ rentPaid: Array.isArray(ex.hra.rentPaid) ? sum(ex.hra.rentPaid, (r) => r.amount) : ex.hra.rentPaid, basic: ex.hra.basic ?? basicDa, hraReceived: ex.hra.hraReceived ?? byRule('HRA'), city: ex.hra.city, metro: ex.hra.metro }];
    const received = sum(periods, (p) => p.hraReceived);
    if (!rule.allowed) refuse('exempt_hra', 'HRA exemption', received);
    else {
      let total = 0;
      const working = [];
      for (const p of periods) {
        const city = p.city ?? ex.hra.city;
        const metro = city ? isMetro(city, rule.metros) : Boolean(p.metro ?? ex.hra.metro);
        if (city && (p.metro ?? ex.hra.metro) != null && Boolean(p.metro ?? ex.hra.metro) !== metro) {
          warnings.push(`HRA: ${city} is ${metro ? '' : 'not '}a 50% city in ${year}; the city decides, not the metro flag.`);
        }
        const a = n(p.hraReceived);
        const b = Math.max(0, n(p.rentPaid) - n(p.basic) * rule.rentOverPctOfSalary / 100);
        const c = n(p.basic) * (metro ? rule.metroPct : rule.otherPct) / 100;
        const e = Math.max(0, Math.min(a, b, c));
        total += e;
        working.push({ month: p.month ?? null, hraReceived: rupee(a), rentMinusTenth: rupee(b), pctOfSalary: rupee(c), pct: metro ? rule.metroPct : rule.otherPct, city: city ?? null, exempt: rupee(e) });
      }
      total = rupee(total);
      if (periods.length === 1) {
        const w = working[0];
        line(`HRA exempt — least of: HRA received ${inr(w.hraReceived)}; rent ${inr(periods[0].rentPaid)} − ${rule.rentOverPctOfSalary}% of Basic + DA ${inr(periods[0].basic)} = ${inr(w.rentMinusTenth)}; ${w.pct}% of Basic + DA${w.city ? ` (${w.city})` : ''} = ${inr(w.pctOfSalary)}`, -total, 'exempt_hra');
      } else {
        line(`HRA exempt — least of the three limbs, month by month (${working.length} months)`, -total, 'exempt_hra');
      }
      exemptions.push({ key: 'exempt_hra', section: rule.section, label: 'HRA', received: rupee(received), exempt: total, working });
    }
  }

  /* 1b. LTA */
  if (ex.lta) {
    const rule = rules.get('exempt_lta');
    const received = n(ex.lta.received ?? byRule('LTA'));
    if (!rule.allowed) refuse('exempt_lta', 'Leave travel exemption', n(ex.lta.claimed) || received);
    else {
      const used2 = n(ex.lta.journeysUsedInBlock);
      const exempt = used2 >= rule.journeysPerBlock ? 0 : rupee(Math.min(received, n(ex.lta.claimed)));
      line(used2 >= rule.journeysPerBlock
        ? `Leave travel: ${rule.journeysPerBlock} journeys already exempted in this block of ${rule.blockYears} years — nothing more`
        : `Leave travel exempt — the fare spent ${inr(ex.lta.claimed)}, at most the LTA received ${inr(received)}`, -exempt, 'exempt_lta');
      exemptions.push({ key: 'exempt_lta', section: rule.section, label: 'Leave travel', received: rupee(received), exempt });
    }
  }

  /* 1c. Gratuity and leave encashment (both regimes) */
  for (const [k, ruleKey, compRule, what] of [['gratuity', 'exempt_gratuity', 'GRATUITY', 'Gratuity'], ['leaveEncashment', 'exempt_leave_encashment', 'LEAVE_ENCASHMENT', 'Leave encashment']]) {
    if (!ex[k]) continue;
    const rule = rules.get(ruleKey);
    const received = n(ex[k].received ?? byRule(compRule));
    const room = Math.max(0, rule.cap - n(ex[k].exemptedBefore));
    const exempt = rupee(Math.min(received, ex[k].formulaAmount == null ? received : n(ex[k].formulaAmount), room));
    line(`${what} exempt — least of received ${inr(received)}${ex[k].formulaAmount == null ? '' : `, the formula ${inr(ex[k].formulaAmount)}`}, the cap ${inr(rule.cap)}${n(ex[k].exemptedBefore) ? ` less ${inr(ex[k].exemptedBefore)} exempted before` : ''}`, -exempt, ruleKey);
    if (!rules.source(ruleKey).verified) warnings.push(`${what}: the cap ${inr(rule.cap)} for ${year} is not confirmed from an official source — check it.`);
    exemptions.push({ key: ruleKey, section: rule.section, label: what, received: rupee(received), exempt });
  }

  const totalExempt = sum(exemptions, (e) => e.exempt);
  const prev = input.previousEmployer ?? {};
  const prevSalary = rupee(prev.taxableSalary);
  if (prevSalary) line('Salary from the previous employer this year (after its exemptions)', prevSalary, 'forms', { form: rules.get('forms').previousEmployer.label });
  const netSalary = rupee(grossSalary - totalExempt + prevSalary);
  line('Net salary', netSalary);

  /* 2. Standard deduction, professional tax */
  const stdRule = rules.get('standard_deduction');
  const standardDeduction = rupee(Math.min(stdRule.amount, Math.max(0, netSalary)));
  line(`Standard deduction (${stdRule.section})`, -standardDeduction, 'standard_deduction');
  const ptRule = rules.get('professional_tax');
  const ptPaid = n(input.professionalTax) + n(prev.pt);
  let professionalTax = 0;
  if (ptPaid) {
    if (!ptRule.allowed) refuse('professional_tax', 'Professional tax', ptPaid);
    else {
      professionalTax = rupee(Math.min(ptPaid, ptRule.maxPerYear));
      line(`Professional tax paid ${inr(ptPaid)}${ptPaid > ptRule.maxPerYear ? `, at most ${inr(ptRule.maxPerYear)} a year` : ''}`, -professionalTax, 'professional_tax');
    }
  }
  const incomeFromSalary = Math.max(0, netSalary - standardDeduction - professionalTax);
  line('Income from salary', incomeFromSalary);

  /* 3. Other income, house property */
  const oi = typeof input.otherIncome === 'object' && input.otherIncome !== null ? input.otherIncome : { other: n(input.otherIncome) };
  const otherIncome = rupee(n(oi.savingsInterest) + n(oi.depositInterest) + n(oi.other));
  if (otherIncome) line('Other income (interest and the rest)', otherIncome);
  const d = Object.fromEntries(Object.entries(input.deductions ?? {}).map(([k, v]) => [DEDUCTION_ALIASES[String(k).toUpperCase().replace(/\s/g, '')] ?? k, v]));
  let houseProperty = 0;
  if (d.ded_24b != null && n(d.ded_24b)) {
    const rule = rules.get('ded_24b');
    if (!rule.allowed) refuse('ded_24b', 'Home-loan interest (self-occupied)', d.ded_24b);
    else {
      houseProperty = -rupee(Math.min(n(d.ded_24b), rule.selfOccupiedLimit));
      line(`House property: interest on the home loan ${inr(d.ded_24b)}${n(d.ded_24b) > rule.selfOccupiedLimit ? `, at most ${inr(rule.selfOccupiedLimit)}` : ''}`, houseProperty, 'ded_24b');
    }
  }
  const grossTotalIncome = Math.max(0, incomeFromSalary + otherIncome + houseProperty);
  line('Gross total income', grossTotalIncome);

  /* 4. Deductions */
  const deductions = [];
  const take = (ruleKey, claimed, allowed, text) => {
    const rule = rules.get(ruleKey);
    deductions.push({ key: ruleKey, section: rule.section, label: rule.label, claimed: rupee(claimed), allowed: rupee(allowed) });
    line(text ?? `${rule.label}: ${inr(claimed)}${allowed < claimed ? `, at most ${inr(allowed)}` : ''}`, -allowed, ruleKey);
  };
  const simple = (ruleKey, what, cap) => {
    if (d[ruleKey] == null || !n(d[ruleKey])) return;
    const rule = rules.get(ruleKey);
    if (!rule.allowed) return refuse(ruleKey, what, d[ruleKey]);
    const lim = cap(rule);
    take(ruleKey, n(d[ruleKey]), lim == null ? n(d[ruleKey]) : Math.min(n(d[ruleKey]), lim));
  };
  simple('ded_80c', '80C', (r) => r.limit);
  simple('ded_80ccd1b', '80CCD(1B)', (r) => r.limit);
  if (d.ded_80ccd2 != null && n(d.ded_80ccd2)) {
    const rule = rules.get('ded_80ccd2');
    const base = input.salaryForLimits != null ? n(input.salaryForLimits) : basicDa;
    const pct = String(input.employerType ?? 'OTHER').toUpperCase() === 'GOVT' ? rule.pctGovt : rule.pctOther;
    const lim = base * pct / 100;
    take('ded_80ccd2', n(d.ded_80ccd2), Math.min(n(d.ded_80ccd2), lim),
      `${rule.label}: ${inr(d.ded_80ccd2)}, at most ${pct}% of Basic + DA ${inr(base)} = ${inr(lim)}`);
  }
  if (d.ded_80d) {
    const rule = rules.get('ded_80d');
    const v = typeof d.ded_80d === 'object' ? d.ded_80d : { selfFamily: d.ded_80d };
    const claimed = n(v.selfFamily) + n(v.parents) + n(v.preventive);
    if (!rule.allowed) refuse('ded_80d', '80D (health insurance)', claimed);
    else if (claimed) {
      const capSelf = (v.selfFamilySenior ?? senior) ? rule.selfFamilySenior : rule.selfFamily;
      const capParents = v.parentsSenior ? rule.parentsSenior : rule.parents;
      const prevent = Math.min(n(v.preventive), rule.preventiveWithin);
      const self = Math.min(n(v.selfFamily) + prevent, capSelf);
      const par = Math.min(n(v.parents), capParents);
      take('ded_80d', claimed, self + par, `${rule.label}: self and family ${inr(n(v.selfFamily) + prevent)} (at most ${inr(capSelf)}), parents ${inr(v.parents)} (at most ${inr(capParents)})`);
    }
  }
  simple('ded_80e', '80E (education-loan interest)', (r) => r.limit);
  simple('ded_80g', '80G (donations)', () => null);
  // 80TTA / 80TTB follow the interest in other income: nothing to declare.
  if (n(oi.savingsInterest) || n(oi.depositInterest)) {
    const tta = rules.get('ded_80tta');
    const ttb = rules.get('ded_80ttb');
    if (!senior && n(oi.savingsInterest)) {
      if (!tta.allowed) refuse('ded_80tta', '80TTA (savings interest)', Math.min(n(oi.savingsInterest), tta.limit));
      else take('ded_80tta', n(oi.savingsInterest), Math.min(n(oi.savingsInterest), tta.limit));
    }
    if (senior && resident) {
      const interest = n(oi.savingsInterest) + n(oi.depositInterest);
      if (!ttb.allowed) refuse('ded_80ttb', '80TTB (interest of a senior citizen)', Math.min(interest, ttb.limit));
      else take('ded_80ttb', interest, Math.min(interest, ttb.limit));
    }
  }
  for (const [k, v] of Object.entries(input.deductions ?? {})) {
    if (!DEDUCTION_ALIASES[String(k).toUpperCase().replace(/\s/g, '')] && n(v)) warnings.push(`Deduction "${k}" is not one the engine knows; left out.`);
  }
  let totalDeductions = sum(deductions, (x) => x.allowed);
  if (totalDeductions > grossTotalIncome) {
    line(`Deductions ${inr(totalDeductions)} cut to the gross total income`, totalDeductions - grossTotalIncome);
    totalDeductions = grossTotalIncome;
  }

  /* 5. Taxable income */
  const rounding = rules.get('rounding');
  const beforeRounding = grossTotalIncome - totalDeductions;
  const taxableIncome = roundTo(beforeRounding, rounding.taxableIncomeTo);
  line(`Taxable income ${inr(beforeRounding)}, rounded to the nearest ₹${rounding.taxableIncomeTo}`, taxableIncome, 'rounding');

  /* 6. Slab tax */
  const slabsByAge = rules.get('slabs').byAge;
  const slabs = slabsByAge.ALL ?? slabsByAge[ageBand];
  const slabTax = rupee(slabTaxOf(taxableIncome, slabs));
  line(`Tax by the slabs (${slabs.map((s) => `${s.rate}%${s.upTo == null ? ' above' : ` to ${inr(s.upTo)}`}`).join(', ')})`, slabTax, 'slabs');

  /* 7. Rebate */
  const reb = rules.get('rebate');
  let rebate = 0;
  let rebateRelief = 0;
  if (resident || !reb.residentOnly) {
    if (taxableIncome <= reb.incomeLimit) {
      rebate = Math.min(slabTax, reb.maxRebate);
      if (rebate) line(`Rebate (${reb.section}): income not above ${inr(reb.incomeLimit)}, up to ${inr(reb.maxRebate)}`, -rebate, 'rebate');
    } else if (reb.marginalRelief && slabTax > taxableIncome - reb.incomeLimit) {
      rebateRelief = slabTax - (taxableIncome - reb.incomeLimit);
      rebate = rebateRelief;
      line(`Marginal relief (${reb.section}): the tax may not be more than the income above ${inr(reb.incomeLimit)} (${inr(taxableIncome - reb.incomeLimit)})`, -rebate, 'rebate');
    }
  } else if (taxableIncome <= reb.incomeLimit) line(`No rebate (${reb.section}): a non-resident`, 0, 'rebate');
  const taxAfterRebate = slabTax - rebate;

  /* 8. Surcharge */
  const sRule = rules.get('surcharge');
  const bands = effectiveBands(sRule);
  let surcharge = 0;
  let surchargeRelief = 0;
  let surchargeRate = 0;
  const bandIdx = bands.reduce((idx, b, i) => (taxableIncome > b.above ? i : idx), -1);
  if (bandIdx >= 0 && taxAfterRebate > 0) {
    const band = bands[bandIdx];
    surchargeRate = band.rate;
    const raw = taxAfterRebate * band.rate / 100;
    surcharge = raw;
    if (sRule.marginalRelief) {
      const prevRate = bandIdx > 0 ? bands[bandIdx - 1].rate : 0;
      const taxAtT = slabTaxOf(band.above, slabs);
      const limit = taxAtT * (1 + prevRate / 100) + (taxableIncome - band.above);
      if (taxAfterRebate + raw > limit) {
        surchargeRelief = rupee(taxAfterRebate + raw - limit);
        surcharge = raw - surchargeRelief;
      }
    }
    surcharge = rupee(surcharge);
    line(`Surcharge ${band.rate}% (income above ${inr(band.above)}${sRule.maxRate != null && sRule.bands.some((b) => b.rate > sRule.maxRate) ? `; at most ${sRule.maxRate}% in this regime` : ''}) = ${inr(raw)}`, rupee(raw), 'surcharge');
    if (surchargeRelief) {
      line(`Marginal relief on surcharge: tax + surcharge may not be more than the tax on ${inr(band.above)} plus the income above it (${inr(taxableIncome - band.above)})`, -surchargeRelief, 'surcharge');
    }
  }

  /* 9. Cess, total */
  const cessRule = rules.get('cess');
  const cess = rupee((taxAfterRebate + surcharge) * cessRule.rate / 100);
  line(`${cessRule.name} ${cessRule.rate}% of ${inr(taxAfterRebate + surcharge)}`, cess, 'cess');
  const totalBeforeRounding = taxAfterRebate + surcharge + cess;
  const totalTax = roundTo(totalBeforeRounding, rounding.taxPayableTo);
  line(`Total tax for the year${totalTax !== totalBeforeRounding ? ` (${inr(totalBeforeRounding)}, rounded to the nearest ₹${rounding.taxPayableTo})` : ''}`, totalTax, 'rounding');

  const unverifiedUsed = [...used].filter((k) => !rules.source(k).verified);
  if (unverifiedUsed.length) warnings.push(`Rules used that are not confirmed from an official source: ${unverifiedUsed.join(', ')}.`);

  return {
    year, regime, ageBand, resident,
    grossSalary, exemptions, totalExempt: rupee(totalExempt), previousEmployerSalary: prevSalary, netSalary,
    standardDeduction, professionalTax, incomeFromSalary, otherIncome, houseProperty, grossTotalIncome,
    deductions, totalDeductions: rupee(totalDeductions), refused,
    taxableIncome, slabTax, rebate, taxAfterRebate, surchargeRate, surcharge, marginalReliefs: { rebate: rebateRelief, surcharge: surchargeRelief },
    cess, totalBeforeRounding, totalTax,
    forms: rules.get('forms'),
    lines, warnings, unverifiedRules: unverifiedUsed,
  };
}

/* ── compareRegimes ────────────────────────────────────────────────────── */
/** Both regimes on the same facts. A tie goes to the NEW regime (the default). */
export function compareRegimes(input, rulesOld, rulesNew) {
  const old = computeTax({ ...input, regime: 'OLD' }, rulesOld);
  const neu = computeTax({ ...input, regime: 'NEW' }, rulesNew);
  const cheaper = old.totalTax < neu.totalTax ? 'OLD' : 'NEW';
  const difference = Math.abs(old.totalTax - neu.totalTax);
  const sentence = difference === 0
    ? `Both regimes come to ${inr(neu.totalTax)}; the new regime is the default.`
    : `The ${cheaper === 'OLD' ? 'old' : 'new'} regime costs ${inr(difference)} less (${inr(cheaper === 'OLD' ? old.totalTax : neu.totalTax)} against ${inr(cheaper === 'OLD' ? neu.totalTax : old.totalTax)}).`;
  return { old, new: neu, cheaper, difference, sentence };
}
