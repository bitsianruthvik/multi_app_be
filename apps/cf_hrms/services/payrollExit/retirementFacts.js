/**
 * retirementFacts.js — the employer's contributions to PF, NPS and superannuation against the year's limit, per
 * person (the projection's own figures), and the facts HR types for the accretion (rule 3B / rule 16 of the 2026
 * Rules): the excess and accretion of the years before, the fund's rate of income. hrms_pay_retirement_facts.
 */
import { HrmsError } from '../../lib/errors.js';
import { audit, bad, n, yearMonths, loadRules } from '../payrollTax/common.js';
import { loadTaxWorld, personTax } from '../payrollTax/runTax.js';
import { readAmount, text, today } from '../payroll/common.js';
import { auditSalaryRead } from '../payroll/payrollService.js';

const shape = (r) => (r ? {
  previousExcess: r.previous_excess == null ? null : n(r.previous_excess), previousAccretion: r.previous_accretion == null ? null : n(r.previous_accretion),
  ratePct: r.rate_pct == null ? null : n(r.rate_pct), fundIncome: r.fund_income == null ? null : n(r.fund_income),
  fundOpening: r.fund_opening == null ? null : n(r.fund_opening), fundClosing: r.fund_closing == null ? null : n(r.fund_closing), note: r.note ?? null,
} : null);

/** GET /tax/:year/retirement — everybody paid or salaried this year: contributions, excess, accretion, facts. Audited. */
export async function listRetirement(db, c, year, requestId = null) {
  const { rules, reason } = await loadRules(db, year);
  if (!rules?.NEW.has('retirement_contributions')) return { year, rule: null, rulesMissing: reason ?? 'The rule retirement_contributions is not seeded.', people: [] };
  const months = yearMonths(year);
  const t = today().slice(0, 7);
  const month = t < months[0] ? months[0] : t > months[11] ? months[11] : t;
  const [emps] = await db.query(
    `SELECT DISTINCT e.id, e.employee_code, e.full_name FROM hrms_employees e JOIN hrms_pay_salaries s ON s.company_id = e.company_id AND s.employee_id = e.id AND s.deleted_at IS NULL
      WHERE e.company_id = ? AND e.deleted_at IS NULL AND (e.exit_date IS NULL OR e.exit_date >= ?) ORDER BY e.full_name`, [c.companyId, `${months[0]}-01`]);
  const world = await loadTaxWorld(db, c.companyId, month, emps.map((e) => e.id));
  const [facts] = await db.query('SELECT * FROM hrms_pay_retirement_facts WHERE company_id = ? AND tax_year = ? AND deleted_at IS NULL', [c.companyId, year]);
  const factOf = new Map(facts.map((r) => [r.employee_id, shape(r)]));
  const people = [];
  for (const e of emps) {
    const tx = await personTax(world, e.id).catch(() => null);
    const r = tx?.retirement;
    if (!r?.total && !factOf.has(e.id)) continue;
    people.push({ employee: { id: e.id, code: e.employee_code, name: e.full_name }, total: r?.total ?? 0, excess: r?.excess ?? 0, accretion: r?.accretion ?? 0, lines: r?.lines ?? [], facts: factOf.get(e.id) ?? null });
  }
  people.sort((a, b) => b.total - a.total);
  if (people.length) await auditSalaryRead(db, c, people.map((p) => p.employee.id), `retirement contributions ${year}`, requestId);
  const rule = rules.NEW.get('retirement_contributions');
  const src = rules.NEW.source('retirement_contributions');
  return { year, asOf: month, rule: { ...rule, source: src.note, url: src.url, verified: src.verified }, people, overLimit: people.filter((p) => p.excess > 0).length };
}

/** PUT /tax/:year/retirement/:employeeId { previousExcess?, previousAccretion?, ratePct?, fundIncome?, fundOpening?, fundClosing?, note? } — null clears. */
export async function putFacts(db, c, year, employeeId, body = {}, requestId = null) {
  const [[e]] = await db.query('SELECT id FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, employeeId]);
  if (!e) throw new HrmsError(404, 'NOT_FOUND', 'That employee not found.');
  const problems = [];
  const amt = (k, label) => (body[k] === undefined || body[k] === null || body[k] === '' ? null : readAmount(body[k], label, problems));
  const f = {
    previousExcess: amt('previousExcess', 'Excess of earlier years'), previousAccretion: amt('previousAccretion', 'Accretion taxed in earlier years'),
    fundIncome: amt('fundIncome', 'Fund income of the year'), fundOpening: amt('fundOpening', 'Opening balance'), fundClosing: amt('fundClosing', 'Closing balance'),
    ratePct: body.ratePct === undefined || body.ratePct === null || body.ratePct === '' ? null : Number(body.ratePct), note: text(body.note, 500),
  };
  if (f.ratePct != null && (!Number.isFinite(f.ratePct) || f.ratePct < 0 || f.ratePct > 50)) problems.push('Rate: a percentage from 0 to 50.');
  if (problems.length) throw bad('The facts cannot be saved yet.', problems);
  const [[old]] = await db.query('SELECT * FROM hrms_pay_retirement_facts WHERE company_id = ? AND employee_id = ? AND tax_year = ? AND deleted_at IS NULL', [c.companyId, employeeId, year]);
  const cols = [f.previousExcess, f.previousAccretion, f.ratePct, f.fundIncome, f.fundOpening, f.fundClosing, f.note];
  if (old) await db.query('UPDATE hrms_pay_retirement_facts SET previous_excess = ?, previous_accretion = ?, rate_pct = ?, fund_income = ?, fund_opening = ?, fund_closing = ?, note = ? WHERE id = ?', [...cols, old.id]);
  else await db.query('INSERT INTO hrms_pay_retirement_facts (company_id, employee_id, tax_year, previous_excess, previous_accretion, rate_pct, fund_income, fund_opening, fund_closing, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [c.companyId, employeeId, year, ...cols, c.userId]);
  await audit(db, c, 'hrms_pay_retirement_facts', old?.id ?? 0, old ? 'UPDATE' : 'CREATE', shape(old), f, requestId);
  return { facts: f };
}

export default { listRetirement, putFacts };
