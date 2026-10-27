/**
 * nesting.js — laying a sales order line's cut plates out on real raw plates.
 *
 *   GET  /orders/:orderId/lines/:lineId/nesting          the SAVED plan
 *   POST /orders/:orderId/lines/:lineId/nesting/plan     { effort?, guillotine?, seed? } — propose
 *   POST /orders/:orderId/lines/:lineId/nesting/accept   { groups | nests } — write it (and forget the line's finished run)
 *   POST   /orders/:orderId/lines/:lineId/nesting/runs          { as /plan } — start a BACKGROUND run (or get the one running)
 *   GET    /orders/:orderId/lines/:lineId/nesting/runs/current  ?plan=1 — status, progress, log; the proposal once done
 *   DELETE /orders/:orderId/lines/:lineId/nesting/runs/current  dismiss a finished run; CANCEL one still working (services/nestRunService.js)
 *   POST   /orders/:orderId/lines/:lineId/nesting/runs/current/stop  "stop and use this": finish now with the best layout so far
 *   POST   /orders/:orderId/lines/:lineId/nesting/compare/stop       the same, for the automatic side of a comparison
 *   DELETE /orders/:orderId/lines/:lineId/nesting/compare            cancel a comparison that is still working
 *   GET  /orders/:orderId/lines/:lineId/nesting/choices  the pieces (Step A) and plates (Step B) a run considers
 *   PUT  /orders/:orderId/lines/:lineId/nesting/choices  { excludedCutPlateIds, excludedPlateIds } — the whole
 *                                                        selection (both empty = reset); applied by every run
 *   PUT  /orders/:orderId/lines/:lineId/nesting/plates   { plates: 'standard' | 'any' } — which plates a run may use
 *                                                        (§44; a line never set uses 'any')
 *   GET  /orders/:orderId/lines/:lineId/nesting/sheet    the nests as a workbook (Nests / Needed / How to use this)
 *   POST /orders/:orderId/lines/:lineId/nesting/sheet    { file, filename, dryRun, force } — preview, or save
 *   GET    /orders/:orderId/lines/:lineId/nesting/files          the plates saved, the files they came from, what is left over
 *   POST   /orders/:orderId/lines/:lineId/nesting/files          { files: [{ filename, file }], dryRun, force, mode, remove, choices }
 *                                                                the CUSTOMER'S nesting, one DXF per plate, copied as drawn (§55)
 *   GET    /orders/:orderId/lines/:lineId/nesting/files/:lotId   the file one plate was read from
 *   DELETE /orders/:orderId/lines/:lineId/nesting/lots/:lotId    one plate off the line
 *   POST   /orders/:orderId/lines/:lineId/nesting/plates         { plates: [{ key, kind, code?, name? }], dryRun } — plates the files use
 *                                                                that the catalog does not have, added to it (orders manage AND catalog manage)
 *   GET    /orders/:orderId/lines/:lineId/nesting/untracked      what is left over, what is marked as cut from untracked offcuts, kg and cost (init.sql §61)
 *   POST   /orders/:orderId/lines/:lineId/nesting/untracked      { pieces?: [{ cutPlateId, quantity? }], all?, dryRun? } — mark left-over pieces
 *   DELETE /orders/:orderId/lines/:lineId/nesting/untracked      { cutPlateIds? } — undo (none = every mark)
 *   GET    /orders/:orderId/lines/:lineId/nesting/compare        the uploaded nesting beside our automatic one (?with=auto)
 *   POST   /orders/:orderId/lines/:lineId/nesting/compare        { run: true, effort? } — start the automatic side when none answers this demand
 *                                                                { run: true, auto: true, rerun? } — the Compare tab: our Standard nesting of the upload's pieces
 *   (2026-10-16) a SAVED upload — POST …/files that applied, DELETE …/lots/:lotId of a customer plate, an approved plate-change
 *   request of either — queues our own Standard nesting of the same pieces in the background (afterUploadSaved); the answer
 *   carries autoCompare: { queued, effort, message } and never waits for it.
 *   POST   /orders/:orderId/lines/:lineId/nesting/compare/accept { side: 'uploaded' | 'auto', runId } — take one side
 *   GET    /orders/:orderId/lines/:lineId/nesting/alternative     §87: AI's nesting stored beside the upload — which side is the main one
 *   POST   /orders/:orderId/lines/:lineId/nesting/alternative/swap { to: 'ai' | 'uploaded', runId? } — make AI's the main
 *                                                                nesting, or switch back (a plate write: plateChangeGate 'swap_alternative')
 *   GET  /orders/:orderId/lines/:lineId/nesting/cnc      every nest's DXF + nests.csv, zipped
 *   GET  /orders/:orderId/lines/:lineId/nesting/cnc/:lotId   one nest's DXF
 *        …/nesting/cnc[/:lotId]?style=ai[&leads=1][&order=1]  the "AI" ProNest DXF (services/aiNestDxf.js); the zip adds each nest's cut plan
 *   GET  /orders/:orderId/lines/:lineId/nesting/cut-plan/:lotId  the AI cut plan of one nest as data (services/aiCutPlan.js)
 *
 *   GET    /orders/:orderId/lines/:lineId/nesting/plate-changes  the line's plate-change gate and requests (routes/plateChanges.js)
 *
 * PLATE CHANGES AFTER A PO (init.sql §62, 2026-10-16). Every write here that changes a line's plates — accept,
 * compare/accept (auto), the files / sheet save, a lot delete, the choices, the plate setting, the untracked marks
 * when they change the plates needed — goes through plateChangeGate (`gated` below): once a purchase order covers
 * the line it becomes a request the MD approves (`reason` required), and a request waiting on the line holds it.
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
import { PERM, guard, handle, ctx, intParam, assertPerm, contentDisposition } from '../lib/http.js';
import {
  planNesting, acceptNesting, getNesting, assertLineOnOrder, nestingChoices, saveNestingChoices, setNestPlates,
} from '../services/nestingService.js';
// The sheet is its own service: the workbook, its locked columns, its banner and
// the diff a dry run reports are a different job from laying steel out, and
// nestingService is long enough already.
import { exportSheet, importSheet } from '../services/nestingSheetService.js';
// A run that outlives the page (2026-10-03): the job, its progress and its proposal, in memory.
import { startRun, readRun, dismissRun, stopRunAnywhere, cancelRun, yieldAutoCompare } from '../services/nestRunService.js';
// The customer's nesting files (init.sql §55): one DXF per plate, stored exactly as drawn.
import { uploadNestFiles, getNestFiles, nestFileOf, deleteNestLot } from '../services/nestDxfImportService.js';
// Plates an uploaded nesting is cut on that are not in the catalog yet (2026-10-14).
import { createNestPlates } from '../services/nestPlateCatalogService.js';
// Pieces cut from loose offcuts in the yard that are not in the system (init.sql §61, 2026-10-14).
import { getUntracked, markUntracked, unmarkUntracked } from '../services/nestUntrackedService.js';
// The uploaded nesting beside our automatic one, and taking one of them.
import { getCompare, startCompare, acceptCompare, scheduleAutoCompare } from '../services/nestCompareService.js';
// §87: AI's nesting stored beside the uploaded one, and swapping which of the two is the main nesting.
import { alternativeOf, swapAlternative } from '../services/nestAlternativeService.js';
// The CNC files: one DXF per nest with a layout, and the line's zip.
import { lotDxf, lineCncZip, lotAiPlan } from '../services/cncExportService.js';
// Plate changes after a purchase order (init.sql §62): every plate write below goes through the gate.
import { plateChangeGate } from '../services/plateChangeService.js';
// Drawings on an order line's rows (init.sql §51): DXF or PDF, matched by drawing mark; a plate part's DXF is its shape.
import { getDrawings, drawingTree, uploadDrawings, deleteDrawing, drawingFile, startDrawing } from '../services/partDrawingService.js';

const router = Router();
const view = guard(PERM.ordersView);
const manage = guard(PERM.orders);
const orderId = (req) => intParam(req.params.orderId, 'orderId');
const lineId = (req) => intParam(req.params.lineId, 'lineId');

/**
 * AN UPLOAD WAS SAVED (2026-10-16): the transaction has committed, so our own Standard nesting of the same pieces is
 * queued in the background (nestCompareService.scheduleAutoCompare) and the answer goes back AT ONCE with
 * `autoCompare: { queued, effort, message }` — the upload never waits for the run. Not on a preview, not on a save that
 * did not apply, not on a plate-change REQUEST (nothing is saved until it is approved; the approval queues it).
 */
function afterUploadSaved(req, out) {
  if (!out || out.requested || out.applied !== true || out.dryRun === true) return out;
  const c = { ...ctx(req), userName: req.user?.name ?? req.user?.email ?? null };
  const auto = scheduleAutoCompare(c, lineId(req));
  return auto ? { ...out, autoCompare: auto } : out;
}

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

/**
 * A PLATE WRITE (init.sql §62): the same transaction as `write`, through plateChangeGate. No purchase order
 * covers the line → the action runs exactly as before (`impact: true` adds the before / after). A PO covers it →
 * a change request (`reason` required) and nothing is saved. A request waiting on the line → refused, in words.
 * A preview (dryRun) is never held and never a request.
 */
const gated = (req, kind, body, fn) => withTransaction(async (db) => {
  const c = { ...ctx(req), userName: req.user?.name ?? req.user?.email ?? null };
  const id = await assertLineOnOrder(db, c.companyId, orderId(req), lineId(req));
  return plateChangeGate(db, c, id, kind, body, (b) => fn(db, c, id, b));
});

router.get('/orders/:orderId/lines/:lineId/nesting', view,
  handle((req) => read(req, (db, companyId, id) => getNesting(db, companyId, id))));

// A proposal. It runs the packer and writes nothing, so it needs only the read
// grant — but it is a POST because it is an action with a cost, not a page.
router.post('/orders/:orderId/lines/:lineId/nesting/plan', view,
  handle((req) => read(req, (db, companyId, id) => {
    // A plan made INSIDE the request: the short synchronous budget, whatever the body says (the
    // 5 / 10 / 20 minute budgets belong to background runs — POST …/nesting/runs).
    const { background, control, budgetMs, workers, pack, onProgress, onDemand, resume, onCheckpoint, checkpointMs, customPlates, ...body } = req.body ?? {};
    void background; void control; void budgetMs; void workers; void pack; void onProgress; void onDemand; void resume; void onCheckpoint; void checkpointMs;
    // §90: custom plate sizes follow the company's setting (Setup › Cutting); a request may only switch them off.
    return planNesting(db, companyId, id, { ...body, ...(customPlates === false ? { customPlates: false } : {}) });
  })));

router.post('/orders/:orderId/lines/:lineId/nesting/accept', manage,
  handle(async (req) => {
    const out = await gated(req, 'accept', req.body ?? {}, (db, c, id, b) => acceptNesting(db, c, id, b));
    // The proposal is now the saved plan: the finished run has done its job. (Not when it only became a
    // request: the run stays until the change is decided.)
    if (!out?.requested) await dismissRun(ctx(req).companyId, lineId(req), { accepted: true });
    return out;
  }));

// BACKGROUND RUNS — the same proposal as /plan, but owned by the server, so
// leaving the page does not lose it. Read grant, like /plan: it writes nothing.
// A person's run goes first: the automatic comparison after an upload, if it is working, stops and keeps its best (2026-10-16).
router.post('/orders/:orderId/lines/:lineId/nesting/runs', view,
  handle((req) => read(req, async (db, companyId, id) => {
    await yieldAutoCompare(companyId, id);
    return startRun(companyId, { ...ctx(req), userName: req.user?.name ?? req.user?.email ?? null }, id, req.body ?? {});
  })));
// readRun: the run in memory, else — after a restart — the finished one the database kept.
router.get('/orders/:orderId/lines/:lineId/nesting/runs/current', view,
  handle((req) => read(req, (db, companyId, id) => readRun(companyId, id, { withPlan: String(req.query.plan ?? '') === '1' }))));
router.delete('/orders/:orderId/lines/:lineId/nesting/runs/current', view,
  handle((req) => read(req, (db, companyId, id) => dismissRun(companyId, id))));
// STOP AND USE THIS: the run finishes now with the best layout it has (a proposal like any other).
router.post('/orders/:orderId/lines/:lineId/nesting/runs/current/stop', view,
  handle((req) => read(req, (db, companyId, id) => stopRunAnywhere(companyId, id, { purpose: 'nest' }))));

// THE NESTING CHOICES (init.sql §40): what a run leaves out. Reading them is a
// look; saving them is part of the order's structure work, so it needs manage.
router.get('/orders/:orderId/lines/:lineId/nesting/choices', view,
  handle((req) => read(req, (db, companyId, id) => nestingChoices(db, companyId, id))));

router.put('/orders/:orderId/lines/:lineId/nesting/choices', manage,
  handle((req) => gated(req, 'choices', req.body ?? {}, (db, c, id, b) => saveNestingChoices(db, c, id, b))));

router.put('/orders/:orderId/lines/:lineId/nesting/plates', manage,
  handle((req) => gated(req, 'nest_plates', req.body ?? {}, (db, c, id, b) => setNestPlates(db, c, id, b))));

router.get('/orders/:orderId/lines/:lineId/nesting/sheet', view, handle(async (req, res) => {
  const out = await read(req, (db, companyId, id) => exportSheet(db, companyId, id));
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', contentDisposition(out.filename));
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
  handle((req) => gated(req, 'sheet', req.body ?? {}, (db, c, id, b) => importSheet(db, c, id, b))));

// DRAWINGS — DXF or PDF per row of the line, matched by drawing mark (a plate part's DXF is its
// shape). A dry run reads and matches and writes nothing; saving also refreshes the line's cut
// plates' cut length and piercings. /file downloads the drawing itself.
router.get('/orders/:orderId/lines/:lineId/drawings', view,
  handle((req) => read(req, (db, companyId, id) => getDrawings(db, companyId, null, id))));
// THE TREE: every row of the line with its parent and whether it has a drawing (view permission) — the viewer's levels.
router.get('/orders/:orderId/lines/:lineId/drawings/tree', view,
  handle((req) => read(req, (db, companyId, id) => drawingTree(db, companyId, null, id))));
router.post('/orders/:orderId/lines/:lineId/drawings', manage,
  handle((req) => write(req, (db, c, id) => uploadDrawings(db, c, null, id, req.body ?? {}))));
// START a register drawing from rows before its file exists: { rowIds, number, revision?, title?, source?, status? }.
router.post('/orders/:orderId/lines/:lineId/drawings/start', manage,
  handle((req) => write(req, (db, c, id) => startDrawing(db, c, null, id, req.body ?? {}))));
router.get('/orders/:orderId/lines/:lineId/drawings/:drawingId/file', view, handle(async (req, res) => {
  const out = await read(req, (db, companyId, id) => drawingFile(db, companyId, null, id, intParam(req.params.drawingId, 'drawingId')));
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', contentDisposition(out.filename));
  res.setHeader('Content-Length', String(out.buffer.length));
  res.send(out.buffer);
}));
router.delete('/orders/:orderId/lines/:lineId/drawings/:drawingId', manage,
  handle((req) => write(req, (db, c, id) => deleteDrawing(db, c, null, id, intParam(req.params.drawingId, 'drawingId')))));

// THE CUSTOMER'S NESTING FILES (§55). One DXF per plate, many in one request, base64 in the JSON
// body like the sheet. dryRun is the DEFAULT: the answer is what would happen — every file read,
// matched, checked, and the difference against what is saved — and nothing is written.
router.get('/orders/:orderId/lines/:lineId/nesting/files', view,
  handle((req) => read(req, (db, companyId, id) => getNestFiles(db, companyId, id))));
router.post('/orders/:orderId/lines/:lineId/nesting/files', manage,
  handle(async (req) => {
    const out = await gated(req, 'upload', req.body ?? {}, (db, c, id, b) => uploadNestFiles(db, c, id, b));
    return afterUploadSaved(req, out);
  }));
router.get('/orders/:orderId/lines/:lineId/nesting/files/:lotId', view, handle(async (req, res) => {
  const out = await read(req, (db, companyId, id) => nestFileOf(db, companyId, id, intParam(req.params.lotId, 'lotId')));
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', contentDisposition(out.filename));
  res.setHeader('Content-Length', String(out.buffer.length));
  res.send(out.buffer);
}));
router.delete('/orders/:orderId/lines/:lineId/nesting/lots/:lotId', manage,
  handle(async (req) => {
    const out = await gated(req, 'delete_lot', { ...(req.body ?? {}), lotId: intParam(req.params.lotId, 'lotId') }, (db, c, id, b) => deleteNestLot(db, c, id, b.lotId));
    // A customer's plate taken off changes what the upload holds: the comparison follows it.
    return out?.removed?.origin === 'imported' ? afterUploadSaved(req, out) : out;
  }));

// PLATES THE FILES USE THAT THE CATALOG DOES NOT HAVE (2026-10-14): the preview lists them
// (`missingPlates`), this adds them — custom sizes unless told otherwise. It is asked from an order's
// nesting, so it needs the order grant; it writes catalog items, so it needs the catalog grant too.
router.post('/orders/:orderId/lines/:lineId/nesting/plates', manage,
  handle((req) => { assertPerm(req, PERM.catalog); return write(req, (db, c, id) => createNestPlates(db, c, id, req.body ?? {})); }));

// CUT FROM UNTRACKED OFFCUTS (§61): the pieces the files leave over that the shop cuts from loose offcuts in the
// yard. Marked, they are no longer left over, need no plate and no heat number; their steel is charged at the plate rate.
router.get('/orders/:orderId/lines/:lineId/nesting/untracked', view,
  handle((req) => read(req, (db, companyId, id) => getUntracked(db, companyId, id))));
router.post('/orders/:orderId/lines/:lineId/nesting/untracked', manage,
  handle((req) => gated(req, 'untracked', req.body ?? {}, (db, c, id, b) => markUntracked(db, c, id, b))));
router.delete('/orders/:orderId/lines/:lineId/nesting/untracked', manage,
  handle((req) => gated(req, 'untracked_undo', { ...(req.query ?? {}), ...(req.body ?? {}) }, (db, c, id, b) => unmarkUntracked(db, c, id, b))));

// COMPARE the uploaded nesting with our automatic one, side by side. The GET never packs: it pulls
// up the automatic run that already answers this demand, or says there is none (or that it is
// stale). The POST starts that run in the background and returns its id to poll here.
router.get('/orders/:orderId/lines/:lineId/nesting/compare', view,
  handle((req) => read(req, (db, companyId, id) => getCompare(db, companyId, id, { with: req.query.with, detail: String(req.query.detail ?? '') === '1' }))));
router.post('/orders/:orderId/lines/:lineId/nesting/compare', view,
  handle((req) => read(req, (db, companyId, id) => startCompare(db, { ...ctx(req), userName: req.user?.name ?? req.user?.email ?? null }, id, req.body ?? {}))));
router.post('/orders/:orderId/lines/:lineId/nesting/compare/stop', view,
  handle((req) => read(req, (db, companyId, id) => stopRunAnywhere(companyId, id, { purpose: 'compare' }))));
router.delete('/orders/:orderId/lines/:lineId/nesting/compare', view,
  handle((req) => read(req, (db, companyId, id) => cancelRun(companyId, id, { purpose: 'compare' }))));
router.post('/orders/:orderId/lines/:lineId/nesting/compare/accept', manage,
  handle((req) => gated(req, 'compare', req.body ?? {}, (db, c, id, b) => acceptCompare(db, c, id, b))));

// §87 (2026-10-18): the alternative. The GET is light (the screen asks it to keep the Compare tab when AI's nesting is the
// main one and no customer's plate is saved); the swap is a plate write like any other — through the gate, with the
// before / after sheet when the screen asks (`impact: true`). The line's finished nesting proposal goes with it.
router.get('/orders/:orderId/lines/:lineId/nesting/alternative', view,
  handle((req) => read(req, (db, companyId, id) => alternativeOf(db, companyId, id))));
router.post('/orders/:orderId/lines/:lineId/nesting/alternative/swap', manage,
  handle(async (req) => {
    const out = await gated(req, 'swap_alternative', req.body ?? {}, (db, c, id, b) => swapAlternative(db, c, id, b));
    if (!out?.requested) await dismissRun(ctx(req).companyId, lineId(req), { accepted: true });
    return out;
  }));

/** A file out: the buffer, its type, and a download name. */
const sendFile = (res, out, type) => {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', contentDisposition(out.filename));
  res.setHeader('Content-Length', String(out.buffer.length));
  res.send(out.buffer);
};

/** ?style=ai[&leads=1][&order=1] — the AI (ProNest) DXF of aiNestDxf.js; anything else — the plain one, as before. */
const dxfOpts = (q) => (q?.style === 'ai' ? { style: 'ai', leads: q.leads === '1' || q.leads === 'true', order: q.order === '1' || q.order === 'true' } : {});

// The AI cut plan of one nest, as data: part in part, shared-line blocks, leads, pierce, kerf side, cut order.
router.get('/orders/:orderId/lines/:lineId/nesting/cut-plan/:lotId', view,
  handle((req) => read(req, (db, companyId, id) => lotAiPlan(db, companyId, id, intParam(req.params.lotId, 'lotId')))));

router.get('/orders/:orderId/lines/:lineId/nesting/cnc', view, handle(async (req, res) => {
  const out = await read(req, (db, companyId, id) => lineCncZip(db, companyId, id, dxfOpts(req.query)));
  sendFile(res, out, 'application/zip');
}));

// A nest without a layout of ours has no drawing: lotDxf refuses it with
// NO_LAYOUT (422), which handle() passes through as it is.
router.get('/orders/:orderId/lines/:lineId/nesting/cnc/:lotId', view, handle(async (req, res) => {
  const lotId = intParam(req.params.lotId, 'lotId');
  const out = await read(req, (db, companyId, id) => lotDxf(db, companyId, id, lotId, dxfOpts(req.query)));
  sendFile(res, out, 'application/dxf');
}));

export default router;
