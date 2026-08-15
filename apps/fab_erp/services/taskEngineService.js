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
import { rollUpProductionOrder } from './productionOrderService.js';

// Sales-order lifecycle (Project Progress feature, 2026-07-24): automation moves
// an order forward through these ranks only. materialized(tasks exist)→scheduled,
// any task started→in_production, all done→ready_to_ship (the automation ceiling
// — shipped/closed are ranked higher and only ever set by hand). Forward-only:
// a status already at/above the computed target (incl. a manual shipped/closed)
// is never moved back.
//
/**
 * `waiting_material` replaced `scheduled` at rank 2 on 2026-08-13.
 *
 * "Scheduled" described the DAG existing, which is now true the moment a
 * production order is raised and says nothing about whether the job can start.
 * What a planner needs at that rank is whether the shop is held up, and it is
 * held up when the production order is `waiting` — approved with every task
 * still blocked for want of steel.
 *
 * `scheduled` is KEPT in the map, at the same rank, so any order still carrying
 * it compares sanely and the forward-only rule keeps working. Nothing targets
 * it any more.
 */
const SALES_STATUS_RANK = {
  draft: 0,
  confirmed: 1,
  scheduled: 2,
  waiting_material: 2,
  in_production: 3,
  ready_to_ship: 4,
  shipped: 5,
  closed: 6,
};

/**
 * Roll task-status aggregates up to the order's lifecycle status.
 *   - tasks exist, none started       → 'scheduled'
 *   - any task started or done        → 'in_production'
 *   - all tasks done (≥1 task)        → 'ready_to_ship'
 * Forward-only by rank, so a manual shipped/closed or a cancellation is never
 * overwritten. Best-effort: swallows its own errors so it can never fail a
 * lifecycle write.
 *
 * @param {import('mysql2/promise').Connection|import('mysql2/promise').Pool} exec
 */
export async function rollUpOrderStatus(exec, companyId, orderId) {
  if (!orderId) return;
  try {
    const [[order]] = await exec.query(
      `SELECT status FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
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

    // Lifecycle automation: materialized→scheduled, started→in_production,
    // all done→ready_to_ship. Forward-only by rank, so a manual shipped/closed
    // (higher rank) or cancelled is never overwritten.
    //
    // A second branch used to sit below this one for non-sales orders, driven by
    // PRE_PRODUCTION_STATUSES and TERMINAL_ORDER_STATUSES. Order types collapsed
    // to sales only on 2026-08-05, so it became unreachable and both sets went
    // with it.
    if (order.status === 'cancelled') return;

    // A DRAFT IS AN ORDER STILL IN THE WIZARD, and building the project tree is
    // one of the wizard's steps — it happens BEFORE anyone confirms. Without
    // this guard the tree step would advance the order straight to 'scheduled',
    // stepping over confirmation entirely and leaving the Confirm button with
    // nothing left to do. Only Confirm takes an order out of draft.
    if (order.status === 'draft') return;

    /**
     * The sales order now MIRRORS ITS PRODUCTION ORDER.
     *
     * The two used to be computed from the same task counts by two different
     * rules, which is two chances to disagree about one job. The production
     * order already answers "is this waiting for steel or actually running",
     * and it is the thing that knows, so the sales order reads it rather than
     * working it out again.
     *
     * An order with no production order yet falls back to the task counts, so
     * anything raised before this existed still behaves.
     */
    const [[moRow]] = await exec.query(
      `SELECT id FROM fab_orders
        WHERE company_id = ? AND source_order_id = ? AND order_type = 'manufacturing'
          AND deleted_at IS NULL
        ORDER BY id LIMIT 1`,
      [companyId, orderId],
    );

    /**
     * REFRESH THE PRODUCTION ORDER BEFORE READING IT.
     *
     * Mirroring a status nobody recomputed is mirroring a stale one. This is
     * called on every task start and completion, and the production order was
     * only recalculated when it was raised, approved, or when stock arrived —
     * so finishing every task on a job left BOTH documents saying "waiting for
     * material" about work that was already done.
     *
     * Doing it here, rather than having the production order push to the sales
     * order, is what keeps the dependency in one direction: this module already
     * owns the sales lifecycle, so it recomputes its input and then maps it.
     */
    let mo = null;
    if (moRow?.id) {
      try {
        mo = await rollUpProductionOrder(exec, companyId, moRow.id);
      } catch (err) {
        // Fall back to the stored value rather than losing the roll-up entirely.
        const [[stored]] = await exec.query(
          'SELECT status FROM fab_orders WHERE id = ? LIMIT 1', [moRow.id],
        );
        mo = stored ?? null;
      }
    }

    let salesTarget;
    if (mo) {
      if (mo.status === 'completed') salesTarget = 'ready_to_ship';
      else if (mo.status === 'in_production') salesTarget = 'in_production';
      else if (mo.status === 'waiting') salesTarget = 'waiting_material';
      // A draft production order is one nobody has approved. The sales order
      // has nothing to advance to yet.
      else return;
    } else if (remaining === 0 && done > 0) salesTarget = 'ready_to_ship';
    else if (done > 0 || active > 0) salesTarget = 'in_production';
    else salesTarget = 'waiting_material'; // tasks exist, none startable yet

    /**
     * READY TO SHIP MEANS BOTH SIDES ARE DONE, not just the made one.
     *
     * Tasks only cover what this shop builds. An order whose every task is
     * finished can still be waiting on a lorry — a bought-in bearing that has
     * not arrived is just as much a reason not to ship as an unwelded seam,
     * and this used to be invisible because purchasing had no record at all.
     *
     * A purchase order that is raised but not fully received holds the order at
     * in_production. Cancelled ones do not count; an order with no purchase
     * orders is unaffected, which is every order made before this existed.
     *
     * Queried inline rather than imported: procurementOrderService reaches
     * stockInService and back into this module, and a cycle here would break
     * task completion — the one path that must never fail.
     */
    if (salesTarget === 'ready_to_ship') {
      const [[po]] = await exec.query(
        `SELECT COUNT(*) AS outstanding
           FROM fab_orders
          WHERE company_id = ? AND source_order_id = ? AND order_type = 'purchase'
            AND deleted_at IS NULL AND status NOT IN ('received', 'cancelled')`,
        [companyId, orderId],
      );
      if ((Number(po?.outstanding) || 0) > 0) salesTarget = 'in_production';
    }
    const curRank = SALES_STATUS_RANK[order.status];
    const tgtRank = SALES_STATUS_RANK[salesTarget];
    if (curRank == null) return; // custom/unknown status — leave it to the user
    if (tgtRank > curRank) {
      await exec.query(
        `UPDATE fab_orders SET status = ? WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
        [salesTarget, orderId, companyId],
      );

      // A finished project has to let go of the constraint. Nothing used to move
      // fab_cc_plans off 'baselined', and both the CC portfolio and
      // drumService.sequenceProjects select on exactly that — so a delivered
      // order kept its drum slot and its row on the fever chart indefinitely,
      // crowding out live work until somebody happened to press Replan.
      //
      // Archived, not deleted: the plan is the record of what was committed to
      // and what it actually cost, and that is the only thing that makes the
      // next estimate better than a guess.
      if (salesTarget === 'ready_to_ship') {
        await exec.query(
          `UPDATE fab_cc_plans SET status = 'archived'
            WHERE company_id = ? AND order_id = ? AND status = 'baselined' AND deleted_at IS NULL`,
          [companyId, orderId],
        );
      }
    }
  } catch (err) {
    // Never let a status rollup break the task lifecycle.
    // eslint-disable-next-line no-console
    console.error('rollUpOrderStatus failed', { companyId, orderId, err: err?.message });
  }
}

/**
 * FEAT-03: per-line completion — qty_completed = line.qty × (done / total tasks
 * belonging to that line). Best-effort; errors bubble to rollUpOrderStatus's catch.
 *
 * The link used to be catalog_item_id: a line named a catalog item, and its
 * items were the top-level nodes carrying the same one. That could not survive
 * lines becoming free text (2026-08-10) — the catalog holds raw materials and
 * consumables, and no fabricator is going to add a one-off 42m span to it. So a
 * line now owns its subtree outright through fab_items.order_line_id, which is
 * both the honest relationship and cheaper to query.
 *
 * Counts EVERY task under the line, not just the top node's, because that is
 * what completion means: a girder is not half done because its own two tasks
 * are, while three hundred parts underneath are untouched.
 */
async function rollUpLineProgress(exec, companyId, orderId) {
  const [lines] = await exec.query(
    `SELECT id, qty FROM fab_order_lines
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
    [companyId, orderId],
  );
  for (const line of lines) {
    const [[a]] = await exec.query(
      `SELECT COUNT(*)              AS total,
              SUM(t.status = 'done') AS done
         FROM fab_project_tasks t
         JOIN fab_items i ON i.id = t.item_id AND i.company_id = t.company_id AND i.deleted_at IS NULL
        WHERE t.company_id = ? AND t.order_id = ? AND t.deleted_at IS NULL
          AND i.order_line_id = ?`,
      [companyId, orderId, line.id],
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
            resource_type_id, computed_hours, setup_hours, sort_order
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
        depends_on, resource_type_id, status, computed_hours, setup_hours,
        deps_cleared_at, queued_at, is_rework, rework_of_task_id, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'eligible', ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), 1, ?, ?)`,
    // Setup is carried across: reworking a part means setting the machine up
    // again, and that cost does not depend on how many pieces come back.
    //
    // `task_qty` is deliberately NOT carried, leaving the rework at the default
    // of 1 piece. How many of a 20-off batch actually failed is not something
    // the system knows — `scrap_qty` is captured at /stop but is not necessarily
    // the rework count — and copying 20 would plan a full second batch every
    // time one plate failed QC. Left as it was before setup existed.
    [companyId, ft.order_id, ft.item_id, ft.flow_id, ft.flow_step_id, ft.operation_id, newSeq,
     String(ft.seq_no), ft.resource_type_id, ft.computed_hours, ft.setup_hours,
     failedTaskId, (Number(ft.sort_order) || 0) + 1],
  );

  return { reworkTaskId: ins.insertId, failedSeqNo: Number(ft.seq_no) };
}
