/**
 * maintenance.js — MAINTENANCE (init.sql §82; services/maintenanceService.js; contract TM/CF_ERP_ORDER_FLOW_PLAN.md
 * "2026-10-18 — Maintenance (S6)").
 *
 *   GET    /maintenance/board                         machines: down / planned / stopped / running / idle, planned
 *                                                     downtime today + 14 days, stop reasons (tops up the calendar and
 *                                                     raises due preventive MOs first)
 *   GET    /maintenance/summary                       the dashboard card: downtime hours this week, maintenance cost
 *   POST   /maintenance/faults                        { machineId, reasonId?, note?, operatorId? } — RAISE A FAULT (floor)
 *   GET    /maintenance/orders?status=&machineId=&search=
 *   POST   /maintenance/orders                        { machineId, title, note? } — a job of maintenance's own
 *   GET    /maintenance/orders/:id
 *   POST   /maintenance/orders/:id/status             { status: in_progress | waiting_parts, note?, stopMachine? }
 *   POST   /maintenance/orders/:id/false-alarm        { note? }
 *   POST   /maintenance/orders/:id/cancel             { note }
 *   POST   /maintenance/orders/:id/close              { workDone?, otherCost?, costNote? }
 *   GET    /maintenance/orders/:id/mr-lines           the machine's tools / spares / consumables (§81) as MR lines
 *   POST   /maintenance/orders/:id/requisition        { lines: [{ itemId, qty, uom? }], note?, orderId? } → an MR (§79)
 *   GET    /maintenance/plans?machineId=              preventive plans with days / run hours / tonnes since (raises due)
 *   POST   /maintenance/plans  · PUT /maintenance/plans/:id · DELETE /maintenance/plans/:id
 *   POST   /maintenance/plans/raise-due               raise an MO for every due plan (a scheduler may call it)
 *   GET    /maintenance/downtime?machineId=           planned downtime rules with their next occurrences
 *   POST   /maintenance/downtime                      { machineId, kind, reason, startsOn, …, dryRun? }
 *   PUT    /maintenance/downtime/:id · DELETE /maintenance/downtime/:id
 *
 * Permission: cf_erp_maintenance (admins pass); production view may read. A fault may be raised by anyone on the floor
 * (cf_erp_floor) or by production / maintenance.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guardAny, handle, ctx, intParam } from '../lib/http.js';
import * as M from '../services/maintenanceService.js';

export const MAINTENANCE = 'cf_erp_maintenance';
const router = Router();
const id = (req) => intParam(req.params.id);
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const view = guardAny(MAINTENANCE, PERM.productionView);
const manage = guardAny(MAINTENANCE);
const fault = guardAny(PERM.floor, PERM.production, MAINTENANCE);

router.get('/maintenance/board', view, handle((req) => tx(req, (db, c) => M.machinesBoard(db, c))));
router.get('/maintenance/summary', guardAny(MAINTENANCE, PERM.productionView), handle((req) => M.maintenanceSummary(pool, ctx(req).companyId)));
router.post('/maintenance/faults', fault, handle((req) => tx(req, (db, c) => M.raiseFault(db, c, req.body ?? {}))));

router.get('/maintenance/orders', view, handle((req) => M.listOrders(pool, ctx(req).companyId, req.query)));
router.post('/maintenance/orders', manage, handle((req) => tx(req, (db, c) => M.createOrder(db, c, req.body ?? {}))));
router.get('/maintenance/orders/:id', view, handle((req) => M.getOrder(pool, ctx(req).companyId, id(req))));
router.post('/maintenance/orders/:id/status', manage, handle((req) => tx(req, (db, c) => M.setStatus(db, c, id(req), req.body ?? {}))));
router.post('/maintenance/orders/:id/false-alarm', manage, handle((req) => tx(req, (db, c) => M.falseAlarm(db, c, id(req), req.body ?? {}))));
router.post('/maintenance/orders/:id/cancel', manage, handle((req) => tx(req, (db, c) => M.cancelOrder(db, c, id(req), req.body ?? {}))));
router.post('/maintenance/orders/:id/close', manage, handle((req) => tx(req, (db, c) => M.closeOrder(db, c, id(req), req.body ?? {}))));
router.get('/maintenance/orders/:id/mr-lines', manage, handle((req) => M.mrLines(pool, ctx(req).companyId, id(req))));
router.post('/maintenance/orders/:id/requisition', manage, handle((req) => tx(req, (db, c) => M.raiseRequisition(db, c, id(req), req.body ?? {}))));

router.get('/maintenance/plans', view, handle((req) => tx(req, (db, c) => M.listPlans(db, c, req.query))));
router.post('/maintenance/plans/raise-due', manage, handle((req) => tx(req, async (db, c) => ({ raised: (await M.raiseDue(db, c)).length }))));
router.post('/maintenance/plans', manage, handle((req) => tx(req, (db, c) => M.createPlan(db, c, req.body ?? {}))));
router.put('/maintenance/plans/:id', manage, handle((req) => tx(req, (db, c) => M.updatePlan(db, c, id(req), req.body ?? {}))));
router.delete('/maintenance/plans/:id', manage, handle((req) => tx(req, (db, c) => M.deletePlan(db, c, id(req)))));

router.get('/maintenance/downtime', view, handle((req) => M.listDowntimes(pool, ctx(req).companyId, req.query)));
router.post('/maintenance/downtime', manage, handle((req) => (req.body?.dryRun
  ? M.createDowntime(pool, ctx(req), req.body)
  : tx(req, (db, c) => M.createDowntime(db, c, req.body ?? {})))));
router.put('/maintenance/downtime/:id', manage, handle((req) => tx(req, (db, c) => M.updateDowntime(db, c, id(req), req.body ?? {}))));
router.delete('/maintenance/downtime/:id', manage, handle((req) => tx(req, (db, c) => M.deleteDowntime(db, c, id(req)))));

export default router;
