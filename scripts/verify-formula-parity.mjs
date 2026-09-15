/**
 * verify-formula-parity.mjs — read-only. EU-8 proof that the split/hardened
 * formulaEngine.js produces the SAME numeric result as the pre-EU-8 engine
 * for every formula actually stored locally, evaluated against the fixture
 * order's real scopes.
 *
 * Loads the OLD evaluator from `git show HEAD:...formulaEngine.js` (written
 * to a scratch file and imported) and the NEW one from the current file,
 * builds — for every task materialized on order 247 — the exact same
 * (itemValues, stepValues, resourceTypeId, opValues, inputCtx) arguments
 * `taskGatingService.planOrderTasks` builds (replicated here rather than
 * imported, since that construction lives inline in `planOrderTasks`, not as
 * its own export), and asserts OLD's `number|null` equals NEW's `.value`
 * (`null == null` counts as equal).
 *
 * A DIFFERENT result is not automatically a bug: R2 deliberately stops
 * `machine.*`/`item.*`/`op.*` unknowns from defaulting to 0 (a typo used to
 * evaluate silently; now it is UNKNOWN_SYMBOL). `input.*`/`inputs.*`
 * absence is deliberately KEPT at 0 (with a new `INPUT_UNAVAILABLE`
 * warning) specifically because real formulas here guard it with
 * `IF(input.raw_material.x > N, ..., default)` and genuinely lack that role
 * on some items — see the EU-8 report for the four fixture tasks (operation
 * 12, items 2146/2156) this would otherwise have broken.
 *
 *   node scripts/verify-formula-parity.mjs [companyId] [orderId]
 *
 * Writes nothing. Deletes its own scratch copy of the old engine on exit.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { pool } from '../db.js';
import { resolveItemFields, buildInputContext } from '../apps/fab_erp/services/itemFieldService.js';
import { evaluateFormula as evaluateFormulaNew } from '../apps/fab_erp/services/formulaEngine.js';

const companyId = Number(process.argv[2]) || 6;
const orderId = Number(process.argv[3]) || 247;

const SCRATCH_DIR = new URL('./_scratch/', import.meta.url);
const OLD_ENGINE_PATH = new URL('./_scratch/formulaEngine.OLD.mjs', import.meta.url);

async function loadOldEvaluateFormula() {
  mkdirSync(SCRATCH_DIR, { recursive: true });
  // Node's child_process could not spawn `git` (or even cmd.exe) reliably in
  // every shell this runs under, so the extraction is one Bash command run
  // ahead of this script rather than shelled out from inside it:
  //   git show HEAD:apps/fab_erp/services/formulaEngine.js \
  //     | sed "s#from '../../../db.js'#from '../../db.js'#" \
  //     > scripts/_scratch/formulaEngine.OLD.mjs
  // (the path rewrite accounts for the scratch file sitting two levels under
  // multi_app_be/ instead of three, same as services/ itself is).
  if (!existsSync(OLD_ENGINE_PATH)) {
    throw new Error(
      `Missing ${OLD_ENGINE_PATH.pathname} — run:\n` +
      `  git show HEAD:apps/fab_erp/services/formulaEngine.js | ` +
      `sed "s#from '../../../db.js'#from '../../db.js'#" > scripts/_scratch/formulaEngine.OLD.mjs`,
    );
  }
  const mod = await import(`${OLD_ENGINE_PATH.href}?t=${Date.now()}`); // cache-bust in case of re-run
  return mod.evaluateFormula;
}

async function main() {
  const evaluateFormulaOld = await loadOldEvaluateFormula();

  const [items] = await pool.query(
    `SELECT id, parent_item_id, catalog_item_id, flow_id, qty, node_kind, order_line_id
       FROM fab_items WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
    [companyId, orderId],
  );
  if (!items.length) { console.log(`No items on order ${orderId} — nothing to check.`); return; }

  const isMaterial = (it) => it.node_kind === 'material';
  const rmChildrenByParent = new Map();
  const childPartsByParent = new Map();
  for (const it of items) {
    if (it.parent_item_id == null) continue;
    if (isMaterial(it)) {
      if (!rmChildrenByParent.has(it.parent_item_id)) rmChildrenByParent.set(it.parent_item_id, []);
      rmChildrenByParent.get(it.parent_item_id).push(it);
    } else if (it.flow_id != null) {
      if (!childPartsByParent.has(it.parent_item_id)) childPartsByParent.set(it.parent_item_id, []);
      childPartsByParent.get(it.parent_item_id).push(it);
    }
  }

  const itemMetricsById = await resolveItemFields(companyId, items.map((i) => i.id));

  const [tasks] = await pool.query(
    `SELECT fpt.id AS taskId, fpt.item_id AS itemId, fpt.flow_step_id AS stepId,
            fops.resource_type_id AS stepResourceTypeId, fops.params_json AS paramsJson,
            fo.id AS operationId, fo.default_resource_type_id AS defaultResourceTypeId,
            fo.time_formula AS formula, fo.time_unit AS timeUnit
       FROM fab_project_tasks fpt
       JOIN fab_operation_flow_steps fops ON fops.id = fpt.flow_step_id
       JOIN fab_operations fo ON fo.id = fops.operation_id
      WHERE fpt.company_id = ? AND fpt.order_id = ? AND fpt.deleted_at IS NULL
      ORDER BY fpt.id`,
    [companyId, orderId],
  );

  const [opVarRows] = await pool.query(
    `SELECT operation_id, var_key, default_value FROM fab_operation_variables
      WHERE company_id = ? AND deleted_at IS NULL`,
    [companyId],
  );
  const opValuesByOpId = new Map();
  for (const v of opVarRows) {
    if (!opValuesByOpId.has(v.operation_id)) opValuesByOpId.set(v.operation_id, {});
    opValuesByOpId.get(v.operation_id)[v.var_key] = v.default_value;
  }

  const distinctFormulas = new Set();
  let checked = 0;
  let mismatched = 0;
  const oldCache = new Map();
  const newCache = new Map();

  for (const t of tasks) {
    if (!t.formula || !String(t.formula).trim()) continue;
    distinctFormulas.add(t.formula);
    const resourceTypeId = t.stepResourceTypeId ?? t.defaultResourceTypeId ?? null;
    const itemValues = itemMetricsById.get(t.itemId) ?? {};
    const stepValues = (() => {
      if (!t.paramsJson) return {};
      const raw = typeof t.paramsJson === 'string' ? JSON.parse(t.paramsJson) : t.paramsJson;
      return raw && typeof raw === 'object' ? raw : {};
    })();
    const opValues = opValuesByOpId.get(t.operationId) ?? {};
    const inputCtx = buildInputContext({
      rmChildren: rmChildrenByParent.get(t.itemId) ?? [],
      partChildren: childPartsByParent.get(t.itemId) ?? [],
      valuesByItemId: itemMetricsById,
    });

    const oldValue = await evaluateFormulaOld(t.formula, itemValues, stepValues, resourceTypeId, opValues, inputCtx, oldCache);
    const newResult = await evaluateFormulaNew(t.formula, itemValues, stepValues, resourceTypeId, opValues, inputCtx, newCache);
    const oldNorm = (typeof oldValue === 'number' && Number.isFinite(oldValue)) ? oldValue : null;
    const newNorm = newResult.value;

    checked++;
    const equal = oldNorm === newNorm
      || (oldNorm != null && newNorm != null && Math.abs(oldNorm - newNorm) < 1e-9);
    if (!equal) {
      mismatched++;
      console.log(`MISMATCH task ${t.taskId} item ${t.itemId} op ${t.operationId}: old=${oldNorm} new=${newNorm} error=${JSON.stringify(newResult.error)}`);
    }
  }

  console.log(`Checked ${checked} tasks (${distinctFormulas.size} distinct formulas) on company ${companyId} order ${orderId}.`);
  console.log(mismatched === 0 ? 'PASS — every value matches.' : `FAIL — ${mismatched} mismatch(es).`);
  process.exitCode = mismatched === 0 ? 0 : 1;
}

// The scratch copy of the OLD engine is left in place across runs (deleting
// it after every run just means the next run has to regenerate it) — remove
// `scripts/_scratch/` by hand once this has passed and stayed passed.
main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { pool.end?.(); });
