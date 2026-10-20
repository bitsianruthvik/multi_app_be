/**
 * extras.js — what P3a / P3b add to a person's tax year, read once for a set of people (loadExtras) and put
 * into the engine's input for one person (personExtras). (TM/CF_HRMS_HIRING_SPEC.md §25.5.)
 *
 *   perquisites    the register (payrollExtras/perquisites.js perquisitesAsOf: the YEAR's value) + the employer's
 *                  contributions to PF, NPS and superannuation above the year's limit, with the accretion when
 *                  its facts are entered (tax/retirement.js; rule `retirement_contributions`)
 *   relief         a READY Form 10E / Form No. 39 worksheet of the year (hrms_tax_relief_10e): given in the TDS
 *                  (s.192(2A) / s.392(4)(a)(ii) — rule `relief_arrears` says it by year)
 *   gratuity, leave encashment   the full and final's formula amounts (hrms_pay_settlements result_json.tax),
 *                  so the engine's exemption is the least of received, the formula and the cap
 *   LTA            approved claims under the leave-travel rule within the block (hrms_pay_claims lta_exempt)
 *
 * Used by runTax.loadTaxWorld (the run's TDS, the tax sheet) and actuals.js (Form 16 / 130, Annexure II).
 */
import { perquisitesAsOf } from '../payrollExtras/perquisites.js';
import { retirementPerquisite } from '../tax/retirement.js';
import { json, n } from './common.js';

const ph = (ids) => ids.map(() => '?').join(',') || 'NULL';

export async function loadExtras(db, companyId, year, ids, rules) {
  const out = { perqs: new Map(), relief: new Map(), settlements: new Map(), lta: new Map(), facts: new Map(), rules: {} };
  if (!ids.length || !rules) return out;
  const [y1] = year.split('-').map(Number);
  out.rules.retirement = rules.NEW.has('retirement_contributions') ? rules.NEW.get('retirement_contributions') : null;
  out.rules.relief = rules.NEW.has('relief_arrears') ? rules.NEW.get('relief_arrears') : null;
  const [[relief], [sets], [lta], [facts]] = await Promise.all([
    db.query(`SELECT employee_id, relief FROM hrms_tax_relief_10e WHERE company_id = ? AND tax_year = ? AND deleted_at IS NULL AND status = 'READY' AND relief > 0 AND employee_id IN (${ph(ids)})`, [companyId, year, ...ids]),
    db.query(`SELECT employee_id, result_json FROM hrms_pay_settlements WHERE company_id = ? AND deleted_at IS NULL AND status IN ('APPROVED','PAID') AND pay_month BETWEEN ? AND ? AND employee_id IN (${ph(ids)})`, [companyId, `${y1}-04`, `${y1 + 1}-03`, ...ids]),
    db.query(`SELECT employee_id, SUM(approved_amount) AS amount FROM hrms_pay_claims c JOIN hrms_pay_claim_types t ON t.company_id = c.company_id AND t.id = c.claim_type_id
                WHERE c.company_id = ? AND c.deleted_at IS NULL AND c.tax_year = ? AND c.status IN ('APPROVED','PAID') AND c.lta_exempt = 1 AND t.tax_treatment = 'LTA'
                  AND c.employee_id IN (${ph(ids)}) GROUP BY c.employee_id`, [companyId, year, ...ids]),
    db.query(`SELECT * FROM hrms_pay_retirement_facts WHERE company_id = ? AND tax_year = ? AND deleted_at IS NULL AND employee_id IN (${ph(ids)})`, [companyId, year, ...ids]),
  ]);
  for (const r of relief) out.relief.set(r.employee_id, n(r.relief));
  for (const r of sets) { const t = json(r.result_json, {})?.tax; if (t) out.settlements.set(r.employee_id, t); }
  for (const r of lta) out.lta.set(r.employee_id, n(r.amount));
  for (const r of facts) {
    out.facts.set(r.employee_id, {
      previousExcess: r.previous_excess == null ? null : n(r.previous_excess), previousAccretion: r.previous_accretion == null ? null : n(r.previous_accretion),
      ratePct: r.rate_pct == null ? null : n(r.rate_pct), fundIncome: r.fund_income == null ? null : n(r.fund_income),
      fundOpening: r.fund_opening == null ? null : n(r.fund_opening), fundClosing: r.fund_closing == null ? null : n(r.fund_closing),
    });
  }
  try {
    out.perqs = await perquisitesAsOf(db, companyId, `${y1 + 1}-03`, ids);
  } catch { out.perqs = new Map(); }
  return out;
}

const has = (components, rule) => components.some((c) => String(c.exemptRule ?? '').toUpperCase() === rule && c.taxable !== 'NO' && n(c.amount) > 0);

/**
 * One person's extras for the engine. Writes the exemption facts into `exemptions` (gratuity, leaveEncashment,
 * lta) and returns { perquisites: [{ name, value }], relief: { amount, section, form, employerSection } | null,
 * retirement, register, warnings }.
 */
export function personExtras(world, employeeId, { contributions, components, exemptions, regime = 'NEW' }) {
  const ex = world.extras;
  const warnings = [];
  if (!ex) return { perquisites: [], relief: null, retirement: null, register: null, warnings };
  const register = ex.perqs.get(employeeId) ?? null;
  const perquisites = [...(register?.perquisites ?? [])];
  let retirement = null;
  if (ex.rules.retirement) {
    retirement = retirementPerquisite({ contributions, rule: ex.rules.retirement, facts: ex.facts.get(employeeId) ?? null });
    perquisites.push(...retirement.perquisites.map((p) => ({ name: p.name, value: p.value })));
    if (retirement.excess && retirement.rate == null) warnings.push(retirement.lines[retirement.lines.length - 1]);
  }
  const s = ex.settlements.get(employeeId);
  if (s && has(components, 'GRATUITY')) exemptions.gratuity = { formulaAmount: n(s.gratuityFormula), exemptedBefore: n(s.gratuityExemptedBefore) };
  if (s && has(components, 'LEAVE_ENCASHMENT')) exemptions.leaveEncashment = { formulaAmount: n(s.leaveFormula), exemptedBefore: n(s.leaveExemptedBefore) };
  const lta = ex.lta.get(employeeId);
  if (lta && has(components, 'LTA')) {
    exemptions.lta = { claimed: n(exemptions.lta?.claimed) + lta, journeysUsedInBlock: exemptions.lta?.journeysUsedInBlock ?? 0 };
  }
  const amount = ex.relief.get(employeeId) ?? 0;
  const R = ex.rules.relief;
  const relief = amount > 0 ? { amount, section: R?.section ?? null, form: R?.formLabel ?? null, employerSection: R?.employerSection ?? null, regime } : null;
  return { perquisites, relief, retirement, register, warnings };
}

export default { loadExtras, personExtras };
