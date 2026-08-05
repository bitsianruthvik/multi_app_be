/**
 * taskEngineService.js
 * ---------------------
 * Dependency-clearing engine for fab_erp (event-driven).
 *
 *   onTaskComplete(companyId, taskId)
 *
 * Called by POST /tasks/:id/stop right after a fab_project_tasks row is set to
 * status = 'done'. It clears every task that was waiting on the just-completed
 * one and is now fully ready. As of the 2026-07-20 remodel "ready" means BOTH
 * process predecessors done AND gated inputs satisfied — the check lives in
 * taskGatingService.tryClearTask, shared with materialization.
 *
 * Two kinds of successor are re-evaluated:
 *   1. Intra-item — blocked tasks in the SAME (item_id, flow_id) instance.
 *      (seq_no in depends_on is only unique within one flow's step sequence, so
 *       this stays scoped to the completed task's item_id + flow_id.)
 *   2. Cross-item (material) — when the completed task is its item's TERMINAL
 *      step, the whole item is produced; any other item's task that lists this
 *      item as a gated component input (fab_task_inputs.producing_item_id) is
 *      re-evaluated. This is how a girder segment's crane-load step unblocks
 *      once all its child parts are finished.
 */

import { pool } from '../../../db.js';
import { tryClearTask } from './taskGatingService.js';

// BUG-03: order statuses that are "before production" and may be advanced to
// 'in_production' once work starts. Manual/terminal statuses (shipped, closed,
// cancelled, completed) are never overwritten by the rollup.
const PRE_PRODUCTION_STATUSES = new Set([
  'draft', 'confirmed', 'approved', 'released', 'scheduled', 'scheduled_late', 'planned',
]);
const TERMINAL_ORDER_STATUSES = new Set([
  'completed', 'shipped', 'closed', 'received', 'converted', 'cancelled',
]);

// Sales-order lifecycle (Project Progress feature, 2026-07-24): automation moves
// an order forward through these ranks only. materialized(tasks exist)→scheduled,
// any task started→in_production, all done→ready_to_ship (the automation ceiling
// — shipped/closed are ranked higher and only ever set by hand). Forward-only:
// a status already at/above the computed target (incl. a manual shipped/closed)
// is never moved back.
const SALES_STATUS_RANK = {
  draft: 0, confirmed: 1, scheduled: 2, in_production: 3, ready_to_ship: 4, shipped: 5, closed: 6,
};

/**
 * BUG-03: roll task-status aggregates up to the order's lifecycle status.
 *   - all tasks done (≥1 task)        → 'completed'
 *   - any task started/done otherwise → 'in_production' (only from a pre-production status)
 * Never moves an order backwards and never overwrites a manual/terminal status.
 * Best-effort: swallows its own errors so it can never fail a lifecycle write.
 *
 * @param {import('mysql2/promise').Connection|import('mysql2/promise').Pool} exec
 */
export async function rollUpOrderStatus(exec, companyId, orderId) {
  if (!orderId) return;
  try {
    const [[order]] = await exec.query(
      `SELECT status, order_type FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [orderId, companyId],
    );
    if (!order) return;

    const [[agg]] = await exec.query(
      `SELECT COUNT(*)                                          AS total,
              SUM(status = 'done')                             AS done,
              SUM(status IN ('in_progress', 'paused'))         AS active,
              SUM(status NOT IN ('done', 'cancelled'))         AS remaining
         FROM fab_project_tasks
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
      [companyId, orderId],
    );
    const total = Number(agg?.total) || 0;
    const done = Number(agg?.done) || 0;
    const active = Number(agg?.active) || 0;
    const remaining = Number(agg?.remaining) || 0;

    // FEAT-03: persist the task-count completion % + per-line progress for the
    // Orders board, independent of the status-advance rules below — so a terminal
    // or manually-set order still shows a correct bar.
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    await exec.query(
      `UPDATE fab_orders SET progress_pct = ? WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [pct, orderId, companyId],
    );
    await rollUpLineProgress(exec, companyId, orderId);

    if (total === 0) return;

    // Sales-order lifecycle automation (2026-07-24): materialized→scheduled,
    // started→in_production, all done→ready_to_ship. Forward-only by rank, so a
    // manual shipped/closed (higher rank) or cancelled is never overwritten.
    if (order.order_type === 'sales') {
      if (order.status === 'cancelled') return;
      let salesTarget;
      if (remaining === 0 && done > 0) salesTarget = 'ready_to_ship';
      else if (done > 0 || active > 0) salesTarget = 'in_production';
      else salesTarget = 'scheduled'; // tasks exist, none started yet
      const curRank = SALES_STATUS_RANK[order.status];
      const tgtRank = SALES_STATUS_RANK[salesTarget];
      if (curRank == null) return; // custom/unknown status — leave it to the user
      if (tgtRank > curRank) {
        await exec.query(
          `UPDATE fab_orders SET status = ? WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
          [salesTarget, orderId, companyId],
        );
      }
      return;
    }

    // BUG-03: non-sales advance — never overwrites a terminal/manual status, never backwards.
    if (TERMINAL_ORDER_STATUSES.has(order.status)) return;
    let target = null;
    if (remaining === 0 && done > 0) target = 'completed';
    else if (done > 0 || active > 0) target = 'in_production';
    if (!target || target === order.status) return;
    // Only advance to in_production from a genuine pre-production status.
    if (target === 'in_production' && !PRE_PRODUCTION_STATUSES.has(order.status)) return;

    await exec.query(
      `UPDATE fab_orders SET status = ? WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [target, orderId, companyId],
    );
  } catch (err) {
    // Never let a status rollup break the task lifecycle.
    // eslint-disable-next-line no-console
    console.error('rollUpOrderStatus failed', { companyId, orderId, err: err?.message });
  }
}

/**
 * FEAT-03: per-line completion. A line maps to its top-level fab_items node(s)
 * by catalog_item_id within the order; qty_completed = line.qty × (done / total
 * tasks for those nodes). Best-effort — errors bubble to rollUpOrderStatus's catch.
 */
async function rollUpLineProgress(exec, companyId, orderId) {
  const [lines] = await exec.query(
    `SELECT id, catalog_item_id, qty FROM fab_order_lines
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
    [companyId, orderId],
  );
  for (const line of lines) {
    if (!line.catalog_item_id) continue;
    const [[a]] = await exec.query(
      `SELECT COUNT(*)              AS total,
              SUM(t.status = 'done') AS done
         FROM fab_project_tasks t
         JOIN fab_items i ON i.id = t.item_id AND i.company_id = t.company_id AND i.deleted_at IS NULL
        WHERE t.company_id = ? AND t.order_id = ? AND t.deleted_at IS NULL
          AND i.parent_item_id IS NULL AND i.catalog_item_id = ?`,
      [companyId, orderId, line.catalog_item_id],
    );
    const total = Number(a?.total) || 0;
    const done = Number(a?.done) || 0;
    const frac = total > 0 ? done / total : 0;
    const qtyDone = Math.round((Number(line.qty) || 0) * frac * 10000) / 10000;
    await exec.query(
      `UPDATE fab_order_lines SET qty_completed = ? WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [qtyDone, line.id, companyId],
    );
  }
}

/**
 * @param {number} companyId
 * @param {number} taskId - id of the fab_project_tasks row that just completed
 * @returns {Promise<{ ok: boolean, completedTaskId: number, successorsCleared: number[] }>}
 */
export async function onTaskComplete(companyId, taskId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [completedRows] = await conn.query(
      `SELECT id, order_id, item_id, flow_id, seq_no FROM fab_project_tasks
        WHERE company_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1`,
      [companyId, taskId],
    );
    if (completedRows.length === 0) {
      await conn.commit();
      return { ok: false, completedTaskId: taskId, successorsCleared: [] };
    }
    const ct = completedRows[0];
    const successorsCleared = [];

    // ── 1. Intra-item successors ────────────────────────────────────────────
    const [siblings] = await conn.query(
      `SELECT id FROM fab_project_tasks
        WHERE company_id = ? AND item_id = ? AND flow_id = ?
          AND status = 'blocked' AND deleted_at IS NULL`,
      [companyId, ct.item_id, ct.flow_id],
    );
    for (const s of siblings) {
      if (await tryClearTask(conn, companyId, s.id)) successorsCleared.push(s.id);
    }

    // ── 2. Cross-item (material) successors, only if this was the item's last step ─
    const [terminal] = await conn.query(
      `SELECT id FROM fab_project_tasks
        WHERE company_id = ? AND item_id = ? AND deleted_at IS NULL
        ORDER BY seq_no DESC LIMIT 1`,
      [companyId, ct.item_id],
    );
    if (terminal.length && terminal[0].id === taskId) {
      const [dependents] = await conn.query(
        `SELECT DISTINCT task_id FROM fab_task_inputs
          WHERE company_id = ? AND producing_item_id = ? AND gate = 1 AND deleted_at IS NULL`,
        [companyId, ct.item_id],
      );
      for (const d of dependents) {
        if (await tryClearTask(conn, companyId, d.task_id)) successorsCleared.push(d.task_id);
      }
    }

    // BUG-03: advance the order's lifecycle status to reflect this completion.
    await rollUpOrderStatus(conn, companyId, ct.order_id);

    await conn.commit();
    return { ok: true, completedTaskId: taskId, successorsCleared };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * FEAT-05: spawn a rework task for a QC-failed task. The new task clones the
 * failed task's operation/resource and is appended at seq_no = maxSeq + 1 so it
 * becomes the node's TERMINAL step — which keeps terminalTaskDone(), the WIP
 * finalize, and every downstream component gate blocked until the rework itself
 * completes with a QC pass. Inserted directly as 'eligible' (its predecessors,
 * including the just-failed task, are already done) so it appears in the queue
 * immediately. Runs inside the caller's transaction (`exec`).
 *
 * Does NOT record its own audit event — recordEvent writes on its own pool
 * connection, so the caller records the 'state_note' AFTER committing (mirroring
 * how /tasks/:id/stop records 'completed' post-commit).
 *
 * @param {import('mysql2/promise').Connection} exec  the caller's txn connection
 * @returns {Promise<{ reworkTaskId: number, failedSeqNo: number } | null>}
 */
export async function spawnReworkTask(exec, companyId, failedTaskId) {
  const [[ft]] = await exec.query(
    `SELECT id, order_id, item_id, flow_id, flow_step_id, operation_id, seq_no,
            resource_type_id, computed_hours, sort_order
       FROM fab_project_tasks
      WHERE company_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1`,
    [companyId, failedTaskId],
  );
  if (!ft) return null;

  const [[b]] = await exec.query(
    `SELECT MAX(seq_no) AS maxSeq FROM fab_project_tasks
      WHERE company_id = ? AND item_id = ? AND deleted_at IS NULL`,
    [companyId, ft.item_id],
  );
  const newSeq = (Number(b?.maxSeq) || Number(ft.seq_no)) + 1;

  const [ins] = await exec.query(
    `INSERT INTO fab_project_tasks
       (company_id, order_id, item_id, flow_id, flow_step_id, operation_id, seq_no,
        depends_on, resource_type_id, status, computed_hours,
        deps_cleared_at, queued_at, is_rework, rework_of_task_id, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'eligible', ?, NOW(), NOW(), 1, ?, ?)`,
    [companyId, ft.order_id, ft.item_id, ft.flow_id, ft.flow_step_id, ft.operation_id, newSeq,
     String(ft.seq_no), ft.resource_type_id, ft.computed_hours,
     failedTaskId, (Number(ft.sort_order) || 0) + 1],
  );

  return { reworkTaskId: ins.insertId, failedSeqNo: Number(ft.seq_no) };
}
