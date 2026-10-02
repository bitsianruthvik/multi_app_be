/**
 * buying.js — the Buying board and the procurement trace (services/buyingBoardService.js).
 *
 *   GET /buying/board?supplierId=&orderId=&search=&includeClosed=&limit=&withRows=
 *        columns To buy → Requested → Approved → RFQ out → Quotes in → Awarded →
 *        Ordered → Part received → Received (+ Closed / cancelled with includeClosed),
 *        each { key, label, hint, count, value, unpriced, cards (≤ limit), more, moreLink }.
 *        orderId = the documents linked to that sales order (+ its receipts, and with
 *        withRows=1 its buy-list rows — the order's Buying stage).
 *   GET /procurement/trace?type=request|rfq|po&id=
 *        one document's stage and the documents joined to it along its lines.
 *
 * Reading: cf_erp_inventory_view, like every other buying screen.
 */
import { Router } from 'express';
import { pool } from '../lib/db.js';
import { PERM, guard, handle, ctx } from '../lib/http.js';
import { buyingBoard, procurementTrace } from '../services/buyingBoardService.js';

const router = Router();
const view = guard(PERM.inventoryView);

router.get('/buying/board', view, handle((req) => buyingBoard(pool, ctx(req).companyId, req.query)));
router.get('/procurement/trace', view, handle((req) => procurementTrace(pool, ctx(req).companyId, req.query)));

export default router;
