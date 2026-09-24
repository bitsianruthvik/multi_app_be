/**
 * bomSheet.js — an order line's structure as a spreadsheet, out and back in.
 *
 *   GET  /order-lines/:id/sheet          the workbook (?format=csv for a CSV)
 *   POST /order-lines/:id/sheet          { fileBase64, dryRun? } — read it back
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
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { exportSheet, importSheet } from '../services/bomSheetService.js';

const router = Router();
const id = (req) => intParam(req.params.id);

router.get('/order-lines/:id/sheet', guard(PERM.ordersView), handle(async (req, res) => {
  const out = await exportSheet(pool, ctx(req).companyId, id(req), { format: req.query.format });
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Content-Length', String(out.buffer.length));
  // Tells a caller what it got without having to open the file.
  res.setHeader('X-CF-Sheet-Rows', String(out.rows));
  res.send(out.buffer);
}));

router.post('/order-lines/:id/sheet', guard(PERM.orders), handle((req) => withTransaction((db) => importSheet(db, ctx(req), id(req), req.body ?? {}))));

export default router;
