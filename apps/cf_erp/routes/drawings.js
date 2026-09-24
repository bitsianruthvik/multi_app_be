/**
 * drawings.js — drawing references and what they cover, at every level of a
 * custom BOM. A reference (number, revision, optional URL), never a file:
 * nothing in this stack stores files and choosing where they live is a separate
 * decision.
 *
 *   GET    /drawings?source=&status=&current=&rootId=&subjectId=&search=&limit=&offset=
 *   POST   /drawings                  { number, revision?, title?, source?, url?, status?, issuedOn?, notes?, code? }
 *   GET    /drawings/:id              the sheet, its whole revision history, and what it covers
 *   PUT    /drawings/:id              title/url/notes/issuedOn any time; number/source/revision/code only while draft
 *   POST   /drawings/:id/issue        draft -> issued
 *   POST   /drawings/:id/retire       { reason? }  draft|issued -> withdrawn (one way)
 *   POST   /drawings/:id/revision     { revision?, title?, url?, notes?, issuedOn?, carryLinks? }
 *                                     a NEW ROW; the old one becomes superseded and keeps its links
 *   DELETE /drawings/:id              a draft with no links only — a typed-wrong number must be removable
 *
 *   GET    /drawings/:id/covers       what this revision covers
 *   POST   /drawings/:id/links        { subjectId, subjectType?, note? }
 *   DELETE /drawing-links/:id
 *
 *   GET    /records/:id/drawings?history=&source=   the drawings covering this record
 *
 * Reads need the catalog view grant, writes the catalog manage grant: a drawing
 * hangs off a master record, which is what that pair already governs. No new
 * permission tag was invented for this — see the report if order managers turn
 * out to need one of their own.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import {
  listDrawings, getDrawing, createDrawing, updateDrawing, issueDrawing, retireDrawing,
  reviseDrawing, deleteDrawing, linkDrawing, removeLink, drawingCoverage, drawingsForRecord,
} from '../services/drawingService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const company = (req) => ctx(req).companyId;
const view = guard(PERM.view);
const manage = guard(PERM.catalog);

router.get('/drawings', view, handle((req) => listDrawings(pool, company(req), req.query)));
router.post('/drawings', manage, handle((req) => tx(req, (db, c) => createDrawing(db, c, req.body ?? {}))));
router.get('/drawings/:id', view, handle((req) => getDrawing(pool, company(req), id(req))));
router.put('/drawings/:id', manage, handle((req) => tx(req, (db, c) => updateDrawing(db, c, id(req), req.body ?? {}))));
router.post('/drawings/:id/issue', manage, handle((req) => tx(req, (db, c) => issueDrawing(db, c, id(req)))));
router.post('/drawings/:id/retire', manage, handle((req) => tx(req, (db, c) => retireDrawing(db, c, id(req), req.body ?? {}))));
router.post('/drawings/:id/revision', manage, handle((req) => tx(req, (db, c) => reviseDrawing(db, c, id(req), req.body ?? {}))));
router.delete('/drawings/:id', manage, handle((req) => tx(req, (db, c) => deleteDrawing(db, c, id(req)))));

router.get('/drawings/:id/covers', view, handle((req) => drawingCoverage(pool, company(req), id(req))));
router.post('/drawings/:id/links', manage, handle((req) => tx(req, (db, c) => linkDrawing(db, c, id(req), req.body ?? {}))));
router.delete('/drawing-links/:id', manage, handle((req) => tx(req, (db, c) => removeLink(db, c, id(req)))));

router.get('/records/:id/drawings', view, handle((req) => drawingsForRecord(pool, company(req), id(req), req.query)));

export default router;
