/**
 * impact.js — what a published law change touches in ONE company (spec §36.4): people, salary
 * structures, leave policies. Simple counts from the company's own data, said in words.
 *
 *   PF / ESI / BONUS / GRATUITY / OVERTIME / WAGES / TAX   everyone with a salary on the date
 *   PT / LWF / MIN_WAGE                                     those whose salary is in that state
 *   LEAVE_MIN                                               the active leave policies (and the people)
 * A state rule (jurisdiction ≠ IN) touches only people whose salary row is in that state; the
 * company's rules in force (law layer, rulesInForce) say whether the company works there at all.
 *
 * C2 (checks and fix proposals, spec §36.2–36.3) adds its proposals here through
 * registerImpactExtension(fn): fn(db, companyId, change, impact) → [{ title, kind, … }]. They are kept
 * on the notification (impact.proposals) and shown with it. Nothing is changed in the company.
 */
import { rulesInForce } from './lawAdapter.js';

const extensions = new Set();
/** C2's hook: a proposer of fixes for a change. Returns an unregister function. */
export function registerImpactExtension(fn) { extensions.add(fn); return () => extensions.delete(fn); }

const STATUTORY_KEY = { PF: 'PF%', ESI: 'ESI%', PT: 'PT%', LWF: 'LWF%' };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * @param change { domain, jurisdiction, ruleKey, effectiveFrom }
 * @returns { affected, people, structures, policies, lines: [string], inForce: number, proposals: [] }
 */
export async function computeImpact(db, companyId, change) {
  const on = change.effectiveFrom;
  const domain = String(change.domain || '').toUpperCase();
  const state = change.jurisdiction && change.jurisdiction !== 'IN' ? change.jurisdiction : null;
  const lines = [];

  // People with a salary on the date (in the state, for a state rule).
  const [[p]] = await db.query(
    `SELECT COUNT(DISTINCT s.employee_id) AS n FROM hrms_pay_salaries s
       JOIN hrms_employees e ON e.company_id = s.company_id AND e.id = s.employee_id AND e.deleted_at IS NULL AND e.employment_status IN ('ACTIVE', 'NOTICE')
      WHERE s.company_id = ? AND s.deleted_at IS NULL AND s.effective_from <= ? AND (s.effective_to IS NULL OR s.effective_to >= ?)
        ${state ? "AND COALESCE(NULLIF(s.state_code, ''), (SELECT ps.state_code FROM hrms_pay_settings ps WHERE ps.company_id = s.company_id AND ps.deleted_at IS NULL), 'TG') = ?" : ''}`, // a salary without its own state is in the company's payroll state
    state ? [companyId, on, on, state] : [companyId, on, on]);
  let people = Number(p.n);

  // Structures: those with a component of the rule's kind, else every active one.
  let structures = 0;
  if (domain !== 'LEAVE_MIN') {
    const key = STATUTORY_KEY[domain];
    const [[s]] = await db.query(
      key ? `SELECT COUNT(DISTINCT st.id) AS n FROM hrms_pay_structures st
               JOIN hrms_pay_structure_lines l ON l.company_id = st.company_id AND l.structure_id = st.id AND l.deleted_at IS NULL
               JOIN hrms_pay_components k ON k.company_id = l.company_id AND k.id = l.component_id AND k.statutory_key LIKE ?
              WHERE st.company_id = ? AND st.deleted_at IS NULL AND st.status = 'ACTIVE'`
        : "SELECT COUNT(*) AS n FROM hrms_pay_structures WHERE company_id = ? AND deleted_at IS NULL AND status = 'ACTIVE'",
      key ? [key, companyId] : [companyId]);
    structures = Number(s.n);
    // PF / ESI / PT are often added by the run rather than a structure line: then every active structure counts.
    if (key && !structures && people) {
      const [[all]] = await db.query("SELECT COUNT(*) AS n FROM hrms_pay_structures WHERE company_id = ? AND deleted_at IS NULL AND status = 'ACTIVE'", [companyId]);
      structures = Number(all.n);
    }
  }

  let policies = 0;
  if (domain === 'LEAVE_MIN') {
    const [[lp]] = await db.query("SELECT COUNT(*) AS n FROM hrms_leave_policies WHERE company_id = ? AND deleted_at IS NULL AND status = 'ACTIVE'", [companyId]);
    policies = Number(lp.n);
    const [[e]] = await db.query("SELECT COUNT(*) AS n FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL AND employment_status IN ('ACTIVE', 'NOTICE')", [companyId]);
    people = Number(e.n);
  }

  let inForce = 0;
  try {
    const rules = await rulesInForce(companyId, on, db);
    inForce = rules.filter((r) => r.domain === domain && (!state || r.jurisdiction === state)).length;
  } catch { /* the rules are context; the counts stand without them */ }

  const where = state ? ` in ${state}` : '';
  if (people) lines.push(`${plural(people, 'person', 'people')} with a salary${where} on ${on}.`);
  if (structures) lines.push(`${plural(structures, 'salary structure')} to look at.`);
  if (policies) lines.push(`${plural(policies, 'leave policy', 'leave policies')} to check against the new minimum.`);
  if (!people && !structures && !policies) lines.push(state ? `Nobody here is paid in ${state} today — nothing to change unless that is wrong.` : 'Nothing in this company’s data is touched today.');

  const impact = { affected: people + structures + policies > 0, people, structures, policies, lines, inForce, proposals: [] };
  for (const fn of extensions) {
    try { impact.proposals.push(...((await fn(db, companyId, change, impact)) ?? [])); } catch { /* a proposer that fails leaves the notification as it is */ }
  }
  return impact;
}

export default { computeImpact, registerImpactExtension };
