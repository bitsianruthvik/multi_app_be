/**
 * invoiceService.js — the tax invoice with each dispatch (CF_ERP_GST_PLAN §3,
 * init.sql §37e–g).
 *
 * "A customer gets a TAX INVOICE WITH EACH DISPATCH — the truck's load at the
 * line's rate + GST; the e-way bill rides on it" (user, 2026-09-30).
 *
 * LIFE OF AN INVOICE.
 *   draft     made by shipping (dispatchService.shipLine, invoice: true — ONE draft
 *             per order per dispatch day collects every line on the truck) or by
 *             POST /orders/:id/invoices for shipments not yet invoiced. A draft
 *             holds only WHAT shipped; its money, parties and tax are worked out
 *             LIVE on every read, so fixing a rate, an HSN code or a GSTIN shows
 *             at once. Editable: date, ship-to, transport, notes; a line can go.
 *   issued    POST /invoices/:id/issue checks everything (problems), takes the next
 *             number of the financial year inside the same transaction
 *             (cf_invoice_series FOR UPDATE — gap-free) and FREEZES the supplier,
 *             buyer, ship-to and every line into the invoice's own columns. It
 *             never changes again; only transport (logistics, not the tax
 *             document), the IRN typed back from the portal and e-way bill
 *             numbers are recorded against it.
 *   cancelled keeps its number (a cancelled number is never reused); its
 *             shipments are free to be invoiced again.
 *
 * A SHIPMENT is an issue movement against an order line, of the line's own item,
 * out of a dispatch area (shipLine's movement). It is invoiced at most once:
 * uq_cinl_claim over (movement, order line, claim) where claim = 1 on a live line
 * of a draft or issued invoice and NULL otherwise.
 *
 * ROUND TRIPS. Every read loads the invoices' lines, items, customers and the
 * company in bulk — a fixed handful of queries whatever the size.
 */
import { invalid, notFound, conflict, assertNoProblems } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { EXPORT_MAX, countsBy, likeOf, orderBy, pageArgs, pageOf, wantsPage } from '../lib/listing.js';
import { round2, measuresOf, amountOf, num, CURRENCY } from './priceService.js';
import {
  companyTax, itemTaxOf, partyTaxOf, supplyOf, taxLines, amountInWords, stateName, validateGstin,
  financialYear, invoiceNumber, FOREIGN_STATE, LUT_NOTE,
} from './taxService.js';
import { readStateCode } from '../modules/parties/gstin.js';

const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const dateOnly = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : d ?? null);
export const todayText = () => dateOnly(new Date());
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PIN_RE = /^[1-9]\d{5}$/;
const json = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
const r3 = (n) => (n == null ? null : Math.round(Number(n) * 1000) / 1000);
export const TRANSPORT_MODES = { road: 1, rail: 2, air: 3, ship: 4 };

/** Where each kind of missing data is fixed — paths relative to /:company/cf_erp/ (plan §5 jump links, the FE's routes). */
export const FIX = {
  company: { label: 'Setup › Company tax details', to: 'company-tax' },
  customer: (id) => ({ label: 'Open the customer', to: `customers/${id}` }),
  order: (id) => ({ label: 'Open the order', to: `orders/${id}` }),
  item: (id) => ({ label: 'Open the item', to: `items/${id}` }),
  definition: (id) => ({ label: 'Open the template', to: `definitions/${id}` }),
};

// --- shipments -------------------------------------------------------------------

/**
 * An order's shipments not on a live invoice line: issue movements against a
 * line, of the line's own item, out of a dispatch area, not reversed. One query.
 * movementIds narrows it. Rows: { movementId, movementCode, date, orderLineId, lineNo, itemId, quantity }.
 */
export async function uninvoicedShipments(db, companyId, orderId, movementIds = null) {
  if (movementIds && !movementIds.length) return [];
  const [rows] = await db.query(
    `SELECT v.id AS movement_id, v.code AS movement_code, v.movement_date, v.order_line_id, l.line_no, l.item_id,
            -SUM(k.quantity) AS quantity
       FROM cf_stock_movements v
       JOIN cf_sales_order_lines l ON l.id = v.order_line_id AND l.company_id = v.company_id
       JOIN cf_stock_ledger k ON k.company_id = v.company_id AND k.movement_id = v.id AND k.item_id = l.item_id AND k.deleted_at IS NULL
       JOIN cf_stocking_areas a ON a.id = k.stocking_area_id AND a.purpose = 'dispatch'
      WHERE v.company_id = ? AND v.order_id = ? AND v.movement_type = 'issue' AND v.deleted_at IS NULL
        AND v.reversed_by_id IS NULL AND v.reversal_of_id IS NULL
        ${movementIds ? 'AND v.id IN (?)' : ''}
        AND NOT EXISTS (SELECT 1 FROM cf_invoice_lines il WHERE il.company_id = v.company_id AND il.movement_id = v.id AND il.claim = 1)
      GROUP BY v.id, v.code, v.movement_date, v.order_line_id, l.line_no, l.item_id
      HAVING quantity > 0
      ORDER BY v.movement_date, v.id`,
    movementIds ? [companyId, orderId, movementIds.map(Number)] : [companyId, orderId],
  );
  return rows.map((r) => ({
    movementId: r.movement_id, movementCode: r.movement_code, date: dateOnly(r.movement_date),
    orderLineId: r.order_line_id, lineNo: r.line_no, itemId: r.item_id, quantity: Number(r.quantity),
  }));
}

async function requireOrder(db, companyId, orderId) {
  const [[o]] = await db.query(
    'SELECT id, code, order_type, customer_id, status FROM cf_sales_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL',
    [companyId, Number(orderId)],
  );
  if (!o) throw notFound('Sales order');
  return o;
}

/** A new empty draft for an order; its ship-to starts as the customer's default ship-to address. */
async function insertDraft(db, c, order, dispatchDate) {
  let shipId = null;
  if (order.customer_id) {
    const [[a]] = await db.query(
      'SELECT id FROM cf_party_addresses WHERE company_id = ? AND party_id = ? AND is_default_ship = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1',
      [c.companyId, order.customer_id],
    );
    shipId = a?.id ?? null;
  }
  const [r] = await db.query(
    `INSERT INTO cf_invoices (company_id, order_id, customer_id, status, dispatch_date, ship_to_address_id, currency, created_by)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)`,
    [c.companyId, order.id, order.customer_id ?? null, dispatchDate, shipId, CURRENCY, c.userId ?? null],
  );
  return r.insertId;
}

/** Appends shipments to a draft as lines (line numbers continue). Two round trips. */
async function appendLines(db, c, invoiceId, shipments) {
  if (!shipments.length) return;
  const [[{ top }]] = await db.query('SELECT COALESCE(MAX(line_no), 0) AS top FROM cf_invoice_lines WHERE company_id = ? AND invoice_id = ?', [c.companyId, invoiceId]);
  let n = Number(top);
  await insertRows(db, 'cf_invoice_lines', ['company_id', 'invoice_id', 'line_no', 'order_line_id', 'movement_id', 'claim', 'quantity'],
    shipments.map((s) => [c.companyId, invoiceId, ++n, s.orderLineId, s.movementId, 1, s.quantity]));
}

/**
 * shipLine's hook (same transaction): the shipments just made go on TODAY'S
 * DRAFT for the order — the draft collecting that dispatch day — created when
 * there is none. Returns { id, status, invoiceNo } or null when nothing is left
 * to invoice.
 */
export async function invoiceShipments(db, c, orderId, movementIds) {
  const shipments = await uninvoicedShipments(db, c.companyId, orderId, movementIds);
  if (!shipments.length) return null;
  const order = await requireOrder(db, c.companyId, orderId);
  const day = shipments[0].date;
  const [[draft]] = await db.query(
    `SELECT id FROM cf_invoices WHERE company_id = ? AND order_id = ? AND status = 'draft' AND dispatch_date = ? AND deleted_at IS NULL
      ORDER BY id LIMIT 1 FOR UPDATE`,
    [c.companyId, order.id, day],
  );
  const id = draft?.id ?? await insertDraft(db, c, order, day);
  await appendLines(db, c, id, shipments);
  return { id, status: 'draft', invoiceNo: null };
}

/**
 * POST /orders/:id/invoices { movementIds?, invoiceId? } — a draft for shipments
 * not yet invoiced (all of the order's when none are named). invoiceId adds
 * them to that draft of the same order instead of starting a new one.
 */
export async function createInvoice(db, c, orderId, input = {}) {
  const order = await requireOrder(db, c.companyId, orderId);
  if (order.order_type === 'stock') throw invalid('STOCK_ORDER', `${order.code} is a stock order — nothing on it is sold, so there is nothing to invoice.`);
  const ids = Array.isArray(input.movementIds) && input.movementIds.length ? input.movementIds.map(Number) : null;
  const shipments = await uninvoicedShipments(db, c.companyId, order.id, ids);
  if (ids) {
    const found = new Set(shipments.map((s) => s.movementId));
    const missing = ids.filter((m) => !found.has(m));
    if (missing.length) throw invalid('NOT_UNINVOICED', `${missing.length === 1 ? 'That shipment is' : `${missing.length} of those shipments are`} not an un-invoiced shipment of ${order.code} — already on an invoice, reversed, or not a shipment.`);
  }
  if (!shipments.length) throw invalid('NOTHING_TO_INVOICE', `Everything shipped on ${order.code} is already on an invoice.`);
  let id;
  if (!blank(input.invoiceId)) {
    const inv = await lockInvoice(db, c.companyId, input.invoiceId);
    if (inv.order_id !== order.id) throw invalid('OTHER_ORDER', 'That draft is for another order.');
    assertDraft(inv);
    id = inv.id;
  } else {
    id = await insertDraft(db, c, order, todayText());
  }
  await appendLines(db, c, id, shipments);
  return getInvoice(db, c.companyId, id);
}

/** GET /orders/:id/invoices → { rows, uninvoiced } */
export async function orderInvoices(db, companyId, orderId) {
  const order = await requireOrder(db, companyId, orderId);
  const [{ rows }, uninvoiced] = await Promise.all([
    listInvoices(db, companyId, { orderId: order.id }, { unbounded: true }), // every invoice of the order, no 500 cap, no counts
    uninvoicedShipments(db, companyId, order.id),
  ]);
  return { rows, uninvoiced: uninvoiced.map(({ itemId, orderLineId, ...s }) => ({ ...s, orderLineId })) };
}

// --- reading: drafts worked out live, issued ones from their frozen columns --------

const INVOICE_SELECT = `SELECT inv.*, o.code AS order_code, p.name AS customer_name, p.code AS customer_code,
            (SELECT COUNT(*) FROM cf_eway_bills e WHERE e.company_id = inv.company_id AND e.invoice_id = inv.id AND e.deleted_at IS NULL) AS eway_count
       FROM cf_invoices inv
       JOIN cf_sales_orders o ON o.id = inv.order_id
       LEFT JOIN cf_parties p ON p.id = inv.customer_id`;

async function lockInvoice(db, companyId, id) {
  const [[inv]] = await db.query('SELECT * FROM cf_invoices WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [companyId, Number(id)]);
  if (!inv) throw notFound('Invoice');
  return inv;
}

function assertDraft(inv, what = 'changed') {
  if (inv.status === 'issued') throw conflict('ISSUED', `Invoice ${inv.invoice_no} is issued — an issued invoice is never ${what}. Cancel it and invoice the shipments again.`);
  if (inv.status === 'cancelled') throw conflict('CANCELLED', `Invoice ${inv.invoice_no ?? ''} is cancelled — it is kept as it was.`.replace('  ', ' '));
}

function supplierOf(company) {
  return {
    legalName: company.legalName, tradeName: company.tradeName, gstin: company.gstin, stateCode: company.stateCode,
    stateName: company.stateName, address1: company.address1, address2: company.address2, city: company.city, pincode: company.pincode,
  };
}

function buyerOf(p) {
  if (!p) return null;
  return {
    partyId: p.id, code: p.code, name: p.name, gstin: p.gstin, registration: p.registration,
    stateCode: p.stateCode, stateName: stateName(p.stateCode), address: p.address, city: p.city, pincode: p.pincode,
  };
}

/**
 * Loads everything a set of invoices needs — lines, and for drafts the company,
 * items' tax and measures, customers and ship-to addresses — and works each
 * out. Returns Map invoiceId → view { supplier, buyer, shipTo, pos, supply, lines, totals, problems }.
 */
async function buildViews(db, companyId, invoices) {
  const out = new Map();
  if (!invoices.length) return out;
  const ids = invoices.map((i) => i.id);
  const drafts = invoices.filter((i) => i.status === 'draft');
  const [lineRows] = await db.query(
    `SELECT il.*, l.line_no AS order_line_no, l.item_id, l.rate AS live_rate, l.rate_basis AS live_basis, l.description AS line_description,
            m.code AS item_code, m.name AS item_name, i.uom AS item_uom, i.source_definition_id, i.item_type,
            v.code AS movement_code, v.movement_date
       FROM cf_invoice_lines il
       JOIN cf_sales_order_lines l ON l.id = il.order_line_id
       LEFT JOIN cf_master_records m ON m.id = l.item_id
       LEFT JOIN cf_item_details i ON i.master_id = l.item_id
       JOIN cf_stock_movements v ON v.id = il.movement_id
      WHERE il.company_id = ? AND il.invoice_id IN (?) AND il.deleted_at IS NULL
      ORDER BY il.invoice_id, il.line_no, il.id`,
    [companyId, ids],
  );
  const linesOf = new Map(ids.map((id) => [id, []]));
  for (const r of lineRows) linesOf.get(r.invoice_id).push(r);

  let company = null; let items = new Map(); let measures = new Map(); let parties = new Map(); const addresses = new Map();
  if (drafts.length) {
    const draftLines = drafts.flatMap((d) => linesOf.get(d.id));
    const measured = draftLines.filter((l) => (l.live_basis ?? 'unit') !== 'unit');
    const addrIds = drafts.map((d) => d.ship_to_address_id).filter(Boolean);
    const [co, it, me, pa, ad] = await Promise.all([
      companyTax(db, companyId),
      itemTaxOf(db, companyId, draftLines.map((l) => l.item_id)),
      measured.length ? measuresOf(db, companyId, measured.map((l) => l.item_id)) : new Map(),
      partyTaxOf(db, companyId, drafts.map((d) => d.customer_id)),
      addrIds.length ? db.query('SELECT * FROM cf_party_addresses WHERE company_id = ? AND id IN (?)', [companyId, addrIds]).then(([rows]) => rows) : [],
    ]);
    company = co; items = it; measures = me; parties = pa;
    for (const a of ad) addresses.set(a.id, a);
  }

  for (const inv of invoices) {
    const rows = linesOf.get(inv.id);
    if (inv.status !== 'draft') { out.set(inv.id, frozenView(inv, rows)); continue; }
    out.set(inv.id, draftView(inv, rows, { company, items, measures, parties, addresses }));
  }
  return out;
}

function shipToOf(inv, buyer, addresses) {
  if (inv.ship_to_address_id) {
    const a = addresses.get(inv.ship_to_address_id);
    if (a && !a.deleted_at) {
      return {
        addressId: a.id, label: a.label, name: buyer?.name ?? null, address: a.address, city: a.city, pincode: a.pincode,
        stateCode: a.state_code, stateName: stateName(a.state_code), gstin: a.gstin ?? null,
      };
    }
  }
  const typed = json(inv.ship_to);
  if (typed) return { addressId: null, ...typed, stateName: stateName(typed.stateCode) };
  return null;
}

function draftView(inv, rows, { company, items, measures, parties, addresses }) {
  const cust = inv.customer_id ? parties.get(inv.customer_id) : null;
  const buyer = buyerOf(cust);
  const shipTo = shipToOf(inv, buyer, addresses);
  const pos = cust?.registration === 'overseas' ? FOREIGN_STATE : (shipTo?.stateCode ?? buyer?.stateCode ?? null);
  const supply = cust ? supplyOf({ supplierState: company.stateCode, placeOfSupply: pos, registration: cust.registration, lutNumber: company.lutNumber }) : null;
  const priced = rows.map((r) => {
    const tax = items.get(r.item_id) ?? {};
    const basis = r.live_basis ?? 'unit';
    const a = amountOf(num(r.live_rate), basis, r.quantity, measures.get(r.item_id), r.item_uom ?? 'nos');
    return {
      row: r,
      id: r.id, slNo: r.line_no, orderLineId: r.order_line_id, lineNo: r.order_line_no, movementId: r.movement_id, movementCode: r.movement_code,
      description: r.line_description || r.item_name || r.item_code, hsnCode: tax.hsnCode ?? null, isService: !!tax.isService,
      quantity: Number(r.quantity), uom: r.item_uom ?? 'nos',
      billedQty: a.billed, billedUom: a.uom, rate: num(r.live_rate), rateBasis: basis,
      taxable: a.amount, gstRate: tax.gstRate ?? null, amountNote: a.note,
      itemId: r.item_id, sourceDefinitionId: r.item_type === 'temporary' ? r.source_definition_id : null,
    };
  });
  const res = taxLines(priced, supply);
  const supplier = supplierOf(company);

  // Why it cannot be issued yet — every reason at once, each with where to fix it.
  const problems = [];
  const P = (message, fix = null) => problems.push({ message, fix });
  if (!company.gstin) P('Company GSTIN not set.', FIX.company);
  if (!company.stateCode) P('Company state not set.', FIX.company);
  if (!company.legalName) P('Company legal name not set.', FIX.company);
  if (!company.address1 || !company.city || !company.pincode) P('Company address (line 1, city, PIN code) not complete.', FIX.company);
  if (!cust) P('The order has no customer.', FIX.order(inv.order_id));
  else {
    if (['regular', 'composition', 'sez'].includes(cust.registration) && !cust.gstin) P(`${cust.name} has no GSTIN — enter it, or mark the customer unregistered.`, FIX.customer(cust.id));
    if (!pos) P(`${cust.name}'s state is not known — set it on the customer or the ship-to address.`, FIX.customer(cust.id));
  }
  if (!rows.length) P('The invoice has no lines — every shipment on it was removed.');
  for (const l of res.lines) {
    const where = l.sourceDefinitionId ? FIX.definition(l.sourceDefinitionId) : FIX.item(l.itemId);
    if (l.rate == null) P(`Line ${l.lineNo} (${l.description}) has no rate.`, FIX.order(inv.order_id));
    else if (l.taxable == null) P(`Line ${l.lineNo} (${l.description}): ${l.amountNote ?? 'its amount cannot be worked out.'}`, FIX.order(inv.order_id));
    if (!l.hsnCode) P(`${l.description} has no HSN code.`, where);
    if (l.gstRate == null) P(`${l.description} has no GST rate.`, where);
  }
  // Two lines of the same item give the same problem twice — say it once.
  const seen = new Set();
  const unique = problems.filter((p) => (seen.has(p.message) ? false : seen.add(p.message)));

  return {
    supplier, buyer, shipTo, pos, isIgst: supply?.isIgst ?? null, supplyType: supply?.supplyType ?? null,
    lutNumber: supply?.zeroRated ? company.lutNumber : null, taxNote: supply?.note ?? null,
    lines: res.lines, totals: res.totals, problems: unique, einvoiceRequired: company.einvoiceRequired,
  };
}

function frozenView(inv, rows) {
  const lines = rows.map((r) => ({
    row: r,
    id: r.id, slNo: r.line_no, orderLineId: r.order_line_id, lineNo: r.order_line_no, movementId: r.movement_id, movementCode: r.movement_code,
    description: r.description, hsnCode: r.hsn_code, isService: !!Number(r.is_service ?? 0),
    quantity: Number(r.quantity), uom: r.uom, billedQty: num(r.billed_qty), billedUom: r.billed_uom,
    rate: num(r.rate), rateBasis: r.rate_basis, taxable: num(r.taxable), gstRate: num(r.gst_rate),
    cgst: num(r.cgst), sgst: num(r.sgst), igst: num(r.igst),
    taxTotal: round2(Number(r.cgst ?? 0) + Number(r.sgst ?? 0) + Number(r.igst ?? 0)),
    total: round2(Number(r.taxable ?? 0) + Number(r.cgst ?? 0) + Number(r.sgst ?? 0) + Number(r.igst ?? 0)),
  }));
  const tax = round2(Number(inv.cgst_total) + Number(inv.sgst_total) + Number(inv.igst_total));
  const pos = inv.place_of_supply;
  return {
    supplier: json(inv.supplier), buyer: json(inv.buyer), shipTo: json(inv.ship_to), pos, isIgst: inv.is_igst == null ? null : !!Number(inv.is_igst),
    supplyType: inv.supply_type, lutNumber: inv.lut_number, taxNote: inv.lut_number ? LUT_NOTE : null,
    lines,
    totals: {
      taxable: num(inv.taxable_total), cgst: num(inv.cgst_total), sgst: num(inv.sgst_total), igst: num(inv.igst_total), tax,
      beforeRounding: round2(Number(inv.taxable_total) + tax), roundOff: num(inv.round_off), grandTotal: num(inv.grand_total),
    },
    problems: [],
  };
}

function summaryOf(inv, view) {
  return {
    id: inv.id,
    invoiceNo: inv.invoice_no,
    status: inv.status,
    invoiceDate: dateOnly(inv.invoice_date),
    dispatchDate: dateOnly(inv.dispatch_date),
    order: { id: inv.order_id, code: inv.order_code },
    customer: inv.customer_id ? { id: inv.customer_id, name: inv.customer_name, code: inv.customer_code } : null,
    taxable: view.totals.taxable,
    tax: view.totals.tax,
    grandTotal: view.totals.grandTotal,
    irn: !!inv.irn,
    ewayBills: Number(inv.eway_count ?? 0),
  };
}

function shapeLine({ row, itemId, sourceDefinitionId, amountNote, ...l }) {
  return {
    ...l,
    billedQty: l.billedQty == null ? null : r3(l.billedQty),
    amountNote: amountNote ?? null,
  };
}

function shapeInvoice(inv, view, extra = {}) {
  const pos = view.pos;
  return {
    ...summaryOf(inv, view),
    fy: inv.fy,
    supplier: view.supplier,
    buyer: view.buyer,
    shipTo: view.shipTo,
    placeOfSupply: pos ? { code: pos, name: stateName(pos) } : null,
    isIgst: view.isIgst,
    supplyType: view.supplyType,
    lutNumber: view.lutNumber,
    taxNote: view.taxNote,
    reverseCharge: !!Number(inv.reverse_charge ?? 0),
    currency: inv.currency ?? CURRENCY,
    lines: view.lines.map(shapeLine),
    totals: {
      taxable: view.totals.taxable, cgst: view.totals.cgst, sgst: view.totals.sgst, igst: view.totals.igst,
      tax: view.totals.tax, roundOff: view.totals.roundOff, grandTotal: view.totals.grandTotal,
      inWords: amountInWords(view.totals.grandTotal ?? 0),
    },
    transport: json(inv.transport),
    irn: inv.irn ?? null,
    hasIrn: !!inv.irn,
    ackNo: inv.ack_no ?? null,
    ackDate: inv.ack_date ?? null,
    signedQr: inv.signed_qr ?? null,
    notes: inv.notes ?? null,
    cancelledReason: inv.cancelled_reason ?? null,
    cancelledAt: inv.cancelled_at ?? null,
    issuedAt: inv.issued_at ?? null,
    createdAt: inv.created_at,
    // Why it cannot be issued yet: { text, fix: { label, to } | null } each (plan §5 jump links).
    problems: view.problems.map((p) => ({ text: p.message, fix: p.fix })),
    ...extra,
  };
}

/** GET /invoices/:id — about 8 round trips for a draft, 4 for an issued invoice. */
export async function getInvoice(db, companyId, id) {
  const [[inv]] = await db.query(`${INVOICE_SELECT} WHERE inv.company_id = ? AND inv.id = ? AND inv.deleted_at IS NULL`, [companyId, Number(id)]);
  if (!inv) throw notFound('Invoice');
  const [views, [ewb], uninvoiced] = await Promise.all([
    buildViews(db, companyId, [inv]),
    db.query('SELECT id, eway_no, vehicle_no, valid_until, created_at FROM cf_eway_bills WHERE company_id = ? AND invoice_id = ? AND deleted_at IS NULL ORDER BY id', [companyId, inv.id]),
    inv.status === 'draft' ? uninvoicedShipments(db, companyId, inv.order_id) : null,
  ]);
  return shapeInvoice(inv, views.get(inv.id), {
    ewayBills: ewb.map((e) => ({ id: e.id, ewayNo: e.eway_no, vehicleNo: e.vehicle_no, validUntil: e.valid_until, createdAt: e.created_at })),
    ...(uninvoiced ? { uninvoicedShipments: uninvoiced.map(({ itemId, ...s }) => s) } : {}),
  });
}

const INVOICE_SORT = {
  no: 'inv.invoice_no', date: 'inv.invoice_date', customer: 'p.name', order: 'o.code', status: 'inv.status',
  irn: "(COALESCE(inv.irn, '') <> '')",
  eway: '(SELECT COUNT(*) FROM cf_eway_bills e WHERE e.company_id = inv.company_id AND e.invoice_id = inv.id AND e.deleted_at IS NULL)',
};
const INVOICE_STATUSES = ['draft', 'issued', 'cancelled'];

/**
 * GET /invoices?status=&orderId=&customerId=&q= → { rows } — newest first, at most 500 (default 200).
 * paged=1 / all=1 → { rows, total, counts: { status, all, issuedNoIrn } } — counts over every filter but the
 * status chip, so each chip and stat figure is true of every invoice, not of the loaded page.
 */
export async function listInvoices(db, companyId, q = {}, { unbounded = false } = {}) {
  const base = ['inv.company_id = ?', 'inv.deleted_at IS NULL'];
  const args = [companyId];
  if (!blank(q.orderId)) { base.push('inv.order_id = ?'); args.push(Number(q.orderId)); }
  if (!blank(q.customerId)) { base.push('inv.customer_id = ?'); args.push(Number(q.customerId)); }
  const like = likeOf(q.q ?? q.search);
  if (like) {
    base.push('(inv.invoice_no LIKE ? OR o.code LIKE ? OR p.name LIKE ?)');
    args.push(like, like, like);
  }
  const where = [...base];
  const rowArgs = [...args];
  if (!blank(q.status) && q.status !== 'all') { where.push('inv.status = ?'); rowArgs.push(String(q.status)); }
  const paged = wantsPage(q);
  const page = paged ? pageArgs(q, { def: 100 }) : { limit: unbounded ? EXPORT_MAX : Math.min(Math.max(Number(q.limit) || 200, 1), 500), offset: 0 };
  const from = 'FROM cf_invoices inv JOIN cf_sales_orders o ON o.id = inv.order_id LEFT JOIN cf_parties p ON p.id = inv.customer_id';
  const [[rows], counted] = await Promise.all([
    db.query(`${INVOICE_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${orderBy(q, INVOICE_SORT, 'inv.id DESC', 'inv.id')} LIMIT ? OFFSET ?`, [...rowArgs, page.limit, page.offset]),
    paged ? Promise.all([
      db.query(`SELECT COUNT(*) AS n ${from} WHERE ${where.join(' AND ')}`, rowArgs),
      db.query(
        `SELECT inv.status AS k, COUNT(*) AS n, SUM(inv.status = 'issued' AND COALESCE(inv.irn, '') = '') AS no_irn
           ${from} WHERE ${base.join(' AND ')} GROUP BY inv.status`,
        args,
      ),
    ]) : null,
  ]);
  const views = await buildViews(db, companyId, rows);
  const shaped = rows.map((inv) => summaryOf(inv, views.get(inv.id)));
  if (!paged) return { rows: shaped };
  const [[[{ n: total }]], [byStatus]] = counted;
  const status = countsBy(byStatus, INVOICE_STATUSES);
  const all = Object.values(status).reduce((t, n) => t + n, 0);
  const issuedNoIrn = byStatus.reduce((t, r) => t + Number(r.no_irn || 0), 0);
  return pageOf(shaped, total, page, { counts: { status, all, issuedNoIrn } });
}

// --- editing a draft -------------------------------------------------------------

function readDate(v, label, problems) {
  if (blank(v)) return null;
  const s = String(v).trim().slice(0, 10);
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) { problems.push(`${label} needs YYYY-MM-DD.`); return null; }
  return s;
}

/** Transport details { mode, vehicleNo, transporter, transporterGstin, distanceKm, lrNo, lrDate } — null clears. */
export function readTransport(v, problems) {
  if (v == null) return null;
  if (typeof v !== 'object') { problems.push('Transport is a set of details.'); return null; }
  const out = {};
  if (!blank(v.mode)) {
    const m = String(v.mode).toLowerCase();
    if (!TRANSPORT_MODES[m]) problems.push('Transport mode is road, rail, air or ship.');
    else out.mode = m;
  }
  if (!blank(v.vehicleNo)) {
    const s = String(v.vehicleNo).replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z0-9]{4,15}$/.test(s)) problems.push('Vehicle number: letters and digits, like MH12AB1234.');
    else out.vehicleNo = s;
  }
  if (!blank(v.transporter)) out.transporter = String(v.transporter).trim().slice(0, 100);
  if (!blank(v.transporterGstin)) {
    const s = String(v.transporterGstin).replace(/\s+/g, '').toUpperCase();
    // A transporter's id is its GSTIN or a 15-character TRANSIN; check the GSTIN only when it looks like one.
    if (!/^[0-9A-Z]{15}$/.test(s)) problems.push('Transporter id is 15 characters (GSTIN or TRANSIN).');
    else if (/^\d{2}[A-Z]{5}\d{4}/.test(s) && !validateGstin(s).valid) problems.push(`Transporter GSTIN: ${validateGstin(s).message}`);
    else out.transporterGstin = s;
  }
  if (!blank(v.distanceKm)) {
    const d = Number(v.distanceKm);
    if (!Number.isInteger(d) || d < 0 || d > 4000) problems.push('Distance is whole kilometres, 0 to 4000.');
    else out.distanceKm = d;
  }
  if (!blank(v.lrNo)) out.lrNo = String(v.lrNo).trim().slice(0, 15);
  if (!blank(v.lrDate)) { const d = readDate(v.lrDate, 'LR date', problems); if (d) out.lrDate = d; }
  return Object.keys(out).length ? out : null;
}

function readShipTo(v, problems) {
  if (v == null) return null;
  if (typeof v !== 'object') { problems.push('Ship-to is an address.'); return null; }
  const out = {
    name: blank(v.name) ? null : String(v.name).trim().slice(0, 255),
    address: blank(v.address) ? null : String(v.address).trim(),
    city: blank(v.city) ? null : String(v.city).trim().slice(0, 100),
    pincode: blank(v.pincode) ? null : String(v.pincode).replace(/\s+/g, ''),
    stateCode: null,
    gstin: null,
  };
  if (!out.address) problems.push('Ship-to needs its address.');
  if (out.pincode && !PIN_RE.test(out.pincode)) problems.push('A PIN code is 6 digits.');
  const st = readStateCode(v.stateCode);
  if (st === undefined) problems.push(`${v.stateCode} is not a GST state code.`);
  else out.stateCode = st;
  if (!blank(v.gstin)) {
    const g = validateGstin(v.gstin);
    if (!g.valid) problems.push(`Ship-to GSTIN: ${g.message}`);
    else { out.gstin = g.gstin; out.stateCode = g.stateCode; }
  }
  if (!out.stateCode) problems.push('Ship-to needs its state — it decides the place of supply.');
  return out;
}

/**
 * PUT /invoices/:id { invoiceDate, shipToAddressId | shipTo, transport, notes }.
 * A draft takes all of them. An ISSUED invoice takes transport only — the truck
 * is logistics, not the tax document, and a vehicle can change after issue.
 */
export async function updateInvoice(db, c, id, input = {}) {
  const inv = await lockInvoice(db, c.companyId, id);
  const problems = [];
  const sets = {};
  if (inv.status !== 'draft') {
    const others = Object.keys(input).filter((k) => k !== 'transport' && input[k] !== undefined);
    if (inv.status === 'cancelled' || others.length) assertDraft(inv);
  }
  if (input.invoiceDate !== undefined) {
    const d = readDate(input.invoiceDate, 'Invoice date', problems);
    if (d && d > todayText()) problems.push('An invoice cannot be dated in the future.');
    sets.invoice_date = d;
  }
  if (input.shipToAddressId !== undefined && !blank(input.shipToAddressId)) {
    const [[a]] = await db.query('SELECT id, party_id FROM cf_party_addresses WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, Number(input.shipToAddressId)]);
    if (!a || a.party_id !== inv.customer_id) problems.push('That address is not one of the customer\'s addresses.');
    else { sets.ship_to_address_id = a.id; sets.ship_to = null; }
  } else if (input.shipTo !== undefined) {
    const s = readShipTo(input.shipTo, problems);
    sets.ship_to = s ? JSON.stringify(s) : null;
    sets.ship_to_address_id = null;
  } else if (input.shipToAddressId !== undefined) {
    sets.ship_to_address_id = null;   // blank address id: back to the customer's own address
  }
  if (input.transport !== undefined) { const t = readTransport(input.transport, problems); sets.transport = t ? JSON.stringify(t) : null; }
  if (input.notes !== undefined) sets.notes = blank(input.notes) ? null : String(input.notes).slice(0, 2000);
  assertNoProblems(problems, 'The invoice needs attention.');
  if (Object.keys(sets).length) {
    await db.query(`UPDATE cf_invoices SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(sets), c.companyId, inv.id]);
  }
  return getInvoice(db, c.companyId, inv.id);
}

/** DELETE /invoices/:id/lines/:lineId — the shipment becomes un-invoiced again. */
export async function removeInvoiceLine(db, c, id, lineId) {
  const inv = await lockInvoice(db, c.companyId, id);
  assertDraft(inv);
  const [r] = await db.query(
    'UPDATE cf_invoice_lines SET claim = NULL, deleted_at = NOW() WHERE company_id = ? AND invoice_id = ? AND id = ? AND deleted_at IS NULL',
    [c.companyId, inv.id, Number(lineId)],
  );
  if (!r.affectedRows) throw notFound('Invoice line');
  return getInvoice(db, c.companyId, inv.id);
}

/** DELETE /invoices/:id — drafts only; their shipments become un-invoiced. */
export async function deleteInvoice(db, c, id) {
  const inv = await lockInvoice(db, c.companyId, id);
  assertDraft(inv, 'deleted');
  await db.query('UPDATE cf_invoice_lines SET claim = NULL, deleted_at = NOW() WHERE company_id = ? AND invoice_id = ? AND deleted_at IS NULL', [c.companyId, inv.id]);
  await db.query('UPDATE cf_invoices SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, inv.id]);
  return { ok: true };
}

// --- issue and cancel ------------------------------------------------------------

/**
 * POST /invoices/:id/issue — checks, numbers (gap-free, this transaction) and
 * freezes. Refused with every problem at once (problems + problemDetails).
 */
export async function issueInvoice(db, c, id) {
  const inv = await lockInvoice(db, c.companyId, id);
  assertDraft(inv, 'issued twice');
  const [[full]] = await db.query(`${INVOICE_SELECT} WHERE inv.company_id = ? AND inv.id = ?`, [c.companyId, inv.id]);
  const view = (await buildViews(db, c.companyId, [full])).get(inv.id);
  const date = dateOnly(inv.invoice_date) ?? todayText();
  const problems = [...view.problems];
  if (date > todayText()) problems.push({ message: 'An invoice cannot be dated in the future.', fix: null });
  if (problems.length) {
    throw invalid('CANNOT_ISSUE', `The invoice cannot be issued yet — ${problems.length === 1 ? 'one thing' : `${problems.length} things`} to fix.`,
      // fail() passes `problems` and `detail` through: detail carries each problem with its fix link.
      { problems: problems.map((p) => p.message), detail: problems.map((p) => ({ text: p.message, fix: p.fix })) });
  }

  // The number: the year's series row, held FOR UPDATE until this transaction ends.
  const fy = financialYear(date);
  const company = await companyTax(db, c.companyId);
  await db.query(
    'INSERT INTO cf_invoice_series (company_id, fy, prefix, next_no) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE next_no = next_no',
    [c.companyId, fy, company.invoicePrefix],
  );
  const [[series]] = await db.query('SELECT prefix, next_no FROM cf_invoice_series WHERE company_id = ? AND fy = ? FOR UPDATE', [c.companyId, fy]);
  const invoiceNo = invoiceNumber(series.prefix, fy, series.next_no);
  await db.query('UPDATE cf_invoice_series SET next_no = next_no + 1 WHERE company_id = ? AND fy = ?', [c.companyId, fy]);

  // Freeze: the parties as they are now, and every line's money.
  const shipTo = view.shipTo ?? (view.buyer ? {
    addressId: null, label: null, name: view.buyer.name, address: view.buyer.address, city: view.buyer.city, pincode: view.buyer.pincode,
    stateCode: view.buyer.stateCode, stateName: view.buyer.stateName, gstin: view.buyer.gstin, sameAsBuyer: true,
  } : null);
  const t = view.totals;
  await db.query(
    `UPDATE cf_invoices SET status = 'issued', invoice_no = ?, invoice_date = ?, fy = ?, supplier = ?, buyer = ?, ship_to = ?,
            place_of_supply = ?, is_igst = ?, supply_type = ?, lut_number = ?, taxable_total = ?, cgst_total = ?, sgst_total = ?,
            igst_total = ?, round_off = ?, grand_total = ?, issued_at = NOW(), issued_by = ?
      WHERE company_id = ? AND id = ?`,
    [invoiceNo, date, fy, JSON.stringify(view.supplier), JSON.stringify(view.buyer), shipTo ? JSON.stringify(shipTo) : null,
      view.pos, view.isIgst ? 1 : 0, view.supplyType, view.lutNumber, t.taxable, t.cgst, t.sgst, t.igst, t.roundOff, t.grandTotal,
      c.userId ?? null, c.companyId, inv.id],
  );
  // Every line in one statement per 200 (upsert on the primary key — the rows exist).
  const cols = ['id', 'company_id', 'invoice_id', 'line_no', 'order_line_id', 'movement_id', 'quantity', 'description', 'hsn_code', 'is_service',
    'uom', 'billed_qty', 'billed_uom', 'rate', 'rate_basis', 'taxable', 'gst_rate', 'cgst', 'sgst', 'igst'];
  const frozen = view.lines.map((l) => [l.id, c.companyId, inv.id, l.slNo, l.orderLineId, l.movementId, l.quantity, String(l.description ?? '').slice(0, 500),
    l.hsnCode, l.isService ? 1 : 0, l.uom, l.billedQty, l.billedUom, l.rate, l.rateBasis, l.taxable, l.gstRate, l.cgst, l.sgst, l.igst]);
  for (let i = 0; i < frozen.length; i += 200) {
    const part = frozen.slice(i, i + 200);
    await db.query(
      `INSERT INTO cf_invoice_lines (${cols.join(', ')}) VALUES ${part.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')}
       ON DUPLICATE KEY UPDATE ${cols.slice(6).map((k) => `${k} = VALUES(${k})`).join(', ')}`,
      part.flat(),
    );
  }
  return getInvoice(db, c.companyId, inv.id);
}

/** POST /invoices/:id/cancel { reason } — keeps the number; frees the shipments. */
export async function cancelInvoice(db, c, id, input = {}) {
  const inv = await lockInvoice(db, c.companyId, id);
  if (inv.status === 'draft') throw invalid('DRAFT', 'A draft has no number yet — delete it instead of cancelling.');
  if (inv.status === 'cancelled') throw conflict('CANCELLED', `Invoice ${inv.invoice_no} is already cancelled.`);
  if (blank(input.reason)) throw invalid('INVALID', 'Say why the invoice is cancelled.', { problems: ['Say why the invoice is cancelled.'] });
  await db.query(
    "UPDATE cf_invoices SET status = 'cancelled', cancelled_reason = ?, cancelled_at = NOW(), cancelled_by = ? WHERE company_id = ? AND id = ?",
    [String(input.reason).trim().slice(0, 255), c.userId ?? null, c.companyId, inv.id],
  );
  await db.query('UPDATE cf_invoice_lines SET claim = NULL WHERE company_id = ? AND invoice_id = ?', [c.companyId, inv.id]);
  return getInvoice(db, c.companyId, inv.id);
}

// --- what the portals hand back ----------------------------------------------------

function assertIssued(inv, what) {
  if (inv.status !== 'issued') throw invalid('NOT_ISSUED', inv.status === 'draft' ? `Issue the invoice first — ${what} belongs to an issued invoice.` : `Invoice ${inv.invoice_no} is cancelled.`);
}

/** PUT /invoices/:id/irn { irn, ackNo, ackDate, signedQr } — typed back from the IRP. All blank clears. */
export async function setIrn(db, c, id, input = {}) {
  const inv = await lockInvoice(db, c.companyId, id);
  assertIssued(inv, 'an IRN');
  const problems = [];
  const irn = blank(input.irn) ? null : String(input.irn).trim().toLowerCase();
  if (irn && !/^[0-9a-f]{64}$/.test(irn)) problems.push('An IRN is 64 characters (0-9, a-f).');
  const ackNo = blank(input.ackNo) ? null : String(input.ackNo).trim();
  if (ackNo && !/^\d{1,20}$/.test(ackNo)) problems.push('An Ack no is up to 20 digits.');
  let ackDate = null;
  if (!blank(input.ackDate)) {
    const s = String(input.ackDate).trim().replace('T', ' ').slice(0, 19);
    if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(s) || Number.isNaN(Date.parse(s.replace(' ', 'T')))) problems.push('Ack date needs YYYY-MM-DD HH:MM.');
    else ackDate = s;
  }
  const signedQr = blank(input.signedQr) ? null : String(input.signedQr).trim();
  if (irn && (!ackNo || !ackDate)) problems.push('Enter the Ack no and Ack date with the IRN.');
  assertNoProblems(problems, 'The IRN details need attention.');
  await db.query('UPDATE cf_invoices SET irn = ?, ack_no = ?, ack_date = ?, signed_qr = ? WHERE company_id = ? AND id = ?',
    [irn, ackNo, ackDate, signedQr, c.companyId, inv.id]);
  return getInvoice(db, c.companyId, inv.id);
}

/** POST /invoices/:id/eway-bills { ewayNo, vehicleNo, validUntil } */
export async function addEwayBill(db, c, id, input = {}) {
  const inv = await lockInvoice(db, c.companyId, id);
  assertIssued(inv, 'an e-way bill');
  const problems = [];
  const ewayNo = String(input.ewayNo ?? '').replace(/\s+/g, '');
  if (!/^\d{12}$/.test(ewayNo)) problems.push('An e-way bill number is 12 digits.');
  const vehicleNo = blank(input.vehicleNo) ? null : String(input.vehicleNo).replace(/[\s-]/g, '').toUpperCase();
  if (vehicleNo && !/^[A-Z0-9]{4,15}$/.test(vehicleNo)) problems.push('Vehicle number: letters and digits, like MH12AB1234.');
  let validUntil = null;
  if (!blank(input.validUntil)) {
    const s = String(input.validUntil).trim().replace('T', ' ').slice(0, 19);
    if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(s)) problems.push('Valid until needs YYYY-MM-DD HH:MM.');
    else validUntil = s;
  }
  assertNoProblems(problems, 'The e-way bill needs attention.');
  await db.query('INSERT INTO cf_eway_bills (company_id, invoice_id, eway_no, vehicle_no, valid_until, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [c.companyId, inv.id, ewayNo, vehicleNo, validUntil, c.userId ?? null]);
  return getInvoice(db, c.companyId, inv.id);
}

/** DELETE /invoices/:id/eway-bills/:ewbId */
export async function removeEwayBill(db, c, id, ewbId) {
  const inv = await lockInvoice(db, c.companyId, id);
  const [r] = await db.query('UPDATE cf_eway_bills SET deleted_at = NOW() WHERE company_id = ? AND invoice_id = ? AND id = ? AND deleted_at IS NULL',
    [c.companyId, inv.id, Number(ewbId)]);
  if (!r.affectedRows) throw notFound('E-way bill');
  return getInvoice(db, c.companyId, inv.id);
}
