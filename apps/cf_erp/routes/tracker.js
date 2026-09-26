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
 *   GET    /orders/:id/production           an order's releases and its lines not released yet
 *   GET    /tracker/steps?status=&orderId=&operationId=&search=   the work queue
 *   GET    /tracker/materials?show=&search=                       material across open releases
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
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import {
  releaseCheck, releasePreview, releaseLine, getRelease, unrelease, orderProduction, listTrackerSteps, listTrackerMaterials,
  startStep, recordProgress, holdStep, resumeStep, stepHistory,
  reserveRequirement, reserveRelease, issueRequirement, releaseReservation,
} from '../services/releaseService.js';
import { shipLine, shipmentView } from '../services/dispatchService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const company = (req) => ctx(req).companyId;
const view = guard(PERM.productionView);
const manage = guard(PERM.production);
const stock = guard(PERM.inventory);

router.get('/order-lines/:id/release-check', view, handle((req) => releaseCheck(pool, company(req), id(req))));
router.get('/order-lines/:id/release-preview', view, handle((req) => releasePreview(pool, company(req), id(req))));
router.post('/order-lines/:id/release', manage, handle((req) => tx(req, (db, c) => releaseLine(db, c, id(req), req.body ?? {}))));
router.get('/releases/:id', view, handle((req) => getRelease(pool, company(req), id(req))));
router.delete('/releases/:id', manage, handle((req) => tx(req, (db, c) => unrelease(db, c, id(req)))));
router.get('/orders/:id/production', view, handle((req) => orderProduction(pool, company(req), id(req))));
// Shipping is an inventory action: it takes finished stock off the dispatch shelf.
router.get('/order-lines/:id/shipment', guard(PERM.ordersView), handle((req) => shipmentView(pool, company(req), id(req))));
router.post('/order-lines/:id/ship', stock, handle((req) => tx(req, (db, c) => shipLine(db, c, id(req), req.body ?? {}))));
router.get('/tracker/steps', view, handle((req) => listTrackerSteps(pool, company(req), req.query)));
router.get('/tracker/materials', view, handle((req) => listTrackerMaterials(pool, company(req), req.query)));

router.post('/production-steps/:id/start', manage, handle((req) => tx(req, (db, c) => startStep(db, c, id(req), req.body ?? {}))));
router.post('/production-steps/:id/progress', manage, handle((req) => tx(req, (db, c) => recordProgress(db, c, id(req), req.body ?? {}))));
router.post('/production-steps/:id/hold', manage, handle((req) => tx(req, (db, c) => holdStep(db, c, id(req), req.body ?? {}))));
router.post('/production-steps/:id/resume', manage, handle((req) => tx(req, (db, c) => resumeStep(db, c, id(req), req.body ?? {}))));
router.get('/production-steps/:id/history', view, handle((req) => stepHistory(pool, company(req), id(req))));

router.post('/requirements/:id/reserve', stock, handle((req) => tx(req, (db, c) => reserveRequirement(db, c, id(req), req.body ?? {}))));
router.post('/releases/:id/reserve', stock, handle((req) => tx(req, (db, c) => reserveRelease(db, c, id(req)))));
router.post('/requirements/:id/issue', stock, handle((req) => tx(req, (db, c) => issueRequirement(db, c, id(req)))));
router.delete('/reservations/:id', stock, handle((req) => tx(req, (db, c) => releaseReservation(db, c, id(req)))));

export default router;
