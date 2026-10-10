/**
 * purchaseFlow.js — ONE purchase order, stage by stage (CF_ERP_PURCHASE_FLOW_PLAN.md, §46).
 *   GET  /purchase/board?orderId=&supplierId=&search=   every open PO in its lane
 *   GET  /orders/:id/purchase                          a sales order's shortfall + its POs by lane
 *   POST /orders/:id/purchase-request                  { lines?: [{ itemId, quantity }], notes? } → a REQUESTED PO
 *   GET  /purchase-orders/:id/stock-check              free stock per line, proposed holds
 *   POST /purchase-orders/:id/stock-check              { lines: [{ lineId, hold }] } — hold for the order, cut the PO
 *   POST /purchase-orders/:id/rfq                      { supplierIds, quotesDue?, terms? } — send / add suppliers
 *   GET  /purchase-orders/:id/quotes                   the RFQ under the PO, quotes, per-line comparison
 *   POST /purchase-orders/:id/quotes                   one supplier's quotation (as POST /rfqs/:id/quotes)
 *   POST /purchase-orders/:id/place                    { awards: [{ rfqLineId, quoteLineId }] } — accept + place, split per supplier
 * Placing straight with a known supplier is POST /purchase-orders/:id/order; the
 * GRN is POST /purchase-lines/:id/receive; expected dates PUT /purchase-lines/:id.
 *
 * BUYING V2 (init.sql §56, contract TM/CF_ERP_BUYING_V2.md) — the REQUISITION of a sales-order
 * line, and the material-ready state production waits on. Every route above still answers.
 *   GET  /orders/:id/requisitions                   the order's requisitions (cover, statuses, material-ready) + lines without one
 *   POST /orders/:id/requisitions                   { lineIds?, notes? } — raise / bring up to date. Earmarks nothing.
 *   GET  /order-lines/:id/requisition               one line's requisition (or what it would ask for)
 *   GET  /order-lines/:id/material-ready            the line's material-ready state, material by material
 *   GET  /requisitions/:id
 *   POST /requisitions/:id/stock-check              { apply?, lineIds?, lines?: [{ lineId, hold }] } — dry run by default; apply HOLDS
 *   POST /requisitions/:id/skip                     { lineIds? | all: true, note? } — do not buy: wait for stock
 *   POST /requisitions/:id/unskip                   { lineIds? | all: true }
 *   POST /requisitions/purchase-orders              { orders: [{ supplierId?, expectedDate?, place?, lines: [{ prLineId, quantity?, expectedDate? }] }] }
 *   POST /requisition-lines/:id/release-excess      { apply? } — more is held / coming than the line needs: let it go
 *   GET  /buying/board?orderId=&search=             requisitions by status, and lines that have none yet
 * A PO line's date and quantity: PUT /purchase-lines/:id (as before). Seeing needs inventory view;
 * raising, holding, skipping and ordering need inventory manage — the purchase routes' own grants.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam, assertPerm } from '../lib/http.js';
import { isPermitted } from '../../../core/middleware/requirePerm.js';
import {
  purchaseBoard, orderPurchase, requestFromOrder, stockCheck, applyStockCheck, sendRfq, poQuotes, recordQuote, placeOrder,
} from '../services/purchaseFlowService.js';
import {
  orderRequisitions, raiseRequisitions, lineRequisition, getRequisition, stockCheck as requisitionStockCheck, setSkip,
  makePurchaseOrders, releaseExcess, buyingBoard,
} from '../services/requisitionService.js';
import { lineMaterialReady } from '../services/materialReadyService.js';

const router = Router();
const id = (req) => intParam(req.params.id);
const pctx = (req) => ({
  ...ctx(req),
  canManage: isPermitted(req.user, PERM.inventory),
  canApprove: isPermitted(req.user, PERM.purchaseApprove),
  isAdmin: String(req.user?.role ?? '').toLowerCase() === 'admin',
});
const tx = (req, fn) => withTransaction((db) => fn(db, pctx(req)));
const view = guard(PERM.inventoryView);
const manage = guard(PERM.inventory);
const body = (req) => req.body ?? {};
const applies = (b) => b.apply === true || b.apply === 'true';

router.get('/purchase/board', view, handle((req) => purchaseBoard(pool, ctx(req).companyId, req.query)));
router.get('/orders/:id/purchase', view, handle((req) => orderPurchase(pool, ctx(req).companyId, id(req))));
router.post('/orders/:id/purchase-request', manage, handle((req) => tx(req, (db, c) => requestFromOrder(db, c, id(req), body(req)))));
router.get('/purchase-orders/:id/stock-check', view, handle((req) => stockCheck(pool, pctx(req), id(req))));
router.post('/purchase-orders/:id/stock-check', manage, handle((req) => tx(req, (db, c) => applyStockCheck(db, c, id(req), body(req)))));
router.post('/purchase-orders/:id/rfq', manage, handle((req) => tx(req, (db, c) => sendRfq(db, c, id(req), body(req)))));
router.get('/purchase-orders/:id/quotes', view, handle((req) => poQuotes(pool, pctx(req), id(req))));
router.post('/purchase-orders/:id/quotes', manage, handle((req) => tx(req, (db, c) => recordQuote(db, c, id(req), body(req)))));
router.post('/purchase-orders/:id/place', manage, handle((req) => tx(req, (db, c) => placeOrder(db, c, id(req), body(req)))));

// --- Buying v2: requisitions and material-ready (§56) ---------------------------------------
router.get('/orders/:id/requisitions', view, handle((req) => orderRequisitions(pool, ctx(req).companyId, id(req))));
router.post('/orders/:id/requisitions', manage, handle((req) => tx(req, (db, c) => raiseRequisitions(db, c, id(req), body(req)))));
router.get('/order-lines/:id/requisition', view, handle((req) => lineRequisition(pool, ctx(req).companyId, id(req))));
router.get('/order-lines/:id/material-ready', view, handle((req) => lineMaterialReady(pool, ctx(req).companyId, id(req))));
router.post('/requisitions/purchase-orders', manage, handle((req) => tx(req, (db, c) => makePurchaseOrders(db, c, body(req)))));
router.get('/requisitions/:id', view, handle((req) => getRequisition(pool, ctx(req).companyId, id(req))));
// The dry run (the default) only reads, so seeing is enough; applying it HOLDS stock and needs the manage grant.
router.post('/requisitions/:id/stock-check', view, handle((req) => {
  if (applies(body(req))) assertPerm(req, PERM.inventory);
  return tx(req, (db, c) => requisitionStockCheck(db, c, id(req), body(req)));
}));
router.post('/requisitions/:id/skip', manage, handle((req) => tx(req, (db, c) => setSkip(db, c, id(req), body(req), true))));
router.post('/requisitions/:id/unskip', manage, handle((req) => tx(req, (db, c) => setSkip(db, c, id(req), body(req), false))));
router.post('/requisition-lines/:id/release-excess', view, handle((req) => {
  if (applies(body(req))) assertPerm(req, PERM.inventory);
  return tx(req, (db, c) => releaseExcess(db, c, id(req), body(req)));
}));
router.get('/buying/board', view, handle((req) => buyingBoard(pool, ctx(req).companyId, req.query)));

export default router;
