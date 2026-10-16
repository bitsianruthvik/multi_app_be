/**
 * plateChanges.js — PLATE CHANGES AFTER A PURCHASE ORDER, approved by the MD (init.sql §62, 2026-10-16).
 * Service: services/plateChangeService.js. The gate itself sits on the nesting write routes (routes/nesting.js).
 *
 *   GET  /orders/:orderId/lines/:lineId/nesting/plate-changes   the line's gate (is a PO covering it? is it held?)
 *                                                                and its requests, newest first      orders view
 *   GET  /plate-changes?status=pending|open|done|all            across orders (the Buying area)     approve OR buying manage
 *   GET  /plate-changes/:id                                     one request, with its events        orders view OR approve OR buying manage
 *   POST /plate-changes/:id/approve   { note? }                 save it, sync the requisition, write the buyer checklist
 *                                                                                                      approve (not one's own unless admin)
 *   POST /plate-changes/:id/reject    { note }                  the note is required                 approve
 *   POST /plate-changes/:id/withdraw  { note? }                 the person who asked (or an approver / admin)   orders manage OR approve
 *   POST /plate-changes/:id/checklist { key, done }             the buyer ticks one purchase-order action        buying manage
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, guardAny, handle, ctx, intParam } from '../lib/http.js';
import { isPermitted } from '../../../core/middleware/requirePerm.js';
import { assertLineOnOrder } from '../services/nestingService.js';
import { dismissRun } from '../services/nestRunService.js';
import {
  lineChanges, listChanges, getChange, approveChange, rejectChange, withdrawChange, tickChecklist,
} from '../services/plateChangeService.js';

const router = Router();

/** Who is asking, and what they may do — the service decides with it. */
export const viewerOf = (req) => ({
  ...ctx(req),
  userName: req.user?.name ?? req.user?.email ?? null,
  canApprove: isPermitted(req.user, PERM.plateChangeApprove),
  canTick: isPermitted(req.user, PERM.inventory),
  canManage: isPermitted(req.user, PERM.orders),
  isAdmin: String(req.user?.role ?? '').toLowerCase() === 'admin',
});
const id = (req) => intParam(req.params.id, 'id');

router.get('/orders/:orderId/lines/:lineId/nesting/plate-changes', guard(PERM.ordersView),
  handle(async (req) => {
    const v = viewerOf(req);
    const lineId = await assertLineOnOrder(pool, v.companyId, intParam(req.params.orderId, 'orderId'), intParam(req.params.lineId, 'lineId'));
    return lineChanges(pool, v, lineId);
  }));

router.get('/plate-changes', guardAny(PERM.plateChangeApprove, PERM.inventory),
  handle((req) => listChanges(pool, viewerOf(req), req.query ?? {})));

router.get('/plate-changes/:id', guardAny(PERM.ordersView, PERM.plateChangeApprove, PERM.inventory),
  handle((req) => getChange(pool, viewerOf(req), id(req))));

router.post('/plate-changes/:id/approve', guard(PERM.plateChangeApprove),
  handle(async (req) => {
    const v = viewerOf(req);
    const out = await withTransaction((db) => approveChange(db, v, id(req), req.body ?? {}));
    // Found out of date: its status is committed first, then the refusal is said.
    if (out.refusal) throw out.refusal;
    // An approved "save our nesting" is the saved plan now: the finished run has done its job (as /accept).
    if (out.kind === 'accept') await dismissRun(v.companyId, out.lineId, { accepted: true });
    return out.request;
  }));

router.post('/plate-changes/:id/reject', guard(PERM.plateChangeApprove),
  handle((req) => withTransaction((db) => rejectChange(db, viewerOf(req), id(req), req.body ?? {}))));

router.post('/plate-changes/:id/withdraw', guardAny(PERM.orders, PERM.plateChangeApprove),
  handle((req) => withTransaction((db) => withdrawChange(db, viewerOf(req), id(req), req.body ?? {}))));

router.post('/plate-changes/:id/checklist', guard(PERM.inventory),
  handle((req) => withTransaction((db) => tickChecklist(db, viewerOf(req), id(req), req.body ?? {}))));

export default router;
