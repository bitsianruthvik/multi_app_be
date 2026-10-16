/**
 * cutAllowances.js — CUTTING ALLOWANCE by BOM part name (init.sql §64, 2026-10-16).
 * Service: services/cutAllowanceService.js. Applied to cut pieces in cutPlateService.survey.
 *
 *   GET    /cut-allowances/part-names?search=                         the catalog's plate-part definitions     orders view
 *   GET    /customers/:customerId/cut-allowances                       the customer's defaults                  orders view
 *   PUT    /customers/:customerId/cut-allowances/:definitionId         { perEndMm, perMetreMm }                 parties manage
 *   DELETE /customers/:customerId/cut-allowances/:definitionId                                                  parties manage
 *   GET    /orders/:orderId/cut-allowances                             part names in this order's BOM, rows     orders view
 *   PUT    /orders/:orderId/cut-allowances/:definitionId               { perEndMm, perMetreMm } override        orders manage
 *   DELETE /orders/:orderId/cut-allowances/:definitionId               back to the customer's                   orders manage
 *   GET    /orders/:orderId/lines/:lineId/rows/:rowId/cut-allowance    one row's levels                         orders view
 *   PUT    /orders/:orderId/lines/:lineId/rows/:rowId/cut-allowance    { perEndMm, perMetreMm } this row only   orders manage
 *   DELETE /orders/:orderId/lines/:lineId/rows/:rowId/cut-allowance    back to the part name's                  orders manage
 *
 * Every write re-derives the cut pieces of the open lines it reaches in the same transaction and answers
 * `refreshed` / `frozen` / `message` beside the fresh view.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import {
  partNames, customerAllowances, setCustomerAllowance, clearCustomerAllowance,
  orderAllowances, setOrderAllowance, clearOrderAllowance, rowAllowance, setRowAllowance, clearRowAllowance,
} from '../services/cutAllowanceService.js';

const router = Router();
const p = (req, name) => intParam(req.params[name], name);

router.get('/cut-allowances/part-names', guard(PERM.ordersView),
  handle((req) => partNames(pool, ctx(req).companyId, { search: req.query?.search ?? '' })));

router.get('/customers/:customerId/cut-allowances', guard(PERM.ordersView),
  handle((req) => customerAllowances(pool, ctx(req).companyId, p(req, 'customerId'))));
router.put('/customers/:customerId/cut-allowances/:definitionId', guard(PERM.parties),
  handle((req) => withTransaction((db) => setCustomerAllowance(db, ctx(req), p(req, 'customerId'), p(req, 'definitionId'), req.body ?? {}))));
router.delete('/customers/:customerId/cut-allowances/:definitionId', guard(PERM.parties),
  handle((req) => withTransaction((db) => clearCustomerAllowance(db, ctx(req), p(req, 'customerId'), p(req, 'definitionId')))));

router.get('/orders/:orderId/cut-allowances', guard(PERM.ordersView),
  handle((req) => orderAllowances(pool, ctx(req).companyId, p(req, 'orderId'))));
router.put('/orders/:orderId/cut-allowances/:definitionId', guard(PERM.orders),
  handle((req) => withTransaction((db) => setOrderAllowance(db, ctx(req), p(req, 'orderId'), p(req, 'definitionId'), req.body ?? {}))));
router.delete('/orders/:orderId/cut-allowances/:definitionId', guard(PERM.orders),
  handle((req) => withTransaction((db) => clearOrderAllowance(db, ctx(req), p(req, 'orderId'), p(req, 'definitionId')))));

router.get('/orders/:orderId/lines/:lineId/rows/:rowId/cut-allowance', guard(PERM.ordersView),
  handle((req) => rowAllowance(pool, ctx(req).companyId, p(req, 'orderId'), p(req, 'lineId'), p(req, 'rowId'))));
router.put('/orders/:orderId/lines/:lineId/rows/:rowId/cut-allowance', guard(PERM.orders),
  handle((req) => withTransaction((db) => setRowAllowance(db, ctx(req), p(req, 'orderId'), p(req, 'lineId'), p(req, 'rowId'), req.body ?? {}))));
router.delete('/orders/:orderId/lines/:lineId/rows/:rowId/cut-allowance', guard(PERM.orders),
  handle((req) => withTransaction((db) => clearRowAllowance(db, ctx(req), p(req, 'orderId'), p(req, 'lineId'), p(req, 'rowId')))));

export default router;
