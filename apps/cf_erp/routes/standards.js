/**
 * standards.js — STANDARD DRAWINGS (init.sql §69, services/standardDrawingService.js).
 *
 *   GET    /standard-drawings?search=            the list: number, name, revision, current version (rows, parts, weight), files, lines
 *   GET    /standard-drawings/:id?versionId=     one standard: its register drawing, versions, the tree with values, files, lines
 *   POST   /standard-drawings                    { number, name?, description?, revision?, sourceUrl?, internal?, notes?, file?: { name, content } }
 *   PUT    /standard-drawings/:id                { name?, description?, revision?, sourceUrl?, internal?, notes? }
 *   GET    /standard-drawings/files/:fileId      one of its files (DXF / PDF)
 *
 *   POST   /orders/:id/lines/from-standard       { standardId | number, versionId?, quantity, committedDate?, description?, rate?, rateBasis? }
 *                                                → the order, + fromStandard { lineId, standardId, number, versionNo, rows, cutPieces }
 *   GET    /order-lines/:id/standard             { line, standard, version, latest, newer, edited, kept, offer: 'save'|'update'|null, canCreate }
 *   POST   /order-lines/:id/standard             the same body as POST /standard-drawings: a new standard tied to this line
 *                                                (the file also goes on the line's top row)
 *   POST   /order-lines/:id/standard/save        { note? } — the line's BOM and values become the standard's next version
 *   POST   /order-lines/:id/standard/keep        "Keep the standard as it is" for the BOM as it stands
 *
 * Reads: the orders view or the catalog view grant. Writes: the orders manage grant — the people who add lines.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, guardAny, handle, ctx, intParam, contentDisposition } from '../lib/http.js';
import {
  listStandards, getStandard, createStandard, updateStandard, standardFile,
  addLineFromStandard, lineStandard, saveLineToStandard, keepStandard,
} from '../services/standardDrawingService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const company = (req) => ctx(req).companyId;
const view = guardAny(PERM.ordersView, PERM.view);
const manage = guard(PERM.orders);

router.get('/standard-drawings', view, handle((req) => listStandards(pool, company(req), req.query)));
router.get('/standard-drawings/files/:fileId', view, handle(async (req, res) => {
  const out = await standardFile(pool, company(req), intParam(req.params.fileId, 'fileId'));
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', contentDisposition(out.filename));
  res.setHeader('Content-Length', String(out.buffer.length));
  res.send(out.buffer);
}));
router.get('/standard-drawings/:id', view, handle((req) => getStandard(pool, company(req), id(req), req.query)));
router.post('/standard-drawings', manage, handle((req) => tx(req, (db, c) => createStandard(db, c, req.body ?? {}))));
router.put('/standard-drawings/:id', manage, handle((req) => tx(req, (db, c) => updateStandard(db, c, id(req), req.body ?? {}))));

router.post('/orders/:id/lines/from-standard', manage, handle((req) => tx(req, (db, c) => addLineFromStandard(db, c, id(req), req.body ?? {}))));
router.get('/order-lines/:id/standard', view, handle((req) => lineStandard(pool, company(req), id(req))));
router.post('/order-lines/:id/standard', manage, handle((req) => tx(req, (db, c) => createStandard(db, c, req.body ?? {}, { lineId: id(req) }))));
router.post('/order-lines/:id/standard/save', manage, handle((req) => tx(req, (db, c) => saveLineToStandard(db, c, id(req), req.body ?? {}))));
router.post('/order-lines/:id/standard/keep', manage, handle((req) => tx(req, (db, c) => keepStandard(db, c, id(req)))));

export default router;
