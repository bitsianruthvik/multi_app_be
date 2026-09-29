/**
 * floor.js — the machine log (services/floorService.js; contract in
 * TM/CF_ERP_FLOOR_LOG_PLAN.md §2, schema init.sql §32).
 *
 *   GET  /floor/machines                      every active machine: running jobs, stopped?, last activity
 *   GET  /floor/operators?machineId=          usual operators of that machine first, then all active
 *   GET  /floor/reasons                       the stop reasons
 *   GET  /floor/machines/:id/queue?search=&limit=   { stop, running, next, total } — the jobs for this machine, in order
 *   GET  /floor/machines/:id/now              { running, stop } — what the machine is doing now
 *   GET  /floor/machines/:id/day?date=        { shifts, sessions, stops, notRecorded, totals }
 *   PUT  /floor/machines/:id/day              { date, operatorId, rows, deletedRows } — the day from paper
 *   POST /floor/start                         { machineId, operatorId, stepIds[] }
 *   POST /floor/pause                         { sessionIds[] }
 *   POST /floor/resume                        { sessionIds[] }
 *   POST /floor/finish                        { sessionId, good, scrap, done }
 *   POST /floor/stop                          { machineId, operatorId, reasonId, note?, since? }
 *   POST /floor/stop/:id/end
 *   GET  /floor/settings  ·  PUT /floor/settings { timezone }   the plant clock
 *
 * Setup (production manage to change):
 *   GET /operators?status=all · POST /operators · PUT /operators/:id · DELETE /operators/:id
 *     body { name, code?, status?, notes?, machineIds? }
 *   GET /stop-reasons?status=all · POST /stop-reasons · PUT /stop-reasons/:id · DELETE /stop-reasons/:id
 *     body { label, code?, sortOrder?, needsNote?, status? }
 *
 * Permission: cf_erp_floor (read and record on the floor — a shared tablet has
 * only this) or cf_erp_production_manage. Every write is one transaction.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, guardAny, handle, ctx, intParam } from '../lib/http.js';
import {
  listMachines, listFloorOperators, listReasons, machineQueue, getMachineNow, getDay, putDay,
  startWork, pauseWork, resumeWork, finishWork, startStop, endStop, getFloorSettings, putFloorSettings,
  listOperators, createOperator, updateOperator, deleteOperator,
  listStopReasons, createStopReason, updateStopReason, deleteStopReason,
} from '../services/floorService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const company = (req) => ctx(req).companyId;
const floor = guardAny(PERM.floor, PERM.production);
const manage = guard(PERM.production);
const setupView = guardAny(PERM.production, PERM.productionView, PERM.floor);

router.get('/floor/machines', floor, handle((req) => listMachines(pool, company(req))));
router.get('/floor/operators', floor, handle((req) => listFloorOperators(pool, company(req), req.query)));
router.get('/floor/reasons', floor, handle((req) => listReasons(pool, company(req))));
router.get('/floor/machines/:id/queue', floor, handle((req) => machineQueue(pool, company(req), id(req), req.query)));
router.get('/floor/machines/:id/now', floor, handle((req) => getMachineNow(pool, company(req), id(req))));
router.get('/floor/machines/:id/day', floor, handle((req) => getDay(pool, company(req), id(req), req.query.date)));
router.put('/floor/machines/:id/day', floor, handle((req) => tx(req, (db, c) => putDay(db, c, id(req), req.body ?? {}))));
router.post('/floor/start', floor, handle((req) => tx(req, (db, c) => startWork(db, c, req.body ?? {}))));
router.post('/floor/pause', floor, handle((req) => tx(req, (db, c) => pauseWork(db, c, req.body ?? {}))));
router.post('/floor/resume', floor, handle((req) => tx(req, (db, c) => resumeWork(db, c, req.body ?? {}))));
router.post('/floor/finish', floor, handle((req) => tx(req, (db, c) => finishWork(db, c, req.body ?? {}))));
router.post('/floor/stop', floor, handle((req) => tx(req, (db, c) => startStop(db, c, req.body ?? {}))));
router.post('/floor/stop/:id/end', floor, handle((req) => tx(req, (db, c) => endStop(db, c, id(req)))));
router.get('/floor/settings', floor, handle((req) => getFloorSettings(pool, company(req))));
router.put('/floor/settings', manage, handle((req) => tx(req, (db, c) => putFloorSettings(db, c, req.body ?? {}))));

router.get('/operators', setupView, handle((req) => listOperators(pool, company(req), req.query)));
router.post('/operators', manage, handle((req) => tx(req, (db, c) => createOperator(db, c, req.body ?? {}))));
router.put('/operators/:id', manage, handle((req) => tx(req, (db, c) => updateOperator(db, c, id(req), req.body ?? {}))));
router.delete('/operators/:id', manage, handle((req) => tx(req, (db, c) => deleteOperator(db, c, id(req)))));

router.get('/stop-reasons', setupView, handle((req) => listStopReasons(pool, company(req), req.query)));
router.post('/stop-reasons', manage, handle((req) => tx(req, (db, c) => createStopReason(db, c, req.body ?? {}))));
router.put('/stop-reasons/:id', manage, handle((req) => tx(req, (db, c) => updateStopReason(db, c, id(req), req.body ?? {}))));
router.delete('/stop-reasons/:id', manage, handle((req) => tx(req, (db, c) => deleteStopReason(db, c, id(req)))));

export default router;
