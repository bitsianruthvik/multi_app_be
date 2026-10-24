/**
 * checks.js — THE COMPLIANCE CHECKS (TM/CF_HRMS_HIRING_SPEC.md §36.2, C2). PURE: no database. The
 * caller (wire.js, breaches.js) reads the law in force for the person's state and date (services/law)
 * and the pay lines, and hands them in.
 *
 * A RESULT is
 *   { check, severity: 'HARD' | 'WARN' | 'INFO', hardIfVerified, unverifiedNote,
 *     rule: { id, domain, jurisdiction, ruleKey, title, sourceUrl, effectiveFrom, version, verified } | null,
 *     message, numbers }
 * Only results that say something are returned (a passing check returns nothing).
 *
 * UNVERIFIED RULES NEVER BLOCK. A check that would be HARD against a rule whose `verified` is false
 * comes back as WARN, with `hardIfVerified: true` and a sentence saying so (`decide`).
 *
 * ── WHAT "WAGES" MEANS HERE (the minimum-wage and 50% comparisons) ─────────────────────────────
 * Code on Wages, 2019 s.2(y) (in force 21-11-2025, S.O. 5322(E)): "wages" are basic pay, dearness
 * allowance and retaining allowance; NOT wages are (a) statutory bonus, (b) house accommodation and
 * amenities, (c) the employer's PF / pension contribution, (d) conveyance, (e) special expenses of the
 * job, (f) HRA, (g) award / settlement pay, (h) overtime, (i) commission, (j) gratuity, (k) retrenchment
 * and retirement benefits. FIRST PROVISO: where (a)–(i) together exceed one half of all remuneration,
 * the excess is deemed wages. The minimum wage (s.6) is a minimum rate of WAGES in that sense, and
 * Telangana's G.O.Ms.No.6 (2026) fixes it as basic + VDA. So:
 *   - the HARD minimum-wage test compares   basic + DA + retaining (+ the statutory top-up) + the
 *     s.2(y) add-back   with the minimum (prorated by days paid in a run);
 *   - a WARN says when basic + DA ALONE is below it (it passes only through the add-back, and the
 *     G.O. words its rates as basic + VDA — an inspector may compare that).
 * Components are sorted by code (classOf): BASIC, DA, VDA, RETAINING(_ALLOWANCE), STAT_TOPUP = wages;
 * every other earning (HRA, conveyance, special, medical, overtime, bonus, LTA …) and the employer's
 * PF / NPS = the excluded remuneration counted in the 50% test; reimbursements, ESI / LWF employer,
 * gratuity, leave encashment, notice pay = not counted. "Special allowance" is treated as NOT wages —
 * the strict reading (some read s.2(y) as making any allowance not in (a)–(k) wages; then the checks
 * are stricter than the law, never looser). Open question for the CA.
 */
import { CHECKS, WAGE_CODES, NOT_COUNTED_EARNINGS, COUNTED_EMPLOYER } from './constants.js';

const money = (x) => Math.round((Number(x) || 0) * 100) / 100;
const inr = (v) => `₹${Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const pctText = (x) => `${Math.round(x * 1000) / 10}%`;

/** The fields of a law version a result carries. */
export function ruleRef(v) {
  if (!v) return null;
  return {
    id: v.id ?? null, domain: v.domain ?? null, jurisdiction: v.jurisdiction ?? null, ruleKey: v.ruleKey ?? null, title: v.title ?? null,
    sourceUrl: v.sourceUrl ?? null, effectiveFrom: v.effectiveFrom ?? null, version: v.version ?? null, verified: Boolean(v.verified),
  };
}

export const UNVERIFIED_NOTE = 'This rule is not verified yet (its value was not read on an official copy), so this warns instead of blocking. Check it with your CA.';

/** A result; HARD against an unverified rule (or no rule) becomes WARN. */
export function decide({ check, severity, rule = null, message, numbers = {} }) {
  const r = ruleRef(rule);
  let sev = severity;
  let unverifiedNote = null;
  if (sev === 'HARD' && !r?.verified) { sev = 'WARN'; unverifiedNote = UNVERIFIED_NOTE; }
  return { check, title: CHECKS[check] ?? check, severity: sev, hardIfVerified: severity === 'HARD', unverifiedNote, rule: r, message, numbers };
}

/* ── wages ───────────────────────────────────────────────────────────── */

/** WAGES | EXCLUDED (counted in remuneration, not wages) | NOT_COUNTED | IGNORE. */
export function classOf(c) {
  if (!c) return 'IGNORE';
  const code = String(c.code ?? '').toUpperCase();
  if (c.kind === 'DEDUCTION') return 'IGNORE';
  if (c.kind === 'REIMBURSEMENT') return 'NOT_COUNTED';
  if (c.kind === 'EMPLOYER_CONTRIBUTION') return COUNTED_EMPLOYER.has(c.statutoryKey ?? '') || COUNTED_EMPLOYER.has(code) ? 'EXCLUDED' : 'NOT_COUNTED';
  if (c.statutoryKey === 'ARREARS') return 'IGNORE';
  if (WAGE_CODES.has(code)) return 'WAGES';
  if (NOT_COUNTED_EARNINGS.has(code)) return 'NOT_COUNTED';
  return 'EXCLUDED';
}

/**
 * The s.2(y) arithmetic over a month's lines [{ code, name?, kind, statutoryKey?, amount | monthly }].
 * @returns { wages, basicDa, excluded, notCounted, remuneration, addBack, codeWages, ratio, wageParts, excludedParts, sharePct }
 */
export function wagesOf(lines, { sharePct = 50 } = {}) {
  let wages = 0; let excluded = 0; let notCounted = 0;
  const wageParts = []; const excludedParts = [];
  for (const l of lines ?? []) {
    const amt = Number(l.amount ?? l.monthly) || 0;
    if (!amt) continue;
    const k = classOf(l);
    if (k === 'WAGES') { wages += amt; wageParts.push({ code: l.code, name: l.name ?? l.code, amount: money(amt) }); }
    else if (k === 'EXCLUDED') { excluded += amt; excludedParts.push({ code: l.code, name: l.name ?? l.code, amount: money(amt) }); }
    else if (k === 'NOT_COUNTED') notCounted += amt;
  }
  const remuneration = wages + excluded;
  const addBack = Math.max(0, excluded - remuneration * (sharePct / 100));
  return {
    wages: money(wages), excluded: money(excluded), notCounted: money(notCounted), remuneration: money(remuneration),
    addBack: money(addBack), codeWages: money(wages + addBack), ratio: remuneration > 0 ? wages / remuneration : 1, sharePct, wageParts, excludedParts,
  };
}

/* ── the checks ──────────────────────────────────────────────────────── */

/**
 * Minimum wage. minWage = minimumWageOn's answer ({ found, reason?, wage: { total, basic, vda, vdaPending, zone, skill }, rule }),
 * rule = the MIN_WAGE law version (for source / verified), factor = days paid ÷ days in the month (1 for a full month).
 */
export function checkMinimumWage({ lines, minWage, rule = null, factor = 1, place = {}, wagesRule = null }) {
  if (!minWage?.found) {
    return [decide({ check: 'MIN_WAGE_UNKNOWN', severity: 'INFO', rule: minWage?.rule ?? null, message: `The minimum wage cannot be checked: ${minWage?.reason ?? 'the place is not known'}`, numbers: {} })];
  }
  const sharePct = Number(wagesRule?.value?.excludedSharePct) || 50;
  const w = wagesOf(lines, { sharePct });
  const need = money(minWage.wage.total * factor);
  const where = `${place.state ?? ''} zone ${minWage.wage.zone}, ${String(minWage.wage.skill).toLowerCase().replace('_', '-')}`.trim();
  const law = rule ?? minWage.rule;
  const lawWords = `${law?.title ?? 'the minimum-wage notification'}, from ${law?.effectiveFrom ?? '?'}`;
  const vda = minWage.wage.vdaPending ? ' (VDA not notified yet: the basic rate only)' : '';
  const numbers = { wages: w.wages, addBack: w.addBack, codeWages: w.codeWages, minimum: need, monthlyMinimum: minWage.wage.total, factor: money(factor), shortBy: money(Math.max(0, need - w.codeWages)) };
  if (w.codeWages + 0.005 < need) {
    return [decide({
      check: 'MIN_WAGE', severity: 'HARD', rule: law,
      message: `Wages of ${inr(w.codeWages)} a month (basic + DA ${inr(w.wages)}${w.addBack ? ` + ${inr(w.addBack)} of allowances above half of pay, Code on Wages s.2(y)` : ''}) are below the minimum wage of ${inr(need)}${factor < 1 ? ` for the days paid (${inr(minWage.wage.total)} a month)` : ''} for ${where}${vda} — ${lawWords}. Short by ${inr(numbers.shortBy)}.`,
      numbers,
    })];
  }
  if (w.wages + 0.005 < need) {
    return [decide({
      check: 'MIN_WAGE_BASIC', severity: 'WARN', rule: law,
      message: `Basic + DA alone (${inr(w.wages)}) is below the minimum wage of ${inr(need)} for ${where}; it is met only because allowances above half of pay count as wages (s.2(y)). The notification words its rates as basic + VDA — move pay into basic to be safe.`,
      numbers,
    })];
  }
  return [];
}

/** The Labour Code 50% rule (WARN): wages under the share of total remuneration. */
export function checkFiftyPercent({ lines, rule }) {
  if (!rule) return [];
  const sharePct = Number(rule.value?.excludedSharePct) || 50;
  const w = wagesOf(lines, { sharePct });
  if (w.remuneration <= 0 || w.ratio >= (100 - sharePct) / 100 - 1e-9) return [];
  const counted = w.wageParts.map((p) => p.name).join(' + ') || 'none';
  const excl = w.excludedParts.map((p) => p.name).join(', ');
  return [decide({
    check: 'WAGES_50', severity: 'WARN', rule,
    message: `Wages (${counted}: ${inr(w.wages)}) are ${pctText(w.ratio)} of total remuneration (${inr(w.remuneration)}, counting ${excl}). Under the Code on Wages s.2(y) the ${inr(w.addBack)} above half counts as wages for PF, ESI, gratuity and bonus.`,
    numbers: { wages: w.wages, remuneration: w.remuneration, ratio: money(w.ratio * 100), addBack: w.addBack, counted: w.wageParts.map((p) => p.code), excluded: w.excludedParts.map((p) => p.code) },
  })];
}

/**
 * Statutory deductions. components: Map(code → component) or array; settings: { PF, ESI, PT, LWF } of the
 * person's state on the day (law layer, each with meta.verification); pfMode of the salary;
 * pfWage / esiWage / gross: the full month's.
 */
export function checkStatutory({ components, settings = {}, pfMode = 'CEILING', pfWage = 0, esiWage = 0, gross = 0, rules = {} }) {
  const list = components instanceof Map ? [...components.values()] : (components ?? []);
  const active = (key) => list.find((c) => c.statutoryKey === key && c.status !== 'INACTIVE');
  const out = [];
  const lawOf = (kind) => rules[kind] ?? (settings[kind] ? { id: settings[kind].meta?.id, domain: kind, jurisdiction: settings[kind].meta?.stateCode, ruleKey: 'settings', title: `${kind} settings`, effectiveFrom: settings[kind].meta?.effectiveFrom, version: settings[kind].meta?.version, verified: settings[kind].meta?.verification === 'VERIFIED' } : null);
  const S = settings;
  if (S.PF) {
    const ceiling = Number(S.PF.wageCeiling) || Infinity;
    if (pfMode === 'NONE' && pfWage > 0 && pfWage <= ceiling) {
      // EPF Scheme para 26: a person whose PF wage is within the ceiling is a member — unless an apprentice or an
      // "excluded employee". The app cannot see which, so it warns and asks for the reason.
      out.push(decide({ check: 'PF_LEFT_OUT', severity: 'WARN', rule: lawOf('PF'), message: `Not a PF member, but the PF wage (${inr(pfWage)}) is within the ceiling of ${inr(ceiling)}: PF applies unless the person is an apprentice or an excluded employee. Say which.`, numbers: { pfWage, ceiling } }));
    }
    if (pfMode !== 'NONE' && pfWage > 0) for (const key of ['PF_EE', 'PF_ER']) if (!active(key)) out.push(decide({ check: 'STATUTORY_MISSING', severity: 'HARD', rule: lawOf('PF'), message: `PF applies, but the ${key === 'PF_EE' ? 'employee' : 'employer'} PF component is inactive or missing: the run would leave it out. Make it active on Payroll › Components.`, numbers: { key } }));
  }
  if (S.ESI && esiWage > 0 && esiWage <= (Number(S.ESI.wageCeiling) || 0)) {
    for (const key of ['ESI_EE', 'ESI_ER']) if (!active(key)) out.push(decide({ check: 'STATUTORY_MISSING', severity: 'HARD', rule: lawOf('ESI'), message: `ESI applies (ESI wage ${inr(esiWage)} is within ${inr(S.ESI.wageCeiling)}), but the ${key === 'ESI_EE' ? 'employee' : 'employer'} ESI component is inactive or missing.`, numbers: { key } }));
  }
  if (S.PT?.slabs?.length && gross > 0) {
    const sorted = [...S.PT.slabs].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
    const slab = sorted.find((s) => s.upTo == null || gross <= Number(s.upTo));
    if (Number(slab?.amount) > 0 && !active('PT')) out.push(decide({ check: 'STATUTORY_MISSING', severity: 'HARD', rule: lawOf('PT'), message: `Professional tax of ${inr(slab.amount)} is due on a gross of ${inr(gross)}, but the PT component is inactive or missing.`, numbers: { key: 'PT' } }));
  }
  if (S.LWF && (Number(S.LWF.employee) > 0 || Number(S.LWF.employer) > 0)) {
    for (const key of ['LWF_EE', 'LWF_ER']) if (!active(key)) out.push(decide({ check: 'STATUTORY_MISSING', severity: 'HARD', rule: lawOf('LWF'), message: `Labour welfare fund applies in this state, but the ${key === 'LWF_EE' ? 'employee' : 'employer'} LWF component is inactive or missing.`, numbers: { key } }));
  }
  return out;
}

/** Overtime rate (HARD): the policy's multiplier below the law's (OSH Code s.27 / Code on Wages s.14: twice). */
export function checkOvertimeRate({ multiplier, rule, policyName = null }) {
  if (multiplier == null || !rule) return [];
  const legal = Number(rule.value?.multiplier) || 2;
  if (Number(multiplier) + 1e-9 >= legal) return [];
  return [decide({ check: 'OT_RATE', severity: 'HARD', rule, message: `Overtime is paid at ${multiplier}×${policyName ? ` (${policyName})` : ''}; the law says at least ${legal}× the ordinary rate of wages.`, numbers: { multiplier: Number(multiplier), legal } })];
}

/**
 * The overtime hourly rate formula against wages ÷ 26 ÷ 8 (WARN): `rate` = what the payroll policy's
 * formula gives for a breakdown, `lines` = that breakdown.
 */
export function checkOvertimeBase({ rate, lines, rule }) {
  if (rate == null || !rule) return [];
  const w = wagesOf(lines);
  const ordinary = money(w.wages / 26 / (Number(rule.value?.dailyHours) || 8));
  if (Number(rate) + 0.005 >= ordinary) return [];
  return [decide({ check: 'OT_RATE_BASE', severity: 'WARN', rule, message: `The overtime hourly rate (${inr(rate)} at 1×) is below wages ÷ 26 days ÷ ${Number(rule.value?.dailyHours) || 8} hours (${inr(ordinary)}): overtime is due on the ordinary rate of wages (basic + DA).`, numbers: { rate: Number(rate), ordinary } })];
}

/**
 * Overtime hours (WARN). days: [{ date, overtimeMinutes, workedMinutes }] of one person; rateRule: OVERTIME 'rate'
 * (maxDailyWithOvertime / maxWeeklyWithOvertime when the law gives them); capRule: the quarter's cap
 * (OVERTIME rate.quarterlyCapHours, else the state's quarterly_cap.hours). quarterMinutes: overtime in the quarter.
 */
export function checkOvertimeHours({ days = [], quarterMinutes = null, quarterLabel = null, rateRule = null, capRule = null }) {
  const out = [];
  const v = rateRule?.value ?? {};
  if (v.maxDailyWithOvertime) {
    const over = days.filter((d) => (Number(d.workedMinutes) || 0) > v.maxDailyWithOvertime * 60);
    if (over.length) out.push(decide({ check: 'OT_HOURS', severity: 'WARN', rule: rateRule, message: `${over.length} day(s) with more than ${v.maxDailyWithOvertime} hours of work including overtime (${over.slice(0, 3).map((d) => d.date).join(', ')}${over.length > 3 ? ' …' : ''}).`, numbers: { limit: 'DAY', days: over.length } }));
  }
  if (v.maxWeeklyWithOvertime) {
    const weeks = new Map();
    for (const d of days) {
      const dt = new Date(`${d.date}T00:00:00Z`);
      const monday = new Date(dt); monday.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
      const k = monday.toISOString().slice(0, 10);
      weeks.set(k, (weeks.get(k) ?? 0) + (Number(d.workedMinutes) || 0));
    }
    const over = [...weeks].filter(([, m]) => m > v.maxWeeklyWithOvertime * 60);
    if (over.length) out.push(decide({ check: 'OT_HOURS', severity: 'WARN', rule: rateRule, message: `${over.length} week(s) with more than ${v.maxWeeklyWithOvertime} hours of work including overtime (weeks from ${over.slice(0, 3).map(([k]) => k).join(', ')}).`, numbers: { limit: 'WEEK', weeks: over.length } }));
  }
  const capHours = v.quarterlyCapHours ?? capRule?.value?.hours ?? null;
  const capFrom = v.quarterlyCapHours ? rateRule : capRule;
  if (capHours && quarterMinutes != null && quarterMinutes > capHours * 60) {
    out.push(decide({ check: 'OT_HOURS', severity: 'WARN', rule: capFrom, message: `${money(quarterMinutes / 60)} hours of overtime in the quarter${quarterLabel ? ` ${quarterLabel}` : ''}: the limit is ${capHours} hours.`, numbers: { limit: 'QUARTER', hours: money(quarterMinutes / 60), cap: capHours } }));
  }
  return out;
}

const ANNUAL_CODES = new Set(['EL', 'AL', 'ANNUAL', 'PRL']);
export const isAnnualLeave = (t) => ANNUAL_CODES.has(String(t?.code ?? '').toUpperCase()) || /earned|privilege|annual/i.test(String(t?.name ?? ''));

/**
 * Days of annual leave a full year's work earns at one day per `per` days worked, for a 6-day week
 * (OSH Code s.26: at most six days a week): 52 × 6 = 312 days, less 8 paid holidays (Telangana's 4 national +
 * 4 festival), less the leave days themselves (they are not days worked): the largest r with
 * floor((304 − r) / per) ≥ r. For per = 20: 14.
 */
export function annualLeaveOwed(per = 20, { workDays = 312, holidays = 8 } = {}) {
  const d = workDays - holidays;
  let r = Math.floor(d / per);
  while (r > 0 && Math.floor((d - r) / per) < r) r -= 1;
  return r;
}

/**
 * A leave policy against the annual-leave minimum (HARD when the rule is verified). policyRules:
 * [{ type: { code, name }, basis, accrual, days, daysWorkedPerLeaveDay }]. rule: LEAVE_MIN annual leave.
 */
export function checkLeavePolicy({ policyName = 'This policy', policyRules = [], rule }) {
  if (!rule) return [];
  const per = Number(rule.value?.daysWorkedPerLeaveDay) || 20;
  const owed = annualLeaveOwed(per);
  const annual = policyRules.filter((r) => isAnnualLeave(r.type));
  if (!annual.length) {
    return [decide({ check: 'LEAVE_MIN', severity: 'WARN', rule, message: `${policyName} has no annual (earned) leave with wages. Workers who work 180 days in a year earn one day for every ${per} days worked (${rule.title ?? 'the law'}). Fine for trainees or apprentices only — say who it covers.`, numbers: { owed } })];
  }
  const out = [];
  for (const r of annual) {
    const name = r.type?.name ?? r.type?.code ?? 'Annual leave';
    if (r.accrual === 'PER_DAYS_WORKED') {
      if (Number(r.daysWorkedPerLeaveDay) > per) out.push(decide({ check: 'LEAVE_MIN', severity: 'HARD', rule, message: `${name}: one day for every ${r.daysWorkedPerLeaveDay} days worked; the law gives one for every ${per} days.`, numbers: { per: Number(r.daysWorkedPerLeaveDay), legal: per } }));
    } else if (r.basis === 'PER_YEAR' && r.days != null && Number(r.days) < owed) {
      // A fixed number of days a year is not the law's measure (days worked): short only for someone who works more
      // than days × 20 days in the year — a warning, not a block.
      out.push(decide({ check: 'LEAVE_MIN', severity: 'WARN', rule, message: `${name}: ${r.days} days a year; a full year's work (6 days a week, less 8 holidays) earns ${owed} days at one day for every ${per} days worked — short for anyone who works more than ${Number(r.days) * per} days. Give it by days worked, or at least ${owed} days.`, numbers: { days: Number(r.days), owed } }));
    }
  }
  return out;
}

/** Product guidance, not law: shares that are usually a mistake (WARN). */
export const USUAL_SHARES_RULE = {
  id: null, domain: 'GUIDANCE', jurisdiction: 'IN', ruleKey: 'usual_shares', title: 'Usual shares of a salary (product guidance, not law)',
  sourceUrl: null, effectiveFrom: null, version: null, verified: false,
};
export function checkAllowanceShares({ lines }) {
  const get = (code) => (lines ?? []).filter((l) => l.code === code).reduce((s, l) => s + (Number(l.amount ?? l.monthly) || 0), 0);
  const gross = (lines ?? []).filter((l) => l.kind === 'EARNING').reduce((s, l) => s + (Number(l.amount ?? l.monthly) || 0), 0);
  const basicDa = get('BASIC') + get('DA');
  const out = [];
  const hra = get('HRA');
  if (hra > 0 && basicDa > 0 && hra > basicDa * 0.5 + 0.5) out.push(decide({ check: 'ALLOWANCE_SHARE', severity: 'WARN', rule: USUAL_SHARES_RULE, message: `HRA (${inr(hra)}) is more than half of basic + DA (${inr(basicDa)}): the HRA tax exemption stops at 50% of salary even in a metro (Income-tax Rules, rule 2A).`, numbers: { hra, basicDa } }));
  const special = get('SPECIAL');
  if (special > 0 && gross > 0 && special > gross * 0.5) out.push(decide({ check: 'ALLOWANCE_SHARE', severity: 'WARN', rule: USUAL_SHARES_RULE, message: `Special allowance (${inr(special)}) is more than half of the gross (${inr(gross)}).`, numbers: { special, gross } }));
  return out;
}

/** HARD first, then WARN, then INFO. */
export const bySeverity = (a, b) => ({ HARD: 0, WARN: 1, INFO: 2 }[a.severity] - { HARD: 0, WARN: 1, INFO: 2 }[b.severity]);
export const summarise = (results) => ({
  hard: results.filter((r) => r.severity === 'HARD').length,
  warn: results.filter((r) => r.severity === 'WARN').length,
  info: results.filter((r) => r.severity === 'INFO').length,
});

export default { ruleRef, decide, classOf, wagesOf, checkMinimumWage, checkFiftyPercent, checkStatutory, checkOvertimeRate, checkOvertimeBase, checkOvertimeHours, checkLeavePolicy, checkAllowanceShares, annualLeaveOwed, isAnnualLeave, summarise, bySeverity };
