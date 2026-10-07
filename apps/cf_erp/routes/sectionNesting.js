/**
 * sectionNesting.js — 1-D nesting of section cut pieces on stock bars (CF_ERP_CUT_FROM_PLAN.md §11.3).
 *
 *   GET    /orders/:orderId/lines/:lineId/section-nesting         the SAVED plan (SectionNestingView)
 *   POST   /orders/:orderId/lines/:lineId/section-nesting/plan    a fresh plan, nothing written
 *   POST   /orders/:orderId/lines/:lineId/section-nesting/accept  {} — plans again and writes it
 *   DELETE /orders/:orderId/lines/:lineId/section-nesting         take the accepted plan back (nothing cut yet)
 *   GET    /orders/:orderId/lines/:lineId/section-nesting/sheet   the bars as a workbook
 *   POST   /orders/:orderId/lines/:lineId/section-nesting/sheet   { file, filename, dryRun, force } — preview, or save
 *
 * The same rules as plate nesting (routes/nesting.js): the line is addressed
 * through its order and the two are checked against each other; seeing and
 * proposing take the orders-view grant, writing takes orders-manage; writes run
 * in one transaction so a refusal leaves the line as it was.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { assertLineOnOrder } from '../services/nestingService.js';
import {
  getSectionNesting, planSectionNesting, acceptSectionNesting, takeBackSectionNesting,
} from '../services/sectionNestingService.js';
import { exportSectionSheet, importSectionSheet } from '../services/sectionSheetService.js';

const router = Router();
const view = guard(PERM.ordersView);
const manage = guard(PERM.orders);
const BASE = '/orders/:orderId/lines/:lineId/section-nesting';
const orderId = (req) => intParam(req.params.orderId, 'orderId');
const lineId = (req) => intParam(req.params.lineId, 'lineId');

const read = (req, fn) => (async () => {
  const { companyId } = ctx(req);
  const id = await assertLineOnOrder(pool, companyId, orderId(req), lineId(req));
  return fn(pool, companyId, id);
})();

const write = (req, fn) => withTransaction(async (db) => {
  const c = ctx(req);
  const id = await assertLineOnOrder(db, c.companyId, orderId(req), lineId(req));
  return fn(db, c, id);
});

router.get(BASE, view, handle((req) => read(req, (db, companyId, id) => getSectionNesting(db, companyId, id))));

router.post(`${BASE}/plan`, view, handle((req) => read(req, (db, companyId, id) => planSectionNesting(db, companyId, id))));

router.post(`${BASE}/accept`, manage, handle((req) => write(req, (db, c, id) => acceptSectionNesting(db, c, id))));

router.delete(BASE, manage, handle((req) => write(req, (db, c, id) => takeBackSectionNesting(db, c, id))));

router.get(`${BASE}/sheet`, view, handle(async (req, res) => {
  const out = await read(req, (db, companyId, id) => exportSectionSheet(db, companyId, id));
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Content-Length', String(out.buffer.length));
  res.setHeader('X-CF-Sheet-Rows', String(out.rows));
  res.setHeader('X-CF-Sheet-Bars', String(out.bars));
  res.setHeader('X-CF-Sheet-Saved', out.saved ? '1' : '0');
  res.send(out.buffer);
}));

router.post(`${BASE}/sheet`, manage, handle((req) => write(req, (db, c, id) => importSectionSheet(db, c, id, req.body ?? {}))));

export default router;
