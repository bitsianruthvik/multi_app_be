/**
 * workOrders.js — contractor work orders (services/workOrderService.js).
 *
 * Every route is behind the production grants: cf_erp_production_view to see,
 * cf_erp_production_manage to change (the Production stage's screens use them).
 *
 * On the order (its Production stage, Contractors tab):
 *   GET  /orders/:orderId/lines/:lineId/assignment
 *        the locked piece tree x operations: who does each cell (blank = in-house),
 *        whether it has started, the contractors and the line's work orders
 *   POST /orders/:orderId/lines/:lineId/assignment   { cells: [{ pieceId, operationId }], contractorId | null }
 *        puts the cells on the contractor's open work order for the line (a new
 *        draft if none); null = back in-house. Started cells refuse the whole request.
 *        Or { assignments: [{ cells, contractorId | null }] }: several groups, ONE transaction.
 *
 * The work orders themselves (Production > Work orders):
 *   GET   /work-orders                 a bare array; ?status=open (draft+issued+in_progress) or a
 *                                      list (draft,issued), &contractorId=&orderId=&lineId=&search=
 *   GET   /work-orders/by-order        (2026-10-17) one row per SALES ORDER: { order, totals, workOrders[] },
 *                                      paged by order (limit, offset); ?status=&search=&contractorId=
 *   GET   /work-orders/:id             header, scope by piece, progress once released
 *   PATCH /work-orders/:id             { startDate?, dueDate?, notes? }
 *   POST  /work-orders/:id/status      { status }  draft -> issued -> in_progress -> done; open -> cancelled
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { CfError } from '../lib/errors.js';
import {
  getAssignment, listWorkOrders, listWorkOrdersByOrder, getWorkOrder, updateWorkOrder, setWorkOrderStatus,
} from '../services/workOrderService.js';

const router = Router();
const orderId = (req) => intParam(req.params.orderId, 'orderId');
const lineId = (req) => intParam(req.params.lineId, 'lineId');
const id = (req) => intParam(req.params.id);

router.get('/orders/:orderId/lines/:lineId/assignment', guard(PERM.productionView),
  handle((req) => getAssignment(pool, ctx(req).companyId, orderId(req), lineId(req))));
// RETIRED (Step 6, §85, user 2026-10-18): contractor work is given from a PRODUCTION ORDER (BOM rows × operations →
// a contractor PO → Management → the work order, in Accounts). The older work orders stay readable here.
router.post('/orders/:orderId/lines/:lineId/assignment', guard(PERM.production),
  handle(async () => { throw new CfError(422, 'RETIRED', 'Contractor work is given from a production order now — open it and use "Give work to a contractor".'); }));

router.get('/work-orders', guard(PERM.productionView), handle((req) => listWorkOrders(pool, ctx(req).companyId, req.query)));
router.get('/work-orders/by-order', guard(PERM.productionView), handle((req) => listWorkOrdersByOrder(pool, ctx(req).companyId, req.query)));
router.get('/work-orders/:id', guard(PERM.productionView), handle((req) => getWorkOrder(pool, ctx(req).companyId, id(req))));
router.patch('/work-orders/:id', guard(PERM.production),
  handle((req) => withTransaction((db) => updateWorkOrder(db, ctx(req), id(req), req.body ?? {}))));
router.post('/work-orders/:id/status', guard(PERM.production),
  handle((req) => withTransaction((db) => setWorkOrderStatus(db, ctx(req), id(req), req.body?.status))));

export default router;
