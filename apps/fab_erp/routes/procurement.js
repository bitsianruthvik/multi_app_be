/**
 * routes/procurement.js — the two steps that follow a finished BOM.
 *
 * Mounted separately at app.js alongside routes/criticalChain.js and
 * routes/planner.js, matching that precedent: this is its own concern rather
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
  raiseProcurement, receiveAgainstLine, receiveAgainstOrder, procurementForOrder,
  openPurchaseOrders, purchaseOrderLines,
} from '../services/procurementOrderService.js';
import {
  ensureProductionOrder, productionForOrder, approveProductionOrder,
} from '../services/productionOrderService.js';
import { rollUpOrderStatus } from '../services/taskEngineService.js';
import { releaseOrderReservations } from '../services/availabilityService.js';
import { checkOrderNesting, blockingIssues } from '../services/nestingIntegrityService.js';
import { missingFieldsForOrder } from '../services/itemFieldService.js';
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
 * GET /orders/:orderId/nesting/integrity — what is wrong with this nesting.
 *
 * Read-only, and the same answer the raise gate uses, so the screen can never
 * show a clean nesting that procurement then refuses.
 */
router.get('/orders/:orderId/nesting/integrity', protect, async (req, res) => {
  const c = ctx(req, res, 'fab_erp_inventory_view');
  if (!c) return;
  const orderId = Number(req.params.orderId);
  try {
    const result = await checkOrderNesting(c.companyId, orderId);
    res.json({ ...result, blocking: blockingIssues(result) });
  } catch (err) {
    logger.error({ err, orderId }, 'nesting integrity check failed');
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
    /**
     * Refuse to buy plate for a nesting that cannot work.
     *
     * A purchase order is where a nesting mistake stops being free. Up to this
     * point a wrong thickness or a part bigger than its plate is a row somebody
     * can correct; past it, steel has been ordered against it — and the sizes
     * being bought ARE the declared plate sizes, so an impossible nest buys
     * impossible material.
     *
     * The two kinds refused read differently and both matter: a MISSING
     * dimension means nobody has finished the job, and an IMPOSSIBLE one means
     * somebody finished it wrong. Buying a plate for a part of unknown size is
     * exactly as useless as buying one that cannot hold it.
     *
     * `{force:true}` proceeds, the same escape as the production-order gate —
     * a buyer who knows the sheet is behind reality should not be stuck.
     */
    if (!req.body?.force) {
      const nesting = await checkOrderNesting(c.companyId, orderId);
      const blocking = blockingIssues(nesting);
      if (blocking.length > 0) {
        return res.status(409).json({
          code: 'NESTING_INVALID',
          message: `${blocking.length} problem(s) would make this order's nesting impossible to cut. `
                 + 'Buying against it would order the wrong material.',
          detail: { issues: blocking, summary: nesting.summary, checked: nesting.checked },
        });
      }
    }

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

/**
 * GET /purchase-orders — what can still be received against.
 *
 * The goods-receipt screen's entry point. Deliberately NOT scoped to a sales
 * order, unlike /orders/:id/procurement: whoever is receiving a delivery has a
 * PO number on a note and no idea which sales order caused it.
 *
 * `?all=1` includes fully received and cancelled orders, for looking one up
 * after the fact.
 */
router.get('/purchase-orders', protect, async (req, res) => {
  const c = ctx(req, res, 'fab_erp_inventory_view');
  if (!c) return;
  try {
    const orders = await openPurchaseOrders(c.companyId, {
      includeClosed: req.query.all === '1' || req.query.all === 'true',
    });
    res.json({ orders });
  } catch (err) {
    logger.error({ err }, 'listing purchase orders failed');
    res.status(500).json({ message: err.message });
  }
});

/** GET one purchase order's lines, each with what is still outstanding. */
router.get('/purchase-orders/:poId/lines', protect, async (req, res) => {
  const c = ctx(req, res, 'fab_erp_inventory_view');
  if (!c) return;
  const poId = Number(req.params.poId);
  try {
    res.json({ poId, lines: await purchaseOrderLines(c.companyId, poId) });
  } catch (err) {
    logger.error({ err, poId }, 'reading purchase order lines failed');
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /purchase-orders/:poId/receive — book a whole delivery in one go.
 *
 * Body `{plant_id, stock_location_id, received_date, notes?, lines:[{line_id,
 * qty, heat_no?, batch_no?}]}`. One transaction across every line, because a
 * delivery note is one document: half of it landing is worse than none of it.
 */
router.post('/purchase-orders/:poId/receive', protect, async (req, res) => {
  const c = ctx(req, res, 'fab_erp_inventory_manage');
  if (!c) return;
  const poId = Number(req.params.poId);
  try {
    res.json(await receiveAgainstOrder(c.companyId, poId, req.body ?? {}));
  } catch (err) {
    logger.error({ err, poId }, 'receiving against purchase order failed');
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
    /**
     * The gate. Raising the order MATERIALIZES the DAG, and materialization is
     * where every formula is evaluated and frozen onto its task — so a part
     * missing a value its flow needs does not fail here, it gets a duration
     * computed from zero. Everything after inherits it: capacity, the critical
     * chain, the buffer, the promised date. Catching it now costs a dialog;
     * catching it later means re-materializing an order that has started.
     *
     * Refused, not blocked. `{force:true}` proceeds and is the honest escape for
     * a shop that knows its estimate is rough and wants the tasks anyway — the
     * same shape as the unresolved-formula save and the output-blocked start.
     */
    if (!req.body?.force) {
      const readiness = await missingFieldsForOrder(c.companyId, orderId);
      if (readiness.itemsShort > 0 || readiness.unknownFields.length > 0) {
        return res.status(409).json({
          code: 'FIELDS_MISSING',
          message: readiness.itemsShort > 0
            ? `${readiness.itemsShort} of ${readiness.itemsChecked} part(s) are missing values their operations need. `
              + 'Their tasks would be estimated as taking no time.'
            : 'Some operations reference fields that do not exist, so they estimate as zero.',
          detail: readiness,
        });
      }
    }

    const mo = await ensureProductionOrder(c.companyId, orderId, { createdBy: c.user?.id ?? null });
    // rollUpOrderStatus refreshes the production order and then mirrors it onto
    // the sales order — one call keeps both right.
    await rollUpOrderStatus(pool, c.companyId, orderId);
    const production = await productionForOrder(c.companyId, orderId);
    res.json({ ...mo, production });
  } catch (err) {
    logger.error({ err, orderId }, 'raising production order failed');
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /production-orders/:moId/approve — the one transition a person makes.
 *
 * Everything after it follows from the shop floor: waiting until material
 * turns up, in production once a task can actually be started.
 */
router.post('/production-orders/:moId/approve', protect, async (req, res) => {
  const c = ctx(req, res, 'fab_erp_projects_manage');
  if (!c) return;
  const moId = Number(req.params.moId);
  try {
    const state = await approveProductionOrder(c.companyId, moId);
    // Approval changes the production order, and the sales order mirrors it.
    const [[link]] = await pool.query(
      `SELECT source_order_id AS soId FROM fab_orders WHERE id = ? AND company_id = ? LIMIT 1`,
      [moId, c.companyId],
    );
    if (link?.soId) await rollUpOrderStatus(pool, c.companyId, link.soId);
    res.json({ ok: true, ...state });
  } catch (err) {
    logger.error({ err, moId }, 'approving production order failed');
    res.status(500).json({ message: err.message });
  }
});

export default router;
