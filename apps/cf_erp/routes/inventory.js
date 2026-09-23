/**
 * inventory.js — stocking areas, their inventories, batches and movements.
 *
 *   GET    /stocking-areas?status=&purpose=
 *   POST   /stocking-areas                  { code, name, purpose?, machineId?, notes? }
 *   GET    /stocking-areas/:id              the area and its inventory
 *   PUT    /stocking-areas/:id
 *   DELETE /stocking-areas/:id              only if it never held stock
 *   GET    /stock?areaId=&itemId=&batchId=&purpose=&search=&includeZero=1
 *   GET    /stock/check                     balances against the ledger
 *   GET    /items/:id/stock                 one item: totals, areas, batches, latest movements
 *   GET    /items/:id/batch-template        what a new batch of it must record
 *   GET    /batches?itemId=&status=&search=&inStock=1
 *   GET    /batches/:id
 *   PUT    /batches/:id                     { supplierRef?, notes? }
 *   POST   /batches/:id/status              { status: available | on_hold | rejected, note? }
 *   PUT    /batches/:id/values              { values: [{ specificationId | specCode, value }] }
 *   GET    /batches/:id/history
 *   GET    /movements?type=&areaId=&itemId=&batchId=&orderId=&from=&to=&search=
 *   POST   /movements                       see stockService.postMovement
 *   GET    /movements/:id
 *   POST   /movements/:id/reverse           { reason }
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { listAreas, createArea, updateArea, deleteArea } from '../services/stockingAreaService.js';
import {
  listBatches, getBatch, updateBatch, setBatchStatus, setBatchValues, getBatchHistory, batchTemplate,
} from '../services/batchService.js';
import {
  postMovement, reverseMovement, listMovements, getMovement, listStock, itemStock, areaInventory, checkLedger,
} from '../services/stockService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const view = guard(PERM.inventoryView);
const manage = guard(PERM.inventory);
const company = (req) => ctx(req).companyId;

router.get('/stocking-areas', view, handle((req) => listAreas(pool, company(req), req.query)));
router.post('/stocking-areas', manage, handle((req) => tx(req, (db, c) => createArea(db, c, req.body ?? {}))));
router.get('/stocking-areas/:id', view, handle((req) => areaInventory(pool, company(req), id(req))));
router.put('/stocking-areas/:id', manage, handle((req) => tx(req, (db, c) => updateArea(db, c, id(req), req.body ?? {}))));
router.delete('/stocking-areas/:id', manage, handle((req) => tx(req, (db, c) => deleteArea(db, c, id(req)))));

router.get('/stock', view, handle((req) => listStock(pool, company(req), req.query)));
router.get('/stock/check', view, handle((req) => checkLedger(pool, company(req))));
router.get('/items/:id/stock', view, handle((req) => itemStock(pool, company(req), id(req))));
router.get('/items/:id/batch-template', view, handle((req) => batchTemplate(pool, company(req), id(req))));

router.get('/batches', view, handle((req) => listBatches(pool, company(req), req.query)));
router.get('/batches/:id', view, handle((req) => getBatch(pool, company(req), id(req))));
router.put('/batches/:id', manage, handle((req) => tx(req, (db, c) => updateBatch(db, c, id(req), req.body ?? {}))));
router.post('/batches/:id/status', manage, handle((req) => tx(req, (db, c) => setBatchStatus(db, c, id(req), req.body ?? {}))));
router.put('/batches/:id/values', manage, handle((req) => tx(req, (db, c) => setBatchValues(db, c, id(req), req.body?.values ?? []))));
router.get('/batches/:id/history', view, handle((req) => getBatchHistory(pool, company(req), id(req), Number(req.query.limit) || 200)));

router.get('/movements', view, handle((req) => listMovements(pool, company(req), req.query)));
router.post('/movements', manage, handle((req) => tx(req, (db, c) => postMovement(db, c, req.body ?? {}))));
router.get('/movements/:id', view, handle((req) => getMovement(pool, company(req), id(req))));
router.post('/movements/:id/reverse', manage, handle((req) => tx(req, (db, c) => reverseMovement(db, c, id(req), req.body ?? {}))));

export default router;
