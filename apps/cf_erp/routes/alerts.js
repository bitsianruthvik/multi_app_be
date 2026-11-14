/**
 * alerts.js — delay alerts by department and the MD's dashboard (init.sql §110; alertService, mdDashboardService).
 *
 *   GET  /alerts?status=active|open|acknowledged|resolved&department=&kind=&orderId=&all=1
 *                                     the alerts addressed to the person's departments (all=1: every department)
 *   POST /alerts/:id/ack              someone has it
 *   POST /alerts/:id/resolve          it is dealt with
 *   POST /alerts/check                run the checks now (planning or the MD)
 *   GET  /md-dashboard?by=order|operation   today, plan vs reality, the MD's alerts and requests
 */
import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { isPermitted } from '../../../core/middleware/requirePerm.js';
import { pool, withTransaction } from '../lib/db.js';
import { guardAny, handle, ctx, intParam } from '../lib/http.js';
import { DEPARTMENTS, listAlerts, actOnAlert, checkCompany } from '../services/alertService.js';
import { mdDashboard } from '../services/mdDashboardService.js';

const router = Router();
const can = (req) => (tag) => isPermitted(req.user, tag);
const md = guardAny(...DEPARTMENTS.md);

router.get('/alerts', protect, handle((req) => listAlerts(pool, ctx(req).companyId, can(req), req.query)));
router.post('/alerts/check', guardAny(...DEPARTMENTS.md, ...DEPARTMENTS.planning), handle((req) => checkCompany(pool, ctx(req).companyId)));
router.post('/alerts/:id/ack', protect, handle((req) => withTransaction((db) => actOnAlert(db, ctx(req), intParam(req.params.id), 'ack'))));
router.post('/alerts/:id/resolve', protect, handle((req) => withTransaction((db) => actOnAlert(db, ctx(req), intParam(req.params.id), 'resolve'))));
router.get('/md-dashboard', md, handle((req) => mdDashboard(pool, ctx(req).companyId, can(req), req.query)));

export default router;
