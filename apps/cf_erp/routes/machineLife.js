/**
 * machineLife.js — THE MACHINE LIFECYCLE (init.sql §104; services/machineLifeService.js).
 *
 *   GET  /machines-to-register?billId=          GRN lines of machines / durable tools still to register (Stores)
 *   POST /machines-to-register                  { billLineId, needsSetup?, lifeYears?, salvageValue?, units: [{ name, code?, classificationId?, serialNumber?, notes? }] }
 *   GET  /machines/:id/life                     stage, place, custody, setup ticket, condemning, cost, depreciation, use by order
 *   GET  /machines/:id/log?limit=               events + maintenance + work, newest first
 *   POST /machines/:id/move                     { areaId, note? }                          Stores or Maintenance
 *   POST /machines/:id/setup-ticket             a setup machine without an open ticket gets one (Maintenance)
 *   POST /machines/:id/go-live                  { note? } — setup done without a ticket (Maintenance)
 *   POST /machines/:id/check-out                { toKind, toId, takenBy?, dueOn?, note? }  Stores
 *   POST /machines/:id/check-in                 { areaId?, note? }                         Stores
 *   POST /machines/:id/condemn                  { reason }                                 Maintenance → the MD
 *   POST /machines/:id/disposal                 { disposal, on, amount?, note? }           Maintenance or Accounts
 *   PUT  /machines/:id/cost                     { cost?, salvageValue?, lifeYears?, liveOn? } Maintenance or Accounts
 *   PUT  /machines/:id/setup-items/:itemId      { treatment: capital | expense }          Maintenance or Accounts
 *   GET  /machine-checkouts?open=&search=&machineId=   what is out (Stores)
 *   GET  /machine-custodians?kind=&search=      whom it can go to
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guardAny, handle, ctx, intParam } from '../lib/http.js';
import * as L from '../services/machineLifeService.js';

const router = Router();
const id = (req) => intParam(req.params.id);
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const company = (req) => ctx(req).companyId;
const body = (req) => req.body ?? {};

const view = guardAny(PERM.productionView, PERM.maintenance, PERM.stores, PERM.inventoryView, PERM.accountsView);
const stores = guardAny(PERM.stores, PERM.inventory);
const maintenance = guardAny(PERM.maintenance);
const place = guardAny(PERM.stores, PERM.inventory, PERM.maintenance);
const money = guardAny(PERM.maintenance, PERM.accounts);

router.get('/machines-to-register', guardAny(PERM.stores, PERM.inventory, PERM.inventoryView), handle((req) => L.toRegister(pool, company(req), req.query)));
router.post('/machines-to-register', stores, handle((req) => tx(req, (db, c) => L.registerReceived(db, c, body(req)))));
router.get('/machine-checkouts', view, handle((req) => L.listCheckouts(pool, company(req), req.query)));
router.get('/machine-custodians', stores, handle((req) => L.listCustodians(pool, company(req), req.query)));

router.get('/machines/:id/life', view, handle((req) => L.getMachineLife(pool, company(req), id(req))));
router.get('/machines/:id/log', view, handle((req) => L.machineLog(pool, company(req), id(req), req.query)));
router.post('/machines/:id/move', place, handle((req) => tx(req, (db, c) => L.moveMachine(db, c, id(req), body(req)))));
router.post('/machines/:id/setup-ticket', maintenance, handle((req) => tx(req, (db, c) => L.raiseSetupTicketAgain(db, c, id(req)))));
router.post('/machines/:id/go-live', maintenance, handle((req) => tx(req, async (db, c) => { await L.goLive(db, c, id(req), { note: body(req).note ?? 'Set up — no ticket needed.', direct: true }); return L.getMachineLife(db, c.companyId, id(req)); })));
router.post('/machines/:id/check-out', stores, handle((req) => tx(req, (db, c) => L.checkOut(db, c, id(req), body(req)))));
router.post('/machines/:id/check-in', stores, handle((req) => tx(req, (db, c) => L.checkIn(db, c, id(req), body(req)))));
router.post('/machines/:id/condemn', maintenance, handle((req) => tx(req, (db, c) => L.askCondemn(db, c, id(req), body(req)))));
router.post('/machines/:id/disposal', money, handle((req) => tx(req, (db, c) => L.recordDisposal(db, c, id(req), body(req)))));
router.put('/machines/:id/cost', money, handle((req) => tx(req, (db, c) => L.setCost(db, c, id(req), body(req)))));
router.put('/machines/:id/setup-items/:itemId', money, handle((req) => tx(req, (db, c) => L.setSetupTreatment(db, c, id(req), intParam(req.params.itemId), body(req)))));

export default router;
