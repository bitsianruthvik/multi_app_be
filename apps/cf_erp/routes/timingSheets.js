/**
 * timingSheets.js — timings as Excel, out and back in (services/timingSheetService.js, 2026-10-31).
 *
 *   GET  /operation-times/sheet                        every operation's timing rules (.xlsx)
 *   POST /operation-times/sheet                        { fileBase64, dryRun? } — rules matched by operation code + machine type / machine code
 *   GET  /orders/:id/operation-times/sheet             one order's time per operation (.xlsx)
 *   POST /orders/:id/operation-times/sheet             { fileBase64, dryRun? } — this order's per-operation times; steps not done re-timed
 *   GET  /orders/:id/floor-sheet?productionOrderId=    the order's (or one production order's) steps (.xlsx)
 *   POST /orders/:id/floor-sheet                       { fileBase64, dryRun?, productionOrderId?, tz?, note? } — progress by piece code +
 *                                                      operation code, one transaction per row (not wrapped in tx(), as /production-steps/finish)
 *
 * Grants are production's: cf_erp_production_view to download, cf_erp_production_manage to upload (a dry run too — it
 * is the upload's first half). The file arrives as base64 in the JSON body, as routes/bomSheet.js explains.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam, contentDisposition } from '../lib/http.js';
import {
  exportOperationTimesSheet, importOperationTimesSheet,
  exportOrderOperationTimesSheet, importOrderOperationTimesSheet,
  exportFloorSheet, importFloorSheet,
} from '../services/timingSheetService.js';

const router = Router();
const id = (req) => intParam(req.params.id);
const view = guard(PERM.productionView);
const manage = guard(PERM.production);

const send = (res, out) => {
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', contentDisposition(out.filename));
  res.setHeader('Content-Length', String(out.buffer.length));
  res.setHeader('X-CF-Sheet-Rows', String(out.rows));
  res.send(out.buffer);
};

router.get('/operation-times/sheet', view, handle(async (req, res) => send(res, await exportOperationTimesSheet(pool, ctx(req).companyId))));
router.post('/operation-times/sheet', manage, handle((req) => withTransaction((db) => importOperationTimesSheet(db, ctx(req), req.body ?? {}))));

router.get('/orders/:id/operation-times/sheet', view, handle(async (req, res) => send(res, await exportOrderOperationTimesSheet(pool, ctx(req).companyId, id(req)))));
router.post('/orders/:id/operation-times/sheet', manage, handle((req) => withTransaction((db) => importOrderOperationTimesSheet(db, ctx(req), id(req), req.body ?? {}))));

router.get('/orders/:id/floor-sheet', view, handle(async (req, res) => send(res, await exportFloorSheet(pool, ctx(req).companyId, id(req), { productionOrderId: req.query.productionOrderId }))));
router.post('/orders/:id/floor-sheet', manage, handle((req) => importFloorSheet(ctx(req), id(req), req.body ?? {})));

export default router;
