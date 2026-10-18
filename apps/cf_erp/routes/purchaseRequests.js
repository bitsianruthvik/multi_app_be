/**
 * purchaseRequests.js — PURCHASE FLOW v3 (init.sql §71, 2026-10-18; contract TM/CF_ERP_BUYING_V2.md "2026-10-18").
 * Service: services/purchaseRequestService.js. The MR is raised from the sales order (POST /orders/:id/requisitions);
 * everything after it is here.
 *
 *   GET    /material-requests?orderId=&search=&open=          every MR, one row each, with its PR
 *   GET    /material-requests/:id                              the MR screen: required / in stock / take from stock / to buy / locked
 *   PUT    /material-requests/:id { lines: [{ lineId, takeFromStock }], customerDate? }
 *                                                              earmark what is taken, make / update the PR (we buy) or the
 *                                                              customer's ₹0 PO (customer supplies)
 *   GET    /purchase-requests?status=open|all|<status>&search=&orderId=
 *   GET    /purchase-requests/:id                              the grid: lines × vendor columns, quotes, PO raised
 *   POST   /purchase-requests/:id/vendors { supplierId }       a vendor column
 *   PUT    /purchase-request-vendors/:id { supplierId }        another vendor in that column
 *   DELETE /purchase-request-vendors/:id
 *   PUT    /purchase-request-vendors/:id/quotes { quotes: [{ lineId, rate, deliveryDays?, remark? }] }   rate blank = no quote
 *   GET    /purchase-request-vendors/:id/pending-pos           that vendor's POs still waiting for MD approval (to add to)
 *   POST   /purchase-request-vendors/:id/purchase-orders { lines: [{ lineId, quantity }], addToPoId?, notes? }
 *                                                              → { purchaseOrder (pending MD approval), purchaseRequest }
 * Reading needs inventory view; changing needs inventory manage (the purchase routes' own grants).
 * The MD's approval and the close are on routes/purchase.js (POST /purchase-orders/:id/approve | /close).
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import {
  listMrs, mrScreen, saveMr, listPrs, getPr, addVendor, setVendor, removeVendor, setQuotes, raisePo, pendingPosOfVendor,
} from '../services/purchaseRequestService.js';

const router = Router();
const id = (req) => intParam(req.params.id);
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const view = guard(PERM.inventoryView);
const manage = guard(PERM.inventory);
const body = (req) => req.body ?? {};
const company = (req) => ctx(req).companyId;

router.get('/material-requests', view, handle((req) => listMrs(pool, company(req), req.query)));
router.get('/material-requests/:id', view, handle((req) => mrScreen(pool, company(req), id(req))));
router.put('/material-requests/:id', manage, handle((req) => tx(req, (db, c) => saveMr(db, c, id(req), body(req)))));

router.get('/purchase-requests', view, handle((req) => listPrs(pool, company(req), req.query)));
router.get('/purchase-requests/:id', view, handle((req) => getPr(pool, company(req), id(req))));
router.post('/purchase-requests/:id/vendors', manage, handle((req) => tx(req, (db, c) => addVendor(db, c, id(req), body(req)))));
router.put('/purchase-request-vendors/:id', manage, handle((req) => tx(req, (db, c) => setVendor(db, c, id(req), body(req)))));
router.delete('/purchase-request-vendors/:id', manage, handle((req) => tx(req, (db, c) => removeVendor(db, c, id(req)))));
router.put('/purchase-request-vendors/:id/quotes', manage, handle((req) => tx(req, (db, c) => setQuotes(db, c, id(req), body(req)))));
router.get('/purchase-request-vendors/:id/pending-pos', view, handle((req) => pendingPosOfVendor(pool, company(req), id(req))));
router.post('/purchase-request-vendors/:id/purchase-orders', manage, handle((req) => tx(req, (db, c) => raisePo(db, c, id(req), body(req)))));

export default router;
