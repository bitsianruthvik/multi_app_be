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
import { logger } from '../../../core/utils/logger.js';
import { materializeOrderTasks } from './taskGatingService.js';
import { rollUpOrderStatus } from './taskEngineService.js';
import { buildBaseline } from './criticalChainService.js';

/**
 * EU-10 placeholder: if a portfolio drum-sequencing module has been added
 * (not built as of EU-4), ask it to resequence after a baseline changes.
 * Guarded so materializeTasks never depends on drumService existing — the
 * dynamic import simply no-ops until EU-10 drops the module in.
 */
async function triggerDrumReplanIfAvailable(companyId) {
  try {
    const mod = await import('./drumService.js');
    const replan = mod?.replan ?? mod?.default?.replan;
    if (typeof replan === 'function') {
      await replan(companyId);
    }
  } catch (err) {
    // Module not present yet (EU-10) or it threw — either way, never let this
    // affect task materialization.
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') {
      logger.warn({ err, companyId }, '[cc] drumService replan trigger failed');
    }
  }
}

/**
 * @param {number} companyId
 * @param {number} orderId
 * @returns {Promise<{ ok: boolean, itemsProcessed: number, itemsSkipped: number, tasksInserted: number, cleared: number }>}
 */
export async function materializeTasks(companyId, orderId) {
  const conn = await pool.getConnection();
  let result;
  try {
    await conn.beginTransaction();
    result = await materializeOrderTasks(conn, companyId, orderId);
    // Building the DAG advances a sales order to 'scheduled' (2026-07-24 lifecycle).
    await rollUpOrderStatus(conn, companyId, orderId);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  // EU-4: auto-baseline sales orders once their tasks are materialized.
  // Never lets a CC failure break materialization — the tasks are already
  // committed above by this point.
  try {
    const [[order]] = await pool.query(
      `SELECT order_type FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [orderId, companyId],
    );
    if (order?.order_type === 'sales') {
      await buildBaseline({ companyId, orderId });
      // EU-10 placeholder — no-ops until drumService.js exists.
      await triggerDrumReplanIfAvailable(companyId);
    }
  } catch (err) {
    logger.warn({ err, companyId, orderId }, '[cc] auto-baseline after materialize failed');
  }

  return result;
}
