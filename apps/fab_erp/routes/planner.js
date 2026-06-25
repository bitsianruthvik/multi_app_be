/**
 * planner.js — Planning Workbench routes
 *
 * GET  /planner/workbench   — demand tree of all pending planned orders
 * POST /planner/firm-tree   — firm a set of planned order IDs in one shot
 */

import { Router }  from 'express';
import { pool }    from '../../../db.js';
import { logger }  from '../../../core/utils/logger.js';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { runScheduler } from '../services/schedulerService.js';

const router = Router();

const requirePerm = (tag) => (req, res, next) => {
  if (!Array.isArray(req.user?.uiPermissions) || !req.user.uiPermissions.includes(tag)) {
    return res.status(403).json({ message: `Permission required: ${tag}` });
  }
  next();
};

// ── GET /planner/workbench ────────────────────────────────────────────────────
// Returns demand groups, each with the full BOM tree of planned orders.
router.get(
  '/planner/workbench',
  protect,
  requirePerm('fab_erp_projects_view'),
  async (req, res) => {
    const companyId = req.user.companyId ?? req.user.company_id;
    try {
      // All pending planned orders with item + stock + source sales order context
      const [rows] = await pool.query(
        `SELECT
           po.id, po.order_number, po.type, po.status,
           po.qty, po.required_date, po.scheduled_start,
           po.source_order_id, po.parent_planned_order_id,
           po.bom_id, po.catalog_item_id,

           -- Item details
           fic.name  AS item_name,
           fic.code  AS item_code,
           fic.procurement_type,
           fic.lead_time_days,

           -- Stock on hand (aggregated across locations)
           COALESCE(sb.on_hand,     0) AS stock_on_hand,
           COALESCE(sb.on_order,    0) AS stock_on_order,

           -- Source sales order (may be NULL for safety-stock demand)
           so.id           AS so_id,
           so.order_number AS so_number,
           so.order_type   AS so_order_type,
           so.customer_name,
           so.customer_po_ref,
           so.priority,
           so.notes        AS so_notes,
           so.required_date AS so_required_date,
           so.status       AS so_status

         FROM fab_orders po
         JOIN fab_item_catalog fic ON fic.id = po.catalog_item_id AND fic.deleted_at IS NULL

         LEFT JOIN (
           SELECT catalog_item_id,
                  SUM(qty_on_hand) AS on_hand,
                  SUM(qty_ordered) AS on_order
           FROM fab_stock_balances
           WHERE company_id = ? AND deleted_at IS NULL
           GROUP BY catalog_item_id
         ) sb ON sb.catalog_item_id = po.catalog_item_id

         LEFT JOIN fab_orders so
           ON so.id = po.source_order_id AND so.deleted_at IS NULL

         WHERE po.company_id = ?
           AND po.order_type  = 'planned'
           AND po.status      = 'draft'
           AND po.deleted_at  IS NULL

         ORDER BY po.source_order_id, po.parent_planned_order_id, po.id`,
        [companyId, companyId],
      );

      // Build tree grouped by source demand
      // demandKey: so_id or 'safety-stock'
      const demandMap  = new Map();  // demandKey → demandGroup
      const orderIndex = new Map();  // order id → order node

      for (const r of rows) {
        const node = {
          id:                    r.id,
          orderNumber:           r.order_number,
          type:                  r.type,
          status:                r.status,
          qty:                   Number(r.qty),
          requiredDate:          r.required_date,
          scheduledStart:        r.scheduled_start,
          sourceOrderId:         r.source_order_id,
          parentPlannedOrderId:  r.parent_planned_order_id,
          bomId:                 r.bom_id,
          catalogItemId:         r.catalog_item_id,
          itemName:              r.item_name,
          itemCode:              r.item_code,
          procurementType:       r.procurement_type,
          leadTimeDays:          r.lead_time_days,
          stockOnHand:           Number(r.stock_on_hand),
          stockOnOrder:          Number(r.stock_on_order),
          netQtyRequired:        Math.max(0, Number(r.qty)),   // already net from MRP
          children:              [],
        };
        orderIndex.set(r.id, node);

        const demandKey = r.so_id ?? 'safety-stock';
        if (!demandMap.has(demandKey)) {
          demandMap.set(demandKey, {
            demandType:    r.so_id ? 'sales_order' : 'safety_stock',
            soId:          r.so_id,
            soNumber:      r.so_number,
            soOrderType:   r.so_order_type,
            customerName:  r.customer_name,
            customerPoRef: r.customer_po_ref,
            priority:      r.priority,
            soNotes:       r.so_notes,
            soRequiredDate: r.so_required_date,
            soStatus:      r.so_status,
            orders:        [],   // flat list, used to build tree
          });
        }
        demandMap.get(demandKey).orders.push(node);
      }

      // Attach children to parents within each demand group
      for (const group of demandMap.values()) {
        const roots = [];
        for (const node of group.orders) {
          if (node.parentPlannedOrderId && orderIndex.has(node.parentPlannedOrderId)) {
            orderIndex.get(node.parentPlannedOrderId).children.push(node);
          } else {
            roots.push(node);
          }
        }
        group.tree  = roots;
        delete group.orders;  // remove flat list, only expose tree

        // Summary counts
        group.totalOrders = countNodes(roots);
        group.makeCount   = countByType(roots, 'mrp_make');
        group.buyCount    = countByType(roots, 'mrp_buy');
      }

      return res.json([...demandMap.values()]);
    } catch (err) {
      logger.error({ err }, '[planner] workbench failed');
      return res.status(500).json({ message: 'Failed to load workbench' });
    }
  },
);

// ── POST /planner/firm-tree ───────────────────────────────────────────────────
// Body: { orderIds: number[] }
// Converts mrp_make → manufacturing WO, mrp_buy → purchase order draft.
// Returns list of new order numbers.
router.post(
  '/planner/firm-tree',
  protect,
  requirePerm('fab_erp_projects_manage'),
  async (req, res) => {
    const companyId = req.user.companyId ?? req.user.company_id;
    const { orderIds } = req.body;

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ message: 'orderIds must be a non-empty array' });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Load and validate all orders
      const [orders] = await conn.query(
        `SELECT id, order_type, type, status, company_id
         FROM fab_orders
         WHERE id IN (${orderIds.map(() => '?').join(',')})
           AND company_id = ?
           AND deleted_at IS NULL`,
        [...orderIds, companyId],
      );

      // Reject if any requested IDs don't belong to this company or don't exist
      if (orders.length !== orderIds.length) {
        const foundIds = new Set(orders.map(o => o.id));
        const missingIds = orderIds.filter(id => !foundIds.has(id));
        await conn.rollback();
        return res.status(400).json({
          message: `${missingIds.length} order ID(s) not found or access denied`,
          missingIds,
        });
      }

      const invalid = orders.filter(o => o.order_type !== 'planned' || o.status !== 'draft');
      if (invalid.length) {
        await conn.rollback();
        return res.status(400).json({
          message: `${invalid.length} order(s) are not fireable (must be planned + draft)`,
          invalidIds: invalid.map(o => o.id),
        });
      }

      const datePrefix = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const [[{ woSeqStart }]] = await conn.query(
        `SELECT COUNT(*) + 1 AS woSeqStart FROM fab_orders
         WHERE company_id = ? AND order_type = 'manufacturing'`,
        [companyId],
      );
      const [[{ poSeqStart }]] = await conn.query(
        `SELECT COUNT(*) + 1 AS poSeqStart FROM fab_orders
         WHERE company_id = ? AND order_type = 'purchase'`,
        [companyId],
      );

      const firmedOrders = [];
      let woSeq = Number(woSeqStart);
      let poSeq = Number(poSeqStart);
      const makeOrderIds = [];

      for (const order of orders) {
        const isMake = order.type === 'mrp_make';
        const newType      = isMake ? 'manufacturing' : 'purchase';
        const newOrderType = isMake ? 'work_order'    : 'standard';
        const newStatus    = isMake ? 'pending_schedule' : 'draft';
        const newNumber    = isMake
          ? `WO-${datePrefix}-${String(woSeq++).padStart(4, '0')}`
          : `PO-${datePrefix}-${String(poSeq++).padStart(4, '0')}`;

        await conn.query(
          `UPDATE fab_orders
           SET order_type    = ?,
               type          = ?,
               status        = ?,
               order_number  = ?
           WHERE id = ?`,
          [newType, newOrderType, newStatus, newNumber, order.id],
        );

        await conn.query(
          `UPDATE fab_order_lines SET status = ? WHERE order_id = ? AND deleted_at IS NULL`,
          [newStatus, order.id],
        );

        firmedOrders.push({ id: order.id, orderNumber: newNumber, orderType: newType });
        if (isMake) makeOrderIds.push(order.id);
      }

      await conn.commit();

      logger.info({ companyId, firmedCount: orders.length, makeOrderIds }, '[planner] tree firmed');

      // Trigger scheduler for all make orders asynchronously
      if (makeOrderIds.length) {
        runScheduler(companyId, {
          triggeredBy: 'on_firm',
          userId:      req.user.id,
          orderIds:    makeOrderIds,
        }).catch(err => logger.error({ err }, '[planner] post-firm scheduler failed'));
      }

      return res.json({ firmed: firmedOrders });
    } catch (err) {
      await conn.rollback().catch(() => {});
      logger.error({ err }, '[planner] firm-tree failed');
      return res.status(500).json({ message: 'Failed to firm orders', error: err.message });
    } finally {
      conn.release();
    }
  },
);

// ── Helpers ───────────────────────────────────────────────────────────────────
function countNodes(nodes) {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}
function countByType(nodes, type) {
  return nodes.reduce((sum, n) => sum + (n.type === type ? 1 : 0) + countByType(n.children, type), 0);
}

export default router;
