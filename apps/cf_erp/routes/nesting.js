/**
 * nesting.js — laying a sales order line's cut plates out on real raw plates.
 *
 *   GET  /orders/:orderId/lines/:lineId/nesting          the SAVED plan
 *   POST /orders/:orderId/lines/:lineId/nesting/plan     { effort?, guillotine?, seed? } — propose
 *   POST /orders/:orderId/lines/:lineId/nesting/accept   { groups | nests } — write it (and forget the line's finished run)
 *   POST   /orders/:orderId/lines/:lineId/nesting/runs          { as /plan } — start a BACKGROUND run (or get the one running)
 *   GET    /orders/:orderId/lines/:lineId/nesting/runs/current  ?plan=1 — status, progress, log; the proposal once done
 *   DELETE /orders/:orderId/lines/:lineId/nesting/runs/current  dismiss a finished run (services/nestRunService.js)
 *   GET  /orders/:orderId/lines/:lineId/nesting/choices  the pieces (Step A) and plates (Step B) a run considers
 *   PUT  /orders/:orderId/lines/:lineId/nesting/choices  { excludedCutPlateIds, excludedPlateIds } — the whole
 *                                                        selection (both empty = reset); applied by every run
 *   PUT  /orders/:orderId/lines/:lineId/nesting/plates   { plates: 'standard' | 'any' } — which plates a run may use
 *                                                        (§44; a line never set uses 'any')
 *   GET  /orders/:orderId/lines/:lineId/nesting/sheet    the nests as a workbook (Nests / Needed / How to use this)
 *   POST /orders/:orderId/lines/:lineId/nesting/sheet    { file, filename, dryRun, force } — preview, or save
 *   GET  /orders/:orderId/lines/:lineId/nesting/cnc      every nest's DXF + nests.csv, zipped
 *   GET  /orders/:orderId/lines/:lineId/nesting/cnc/:lotId   one nest's DXF
 *
 * A LOOK IS A LOOK. The GET reads what was accepted and does not re-pack:
 * re-solving on every open cost the other system a 36-second spinner, and a
 * saved plan IS the plan. /plan is the button that re-packs, and it is a POST
 * because it is an action a person asks for — it still writes nothing.
 *
 * SUGGEST, THEN ACCEPT. /plan proposes and /accept writes; nothing reaches the
 * database in between. The sheet works the same way: an upload is a preview
 * (dryRun) first, every nest checked against our rules, and only a save writes
 * — replacing every lot on the line, imported and automatic alike.
 *
 * The line is addressed through its order, so the two are checked against each
 * other first — /orders/7/lines/99 must not quietly serve line 99 of order 3.
 *
 * Grants are the ones the rest of a sales order's structure already uses, and
 * for the same reason orders.js splits them: seeing a layout is reading the
 * order, and accepting one rewrites what the order will buy.
 *
 * The workbook arrives as base64 in the JSON body, exactly as the BOM sheet
 * does — cf_erp takes no multipart anywhere, and adding an upload middleware
 * for one route is a decision for whoever needs it.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import {
  planNesting, acceptNesting, getNesting, assertLineOnOrder, nestingChoices, saveNestingChoices, setNestPlates,
} from '../services/nestingService.js';
// The sheet is its own service: the workbook, its locked columns, its banner and
// the diff a dry run reports are a different job from laying steel out, and
// nestingService is long enough already.
import { exportSheet, importSheet } from '../services/nestingSheetService.js';
// A run that outlives the page (2026-10-03): the job, its progress and its proposal, in memory.
import { startRun, currentRun, dismissRun } from '../services/nestRunService.js';
// The CNC files: one DXF per nest with a layout, and the line's zip.
import { lotDxf, lineCncZip } from '../services/cncExportService.js';
// Drawings on an order line's rows (init.sql §51): DXF or PDF, matched by drawing mark; a plate part's DXF is its shape.
import { getDrawings, uploadDrawings, deleteDrawing, drawingFile } from '../services/partDrawingService.js';

const router = Router();
const view = guard(PERM.ordersView);
const manage = guard(PERM.orders);
const orderId = (req) => intParam(req.params.orderId, 'orderId');
const lineId = (req) => intParam(req.params.lineId, 'lineId');

/** Reads: one connection from the pool, the order/line agreement checked on it. */
const read = (req, fn) => (async () => {
  const { companyId } = ctx(req);
  const id = await assertLineOnOrder(pool, companyId, orderId(req), lineId(req));
  return fn(pool, companyId, id);
})();

/** Writes: the caller's transaction, so a refusal anywhere leaves the line as it was. */
const write = (req, fn) => withTransaction(async (db) => {
  const c = ctx(req);
  const id = await assertLineOnOrder(db, c.companyId, orderId(req), lineId(req));
  return fn(db, c, id);
});

router.get('/orders/:orderId/lines/:lineId/nesting', view,
  handle((req) => read(req, (db, companyId, id) => getNesting(db, companyId, id))));

// A proposal. It runs the packer and writes nothing, so it needs only the read
// grant — but it is a POST because it is an action with a cost, not a page.
router.post('/orders/:orderId/lines/:lineId/nesting/plan', view,
  handle((req) => read(req, (db, companyId, id) => planNesting(db, companyId, id, req.body ?? {}))));

router.post('/orders/:orderId/lines/:lineId/nesting/accept', manage,
  handle(async (req) => {
    const out = await write(req, (db, c, id) => acceptNesting(db, c, id, req.body ?? {}));
    // The proposal is now the saved plan: the finished run has done its job.
    dismissRun(ctx(req).companyId, lineId(req));
    return out;
  }));

// BACKGROUND RUNS — the same proposal as /plan, but owned by the server, so
// leaving the page does not lose it. Read grant, like /plan: it writes nothing.
router.post('/orders/:orderId/lines/:lineId/nesting/runs', view,
  handle((req) => read(req, (db, companyId, id) => startRun(companyId, { ...ctx(req), userName: req.user?.name ?? req.user?.email ?? null }, id, req.body ?? {}))));
router.get('/orders/:orderId/lines/:lineId/nesting/runs/current', view,
  handle((req) => read(req, (db, companyId, id) => currentRun(companyId, id, { withPlan: String(req.query.plan ?? '') === '1' }))));
router.delete('/orders/:orderId/lines/:lineId/nesting/runs/current', view,
  handle((req) => read(req, (db, companyId, id) => dismissRun(companyId, id))));

// THE NESTING CHOICES (init.sql §40): what a run leaves out. Reading them is a
// look; saving them is part of the order's structure work, so it needs manage.
router.get('/orders/:orderId/lines/:lineId/nesting/choices', view,
  handle((req) => read(req, (db, companyId, id) => nestingChoices(db, companyId, id))));

router.put('/orders/:orderId/lines/:lineId/nesting/choices', manage,
  handle((req) => write(req, (db, c, id) => saveNestingChoices(db, c, id, req.body ?? {}))));

router.put('/orders/:orderId/lines/:lineId/nesting/plates', manage,
  handle((req) => write(req, (db, c, id) => setNestPlates(db, c, id, req.body ?? {}))));

router.get('/orders/:orderId/lines/:lineId/nesting/sheet', view, handle(async (req, res) => {
  const out = await read(req, (db, companyId, id) => exportSheet(db, companyId, id));
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Content-Length', String(out.buffer.length));
  // Says what the caller got without having to open the file: how many pieces,
  // how many plates, and whether this is the saved plan or a proposal made
  // because none exists.
  res.setHeader('X-CF-Sheet-Rows', String(out.rows));
  res.setHeader('X-CF-Sheet-Lots', String(out.lots));
  res.setHeader('X-CF-Sheet-Saved', out.saved ? '1' : '0');
  res.send(out.buffer);
}));

// THE SHEET IS PREVIEWED, THEN SAVED. `dryRun: true` checks every nest and
// writes nothing; saving replaces every lot on the line, and a nest that does
// not fit our rules (or a cut plate over-covered) needs `force: true`.
router.post('/orders/:orderId/lines/:lineId/nesting/sheet', manage,
  handle((req) => write(req, (db, c, id) => importSheet(db, c, id, req.body ?? {}))));

// DRAWINGS — DXF or PDF per row of the line, matched by drawing mark (a plate part's DXF is its
// shape). A dry run reads and matches and writes nothing; saving also refreshes the line's cut
// plates' cut length and piercings. /file downloads the drawing itself.
router.get('/orders/:orderId/lines/:lineId/drawings', view,
  handle((req) => read(req, (db, companyId, id) => getDrawings(db, companyId, null, id))));
router.post('/orders/:orderId/lines/:lineId/drawings', manage,
  handle((req) => write(req, (db, c, id) => uploadDrawings(db, c, null, id, req.body ?? {}))));
router.get('/orders/:orderId/lines/:lineId/drawings/:drawingId/file', view, handle(async (req, res) => {
  const out = await read(req, (db, companyId, id) => drawingFile(db, companyId, null, id, intParam(req.params.drawingId, 'drawingId')));
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${String(out.filename).replace(/["\\]/g, '')}"`);
  res.setHeader('Content-Length', String(out.buffer.length));
  res.send(out.buffer);
}));
router.delete('/orders/:orderId/lines/:lineId/drawings/:drawingId', manage,
  handle((req) => write(req, (db, c, id) => deleteDrawing(db, c, null, id, intParam(req.params.drawingId, 'drawingId')))));

/** A file out: the buffer, its type, and a download name. */
const sendFile = (res, out, type) => {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Content-Length', String(out.buffer.length));
  res.send(out.buffer);
};

router.get('/orders/:orderId/lines/:lineId/nesting/cnc', view, handle(async (req, res) => {
  const out = await read(req, (db, companyId, id) => lineCncZip(db, companyId, id));
  sendFile(res, out, 'application/zip');
}));

// A nest without a layout of ours has no drawing: lotDxf refuses it with
// NO_LAYOUT (422), which handle() passes through as it is.
router.get('/orders/:orderId/lines/:lineId/nesting/cnc/:lotId', view, handle(async (req, res) => {
  const lotId = intParam(req.params.lotId, 'lotId');
  const out = await read(req, (db, companyId, id) => lotDxf(db, companyId, id, lotId));
  sendFile(res, out, 'application/dxf');
}));

export default router;
