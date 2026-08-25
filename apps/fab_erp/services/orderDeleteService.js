/**
 * orderDeleteService.js — deleting a sales order means deleting the order, not
 * just the row that names it.
 *
 * WHAT WENT WRONG. Delete was the generic single-row soft delete, pointed at a
 * confirmation dialog that says "this cannot be undone". It set `deleted_at` on
 * `fab_orders` and stopped. Everything hanging off the order stayed live:
 * measured on one deleted order, 2,352 BOM items, 8,858 project tasks, a
 * manufacturing order still reading `in_production`, and — the damaging one —
 * 18 stock reservations still earmarking steel for a job that no longer exists.
 *
 * None of it surfaced as an error. The order vanished from the board and its
 * work went on occupying machines, holding material, and counting toward
 * capacity, with nothing left on screen to explain why.
 *
 * ── WHAT IS DELETED, AND WHAT IS DELIBERATELY NOT ─────────────────────────
 *
 * DELETED — everything that exists only because the order does:
 *   fab_order_lines · fab_items · fab_project_tasks · fab_task_inputs
 *   fab_plan_entries · fab_cc_plans · the derived manufacturing order
 *
 * RELEASED — reservations. Not deleted: `releaseOrderReservations` walks them to
 *   `released` with a timestamp, which is what puts the steel back on the shelf
 *   for everyone else. Soft-deleting them would hide the earmark without
 *   returning the stock.
 *
 * KEPT — purchase orders, and this is the important judgement here. A PO raised
 *   from this order is an agreement with a supplier; one already received turned
 *   into stock pieces that are physically in the yard. Cancelling it would
 *   un-tell a story that actually happened. They are reported back instead, so
 *   whoever deleted the order can decide what to do about a live commitment.
 *
 * KEPT — issued nests (`fab_nest_issues`), for the same reason: an issue record
 *   says plate left the store. That happened whatever becomes of the order.
 *
 * ── WHY SOFT, WHEN THE DIALOG SAYS OTHERWISE ──────────────────────────────
 * Every table here uses `deleted_at`, and the whole app filters on it. "Cannot
 * be undone" is true from the user's side — nothing in the product will bring it
 * back — while leaving the rows recoverable by hand, which has already been
 * worth having once.
 */

import { pool } from '../../../db.js';
import { releaseOrderReservations } from './availabilityService.js';
import { logger } from '../../../core/utils/logger.js';

/**
 * Delete a sales order and everything that belongs to it.
 *
 * @returns {Promise<{orderNumber:string, deleted:Record<string,number>,
 *   reservationsReleased:number, purchaseOrdersKept:object[]}>}
 */
export async function deleteSalesOrder(companyId, orderId, existingConn = null) {
  const conn = existingConn ?? await pool.getConnection();
  const owned = !existingConn;

  try {
    if (owned) await conn.beginTransaction();

    const [[order]] = await conn.query(
      `SELECT id, order_number, order_type FROM fab_orders
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [orderId, companyId],
    );
    if (!order) { const e = new Error('That order does not exist.'); e.status = 404; throw e; }

    const deleted = {};
    const soft = async (label, sql, params) => {
      const [r] = await conn.query(sql, params);
      deleted[label] = r.affectedRows || 0;
    };

    /**
     * Task inputs FIRST, while their tasks are still findable. They carry an
     * `order_id` of their own, but the join is what catches inputs written
     * against a task whose order column was never backfilled.
     */
    await soft('taskInputs',
      `UPDATE fab_task_inputs i
         JOIN fab_project_tasks t ON t.id = i.task_id
          SET i.deleted_at = UTC_TIMESTAMP()
        WHERE i.company_id = ? AND t.order_id = ? AND i.deleted_at IS NULL`,
      [companyId, orderId]);

    await soft('tasks',
      `UPDATE fab_project_tasks SET deleted_at = UTC_TIMESTAMP()
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
      [companyId, orderId]);

    await soft('planEntries',
      `UPDATE fab_plan_entries SET deleted_at = UTC_TIMESTAMP()
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
      [companyId, orderId]);

    await soft('items',
      `UPDATE fab_items SET deleted_at = UTC_TIMESTAMP()
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
      [companyId, orderId]);

    await soft('lines',
      `UPDATE fab_order_lines SET deleted_at = UTC_TIMESTAMP()
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
      [companyId, orderId]);

    /**
     * The critical-chain baseline. It is rebuilt from scratch on every
     * re-baseline anyway, so there is nothing here worth keeping once the tasks
     * it describes are gone.
     */
    await soft('criticalChainPlans',
      `UPDATE fab_cc_plans SET deleted_at = UTC_TIMESTAMP()
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
      [companyId, orderId]);

    /** The manufacturing order exists only to carry this order's tasks. */
    await soft('manufacturingOrders',
      `UPDATE fab_orders SET deleted_at = UTC_TIMESTAMP()
        WHERE company_id = ? AND source_order_id = ? AND order_type = 'manufacturing'
          AND deleted_at IS NULL`,
      [companyId, orderId]);

    // Released, not deleted — this is what puts the steel back on the shelf.
    const released = await releaseOrderReservations(conn, companyId, orderId);

    /**
     * Purchase orders are reported, never cancelled. One already received has
     * become stock that is physically in the yard.
     */
    const [pos] = await conn.query(
      `SELECT id, order_number AS orderNumber, status FROM fab_orders
        WHERE company_id = ? AND source_order_id = ? AND order_type = 'purchase'
          AND deleted_at IS NULL`,
      [companyId, orderId],
    );

    await soft('order',
      `UPDATE fab_orders SET deleted_at = UTC_TIMESTAMP()
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [orderId, companyId]);

    if (owned) await conn.commit();

    const result = {
      orderNumber: order.order_number,
      deleted,
      reservationsReleased: Number(released) || 0,
      purchaseOrdersKept: pos,
    };
    logger.info({ companyId, orderId, ...result }, 'fab_erp: sales order deleted with its tree');
    return result;
  } catch (err) {
    if (owned) await conn.rollback();
    throw err;
  } finally {
    if (owned) conn.release();
  }
}
