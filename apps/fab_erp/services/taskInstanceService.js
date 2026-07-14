/**
 * taskInstanceService.js
 * -----------------------
 * EU-5: Task instantiation service for fab_erp.
 *
 * Exported function:
 *   materializeTasks(companyId, projectId)
 *
 * For every fab_items instance belonging to the project whose catalog item
 * has a BOM with an active flow binding, insert one fab_project_tasks row
 * per (fab_items instance x flow step) — no dedup/batching across identical
 * sibling instances; each instance gets its own independent set of task rows.
 *
 * BOM linkage (read from actual schema/code, see mrpService.js §6 "Default
 * BOM snapshot" for the established precedent in this codebase):
 *   fab_items has NO bom_id column — it only carries catalog_item_id. There
 *   is no per-item mechanism recording which specific fab_material_boms row
 *   produced/applies to a given fab_items instance. mrpService.js resolves
 *   "the" BOM for a catalog_item_id via `fab_material_boms.is_default = 1`,
 *   and this service follows the same precedent: for each fab_items instance,
 *   resolve its BOM as the row in fab_material_boms with
 *   catalog_item_id = fab_items.catalog_item_id AND is_default = 1, then look
 *   up an active fab_bom_flow_bindings row for that bom_id to get the flow_id.
 *   If a catalog_item_id has no default BOM, or the default BOM has no active
 *   binding, that fab_items instance is skipped (no tasks materialized for it).
 *
 * Idempotency: before inserting, existing (item_id, flow_id) task combinations
 * for the project are loaded and skipped — materializeTasks can be re-run
 * safely without creating duplicate task rows.
 *
 * computed_hours: derived via formulaEngine.evaluateFormula(operation.time_formula,
 * itemValues={}, stepValues={}, resourceTypeId, opValues) where opValues is
 * built from that operation's fab_operation_variables (var_key -> default_value).
 * There is no per-project variable binding mechanism yet (future phase), so
 * default_value is used as-is for every instance.
 *
 * Eligibility: a flow step is 'eligible' (with deps_cleared_at = NOW()) iff its
 * depends_on is empty/NULL AND its seq_no is the minimum seq_no for that flow
 * (i.e. it is the first step, with no prior step at all). Every other step
 * starts 'blocked'.
 */

import { pool } from '../../../db.js';
import { evaluateFormula } from './formulaEngine.js';

/**
 * @param {number} companyId
 * @param {number} projectId
 * @returns {Promise<{ ok: boolean, itemsProcessed: number, itemsSkipped: number, tasksInserted: number }>}
 */
export async function materializeTasks(companyId, projectId) {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // ── 1. fab_items instances for this project ─────────────────────────────
    const [items] = await conn.query(
      `SELECT id, catalog_item_id
         FROM fab_items
        WHERE company_id = ? AND project_id = ? AND deleted_at IS NULL
          AND catalog_item_id IS NOT NULL`,
      [companyId, projectId],
    );

    if (items.length === 0) {
      await conn.commit();
      return { ok: true, itemsProcessed: 0, itemsSkipped: 0, tasksInserted: 0 };
    }

    const catalogItemIds = [...new Set(items.map((i) => i.catalog_item_id))];

    // ── 2. Default BOM per catalog_item_id ───────────────────────────────────
    const [bomRows] = await conn.query(
      `SELECT id AS bom_id, catalog_item_id
         FROM fab_material_boms
        WHERE company_id = ? AND is_default = 1 AND deleted_at IS NULL
          AND catalog_item_id IN (?)`,
      [companyId, catalogItemIds],
    );
    const bomIdByCatalogItemId = new Map(bomRows.map((r) => [r.catalog_item_id, r.bom_id]));
    const bomIds = [...new Set(bomRows.map((r) => r.bom_id))];

    // ── 3. Active flow binding per bom_id ────────────────────────────────────
    let flowIdByBomId = new Map();
    if (bomIds.length > 0) {
      const [bindingRows] = await conn.query(
        `SELECT bom_id, flow_id
           FROM fab_bom_flow_bindings
          WHERE company_id = ? AND active = 1 AND deleted_at IS NULL
            AND bom_id IN (?)`,
        [companyId, bomIds],
      );
      flowIdByBomId = new Map(bindingRows.map((r) => [r.bom_id, r.flow_id]));
    }

    // ── 4. Flow steps per flow_id ─────────────────────────────────────────────
    const flowIds = [...new Set([...flowIdByBomId.values()])];
    const stepsByFlowId = new Map();
    if (flowIds.length > 0) {
      const [stepRows] = await conn.query(
        `SELECT id, flow_id, operation_id, seq_no, depends_on, resource_type_id
           FROM fab_operation_flow_steps
          WHERE company_id = ? AND deleted_at IS NULL AND flow_id IN (?)
          ORDER BY flow_id, seq_no`,
        [companyId, flowIds],
      );
      for (const step of stepRows) {
        if (!stepsByFlowId.has(step.flow_id)) stepsByFlowId.set(step.flow_id, []);
        stepsByFlowId.get(step.flow_id).push(step);
      }
    }

    // ── 5. Operations + their variables, for every operation_id referenced ───
    const operationIds = [
      ...new Set([...stepsByFlowId.values()].flat().map((s) => s.operation_id)),
    ];
    const opById = new Map();
    const opVarsByOpId = new Map();
    if (operationIds.length > 0) {
      const [opRows] = await conn.query(
        `SELECT id, default_resource_type_id, time_formula
           FROM fab_operations
          WHERE company_id = ? AND deleted_at IS NULL AND id IN (?)`,
        [companyId, operationIds],
      );
      for (const op of opRows) opById.set(op.id, op);

      const [varRows] = await conn.query(
        `SELECT operation_id, var_key, default_value
           FROM fab_operation_variables
          WHERE company_id = ? AND deleted_at IS NULL AND operation_id IN (?)`,
        [companyId, operationIds],
      );
      for (const v of varRows) {
        if (!opVarsByOpId.has(v.operation_id)) opVarsByOpId.set(v.operation_id, {});
        opVarsByOpId.get(v.operation_id)[v.var_key] = v.default_value;
      }
    }

    // ── 6. Existing (item_id, flow_id) task combinations — idempotency guard ─
    const [existingRows] = await conn.query(
      `SELECT DISTINCT item_id, flow_id
         FROM fab_project_tasks
        WHERE company_id = ? AND project_id = ? AND deleted_at IS NULL`,
      [companyId, projectId],
    );
    const existingCombos = new Set(existingRows.map((r) => `${r.item_id}:${r.flow_id}`));

    // ── 7. Build + insert task rows ───────────────────────────────────────────
    let itemsProcessed = 0;
    let itemsSkipped = 0;
    let tasksInserted = 0;

    for (const item of items) {
      const bomId = bomIdByCatalogItemId.get(item.catalog_item_id);
      const flowId = bomId != null ? flowIdByBomId.get(bomId) : undefined;
      const steps = flowId != null ? stepsByFlowId.get(flowId) : undefined;

      if (!flowId || !steps || steps.length === 0) {
        itemsSkipped++;
        continue;
      }

      const comboKey = `${item.id}:${flowId}`;
      if (existingCombos.has(comboKey)) {
        itemsSkipped++;
        continue;
      }

      const minSeqNo = Math.min(...steps.map((s) => s.seq_no));

      for (const step of steps) {
        const op = opById.get(step.operation_id);
        const resourceTypeId = step.resource_type_id ?? op?.default_resource_type_id ?? null;
        const opValues = opVarsByOpId.get(step.operation_id) ?? {};

        const computedHours = op
          ? await evaluateFormula(op.time_formula, {}, {}, resourceTypeId, opValues)
          : null;

        const hasDeps = step.depends_on !== null && String(step.depends_on).trim() !== '';
        const isFirstStep = step.seq_no === minSeqNo;
        const status = !hasDeps && isFirstStep ? 'eligible' : 'blocked';
        const depsClearedAt = status === 'eligible' ? new Date() : null;

        await conn.query(
          `INSERT INTO fab_project_tasks
             (company_id, project_id, item_id, flow_id, flow_step_id, operation_id,
              seq_no, depends_on, resource_type_id, status, deps_cleared_at, computed_hours)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            companyId,
            projectId,
            item.id,
            flowId,
            step.id,
            step.operation_id,
            step.seq_no,
            step.depends_on,
            resourceTypeId,
            status,
            depsClearedAt,
            computedHours,
          ],
        );

        tasksInserted++;
      }

      itemsProcessed++;
    }

    await conn.commit();

    return { ok: true, itemsProcessed, itemsSkipped, tasksInserted };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
