/**
 * process.js — configurable order processes (models/init.sql §18).
 *
 *   GET    /stage-catalogue            the seven stage KINDS, which are code
 *
 *   GET    /processes                  each with its stage count and the rules pointing at it
 *   POST   /processes                  { code, name, description?, status? }
 *   GET    /processes/:id              header + ordered stages + rules
 *   PUT    /processes/:id              { code?, name?, description? }
 *   POST   /processes/:id/status       { status } — draft | active | obsolete
 *   DELETE /processes/:id              only while no order follows it
 *   PUT    /processes/:id/stages       { stages: [...] } — the WHOLE ordered list, replaced
 *   POST   /processes/:id/rules        { customerId?, orderType? } — NULL means any
 *   DELETE /process-rules/:id
 *
 *   GET    /orders/:id/process         where this order's lines have got to
 *
 * Replacing the stage list rather than patching it is deliberate: reordering is
 * the normal edit, and a per-stage update has to pass through states where two
 * stages share a sequence, which the unique key forbids. See replaceStages.
 *
 * Defining a process is SETUP; reading one, and reading where an order has got
 * to, is part of seeing the order.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import {
  stageCatalogue, listProcesses, getProcess, createProcess, updateProcess, setProcessStatus,
  deleteProcess, replaceStages, addRule, deleteRule, orderProcess,
} from '../services/processService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const company = (req) => ctx(req).companyId;
const view = guard(PERM.ordersView);
const manage = guard(PERM.setup);

// The catalogue is code, so it needs no company — but it is still behind the
// same permission as everything else the screen shows.
router.get('/stage-catalogue', view, handle(() => stageCatalogue()));

router.get('/processes', view, handle((req) => listProcesses(pool, company(req))));
router.post('/processes', manage, handle((req) => tx(req, (db, c) => createProcess(db, c, req.body ?? {}))));
router.get('/processes/:id', view, handle((req) => getProcess(pool, company(req), id(req))));
router.put('/processes/:id', manage, handle((req) => tx(req, (db, c) => updateProcess(db, c, id(req), req.body ?? {}))));
router.post('/processes/:id/status', manage, handle((req) => tx(req, (db, c) => setProcessStatus(db, c, id(req), req.body?.status))));
router.delete('/processes/:id', manage, handle((req) => tx(req, (db, c) => deleteProcess(db, c, id(req)))));
router.put('/processes/:id/stages', manage, handle((req) => tx(req, (db, c) => replaceStages(db, c, id(req), req.body ?? {}))));
router.post('/processes/:id/rules', manage, handle((req) => tx(req, (db, c) => addRule(db, c, id(req), req.body ?? {}))));
router.delete('/process-rules/:id', manage, handle((req) => tx(req, (db, c) => deleteRule(db, c, id(req)))));

router.get('/orders/:id/process', view, handle((req) => orderProcess(pool, company(req), id(req))));

export default router;
