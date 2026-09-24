/**
 * production.js — machines, operations, flows (Phase 2, step 3).
 *
 *   GET    /machines?status=&classificationId=&search=
 *   POST   /machines                     { code?, name, classificationId, catalogItemId?, serialNumber?, status?, notes?, values? }
 *   GET    /machines/:id                 with its machine type path and the operations it can do
 *   PUT    /machines/:id                 { code?, name?, classificationId?, catalogItemId?, serialNumber?, status?, notes? }
 *   DELETE /machines/:id
 *   GET    /machines/:id/specs           resolved specifications
 *   PUT    /machines/:id/values          { values: [{ specificationId | specCode, value }] }
 *   GET    /machines/:id/history
 *
 *   GET    /machine-types                the machine side of the classification tree, with machine counts
 *   POST   /machine-types                { family: {id}|{code,name}, subfamily: {id}|{code,name}, code, name, description? }
 *   PUT    /machine-types/:id            { name?, code?, description?, status? }  — any level: Family, Subfamily or type
 *   DELETE /machine-types/:id            — any level; refused while anything live sits below it
 *
 *   GET    /operations?status=&search=
 *   POST   /operations                   { code, name, description?, status? }
 *   GET    /operations/:id               with its timing rules, flows and the machines that can do it
 *   PUT    /operations/:id
 *   DELETE /operations/:id
 *   POST   /operations/:id/rules         { subjectType, subjectId, eligible?, setupMinutes | setupFormulaId, workMinutes | workFormulaId, effectiveFrom?, effectiveTo?, notes? }
 *   PUT    /operation-rules/:id
 *   DELETE /operation-rules/:id
 *   POST   /operations/:id/timing        { machineId, itemId?, quantity?, date? } — how long, and why
 *
 *   GET    /flows?status=&search=
 *   POST   /flows                        { code, name, description? }
 *   GET    /flows/:id                    steps, wait rules, what uses it
 *   PUT    /flows/:id
 *   POST   /flows/:id/status             { status }  draft → active → obsolete
 *   POST   /flows/:id/revise             { revision? }
 *   DELETE /flows/:id
 *   POST   /flows/:id/steps              { operationId, sequence?, stepName?, notes? }
 *                                        A flow MAY repeat an operation — welded, crane-turned,
 *                                        welded again. The one bar is two steps of the same
 *                                        operation at the SAME sequence number, which would
 *                                        leave the passes unordered.
 *   PUT    /flow-steps/:id               { sequence?, stepName?, notes? }
 *   DELETE /flow-steps/:id
 *   POST   /flow-steps/:id/waits         { relation, targetDefinitionId?, targetOperationId?, requiredStatus?, notes? }
 *                                        targetOperationId names an OPERATION, not a step. Where
 *                                        the target's flow repeats it, requiredStatus picks the
 *                                        pass: done = the last, started = the first.
 *   DELETE /flow-waits/:id
 *
 *   GET    /machines/:id/shifts             its weekly shift patterns
 *   POST   /machines/:id/shifts             { name, weekdays: ['mon',…], startTime, endTime, breakMinutes?, effectiveFrom?, effectiveTo?, notes? }
 *   POST   /machines/:id/shifts/copy        { fromMachineId } — replaces its shifts with another machine's
 *   PUT    /machine-shifts/:id
 *   DELETE /machine-shifts/:id
 *   GET    /machines/:id/exceptions?from=&to=
 *   POST   /machines/:id/exceptions         { date, kind: closed | extra, shiftId?, startTime?, endTime?, reason? }
 *   DELETE /machine-exceptions/:id
 *   GET    /machines/:id/calendar?from=&to= when it works, day by day
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import {
  listMachines, getMachine, createMachine, updateMachine, deleteMachine, getMachineSpecs, setMachineValues, getMachineHistory,
} from '../services/machineService.js';
import {
  listOperations, getOperation, createOperation, updateOperation, deleteOperation,
  createTimingRule, updateTimingRule, deleteTimingRule, timingPreview,
} from '../services/operationService.js';
import {
  listFlows, getFlow, createFlow, updateFlow, setFlowStatus, reviseFlow, deleteFlow,
  addStep, updateStep, removeStep, addWaitRule, removeWaitRule,
} from '../services/flowService.js';
import {
  listShifts, createShift, updateShift, deleteShift, copyShifts, listExceptions, createException, deleteException, machineCalendar,
} from '../services/shiftService.js';
import {
  listMachineTypes, createMachineType, updateMachineNode, deleteMachineNode,
} from '../services/classificationService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const view = guard(PERM.productionView);
const manage = guard(PERM.production);

router.get('/machines', view, handle((req) => listMachines(pool, ctx(req).companyId, req.query)));
router.post('/machines', manage, handle((req) => tx(req, (db, c) => createMachine(db, c, req.body ?? {}))));
router.get('/machines/:id', view, handle((req) => getMachine(pool, ctx(req).companyId, id(req))));
router.put('/machines/:id', manage, handle((req) => tx(req, (db, c) => updateMachine(db, c, id(req), req.body ?? {}))));
router.delete('/machines/:id', manage, handle((req) => tx(req, (db, c) => deleteMachine(db, c, id(req)))));
router.get('/machines/:id/specs', view, handle((req) => getMachineSpecs(pool, ctx(req).companyId, id(req))));
router.put('/machines/:id/values', manage, handle((req) => tx(req, (db, c) => setMachineValues(db, c, id(req), req.body?.values ?? []))));
router.get('/machines/:id/history', view, handle((req) => getMachineHistory(pool, ctx(req).companyId, id(req), Number(req.query.limit) || 200)));

// Machine types are classification nodes, but they belong to the Machines
// screen: somebody who may add a machine can add the type it needs without the
// Setup grant. The service still goes through createNode / updateNode /
// deleteNode, so the tree's own rules apply either way.
//
// POST makes a type (with its Family and Subfamily, if they are new). PUT and
// DELETE take ANY level of a machine family — a screen that can make a Family
// inline and then never rename or retire it is the same dead end one step up.
router.get('/machine-types', view, handle((req) => listMachineTypes(pool, ctx(req).companyId)));
router.post('/machine-types', manage, handle((req) => tx(req, (db, c) => createMachineType(db, c, req.body ?? {}))));
router.put('/machine-types/:id', manage, handle((req) => tx(req, (db, c) => updateMachineNode(db, c, id(req), req.body ?? {}))));
router.delete('/machine-types/:id', manage, handle((req) => tx(req, (db, c) => deleteMachineNode(db, c, id(req)))));

router.get('/operations', view, handle((req) => listOperations(pool, ctx(req).companyId, req.query)));
router.post('/operations', manage, handle((req) => tx(req, (db, c) => createOperation(db, c, req.body ?? {}))));
router.get('/operations/:id', view, handle((req) => getOperation(pool, ctx(req).companyId, id(req))));
router.put('/operations/:id', manage, handle((req) => tx(req, (db, c) => updateOperation(db, c, id(req), req.body ?? {}))));
router.delete('/operations/:id', manage, handle((req) => tx(req, (db, c) => deleteOperation(db, c, id(req)))));
router.post('/operations/:id/rules', manage, handle((req) => tx(req, (db, c) => createTimingRule(db, c, id(req), req.body ?? {}))));
router.put('/operation-rules/:id', manage, handle((req) => tx(req, (db, c) => updateTimingRule(db, c, id(req), req.body ?? {}))));
router.delete('/operation-rules/:id', manage, handle((req) => tx(req, (db, c) => deleteTimingRule(db, c, id(req)))));
router.post('/operations/:id/timing', view, handle((req) => timingPreview(pool, ctx(req).companyId, id(req), req.body ?? {})));

router.get('/flows', view, handle((req) => listFlows(pool, ctx(req).companyId, req.query)));
router.post('/flows', manage, handle((req) => tx(req, (db, c) => createFlow(db, c, req.body ?? {}))));
router.get('/flows/:id', view, handle((req) => getFlow(pool, ctx(req).companyId, id(req))));
router.put('/flows/:id', manage, handle((req) => tx(req, (db, c) => updateFlow(db, c, id(req), req.body ?? {}))));
router.post('/flows/:id/status', manage, handle((req) => tx(req, (db, c) => setFlowStatus(db, c, id(req), req.body?.status))));
router.post('/flows/:id/revise', manage, handle((req) => tx(req, (db, c) => reviseFlow(db, c, id(req), req.body ?? {}))));
router.delete('/flows/:id', manage, handle((req) => tx(req, (db, c) => deleteFlow(db, c, id(req)))));
router.post('/flows/:id/steps', manage, handle((req) => tx(req, (db, c) => addStep(db, c, id(req), req.body ?? {}))));
router.put('/flow-steps/:id', manage, handle((req) => tx(req, (db, c) => updateStep(db, c, id(req), req.body ?? {}))));
router.delete('/flow-steps/:id', manage, handle((req) => tx(req, (db, c) => removeStep(db, c, id(req)))));
router.post('/flow-steps/:id/waits', manage, handle((req) => tx(req, (db, c) => addWaitRule(db, c, id(req), req.body ?? {}))));
router.delete('/flow-waits/:id', manage, handle((req) => tx(req, (db, c) => removeWaitRule(db, c, id(req)))));

router.get('/machines/:id/shifts', view, handle((req) => listShifts(pool, ctx(req).companyId, id(req))));
router.post('/machines/:id/shifts', manage, handle((req) => tx(req, (db, c) => createShift(db, c, id(req), req.body ?? {}))));
router.post('/machines/:id/shifts/copy', manage, handle((req) => tx(req, (db, c) => copyShifts(db, c, id(req), req.body?.fromMachineId))));
router.put('/machine-shifts/:id', manage, handle((req) => tx(req, (db, c) => updateShift(db, c, id(req), req.body ?? {}))));
router.delete('/machine-shifts/:id', manage, handle((req) => tx(req, (db, c) => deleteShift(db, c, id(req)))));
router.get('/machines/:id/exceptions', view, handle((req) => listExceptions(pool, ctx(req).companyId, id(req), req.query)));
router.post('/machines/:id/exceptions', manage, handle((req) => tx(req, (db, c) => createException(db, c, id(req), req.body ?? {}))));
router.delete('/machine-exceptions/:id', manage, handle((req) => tx(req, (db, c) => deleteException(db, c, id(req)))));
router.get('/machines/:id/calendar', view, handle((req) => machineCalendar(pool, ctx(req).companyId, id(req), req.query)));

export default router;
