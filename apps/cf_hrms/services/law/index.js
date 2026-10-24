/**
 * services/law — THE LAW LAYER (TM/CF_HRMS_HIRING_SPEC.md §36.1, C1; models/init.sql §37).
 *
 * The law is product-level data: one copy for every company, versioned, published by the product
 * team. A company reads it and makes its CHOICES within it (company.js). Payroll reads PF / ESI /
 * PT / LWF from here (statutory.js), by the PERSON's state (personLaw.js), and every calculation
 * stores the versions it used (pin.js, runSnapshot) so a month can be recomputed exactly.
 *
 * ── THE API (for the platform console, the watcher, notifications and the reviewer — C4/C5) ──
 *
 * A VERSION (law or tax) is:
 *   { id,                     number for a law rule; 'tax:<id>' for a tax rule
 *     kind: 'LAW' | 'TAX',
 *     domain,                 PF ESI PT LWF MIN_WAGE BONUS GRATUITY OVERTIME WAGES LEAVE_MIN | TAX
 *     jurisdiction,           'IN' or a state code ('TG' …); TAX is always 'IN'
 *     ruleKey,                'settings' (PF/ESI/PT/LWF), 'ALL_EMPLOYMENTS' (MIN_WAGE), 'rates', 'cap' …
 *     title, value,           value = the rule's JSON (shapes: payroll/statutory.js, minWage.js, lawData.js)
 *     effectiveFrom, effectiveTo,   'YYYY-MM-DD'; effectiveTo null = until the next effectiveFrom
 *                                   (TAX: the tax year's 1 April … 31 March)
 *     version, status,        status DRAFT | PUBLISHED | SUPERSEDED
 *     sourceUrl, sourceNote, note, verified (boolean), reviewedBy, publishedAt, reviewBy, supersedesId,
 *     taxYear?, regime?, taxId? }   (TAX only)
 *
 *   listRules(db, { domain?, jurisdiction?, ruleKey?, status?, taxYear?, includeTax? = true })
 *       → [version]  every version, any status (drafts included), newest first per rule.
 *   rulesInForce(companyId, on, db = pool)
 *       → [version]  the PUBLISHED versions that apply to the company on `on`: national + the
 *                    company's state + every state its locations are in, and the tax year's rules.
 *   draftVersion(db, input, actor)
 *       input: { domain, jurisdiction, ruleKey, value, effectiveFrom, effectiveTo?, title?, sourceUrl?,
 *                sourceNote?, note?, verified?, reviewBy? }   — or for TAX { domain: 'TAX', taxYear, regime,
 *                ruleKey, value, … } — or { fromId, …changes } to start from an existing version.
 *       → the DRAFT version. (updateDraft / discardDraft change or drop a draft; nothing else is editable.)
 *   publishVersion(db, ref, reviewer)
 *       ref: a version id, 'tax:<id>', { ruleId } / { versionId }, or { draft: input } (draft + publish).
 *       Checks the value and runs value.examples (validate.js); the earlier PUBLISHED version of the
 *       same rule and date becomes SUPERSEDED; stamps reviewedBy / publishedAt; fires onPublish.
 *       → the PUBLISHED version. 409 PUBLISHED_IS_FINAL when it is not a draft; 422 INVALID with problems.
 *   actor / reviewer: { kind: 'PLATFORM', userId, name } (must be a live platform_admins row) or
 *       { kind: 'SCRIPT', name } (seed / migration scripts). Anything with a companyId → 403 LAW_IS_PRODUCT.
 *   onPublish(fn) → unsubscribe()    fn(version) is awaited after every publish; a throwing listener
 *       is logged and never undoes the publish (it is already written in the caller's transaction).
 *   runSnapshot(db, companyId, runId) → { law: [ids], tax: [ids], calculatedAt } | null
 *       the versions a payroll calculation used (hrms_pay_runs.law_versions_json).
 *   reproduceRun(db, c, runId) → { runId, same, differences: [...], used, pinned }
 *       recomputes the run with exactly those versions, in a savepoint that is rolled back; compares
 *       every person's lines with the stored ones. Writes nothing.
 *
 * Also: statutoryFromLaw (payroll), minimumWageOn / employmentsOf (minWage.js), lawPlacesOf
 * (personLaw.js), company choices / notes / location and role law (company.js).
 */
import { pool } from '../../lib/db.js';
import { HrmsError } from '../../lib/errors.js';
import * as STORE from './store.js';
import { companyStates } from './personLaw.js';
import { withLawContext, usedOf } from './pin.js';

export const { listRules, draftVersion, updateDraft, discardDraft, publishVersion, onPublish, getVersion, lawInForce } = STORE;
export { statutoryFromLaw } from './statutory.js';
export { minimumWageOn, minimumWageFrom, employmentsOf } from './minWage.js';
export { lawPlacesOf, statesOf, companyStates } from './personLaw.js';
export { withLawContext, currentLaw, usedOf } from './pin.js';

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const taxYearOf = (on) => { const y = Number(on.slice(0, 4)); const s = Number(on.slice(5, 7)) >= 4 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };

export async function rulesInForce(companyId, on = today(), db = pool) {
  const states = companyId ? await companyStates(db, companyId) : [];
  const law = await STORE.lawInForce(db, { jurisdictions: ['IN', ...states], on });
  const tax = await STORE.listRules(db, { domain: 'TAX', taxYear: taxYearOf(on), status: 'PUBLISHED' });
  return [...law, ...tax];
}

const json = (v, d = null) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };

export async function runSnapshot(db, companyId, runId) {
  const [[r]] = await db.query('SELECT law_versions_json, calculated_at FROM hrms_pay_runs WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, runId]);
  if (!r) return null;
  const s = json(r.law_versions_json, null);
  if (!s) return null;
  return { law: s.law ?? [], tax: s.tax ?? [], calculatedAt: s.calculatedAt ?? (r.calculated_at ? String(r.calculated_at) : null) };
}

/**
 * Recomputes a run with exactly the law and tax versions it stored, and says whether every person's
 * lines come out the same. Runs calculateRun inside a SAVEPOINT on the caller's connection (which must
 * be in a transaction) and rolls back to it: nothing is written. A locked run is recomputed as if open.
 */
export async function reproduceRun(db, c, runId) {
  const snap = await runSnapshot(db, c.companyId, runId);
  if (!snap) throw new HrmsError(409, 'NO_SNAPSHOT', 'This run was calculated before the law layer kept the versions it used. Calculate it again (if it is open) to keep them.');
  const { calculateRun } = await import('../payroll/runService.js');
  const linesOf = async () => {
    const [rows] = await db.query(
      `SELECT p.employee_id, k.code, l.amount, l.for_month FROM hrms_pay_run_lines l JOIN hrms_pay_run_people p ON p.id = l.run_person_id
        LEFT JOIN hrms_pay_components k ON k.company_id = l.company_id AND k.id = l.component_id
        WHERE l.company_id = ? AND l.run_id = ? AND l.deleted_at IS NULL AND p.deleted_at IS NULL ORDER BY p.employee_id, k.code, l.for_month`, [c.companyId, runId]);
    return rows.map((r) => `${r.employee_id}|${r.code}|${r.for_month ?? ''}|${Number(r.amount).toFixed(2)}`);
  };
  const before = await linesOf();
  await db.query('SAVEPOINT law_reproduce');
  let after; let used;
  try {
    await db.query("UPDATE hrms_pay_runs SET status = 'CALCULATED' WHERE company_id = ? AND id = ?", [c.companyId, runId]);
    used = await withLawContext(snap, async (store) => { await calculateRun(db, c, runId, null); return usedOf(store); });
    after = await linesOf();
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT law_reproduce');
  }
  const a = new Set(before);
  const b = new Set(after);
  const differences = [...before.filter((x) => !b.has(x)).map((x) => `stored ${x}`), ...after.filter((x) => !a.has(x)).map((x) => `recomputed ${x}`)];
  return { runId, same: differences.length === 0, differences: differences.slice(0, 50), lines: before.length, pinned: snap, used };
}

export default { listRules, rulesInForce, draftVersion, updateDraft, discardDraft, publishVersion, onPublish, runSnapshot, reproduceRun, getVersion, lawInForce, taxYearOf };
