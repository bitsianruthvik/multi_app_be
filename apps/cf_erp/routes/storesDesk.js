/**
 * storesDesk.js — the Stores desk (init.sql §111, services/storesDeskService.js).
 *
 *   GET  /stores-desk/settings                 { storesV2, countAutoLimit }
 *   GET  /stores-desk/departments              POST { name }
 *   GET  /stores-desk/people?search=           POST { name, departmentId? }
 *   GET  /stores-desk/ledger?from=&to=&areaId=&familyId=&subfamilyId=&search=&show=&paged=1
 *   GET  /stores-desk/ledger/:itemId?from=&to=
 *   POST /stores-desk/give-out                 see storesDeskService.giveOut
 *   GET  /stores-desk/out-with?holder=&overdue=1&search=&status=
 *   POST /stores-desk/out-with/:id/back        { kind: returned | worn | lost, quantity?, note? }
 *   GET  /stores-desk/count-list?areaId=&kind=&subfamilyId=
 *   GET  /stores-desk/counts                   POST { areaId, kind?, note?, lines }
 *   GET  /stores-desk/counts/:id
 *   §112:
 *   PUT  /stores-desk/settings                 { closedThrough?, backdateDays?, openTime?, closeTime?, toolsOutDays?, countAutoLimit? }  Management
 *   GET  /stores-desk/today                    the Today page in one answer
 *   POST /stores-desk/night-check              { note? }  the morning check of after-hours entries
 *   GET  /stores-desk/level-suggestions        minimum / maximum worked out from usage (gated on history)
 *   POST /stores-desk/level-suggestions/:id/apply   { min, max }  Purchase, the catalog's keeper or Management
 *
 * Reading the ledger is for everyone who plans against stock (planning, production, purchase, maintenance, sales) —
 * quantities only, no prices. Changing anything is the store's.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, guardAny, handle, ctx, intParam } from '../lib/http.js';
import { setDeskSettings, today, nightCheck, levelSuggestions, applyLevel } from '../services/storesTodayService.js';
import {
  deskSettings, listDepartments, addDepartment, listPeople, addPerson, ledger, itemLedger, giveOut, outWith, custodyBack,
  countList, postCount, listCounts, getCount,
} from '../services/storesDeskService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const company = (req) => ctx(req).companyId;
const view = guardAny(PERM.inventoryView, PERM.inventory, PERM.stores, PERM.purchase, PERM.productionView, PERM.production, PERM.maintenance, PERM.ordersView, PERM.floor);
const manage = guardAny(PERM.inventory, PERM.stores);

router.get('/stores-desk/settings', view, handle((req) => deskSettings(pool, company(req))));
router.get('/stores-desk/departments', view, handle((req) => listDepartments(pool, company(req))));
router.post('/stores-desk/departments', manage, handle((req) => tx(req, (db, c) => addDepartment(db, c, req.body ?? {}))));
router.get('/stores-desk/people', view, handle((req) => listPeople(pool, company(req), req.query)));
router.post('/stores-desk/people', manage, handle((req) => tx(req, (db, c) => addPerson(db, c, req.body ?? {}))));
router.get('/stores-desk/ledger', view, handle((req) => ledger(pool, company(req), req.query)));
router.get('/stores-desk/ledger/:id', view, handle((req) => itemLedger(pool, company(req), id(req), req.query)));
router.post('/stores-desk/give-out', manage, handle((req) => tx(req, (db, c) => giveOut(db, c, req.body ?? {}))));
router.get('/stores-desk/out-with', view, handle((req) => outWith(pool, company(req), req.query)));
router.post('/stores-desk/out-with/:id/back', manage, handle((req) => tx(req, (db, c) => custodyBack(db, c, id(req), req.body ?? {}))));
router.get('/stores-desk/count-list', manage, handle((req) => countList(pool, company(req), req.query)));
router.get('/stores-desk/counts', view, handle((req) => listCounts(pool, company(req))));
router.post('/stores-desk/counts', manage, handle((req) => tx(req, (db, c) => postCount(db, c, req.body ?? {}))));
router.get('/stores-desk/counts/:id', view, handle((req) => getCount(pool, company(req), id(req))));
// §112
const MANAGEMENT = 'cf_erp_approve_stock_count';
router.put('/stores-desk/settings', guard(MANAGEMENT), handle((req) => tx(req, (db, c) => setDeskSettings(db, c, req.body ?? {}))));
router.get('/stores-desk/today', view, handle((req) => today(pool, company(req))));
router.post('/stores-desk/night-check', guardAny(PERM.inventory, PERM.stores, PERM.production, MANAGEMENT), handle((req) => tx(req, (db, c) => nightCheck(db, c, req.body ?? {}))));
router.get('/stores-desk/level-suggestions', view, handle((req) => levelSuggestions(pool, company(req), req.query)));
router.post('/stores-desk/level-suggestions/:id/apply', guardAny(PERM.catalog, PERM.purchase, MANAGEMENT), handle((req) => tx(req, (db, c) => applyLevel(db, c, id(req), req.body ?? {}))));
export default router;
