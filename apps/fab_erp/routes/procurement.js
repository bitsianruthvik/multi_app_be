/**
 * routes/procurement.js — buying, cutting and making: the production step.
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
import { fail, isPermitted } from '../../../core/middleware/requirePerm.js';
import {
  requestProcurement, sendPurchaseRequest, receiveAgainstLine, receiveAgainstOrder,
  openPurchaseOrders, purchaseOrderLines,
} from '../services/procurementOrderService.js';
import { deployProductionOrder } from '../services/productionOrderService.js';
import { productionPlan, setStepTime, raiseDraft } from '../services/productionPlanService.js';
import { rollUpOrderStatus } from '../services/taskEngineService.js';
import { checkOrderNesting, blockingIssues, advisoryIssues } from '../services/nestingIntegrityService.js';
import { missingFieldsForOrder } from '../services/itemFieldService.js';
import { raiseSubcontractOrder } from '../services/subcontractService.js';
import { orderReadiness, refreshOrderStage } from '../services/orderReadinessService.js';
import { pool } from '../../../db.js';

const router = Router();

function ctx(req, res, tag) {
  const user = req.user;
  const companyId = user?.companyId;
  if (!companyId) {
    res.status(400).json({ message: 'Unable to determine companyId from token.' });
    return null;
  }
  if (tag && !isPermitted(user, tag)) {
    res.status(403).json({ message: `Requires the ${tag} permission.` });
    return null;
  }
  return { companyId, user };
}

/**
 * GET /orders/:orderId/production-plan — the production step in one read: what
 * is bought, and both production orders as their BOM with each row's steps.
 */
router.get('/orders/:orderId/production-plan', protect, async (req, res) => {
  const c = ctx(req, res, 'fab_erp_projects_view');
  if (!c) return;
  const orderId = Number(req.params.orderId);
  try {
    res.json(await productionPlan(c.companyId, orderId));
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * PUT /orders/:orderId/production-plan/time — type over one step's time.
 * Body `{ itemId, stepId, minutes }`; minutes is per piece, null clears it.
 */
router.put('/orders/:orderId/production-plan/time', protect, async (req, res) => {
  const c = ctx(req, res, 'fab_erp_projects_manage');
  if (!c) return;
  const orderId = Number(req.params.orderId);
  try {
    const { itemId, stepId, minutes } = req.body ?? {};
    const result = await setStepTime(c.companyId, orderId, Number(itemId), Number(stepId), minutes, c.user?.id ?? null);
    // REPAIR-E item 4: the wizard's Production step reads this response's own
    // readiness rather than re-fetching (EU-7's shape) — `hint:'production'`
    // is cheap here (skips the other three stages' queries) since a step-time
    // edit can only ever move the production stage.
    const readiness = await refreshOrderStage(c.companyId, orderId, { hint: 'production' });
    res.json({ ...result, readiness });
  } catch (err) {
    return fail(res, err);
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
    // Both buckets, named. An advisory is a real finding that simply does not
    // stop the order — "this part is not on a nest yet" is the normal state of
    // a fresh job, and blocking a purchase order on it stopped legitimate
    // buying. Returning it separately means a caller can show the count
    // without re-deriving the split by filtering issues client-side.
    res.json({ ...result, blocking: blockingIssues(result), advisory: advisoryIssues(result) });
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * POST /orders/:orderId/procurement/request — take from stock, ask for the rest.
 *
 * Body `{ lines: [{ catalogItemId, take }] }` — how much of each bought item to
 * take off the shelf. Everything still needed goes on the order's one purchase
 * request, rewritten in place if it is already there.
 */
router.post('/orders/:orderId/procurement/request', protect, async (req, res) => {
  const c = ctx(req, res, 'fab_erp_inventory_manage');
  if (!c) return;
  const orderId = Number(req.params.orderId);
  try {
    const result = await requestProcurement(c.companyId, orderId, req.body?.lines ?? [], { createdBy: c.user?.id ?? null });
    const readiness = await refreshOrderStage(c.companyId, orderId, { hint: 'production' });
    res.json({ ...result, readiness });
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * POST /orders/:orderId/subcontract/request — send named steps out to a
 * supplier. Body `{ supplierId, taskIds }`.
 *
 * Raises a NEW `fab_orders` row every call (unlike `/procurement/request`,
 * which rewrites one open request) — several subcontract orders against one
 * sales order are legitimate (EU-14/EU-1), so there is nothing to rewrite.
 * Same tag as the rest of the Production step (`fab_erp_projects_manage`):
 * this is the Subcontract section of that screen, not an inventory action.
 */
router.post('/orders/:orderId/subcontract/request', protect, async (req, res) => {
  const c = ctx(req, res, 'fab_erp_projects_manage');
  if (!c) return;
  const orderId = Number(req.params.orderId);
  try {
    const order = await raiseSubcontractOrder(
      c.companyId, orderId, req.body?.supplierId, req.body?.taskIds ?? [],
      { createdBy: c.user?.id ?? null },
    );
    res.json({ ok: true, order, readiness: await orderReadiness(c.companyId, orderId) });
  } catch (err) {
    return fail(res, err);
  }
});

/** POST /purchase-orders/:poId/send — name the supplier and send a request. */
router.post('/purchase-orders/:poId/send', protect, async (req, res) => {
  const c = ctx(req, res, 'fab_erp_inventory_manage');
  if (!c) return;
  const poId = Number(req.params.poId);
  try {
    const result = await sendPurchaseRequest(c.companyId, poId, Number(req.body?.supplierId));
    // The PO row IS the readiness signal for its own sales order — resolve it
    // by `source_order_id`, the same lookup /deploy already does below.
    const [[link]] = await pool.query(
      `SELECT source_order_id AS soId FROM fab_orders WHERE id = ? AND company_id = ? LIMIT 1`,
      [poId, c.companyId],
    );
    const readiness = link?.soId ? await refreshOrderStage(c.companyId, link.soId, { hint: 'production' }) : undefined;
    res.json({ ...result, readiness });
  } catch (err) {
    return fail(res, err);
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
    return fail(res, err);
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
    return fail(res, err);
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
    return fail(res, err);
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
    return fail(res, err);
  }
});

/**
 * POST /orders/:orderId/production/draft — raise, or bring up to date, the draft
 * production order for cutting or for fabrication. Body `{ purpose }`.
 *
 * Idempotent: one of each per sales order, so pressing this again refreshes the
 * draft's tasks — times typed over, quantities changed — rather than raising a
 * second one.
 */
router.post('/orders/:orderId/production/draft', protect, async (req, res) => {
  const c = ctx(req, res, 'fab_erp_projects_manage');
  if (!c) return;
  const orderId = Number(req.params.orderId);
  const purpose = req.body?.purpose === 'cutting' ? 'cutting' : 'fabrication';
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

    /**
     * The SECOND gate, and the one Procurement has always had: parts that
     * cannot physically be cut.
     *
     * Procurement refused to buy against broken nesting while Production
     * happily built tasks against the identical errors — same facts, opposite
     * answers, and the production side is the one that puts work on a shop
     * floor. Enforced HERE rather than only in the client because the Production
     * tab needs `fab_erp_projects_view` while the integrity read needs
     * `fab_erp_inventory_view`, so a projects-only user fell straight through a
     * client-side check, as does any other caller of this endpoint.
     *
     * Same `{force:true}` escape as the gate above, so a shop that knows better
     * is never trapped.
     */
    if (!req.body?.force && !req.body?.ignoreNesting) {
      const nesting = await checkOrderNesting(c.companyId, orderId);
      const blocking = blockingIssues(nesting);
      if (blocking.length > 0) {
        return res.status(409).json({
          code: 'NESTING_INVALID',
          message: `${blocking.length} problem(s) would make this order impossible to cut. `
            + 'Building tasks against it would put work on the floor for parts nobody can make.',
          detail: { blocking },
        });
      }
    }

    const mo = await raiseDraft(c.companyId, orderId, purpose, c.user?.id ?? null);
    // rollUpOrderStatus refreshes the production orders and then mirrors them
    // onto the sales order — one call keeps both right.
    await rollUpOrderStatus(pool, c.companyId, orderId);
    const readiness = await refreshOrderStage(c.companyId, orderId, { hint: 'production' });
    res.json({ ...mo, readiness });
  } catch (err) {
    // EU-13 found this hardcoded to 500 regardless of err.status — a quote's
    // QUOTE_CANNOT_RAISE (409) from raiseDraft showed up as a plain 500. The
    // two explicit 409s above (FIELDS_MISSING/NESTING_INVALID) return early
    // and never reach here, so their `force`/`detail` shape is unchanged.
    return fail(res, err);
  }
});

/**
 * POST /production-orders/:moId/deploy — send a draft production order to the
 * shop. Codes are written (BOM rows and tasks, from the code generator) and from
 * here the order follows the floor: waiting until material turns up, in
 * production once a task can start.
 *
 * Body `{ redeploy: true }` (EU-12): re-plan a NON-draft production order
 * (one already on the floor, after a revision changed its BOM) without
 * regressing its status — the ordinary path here is draft-only.
 */
router.post('/production-orders/:moId/deploy', protect, async (req, res) => {
  const c = ctx(req, res, 'fab_erp_projects_manage');
  if (!c) return;
  const moId = Number(req.params.moId);
  const redeploy = req.body?.redeploy === true;
  try {
    const state = await deployProductionOrder(c.companyId, moId, { redeploy });
    // Deploying changes the production order, and the sales order mirrors it.
    const [[link]] = await pool.query(
      `SELECT source_order_id AS soId FROM fab_orders WHERE id = ? AND company_id = ? LIMIT 1`,
      [moId, c.companyId],
    );
    if (link?.soId) await rollUpOrderStatus(pool, c.companyId, link.soId);
    const readiness = link?.soId ? await refreshOrderStage(c.companyId, link.soId, { hint: 'production' }) : undefined;
    res.json({ ok: true, ...state, readiness });
  } catch (err) {
    return fail(res, err);
  }
});

export default router;
