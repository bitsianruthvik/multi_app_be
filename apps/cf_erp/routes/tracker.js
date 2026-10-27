/**
 * tracker.js — release to production and the production tracker (Phase 5).
 *
 *   GET    /order-lines/:id/release-check   what releasing the line would create, and what stops it
 *   GET    /order-lines/:id/release-preview every piece release would make and the code it would get —
 *                                           read-only, heavy (6,072 pieces on the KEPL line); a released
 *                                           line says so instead
 *   POST   /order-lines/:id/release         { notes? } — releases the WHOLE line (decision E1)
 *   GET    /releases/:id                    the tracker tree, every step's status, the material
 *   DELETE /releases/:id                    takes a release back — nothing started, nothing issued
 *   GET    /orders/:id/production           an order's releases AS FIGURES (releaseSummaries — no tree) and its
 *                                           lines not released yet; ?full=1 = every release in full (getRelease)
 *   GET    /releases/:id/requirements       a release's material on its own (the order page opens it on request)
 *   GET    /tracker/steps?status=&orderId=&operationId=&search=   the work queue
 *   GET    /tracker/materials?show=&search=                       material across open releases
 *   GET    /tracker/tree?orderId=&lineId=&depth=&search=&onlyBlocked=&includeClosed=
 *                                           the progress tree: order › line › piece codes, each node's
 *                                           operations and its subtree's completion (trackerTreeService)
 *   GET    /tracker/tree/children?nodeId=&depth=   a branch of it, filled in when opened
 *   GET    /tracker/tree/node?nodeId=p…     one piece and its steps in full
 *   GET    /tracker/grid?lineId=&depth=     one released line as a grid: the piece-code tree down the left, the
 *                                           line's operations across, a cell per piece per operation (lineGrid)
 *   GET    /tracker/grid/children?nodeId=&depth=   a branch of that grid, filled in when opened
 *   GET    /released-lines?status=&customerId=&search=&limit=&offset=   (2026-10-17) every release
 *                                           (released line) grouped by sales order, paged by order
 *                                           (productionOrdersService). Was /production-orders until §76 — that
 *                                           path is now the production orders themselves (routes/productionOrders.js).
 *   GET    /tracker/plan-check?stepIds=1,2  (2026-10-17) which of these steps the plan has no ship week for
 *
 * Every write below answers with the whole release (getRelease) unless asked
 * ?view=summary (its figures only) or ?view=none — the order page's grid asks
 * for the summary and re-reads only the cells it shows.
 *   POST   /production-steps/:id/start      { machineId?, note? }
 *   POST   /production-steps/:id/progress   { good?, scrap?, note? }
 *   POST   /production-steps/:id/hold       { note }
 *   POST   /production-steps/:id/resume     { note? }
 *   GET    /production-steps/:id/history
 *   POST   /requirements/:id/reserve        { quantity?, batchId? }
 *   POST   /releases/:id/reserve            reserves what is free for every requirement
 *   POST   /requirements/:id/issue          issues the reserved stock to the order
 *   DELETE /reservations/:id                lets a reservation go
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, guardAny, handle, ctx, intParam } from '../lib/http.js';
import { isPermitted } from '../../../core/middleware/requirePerm.js';
import {
  releaseCheck, releasePreview, releaseLine, getRelease, unrelease, orderProduction, orderProductionSummary, releaseRequirements,
  takeMrEarmarks, releaseAfterWrite,
  listTrackerSteps, listTrackerMaterials,
  startStep, recordProgress, holdStep, resumeStep, stepHistory,
  reserveRequirement, reserveRelease, issueRequirement, releaseReservation,
} from '../services/releaseService.js';
import { shipLine, shipmentView } from '../services/dispatchService.js';
import { trackerTree, trackerTreeChildren, trackerTreeNode, lineGrid, lineGridChildren } from '../services/trackerTreeService.js';
import { listProductionOrders } from '../services/productionOrdersService.js';
import { planCheck } from '../services/floorService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const company = (req) => ctx(req).companyId;
const view = guard(PERM.productionView);
const manage = guard(PERM.production);
// Reserving / issuing stock to production and shipping a line: Stores (inventory manage) OR PPC (production manage) —
// user 2026-10-27. Receipts, transfers, counts, scrap and GRNs stay Stores' (routes/inventory.js, grn.js).
const stock = guardAny(PERM.inventory, PERM.production);
/** A shipment drafts the tax invoice only for Accounts (invoices are accounts manage only, 2026-10-27, init.sql §94):
 *  anyone else ships and the dispatch waits un-invoiced on the order's Invoices card for Accounts to raise. */
export const shipInput = (req) => ({ ...(req.body ?? {}), ...(isPermitted(req.user, PERM.accounts) ? {} : { invoice: false }) });
/** What a write answers with: ?view=summary | none, else the whole release. */
const view_ = (req) => (req.query.view === 'summary' || req.query.view === 'none' ? String(req.query.view) : undefined);
const body = (req) => ({ ...(req.body ?? {}), view: view_(req) });

router.get('/order-lines/:id/release-check', view, handle((req) => releaseCheck(pool, company(req), id(req))));
router.get('/order-lines/:id/release-preview', view, handle((req) => releasePreview(pool, company(req), id(req))));
// The material request is the production order's input (§66): what is earmarked for the line's MR becomes the
// release's reservations at once — { fromMr: false } releases without it. The answer carries `fromMr`.
router.post('/order-lines/:id/release', manage, handle((req) => tx(req, async (db, c) => {
  const out = await releaseLine(db, c, id(req), body(req));
  if (req.body?.fromMr === false) return out;
  const fromMr = await takeMrEarmarks(db, c, out.id ?? out.release?.id);
  return { ...(fromMr.reserved.length ? await releaseAfterWrite(db, c.companyId, out.id ?? out.release?.id, view_(req)) : out), fromMr };
})));
router.get('/releases/:id', view, handle((req) => getRelease(pool, company(req), id(req))));
router.delete('/releases/:id', manage, handle((req) => tx(req, (db, c) => unrelease(db, c, id(req)))));
router.get('/orders/:id/production', view, handle((req) => (String(req.query.full) === '1'
  ? orderProduction(pool, company(req), id(req))
  : orderProductionSummary(pool, company(req), id(req)))));
router.get('/releases/:id/requirements', view, handle((req) => releaseRequirements(pool, company(req), id(req))));
// Shipping takes finished stock off the dispatch shelf: Stores or PPC (above).
router.get('/order-lines/:id/shipment', guard(PERM.ordersView), handle((req) => shipmentView(pool, company(req), id(req))));
router.post('/order-lines/:id/ship', stock, handle((req) => tx(req, (db, c) => shipLine(db, c, id(req), shipInput(req)))));
router.get('/tracker/steps', view, handle((req) => listTrackerSteps(pool, company(req), req.query)));
router.get('/tracker/materials', view, handle((req) => listTrackerMaterials(pool, company(req), req.query)));
router.get('/tracker/tree', view, handle((req) => trackerTree(pool, company(req), req.query)));
router.get('/tracker/tree/children', view, handle((req) => trackerTreeChildren(pool, company(req), req.query)));
router.get('/tracker/tree/node', view, handle((req) => trackerTreeNode(pool, company(req), req.query)));
router.get('/tracker/grid', view, handle((req) => lineGrid(pool, company(req), req.query)));
router.get('/tracker/grid/children', view, handle((req) => lineGridChildren(pool, company(req), req.query)));
router.get('/released-lines', view, handle((req) => listProductionOrders(pool, company(req), req.query)));
router.get('/tracker/plan-check', view, handle((req) => planCheck(pool, company(req), req.query)));

router.post('/production-steps/:id/start', manage, handle((req) => tx(req, (db, c) => startStep(db, c, id(req), body(req)))));
router.post('/production-steps/:id/progress', manage, handle((req) => tx(req, (db, c) => recordProgress(db, c, id(req), body(req)))));
router.post('/production-steps/:id/hold', manage, handle((req) => tx(req, (db, c) => holdStep(db, c, id(req), body(req)))));
router.post('/production-steps/:id/resume', manage, handle((req) => tx(req, (db, c) => resumeStep(db, c, id(req), body(req)))));
router.get('/production-steps/:id/history', view, handle((req) => stepHistory(pool, company(req), id(req))));

router.post('/requirements/:id/reserve', stock, handle((req) => tx(req, (db, c) => reserveRequirement(db, c, id(req), body(req)))));
router.post('/releases/:id/reserve', stock, handle((req) => tx(req, (db, c) => reserveRelease(db, c, id(req), { view: view_(req) }))));
router.post('/requirements/:id/issue', stock, handle((req) => tx(req, (db, c) => issueRequirement(db, c, id(req), { view: view_(req) }))));
router.delete('/reservations/:id', stock, handle((req) => tx(req, (db, c) => releaseReservation(db, c, id(req), { view: view_(req) }))));

export default router;
