/**
 * taskInstanceService.js
 * -----------------------
 * Task instantiation for fab_erp: materialize one fab_project_tasks row per
 * (fab_items instance × flow step) for an order.
 *
 * As of the 2026-07-20 BOM/flow remodel the core logic — flow resolution
 * (item.flow_id first, else default-BOM → active flow binding), per-task
 * fab_task_inputs, and material/component-aware first-step gating — lives in
 * the shared, connection-based `materializeOrderTasks` in taskGatingService.js,
 * so the identical code path runs both here (app, via a pool connection) and in
 * one-off maintenance scripts (via their own connection).
 *
 * This module only owns the pool connection + transaction.
 *
 * Idempotency: existing (item_id, flow_id) task combinations for the order are
 * skipped, so materializeTasks can be re-run safely.
 */

import { pool } from '../../../db.js';
import { materializeOrderTasks } from './taskGatingService.js';
import { rollUpOrderStatus } from './taskEngineService.js';

/**
 * @param {number} companyId
 * @param {number} orderId
 * @returns {Promise<{ ok: boolean, itemsProcessed: number, itemsSkipped: number, tasksInserted: number, cleared: number }>}
 */
export async function materializeTasks(companyId, orderId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await materializeOrderTasks(conn, companyId, orderId);
    // Building the DAG advances a sales order to 'scheduled' (2026-07-24 lifecycle).
    await rollUpOrderStatus(conn, companyId, orderId);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
