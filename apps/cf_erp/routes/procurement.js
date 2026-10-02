/**
 * procurement.js — purchase request -> RFQ -> quotes -> comparison -> award -> POs
 * (init.sql §39, TM/CF_ERP_PROCUREMENT_PLAN.md, services/procurementService.js).
 *
 * Reading: cf_erp_inventory_view. Raising requests, RFQs, quotes, award, POs:
 * cf_erp_inventory_manage (buying runs on it). Approve / reject a request:
 * cf_erp_purchase_approve (admins pass everywhere; the service also refuses an
 * approval of one's own request unless admin).
 *
 *   GET    /purchase-requests?status=open|all|<status>&q=     { rows }
 *   POST   /purchase-requests        { neededBy?, notes?, lines: [{ itemId, quantity, neededBy?, estUnitPrice?, notes? }] }
 *   POST   /buy-list/request         { rows: [{ itemId, quantity? }] | all: true, neededBy?, notes? }  -> request + skipped[]
 *   GET    /purchase-requests/:id
 *   PUT    /purchase-requests/:id    { neededBy?, notes? }                       (draft / rejected)
 *   POST   /purchase-requests/:id/lines   { itemId, quantity, neededBy?, estUnitPrice?, notes? }
 *   PUT    /purchase-request-lines/:id    { quantity?, neededBy?, estUnitPrice?, notes? }
 *   DELETE /purchase-request-lines/:id
 *   POST   /purchase-requests/:id/submit | /approve { note? } | /reject { note } | /cancel { note? }
 *
 *   GET    /rfqs?status=open|all|<status>&q=     { rows }
 *   POST   /rfqs                     { requestLineIds: [...] | requestId, quotesDue?, terms?, notes?, supplierIds? }
 *   GET    /rfqs/:id
 *   PUT    /rfqs/:id                 { quotesDue?, terms?, notes? }
 *   POST   /rfqs/:id/suppliers       { supplierId, contactEmail? }
 *   DELETE /rfqs/:id/suppliers/:supplierId           (supplierId = the party id)
 *   POST   /rfqs/:id/suppliers/:supplierId/decline
 *   POST   /rfqs/:id/mark-sent       { supplierId }
 *   GET    /rfqs/:id/print?supplierId=               text/html (A4)
 *   GET    /rfqs/:id/email?supplierId=               { to, subject, body }
 *   POST   /rfqs/:id/quotes          { supplierId, quoteRef?, receivedOn?, validUntil?, paymentTerms?, freightAmount?, notes?, lines: [...] }
 *   GET    /quotes/:id               header + one row per RFQ line (prefill)
 *   PUT    /quotes/:id               { same, without supplierId }
 *   GET    /rfqs/:id/comparison
 *   POST   /rfqs/:id/award           { awards: [{ rfqLineId, quoteLineId | null }] }
 *   POST   /rfqs/:id/create-pos      -> { purchaseOrders: [{ id, code, supplier, lines }], rfq }
 *   POST   /rfqs/:id/close | /cancel
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { isPermitted, fail } from '../../../core/middleware/requirePerm.js';
import { translateDbError } from '../lib/errors.js';
import * as P from '../services/procurementService.js';

const router = Router();
const id = (req) => intParam(req.params.id);
/** The request's context plus what the person may do — the services work out `allowed` from it. */
const pctx = (req) => ({
  ...ctx(req),
  canManage: isPermitted(req.user, PERM.inventory),
  canApprove: isPermitted(req.user, PERM.purchaseApprove),
  isAdmin: String(req.user?.role ?? '').toLowerCase() === 'admin',
});
const tx = (req, fn) => withTransaction((db) => fn(db, pctx(req)));
const view = guard(PERM.inventoryView);
const manage = guard(PERM.inventory);
const approve = guard(PERM.purchaseApprove);
const body = (req) => req.body ?? {};

// ---- purchase requests -------------------------------------------------------
router.get('/purchase-requests', view, handle((req) => P.listRequests(pool, ctx(req).companyId, req.query)));
router.post('/purchase-requests', manage, handle((req) => tx(req, (db, c) => P.createRequest(db, c, body(req)))));
router.post('/buy-list/request', manage, handle((req) => tx(req, (db, c) => P.requestFromBuyList(db, c, body(req)))));
router.get('/purchase-requests/:id', view, handle((req) => P.getRequest(pool, pctx(req), id(req))));
router.put('/purchase-requests/:id', manage, handle((req) => tx(req, (db, c) => P.updateRequest(db, c, id(req), body(req)))));
router.post('/purchase-requests/:id/lines', manage, handle((req) => tx(req, (db, c) => P.addRequestLine(db, c, id(req), body(req)))));
router.put('/purchase-request-lines/:id', manage, handle((req) => tx(req, (db, c) => P.updateRequestLine(db, c, id(req), body(req)))));
router.delete('/purchase-request-lines/:id', manage, handle((req) => tx(req, (db, c) => P.removeRequestLine(db, c, id(req)))));
router.post('/purchase-requests/:id/submit', manage, handle((req) => tx(req, (db, c) => P.submitRequest(db, c, id(req)))));
router.post('/purchase-requests/:id/approve', approve, handle((req) => tx(req, (db, c) => P.approveRequest(db, c, id(req), body(req)))));
router.post('/purchase-requests/:id/reject', approve, handle((req) => tx(req, (db, c) => P.rejectRequest(db, c, id(req), body(req)))));
router.post('/purchase-requests/:id/cancel', manage, handle((req) => tx(req, (db, c) => P.cancelRequest(db, c, id(req), body(req)))));

// ---- RFQs ------------------------------------------------------------------------
router.get('/rfqs', view, handle((req) => P.listRfqs(pool, ctx(req).companyId, req.query)));
router.post('/rfqs', manage, handle((req) => tx(req, (db, c) => P.createRfq(db, c, body(req)))));
router.get('/rfqs/:id', view, handle((req) => P.getRfq(pool, pctx(req), id(req))));
router.put('/rfqs/:id', manage, handle((req) => tx(req, (db, c) => P.updateRfq(db, c, id(req), body(req)))));
router.post('/rfqs/:id/suppliers', manage, handle((req) => tx(req, (db, c) => P.addRfqSupplier(db, c, id(req), body(req)))));
router.delete('/rfqs/:id/suppliers/:supplierId', manage, handle((req) => tx(req, (db, c) => P.removeRfqSupplier(db, c, id(req), intParam(req.params.supplierId, 'supplierId')))));
router.post('/rfqs/:id/suppliers/:supplierId/decline', manage, handle((req) => tx(req, (db, c) => P.declineRfqSupplier(db, c, id(req), intParam(req.params.supplierId, 'supplierId')))));
router.post('/rfqs/:id/mark-sent', manage, handle((req) => tx(req, (db, c) => P.markRfqSent(db, c, id(req), body(req)))));
/** The printable RFQ — HTML, not JSON. Errors still come back as JSON. */
router.get('/rfqs/:id/print', view, async (req, res) => {
  try {
    res.type('html').send(await P.rfqPrintHtml(pool, pctx(req), id(req), req.query.supplierId));
  } catch (err) { fail(res, translateDbError(err)); }
});
router.get('/rfqs/:id/email', view, handle((req) => P.rfqEmail(pool, pctx(req), id(req), req.query.supplierId)));
router.post('/rfqs/:id/quotes', manage, handle((req) => tx(req, (db, c) => P.upsertQuote(db, c, id(req), body(req)))));
router.get('/quotes/:id', view, handle((req) => P.getQuote(pool, pctx(req), id(req))));
router.put('/quotes/:id', manage, handle((req) => tx(req, (db, c) => P.updateQuote(db, c, id(req), body(req)))));
router.get('/rfqs/:id/comparison', view, handle((req) => P.rfqComparison(pool, pctx(req), id(req))));
router.post('/rfqs/:id/award', manage, handle((req) => tx(req, (db, c) => P.awardRfq(db, c, id(req), body(req)))));
router.post('/rfqs/:id/create-pos', manage, handle((req) => tx(req, (db, c) => P.createPosFromRfq(db, c, id(req)))));
router.post('/rfqs/:id/close', manage, handle((req) => tx(req, (db, c) => P.closeRfq(db, c, id(req)))));
router.post('/rfqs/:id/cancel', manage, handle((req) => tx(req, (db, c) => P.cancelRfq(db, c, id(req)))));

export default router;
