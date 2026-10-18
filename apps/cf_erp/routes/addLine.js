/**
 * addLine.js — ADD LINE (three choices) and the New order dialog's order values (init.sql §77, services/drawingLineService.js).
 *
 *   GET  /order-defaults/new                     the order values the New order dialog shows, prefilled
 *                                                (the company's last order, else the templates' most common value)
 *   POST /orders/:id/lines/from-drawing          { file: { name, content }, quantity?, committedDate?, description?, rate?, rateBasis? }
 *                                                → the order + fromDrawing { lineId, parts, rows, flagged, flags[], sentence }
 *   GET  /order-lines/:id/drawing-import         { import (file, parts, rows, flagged) | null, open: [{ rowId, notes }] }
 *   POST /order-lines/:id/ai-flags/clear         { rowIds? } — mark checked (all rows when none given)
 *   POST /order-lines/:id/standard/from-line     { number, name?, revision?, description?, notes? } — a new standard + version 1, one request
 *
 * (POST /orders takes `specDefaults: [{ specCode, value }]` too — salesOrderService.createOrder.)
 * Reads: orders view. Writes: orders manage.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { addLineFromDrawing, lineDrawingImport, clearAiFlags, saveLineAsStandard, newOrderDefaults } from '../services/drawingLineService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);

router.get('/order-defaults/new', guard(PERM.ordersView), handle((req) => newOrderDefaults(pool, ctx(req).companyId)));
router.post('/orders/:id/lines/from-drawing', guard(PERM.orders), handle((req) => tx(req, (db, c) => addLineFromDrawing(db, c, id(req), req.body ?? {}))));
router.get('/order-lines/:id/drawing-import', guard(PERM.ordersView), handle((req) => lineDrawingImport(pool, ctx(req).companyId, id(req))));
router.post('/order-lines/:id/ai-flags/clear', guard(PERM.orders), handle((req) => tx(req, (db, c) => clearAiFlags(db, c, id(req), req.body ?? {}))));
router.post('/order-lines/:id/standard/from-line', guard(PERM.orders), handle((req) => tx(req, (db, c) => saveLineAsStandard(db, c, id(req), req.body ?? {}))));

export default router;
