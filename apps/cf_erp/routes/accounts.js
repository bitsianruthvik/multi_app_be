/**
 * accounts.js — ACCOUNTS (init.sql §74): the Billing board, raising a GST invoice from due cards, receipts, order costing.
 *
 *   GET    /accounts/billing?search=&orderId=     the board: lanes Upcoming → Due to bill → Billed → Paid (reading it
 *                                                 records the material share it sees — billingService.observeMaterial)
 *   POST   /accounts/invoices                     { orderId, cards: [card id], invoiceDate?, creditDays?, notes?, dryRun? }
 *                                                 raise (number + issue) a tax invoice of due cards of one order; dryRun = preview
 *   GET    /accounts/invoices/:id/pdf             the issued invoice as a PDF
 *   GET    /accounts/receipts?orderId=&search=    payments received
 *   POST   /accounts/receipts                     { orderId | invoiceId, receiptDate?, amount, mode?, reference?, notes? }
 *   DELETE /accounts/receipts/:id                 { reason } — entered by mistake
 *   GET    /accounts/orders/:id/payments          one order: invoices with what each owes, receipts, on account
 *   GET    /accounts/costing?search=              one row per sales order: charged, material, consumables, credits, margin
 *   GET    /accounts/costing/:id                  the cost sheet of one order (also the order page's costs card)
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, guardAny, handle, ctx, intParam } from '../lib/http.js';
import { billingBoard, raiseInvoice, invoicePdf } from '../services/billingService.js';
import { recordReceipt, removeReceipt, listReceipts, orderPayments } from '../services/receiptService.js';
import { costingList, costSheet } from '../services/costingService.js';

const router = Router();
const id = (req) => intParam(req.params.id);
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const view = guard(PERM.accountsView);
const manage = guard(PERM.accounts);

router.get('/accounts/billing', view, handle((req) => tx(req, (db, c) => billingBoard(db, c, req.query, { observe: true }))));
router.post('/accounts/invoices', manage, handle((req) => (req.body?.dryRun
  ? raiseInvoice(pool, ctx(req), req.body)
  : tx(req, (db, c) => raiseInvoice(db, c, req.body ?? {})))));
router.get('/accounts/invoices/:id/pdf', guardAny(PERM.accountsView, PERM.ordersView), async (req, res) => {
  try {
    const out = await invoicePdf(pool, ctx(req).companyId, id(req));
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${out.filename}"`);
    res.setHeader('Content-Length', String(out.buffer.length));
    res.send(out.buffer);
  } catch (err) {
    res.status(err?.status ?? 500).json({ code: err?.code, message: err?.status ? err.message : 'Something went wrong.' });
  }
});
router.get('/accounts/receipts', view, handle((req) => listReceipts(pool, ctx(req).companyId, req.query)));
router.post('/accounts/receipts', manage, handle((req) => tx(req, (db, c) => recordReceipt(db, c, req.body ?? {}))));
router.delete('/accounts/receipts/:id', manage, handle((req) => tx(req, (db, c) => removeReceipt(db, c, id(req), req.body ?? {}))));
router.get('/accounts/orders/:id/payments', view, handle((req) => orderPayments(pool, ctx(req).companyId, id(req))));
router.get('/accounts/costing', view, handle((req) => costingList(pool, ctx(req).companyId, req.query)));
router.get('/accounts/costing/:id', guardAny(PERM.accountsView, PERM.inventoryView), handle((req) => costSheet(pool, ctx(req).companyId, id(req))));

export default router;
