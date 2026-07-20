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
      `SELECT id, item_id, flow_id, seq_no FROM fab_project_tasks
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

    await conn.commit();
    return { ok: true, completedTaskId: taskId, successorsCleared };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
