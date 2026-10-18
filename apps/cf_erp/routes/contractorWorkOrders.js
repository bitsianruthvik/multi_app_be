/**
 * contractorWorkOrders.js — CONTRACTOR WORK ORDERS (init.sql §85, services/contractorWorkOrderService.js; contract
 * TM/CF_ERP_ORDER_FLOW_PLAN.md "2026-10-18 — Step 6: contractor work orders").
 *
 * From a production order (Production › Production order › Contractor work):
 *   GET  /production-orders/:id/contractor-grid           BOM rows × operations: who holds each cell, tonnes, contractors,
 *                                                          each contractor's last rate per operation
 *   POST /production-orders/:id/contractor-work-orders    { contractorId, cells: [{ rowKey, operationId }],
 *                                                          rates: { [operationId]: rate per t }, dueDate?, notes?, dryRun? }
 *                                                          → the contractor PO (Management approval) + the work order
 * In Accounts (Accounts › Work orders):
 *   GET    /accounts/work-orders?search=&contractorId=&orderId=&productionOrderId=   lanes
 *   GET    /accounts/work-orders/:id
 *   POST   /accounts/work-orders/:id/payments               { paymentDate?, reference?, notes?, lines: [{ poLineId, tonnes?, rate?, amount? }], dryRun? }
 *   DELETE /accounts/work-order-payments/:id                { reason }
 *   POST   /accounts/work-orders/:id/close-short            { reason } — asks Management (the PO's close short)
 *   POST   /accounts/work-orders/:id/cancel                 { reason } — nothing done or paid
 *   POST   /accounts/work-orders/:id/send-again             after Management sent it back
 * For the planner:
 *   GET    /contractor-work/cells?productionOrderIds=&orderIds=   cells (and released steps) under an open work order
 *
 * Grants: the grid and the cells read with production view or accounts view; giving work with production manage or
 * accounts manage; the Accounts screens with accounts view / manage.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guardAny, handle, ctx, intParam } from '../lib/http.js';
import {
  contractorGrid, createContractorWorkOrder, workOrderBoard, readContractorWorkOrder, recordPayment, removePayment,
  askCloseShort, cancelContractorWorkOrder, sendAgain, contractorCellsOf,
} from '../services/contractorWorkOrderService.js';

const router = Router();
const id = (req) => intParam(req.params.id);
const company = (req) => ctx(req).companyId;
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const read = guardAny(PERM.productionView, PERM.accountsView);
const give = guardAny(PERM.production, PERM.accounts);
const view = guardAny(PERM.accountsView, PERM.productionView);
const manage = guardAny(PERM.accounts);

router.get('/production-orders/:id/contractor-grid', read, handle((req) => contractorGrid(pool, company(req), id(req))));
router.post('/production-orders/:id/contractor-work-orders', give, handle((req) => (req.body?.dryRun
  ? createContractorWorkOrder(pool, ctx(req), id(req), req.body)
  : tx(req, (db, c) => createContractorWorkOrder(db, c, id(req), req.body ?? {})))));

router.get('/accounts/work-orders', view, handle((req) => workOrderBoard(pool, company(req), req.query)));
router.get('/accounts/work-orders/:id', view, handle((req) => readContractorWorkOrder(pool, company(req), id(req))));
router.post('/accounts/work-orders/:id/payments', manage, handle((req) => (req.body?.dryRun
  ? recordPayment(pool, ctx(req), id(req), req.body)
  : tx(req, (db, c) => recordPayment(db, c, id(req), req.body ?? {})))));
router.delete('/accounts/work-order-payments/:id', manage, handle((req) => tx(req, (db, c) => removePayment(db, c, id(req), req.body ?? {}))));
router.post('/accounts/work-orders/:id/close-short', manage, handle((req) => tx(req, (db, c) => askCloseShort(db, c, id(req), req.body ?? {}))));
router.post('/accounts/work-orders/:id/cancel', manage, handle((req) => tx(req, (db, c) => cancelContractorWorkOrder(db, c, id(req), req.body ?? {}))));
router.post('/accounts/work-orders/:id/send-again', give, handle((req) => tx(req, (db, c) => sendAgain(db, c, id(req)))));

router.get('/contractor-work/cells', read, handle((req) => contractorCellsOf(pool, company(req), req.query)));

export default router;
