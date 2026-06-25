/**
 * plannedOpService.js
 * -------------------
 * EU-D1: Planned-operation generation service for fab_erp.
 *
 * Exported function:
 *   generatePlannedOperations(companyId, { projectId, itemId })
 *
 * Generation flow:
 *   1. Load the fab_item and resolve its manufacturing_method_template_id.
 *   2. Approval-gate the manufacturing method template via isVersionConsumable.
 *   3. Load fab_manufacturing_method_lines for that template (ordered by seq_no).
 *   4. For each line that carries a routing_template_id:
 *        a. Approval-gate the routing template.
 *        b. Load its fab_routing_template_steps (ordered by seq_no).
 *   5. Build the item variable context from fab_item_metric_values.
 *   6. For each routing step (in order, across all lines):
 *        a. If formula_id is set: load expression_text from fab_formulas, call
 *           evaluateFormula() to obtain planned_hours.
 *        b. If no formula_id: planned_hours = 0 (documented below).
 *   7. Inside a single transaction:
 *        a. Soft-delete (set deleted_at = NOW()) any existing fab_planned_operations
 *           for this item+project+company — makes regeneration idempotent.
 *        b. Insert one fab_planned_operations row per routing step.
 *   8. Return { count, plannedOperationIds }.
 *
 * planned_hours when no formula_id:
 *   Set to 0 rather than NULL so that downstream scheduling code always has a
 *   numeric value to sum. A zero signals "duration not yet estimated" without
 *   causing NULL-propagation problems in aggregate queries.
 *
 * Resource-type metrics in variableContext:
 *   fab_resource_type_metrics holds DEFINITIONS (metric_key labels) for a
 *   resource type, not per-resource numeric values. There is no table in this
 *   schema that stores numeric values keyed to a resource_type_id, so only
 *   item metric values are injected into variableContext. The formulaEngine
 *   itself resolves fab_constants and system (shift-calendar) values internally,
 *   so those are also available to every formula without any extra work here.
 *   If resource-type numeric values are added in a future schema migration,
 *   extend the variableContext building block in step 5 of this function.
 *
 * Regeneration idempotency:
 *   Existing planned_operations rows are soft-deleted (deleted_at = NOW())
 *   rather than hard-deleted so that audit history and any foreign-key
 *   references (e.g. fab_resource_assignments) are preserved.
 */

import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import { evaluateFormula } from './formulaEngine.js';
import { isVersionConsumable } from './versionService.js';

// ---------------------------------------------------------------------------
// generatePlannedOperations
// ---------------------------------------------------------------------------

/**
 * @param {number} companyId
 * @param {{ projectId: number, itemId: number }} params
 * @returns {Promise<{ count: number, plannedOperationIds: number[] }>}
 */
export async function generatePlannedOperations(companyId, { projectId, itemId }) {
  // ── 1. Load the item ───────────────────────────────────────────────────────
  const [itemRows] = await pool.query(
    `SELECT id, name, manufacturing_method_template_id
       FROM fab_items
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL
      LIMIT 1`,
    [itemId, companyId],
  );

  if (!itemRows.length) {
    const err = new Error(`Item not found (id=${itemId}, company=${companyId})`);
    err.statusCode = 404;
    throw err;
  }

  const item = itemRows[0];
  const mfgMethodTemplateId = item.manufacturing_method_template_id;

  if (!mfgMethodTemplateId) {
    const err = new Error(
      `Item (id=${itemId}) has no manufacturing_method_template_id assigned. ` +
      `Assign an approved manufacturing method template to the item before generating planned operations.`,
    );
    err.statusCode = 422;
    throw err;
  }

  // ── 2. Approval gate: manufacturing method template ────────────────────────
  const mfgMethodOk = await isVersionConsumable(
    'manufacturing_method_templates',
    mfgMethodTemplateId,
    companyId,
  );
  if (!mfgMethodOk) {
    const err = new Error('Manufacturing method template is not approved');
    err.code = 'NOT_APPROVED';
    err.statusCode = 422;
    throw err;
  }

  // ── 3. Load manufacturing method lines ────────────────────────────────────
  const [mfgLines] = await pool.query(
    `SELECT id, seq_no, routing_template_id, process_template_id
       FROM fab_manufacturing_method_lines
      WHERE mfg_method_template_id = ?
        AND company_id = ?
        AND deleted_at IS NULL
      ORDER BY seq_no ASC`,
    [mfgMethodTemplateId, companyId],
  );

  // ── 4. Collect routing steps across all lines (in order) ──────────────────
  // Each line may reference a routing_template_id. We walk lines in seq_no
  // order and accumulate steps from each routing template in seq_no order.
  const allSteps = []; // { id, name, resource_type_id, formula_id, routingTemplateId }

  for (const line of mfgLines) {
    if (!line.routing_template_id) {
      // Line has no routing template (e.g. process_template_id only, or empty).
      // Skip silently — no planned operations are generated from such lines.
      continue;
    }

    // Approval gate: routing template
    const routingOk = await isVersionConsumable(
      'routing_templates',
      line.routing_template_id,
      companyId,
    );
    if (!routingOk) {
      const err = new Error(
        `Routing template (id=${line.routing_template_id}) referenced by ` +
        `manufacturing method line (seq_no=${line.seq_no}) is not approved`,
      );
      err.code = 'NOT_APPROVED';
      err.statusCode = 422;
      throw err;
    }

    // Load routing steps
    const [steps] = await pool.query(
      `SELECT id, seq_no, name, resource_type_id, formula_id
         FROM fab_routing_template_steps
        WHERE routing_template_id = ?
          AND company_id = ?
          AND deleted_at IS NULL
        ORDER BY seq_no ASC`,
      [line.routing_template_id, companyId],
    );

    for (const step of steps) {
      allSteps.push({ ...step, routingTemplateId: line.routing_template_id });
    }
  }

  // ── 5. Build item variable context ────────────────────────────────────────
  // Load numeric metric values stored against this item.
  // fab_constants and system (shift-calendar) values are resolved internally
  // by evaluateFormula, so we do not need to supply them here.
  const [metricRows] = await pool.query(
    `SELECT metric_key, metric_value
       FROM fab_item_metric_values
      WHERE item_id = ?
        AND company_id = ?
        AND deleted_at IS NULL`,
    [itemId, companyId],
  );

  const variableContext = {};
  for (const row of metricRows) {
    variableContext[row.metric_key] = Number(row.metric_value);
  }

  // ── 6. Evaluate formulas and prepare insert rows ───────────────────────────
  const insertRows = []; // { resource_type_id, seq_no, name, planned_hours, source_routing_step_id }

  for (let i = 0; i < allSteps.length; i++) {
    const step = allSteps[i];
    const globalSeqNo = i + 1; // 1-based, sequential across the whole generation

    let planned_hours = 0;

    if (step.formula_id) {
      // Load the formula expression
      const [formulaRows] = await pool.query(
        `SELECT expression_text
           FROM fab_formulas
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL
          LIMIT 1`,
        [step.formula_id, companyId],
      );

      if (!formulaRows.length) {
        const err = new Error(
          `Formula (id=${step.formula_id}) referenced by routing step ` +
          `"${step.name}" (id=${step.id}) was not found or is deleted.`,
        );
        err.statusCode = 422;
        throw err;
      }

      const { expression_text } = formulaRows[0];

      try {
        planned_hours = await evaluateFormula(companyId, expression_text, variableContext);
      } catch (evalErr) {
        // Surface a clear error that names the step so the caller knows which
        // step's formula failed (e.g. missing variable values in context).
        const err = new Error(
          `Formula evaluation failed for routing step "${step.name}" (id=${step.id}, ` +
          `formula_id=${step.formula_id}): ${evalErr.message}`,
        );
        err.statusCode = 422;
        throw err;
      }
    }
    // If no formula_id: planned_hours stays 0 (see module-level doc comment).

    insertRows.push({
      resource_type_id: step.resource_type_id ?? null,
      seq_no: globalSeqNo,
      name: step.name,
      planned_hours,
      source_routing_step_id: step.id,
    });
  }

  // ── 7. Transaction: soft-delete existing rows, then bulk-insert ────────────
  const conn = await pool.getConnection();
  const plannedOperationIds = [];

  try {
    await conn.beginTransaction();

    // Soft-delete existing planned operations for this item+project+company.
    // Using soft-delete (deleted_at = NOW()) rather than hard-delete to preserve
    // audit history and avoid breaking any fab_resource_assignments FK references.
    await conn.query(
      `UPDATE fab_planned_operations
          SET deleted_at = NOW()
        WHERE item_id = ?
          AND project_id = ?
          AND company_id = ?
          AND deleted_at IS NULL`,
      [itemId, projectId, companyId],
    );

    // Insert new planned operation rows one-by-one to capture each insertId.
    for (const row of insertRows) {
      const [result] = await conn.query(
        `INSERT INTO fab_planned_operations
           (company_id, project_id, item_id, resource_type_id, seq_no, name,
            planned_hours, status, source_routing_step_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?)`,
        [
          companyId,
          projectId,
          itemId,
          row.resource_type_id,
          row.seq_no,
          row.name,
          row.planned_hours,
          row.source_routing_step_id,
        ],
      );
      plannedOperationIds.push(result.insertId);
    }

    await conn.commit();
  } catch (txErr) {
    await conn.rollback();
    logger.error({ txErr, companyId, projectId, itemId }, 'plannedOpService: transaction failed');
    throw txErr;
  } finally {
    conn.release();
  }

  logger.info(
    { companyId, projectId, itemId, count: plannedOperationIds.length },
    'plannedOpService: planned operations generated',
  );

  return { count: plannedOperationIds.length, plannedOperationIds };
}
