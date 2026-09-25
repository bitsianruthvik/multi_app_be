/**
 * nesting.js — laying a sales order line's cut plates out on real raw plates.
 *
 *   GET  /orders/:orderId/lines/:lineId/nesting          the SAVED plan
 *   POST /orders/:orderId/lines/:lineId/nesting/plan     { effort?, guillotine?, seed? } — propose
 *   POST /orders/:orderId/lines/:lineId/nesting/accept   { groups | nests } — write it
 *   GET  /orders/:orderId/lines/:lineId/nesting/sheet    the layout as a workbook
 *   POST /orders/:orderId/lines/:lineId/nesting/sheet    { fileBase64 } — read it back
 *
 * A LOOK IS A LOOK. The GET reads what was accepted and does not re-pack:
 * re-solving on every open cost the other system a 36-second spinner, and a
 * saved plan IS the plan. /plan is the button that re-packs, and it is a POST
 * because it is an action a person asks for — it still writes nothing.
 *
 * SUGGEST, THEN ACCEPT. /plan proposes and /accept writes; nothing reaches the
 * database in between. Uploading the sheet is the one exception, and it is not
 * really one: the sheet says on its own face that uploading IT is accepting it,
 * and it goes through the same acceptNesting, with the same verification.
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
  planNesting, acceptNesting, getNesting, exportNestingSheet, importNestingSheet, assertLineOnOrder,
} from '../services/nestingService.js';

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
  handle((req) => write(req, (db, c, id) => acceptNesting(db, c, id, req.body ?? {}))));

router.get('/orders/:orderId/lines/:lineId/nesting/sheet', view, handle(async (req, res) => {
  const out = await read(req, (db, companyId, id) => exportNestingSheet(db, companyId, id));
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Content-Length', String(out.buffer.length));
  // Says what the caller got without having to open the file: how many pieces,
  // and whether this is the saved plan or a proposal made because none exists.
  res.setHeader('X-CF-Sheet-Rows', String(out.rows));
  res.setHeader('X-CF-Sheet-Saved', out.saved ? '1' : '0');
  res.send(out.buffer);
}));

// Uploading the sheet IS accepting it. The workbook says so on its own face.
router.post('/orders/:orderId/lines/:lineId/nesting/sheet', manage,
  handle((req) => write(req, (db, c, id) => importNestingSheet(db, c, id, req.body ?? {}))));

export default router;
