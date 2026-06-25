/**
 * orders.js — extra order actions beyond generic CRUD
 *
 * POST /orders/:id/firm
 *   Converts a planned draft order → manufacturing work order.
 *   Requires: fab_erp_projects_manage
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import { runScheduler } from '../services/schedulerService.js';

const router = Router();

const requirePerm = (tag) => (req, res, next) => {
  if (!Array.isArray(req.user?.uiPermissions) || !req.user.uiPermissions.includes(tag)) {
    return res.status(403).json({ message: `Permission required: ${tag}` });
  }
  next();
};

// ── POST /orders/:id/firm ─────────────────────────────────────────────────────
router.post(
  '/orders/:id/firm',
  protect, requirePerm('fab_erp_projects_manage'),
  async (req, res) => {
    const orderId   = Number(req.params.id);
    const companyId = req.user.companyId ?? req.user.company_id;

    const conn = await pool.getConnection();
    let woNumber;
    try {
      await conn.beginTransaction();

      // Load and validate
      const [[order]] = await conn.query(
        `SELECT id, order_type, type, status, company_id, catalog_item_id,
                qty, required_date, bom_id, plant_id
         FROM fab_orders
         WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
        [orderId, companyId],
      );

      if (!order) {
        await conn.rollback();
        return res.status(404).json({ message: 'Order not found' });
      }
      if (order.order_type !== 'planned') {
        await conn.rollback();
        return res.status(400).json({ message: 'Only planned orders can be firmed' });
      }
      if (order.status !== 'draft') {
        await conn.rollback();
        return res.status(400).json({ message: `Cannot firm order with status "${order.status}"` });
      }

      // Generate WO number: WO-YYYYMMDD-XXXX
      const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const [[{ seq }]] = await conn.query(
        `SELECT COUNT(*) + 1 AS seq
         FROM fab_orders
         WHERE company_id = ? AND order_type = 'manufacturing'`,
        [companyId],
      );
      woNumber = `WO-${datePart}-${String(seq).padStart(4, '0')}`;

      // Convert planned → manufacturing work order
      await conn.query(
        `UPDATE fab_orders
         SET order_type = 'manufacturing',
             type       = 'work_order',
             status     = 'pending_schedule',
             order_number = ?
         WHERE id = ?`,
        [woNumber, orderId],
      );

      // Update the order line status too
      await conn.query(
        `UPDATE fab_order_lines
         SET status = 'pending_schedule'
         WHERE order_id = ? AND deleted_at IS NULL`,
        [orderId],
      );

      await conn.commit();

      logger.info({ orderId, woNumber, companyId }, '[orders] planned order firmed');

      // Trigger scheduler asynchronously — don't block the response
      runScheduler(companyId, {
        triggeredBy: 'on_firm',
        userId: req.user.id,
        orderIds: [orderId],
      }).catch((err) =>
        logger.error({ err, orderId }, '[orders] post-firm scheduler failed'),
      );

      return res.json({
        message: 'Order firmed successfully',
        orderId,
        orderNumber: woNumber,
        status: 'pending_schedule',
      });
    } catch (err) {
      await conn.rollback().catch(() => {});
      logger.error({ err, orderId }, '[orders] firm failed');
      return res.status(500).json({ message: 'Failed to firm order', error: err.message });
    } finally {
      conn.release();
    }
  },
);

export default router;
