/**
 * stockMoney.js — what stock is worth, what a job cost, and the customer's
 * material (CF_ERP_MONEY_PLAN §1–2, init.sql §35).
 *
 *   GET  /stock/valuation?groupBy=item|area|owner&owner=ours|customer|<partyId>&areaId=&itemId=&purpose=
 *   GET  /items/:id/cost                       last receipt cost, average cost, stock value (ours / customers')
 *   GET  /orders/:id/costs                     job cost per order line: material issued at cost, scrap, nests
 *   GET  /orders/:id/material-reconciliation   the customer's material on this order: received − issued − scrapped − returned
 *   POST /customer-material/receive            { orderId, toAreaId, lines: [{ itemId, quantity, batchId? | batch?, unitCost? }] }
 *   POST /customer-material/return             { orderId, lines?: [{ itemId, batchId, quantity, fromAreaId? }], offcutIds?, scrapKg?, reason?, fromAreaId? }
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { stockValuation, itemCost, orderCosts } from '../services/valuationService.js';
import { receiveCustomerMaterial, materialReconciliation, returnToCustomer } from '../services/ownershipService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const view = guard(PERM.inventoryView);
const manage = guard(PERM.inventory);
const company = (req) => ctx(req).companyId;

router.get('/stock/valuation', view, handle((req) => stockValuation(pool, company(req), req.query)));
router.get('/items/:id/cost', view, handle((req) => itemCost(pool, company(req), id(req))));
router.get('/orders/:id/costs', view, handle((req) => orderCosts(pool, company(req), id(req))));
router.get('/orders/:id/material-reconciliation', view, handle((req) => materialReconciliation(pool, company(req), id(req))));
router.post('/customer-material/receive', manage, handle((req) => tx(req, (db, c) => receiveCustomerMaterial(db, c, req.body ?? {}))));
router.post('/customer-material/return', manage, handle((req) => tx(req, (db, c) => returnToCustomer(db, c, req.body ?? {}))));

export default router;
