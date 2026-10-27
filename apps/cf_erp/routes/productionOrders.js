/**
 * productionOrders.js — PRODUCTION ORDERS (init.sql §76, services/productionOrderService.js). The production order is
 * what is released, tracked and dispatched (contract: TM/CF_ERP_ORDER_FLOW_PLAN.md "2026-10-18 — Step 4").
 *
 *   GET  /orders/:id/production-orders            the order's production orders, what Create would make, older
 *                                                  releases, the time override
 *   POST /orders/:id/production-orders            { dryRun? } — make every production order the saved plan asks for
 *   PUT  /orders/:id/time-override                { seconds: number | null } — "Override all times to N seconds"
 *   GET  /production-orders?state=&search=&orderId=&limit=&offset=   every production order, by sales order
 *   GET  /production-orders/:id                   one, with its pieces' steps
 *   POST /production-orders/release               { ids, finishedAreaId?, notes? } — Yet to plan → Planned (bulk)
 *   POST /production-orders/:id/take-back         Planned → Yet to plan while nothing started
 *   POST /production-orders/:id/dispatch          { reference?, movementDate? } — ships its finished units
 *
 * Grants: production view to read; production manage to create, release, take back and re-time; dispatch (it takes
 * finished stock off the dispatch shelf) is inventory manage OR production manage (PPC, user 2026-10-27), and drafts
 * the tax invoice only for accounts manage (invoices are Accounts' only, init.sql §94).
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, guardAny, handle, ctx, intParam } from '../lib/http.js';
import { shipInput } from './tracker.js';
import {
  getOrderProductionOrders, createProductionOrders, setTimeOverride, listProductionOrders, readProductionOrder,
  releaseProductionOrders, takeBackProductionOrder, dispatchProductionOrder,
} from '../services/productionOrderService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const company = (req) => ctx(req).companyId;
const view = guard(PERM.productionView);
const manage = guard(PERM.production);

router.get('/orders/:id/production-orders', view, handle((req) => getOrderProductionOrders(pool, company(req), id(req))));
router.post('/orders/:id/production-orders', manage, handle((req) => (req.body?.dryRun
  ? createProductionOrders(pool, ctx(req), id(req), { dryRun: true })
  : tx(req, (db, c) => createProductionOrders(db, c, id(req), req.body ?? {})))));
router.put('/orders/:id/time-override', manage, handle((req) => tx(req, (db, c) => setTimeOverride(db, c, id(req), req.body ?? {}))));
router.get('/production-orders', view, handle((req) => listProductionOrders(pool, company(req), req.query)));
// Before /production-orders/:id, which would take 'release' for an id.
router.post('/production-orders/release', manage, handle((req) => tx(req, (db, c) => releaseProductionOrders(db, c, req.body ?? {}))));
router.get('/production-orders/:id', view, handle((req) => readProductionOrder(pool, company(req), id(req))));
router.post('/production-orders/:id/take-back', manage, handle((req) => tx(req, (db, c) => takeBackProductionOrder(db, c, id(req)))));
router.post('/production-orders/:id/dispatch', guardAny(PERM.inventory, PERM.production), handle((req) => tx(req, (db, c) => dispatchProductionOrder(db, c, id(req), shipInput(req)))));

export default router;
