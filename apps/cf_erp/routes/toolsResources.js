/**
 * toolsResources.js — tools / spares / consumables as stock items and each machine's resource list (init.sql §81).
 *
 *   GET    /machines/:id/resources            the machine's list [{ id, itemId, code, name, kind, qty, uom, notes, itemKind, lifeUnit, lifeLimit }]
 *                                             (what maintenance orders prefill their material requests from — machineResources())
 *   PUT    /machines/:id/resources            { rows: [{ itemId, kind?, qty?, notes? }] } the whole list in one save
 *   POST   /machines/:id/resources            { itemId, kind?, qty?, notes? } one row
 *   PUT    /machine-resources/:id             { kind?, qty?, notes? }
 *   DELETE /machine-resources/:id
 *   GET    /resource-items?kind=&search=&all=1&limit=   catalog items to pick: the Tools / Spares / Consumables families (all=1: whole catalog)
 *
 *   GET    /tools/items?search=               the Tools family: life setting, pieces in use / worn out
 *   GET    /tools/life?itemId=&status=&machineId=&orderId=&search=&limit=   tool pieces issued from stock
 *   GET    /tools/life/:id                    + usage history
 *   POST   /tools/life/:id/use                { amount, usedOn?, machineId?, orderId?, note? } add use; at its limit it is worn out
 *   POST   /tools/life/:id/retire             { note? }
 *   GET    /items/:id/tool-life               { lifeUnit, lifeLimit, inUse, wornOut, retired }
 *   PUT    /items/:id/tool-life               { lifeUnit | null, lifeLimit | null } (catalog manage)
 *
 * Issuing a tool needs "Used for" like every issue (stockService, §74); each whole piece of an item that carries a
 * life gets a tool-life row when it is issued, and its row is voided if the issue is reversed.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import {
  listMachineResources, setMachineResources, addMachineResource, updateMachineResource, removeMachineResource, searchResourceItems,
} from '../services/machineResourceService.js';
import {
  listToolLife, getToolLife, recordToolUse, retireTool, getItemLife, setItemLife, listToolItems,
} from '../services/toolLifeService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const company = (req) => ctx(req).companyId;

router.get('/machines/:id/resources', guard(PERM.productionView), handle((req) => listMachineResources(pool, company(req), id(req))));
router.put('/machines/:id/resources', guard(PERM.production), handle((req) => tx(req, (db, c) => setMachineResources(db, c, id(req), req.body ?? {}))));
router.post('/machines/:id/resources', guard(PERM.production), handle((req) => tx(req, (db, c) => addMachineResource(db, c, id(req), req.body ?? {}))));
router.put('/machine-resources/:id', guard(PERM.production), handle((req) => tx(req, (db, c) => updateMachineResource(db, c, id(req), req.body ?? {}))));
router.delete('/machine-resources/:id', guard(PERM.production), handle((req) => tx(req, (db, c) => removeMachineResource(db, c, id(req)))));
router.get('/resource-items', guard(PERM.productionView), handle((req) => searchResourceItems(pool, company(req), req.query)));

router.get('/tools/items', guard(PERM.inventoryView), handle((req) => listToolItems(pool, company(req), req.query)));
router.get('/tools/life', guard(PERM.inventoryView), handle((req) => listToolLife(pool, company(req), req.query)));
router.get('/tools/life/:id', guard(PERM.inventoryView), handle((req) => getToolLife(pool, company(req), id(req))));
router.post('/tools/life/:id/use', guard(PERM.inventory), handle((req) => tx(req, (db, c) => recordToolUse(db, c, id(req), req.body ?? {}))));
router.post('/tools/life/:id/retire', guard(PERM.inventory), handle((req) => tx(req, (db, c) => retireTool(db, c, id(req), req.body ?? {}))));
router.get('/items/:id/tool-life', guard(PERM.inventoryView), handle((req) => getItemLife(pool, company(req), id(req))));
router.put('/items/:id/tool-life', guard(PERM.catalog), handle((req) => tx(req, (db, c) => setItemLife(db, c, id(req), req.body ?? {}))));

export default router;
