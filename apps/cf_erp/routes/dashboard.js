/**
 * dashboard.js — Production › Dashboard (services/dashboardService.js). Reads only.
 *
 *   GET /dashboard/machines?from=YYYY-MM-DD&to=YYYY-MM-DD   by machine (default this week, ≤ 92 days)
 *   GET /dashboard/orders?from=&to=                          by confirmed order; from/to set "this period"
 *
 * Permission: production view (or manage) for both — what management already
 * holds to see machines, the plan and the tracker. The orders tab also opens
 * with orders view alone; its money (order value, invoiced, material cost) is
 * only sent to a reader with orders view (admins pass, as everywhere).
 */
import { Router } from 'express';
import { pool } from '../lib/db.js';
import { PERM, guardAny, handle, ctx } from '../lib/http.js';
import { isPermitted } from '../../../core/middleware/requirePerm.js';
import { machinesDashboard, ordersDashboard } from '../services/dashboardService.js';

const router = Router();

router.get('/dashboard/machines', guardAny(PERM.productionView, PERM.production),
  handle((req) => machinesDashboard(pool, ctx(req).companyId, req.query)));
router.get('/dashboard/orders', guardAny(PERM.productionView, PERM.production, PERM.ordersView),
  handle((req) => ordersDashboard(pool, ctx(req).companyId, req.query, { withMoney: isPermitted(req.user, PERM.ordersView) })));

export default router;
