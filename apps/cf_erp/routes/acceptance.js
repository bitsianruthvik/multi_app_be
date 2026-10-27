/**
 * acceptance.js — CUSTOMER ACCEPTANCE (the sales order's confirm step), its templates, the MR to share with the customer,
 * the Orders board and its post-production checklist (init.sql §73).
 *
 *   GET    /term-templates?kind=charges|milestones|stages     Setup › Templates
 *   POST   /term-templates            { kind, name, isDefault?, rows, notes? }
 *   PUT    /term-templates/:id        { name?, isDefault?, rows?, notes? }
 *   DELETE /term-templates/:id
 *   GET    /orders/:id/acceptance     the step: terms (pending / sent back / approved / templates), estimate, standing, lists
 *   PUT    /orders/:id/acceptance     { charges, material, lumpSums, milestones, stages, note?, dryRun? } — send to Management
 *                                     (dryRun = the live check and estimate; a later save on an approved order = a rate change)
 *   POST   /orders/:id/acceptance/withdraw   take the pending terms back
 *   GET    /orders/:id/events         what happened to the order (billing, step 3B, reads these)
 *   GET    /orders/:id/mr-document?format=pdf|xlsx   the order's MR as a file for the customer
 *   GET    /order-board?search=       Sales › Orders board: lanes from tracked facts
 *   POST   /order-post-stages/:id/done  { date?, note? }   a post-production stage done (recorded; the last one closes the order)
 *   POST   /order-post-stages/:id/undo  { note? }
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, guardAny, handle, ctx, intParam, contentDisposition } from '../lib/http.js';
import { APPROVAL_PERMS } from '../services/approvalService.js';
import {
  listTemplates, createTemplate, updateTemplate, deleteTemplate, getAcceptance, saveAcceptance, withdrawAcceptance, orderEvents,
} from '../services/acceptanceService.js';
import { mrDocument } from '../services/mrDocumentService.js';
import { orderBoard, markStageDone, undoStageDone } from '../services/orderBoardService.js';

const router = Router();
const id = (req) => intParam(req.params.id);
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const view = guard(PERM.ordersView);
const manage = guard(PERM.orders);
// Management reads an order's acceptance from the inbox without the order grants.
const viewAcceptance = guardAny(PERM.ordersView, ...APPROVAL_PERMS);

router.get('/term-templates', view, handle((req) => listTemplates(pool, ctx(req).companyId, req.query)));
router.post('/term-templates', manage, handle((req) => tx(req, (db, c) => createTemplate(db, c, req.body ?? {}))));
router.put('/term-templates/:id', manage, handle((req) => tx(req, (db, c) => updateTemplate(db, c, id(req), req.body ?? {}))));
router.delete('/term-templates/:id', manage, handle((req) => tx(req, (db, c) => deleteTemplate(db, c, id(req)))));

router.get('/orders/:id/acceptance', viewAcceptance, handle((req) => getAcceptance(pool, ctx(req).companyId, id(req))));
// A dry run writes nothing, so it needs no transaction (the step's live preview calls it on every change).
router.put('/orders/:id/acceptance', manage, handle((req) => (req.body?.dryRun
  ? saveAcceptance(pool, ctx(req), id(req), req.body)
  : tx(req, (db, c) => saveAcceptance(db, c, id(req), req.body ?? {})))));
router.post('/orders/:id/acceptance/withdraw', manage, handle((req) => tx(req, (db, c) => withdrawAcceptance(db, c, id(req)))));
router.get('/orders/:id/events', viewAcceptance, handle((req) => orderEvents(pool, ctx(req).companyId, id(req))));

router.get('/orders/:id/mr-document', guardAny(PERM.ordersView, PERM.inventoryView), async (req, res) => {
  try {
    const out = await mrDocument(pool, ctx(req).companyId, id(req), req.query.format);
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', contentDisposition(out.filename));
    res.setHeader('Content-Length', String(out.buffer.length));
    res.send(out.buffer);
  } catch (err) {
    res.status(err?.status ?? 500).json({ code: err?.code, message: err?.status ? err.message : 'Something went wrong.' });
  }
});

router.get('/order-board', view, handle((req) => orderBoard(pool, ctx(req).companyId, req.query)));
router.post('/order-post-stages/:id/done', manage, handle((req) => tx(req, (db, c) => markStageDone(db, c, id(req), req.body ?? {}))));
router.post('/order-post-stages/:id/undo', manage, handle((req) => tx(req, (db, c) => undoStageDone(db, c, id(req), req.body ?? {}))));

export default router;
