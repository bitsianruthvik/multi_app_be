/**
 * policy.js — the company's payroll choices that are not law (TM/CF_HRMS_HIRING_SPEC.md §25.5, §28.6):
 *
 *   overtimeRateFormula   what ONE HOUR of overtime pays at 1×           default (BASIC + DA) / 26 / 8
 *   encashRateFormula     what ONE DAY of leave encashed on leaving pays  default BASIC / 26
 *   noticeRateFormula     what ONE DAY of notice pay is (recovery or payout) default GROSS / 30
 *   flexiYearEnd          an unclaimed flexible-benefit balance at the year end: PAY_TAXABLE (paid in the
 *                         March run, taxed) | LAPSE                       default PAY_TAXABLE
 *   claimsManagerFirst    a claim goes to the person's manager for a first look before HR  default yes
 *
 * The formulas are the salary-structure language (services/payroll/formula.js: numbers, %, of, + − × ÷,
 * min, max, round), parsed, never eval'd. Their names: any component code of the company (its MONTHLY
 * amount in the person's salary on the day; 0 when the salary has no such line), GROSS (the month's
 * earnings of the salary, monthly components only), CTC (monthly), CTC_ANNUAL.
 * One row a company (hrms_pay_policy, init.sql §32); none = the defaults.
 */
import { parse, refsOf, evaluate, FormulaError, money } from '../payroll/formula.js';
import { audit, bad, text, stamp } from '../payroll/common.js';

export const DEFAULTS = Object.freeze({
  overtimeRateFormula: '(BASIC + DA) / 26 / 8',
  encashRateFormula: 'BASIC / 26',
  noticeRateFormula: 'GROSS / 30',
  flexiYearEnd: 'PAY_TAXABLE',
  claimsManagerFirst: true,
});
export const FLEXI_YEAR_END = ['PAY_TAXABLE', 'LAPSE'];
export const EXTRA_NAMES = ['GROSS', 'CTC', 'CTC_ANNUAL'];

export async function policyOf(db, companyId) {
  const [[r]] = await db.query('SELECT * FROM hrms_pay_policy WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  return {
    overtimeRateFormula: r?.overtime_rate_formula ?? DEFAULTS.overtimeRateFormula,
    encashRateFormula: r?.encash_rate_formula ?? DEFAULTS.encashRateFormula,
    noticeRateFormula: r?.notice_rate_formula ?? DEFAULTS.noticeRateFormula,
    flexiYearEnd: r?.flexi_year_end ?? DEFAULTS.flexiYearEnd,
    claimsManagerFirst: r ? Boolean(r.claims_manager_first) : DEFAULTS.claimsManagerFirst,
    defaults: DEFAULTS, updatedAt: stamp(r?.updated_at),
  };
}

/** Problems of a formula: it parses, and uses only the company's codes and GROSS / CTC / CTC_ANNUAL. */
export function formulaProblems(formula, codes, label) {
  try {
    const refs = refsOf(parse(formula));
    const unknown = refs.filter((x) => !codes.has(x) && !EXTRA_NAMES.includes(x));
    return unknown.length ? [`${label}: ${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a component code of the company, nor GROSS, CTC or CTC_ANNUAL.`] : [];
  } catch (e) {
    return [`${label}: ${e instanceof FormulaError ? e.message : 'it cannot be read.'}`];
  }
}

/** PUT /payroll/policy */
export async function putPolicy(db, c, body = {}, requestId = null) {
  const before = await policyOf(db, c.companyId);
  const [comps] = await db.query('SELECT code FROM hrms_pay_components WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  const codes = new Set(comps.map((k) => String(k.code).toUpperCase()));
  const problems = [];
  const next = { ...before };
  for (const [key, label] of [['overtimeRateFormula', 'Overtime, an hour'], ['encashRateFormula', 'Leave encashment, a day'], ['noticeRateFormula', 'Notice pay, a day']]) {
    if (body[key] === undefined) continue;
    const f = text(body[key], 300);
    if (!f) { next[key] = DEFAULTS[key]; continue; }
    problems.push(...formulaProblems(f, codes, label));
    next[key] = f;
  }
  if (body.flexiYearEnd !== undefined) {
    const v = String(body.flexiYearEnd ?? '').toUpperCase();
    if (!FLEXI_YEAR_END.includes(v)) problems.push('Unclaimed flexible balance: PAY_TAXABLE (paid in March, taxed) or LAPSE.');
    next.flexiYearEnd = v;
  }
  if (body.claimsManagerFirst !== undefined) next.claimsManagerFirst = Boolean(body.claimsManagerFirst);
  if (problems.length) throw bad('The payroll policy cannot be saved yet.', problems);
  const keep = (k) => (next[k] === DEFAULTS[k] ? null : next[k]);
  const [[row]] = await db.query('SELECT id FROM hrms_pay_policy WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  const cols = [keep('overtimeRateFormula'), keep('encashRateFormula'), keep('noticeRateFormula'), next.flexiYearEnd, next.claimsManagerFirst ? 1 : 0];
  if (row) await db.query('UPDATE hrms_pay_policy SET overtime_rate_formula = ?, encash_rate_formula = ?, notice_rate_formula = ?, flexi_year_end = ?, claims_manager_first = ? WHERE id = ?', [...cols, row.id]);
  else await db.query('INSERT INTO hrms_pay_policy (company_id, overtime_rate_formula, encash_rate_formula, notice_rate_formula, flexi_year_end, claims_manager_first, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)', [c.companyId, ...cols, c.userId]);
  const { defaults, updatedAt, ...b } = before;
  const after = await policyOf(db, c.companyId);
  const { defaults: d2, updatedAt: u2, ...a } = after;
  await audit(db, c, 'hrms_pay_policy', row?.id ?? 0, row ? 'UPDATE' : 'CREATE', b, a, requestId);
  return { policy: after };
}

/**
 * The names a policy formula reads, from a salary's breakdown lines ({ code, kind, frequency, statutoryKey, monthly }):
 * every company code (0 when not in the salary), GROSS, CTC, CTC_ANNUAL.
 */
export function formulaValues(lines, allCodes, { annualCtc = 0 } = {}) {
  const values = Object.fromEntries([...allCodes].map((code) => [String(code).toUpperCase(), 0]));
  let gross = 0;
  for (const l of lines ?? []) {
    values[String(l.code).toUpperCase()] = Number(l.monthly) || 0;
    if (l.kind === 'EARNING' && !l.statutoryKey && (l.frequency ?? 'MONTHLY') === 'MONTHLY') gross += Number(l.monthly) || 0;
  }
  values.GROSS = money(gross);
  values.CTC = money((Number(annualCtc) || 0) / 12);
  values.CTC_ANNUAL = money(Number(annualCtc) || 0);
  return values;
}

/** A policy formula's value: { ok, value (to paise), text } or { ok: false, problem }. */
export function rateOf(formula, values) {
  try {
    const v = evaluate(parse(formula), values);
    return { ok: true, value: money(v), text: formula };
  } catch (e) {
    return { ok: false, value: 0, problem: e instanceof FormulaError ? e.message : 'The formula cannot be worked out.', text: formula };
  }
}

export default { policyOf, putPolicy, formulaValues, rateOf, formulaProblems, DEFAULTS, FLEXI_YEAR_END };
