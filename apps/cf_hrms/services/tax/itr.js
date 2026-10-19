/**
 * itr.js — the person's own income-tax RETURN for a year, worked out from the employer's
 * figures and what the person adds (TM/CF_HRMS_HIRING_SPEC.md §25.6, P4 "ITR helper (A)").
 * Pure: no database, no clock (the caller passes `today`), no numbers of its own — every
 * rate, limit and date is a rule of the year (ruleData.js: itr_forms, interest_234,
 * return_filing, house_property, capital_gains, rebate_special and the engine's own).
 *
 *   selectForm(parts, totals, rules)        ITR-1 or ITR-2, each condition with its answer
 *   interestEstimate(input, rules, year)    234A / 234B / 234C and the 234F fee (an estimate)
 *   engineInput(parts, employer, year)      the engine's input from the return's parts
 *   computeReturn({ year, parts, employer, today }, { OLD, NEW })
 *                                           both regimes, the regime to file, taxes paid, interest,
 *                                           payable or refund, and the ITR schedules (S, HP, CG, OS,
 *                                           VI-A, B-TI, B-TTI, TDS/TCS/IT) for the summary.
 *
 * NOTHING HERE FILES ANYTHING. The result is what the person types or uploads on
 * incometax.gov.in themselves.
 */
import { compareRegimes, inr, roundTo } from './engine.js';
import { ageBandFor, yearBounds } from './rules.js';

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const rupee = (v) => Math.round(n(v) + 1e-9);
const pos = (v) => Math.max(0, rupee(v));
const sum = (arr, f = (x) => x) => (arr ?? []).reduce((a, x) => a + n(f(x)), 0);

/* ── dates ─────────────────────────────────────────────────────────────── */
const at = (iso) => new Date(`${iso}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const addMonths = (s, k) => { const d = at(s); d.setUTCMonth(d.getUTCMonth() + k); return iso(d); };
const addDays = (s, k) => { const d = at(s); d.setUTCDate(d.getUTCDate() + k); return iso(d); };
/** Months "or part of a month" from `from` (inclusive) to `to` (inclusive): 1 Apr → 15 Jul = 4. */
export function monthsOrPart(from, to) {
  if (!from || !to || to < from) return 0;
  let k = 0;
  while (addMonths(from, k) <= to) k += 1;
  return k;
}
/** The day a part of a year falls on: '06-15' in the financial year → 'YYYY-06-15' (March → the next calendar year). */
const fyDate = (year, mmdd) => { const { startYear } = yearBounds(year); return `${Number(mmdd.slice(0, 2)) >= 4 ? startYear : startYear + 1}-${mmdd}`; };

/* ── the parts of a return (what the person types) ─────────────────────── */
/**
 * parts = {
 *   personal:   { residentialStatus: 'RESIDENT'|'RNOR'|'NON_RESIDENT', dateOfBirth, agriculturalIncome,
 *                 isDirector, unlistedShares, foreignAssetsOrIncome, broughtForwardLosses },
 *   employer:   typed Form 16/130 figures (used when there are no payslips, or useTyped):
 *               { useTyped, employerName, tan, grossSalary, perquisites, exemptHra, exemptLta, exemptOther, exemptOtherSection,
 *                 professionalTax, tds, employerNps, basic, da, previous: { name, tan, salary, professionalTax, tds } },
 *               basic / da: the year's Basic and DA (typed, else the payslips' BASIC / DA lines) — the
 *               salary of the 80CCD(2) limit and of the HRA working; never the gross.
 *   income:     { savingsInterest, depositInterest, dividends, other: [{ description, amount }],
 *                 houseProperties: [{ kind, name, rentReceived, municipalTaxPaid, interest }],
 *                 capitalGains: { stcg111A, ltcg112A, ltcg112, stcgOther } },
 *   deductions: { '80C', '80CItems': [{ description, documentNo, amount }], '80CCD1B',
 *                 '80D': { selfFamily, parents, selfFamilySenior, parentsSenior, preventive,
 *                          policies: [{ for: 'SELF_FAMILY'|'PARENTS', insurer, policyNo, amount }] },
 *                 '80E', '80ELoans': [{ lenderType: 'B'|'I', lender, loanAccount, loanDate, loanAmount, outstanding, interest }],
 *                 '80G', '80GDonations': [{ name, pan, address, city, stateCode, pinCode, category, cash, otherMode, transactionRef, ifsc, arn, eligible }],
 *                 hra: { placeOfWork, rentPaid, received } },
 *               A list, when given, is the claim: 80C = the sum of the lines, the 80D halves = the
 *               policies, 80E = the interest, 80G = the eligible amounts (deductionsOf). The lists are
 *               what the ITR's schedules 80C / 80D / 80E / 80G / 10(13A) need.
 *   taxes:      { paid: [{ kind: 'ADVANCE'|'SELF_ASSESSMENT', bsrCode, date, challanNo, amount }],
 *                 otherTds: [{ kind: 'TDS'|'TCS', deductor, tan, section, income, amount }] },
 *   choices:    { form: 'ITR1'|'ITR2'|null, regime: 'OLD'|'NEW'|null, filingDate },
 * }
 * employer (live, from payroll, or null) = { source: 'PAYROLL', employerName, months, grossSalary,
 *   professionalTax, tds, pfEmployee, hraReceived, basic, da } — services/itr/employerPart.js.
 */

/** The salary block the return uses: from payroll, else typed; each figure says where it came from. */
export function salaryBlock(parts, employer) {
  const t = parts.employer ?? {};
  const fromPayroll = Boolean(employer && employer.months > 0 && !t.useTyped);
  const pick = (key, live) => (fromPayroll && live != null ? { value: rupee(live), source: 'EMPLOYER' } : { value: rupee(t[key]), source: 'TYPED' });
  const prev = t.previous ?? {};
  // Basic and DA: what the person typed wins; else the released payslips' BASIC / DA lines.
  const typedOr = (v, live) => (v != null && v !== '' ? { value: pos(v), source: 'TYPED' } : (employer && employer.months > 0 && live != null ? { value: pos(live), source: 'EMPLOYER' } : { value: 0, source: 'TYPED' }));
  const basic = typedOr(t.basic, employer?.basic);
  const da = typedOr(t.da, employer?.da);
  const hraIn = parts.deductions?.hra ?? {};
  return {
    fromPayroll,
    employerName: fromPayroll ? employer.employerName : (t.employerName ?? null),
    tan: t.tan ?? null,
    grossSalary: pick('grossSalary', employer?.grossSalary),
    perquisites: { value: pos(t.perquisites), source: 'TYPED' },
    exemptHra: { value: pos(t.exemptHra), source: 'TYPED' },
    exemptLta: { value: pos(t.exemptLta), source: 'TYPED' },
    exemptOtherSection: t.exemptOtherSection ?? '10(10)',
    exemptOther: { value: pos(t.exemptOther), source: 'TYPED' },
    professionalTax: pick('professionalTax', employer?.professionalTax),
    tds: pick('tds', employer?.tds),
    employerNps: { value: pos(t.employerNps), source: 'TYPED' },
    basic, da, basicDa: { value: basic.value + da.value, source: basic.source === 'EMPLOYER' || da.source === 'EMPLOYER' ? 'EMPLOYER' : 'TYPED' },
    hraReceived: typedOr(hraIn.received, employer?.hraReceived),
    previous: (n(prev.salary) || n(prev.tds)) ? { name: prev.name ?? null, tan: prev.tan ?? null, salary: pos(prev.salary), professionalTax: pos(prev.professionalTax), tds: pos(prev.tds) } : null,
  };
}

/* ── the deduction details behind the ITR's schedules ──────────────────── */
/** Schedule 80G's four tables (ITR-1 AY 2026-27 schema: Don100Percent, Don50PercentNoApprReqd,
 *  Don100PercentApprReqd, Don50PercentApprReqd) and the share of each donation they allow. */
export const DONATION_CATEGORIES = { NO_LIMIT_100: 100, NO_LIMIT_50: 50, LIMIT_100: 100, LIMIT_50: 50 };
/** Section 80G(5D) / ITR-1 AY 2026-27 validation rules 88 and 327: cash to one donee (PAN) above
 *  ₹2,000 in all is not allowed at all. */
export const DONATION_CASH_LIMIT = 2000;

/** Each donation with what it allows: { …, cash, otherMode, donation, eligible, max, pct, limited, cashRefused }.
 *  A "subject to the qualifying limit" donation counts what the person typed as eligible (the 10% of
 *  adjusted gross total income is not worked out here), at most its share of the donation. */
export function donationsWorked(list = []) {
  const cashByPan = {};
  for (const x of list) { const k = String(x.pan ?? '').toUpperCase(); cashByPan[k] = (cashByPan[k] ?? 0) + pos(x.cash); }
  return list.map((x) => {
    const category = DONATION_CATEGORIES[x.category] ? x.category : 'LIMIT_50';
    const pct = DONATION_CATEGORIES[category];
    const cash = pos(x.cash);
    const otherMode = pos(x.otherMode);
    const cashRefused = cashByPan[String(x.pan ?? '').toUpperCase()] > DONATION_CASH_LIMIT && cash > 0;
    const max = rupee((otherMode + (cashRefused ? 0 : cash)) * pct / 100);
    const typed = x.eligible != null && x.eligible !== '';
    return { ...x, category, pct, cash, otherMode, donation: cash + otherMode, max, eligible: typed ? Math.min(pos(x.eligible), max) : max, limited: category.startsWith('LIMIT'), eligibleTyped: typed, cashRefused };
  });
}

/** The deductions the engine counts: a list, when given, is the claim. */
export function deductionsOf(parts) {
  const src = parts.deductions ?? {};
  const ded = { ...src };
  for (const k of ['80CItems', '80ELoans', '80GDonations', 'hra']) delete ded[k];
  const items = (src['80CItems'] ?? []).filter((x) => n(x.amount) > 0);
  if (items.length) ded['80C'] = rupee(sum(items, (x) => x.amount));
  const d80 = src['80D'];
  if (d80 && typeof d80 === 'object') {
    const pol = (d80.policies ?? []).filter((x) => n(x.amount) > 0);
    const self = pol.filter((x) => x.for !== 'PARENTS');
    const par = pol.filter((x) => x.for === 'PARENTS');
    ded['80D'] = { ...d80, ...(self.length ? { selfFamily: rupee(sum(self, (x) => x.amount)) } : {}), ...(par.length ? { parents: rupee(sum(par, (x) => x.amount)) } : {}) };
    delete ded['80D'].policies;
  }
  const loans = (src['80ELoans'] ?? []).filter((x) => n(x.interest) > 0);
  if (loans.length) ded['80E'] = rupee(sum(loans, (x) => x.interest));
  const gifts = donationsWorked((src['80GDonations'] ?? []).filter((x) => n(x.cash) + n(x.otherMode) > 0));
  if (gifts.length) ded['80G'] = sum(gifts, (x) => x.eligible);
  return ded;
}

/** HRA to be worked out from the rent (Schedule 10(13A)), or null when no rent is given. */
export function hraOf(parts, s) {
  const h = parts.deductions?.hra ?? {};
  if (!(n(h.rentPaid) > 0)) return null;
  return { rentPaid: pos(h.rentPaid), city: h.placeOfWork || null, basic: s.basicDa.value, hraReceived: s.hraReceived.value };
}

/** The engine's input. The return counts the whole year's deductions (also those given to the employer). */
export function engineInput(parts, employer, year) {
  const s = salaryBlock(parts, employer);
  const inc = parts.income ?? {};
  const p = parts.personal ?? {};
  const ded = deductionsOf(parts);
  if (s.employerNps.value) ded['80CCD2'] = s.employerNps.value;
  const hra = hraOf(parts, s);
  return {
    year,
    dateOfBirth: p.dateOfBirth || undefined,
    resident: String(p.residentialStatus ?? 'RESIDENT').toUpperCase() !== 'NON_RESIDENT',
    salary: { components: [{ code: 'GROSS', name: 'Gross salary (section 17(1))', amount: s.grossSalary.value }] },
    perquisites: s.perquisites.value ? [{ name: 'Perquisites (as on the certificate)', value: s.perquisites.value }] : [],
    // HRA: worked out from the rent when it is given (the ITR's Schedule 10(13A) needs the working), else as certified.
    exemptions: { asCertified: { hraLta: (hra ? 0 : s.exemptHra.value) + s.exemptLta.value, other: s.exemptOther.value }, ...(hra ? { hra } : {}) },
    professionalTax: s.professionalTax.value,
    previousEmployer: s.previous ? { taxableSalary: s.previous.salary, tds: s.previous.tds, pt: s.previous.professionalTax } : undefined,
    // 80CCD(2): at most 14% (new) / 10% or 14% (old) of SALARY = Basic + DA (Explanation to 80CCD;
    // the 2025 Act keeps "salary" as Basic + DA) — never the gross.
    salaryForLimits: s.basicDa.value,
    otherIncome: { savingsInterest: pos(inc.savingsInterest), depositInterest: pos(inc.depositInterest), dividends: pos(inc.dividends), other: sum(inc.other, (o) => Math.max(0, n(o.amount))) },
    houseProperties: (inc.houseProperties ?? []).map((h) => ({ kind: h.kind, name: h.name, rentReceived: pos(h.rentReceived), municipalTaxPaid: pos(h.municipalTaxPaid), interest: pos(h.interest) })),
    capitalGains: inc.capitalGains ?? {},
    deductions: ded,
  };
}

/* ── which form ────────────────────────────────────────────────────────── */
/**
 * ITR-1 (Sahaj) when every condition holds; else ITR-2 (no business income is modelled here).
 * `c` = the computation the form is judged on (the regime to file). The person may pick ITR-2
 * anyway; ITR-1 when a condition fails is refused with the reason.
 */
export function selectForm(parts, c, rules) {
  const f = rules.get('itr_forms');
  const one = f.ITR1;
  const p = parts.personal ?? {};
  const status = String(p.residentialStatus ?? 'RESIDENT').toUpperCase();
  const props = parts.income?.houseProperties ?? [];
  const cg = c.capitalGains ?? {};
  const checks = [
    { key: 'resident', ok: status === 'RESIDENT', text: status === 'RESIDENT' ? 'You are resident (and ordinarily resident) in India.' : `ITR-1 is only for a resident who is ordinarily resident; you said ${status === 'RNOR' ? 'resident but not ordinarily resident' : 'non-resident'}.` },
    { key: 'totalIncome', ok: c.taxableIncome <= one.maxTotalIncome, text: c.taxableIncome <= one.maxTotalIncome ? `Total income ${inr(c.taxableIncome)} is not above ${inr(one.maxTotalIncome)}.` : `Total income ${inr(c.taxableIncome)} is above ${inr(one.maxTotalIncome)}.` },
    { key: 'houseProperty', ok: props.length <= one.maxHouseProperties, text: props.length <= one.maxHouseProperties ? `${props.length ? props.length : 'No'} house propert${props.length === 1 ? 'y' : 'ies'} (ITR-1 allows ${one.maxHouseProperties}).` : `${props.length} house properties — ITR-1 allows ${one.maxHouseProperties}.` },
    { key: 'hpLoss', ok: !c.hpLossCarriedForward, text: c.hpLossCarriedForward ? `A house-property loss of ${inr(c.hpLossCarriedForward)} is carried forward — that needs ITR-2.` : 'No loss to carry forward.' },
    {
      key: 'capitalGains',
      ok: !cg.stcg111A && !cg.ltcg112 && !cg.stcgOther && n(cg.ltcg112A) <= one.ltcg112aMax,
      text: (!cg.stcg111A && !cg.ltcg112 && !cg.stcgOther && n(cg.ltcg112A) <= one.ltcg112aMax)
        ? (n(cg.ltcg112A) ? `Only long-term equity gains of ${inr(cg.ltcg112A)} (${one.ltcg112aSection}), not above ${inr(one.ltcg112aMax)}.` : 'No capital gains.')
        : `Capital gains other than long-term equity gains up to ${inr(one.ltcg112aMax)} (${one.ltcg112aSection}) need ITR-2.`,
    },
    { key: 'agricultural', ok: n(p.agriculturalIncome) <= one.agriculturalIncomeMax, text: n(p.agriculturalIncome) <= one.agriculturalIncomeMax ? `Agricultural income ${inr(p.agriculturalIncome)} is not above ${inr(one.agriculturalIncomeMax)}.` : `Agricultural income ${inr(p.agriculturalIncome)} is above ${inr(one.agriculturalIncomeMax)}.` },
    { key: 'director', ok: !p.isDirector, text: p.isDirector ? 'A director of a company files ITR-2.' : 'Not a director of a company.' },
    { key: 'unlisted', ok: !p.unlistedShares, text: p.unlistedShares ? 'Holding unlisted equity shares at any time in the year needs ITR-2.' : 'No unlisted equity shares.' },
    { key: 'foreign', ok: !p.foreignAssetsOrIncome, text: p.foreignAssetsOrIncome ? 'Foreign assets or foreign income need ITR-2.' : 'No foreign assets or income.' },
    { key: 'losses', ok: !p.broughtForwardLosses, text: p.broughtForwardLosses ? 'Losses brought forward from earlier years need ITR-2.' : 'No losses brought forward.' },
  ];
  const failed = checks.filter((x) => !x.ok);
  const suggested = failed.length ? 'ITR2' : 'ITR1';
  const chosen = String(parts.choices?.form ?? '').toUpperCase();
  let form = suggested;
  let note = null;
  if (chosen === 'ITR2') form = 'ITR2';
  else if (chosen === 'ITR1' && failed.length) note = `ITR-1 cannot be used: ${failed.map((x) => x.text).join(' ')}`;
  return {
    suggested, form, chosen: chosen || null, note,
    reason: failed.length ? `ITR-2, because: ${failed.map((x) => x.text).join(' ')}` : 'ITR-1 (Sahaj): every condition below holds.',
    checks, names: { ITR1: one.name, ITR2: f.ITR2.name }, published: f.published, formsNote: f.note,
  };
}

/* ── interest and fee ──────────────────────────────────────────────────── */
/**
 * input = { taxOnIncome (after rebate, surcharge, cess), tdsTcs, advance: [{ date, amount }],
 *           selfAssessment: [{ date, amount }], filingDate, totalIncome, exemptFromAdvanceTax }
 * Interest is 1% a month or part of a month on an amount rounded DOWN to ₹100 (rule 119A).
 * 234C assumes all the income was there from the start of the year (capital gains or dividends
 * that came later would lower it — the proviso — and are not modelled; said in the notes).
 */
export function interestEstimate(input, rules, year) {
  const r = rules.get('interest_234');
  const due = rules.get('return_filing');
  const floorTo = (x) => Math.floor(Math.max(0, x) / r.roundBaseDownTo) * r.roundBaseDownTo;
  const { endYear } = yearBounds(year);
  const ayStart = `${endYear}-04-01`;
  const filingDate = input.filingDate ?? due.dueDate;
  const tax = rupee(input.taxOnIncome);
  const tdsTcs = rupee(input.tdsTcs);
  const advance = (input.advance ?? []).filter((x) => n(x.amount) > 0);
  const sat = (input.selfAssessment ?? []).filter((x) => n(x.amount) > 0);
  const advancePaid = rupee(sum(advance, (x) => x.amount));
  const assessed = Math.max(0, tax - tdsTcs);
  const notes = [];
  const out = { a: 0, b: 0, c: 0, fee: 0, assessed, advancePaid, details: { a: [], b: [], c: [] }, notes, dueDate: due.dueDate, filingDate, late: filingDate > due.dueDate };

  const liable = assessed >= r.advanceTaxThreshold && !input.exemptFromAdvanceTax;
  if (input.exemptFromAdvanceTax && assessed >= r.advanceTaxThreshold) notes.push(r.seniorNote);
  if (!input.exemptFromAdvanceTax && assessed > 0 && assessed < r.advanceTaxThreshold) notes.push(`No advance tax was due: the tax after TDS (${inr(assessed)}) is below ${inr(r.advanceTaxThreshold)} (${r.thresholdSection}), so no interest under ${r.sections.b} or ${r.sections.c}.`);

  /* 234C — instalments */
  if (liable) {
    for (const inst of r.instalments) {
      const by = fyDate(year, inst.by);
      const paid = sum(advance.filter((x) => String(x.date) <= by), (x) => x.amount);
      const required = assessed * inst.cumPct / 100;
      const safe = assessed * inst.safePct / 100;
      let interest = 0;
      if (paid < safe) interest = rupee(floorTo(required - paid) * r.ratePerMonth / 100 * inst.months);
      out.details.c.push({ by, cumPct: inst.cumPct, required: rupee(required), paid: rupee(paid), shortfall: rupee(Math.max(0, required - paid)), months: inst.months, interest });
      out.c += interest;
    }
    notes.push(r.cgNote);
  }

  /* 234B — advance tax below 90% of the assessed tax: from 1 April of the assessment year to filing */
  if (liable && advancePaid < assessed * r.bPct / 100) {
    const shortfall = assessed - advancePaid;
    const months = monthsOrPart(ayStart, filingDate);
    for (let k = 0; k < months; k += 1) {
      const start = addMonths(ayStart, k);
      const outstanding = shortfall - sum(sat.filter((x) => String(x.date) >= ayStart && String(x.date) < start), (x) => x.amount);
      const i = rupee(floorTo(outstanding) * r.ratePerMonth / 100);
      out.details.b.push({ from: start, outstanding: rupee(Math.max(0, outstanding)), interest: i });
      out.b += i;
    }
  }

  /* 234A — filed after the due date: on the tax still unpaid on the due date */
  if (out.late) {
    const base = tax - tdsTcs - advancePaid - sum(sat.filter((x) => String(x.date) <= due.dueDate), (x) => x.amount);
    const from = addDays(due.dueDate, 1);
    const months = monthsOrPart(from, filingDate);
    for (let k = 0; k < months; k += 1) {
      const start = addMonths(from, k);
      const outstanding = base - sum(sat.filter((x) => String(x.date) > due.dueDate && String(x.date) < start), (x) => x.amount);
      const i = rupee(floorTo(outstanding) * r.ratePerMonth / 100);
      out.details.a.push({ from: start, outstanding: rupee(Math.max(0, outstanding)), interest: i });
      out.a += i;
    }
    const f = rules.get('late_fee');
    const opt = rules.get('regime_option');
    out.fee = n(input.totalIncome) <= f.smallIncomeLimit ? f.smallIncomeFee : f.fee;
    notes.push(`Filed after ${due.dueDate}: a late fee of ${inr(out.fee)} (${f.section}) and interest under ${r.sections.a}.${opt.oldRegimeNote ? ` ${opt.oldRegimeNote}` : ''}`);
  }
  out.total = out.a + out.b + out.c;
  return out;
}

/* ── the return ────────────────────────────────────────────────────────── */
export function computeReturn({ year, parts = {}, employer = null, today }, rules) {
  const R = rules.NEW;
  const input = engineInput(parts, employer, year);
  const both = compareRegimes(input, rules.OLD, rules.NEW);
  const due = R.get('return_filing');
  const filingDate = parts.choices?.filingDate || (today && today > due.dueDate ? today : due.dueDate);
  const chosenRegime = String(parts.choices?.regime ?? '').toUpperCase();
  const warnings = [];
  let regime = chosenRegime === 'OLD' || chosenRegime === 'NEW' ? chosenRegime : both.cheaper;
  const opt = R.get('regime_option');
  if (regime === 'OLD' && filingDate > due.dueDate && opt.oldRegimeNeedsDueDate) {
    warnings.push(`The old regime can be chosen only in a return filed by ${due.dueDate} (${opt.oldRegimeSection}). Filed on ${filingDate}, the new regime applies.`);
    regime = 'NEW';
  }
  const c = regime === 'OLD' ? both.old : both.new;
  const form = selectForm(parts, c, R);
  const s = salaryBlock(parts, employer);
  if (s.employerNps.value && !s.basicDa.value) warnings.push("Employer's NPS (80CCD(2)): its limit is a share of your Basic + DA, which is not known — type your Basic and DA for the year in step 2. Until then the deduction counts ₹0.");
  const hra = hraOf(parts, s);
  if (hra && s.exemptHra.value) {
    const worked = c.exemptions.find((e) => e.key === 'exempt_hra' && e.working)?.exempt;
    if (worked != null && worked !== s.exemptHra.value) warnings.push(`HRA: the exemption worked out from your rent is ${inr(worked)}; the ${inr(s.exemptHra.value)} typed from your certificate is not used (the return's Schedule 10(13A) needs the working).`);
  }
  if (hra && !s.basicDa.value) warnings.push('HRA: the exemption is worked out on your Basic + DA, which is not known — type them in step 2.');
  for (const g of donationsWorked(parts.deductions?.['80GDonations'] ?? [])) {
    if (g.cashRefused) warnings.push(`80G: cash to ${g.name || 'a donee'} above ${inr(DONATION_CASH_LIMIT)} in all is not allowed (section 80G(5D)); only the other-mode amount counts.`);
    if (g.limited && !g.eligibleTyped && g.max) warnings.push(`80G: the donation to ${g.name || 'a donee'} is subject to the qualifying limit (10% of the adjusted gross total income), which is not worked out here — type the eligible amount if the limit cuts it.`);
  }

  const otherTds = (parts.taxes?.otherTds ?? []).filter((t) => String(t.kind ?? 'TDS').toUpperCase() === 'TDS');
  const tcs = (parts.taxes?.otherTds ?? []).filter((t) => String(t.kind).toUpperCase() === 'TCS');
  const paid = parts.taxes?.paid ?? [];
  const advance = paid.filter((x) => String(x.kind).toUpperCase() === 'ADVANCE');
  const selfAssessment = paid.filter((x) => String(x.kind).toUpperCase() === 'SELF_ASSESSMENT');
  const prepaid = {
    salaryTds: s.tds.value + (s.previous?.tds ?? 0),
    otherTds: rupee(sum(otherTds, (t) => t.amount)),
    tcs: rupee(sum(tcs, (t) => t.amount)),
    advance: rupee(sum(advance, (t) => t.amount)),
    selfAssessment: rupee(sum(selfAssessment, (t) => t.amount)),
  };
  prepaid.total = prepaid.salaryTds + prepaid.otherTds + prepaid.tcs + prepaid.advance + prepaid.selfAssessment;

  const p = parts.personal ?? {};
  const ageBand = ageBandFor({ dateOfBirth: p.dateOfBirth || undefined }, year);
  const interestRule = R.get('interest_234');
  const exemptFromAdvanceTax = ageBand !== 'BELOW_60' && String(p.residentialStatus ?? 'RESIDENT').toUpperCase() !== 'NON_RESIDENT' && interestRule.seniorExempt;
  const interest = interestEstimate({
    taxOnIncome: c.totalTax, tdsTcs: prepaid.salaryTds + prepaid.otherTds + prepaid.tcs,
    advance, selfAssessment, filingDate, totalIncome: c.taxableIncome, exemptFromAdvanceTax,
  }, R, year);
  const balanceExact = c.totalTax + interest.total + interest.fee - prepaid.total;
  const balance = roundTo(balanceExact, R.get('rounding').taxPayableTo);
  const payable = balance > 0 ? balance : 0;
  const refund = balance < 0 ? -balance : 0;
  const sentence = payable
    ? `You have ${inr(payable)} still to pay. Pay it as self-assessment tax (e-Pay Tax on incometax.gov.in) before you file, then add the challan here.`
    : refund ? `You should get a refund of ${inr(refund)} into your bank account once the return is processed.` : 'Nothing more to pay and no refund.';

  const { endYear } = yearBounds(year);
  const result = {
    year, assessmentYear: `${endYear}-${String((endYear + 1) % 100).padStart(2, '0')}`,
    act: R.get('forms').act, forms: R.get('forms'),
    regime, regimeChosen: chosenRegime || null, compare: { cheaper: both.cheaper, difference: both.difference, sentence: both.sentence, oldTax: both.old.totalTax, newTax: both.new.totalTax },
    old: both.old, new: both.new, computation: c,
    form, salary: s, prepaid, interest, filingDate, balance, payable, refund, sentence,
    warnings: [...warnings, ...c.warnings],
    unverifiedRules: [...new Set([...both.old.unverifiedRules, ...both.new.unverifiedRules, ...['itr_forms', 'interest_234', 'return_filing', 'regime_option', 'late_fee'].filter((k) => !R.source(k).verified)])],
  };
  result.schedules = schedules(result, parts, R);
  return result;
}

/* ── the ITR's schedules, as the summary prints them ───────────────────── */
function schedules(r, parts, R) {
  const c = r.computation;
  const s = r.salary;
  const cert = R.get('forms').certificate.label;
  const row = (label, amount, extra = {}) => ({ label, amount: amount == null ? null : rupee(amount), ...extra });
  const S = [
    row(`Gross salary (section 17(1)) — ${s.employerName ?? 'your employer'}`, s.grossSalary.value, { source: s.grossSalary.source }),
    ...(s.perquisites.value ? [row('Perquisites (section 17(2))', s.perquisites.value, { source: 'TYPED' })] : []),
    ...(s.previous ? [row(`Salary from the previous employer${s.previous.name ? ` (${s.previous.name})` : ''}`, s.previous.salary, { source: 'TYPED' })] : []),
    ...c.exemptions.map((e) => row(`Less exempt: ${e.label}`, -e.exempt, { source: 'TYPED' })),
    row('Net salary', c.netSalary),
    row(`Standard deduction`, -c.standardDeduction),
    ...(c.professionalTax ? [row('Professional tax', -c.professionalTax, { source: s.professionalTax.source })] : []),
    row('Income chargeable under the head "Salaries"', c.incomeFromSalary),
  ];
  const HP = c.houseProperties.map((h, i) => ({
    label: `${h.name || `Property ${i + 1}`} — ${h.kind === 'SELF_OCCUPIED' ? 'self-occupied' : 'let out'}`,
    rows: h.kind === 'SELF_OCCUPIED'
      ? [row('Interest on borrowed capital', -(h.interestAllowed ?? 0)), row('Income from this property', h.income)]
      : [row('Gross rent', h.rentReceived), row('Less municipal taxes paid', -h.municipalTaxPaid), row('Net annual value', h.netAnnualValue), row('Less 30% of net annual value', -h.standardDeduction), row('Less interest on borrowed capital', -h.interest), row('Income from this property', h.income)],
  }));
  const cg = c.capitalGains;
  const CG = [
    ...(cg.stcg111A ? [row('Short-term gains on listed equity / equity funds (STT paid)', cg.stcg111A, { rate: R.get('capital_gains').stcgEquity.rate })] : []),
    ...(cg.stcgOther ? [row('Other short-term gains (slab rates)', cg.stcgOther)] : []),
    ...(cg.ltcg112A ? [row('Long-term gains on listed equity / equity funds (section 112A)', cg.ltcg112A, { rate: R.get('capital_gains').ltcgEquity.rate })] : []),
    ...(cg.ltcg112 ? [row('Other long-term gains (section 112)', cg.ltcg112, { rate: R.get('capital_gains').ltcgOther.rate })] : []),
  ];
  const os = c.otherSources;
  const OS = [
    ...(os.savingsInterest ? [row('Interest from savings accounts', os.savingsInterest)] : []),
    ...(os.depositInterest ? [row('Interest from deposits (bank, post office, co-operative)', os.depositInterest)] : []),
    ...(os.dividends ? [row('Dividends', os.dividends)] : []),
    ...(parts.income?.other ?? []).filter((o) => n(o.amount) > 0).map((o) => row(o.description || 'Other income', o.amount)),
    row('Income from other sources', c.otherIncome),
  ];
  // `counted`: each part after the cut to the gross total income, so the rows add up to the total (engine.js).
  const VIA = [...c.deductions.map((d) => row(`${d.section} — ${String(d.label).split(' — ')[1] ?? d.label}`, d.counted ?? d.allowed)), row('Total deductions', c.totalDeductions)];
  const BTI = [
    row('Salaries', c.incomeFromSalary),
    row('House property', c.houseProperty),
    row('Capital gains', cg.stcg111A + cg.stcgOther + cg.ltcg112A + cg.ltcg112),
    row('Other sources', c.otherIncome),
    row('Gross total income', c.grossTotalIncome),
    row('Deductions (Chapter VI-A)', -c.totalDeductions),
    row('Total income', c.taxableIncome),
    ...(c.hpLossCarriedForward ? [row('Loss carried forward (house property)', c.hpLossCarriedForward)] : []),
  ];
  const i = r.interest;
  const BTTI = [
    row('Tax at the slab rates', c.slabTax),
    ...(c.specialRateTax ? [row('Tax at special rates (capital gains)', c.specialRateTax)] : []),
    row(`Rebate${c.marginalReliefs.rebate ? ' (marginal relief)' : ''}`, -c.rebate),
    ...(c.surcharge ? [row('Surcharge', c.surcharge)] : []),
    row('Health and education cess', c.cess),
    row('Tax on total income', c.totalTax),
    ...(i.a ? [row('Interest u/s 234A (estimate)', i.a)] : []),
    ...(i.b ? [row('Interest u/s 234B (estimate)', i.b)] : []),
    ...(i.c ? [row('Interest u/s 234C (estimate)', i.c)] : []),
    ...(i.fee ? [row('Fee u/s 234F', i.fee)] : []),
    row('Total tax, interest and fee', c.totalTax + i.total + i.fee),
    row('Taxes paid (TDS, TCS, advance and self-assessment tax)', -r.prepaid.total),
    row(r.payable ? 'Tax payable' : 'Refund', r.payable || r.refund),
  ];
  const TDS = [
    { who: s.employerName ?? 'Employer', tan: s.tan, kind: `Salary (${cert})`, income: s.grossSalary.value, amount: s.tds.value, source: s.tds.source },
    ...(s.previous ? [{ who: s.previous.name ?? 'Previous employer', tan: s.previous.tan, kind: 'Salary (previous employer)', income: s.previous.salary, amount: s.previous.tds, source: 'TYPED' }] : []),
    ...(parts.taxes?.otherTds ?? []).filter((t) => String(t.kind ?? 'TDS').toUpperCase() === 'TDS').map((t) => ({ who: t.deductor, tan: t.tan, kind: t.section ? `Other income (${t.section})` : 'Other income', income: rupee(t.income), amount: rupee(t.amount), source: 'TYPED' })),
  ];
  const TCS = (parts.taxes?.otherTds ?? []).filter((t) => String(t.kind).toUpperCase() === 'TCS').map((t) => ({ who: t.deductor, tan: t.tan, kind: t.section ?? 'TCS', amount: rupee(t.amount) }));
  const IT = (parts.taxes?.paid ?? []).map((t) => ({ kind: String(t.kind).toUpperCase() === 'ADVANCE' ? 'Advance tax' : 'Self-assessment tax', bsrCode: t.bsrCode ?? null, date: t.date ?? null, challanNo: t.challanNo ?? null, amount: rupee(t.amount) }));
  return { S, HP, CG, OS, VIA, BTI, BTTI, TDS, TCS, IT };
}
