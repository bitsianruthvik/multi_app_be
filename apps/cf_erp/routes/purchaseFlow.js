/**
 * purchaseFlow.js — the MATERIAL REQUEST (MR) of a sales order and the material-ready state production waits on
 * (BUYING V2, init.sql §56 + §66 + §68; contract TM/CF_ERP_BUYING_V2.md).
 *   GET  /orders/:id/requisitions                   the order's MRs (cover, statuses, material-ready) + lines without one
 *   POST /orders/:id/requisitions                   { lineIds?, notes?, earmark?, customerDate? } — RAISE / bring up to date
 *                                                   (orders manage OR inventory manage; reads: orders view OR inventory view).
 *                                                   The sales order's only buying action (§71); everything after it is in
 *                                                   Purchase (routes/purchaseRequests.js). A customer-supplied MR earmarks the
 *                                                   customer's own lots and asks the rest of the customer on a ₹0 PO to them.
 *   GET  /order-lines/:id/requisition               one line's MR (or what it would ask for)
 *   GET  /order-lines/:id/material-ready            the line's material-ready state, material by material
 *   GET  /requisitions/:id
 *   PUT  /order-lines/:id/material-supply           { supply: 'we_buy' | 'customer' | null } — who supplies the line's material (§66)
 *   GET  /customer-material/returns?orderId=&partyId= customer material to go back, and substitutes (§68)
 * PURCHASE FLOW v3 (§71, 2026-10-18) REMOVED from here: the purchase board and a sales order's lanes (/purchase/board,
 * /orders/:id/purchase), the requested-PO flow (/orders/:id/purchase-request, /purchase-orders/:id/stock-check|rfq|quotes|place),
 * the MR board (/buying/board), the MR stock check, skip / unskip, release-excess and POs straight from MR lines
 * (/requisitions/purchase-orders). The MR screen, the PR with its vendor columns and "Raise PO" replace them.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guardAny, handle, ctx, intParam } from '../lib/http.js';
import { orderRequisitions, raiseRequisitions, lineRequisition, getRequisition } from '../services/requisitionService.js';
import { lineMaterialReady } from '../services/materialReadyService.js';
import { setLineSupply } from '../services/salesOrderService.js';
import { customerReturns } from '../services/customerMaterialService.js';

const router = Router();
const id = (req) => intParam(req.params.id);
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
// User 2026-10-27: the sales order raises its own MR (a request TO Stores) — whoever manages orders (Sales) may raise it
// and say who supplies a line's material, as Stores (inventory manage) always could; seeing it, orders view or inventory view.
const view = guardAny(PERM.inventoryView);
const orderView = guardAny(PERM.inventoryView, PERM.ordersView);
const manage = guardAny(PERM.inventory, PERM.orders);
const body = (req) => req.body ?? {};

router.get('/orders/:id/requisitions', orderView, handle((req) => orderRequisitions(pool, ctx(req).companyId, id(req))));
router.post('/orders/:id/requisitions', manage, handle((req) => tx(req, (db, c) => raiseRequisitions(db, c, id(req), body(req)))));
router.get('/order-lines/:id/requisition', orderView, handle((req) => lineRequisition(pool, ctx(req).companyId, id(req))));
router.get('/order-lines/:id/material-ready', orderView, handle((req) => lineMaterialReady(pool, ctx(req).companyId, id(req))));
router.get('/requisitions/:id', view, handle((req) => getRequisition(pool, ctx(req).companyId, id(req))));
router.put('/order-lines/:id/material-supply', manage, handle((req) => tx(req, (db, c) => setLineSupply(db, c, id(req), body(req)))));
// §68: customer material to go back (extra, a substitute not accepted) and the substitutes, by order or customer.
router.get('/customer-material/returns', view, handle((req) => customerReturns(pool, ctx(req).companyId, req.query)));

export default router;
