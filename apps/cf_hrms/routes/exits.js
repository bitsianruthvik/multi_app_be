/**
 * exits.js — leaving: notice, and closing an employee.
 * (TM/CF_HRMS_HIRING_SPEC.md §4.4 — paths and shapes are that contract.)
 *
 *   GET    /people/exit-reasons                     { types: [{ type, label, reasons: [{ code, label, noteRequired }] }] }
 *   POST   /people/employees/:id/exit               { exitType, reasonCode, note?, noticeDate, lastWorkingDay }
 *          -> { employee, exit }      409 EXIT_OPEN · 409 ALREADY_LEFT · 422 INVALID with problems[]
 *   PUT    /people/employees/:id/exit               any of the same fields, while the record is open   -> { employee, exit }
 *   POST   /people/employees/:id/exit/withdraw      { note? }                                           -> { employee, exit }
 *   POST   /people/employees/:id/exit/close         { lastWorkingDay?, note? }
 *          -> { employee, exit, endedAssignments, vacatedPositions: [{ positionId, positionCode, roleTitle }], loginDisabled }
 *          422 NOT_READY when the recorded last working day has not come and the body does not bring it forward
 *   GET    /people/employees/:id/exits              { exits: Exit[] } — the history, newest first
 *
 * Reads: `cf_hrms_people_view`. Writes: `cf_hrms_people_manage`. Nothing here
 * is reachable with `cf_hrms_self_view`: an employee sees their own notice on
 * `/user/me/place` and can change nothing about it.
 *
 * AN EMPLOYEE IS NEVER DELETED HERE. Leaving is ACTIVE -> NOTICE -> EXITED, and
 * closing is one transaction (services/exitService.js): the employee, their
 * assignments, the event in their file and their login change together or not
 * at all.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { listExitReasons } from '../services/exitRead.js';
import { startExit, updateExit, withdrawExit, closeExit, listExits } from '../services/exitService.js';

const router = Router();

const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const reqId = (req) => req.id ?? req.headers['x-request-id'] ?? null;

const read = guard(PERM.peopleView);
const write = guard(PERM.peopleManage);

router.get('/people/exit-reasons', read, handle(async () => listExitReasons()));

router.get('/people/employees/:id/exits', read, handle((req) => listExits(pool, ctx(req).companyId, id(req))));

router.post('/people/employees/:id/exit', write, handle((req) => tx(req, (db, c) => startExit(db, c, id(req), req.body ?? {}, reqId(req)))));
router.put('/people/employees/:id/exit', write, handle((req) => tx(req, (db, c) => updateExit(db, c, id(req), req.body ?? {}, reqId(req)))));
router.post('/people/employees/:id/exit/withdraw', write, handle((req) => tx(req, (db, c) => withdrawExit(db, c, id(req), req.body ?? {}, reqId(req)))));
router.post('/people/employees/:id/exit/close', write, handle((req) => tx(req, (db, c) => closeExit(db, c, id(req), req.body ?? {}, reqId(req)))));

export default router;
