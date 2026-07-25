/**
 * rematerializeService.js
 * -----------------------
 * FEAT-07: explicit re-generation of an order's task DAG after its flows (or
 * BOMs) are edited. The original `materializeTasks` is idempotent per step, so a
 * re-run adds *new* steps — but it never removes deleted steps, re-times moved
 * ones, or refreshes durations on already-materialized items. This service gives:
 *
 *   previewRematerialize(companyId, orderId)  — read-only diff (added / removed /
 *       changed / retained), keyed on flow_step_id, with a safety flag on every
 *       row whose task has already started (in_progress / paused / done).
 *
 *   applyRematerialize(companyId, orderId)    — soft-deletes every UNSTARTED
 *       (blocked / eligible) task + its inputs, releases their reservations, then
 *       re-runs materializeOrderTasks to rebuild the unstarted DAG from the
 *       current flow definition. Started / done tasks are always preserved, so
 *       real shop-floor work is never lost.
 *
 * Safety model: the apply only ever deletes/rebuilds unstarted work. A started or
 * done task pins its step (per-step idempotency skips it on rebuild), so its
 * history stays intact; the preview flags any flow change that lands on such a
 * task as "retained — not modified" so the operator knows it won't take effect
 * until that task is re-run.
 */

import { pool } from '../../../db.js';
import {
  materializeOrderTasks,
  releaseTaskReservations,
} from './taskGatingService.js';
import { rollUpOrderStatus } from './taskEngineService.js';
import { evaluateFormula } from './formulaEngine.js';
import { getUsableStat } from './operationStatsService.js';

const STARTED_STATUSES = new Set(['in_progress', 'paused', 'done']);
const HOURS_EPS = 0.01;

/** Resolve the flow an item should use now (explicit flow_id, else default BOM→binding). */
async function resolveItemFlowId(conn, companyId, item) {
  if (item.flow_id != null) return item.flow_id;
  if (item.catalog_item_id == null) return null;
  const [[bom]] = await conn.query(
    `SELECT id FROM fab_material_boms
      WHERE company_id = ? AND is_default = 1 AND deleted_at IS NULL AND catalog_item_id = ? LIMIT 1`,
    [companyId, item.catalog_item_id],
  );
  if (!bom) return null;
  const [[bind]] = await conn.query(
    `SELECT flow_id FROM fab_bom_flow_bindings
      WHERE company_id = ? AND active = 1 AND deleted_at IS NULL AND bom_id = ? LIMIT 1`,
    [companyId, bom.id],
  );
  return bind?.flow_id ?? null;
}

/** Desired planning hours for a step — mirrors materializeOrderTasks (learned p80 ?? formula). */
async function desiredHours(conn, companyId, operationId, resourceTypeId) {
  const [[op]] = await conn.query(
    `SELECT time_formula, default_resource_type_id FROM fab_operations
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [operationId, companyId],
  );
  if (!op) return null;
  const [vars] = await conn.query(
    `SELECT var_key, default_value FROM fab_operation_variables
      WHERE company_id = ? AND operation_id = ? AND deleted_at IS NULL`,
    [companyId, operationId],
  );
  const opValues = Object.fromEntries(vars.map((v) => [v.var_key, v.default_value]));
  const rt = resourceTypeId ?? op.default_resource_type_id ?? null;
  const formulaHours = await evaluateFormula(op.time_formula, {}, {}, rt, opValues);
  const stat = await getUsableStat(companyId, operationId, rt);
  const learned = stat && stat.p80_minutes != null ? Number(stat.p80_minutes) / 60 : null;
  return learned != null ? learned : formulaHours;
}

const normDeps = (d) => (d == null ? '' : String(d).trim());

/**
 * Compute the per-item diff between the order's current tasks and what the
 * current flow definitions would produce. Read-only (uses whatever connection
 * it's given — a pooled one by default).
 */
export async function previewRematerialize(companyId, orderId, exec = pool) {
  const [items] = await exec.query(
    `SELECT id, parent_item_id, catalog_item_id, flow_id, name
       FROM fab_items WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
    [companyId, orderId],
  );

  const outItems = [];
  let added = 0, removed = 0, changed = 0, retainedStarted = 0;

  for (const item of items) {
    const flowId = await resolveItemFlowId(exec, companyId, item);
    if (!flowId) continue; // no flow resolvable → nothing to compare

    const [[flow]] = await exec.query(
      `SELECT name FROM fab_operation_flows WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [flowId, companyId],
    );
    const [steps] = await exec.query(
      `SELECT s.id, s.seq_no, s.operation_id, s.depends_on, s.resource_type_id, o.name AS operation_name
         FROM fab_operation_flow_steps s
         LEFT JOIN fab_operations o ON o.id = s.operation_id AND o.company_id = s.company_id
        WHERE s.company_id = ? AND s.flow_id = ? AND s.deleted_at IS NULL
        ORDER BY s.seq_no`,
      [companyId, flowId],
    );
    const [tasks] = await exec.query(
      `SELECT t.id, t.flow_step_id, t.flow_id, t.seq_no, t.operation_id, t.depends_on,
              t.resource_type_id, t.computed_hours, t.status, o.name AS operation_name
         FROM fab_project_tasks t
         LEFT JOIN fab_operations o ON o.id = t.operation_id AND o.company_id = t.company_id
        WHERE t.company_id = ? AND t.order_id = ? AND t.item_id = ? AND t.deleted_at IS NULL`,
      [companyId, orderId, item.id],
    );

    const stepById = new Map(steps.map((s) => [s.id, s]));
    const taskByStepId = new Map(tasks.filter((t) => t.flow_step_id != null).map((t) => [t.flow_step_id, t]));

    const itemAdded = [], itemRemoved = [], itemChanged = [];

    // Added: a current step with no live task (and not pinned by a started task on
    // the same step — that would be a matched row, handled below).
    for (const s of steps) {
      if (!taskByStepId.has(s.id)) {
        itemAdded.push({ flowStepId: s.id, seqNo: s.seq_no, operationName: s.operation_name });
      }
    }

    // Removed: a live task whose step no longer exists in the flow (or whose flow
    // was rebound to a different flow than the task carries).
    for (const t of tasks) {
      const gone = t.flow_step_id == null || !stepById.has(t.flow_step_id) || t.flow_id !== flowId;
      if (gone) {
        const started = STARTED_STATUSES.has(t.status);
        itemRemoved.push({ taskId: t.id, flowStepId: t.flow_step_id, seqNo: t.seq_no, operationName: t.operation_name, status: t.status, retained: started });
        if (started) retainedStarted++;
      }
    }

    // Changed: matched step ↔ task where seq_no / deps / resource type / duration differ.
    for (const s of steps) {
      const t = taskByStepId.get(s.id);
      if (!t || t.flow_id !== flowId) continue;
      const changes = [];
      if (Number(s.seq_no) !== Number(t.seq_no)) changes.push(`seq ${t.seq_no}→${s.seq_no}`);
      if (normDeps(s.depends_on) !== normDeps(t.depends_on)) changes.push('dependencies');
      if ((s.resource_type_id ?? null) !== (t.resource_type_id ?? null)) changes.push('resource type');
      const want = await desiredHours(exec, companyId, s.operation_id, s.resource_type_id);
      const have = t.computed_hours == null ? null : Number(t.computed_hours);
      if (want != null && (have == null || Math.abs(want - have) > HOURS_EPS)) {
        changes.push(`duration ${have == null ? '—' : have}→${Number(want.toFixed(2))}`);
      }
      if (changes.length) {
        const started = STARTED_STATUSES.has(t.status);
        itemChanged.push({ taskId: t.id, flowStepId: s.id, seqNo: s.seq_no, operationName: s.operation_name, status: t.status, changes, retained: started });
        if (started) retainedStarted++;
      }
    }

    if (itemAdded.length || itemRemoved.length || itemChanged.length) {
      added += itemAdded.length; removed += itemRemoved.length; changed += itemChanged.length;
      outItems.push({
        itemId: item.id, itemName: item.name, flowId, flowName: flow?.name ?? null,
        added: itemAdded, removed: itemRemoved, changed: itemChanged,
      });
    }
  }

  return {
    ok: true,
    orderId,
    summary: { itemsAffected: outItems.length, added, removed, changed, retainedStarted },
    items: outItems,
  };
}

/**
 * Apply the re-materialization: drop unstarted work and rebuild from current
 * flows, preserving started/done tasks. Returns counts of what changed.
 */
export async function applyRematerialize(companyId, orderId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Unstarted tasks (blocked/eligible) are the only ones we may rebuild.
    const [unstarted] = await conn.query(
      `SELECT id FROM fab_project_tasks
        WHERE company_id = ? AND order_id = ? AND status IN ('blocked','eligible') AND deleted_at IS NULL`,
      [companyId, orderId],
    );
    const ids = unstarted.map((r) => r.id);

    let deleted = 0;
    if (ids.length) {
      // Release any material these tasks had earmarked (FEAT-02), then soft-delete
      // the tasks and their gated inputs so materialize sees their steps as missing.
      for (const id of ids) await releaseTaskReservations(conn, companyId, id);
      await conn.query(
        `UPDATE fab_project_tasks SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)`,
        [companyId, ids],
      );
      await conn.query(
        `UPDATE fab_task_inputs SET deleted_at = NOW() WHERE company_id = ? AND task_id IN (?) AND deleted_at IS NULL`,
        [companyId, ids],
      );
      deleted = ids.length;
    }

    // Rebuild: per-step idempotency re-inserts every now-missing step (the ones we
    // just dropped + any brand-new steps/items), skipping steps still pinned by a
    // retained started/done task.
    const rebuilt = await materializeOrderTasks(conn, companyId, orderId);
    // Keep the sales lifecycle in sync after a rebuild (2026-07-24).
    await rollUpOrderStatus(conn, companyId, orderId);

    await conn.commit();
    return { ok: true, orderId, deletedUnstarted: deleted, rebuilt };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
