/**
 * records.js — items and definitions, their values and their selection lists.
 *
 *   GET    /records?recordKind=&kind=&status=&classificationId=&search=&limit=&offset=
 *   POST   /records/preview            draft -> which specs apply, the code and name it would get
 *   POST   /catalog/classification     { parentId, code, name, description?, scope?, sortOrder? }
 *                                      a Family / Subfamily / Variant made mid-flow from the catalog
 *                                      screens; the item side of the tree only.
 *   POST   /items                      { itemType, classificationId | sourceDefinitionId+ownerOrderLineId, name?, code?, uom?, trackedBy?, status?, revision?, values? }
 *   POST   /definitions                { definitionType, classificationId, name?, code?, selectionMode?, candidateClassificationId?, status?, values? }
 *   GET    /records/:id
 *   GET    /records/:id/specs          every rule that reaches it, with values and where they came from
 *   GET    /records/:id/history        value history
 *   PUT    /records/:id                name, description, code (draft only), classification, uom, tracking, selection fields
 *   PUT    /records/:id/values         { values: [{ specCode | specificationId, value }] }
 *   POST   /records/:id/status         { status: active | obsolete }
 *   POST   /records/:id/revision       { revision? }  (empty = next label)
 *   DELETE /records/:id
 *
 *   GET    /definitions/:id/selection   allowed list + criteria
 *   GET    /definitions/:id/candidates  the catalog items it resolves to now
 *   POST   /definitions/:id/allowed-items   { itemId, isDefault? }
 *   POST   /allowed-items/:id/default
 *   DELETE /allowed-items/:id
 *   POST   /definitions/:id/criteria        { specificationId, operator, value, valueTo? }
 *   PUT    /criteria/:id
 *   DELETE /criteria/:id
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import {
  listRecords, getRecord, getRecordSpecs, createItem, createDefinition, updateRecord,
  setStatus, reviseRecord, deleteRecord, previewDraft,
} from '../services/masterRecordService.js';
import { setValues, getHistory } from '../services/valueService.js';
import {
  getSelection, findCandidates, addAllowedItem, setDefaultAllowed, removeAllowedItem,
  addCriterion, updateCriterion, removeCriterion,
} from '../services/selectionService.js';
import { createCatalogNode } from '../services/classificationService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);

router.get('/records', guard(PERM.view), handle((req) => listRecords(pool, ctx(req).companyId, req.query)));

// A preview runs in a transaction that is always rolled back: it reads sequence
// counters but must never leave anything behind.
router.post('/records/preview', guard(PERM.view), handle(async (req) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    return await previewDraft(conn, ctx(req).companyId, req.body ?? {});
  } finally {
    try { await conn.rollback(); } catch { /* nothing to undo */ }
    conn.release();
  }
}));

// The catalog's own door into the classification tree: a catalog editor who
// needs a Variant halfway through making an item should not have to go and ask
// for the Setup grant. Setup › Classification keeps its own route and its own
// guard; this one refuses machine scope and machine families outright.
router.post('/catalog/classification', guard(PERM.catalog), handle((req) => tx(req, (db, c) => createCatalogNode(db, c, req.body ?? {}))));

router.post('/items', guard(PERM.catalog), handle((req) => tx(req, (db, c) => createItem(db, c, req.body))));
router.post('/definitions', guard(PERM.catalog), handle((req) => tx(req, (db, c) => createDefinition(db, c, req.body))));

router.get('/records/:id', guard(PERM.view), handle((req) => getRecord(pool, ctx(req).companyId, id(req))));
router.get('/records/:id/specs', guard(PERM.view), handle((req) => getRecordSpecs(pool, ctx(req).companyId, id(req))));
router.get('/records/:id/history', guard(PERM.view), handle((req) => getHistory(pool, ctx(req).companyId, 'master', id(req), req.query.limit)));
router.put('/records/:id', guard(PERM.catalog), handle((req) => tx(req, (db, c) => updateRecord(db, c, id(req), req.body))));
router.put('/records/:id/values', guard(PERM.catalog), handle((req) => tx(req, async (db, c) => {
  const result = await setValues(db, c, 'master', id(req), req.body?.values);
  return { ...result, specs: await getRecordSpecs(db, c.companyId, id(req)) };
})));
router.post('/records/:id/status', guard(PERM.catalog), handle((req) => tx(req, (db, c) => setStatus(db, c, id(req), req.body?.status))));
router.post('/records/:id/revision', guard(PERM.catalog), handle((req) => tx(req, (db, c) => reviseRecord(db, c, id(req), req.body))));
router.delete('/records/:id', guard(PERM.catalog), handle((req) => tx(req, (db, c) => deleteRecord(db, c, id(req)))));

router.get('/definitions/:id/selection', guard(PERM.view), handle((req) => getSelection(pool, ctx(req).companyId, id(req))));
router.get('/definitions/:id/candidates', guard(PERM.view), handle((req) => findCandidates(pool, ctx(req).companyId, id(req), { limit: req.query.limit })));
router.post('/definitions/:id/allowed-items', guard(PERM.catalog), handle((req) => tx(req, (db, c) => addAllowedItem(db, c, id(req), req.body))));
router.post('/allowed-items/:id/default', guard(PERM.catalog), handle((req) => tx(req, (db, c) => setDefaultAllowed(db, c, id(req)))));
router.delete('/allowed-items/:id', guard(PERM.catalog), handle((req) => tx(req, (db, c) => removeAllowedItem(db, c, id(req)))));
router.post('/definitions/:id/criteria', guard(PERM.catalog), handle((req) => tx(req, (db, c) => addCriterion(db, c, id(req), req.body))));
router.put('/criteria/:id', guard(PERM.catalog), handle((req) => tx(req, (db, c) => updateCriterion(db, c, id(req), req.body))));
router.delete('/criteria/:id', guard(PERM.catalog), handle((req) => tx(req, (db, c) => removeCriterion(db, c, id(req)))));

export default router;
