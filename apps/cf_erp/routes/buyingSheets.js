/**
 * buyingSheets.js — the buying chain as Excel, out and back in (services/buyingSheetService.js; user, 2026-10-31).
 *
 *   GET  /material-requests/:id/sheet     the MR lines (.xlsx)
 *   POST /material-requests/:id/sheet     { fileBase64, dryRun?, customerDate? } — take from stock per item code (saveMr)
 *   GET  /purchase-requests/:id/sheet     the quote grid: a row per PR line, "<SUPPLIER CODE> rate | days | remark"
 *   POST /purchase-requests/:id/sheet     { fileBase64, dryRun? } — quotes by item code × supplier code (wide or long);
 *                                         a new supplier code adds its vendor column (addVendor + setQuotes)
 *   GET  /purchase-orders/:id/sheet       the PO header + lines
 *   POST /purchase-orders/:id/sheet       { fileBase64, dryRun? } — qty, unit price, expected date per item code, and the
 *                                         PO's own expected date; refused once Management approved it
 *
 * The same grants as the screens' own saves: reading = the screen's read; an MR upload = saving the MR (inventory manage
 * or Stores); a PR or PO upload = Purchase (cf_erp_purchase — vendors, quotes, a PO's lines and prices are Purchase's).
 * Every POST answers the preview { ok, problems[], changes[], summary.sentence } and only a non-dry run writes.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, guardAny, handle, ctx, intParam, contentDisposition } from '../lib/http.js';
import { APPROVAL_PERMS } from '../services/approvalService.js';
import {
  exportMrSheet, importMrSheet, exportPrSheet, importPrSheet, exportPoSheet, importPoSheet,
} from '../services/buyingSheetService.js';

const router = Router();
const id = (req) => intParam(req.params.id);
const view = guardAny(PERM.inventoryView, PERM.stores, PERM.purchase);
const mrManage = guardAny(PERM.inventory, PERM.stores);
const buy = guard(PERM.purchase);
const viewPo = guardAny(PERM.inventoryView, PERM.purchase, PERM.plateChangeApprove, ...APPROVAL_PERMS);

const send = (fn) => handle(async (req, res) => {
  const out = await fn(pool, ctx(req).companyId, id(req));
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', contentDisposition(out.filename));
  res.setHeader('Content-Length', String(out.buffer.length));
  res.setHeader('X-CF-Sheet-Rows', String(out.rows));
  res.send(out.buffer);
});
const upload = (fn) => handle((req) => withTransaction((db) => fn(db, ctx(req), id(req), req.body ?? {})));

router.get('/material-requests/:id/sheet', view, send(exportMrSheet));
router.post('/material-requests/:id/sheet', mrManage, upload(importMrSheet));
router.get('/purchase-requests/:id/sheet', view, send(exportPrSheet));
router.post('/purchase-requests/:id/sheet', buy, upload(importPrSheet));
router.get('/purchase-orders/:id/sheet', viewPo, send(exportPoSheet));
router.post('/purchase-orders/:id/sheet', buy, upload(importPoSheet));

export default router;
