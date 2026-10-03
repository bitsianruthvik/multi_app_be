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
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { isPermitted } from '../../../core/middleware/requirePerm.js';
import {
  purchaseBoard, orderPurchase, requestFromOrder, stockCheck, applyStockCheck, sendRfq, poQuotes, recordQuote, placeOrder,
} from '../services/purchaseFlowService.js';

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

router.get('/purchase/board', view, handle((req) => purchaseBoard(pool, ctx(req).companyId, req.query)));
router.get('/orders/:id/purchase', view, handle((req) => orderPurchase(pool, ctx(req).companyId, id(req))));
router.post('/orders/:id/purchase-request', manage, handle((req) => tx(req, (db, c) => requestFromOrder(db, c, id(req), body(req)))));
router.get('/purchase-orders/:id/stock-check', view, handle((req) => stockCheck(pool, pctx(req), id(req))));
router.post('/purchase-orders/:id/stock-check', manage, handle((req) => tx(req, (db, c) => applyStockCheck(db, c, id(req), body(req)))));
router.post('/purchase-orders/:id/rfq', manage, handle((req) => tx(req, (db, c) => sendRfq(db, c, id(req), body(req)))));
router.get('/purchase-orders/:id/quotes', view, handle((req) => poQuotes(pool, pctx(req), id(req))));
router.post('/purchase-orders/:id/quotes', manage, handle((req) => tx(req, (db, c) => recordQuote(db, c, id(req), body(req)))));
router.post('/purchase-orders/:id/place', manage, handle((req) => tx(req, (db, c) => placeOrder(db, c, id(req), body(req)))));

export default router;
