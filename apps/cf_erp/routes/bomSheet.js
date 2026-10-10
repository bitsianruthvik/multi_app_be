/**
 * bomSheet.js — an order line's structure as a spreadsheet, out and back in.
 *
 *   GET  /order-lines/:id/sheet          the workbook: the BOM as the screen shows it,
 *                                        two rows per line (orderSheetService; .xlsx only)
 *   POST /order-lines/:id/sheet          { fileBase64, dryRun? } — read it back
 *   GET  /records/:id/bom/sheet          a catalog item's or definition's BOM, one row
 *   POST /records/:id/bom/sheet          per line (bomSheetService; ?format=csv for a CSV)
 *
 * The same grant as the rest of a sales order's structure, for the same reason
 * orders.js splits them: downloading the sheet is reading the order, importing
 * it rewrites the order's own BOM.
 *
 * The file arrives as base64 in the JSON body. cf_erp takes no multipart
 * anywhere else, and a BOM sheet is tens of kilobytes; adding an upload
 * middleware for one route is a decision for whoever needs it.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam, assertPerm } from '../lib/http.js';
import { requireMaster } from '../services/records.js';
import { bomTypeOf } from '../services/bomGraph.js';
import { exportRecordSheet, importRecordSheet } from '../services/bomSheetService.js';
import { exportOrderSheet, importOrderSheet } from '../services/orderSheetService.js';
import { withCutPieces } from '../services/cutPlateService.js';

const router = Router();
const id = (req) => intParam(req.params.id);

router.get('/order-lines/:id/sheet', guard(PERM.ordersView), handle(async (req, res) => {
  const out = await exportOrderSheet(pool, ctx(req).companyId, id(req));
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Content-Length', String(out.buffer.length));
  // Tells a caller what it got without having to open the file.
  res.setHeader('X-CF-Sheet-Rows', String(out.rows));
  res.send(out.buffer);
}));

// An applied sheet is followed by the line's cut pieces (cutPlateService.refreshCutPieces).
router.post('/order-lines/:id/sheet', guard(PERM.orders), handle((req) => withTransaction(async (db) => {
  const c = ctx(req);
  const out = await importOrderSheet(db, c, id(req), req.body ?? {});
  return out.applied ? withCutPieces(db, c, id(req), out) : out;
})));

// The same workbook is useful on the catalogue side: an item or definition's
// own BOM is shared by every order that uses it. Permission follows the parent,
// as in boms.js; a temporary record also refreshes its order's cut pieces.
router.get('/records/:id/bom/sheet', guard(PERM.view), handle(async (req, res) => {
  const out = await exportRecordSheet(pool, ctx(req).companyId, id(req), { format: req.query.format });
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Content-Length', String(out.buffer.length));
  res.setHeader('X-CF-Sheet-Rows', String(out.rows));
  res.send(out.buffer);
}));

router.post('/records/:id/bom/sheet', guard(PERM.view), handle((req) => withTransaction(async (db) => {
  const c = ctx(req);
  const parent = await requireMaster(db, c.companyId, id(req));
  assertPerm(req, bomTypeOf(parent) === 'custom' ? PERM.orders : PERM.catalog);
  const out = await importRecordSheet(db, c, id(req), req.body ?? {});
  return out.applied && parent.item_type === 'temporary'
    ? withCutPieces(db, c, parent.owner_order_line_id, out) : out;
})));

export default router;
