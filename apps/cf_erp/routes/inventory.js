/**
 * inventory.js — stocking areas, their inventories, batches and movements.
 *
 *   GET    /stocking-areas?status=&purpose=
 *   POST   /stocking-areas                  { code, name, purpose?, machineId?, notes? }
 *   GET    /stocking-areas/:id              the area and its inventory
 *   PUT    /stocking-areas/:id
 *   DELETE /stocking-areas/:id              only if it never held stock
 *   GET    /stock?areaId=&itemId=&batchId=&purpose=&search=&includeZero=1
 *   GET    /stock/check                     balances against the ledger (and pieces against their lots, §67)
 *   GET    /stock/view                      the Stock screen: groups by tracking mode, chips, totals by owner (§67)
 *   GET    /stock/view/lots                 the lots of one Stock row
 *   GET    /stock/units                     pieces of individual items (paged=1)
 *   GET    /stock/units/:id                 one piece and its history
 *   GET    /stock/losses?orderId=&owner=    kerf, scrap write-downs, pieces made again
 *   GET    /stock/scrap-rate                { ratePerKg | null, note }
 *   PUT    /stock/scrap-rate                { ratePerKg } (blank = not set)
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
import { PERM, guard, guardAny, handle, ctx, intParam } from '../lib/http.js';
import { listAreas, createArea, updateArea, deleteArea } from '../services/stockingAreaService.js';
// The production ledger (§45): work in progress by level, and offcut pieces with their outlines.
import { wipStock, listOffcuts } from '../services/wipStockService.js';
// Inventory v2 (§67): the Stock screen, pieces, losses and the scrap rate.
import { stockView, stockViewLots } from '../services/stockViewService.js';
import { listUnits, unitHistory } from '../services/unitService.js';
import { scrapRate, setScrapRate, listLosses } from '../services/scrapService.js';
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
router.get('/stock/wip', view, handle((req) => wipStock(pool, company(req), req.query)));
router.get('/stock/view', view, handle((req) => stockView(pool, company(req), req.query)));
router.get('/stock/view/lots', view, handle((req) => stockViewLots(pool, company(req), req.query)));
router.get('/stock/units', view, handle((req) => listUnits(pool, company(req), req.query)));
router.get('/stock/units/:id', view, handle((req) => unitHistory(pool, company(req), id(req))));
router.get('/stock/losses', view, handle((req) => listLosses(pool, company(req), req.query)));
// The scrap rate sits on Setup › Cutting with the catalog's cutting rules (2026-10-24): catalog OR inventory.
router.get('/stock/scrap-rate', guardAny(PERM.inventoryView, PERM.view), handle((req) => scrapRate(pool, company(req))));
router.put('/stock/scrap-rate', guardAny(PERM.inventory, PERM.catalog), handle((req) => tx(req, (db, c) => setScrapRate(db, c, req.body ?? {}))));
router.get('/offcuts', view, handle((req) => listOffcuts(pool, company(req), req.query)));
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
