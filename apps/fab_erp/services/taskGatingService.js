/**
 * taskGatingService.js
 * --------------------
 * Shared, connection-based core for materializing tasks and clearing them to
 * 'eligible'. Every function takes an explicit mysql connection so the exact
 * same logic runs inside the app (via a pool connection, wrapped by
 * taskInstanceService / taskEngineService) and in one-off maintenance scripts
 * (via their own connection).
 *
 * The model (2026-07-20 remodel): a fab_project_tasks row clears from 'blocked'
 * to 'eligible' only when BOTH hold:
 *   1. process predecessors are done  (intra-item flow deps — depends_on / prev)
 *   2. every gated input is satisfied (fab_task_inputs, gate=1):
 *        - raw_material / consumable → stock present  (SUM(fab_stock_pieces.qty) > 0)
 *        - component                 → the producing fab_items node's terminal
 *                                       task is done (cross-item dependency)
 *
 * Backward-compatible: tasks with no fab_task_inputs rows behave exactly as
 * before (predecessor-only gating), so other tenants/flows are unaffected.
 */

import { pool } from '../../../db.js';
import { evaluateFormula } from './formulaEngine.js';
import { recordEvent, recordEvents } from './taskEventService.js';
import { resolveNextInputBuffer, loadOf, statusFor } from './bufferService.js';
import { getUsableStat } from './operationStatsService.js';

/** Best-effort machine name for a resource id (falls back to "#<id>"). */
async function resourceName(exec, companyId, resourceId) {
  if (!resourceId) return null;
  try {
    const [[r]] = await exec.query(
      `SELECT name FROM fab_resources WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [resourceId, companyId],
    );
    return r?.name || `#${resourceId}`;
  } catch {
    return `#${resourceId}`;
  }
}

/**
 * Output-blocked check (EU-8, Locked Decision 4). A task is output-blocked ONLY
 * when BOTH sides are simultaneously full:
 *   (a) the successor machine's INPUT buffer is at/over its block_pct, AND
 *   (b) this task's OWN machine's OUTPUT buffer is at/over its block_pct.
 * If either buffer is absent (not configured), the machine is NEVER blocking —
 * buffers are opt-in, so the common no-buffer case always returns blocked:false.
 *
 * @param {number} companyId
 * @param {object} task  needs at least `id` (+ assigned_resource_id if known;
 *                       resolveNextInputBuffer re-reads item/flow/seq as needed).
 * @param {import('mysql2/promise').Connection} [conn]
 * @returns {Promise<{blocked:boolean, reason?:string}>}
 */
export async function isOutputBlocked(companyId, task, conn) {
  const exec = conn ?? pool;

  // (a) successor machine's input buffer — no next input buffer ⇒ never blocking.
  const nextBuf = await resolveNextInputBuffer(companyId, task, conn);
  if (!nextBuf) return { blocked: false };
  const nextLoad = await loadOf(companyId, nextBuf.id, conn);
  if (statusFor(nextLoad.pct, nextLoad.warnPct, nextLoad.blockPct) !== 'block') {
    return { blocked: false };
  }

  // (b) this task's OWN output buffer — no output buffer ⇒ never blocking.
  let assignedResourceId = task.assigned_resource_id;
  if (assignedResourceId === undefined) {
    const [[t]] = await exec.query(
      `SELECT assigned_resource_id FROM fab_project_tasks
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [task.id, companyId],
    );
    assignedResourceId = t?.assigned_resource_id ?? null;
  }
  if (!assignedResourceId) return { blocked: false };
  const [[ownBuf]] = await exec.query(
    `SELECT id FROM fab_buffers
      WHERE company_id = ? AND resource_id = ? AND kind = 'output'
        AND active = 1 AND deleted_at IS NULL LIMIT 1`,
    [companyId, assignedResourceId],
  );
  if (!ownBuf) return { blocked: false };
  const ownLoad = await loadOf(companyId, ownBuf.id, conn);
  if (statusFor(ownLoad.pct, ownLoad.warnPct, ownLoad.blockPct) !== 'block') {
    return { blocked: false };
  }

  // Both sides full — genuinely blocked. Build a best-effort human reason.
  const nextName = await resourceName(exec, companyId, nextBuf.resource_id);
  const thisName = await resourceName(exec, companyId, assignedResourceId);
  return {
    blocked: true,
    reason: `blocked because ${nextName} input buffer is full and ${thisName} output staging is full`,
  };
}

export function parseDependsOn(csv) {
  if (csv === null || csv === undefined) return [];
  const str = String(csv).trim();
  if (str === '') return [];
  return str.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n));
}

/** True when every process predecessor of `task` (in its own item+flow) is done. */
export async function processPredecessorsDone(conn, companyId, task) {
  const [siblings] = await conn.query(
    `SELECT seq_no, status FROM fab_project_tasks
      WHERE company_id = ? AND item_id = ? AND flow_id = ? AND deleted_at IS NULL`,
    [companyId, task.item_id, task.flow_id],
  );
  const statusBySeq = new Map(siblings.map((r) => [r.seq_no, r.status]));
  const seqNos = siblings.map((r) => r.seq_no).sort((a, b) => a - b);

  const deps = parseDependsOn(task.depends_on);
  let preds;
  if (deps.length > 0) {
    preds = deps;
  } else {
    let prev = null;
    for (const s of seqNos) if (s < task.seq_no && (prev === null || s > prev)) prev = s;
    if (prev === null) return true; // first step — no process predecessor
    preds = [prev];
  }
  return preds.every((sn) => statusBySeq.get(sn) === 'done');
}

/** The item's last step (max seq_no) is done ⇒ the whole item is produced. */
export async function terminalTaskDone(conn, companyId, itemId) {
  const [r] = await conn.query(
    `SELECT status FROM fab_project_tasks
      WHERE company_id = ? AND item_id = ? AND deleted_at IS NULL
      ORDER BY seq_no DESC LIMIT 1`,
    [companyId, itemId],
  );
  return r.length > 0 && r[0].status === 'done';
}

/** Live check of a single gated input row. */
async function inputSatisfiedLive(conn, companyId, input) {
  if (input.input_role === 'component' && input.producing_item_id) {
    return terminalTaskDone(conn, companyId, input.producing_item_id);
  }
  if (input.ref_catalog_item_id) {
    const [r] = await conn.query(
      `SELECT COALESCE(SUM(qty), 0) AS q FROM fab_stock_pieces
        WHERE company_id = ? AND catalog_item_id = ? AND status = 'in_stock' AND deleted_at IS NULL`,
      [companyId, input.ref_catalog_item_id],
    );
    return Number(r[0].q) > 0; // presence gate (stock in pcs, demand in kg — see remodel notes)
  }
  return true;
}

/** True when all gate=1 inputs for the task are satisfied; stamps satisfied_at as it goes. */
export async function taskInputsSatisfied(conn, companyId, taskId) {
  const [inputs] = await conn.query(
    `SELECT * FROM fab_task_inputs
      WHERE company_id = ? AND task_id = ? AND gate = 1 AND deleted_at IS NULL`,
    [companyId, taskId],
  );
  for (const inp of inputs) {
    if (inp.satisfied_at) continue;
    if (!(await inputSatisfiedLive(conn, companyId, inp))) return false;
    await conn.query('UPDATE fab_task_inputs SET satisfied_at = NOW() WHERE id = ?', [inp.id]);
  }
  // Every gate=1 input is now satisfied — fire once per task, not per input row.
  if (inputs.length > 0) {
    await recordEvent({ companyId, taskId, type: 'materials_ready', source: 'system' });
  }
  return true;
}

/** Try to flip a single blocked task to eligible. Returns true if it flipped. */
export async function tryClearTask(conn, companyId, taskId) {
  const [rows] = await conn.query(
    `SELECT id, item_id, flow_id, seq_no, depends_on, status
       FROM fab_project_tasks WHERE company_id = ? AND id = ? AND deleted_at IS NULL`,
    [companyId, taskId],
  );
  if (!rows.length) return false;
  const t = rows[0];
  if (t.status !== 'blocked') return false;
  if (!(await processPredecessorsDone(conn, companyId, t))) return false;
  if (!(await taskInputsSatisfied(conn, companyId, taskId))) return false;
  const [u] = await conn.query(
    `UPDATE fab_project_tasks
        SET status = 'eligible', deps_cleared_at = NOW(), queued_at = NOW()
      WHERE id = ? AND status = 'blocked' AND deleted_at IS NULL`,
    [taskId],
  );
  const cleared = u.affectedRows > 0;
  if (cleared) {
    await recordEvents([
      { companyId, taskId, type: 'deps_cleared', source: 'system' },
      { companyId, taskId, type: 'queued', source: 'system' },
    ]);
  }
  return cleared;
}

/**
 * Re-evaluate tasks gated on newly-received stock (called after a GRN posts).
 * Returns the ids of tasks that flipped to 'eligible'.
 */
export async function reevaluateStockGatedTasks(conn, companyId, catalogItemIds) {
  const ids = [...new Set((catalogItemIds || []).filter((n) => Number.isInteger(n)))];
  if (!ids.length) return [];
  const [tasks] = await conn.query(
    `SELECT DISTINCT task_id FROM fab_task_inputs
      WHERE company_id = ? AND gate = 1 AND satisfied_at IS NULL
        AND ref_catalog_item_id IN (?) AND deleted_at IS NULL`,
    [companyId, ids],
  );
  const cleared = [];
  for (const t of tasks) if (await tryClearTask(conn, companyId, t.task_id)) cleared.push(t.task_id);
  return cleared;
}

/**
 * Materialize all tasks + task-inputs for an order (transaction owned by caller).
 * Mirrors the legacy materializeTasks flow resolution (item.flow_id first, else
 * default-BOM→binding), then additionally writes fab_task_inputs from each
 * step's fab_operation_flow_step_inputs and gates first-step eligibility.
 */
export async function materializeOrderTasks(conn, companyId, orderId) {
  const [items] = await conn.query(
    `SELECT id, parent_item_id, catalog_item_id, flow_id
       FROM fab_items WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
    [companyId, orderId],
  );
  if (items.length === 0) return { ok: true, itemsProcessed: 0, itemsSkipped: 0, tasksInserted: 0 };

  const catalogItemIds = [...new Set(items.filter((i) => i.catalog_item_id != null).map((i) => i.catalog_item_id))];

  // legacy fallback: default BOM per catalog item → active flow binding
  let bomIdByCatalogItemId = new Map();
  let bomIds = [];
  if (catalogItemIds.length) {
    const [bomRows] = await conn.query(
      `SELECT id AS bom_id, catalog_item_id FROM fab_material_boms
        WHERE company_id = ? AND is_default = 1 AND deleted_at IS NULL AND catalog_item_id IN (?)`,
      [companyId, catalogItemIds],
    );
    bomIdByCatalogItemId = new Map(bomRows.map((r) => [r.catalog_item_id, r.bom_id]));
    bomIds = [...new Set(bomRows.map((r) => r.bom_id))];
  }
  let flowIdByBomId = new Map();
  if (bomIds.length) {
    const [bindingRows] = await conn.query(
      `SELECT bom_id, flow_id FROM fab_bom_flow_bindings
        WHERE company_id = ? AND active = 1 AND deleted_at IS NULL AND bom_id IN (?)`,
      [companyId, bomIds],
    );
    flowIdByBomId = new Map(bindingRows.map((r) => [r.bom_id, r.flow_id]));
  }

  // resolve each item's flow
  const flowOf = (item) => {
    if (item.flow_id != null) return item.flow_id;
    const bomId = bomIdByCatalogItemId.get(item.catalog_item_id);
    return bomId != null ? flowIdByBomId.get(bomId) : undefined;
  };

  const flowIds = [...new Set(items.map(flowOf).filter((f) => f != null))];
  const stepsByFlowId = new Map();
  let allStepIds = [];
  if (flowIds.length) {
    const [stepRows] = await conn.query(
      `SELECT id, flow_id, operation_id, seq_no, depends_on, resource_type_id
         FROM fab_operation_flow_steps
        WHERE company_id = ? AND deleted_at IS NULL AND flow_id IN (?) ORDER BY flow_id, seq_no`,
      [companyId, flowIds],
    );
    for (const s of stepRows) {
      if (!stepsByFlowId.has(s.flow_id)) stepsByFlowId.set(s.flow_id, []);
      stepsByFlowId.get(s.flow_id).push(s);
      allStepIds.push(s.id);
    }
  }

  // step inputs, keyed by flow_step_id
  const inputsByStepId = new Map();
  if (allStepIds.length) {
    const [inRows] = await conn.query(
      `SELECT flow_step_id, input_role, ref_catalog_item_id, ref_bom_role, qty, unit, gate
         FROM fab_operation_flow_step_inputs
        WHERE company_id = ? AND deleted_at IS NULL AND flow_step_id IN (?)`,
      [companyId, allStepIds],
    );
    for (const r of inRows) {
      if (!inputsByStepId.has(r.flow_step_id)) inputsByStepId.set(r.flow_step_id, []);
      inputsByStepId.get(r.flow_step_id).push(r);
    }
  }

  // operations + variables
  const operationIds = [...new Set([...stepsByFlowId.values()].flat().map((s) => s.operation_id))];
  const opById = new Map();
  const opVarsByOpId = new Map();
  if (operationIds.length) {
    const [opRows] = await conn.query(
      `SELECT id, default_resource_type_id, time_formula FROM fab_operations
        WHERE company_id = ? AND deleted_at IS NULL AND id IN (?)`,
      [companyId, operationIds],
    );
    for (const op of opRows) opById.set(op.id, op);
    const [varRows] = await conn.query(
      `SELECT operation_id, var_key, default_value FROM fab_operation_variables
        WHERE company_id = ? AND deleted_at IS NULL AND operation_id IN (?)`,
      [companyId, operationIds],
    );
    for (const v of varRows) {
      if (!opVarsByOpId.has(v.operation_id)) opVarsByOpId.set(v.operation_id, {});
      opVarsByOpId.get(v.operation_id)[v.var_key] = v.default_value;
    }
  }

  // child parts (flow-bound children) per parent item — for 'child_parts' inputs
  const childPartsByParent = new Map();
  for (const it of items) {
    if (it.parent_item_id == null) continue;
    if (it.flow_id == null) continue; // only flow-bearing children count as parts
    if (!childPartsByParent.has(it.parent_item_id)) childPartsByParent.set(it.parent_item_id, []);
    childPartsByParent.get(it.parent_item_id).push(it);
  }
  // raw-material child (catalog-bearing child) per parent item — for 'raw_material' inputs
  const rmChildByParent = new Map();
  for (const it of items) {
    if (it.parent_item_id == null || it.catalog_item_id == null) continue;
    if (!rmChildByParent.has(it.parent_item_id)) rmChildByParent.set(it.parent_item_id, it);
  }

  // idempotency: skip already-materialized (item_id, flow_id)
  const [existingRows] = await conn.query(
    `SELECT DISTINCT item_id, flow_id FROM fab_project_tasks
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
    [companyId, orderId],
  );
  const existingCombos = new Set(existingRows.map((r) => `${r.item_id}:${r.flow_id}`));

  let itemsProcessed = 0, itemsSkipped = 0, tasksInserted = 0;
  const insertedTaskIds = [];

  for (const item of items) {
    const flowId = flowOf(item);
    const steps = flowId != null ? stepsByFlowId.get(flowId) : undefined;
    if (!flowId || !steps || !steps.length) { itemsSkipped++; continue; }
    if (existingCombos.has(`${item.id}:${flowId}`)) { itemsSkipped++; continue; }

    for (const step of steps) {
      const op = opById.get(step.operation_id);
      const resourceTypeId = step.resource_type_id ?? op?.default_resource_type_id ?? null;
      const opValues = opVarsByOpId.get(step.operation_id) ?? {};
      const formulaHours = op
        ? await evaluateFormula(op.time_formula, {}, {}, resourceTypeId, opValues)
        : null;

      // EU-15: prefer the learned p80 touch-time (converted to hours) as the
      // planning estimate when enough real samples exist; keep the formula's
      // value in formula_hours for comparison. No usable stat → computed_hours
      // stays the formula value and formula_hours is left NULL (no distinct
      // learned value to preserve).
      const stat = await getUsableStat(companyId, step.operation_id, resourceTypeId);
      const learnedHours = stat && stat.p80_minutes != null ? Number(stat.p80_minutes) / 60 : null;
      const computedHours = learnedHours != null ? learnedHours : formulaHours;
      const preservedFormulaHours = learnedHours != null ? formulaHours : null;

      // insert task as 'blocked' first; clear at the end once inputs exist
      const [ins] = await conn.query(
        `INSERT INTO fab_project_tasks
           (company_id, order_id, item_id, flow_id, flow_step_id, operation_id,
            seq_no, depends_on, resource_type_id, status, computed_hours, formula_hours)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'blocked', ?, ?)`,
        [companyId, orderId, item.id, flowId, step.id, step.operation_id,
         step.seq_no, step.depends_on, resourceTypeId, computedHours, preservedFormulaHours],
      );
      const taskId = ins.insertId;
      tasksInserted++;
      insertedTaskIds.push({ taskId, seq_no: step.seq_no, hasDeps: !!(step.depends_on && String(step.depends_on).trim()) });

      // materialize inputs for this step
      const stepInputs = inputsByStepId.get(step.id) ?? [];
      for (const si of stepInputs) {
        if (si.ref_bom_role === 'raw_material') {
          const rm = rmChildByParent.get(item.id);
          const refItem = rm ? rm.catalog_item_id : item.catalog_item_id;
          if (refItem == null) continue;
          await conn.query(
            `INSERT INTO fab_task_inputs (company_id, task_id, order_id, input_role, ref_catalog_item_id, qty, unit, gate)
             VALUES (?, ?, ?, 'raw_material', ?, ?, ?, ?)`,
            [companyId, taskId, orderId, refItem, rm ? rm.qty ?? null : null, si.unit ?? null, si.gate],
          );
        } else if (si.ref_bom_role === 'child_parts') {
          const kids = childPartsByParent.get(item.id) ?? [];
          for (const kid of kids) {
            await conn.query(
              `INSERT INTO fab_task_inputs (company_id, task_id, order_id, input_role, producing_item_id, gate)
               VALUES (?, ?, ?, 'component', ?, ?)`,
              [companyId, taskId, orderId, kid.id, si.gate],
            );
          }
        } else if (si.ref_catalog_item_id != null) {
          await conn.query(
            `INSERT INTO fab_task_inputs (company_id, task_id, order_id, input_role, ref_catalog_item_id, qty, unit, gate)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [companyId, taskId, orderId, si.input_role, si.ref_catalog_item_id, si.qty ?? null, si.unit ?? null, si.gate],
          );
        }
      }
    }
    itemsProcessed++;
  }

  // clear first steps whose inputs are already available
  let cleared = 0;
  for (const { taskId } of insertedTaskIds) {
    if (await tryClearTask(conn, companyId, taskId)) cleared++;
  }

  return { ok: true, itemsProcessed, itemsSkipped, tasksInserted, cleared };
}
