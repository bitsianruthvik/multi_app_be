/**
 * gst.js — GST: the company's tax details, the state list, the GSTIN check, and
 * tax invoices (CF_ERP_GST_PLAN §6, init.sql §37).
 *
 *   GET  /settings/tax                    { legalName, tradeName, gstin, stateCode, stateName, address1, address2, city, pincode,
 *                                           lutNumber, invoicePrefix, einvoiceRequired, gstRates: number[] }
 *   PUT  /settings/tax                    any of those (GSTIN checked; problems[] as usual)
 *   GET  /tax/states                      [{ code, name }]
 *   GET  /tax/validate-gstin?gstin=       { valid, gstin, stateCode, stateName, pan, message }
 *   GET  /invoices?status=&orderId=&customerId=&q=     { rows: InvoiceSummary[] }
 *   GET  /invoices/:id                    Invoice
 *   PUT  /invoices/:id                    { invoiceDate, shipToAddressId | shipTo, transport, notes } (draft; transport also when issued)
 *   DELETE /invoices/:id                  a draft
 *   DELETE /invoices/:id/lines/:lineId    a draft's line (its shipment becomes un-invoiced)
 *   POST /invoices/:id/issue              numbers and freezes it
 *   POST /invoices/:id/cancel             { reason }
 *   GET  /invoices/:id/print?copy=original|duplicate|triplicate    text/html
 *   GET  /invoices/:id/einvoice.json      NIC INV-01 v1.1 (attachment)
 *   GET  /invoices/:id/ewaybill.json      e-way bill bulk JSON (attachment)
 *   PUT  /invoices/:id/irn                { irn, ackNo, ackDate, signedQr }
 *   POST /invoices/:id/eway-bills         { ewayNo, vehicleNo, validUntil }
 *   DELETE /invoices/:id/eway-bills/:ewbId
 *   GET  /orders/:id/invoices             { rows, uninvoiced }
 *   POST /orders/:id/invoices             { movementIds?, invoiceId? } → Invoice (draft)
 *
 * Reads take cf_erp_orders_view, writes cf_erp_orders_manage — the tax settings
 * too (the people who invoice set them up).
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { fail } from '../../../core/middleware/requirePerm.js';
import { translateDbError } from '../lib/errors.js';
import { getTaxSettings, putTaxSettings, GST_STATES, validateGstin } from '../services/taxService.js';
import {
  listInvoices, getInvoice, updateInvoice, deleteInvoice, removeInvoiceLine, issueInvoice, cancelInvoice,
  setIrn, addEwayBill, removeEwayBill, orderInvoices, createInvoice,
} from '../services/invoiceService.js';
import { printHtml, einvoiceJson, ewaybillJson, COPY_LABELS } from '../services/invoiceDocuments.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const company = (req) => ctx(req).companyId;
const view = guard(PERM.ordersView);
const manage = guard(PERM.orders);

router.get('/settings/tax', view, handle((req) => getTaxSettings(pool, company(req))));
router.put('/settings/tax', manage, handle((req) => tx(req, (db, c) => putTaxSettings(db, c, req.body ?? {}))));
router.get('/tax/states', view, handle(() => GST_STATES));
router.get('/tax/validate-gstin', view, handle((req) => validateGstin(req.query.gstin)));

router.get('/invoices', view, handle((req) => listInvoices(pool, company(req), req.query)));
router.get('/invoices/:id', view, handle((req) => getInvoice(pool, company(req), id(req))));
router.put('/invoices/:id', manage, handle((req) => tx(req, (db, c) => updateInvoice(db, c, id(req), req.body ?? {}))));
router.delete('/invoices/:id', manage, handle((req) => tx(req, (db, c) => deleteInvoice(db, c, id(req)))));
router.delete('/invoices/:id/lines/:lineId', manage, handle((req) => tx(req, (db, c) => removeInvoiceLine(db, c, id(req), intParam(req.params.lineId, 'lineId')))));
router.post('/invoices/:id/issue', manage, handle((req) => tx(req, (db, c) => issueInvoice(db, c, id(req)))));
router.post('/invoices/:id/cancel', manage, handle((req) => tx(req, (db, c) => cancelInvoice(db, c, id(req), req.body ?? {}))));
router.put('/invoices/:id/irn', manage, handle((req) => tx(req, (db, c) => setIrn(db, c, id(req), req.body ?? {}))));
router.post('/invoices/:id/eway-bills', manage, handle((req) => tx(req, (db, c) => addEwayBill(db, c, id(req), req.body ?? {}))));
router.delete('/invoices/:id/eway-bills/:ewbId', manage, handle((req) => tx(req, (db, c) => removeEwayBill(db, c, id(req), intParam(req.params.ewbId, 'ewbId')))));

/** The printable page — HTML, not JSON. Errors still come back as JSON. */
router.get('/invoices/:id/print', view, async (req, res) => {
  try {
    const inv = await getInvoice(pool, company(req), id(req));
    const copy = COPY_LABELS[req.query.copy] ? req.query.copy : 'original';
    res.type('html').send(printHtml(inv, copy));
  } catch (err) { fail(res, translateDbError(err)); }
});

const fileName = (inv, kind) => `${String(inv.invoiceNo ?? `draft-${inv.id}`).replace(/[^A-Za-z0-9-]+/g, '_')}-${kind}.json`;
const attachment = (build, kind) => async (req, res) => {
  try {
    const inv = await getInvoice(pool, company(req), id(req));
    const body = build(inv);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(inv, kind)}"`);
    res.type('application/json').send(JSON.stringify(body, null, 2));
  } catch (err) { fail(res, translateDbError(err)); }
};
router.get('/invoices/:id/einvoice.json', view, attachment(einvoiceJson, 'einvoice'));
router.get('/invoices/:id/ewaybill.json', view, attachment(ewaybillJson, 'ewaybill'));

router.get('/orders/:id/invoices', view, handle((req) => orderInvoices(pool, company(req), id(req))));
router.post('/orders/:id/invoices', manage, handle((req) => tx(req, (db, c) => createInvoice(db, c, id(req), req.body ?? {}))));

export default router;
