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
import { logger } from '../../../core/utils/logger.js';
import { evaluateFormula, formulaResultToHours, parseStepParams } from './formulaEngine.js';
import { recordEvent, recordEvents } from './taskEventService.js';
import { resolveNextInputBuffer, loadOf, statusFor } from './bufferService.js';
import { resolveItemFields, buildInputContext } from './itemFieldService.js';

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

/**
 * On-hand quantity of a catalog item: SUM of in_stock pieces.
 *
 * Until 2026-08-05 this subtracted active reservations to give a FREE quantity.
 * Reservations are gone (see the note below inputSatisfiedLive); the table held
 * zero rows, so the subtraction was always of zero and this is the same number.
 */
async function availableQty(conn, companyId, catalogItemId) {
  const [r] = await conn.query(
    `SELECT COALESCE(SUM(qty), 0) AS q FROM fab_stock_pieces
      WHERE company_id = ? AND catalog_item_id = ? AND status = 'in_stock' AND deleted_at IS NULL`,
    [companyId, catalogItemId],
  );
  return Number(r[0].q) || 0;
}

/**
 * Live check of a single gated input row.
 * BUG-02: a quantity-aware gate — when the input declares a required qty, compare
 * available ≥ required in the SAME unit (kg↔pcs conversion is deferred until a
 * per-item factor exists). With no declared qty, fall back to a presence check.
 */
async function inputSatisfiedLive(conn, companyId, input) {
  const required = Number(input.qty) > 0 ? Number(input.qty) : 0;

  if (input.input_role === 'component' && input.producing_item_id) {
    // The producing node must be finished AND (if a qty is declared) enough of it
    // must actually be on hand — completion no longer implies infinite supply.
    if (!(await terminalTaskDone(conn, companyId, input.producing_item_id))) return false;
    if (required > 0) {
      const [child] = await conn.query(
        `SELECT catalog_item_id FROM fab_items WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
        [input.producing_item_id, companyId],
      );
      const catId = child[0]?.catalog_item_id;
      if (catId) return (await availableQty(conn, companyId, catId)) + 1e-9 >= required;
    }
    return true;
  }

  if (input.ref_catalog_item_id) {
    const avail = await availableQty(conn, companyId, input.ref_catalog_item_id);
    return required > 0 ? avail + 1e-9 >= required : avail > 0;
  }
  return true;
}

/*
 * Stock reservations (FEAT-02) were removed 2026-08-05 along with the rest of the
 * out-of-spec features. inputCatalogItemId / reserveTaskInputs /
 * releaseTaskReservations lived here and earmarked a task's gated material once
 * its gate cleared, so a second task could not clear against the same stock.
 *
 * The table held zero rows in production, so availableQty was always subtracting
 * zero and removal is behaviourally identical. Worth knowing what was given up:
 * two tasks needing the same plate can now both clear their material gate, and
 * whichever starts second finds the stock already consumed. That is acceptable
 * while material is issued at start and the shop runs a handful of projects; it
 * would not be if the queue ever ran deep enough for gate-to-start latency to
 * matter.
 */

/**
 * WHAT is holding a set of blocked tasks up, in one grouped query.
 *
 * The distinction matters because the two kinds of blocker behave completely
 * differently when planning:
 *
 *   component  an unsatisfied gate naming a PRODUCING ITEM. This is another
 *              task's output, so `buildEdges` already models it as a DAG edge
 *              and the planner's own gate reasons about it — plan the producer
 *              first and this becomes placeable after it.
 *   material   an unsatisfied gate naming a CATALOG ITEM. Steel off the shelf.
 *              There is no task to plan first, so nothing about placing work
 *              can make it available, and the DAG gate cannot see it at all.
 *
 * One definition, because three callers ask this question — the planner's
 * backlog, the planner's placement gate, and the shift log's task picker — and
 * three copies of "what does blocked mean" is three chances to disagree about
 * whether a job can be scheduled.
 *
 * Reads `satisfied_at IS NULL` rather than re-checking live stock: that stamp is
 * what the gate sweep maintains and what `tryClearTask` acts on, so anything
 * else here would answer a different question from the one the engine answers.
 *
 * @param {number[]} taskIds
 * @returns {Promise<Map<number, {material: number, component: number}>>}
 *          Tasks absent from the map have no outstanding gate.
 */
export async function outstandingGatesFor(companyId, taskIds, conn) {
  const out = new Map();
  const ids = [...new Set((taskIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return out;
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT ti.task_id AS taskId,
            SUM(ti.ref_catalog_item_id IS NOT NULL) AS material,
            SUM(ti.producing_item_id   IS NOT NULL) AS component
       FROM fab_task_inputs ti
      WHERE ti.company_id = ? AND ti.task_id IN (?)
        AND ti.gate = 1 AND ti.satisfied_at IS NULL AND ti.deleted_at IS NULL
      GROUP BY ti.task_id`,
    [companyId, ids],
  );
  for (const r of rows) {
    out.set(Number(r.taskId), {
      material: Number(r.material) || 0,
      component: Number(r.component) || 0,
    });
  }
  return out;
}

/** How an outstanding-gate entry reads to a person. Null when nothing is outstanding. */
export function blockerLabelFor(gate) {
  if (!gate) return null;
  if (gate.material && gate.component) return 'waiting on material and an earlier part';
  if (gate.material) return 'waiting on material';
  if (gate.component) return 'waiting on an earlier part';
  return null;
}

/** True when the task cannot proceed for want of STOCK — the one blocker planning cannot fix. */
export const isMaterialBlocked = (gate) => !!gate && gate.material > 0;

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
    await conn.query('UPDATE fab_task_inputs SET satisfied_at = UTC_TIMESTAMP() WHERE id = ?', [inp.id]);
  }
  // Every gate=1 input is now satisfied — fire once per task, not per input row.
  if (inputs.length > 0) {
    // `conn` — this runs inside the caller's transaction. Writing the event on
    // a pooled connection instead would wait on locks this transaction holds.
    await recordEvent({ companyId, taskId, type: 'materials_ready', source: 'system' }, conn);
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
        SET status = 'eligible', deps_cleared_at = UTC_TIMESTAMP(), queued_at = UTC_TIMESTAMP()
      WHERE id = ? AND status = 'blocked' AND deleted_at IS NULL`,
    [taskId],
  );
  const cleared = u.affectedRows > 0;
  if (cleared) {
    await recordEvents([
      { companyId, taskId, type: 'deps_cleared', source: 'system' },
      { companyId, taskId, type: 'queued', source: 'system' },
    ], conn);
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
    // `qty` is load-bearing and was missing until 2026-08-15: without it
    // `item.qty ?? 1` below always took the 1, so EVERY task materialized was
    // planned as a single piece and the per-piece × quantity model was inert
    // for new work. The same omission made `rm.qty` undefined, so every
    // fab_task_inputs row was written with a NULL quantity and the
    // quantity-aware material gate silently degraded to a presence check.
    `SELECT id, parent_item_id, catalog_item_id, flow_id, qty
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
      `SELECT id, flow_id, operation_id, seq_no, depends_on, resource_type_id, params_json
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
      `SELECT id, default_resource_type_id, time_formula, time_unit, setup_minutes FROM fab_operations
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

  // Per-item metrics, so a formula can size the job off the actual part. Without
  // these every item_* variable evaluated to 0 and each formula collapsed onto its
  // operation-level default — one flat time for every part, so a 250 mm stiffener
  // cost the same to cut as a full web plate.
  /**
   * Field values, resolved down the whole chain rather than read from one table.
   *
   * This used to be a flat `SELECT ... FROM fab_item_metric_values`, which is
   * why formulas silently estimated from zero: the BOQ sheet and the BOM tree
   * write `fab_items.length/width/height`, and nothing mirrored those into
   * metric values. `resolveItemFields` consults order item → catalog item →
   * subgroup → group → category → default, so a value entered anywhere a person
   * would reasonably enter it now reaches the formula.
   *
   * No piece map: nothing is issued at materialization, so piece-varying fields
   * correctly fall back to the item's own value here.
   */
  const itemMetricsById = items.length
    ? await resolveItemFields(companyId, items.map((i) => i.id), { conn })
    : new Map();

  // child parts (flow-bound children) per parent item — for 'child_parts' inputs
  const childPartsByParent = new Map();
  for (const it of items) {
    if (it.parent_item_id == null) continue;
    if (it.flow_id == null) continue; // only flow-bearing children count as parts
    if (!childPartsByParent.has(it.parent_item_id)) childPartsByParent.set(it.parent_item_id, []);
    childPartsByParent.get(it.parent_item_id).push(it);
  }
  // raw-material children (catalog-bearing children) per parent item — for
  // 'raw_material' inputs. BUG-07: keep ALL such children, not just the first, so
  // a multi-material assembly gates on every material it needs.
  const rmChildrenByParent = new Map();
  for (const it of items) {
    if (it.parent_item_id == null || it.catalog_item_id == null) continue;
    if (!rmChildrenByParent.has(it.parent_item_id)) rmChildrenByParent.set(it.parent_item_id, []);
    rmChildrenByParent.get(it.parent_item_id).push(it);
  }

  // FEAT-07: per-STEP idempotency (was per-(item,flow)). Skipping only steps that
  // already have a task lets a re-run pick up steps ADDED to a flow after the
  // order was first materialized — the foundation for re-materialization. A first
  // run (no tasks → every step inserted) and a re-run of an unchanged order
  // (every step present → every step skipped) behave exactly as before.
  const [existingRows] = await conn.query(
    `SELECT item_id, flow_step_id FROM fab_project_tasks
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
    [companyId, orderId],
  );
  const existingStepKeys = new Set(existingRows.map((r) => `${r.item_id}:${r.flow_step_id}`));

  let itemsProcessed = 0, itemsSkipped = 0, tasksInserted = 0;
  const insertedTaskIds = [];

  for (const item of items) {
    const flowId = flowOf(item);
    const steps = flowId != null ? stepsByFlowId.get(flowId) : undefined;
    if (!flowId || !steps || !steps.length) { itemsSkipped++; continue; }

    for (const step of steps) {
      if (existingStepKeys.has(`${item.id}:${step.id}`)) continue; // step already materialized
      const op = opById.get(step.operation_id);
      const resourceTypeId = step.resource_type_id ?? op?.default_resource_type_id ?? null;
      const opValues = opVarsByOpId.get(step.operation_id) ?? {};
      // The formula returns the operation's OWN unit (min for nearly all of
      // them); computed_hours is hours. Convert, or a 500-minute cut is stored
      // as 500 hours — which is exactly what used to happen.
      const formulaHours = op
        ? formulaResultToHours(
            await evaluateFormula(
              op.time_formula,
              itemMetricsById.get(item.id) ?? {},
              // step.* — this step's own parameters. Passed as `{}` since the
              // engine was written, so `step.anything` silently evaluated to 0
              // and the namespace was documented but dead. This is what lets one
              // "Cut Plate" operation roll along the length on one flow and
              // across the width on another without cloning the operation.
              parseStepParams(step),
              resourceTypeId,
              opValues,
              // input.* / inputs.* — what this task consumes. Built from the
              // item's children and the field values already resolved above,
              // so it costs no extra query per step.
              buildInputContext({
                rmChildren: rmChildrenByParent.get(item.id) ?? [],
                partChildren: childPartsByParent.get(item.id) ?? [],
                valuesByItemId: itemMetricsById,
              }),
            ),
            op.time_unit,
          )
        : null;

      // The formula IS the estimate. Learned p80 touch-times used to override it
      // here, with the formula's own value preserved in formula_hours for
      // comparison; that subsystem was removed 2026-08-05 (buffer sizing is a
      // fixed 50%, so nothing consumed the learning). One source of truth now.
      const computedHours = formulaHours;

      // Setup is frozen here exactly as the formula result is, and for the same
      // reason: re-deriving it at read time would re-time committed work every
      // time somebody edited the operation. It is charged ONCE per task and
      // never multiplied by quantity — see taskDuration.taskHours().
      const setupHours = op?.setup_minutes != null && Number(op.setup_minutes) > 0
        ? Number(op.setup_minutes) / 60
        : null;

      // insert task as 'blocked' first; clear at the end once inputs exist
      const [ins] = await conn.query(
        `INSERT INTO fab_project_tasks
           (company_id, order_id, item_id, flow_id, flow_step_id, operation_id,
            seq_no, depends_on, resource_type_id, status, computed_hours, setup_hours, task_qty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'blocked', ?, ?, ?)`,
        [companyId, orderId, item.id, flowId, step.id, step.operation_id,
         step.seq_no, step.depends_on, resourceTypeId, computedHours, setupHours,
         // Snapshotted, not joined at read time: a BOM quantity edited later
         // must not silently move the estimate under a plan already committed.
         // Re-materialization is the deliberate way to pick up a change.
         item.qty ?? 1],
      );
      const taskId = ins.insertId;
      tasksInserted++;
      insertedTaskIds.push({ taskId, seq_no: step.seq_no, hasDeps: !!(step.depends_on && String(step.depends_on).trim()) });

      // materialize inputs for this step
      const stepInputs = inputsByStepId.get(step.id) ?? [];
      for (const si of stepInputs) {
        if (si.ref_bom_role === 'raw_material') {
          // BUG-07: one raw_material input per RM child (each gated independently).
          // If the parent has no catalog-bearing children, fall back to the item's
          // own catalog item (prior single-input behaviour).
          const rms = rmChildrenByParent.get(item.id) ?? [];
          if (rms.length) {
            for (const rm of rms) {
              if (rm.catalog_item_id == null) continue;
              await conn.query(
                `INSERT INTO fab_task_inputs (company_id, task_id, order_id, input_role, ref_catalog_item_id, qty, unit, gate)
                 VALUES (?, ?, ?, 'raw_material', ?, ?, ?, ?)`,
                [companyId, taskId, orderId, rm.catalog_item_id, rm.qty ?? null, si.unit ?? null, si.gate],
              );
            }
          } else if (item.catalog_item_id != null) {
            await conn.query(
              `INSERT INTO fab_task_inputs (company_id, task_id, order_id, input_role, ref_catalog_item_id, qty, unit, gate)
               VALUES (?, ?, ?, 'raw_material', ?, ?, ?, ?)`,
              [companyId, taskId, orderId, item.catalog_item_id, null, si.unit ?? null, si.gate],
            );
          }
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

/**
 * What would stop each of these tasks from starting, right now.
 *
 * The operator's queue used to filter on status alone, so it listed work that
 * 409s on contact — the two gates that actually decide a start (a full output
 * buffer, and material a sibling task consumed first) were only evaluated
 * inside POST /tasks/:id/start. Dispatch pre-filtered; the person pressing the
 * button did not, and got a red toast with no way to see it coming.
 *
 * Batched deliberately. The queue polls every 30 seconds, and calling
 * isOutputBlocked per task would be four round trips each. Two properties make
 * that unnecessary:
 *
 *   - The queue is ONE machine's, and output-blocking requires this machine's
 *     own output buffer to be full. That is one check for the whole list, and
 *     when it comes back clear — the overwhelmingly common case — no task in
 *     the queue can be output-blocked and we stop.
 *   - Material availability is a sum per catalog item, so every task's inputs
 *     resolve from a single grouped query.
 *
 * Returns Map<taskId, { outputBlocked, materialShort, reason }>. A task absent
 * from the map has nothing standing in its way.
 */
export async function startBlockersForQueue(companyId, resourceId, tasks) {
  const out = new Map();
  const eligible = (tasks || []).filter((t) => t.status === 'eligible');
  if (eligible.length === 0) return out;

  // ── (1) output buffer, once for the whole machine ────────────────────────
  let ownBufferFull = false;
  if (resourceId) {
    const [[ownBuf]] = await pool.query(
      `SELECT id FROM fab_buffers
        WHERE company_id = ? AND resource_id = ? AND kind = 'output'
          AND active = 1 AND deleted_at IS NULL LIMIT 1`,
      [companyId, resourceId],
    );
    if (ownBuf) {
      const load = await loadOf(companyId, ownBuf.id);
      ownBufferFull = statusFor(load.pct, load.warnPct, load.blockPct) === 'block';
    }
  }

  if (ownBufferFull) {
    // Only now is the successor side worth resolving, and only per task,
    // because each task's next step can sit on a different machine.
    for (const t of eligible) {
      try {
        const r = await isOutputBlocked(companyId, { ...t, assigned_resource_id: resourceId });
        if (r.blocked) {
          out.set(t.id, { outputBlocked: true, materialShort: false, reason: r.reason ?? 'output buffer full' });
        }
      } catch { /* a gating hiccup must not empty the queue; treat as startable */ }
    }
  }

  // ── (2) material, for the tasks that will actually consume ───────────────
  //
  // Only a first step consumes (wipInventoryService opens the WIP piece there);
  // later steps move a piece that already exists. A task is eligible because its
  // gate was satisfied at some point in the past — satisfied_at is a one-way
  // stamp — so stock a sibling has since taken is exactly the case this catches.
  const taskIds = eligible.map((t) => t.id);
  const [gateRows] = await pool.query(
    `SELECT ti.task_id, ti.ref_catalog_item_id AS catalogItemId, ti.qty,
            ic.name AS itemName
       FROM fab_task_inputs ti
       LEFT JOIN fab_item_catalog ic ON ic.id = ti.ref_catalog_item_id
      WHERE ti.company_id = ? AND ti.task_id IN (?) AND ti.gate = 1
        AND ti.ref_catalog_item_id IS NOT NULL AND ti.deleted_at IS NULL`,
    [companyId, taskIds],
  );
  if (gateRows.length === 0) return out;

  const catalogIds = [...new Set(gateRows.map((r) => r.catalogItemId))];
  const [stockRows] = await pool.query(
    `SELECT catalog_item_id AS catalogItemId, COALESCE(SUM(qty), 0) AS available
       FROM fab_stock_pieces
      WHERE company_id = ? AND catalog_item_id IN (?)
        AND status = 'in_stock' AND deleted_at IS NULL
      GROUP BY catalog_item_id`,
    [companyId, catalogIds],
  );
  const availableBy = new Map(stockRows.map((r) => [r.catalogItemId, Number(r.available) || 0]));

  // Mirror inputSatisfiedLive exactly, including its weakness. That function
  // does `required > 0 ? avail >= required : avail > 0`, and in practice the
  // second branch is the only one that ever runs: fab_task_inputs.qty is NULL on
  // every row in production (2328 of 2328), because the flow-step inputs it is
  // copied from carry no quantity either. So the material gate is presence-only
  // — it asks "is there any of this?", not "is there enough?".
  //
  // Predicting something stricter than the gate would be worse than predicting
  // nothing: the queue would grey out work that starts perfectly well. When a
  // quantity does exist, demand is summed across the whole queue, because two
  // tasks each needing the last plate are both fine in isolation and cannot
  // both be right.
  const demandBy = new Map();
  let anyQuantities = false;
  for (const g of gateRows) {
    const need = Number(g.qty) || 0;
    if (need > 0) anyQuantities = true;
    demandBy.set(g.catalogItemId, (demandBy.get(g.catalogItemId) ?? 0) + need);
  }

  const shortItems = new Set();
  for (const catId of demandBy.keys()) {
    const have = availableBy.get(catId) ?? 0;
    const demand = demandBy.get(catId) ?? 0;
    const short = demand > 0 ? demand > have + 1e-9 : have <= 0;
    if (short) shortItems.add(catId);
  }
  if (shortItems.size === 0) return out;

  for (const g of gateRows) {
    if (!shortItems.has(g.catalogItemId)) continue;
    const have = availableBy.get(g.catalogItemId) ?? 0;
    const demand = demandBy.get(g.catalogItemId) ?? 0;
    const prev = out.get(g.task_id) ?? { outputBlocked: false, materialShort: false, reason: null };
    const label = g.itemName ?? `item #${g.catalogItemId}`;
    out.set(g.task_id, {
      ...prev,
      materialShort: true,
      reason: prev.outputBlocked
        ? prev.reason
        : (demand > 0
          ? `${label}: ${round2(have)} in stock, this queue needs ${round2(demand)}`
          : `${label}: none in stock`),
    });
  }

  return out;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Re-check every task still sitting on 'blocked' for material.
 *
 * The safety net under reevaluateStockGatedTasks. That hook runs once, at the
 * moment stock is received, and it is the only thing that moves a task off
 * 'blocked' — so if it fails (deadlock, timeout, a bad row) the material is on
 * hand and the work stays blocked with nobody watching. It is now retried three
 * times at the call site, but a retry loop still cannot survive a process
 * restart mid-receipt.
 *
 * This sweep closes that hole from the other side: it asks the same question
 * periodically, for every blocked task, regardless of what happened at receipt
 * time. Idempotent by construction — tryClearTask only acts on tasks that are
 * still 'blocked' and whose inputs genuinely check out, so a task that is fine
 * costs one evaluation and nothing else.
 *
 * @returns {Promise<{checked:number, cleared:number[]}>}
 */
export async function sweepBlockedTasks(companyId, { limit = 500 } = {}) {
  const [rows] = await pool.query(
    `SELECT DISTINCT t.id
       FROM fab_project_tasks t
       JOIN fab_task_inputs ti ON ti.task_id = t.id AND ti.gate = 1
                              AND ti.satisfied_at IS NULL AND ti.deleted_at IS NULL
      WHERE t.company_id = ? AND t.status = 'blocked' AND t.deleted_at IS NULL
      ORDER BY t.id ASC
      LIMIT ?`,
    [companyId, limit],
  );
  if (rows.length === 0) return { checked: 0, cleared: [] };

  const conn = await pool.getConnection();
  const cleared = [];
  try {
    for (const r of rows) {
      try {
        if (await tryClearTask(conn, companyId, r.id)) cleared.push(r.id);
      } catch (err) {
        // One bad task must not stop the sweep for the rest of the shop.
        logger.warn({ err, companyId, taskId: r.id }, '[gate-sweep] task re-check failed');
      }
    }
  } finally {
    conn.release();
  }
  return { checked: rows.length, cleared };
}

/** Every company with at least one blocked, material-gated task. */
export async function sweepBlockedTasksAllCompanies({ limit = 500 } = {}) {
  const [companies] = await pool.query(
    `SELECT DISTINCT t.company_id AS companyId
       FROM fab_project_tasks t
       JOIN fab_task_inputs ti ON ti.task_id = t.id AND ti.gate = 1
                              AND ti.satisfied_at IS NULL AND ti.deleted_at IS NULL
      WHERE t.status = 'blocked' AND t.deleted_at IS NULL`,
  );
  let totalChecked = 0;
  const totalCleared = [];
  for (const c of companies) {
    const r = await sweepBlockedTasks(c.companyId, { limit });
    totalChecked += r.checked;
    totalCleared.push(...r.cleared);
  }
  return { companies: companies.length, checked: totalChecked, cleared: totalCleared };
}
