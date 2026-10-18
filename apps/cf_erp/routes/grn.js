/**
 * grn.js — a GRN that captures the money (init.sql §80; services/grnService.js).
 *
 *   GET  /purchase-orders/:id/grn-context   what the GRN screen needs: the company's GST state (set?), the supplier's, how the
 *                                           bill is taxed (or why that cannot be said yet), the allowed rates, each line's HSN / rate
 *   POST /purchase-orders/:id/grn           { stockingAreaId, movementDate?, reference?, notes?, invoice: { no?, date?, pending? },
 *                                           charges?: { freight?: { amount, taxable, gstRate }, other?: {...} },
 *                                           companyStateCode?, supplierStateCode?, dryRun?,
 *                                           lines: [{ lineId, quantity?, unitPrice?, mrp?, discountMode? 'pct'|'amt', discountValue?,
 *                                                     hsnCode?, gstRate?, batchId?, batch? }] }
 *                                           books one receipt per line at the LANDED unit cost + one supplier bill -> { bill, movements, held, order, warnings, money }
 *                                           (dryRun: { preview } only)
 *   GET  /grn-bills?supplierId=&purchaseOrderId=&flag=invoice_pending|no_money&from=&to=&search=&limit=   supplier bills (Accounts reads these)
 *   GET  /grn-bills/:id                     one bill with its lines
 *   PUT  /grn-bills/:id/invoice             { no, date } — the invoice that was "to follow" has come
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, guardAny, handle, ctx, intParam } from '../lib/http.js';
import { grnContext, receiveGrn, listBills, getBill, completeInvoice } from '../services/grnService.js';

const router = Router();
const id = (req) => intParam(req.params.id);
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const view = guardAny(PERM.inventoryView, PERM.accountsView);
const manage = guard(PERM.inventory);

router.get('/purchase-orders/:id/grn-context', view, handle((req) => grnContext(pool, ctx(req).companyId, id(req), { lineIds: req.query.lineIds ? String(req.query.lineIds).split(',').map(Number).filter(Boolean) : null })));
router.post('/purchase-orders/:id/grn', manage, handle((req) => (req.body?.dryRun
  ? receiveGrn(pool, ctx(req), id(req), req.body)
  : tx(req, (db, c) => receiveGrn(db, c, id(req), req.body ?? {})))));
router.get('/grn-bills', view, handle((req) => listBills(pool, ctx(req).companyId, req.query)));
router.get('/grn-bills/:id', view, handle((req) => getBill(pool, ctx(req).companyId, id(req))));
router.put('/grn-bills/:id/invoice', guardAny(PERM.inventory, PERM.accounts), handle((req) => tx(req, (db, c) => completeInvoice(db, c, id(req), req.body ?? {}))));

export default router;
