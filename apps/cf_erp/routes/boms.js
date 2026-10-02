/**
 * boms.js — BOMs of any record, and their lines.
 *
 *   GET    /records/:id/bom                 the BOM, its lines, what it may contain
 *   GET    /records/:id/bom/tree            the whole structure below it (?quantity= for the top)
 *   GET    /records/:id/bom/codes           each row's code, worked out by the order coding rules (preview, nothing stored)
 *   GET    /records/:id/where-used          BOMs that hold it
 *   POST   /records/:id/bom/lines           { childId, quantity, role?, lineNo?, notes?, operationFlowId? }
 *   POST   /records/:id/bom/status          { status: active | obsolete }   (standard / template)
 *   POST   /records/:id/bom/revision        { revision? }                   (standard / template)
 *   PUT    /bom-lines/:id                   { quantity?, role?, lineNo?, notes?, operationFlowId? }  (null clears the flow)
 *   DELETE /bom-lines/:id                   a temporary item goes with its line
 *   GET    /bom-lines/:id/candidates        catalog items a selection line may take
 *   POST   /bom-lines/:id/resolve           { itemId | null }
 *   POST   /bom-changes                     { scope: { recordId } | { orderLineId }, dryRun?, changes: [...] }
 *                                           edit mode: quantity / flow / remove / paste, all or nothing
 *                                           (services/bomChangeService.js)
 *
 * Permission follows the parent: a Custom BOM is order design (orders manage),
 * a Standard or Template BOM is catalog design (catalog manage). A batch asks
 * for the grant of every kind of parent it touches.
 *
 * A change to an order's own structure is followed by the line's cut pieces,
 * on the same transaction (cutPlateService.refreshCutPieces — it never fails
 * the save); the answer carries what happened as `cutPieces`.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam, assertPerm } from '../lib/http.js';
import { requireMaster } from '../services/records.js';
import { bomTypeOf } from '../services/bomGraph.js';
import {
  getBom, explode, whereUsed, addLine, updateLine, removeLine, lineCandidates, resolveLine,
  setBomStatus, reviseBom, parentOfLine,
} from '../services/bomService.js';
import { applyBomChanges } from '../services/bomChangeService.js';
import { recordBomCodes } from '../services/placeholderService.js';
import { withCutPieces, ownerLineOf } from '../services/cutPlateService.js';

const router = Router();
const id = (req) => intParam(req.params.id);
const permForType = (bomType) => (bomType === 'custom' ? PERM.orders : PERM.catalog);
const permFor = (parent) => permForType(bomTypeOf(parent));

/** Runs a write in a transaction after checking the permission its parent needs. */
const write = (req, parentOf, fn) => withTransaction(async (db) => {
  const c = ctx(req);
  const parent = await parentOf(db, c);
  assertPerm(req, permFor(parent));
  const out = await fn(db, c, parent);
  // Only an order's own rows belong to a line whose cut pieces follow them.
  return parent.item_type === 'temporary' ? withCutPieces(db, c, parent.owner_order_line_id, out) : out;
});
const byRecord = (req) => (db, c) => requireMaster(db, c.companyId, id(req));
const byLine = (req) => (db, c) => parentOfLine(db, c.companyId, id(req));

router.get('/records/:id/bom', guard(PERM.view), handle((req) => getBom(pool, ctx(req).companyId, id(req))));
router.get('/records/:id/bom/tree', guard(PERM.view), handle((req) => {
  const q = Number(req.query.quantity);
  return explode(pool, ctx(req).companyId, id(req), { rootQuantity: Number.isFinite(q) && q > 0 ? q : 1 });
}));
// A catalog item's or definition's BOM, coded the way an order codes its rows — read only.
router.get('/records/:id/bom/codes', guard(PERM.view), handle((req) => recordBomCodes(pool, ctx(req).companyId, id(req))));
router.get('/records/:id/where-used', guard(PERM.view), handle((req) => whereUsed(pool, ctx(req).companyId, id(req), { withTotal: req.query.withTotal === '1' })));

router.post('/records/:id/bom/lines', guard(PERM.view), handle((req) => write(req, byRecord(req), (db, c) => addLine(db, c, id(req), req.body ?? {}))));
router.post('/records/:id/bom/status', guard(PERM.view), handle((req) => write(req, byRecord(req), (db, c) => setBomStatus(db, c, id(req), req.body?.status))));
router.post('/records/:id/bom/revision', guard(PERM.view), handle((req) => write(req, byRecord(req), (db, c) => reviseBom(db, c, id(req), req.body ?? {}))));

router.put('/bom-lines/:id', guard(PERM.view), handle((req) => write(req, byLine(req), (db, c) => updateLine(db, c, id(req), req.body ?? {}))));
router.delete('/bom-lines/:id', guard(PERM.view), handle((req) => write(req, byLine(req), (db, c) => removeLine(db, c, id(req)))));
router.get('/bom-lines/:id/candidates', guard(PERM.view), handle((req) => lineCandidates(pool, ctx(req).companyId, id(req), { limit: req.query.limit, search: req.query.search })));
router.post('/bom-lines/:id/resolve', guard(PERM.view), handle((req) => write(req, byLine(req), (db, c) => resolveLine(db, c, id(req), { itemId: req.body?.itemId ?? null }))));

// The service names the BOM type of every parent the batch touches; the grant
// asked for is the one each single-line route above would ask for.
router.post('/bom-changes', guard(PERM.view), handle((req) => withTransaction(async (db) => {
  const c = ctx(req);
  const body = req.body ?? {};
  const out = await applyBomChanges(db, c, body, { allow: (bomType) => assertPerm(req, permForType(bomType)) });
  if (!out.applied) return out;   // a dry run changed nothing
  const lineId = body.scope?.orderLineId != null ? Number(body.scope.orderLineId) : await ownerLineOf(db, c.companyId, Number(body.scope?.recordId));
  return withCutPieces(db, c, lineId, out);
})));

export default router;
