/**
 * routes/procurement.js — the two steps that follow a finished BOM.
 *
 * Mounted separately at app.js alongside routes/criticalChain.js and
 * routes/dispatch.js, matching that precedent: this is its own concern rather
 * than another entry in the index router.
 *
 * The shape is deliberately the same as dispatch's — a preview that computes
 * and writes nothing, then a confirm that persists what was shown. A shortfall
 * is a moving number: stock arrives, another order reserves, the BOM changes.
 * Raising purchase orders straight off a computed figure would mean nobody ever
 * approved the specific list that got ordered.
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { logger } from '../../../core/utils/logger.js';
import { orderShortfall, orderProcurementSplit } from '../services/procurementService.js';
import {
  raiseProcurement, receiveAgainstLine, procurementForOrder,
} from '../services/procurementOrderService.js';
import {
  ensureProductionOrder, productionForOrder, rollUpProductionOrder,
} from '../services/productionOrderService.js';
import { releaseOrderReservations } from '../services/availabilityService.js';
import { pool } from '../../../db.js';

const router = Router();

function has(user, tag) {
  return Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(tag);
}

function ctx(req, res, tag) {
  const user = req.user;
  const companyId = user?.companyId;
  if (!companyId) {
    res.status(400).json({ message: 'Unable to determine companyId from token.' });
    return null;
  }
  if (tag && user.role !== 'admin' && !has(user, tag)) {
    res.status(403).json({ message: `Requires the ${tag} permission.` });
    return null;
  }
  return { companyId, user };
}

/**
 * GET /orders/:orderId/procurement — what has to be bought, and what is covered.
 *
 * Read-only. Reserves nothing, raises nothing.
 */
router.get('/orders/:orderId/procurement', protect, async (req, res) => {
  const c = ctx(req, res, 'fab_erp_inventory_view');
  if (!c) return;
  const orderId = Number(req.params.orderId);
  try {
    const [shortfall, orders] = await Promise.all([
      orderShortfall(c.companyId, orderId),
      procurementForOrder(c.companyId, orderId),
    ]);
    res.json({
      orderId,
      lines: shortfall.lines,
      unmatched: shortfall.unmatched,
      shortCount: shortfall.shortCount,
      purchaseOrders: orders,
    });
  } catch (err) {
    logger.error({ err, orderId }, 'procurement preview failed');
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /orders/:orderId/procurement/raise — reserve what we have, buy the rest.
 *
 * Body `{ lines?: [{catalogItemId, qty, supplierId, expectedDate?, unitPrice?}] }`.
 * Omitting `lines` reserves against the whole shortfall and then refuses every
 * purchase line for want of a supplier — which is the honest outcome, not a
 * silent no-op: the reservations are real and the skipped list says exactly
 * what still needs addressing.
 */
router.post('/orders/:orderId/procurement/raise', protect, async (req, res) => {
  const c = ctx(req, res, 'fab_erp_inventory_manage');
  if (!c) return;
  const orderId = Number(req.params.orderId);
  try {
    const result = await raiseProcurement(c.companyId, orderId, {
      lines: req.body?.lines,
      createdBy: c.user?.id ?? null,
    });
    res.json(result);
  } catch (err) {
    logger.error({ err, orderId }, 'raising procurement failed');
    res.status(500).json({ message: err.message });
  }
});

/** DELETE the order's earmarks — starting the step over, or cancelling. */
router.post('/orders/:orderId/procurement/release', protect, async (req, res) => {
  const c = ctx(req, res, 'fab_erp_inventory_manage');
  if (!c) return;
  const orderId = Number(req.params.orderId);
  try {
    const released = await releaseOrderReservations(null, c.companyId, orderId);
    res.json({ released });
  } catch (err) {
    logger.error({ err, orderId }, 'releasing reservations failed');
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /purchase-lines/:lineId/receive — book delivered stock against its line.
 *
 * Body is the stock-in payload minus catalog_item_id, which comes from the line
 * — receiving 20mm plate against a line that ordered 12mm is not a thing to
 * make expressible.
 */
router.post('/purchase-lines/:lineId/receive', protect, async (req, res) => {
  const c = ctx(req, res, 'fab_erp_inventory_manage');
  if (!c) return;
  const lineId = Number(req.params.lineId);
  try {
    const result = await receiveAgainstLine(c.companyId, lineId, req.body ?? {});
    res.json(result);
  } catch (err) {
    logger.error({ err, lineId }, 'receiving against purchase line failed');
    res.status(500).json({ message: err.message });
  }
});

/** GET the production order for a sales order, with its DAG's shape. */
router.get('/orders/:orderId/production', protect, async (req, res) => {
  const c = ctx(req, res, 'fab_erp_projects_view');
  if (!c) return;
  const orderId = Number(req.params.orderId);
  try {
    const [production, split] = await Promise.all([
      productionForOrder(c.companyId, orderId),
      orderProcurementSplit(c.companyId, orderId),
    ]);
    res.json({ orderId, production, makeItemCount: split.make.length });
  } catch (err) {
    logger.error({ err, orderId }, 'production lookup failed');
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /orders/:orderId/production/raise — create the MO and claim its tasks.
 *
 * Idempotent: one production order per sales order, so pressing this twice
 * re-claims tasks onto the existing one. That re-claim is the point — tasks
 * materialized after the order was raised would otherwise sit outside the
 * document that is supposed to be tracking them.
 */
router.post('/orders/:orderId/production/raise', protect, async (req, res) => {
  const c = ctx(req, res, 'fab_erp_projects_manage');
  if (!c) return;
  const orderId = Number(req.params.orderId);
  try {
    const mo = await ensureProductionOrder(c.companyId, orderId, { createdBy: c.user?.id ?? null });
    await rollUpProductionOrder(pool, c.companyId, mo.id);
    const production = await productionForOrder(c.companyId, orderId);
    res.json({ ...mo, production });
  } catch (err) {
    logger.error({ err, orderId }, 'raising production order failed');
    res.status(500).json({ message: err.message });
  }
});

export default router;
