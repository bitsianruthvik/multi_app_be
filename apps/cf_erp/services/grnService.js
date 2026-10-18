/**
 * grnService.js — a GRN that captures the MONEY (init.sql §80; contract TM/CF_ERP_ORDER_FLOW_PLAN.md
 * "2026-10-18 — GRN money capture").
 *
 * `receiveGrn` books one or more lines of ONE purchase order as a GRN with the supplier's bill behind it:
 *   per line   unit price (the PO line's by default), MRP, discount (% or amount), HSN/SAC (the item's by default),
 *              GST rate (the item's by default) → taxable value and the split CGST + SGST / IGST;
 *   per GRN    the supplier invoice number + date (or "invoice to follow" — flagged), freight and other charges
 *              (taxable or not), the total.
 * WHICH TAX: the supplier's state_code against the company's GST state (taxService.supplyOf, direction 'in'). If the
 * company's GST state is not set (or the supplier's), the screen asks for one (`companyStateCode` / `supplierStateCode`)
 * and says so; the state used is stored on the bill. An unregistered / composition supplier charges no GST.
 * LANDED COST: grnMoney.computeGrnMoney — taxable value + the share of freight/other charges (by taxable value); the GST
 * input credit is not in it. That per-unit figure is posted as the receipt's unit cost, so the stock ledger, the
 * average cost (cf_item_costs), batch costs and every cost sheet carry it with no further change.
 * Each PO line still posts its own stock receipt (purchaseService.receiveLine); the bill ties them together.
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { round2 } from './priceService.js';
import { receiveLine } from './purchaseService.js';
import { companyTax, itemTaxOf, partyTaxOf, supplyOf, readHsn, readGstRate } from './taxService.js';
import { computeGrnMoney } from './grnMoney.js';
import { isStateCode } from '../modules/parties/gstin.js';

const EPS = 1e-6;
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INVOICE_NO_MAX = 40;
const numOrNull = (v) => (v == null ? null : Number(v));

const readDate = (v, label, problems) => {
  if (blank(v)) return null;
  const s = String(v).trim();
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) { problems.push(`${label} needs YYYY-MM-DD.`); return null; }
  return s;
};
const readMoney = (v, label, problems, { required = false } = {}) => {
  if (blank(v)) { if (required) problems.push(`${label} is required.`); return null; }
  const n = Number(typeof v === 'string' ? v.replace(/,/g, '').trim() : v);
  if (!Number.isFinite(n) || n < 0) { problems.push(`${label} is a number, zero or more.`); return null; }
  return n;
};

/** The words for what decided the tax split, for the screen. */
export const SUPPLY_TEXT = {
  intra: 'Same state as the company — CGST + SGST.',
  inter: 'Another state — IGST.',
  none: 'The supplier charges no GST.',
};

async function loadPo(db, companyId, poId) {
  const [[po]] = await db.query(
    'SELECT id, code, supplier_id, status, reverse_charge, supplied_by_customer, approval_status, closed_at FROM cf_purchase_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL',
    [companyId, Number(poId)],
  );
  if (!po) throw notFound('Purchase order');
  return po;
}

/**
 * What the GRN screen needs before it is filled: the company's GST state (is it set?), the supplier's, how a bill from
 * this supplier is taxed (or why that cannot be said yet), the allowed rates, the items' HSN / rate.
 * GET /purchase-orders/:id/grn-context
 */
export async function grnContext(db, companyId, poId, { lineIds = null } = {}) {
  const po = await loadPo(db, companyId, poId);
  const [company, parties] = await Promise.all([companyTax(db, companyId), partyTaxOf(db, companyId, [po.supplier_id])]);
  const sup = po.supplier_id ? parties.get(Number(po.supplier_id)) ?? null : null;
  const [lines] = await db.query(
    `SELECT l.id, l.item_id, l.quantity, l.qty_received, l.unit_price, l.uom FROM cf_purchase_order_lines l
      WHERE l.company_id = ? AND l.purchase_order_id = ? AND l.deleted_at IS NULL ${lineIds ? 'AND l.id IN (?)' : ''}`,
    lineIds ? [companyId, po.id, lineIds] : [companyId, po.id],
  );
  const items = await itemTaxOf(db, companyId, lines.map((l) => l.item_id));
  const supply = sup ? supplyOf({ supplierState: sup.stateCode, placeOfSupply: company.stateCode, registration: sup.registration, direction: 'in' }) : null;
  return {
    purchaseOrder: { id: po.id, code: po.code, reverseCharge: !!Number(po.reverse_charge ?? 0), suppliedByCustomer: !!Number(po.supplied_by_customer ?? 0) },
    company: { stateCode: company.stateCode, stateName: company.stateName, gstin: company.gstin },
    supplier: sup ? { id: sup.id, name: sup.name, stateCode: sup.stateCode, registration: sup.registration, gstin: sup.gstin } : null,
    gstRates: company.gstRates,
    supply: supply ? { isIgst: supply.isIgst, zeroRated: supply.zeroRated, note: supply.note, problem: supply.problem } : null,
    needsCompanyState: !company.stateCode && !(sup && ['unregistered', 'composition', 'overseas'].includes(sup.registration)),
    needsSupplierState: !!sup && !sup.stateCode && !['unregistered', 'composition', 'overseas'].includes(sup.registration),
    lines: lines.map((l) => ({
      lineId: l.id, itemId: l.item_id, unitPrice: numOrNull(l.unit_price), uom: l.uom,
      hsnCode: items.get(Number(l.item_id))?.hsnCode ?? null, gstRate: items.get(Number(l.item_id))?.gstRate ?? null,
    })),
  };
}

/**
 * POST /purchase-orders/:id/grn
 * { stockingAreaId, movementDate?, reference? (the delivery note), notes?,
 *   invoice: { no?, date?, pending? }, charges?: { freight?: { amount, taxable, gstRate }, other?: {...} },
 *   companyStateCode?, supplierStateCode?, dryRun?,
 *   lines: [{ lineId, quantity?, unitPrice?, mrp?, discountMode? 'pct'|'amt', discountValue?, hsnCode?, gstRate?, batchId?, batch? }] }
 * dryRun answers { preview } and writes nothing.
 */
export async function receiveGrn(db, c, poId, input = {}) {
  const po = await loadPo(db, c.companyId, poId);
  if (Number(po.supplied_by_customer ?? 0)) throw invalid('NO_MONEY', `${po.code} is the customer's own material — there is no supplier bill to capture. Book it as a plain delivery.`);
  const problems = [];
  const rawLines = Array.isArray(input.lines) ? input.lines : [];
  if (!rawLines.length) problems.push('Say which lines of the order arrived.');
  const ids = rawLines.map((x) => Number(x.lineId));
  if (new Set(ids).size !== ids.length) problems.push('A line appears twice.');
  const [poLines] = ids.length
    ? await db.query(
      `SELECT l.*, m.code AS item_code, m.name AS item_name FROM cf_purchase_order_lines l
         JOIN cf_master_records m ON m.id = l.item_id
        WHERE l.company_id = ? AND l.purchase_order_id = ? AND l.id IN (?) AND l.deleted_at IS NULL`,
      [c.companyId, po.id, ids],
    ) : [[]];
  const byId = new Map(poLines.map((l) => [Number(l.id), l]));
  for (const id of ids) if (!byId.has(id)) problems.push(`Line ${id} is not on ${po.code}.`);

  const [company, parties, items] = await Promise.all([
    companyTax(db, c.companyId),
    partyTaxOf(db, c.companyId, [po.supplier_id]),
    itemTaxOf(db, c.companyId, poLines.map((l) => l.item_id)),
  ]);
  const sup = po.supplier_id ? parties.get(Number(po.supplier_id)) ?? null : null;
  if (!sup) problems.push(`${po.code} has no supplier named.`);

  // ---- where the tax is decided ----
  const noGstSupplier = !!sup && ['unregistered', 'composition', 'overseas'].includes(sup.registration);
  let companyState = company.stateCode ?? null;
  let supplierState = sup?.stateCode ?? null;
  let statePicked = false;
  if (!companyState && !blank(input.companyStateCode)) {
    if (!isStateCode(input.companyStateCode)) problems.push('That is not a GST state code.');
    else { companyState = String(input.companyStateCode); statePicked = true; }
  }
  if (!supplierState && !blank(input.supplierStateCode)) {
    if (!isStateCode(input.supplierStateCode)) problems.push('That is not a GST state code.');
    else { supplierState = String(input.supplierStateCode); statePicked = true; }
  }
  const supply = sup ? supplyOf({ supplierState, placeOfSupply: companyState, registration: sup.registration, direction: 'in' }) : null;
  const needsCompanyState = !companyState && !noGstSupplier;
  const needsSupplierState = !!sup && !supplierState && !noGstSupplier && !needsCompanyState;
  if (needsCompanyState) problems.push('The company\'s GST state is not set (Setup › Company tax details) — pick it on this screen so the tax can be split.');
  else if (supply?.problem) problems.push(supply.problem.includes('supplier') ? 'The supplier\'s state is not known — pick it on this screen, or set it on the supplier.' : supply.problem);
  const supplyType = !supply || supply.isIgst == null ? null : supply.zeroRated ? 'none' : supply.isIgst ? 'inter' : 'intra';

  // ---- the supplier's invoice ----
  const inv = input.invoice ?? {};
  const pending = !!inv.pending;
  const invoiceNo = blank(inv.no) ? null : String(inv.no).trim();
  const invoiceDate = readDate(inv.date, 'Invoice date', problems);
  if (invoiceNo && invoiceNo.length > INVOICE_NO_MAX) problems.push(`Invoice number: at most ${INVOICE_NO_MAX} characters.`);
  if (!pending) {
    if (!invoiceNo) problems.push('Enter the supplier invoice number, or tick "Invoice to follow".');
    if (!invoiceDate) problems.push('Enter the supplier invoice date, or tick "Invoice to follow".');
  }

  // ---- the charges ----
  const rates = company.gstRates;
  const chargeIn = (name, raw) => {
    const amount = readMoney(raw?.amount, `${name} amount`, problems) ?? 0;
    const taxable = !!raw?.taxable;
    let gstRate = null;
    if (amount > 0 && taxable && !supply?.zeroRated) {
      if (blank(raw?.gstRate)) problems.push(`${name} is taxable — give its GST rate.`);
      else gstRate = readGstRate(raw.gstRate, rates, problems);
    }
    return { amount, taxable, gstRate };
  };
  const charges = { freight: chargeIn('Freight', input.charges?.freight), other: chargeIn('Other charges', input.charges?.other) };

  // ---- the lines ----
  const warnings = [];
  const lines = [];
  for (const raw of rawLines) {
    const l = byId.get(Number(raw.lineId));
    if (!l) continue;
    const label = l.item_code ?? l.item_name;
    const left = Math.max(0, Number(l.quantity) - Number(l.qty_received));
    const quantity = readMoney(raw.quantity ?? left, `${label}: quantity`, problems, { required: true });
    if (quantity != null && quantity <= 0) problems.push(`${label}: quantity is above zero.`);
    if (quantity != null && quantity > left + EPS) problems.push(`${label}: only ${Number(left.toFixed(3))} ${l.uom} is still outstanding.`);
    const unitPrice = readMoney(raw.unitPrice ?? l.unit_price, `${label}: unit price`, problems, { required: true });
    const mrp = readMoney(raw.mrp, `${label}: MRP`, problems);
    let discountMode = null;
    let discountValue = null;
    if (!blank(raw.discountValue) && Number(raw.discountValue) !== 0) {
      discountMode = raw.discountMode === 'amt' ? 'amt' : raw.discountMode === 'pct' ? 'pct' : null;
      if (!discountMode) problems.push(`${label}: say whether the discount is a percentage or an amount.`);
      discountValue = readMoney(raw.discountValue, `${label}: discount`, problems);
      if (discountMode === 'pct' && discountValue != null && discountValue > 100) problems.push(`${label}: a discount cannot be more than 100%.`);
      if (discountMode === 'amt' && discountValue != null && unitPrice != null && quantity != null && discountValue > unitPrice * quantity + 0.005) problems.push(`${label}: the discount is more than the line.`);
    }
    const it = items.get(Number(l.item_id)) ?? {};
    const hsnRaw = blank(raw.hsnCode) ? (it.hsnCode ?? null) : raw.hsnCode;
    const hsnCode = readHsn(hsnRaw, !!it.isService, problems);
    const rateRaw = blank(raw.gstRate) ? it.gstRate ?? null : raw.gstRate;
    let gstRate = null;
    if (supply?.zeroRated) gstRate = blank(rateRaw) ? 0 : readGstRate(rateRaw, rates, problems);
    else if (blank(rateRaw)) problems.push(`${label}: the GST rate is required.`);
    else gstRate = readGstRate(rateRaw, rates, problems);
    if (mrp != null && unitPrice != null && unitPrice > mrp + 0.005) warnings.push(`${label}: the price ${unitPrice} is above the MRP ${mrp}.`);
    lines.push({
      lineId: Number(l.id), po: l, quantity, unitPrice, mrp, discountMode, discountValue, hsnCode, gstRate,
      batchId: raw.batchId, batch: raw.batch,
    });
  }
  assertNoProblems(problems, 'The GRN cannot be booked.');

  const reverseCharge = !!Number(po.reverse_charge ?? 0);
  const money = computeGrnMoney({ lines, charges, supply, reverseCharge });
  if (invoiceNo && po.supplier_id) {
    const [dup] = await db.query(
      'SELECT id, purchase_order_id FROM cf_grn_bills WHERE company_id = ? AND supplier_id = ? AND LOWER(invoice_no) = LOWER(?) AND deleted_at IS NULL LIMIT 3',
      [c.companyId, po.supplier_id, invoiceNo],
    );
    if (dup.length) warnings.push(`Invoice ${invoiceNo} of this supplier is already on ${dup.length === 1 ? 'another GRN' : `${dup.length} other GRNs`} — check it is not entered twice.`);
  }
  const header = {
    companyState, supplierState, supplyType, statePicked, reverseCharge, needs: { companyState: needsCompanyState, supplierState: needsSupplierState },
    supplyText: supplyType ? SUPPLY_TEXT[supplyType] : null,
    invoice: { no: invoiceNo, date: invoiceDate, pending },
  };
  if (input.dryRun) return { dryRun: true, ...header, money, warnings };

  // ---- book the stock, one receipt per line, each at its LANDED unit cost ----
  const movements = [];
  const held = [];
  let order = null;
  for (let i = 0; i < lines.length; i += 1) {
    const L = lines[i];
    const m = money.lines[i];
    const r = await receiveLine(db, c, L.lineId, {
      quantity: L.quantity, stockingAreaId: input.stockingAreaId, movementDate: input.movementDate,
      reference: blank(input.reference) ? invoiceNo : input.reference, notes: input.notes,
      unitCost: m.landedUnitCost, batchId: L.batchId, batch: L.batch,
    });
    movements.push(r.movement);
    held.push(...(r.held ?? []));
    order = r.order;
  }

  const bill = await insertBill(db, c, {
    po, grnDate: movements[0]?.movementDate ?? input.movementDate ?? new Date().toISOString().slice(0, 10), invoiceNo, invoiceDate, pending, moneyCaptured: 1,
    header, charges: money.charges, totals: money.totals, notes: input.notes,
    lines: lines.map((L, i) => ({ L, m: money.lines[i], movementId: movements[i]?.id ?? null })),
  });
  return { bill: await getBill(db, c.companyId, bill), movements, held, order, warnings, money };
}

async function insertBill(db, c, { po, grnDate, invoiceNo, invoiceDate, pending, moneyCaptured, header, charges, totals, notes, lines }) {
  const [res] = await db.query(
    `INSERT INTO cf_grn_bills (company_id, purchase_order_id, supplier_id, grn_date, invoice_no, invoice_date, invoice_pending, money_captured,
        company_state, supplier_state, supply_type, state_picked, reverse_charge,
        freight_amount, freight_taxable, freight_gst_rate, freight_tax, other_amount, other_taxable, other_gst_rate, other_tax,
        taxable_total, charges_total, cgst, sgst, igst, total, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, po.id, po.supplier_id ?? null, grnDate, invoiceNo, invoiceDate, pending ? 1 : 0, moneyCaptured,
      header.companyState ?? null, header.supplierState ?? null, header.supplyType ?? null, header.statePicked ? 1 : 0, header.reverseCharge ? 1 : 0,
      charges.freight.amount, charges.freight.taxable ? 1 : 0, charges.freight.gstRate, charges.freight.tax,
      charges.other.amount, charges.other.taxable ? 1 : 0, charges.other.gstRate, charges.other.tax,
      totals.taxable, totals.charges, totals.cgst, totals.sgst, totals.igst, totals.total, notes ?? null, c.userId ?? null],
  );
  const billId = res.insertId;
  if (lines.length) {
    await db.query(
      `INSERT INTO cf_grn_bill_lines (company_id, bill_id, line_no, purchase_line_id, movement_id, item_id, quantity, uom, unit_price, mrp,
          discount_mode, discount_value, discount_amount, gross_amount, taxable_value, hsn_code, gst_rate, cgst, sgst, igst, line_total,
          freight_alloc, landed_value, landed_unit_cost) VALUES ?`,
      [lines.map(({ L, m, movementId }, i) => [c.companyId, billId, i + 1, L.lineId, movementId, L.po.item_id, m.quantity, L.po.uom ?? null, m.unitPrice ?? null, m.mrp ?? null,
        m.discountMode ?? null, m.discountValue ?? null, m.discountAmount, m.gross, m.taxable, m.hsnCode ?? null, m.gstRate ?? null, m.cgst, m.sgst, m.igst, m.lineTotal,
        m.freightAlloc, m.landedValue, m.landedUnitCost])],
    );
  }
  return billId;
}

/**
 * A receipt booked through the old call (POST /purchase-lines/:id/receive with no money) still leaves a bill row, so
 * Accounts sees it: money_captured = 0, invoice to follow, the unit cost it was booked at. Never throws.
 */
export async function noteLegacyReceipt(db, c, lineId, result) {
  try {
    const [[l]] = await db.query('SELECT l.*, p.supplier_id, p.supplied_by_customer FROM cf_purchase_order_lines l JOIN cf_purchase_orders p ON p.id = l.purchase_order_id WHERE l.company_id = ? AND l.id = ?', [c.companyId, lineId]);
    const mv = result?.movement;
    if (!l || !mv || Number(l.supplied_by_customer ?? 0)) return null;   // the customer's own material has no supplier bill
    const led = (mv.lines ?? [])[0];
    const unit = led?.unitCost ?? null;
    const qty = Number(led?.quantity ?? 0) || Number((mv.lines ?? []).reduce((t, x) => t + Number(x.quantity ?? 0), 0));
    const taxable = unit == null ? 0 : round2(unit * qty);
    const zero = { amount: 0, taxable: false, gstRate: null, cgst: 0, sgst: 0, igst: 0, tax: 0 };
    const id = await insertBill(db, c, {
      po: { id: l.purchase_order_id, supplier_id: l.supplier_id }, grnDate: mv.movementDate ?? new Date().toISOString().slice(0, 10), invoiceNo: null, invoiceDate: null, pending: true, moneyCaptured: 0,
      header: { companyState: null, supplierState: null, supplyType: null, statePicked: false, reverseCharge: false },
      charges: { freight: zero, other: zero }, totals: { taxable, charges: 0, cgst: 0, sgst: 0, igst: 0, total: taxable }, notes: null,
      lines: [{
        L: { lineId: l.id, po: l },
        m: { quantity: qty, unitPrice: unit, mrp: null, discountMode: null, discountValue: null, discountAmount: 0, gross: taxable, taxable, hsnCode: null, gstRate: null, cgst: 0, sgst: 0, igst: 0, lineTotal: taxable, freightAlloc: 0, landedValue: taxable, landedUnitCost: unit },
        movementId: mv.id,
      }],
    });
    return id;
  } catch { return null; }
}

// ---- reads (Accounts' supplier bills) ------------------------------------------------------------------

const BILL_COLS = `b.id, b.purchase_order_id, p.code AS po_code, b.supplier_id, s.name AS supplier_name, s.code AS supplier_code, b.grn_date,
  b.invoice_no, b.invoice_date, b.invoice_pending, b.money_captured, b.company_state, b.supplier_state, b.supply_type, b.state_picked, b.reverse_charge,
  b.freight_amount, b.freight_taxable, b.freight_gst_rate, b.freight_tax, b.other_amount, b.other_taxable, b.other_gst_rate, b.other_tax,
  b.taxable_total, b.charges_total, b.cgst, b.sgst, b.igst, b.total, b.notes, b.created_at,
  (SELECT COUNT(*) FROM cf_grn_bill_lines x WHERE x.company_id = b.company_id AND x.bill_id = b.id AND x.deleted_at IS NULL) AS line_count,
  (SELECT COUNT(*) FROM cf_grn_bill_lines x JOIN cf_stock_movements m ON m.id = x.movement_id
    WHERE x.company_id = b.company_id AND x.bill_id = b.id AND x.deleted_at IS NULL AND m.reversed_by_id IS NOT NULL) AS reversed_lines`;

const money2 = (v) => (v == null ? null : round2(Number(v)));

function billHeader(r) {
  const flags = [];
  if (Number(r.invoice_pending)) flags.push('invoice_pending');
  if (!Number(r.money_captured)) flags.push('no_money');
  const reversed = Number(r.line_count) > 0 && Number(r.reversed_lines) >= Number(r.line_count);
  return {
    id: r.id, purchaseOrder: { id: r.purchase_order_id, code: r.po_code },
    supplier: r.supplier_id ? { id: r.supplier_id, code: r.supplier_code, name: r.supplier_name } : null,
    grnDate: r.grn_date instanceof Date ? r.grn_date.toISOString().slice(0, 10) : String(r.grn_date).slice(0, 10),
    invoice: {
      no: r.invoice_no ?? null,
      date: r.invoice_date ? (r.invoice_date instanceof Date ? r.invoice_date.toISOString().slice(0, 10) : String(r.invoice_date).slice(0, 10)) : null,
      pending: !!Number(r.invoice_pending),
    },
    moneyCaptured: !!Number(r.money_captured),
    flags, reversed,
    tax: {
      companyState: r.company_state, supplierState: r.supplier_state, supplyType: r.supply_type,
      supplyText: r.supply_type ? SUPPLY_TEXT[r.supply_type] : null, statePicked: !!Number(r.state_picked), reverseCharge: !!Number(r.reverse_charge),
    },
    charges: {
      freight: { amount: money2(r.freight_amount), taxable: !!Number(r.freight_taxable), gstRate: numOrNull(r.freight_gst_rate), tax: money2(r.freight_tax) },
      other: { amount: money2(r.other_amount), taxable: !!Number(r.other_taxable), gstRate: numOrNull(r.other_gst_rate), tax: money2(r.other_tax) },
    },
    totals: { taxable: money2(r.taxable_total), charges: money2(r.charges_total), cgst: money2(r.cgst), sgst: money2(r.sgst), igst: money2(r.igst), total: money2(r.total) },
    lineCount: Number(r.line_count), notes: r.notes ?? null,
  };
}

/** GET /grn-bills?supplierId=&purchaseOrderId=&flag=invoice_pending|no_money&from=&to=&search=&limit= */
export async function listBills(db, companyId, q = {}) {
  const where = ['b.company_id = ?', 'b.deleted_at IS NULL'];
  const params = [companyId];
  if (!blank(q.supplierId)) { where.push('b.supplier_id = ?'); params.push(Number(q.supplierId)); }
  if (!blank(q.purchaseOrderId)) { where.push('b.purchase_order_id = ?'); params.push(Number(q.purchaseOrderId)); }
  if (q.flag === 'invoice_pending') where.push('b.invoice_pending = 1');
  else if (q.flag === 'no_money') where.push('b.money_captured = 0');
  const from = blank(q.from) ? null : String(q.from);
  const to = blank(q.to) ? null : String(q.to);
  if (from && DATE_RE.test(from)) { where.push('b.grn_date >= ?'); params.push(from); }
  if (to && DATE_RE.test(to)) { where.push('b.grn_date <= ?'); params.push(to); }
  if (!blank(q.search)) {
    const like = `%${String(q.search).trim().replace(/[%_]/g, (m) => `\\${m}`)}%`;
    where.push('(b.invoice_no LIKE ? OR p.code LIKE ? OR s.name LIKE ?)');
    params.push(like, like, like);
  }
  const limit = Math.min(500, Math.max(1, Number(q.limit) || 200));
  const [rows] = await db.query(
    `SELECT ${BILL_COLS} FROM cf_grn_bills b
       JOIN cf_purchase_orders p ON p.id = b.purchase_order_id
       LEFT JOIN cf_parties s ON s.company_id = b.company_id AND s.id = b.supplier_id
      WHERE ${where.join(' AND ')} ORDER BY b.grn_date DESC, b.id DESC LIMIT ${limit}`,
    params,
  );
  const bills = rows.map(billHeader);
  const live = bills.filter((b) => !b.reversed);
  return {
    rows: bills,
    summary: {
      count: bills.length,
      total: round2(live.reduce((t, b) => t + (b.totals.total ?? 0), 0)),
      invoicePending: live.filter((b) => b.invoice.pending).length,
      noMoney: live.filter((b) => !b.moneyCaptured).length,
    },
  };
}

/** GET /grn-bills/:id */
export async function getBill(db, companyId, id) {
  const [[r]] = await db.query(
    `SELECT ${BILL_COLS} FROM cf_grn_bills b
       JOIN cf_purchase_orders p ON p.id = b.purchase_order_id
       LEFT JOIN cf_parties s ON s.company_id = b.company_id AND s.id = b.supplier_id
      WHERE b.company_id = ? AND b.id = ? AND b.deleted_at IS NULL`,
    [companyId, Number(id)],
  );
  if (!r) throw notFound('GRN bill');
  const [lines] = await db.query(
    `SELECT x.*, m.code AS item_code, m.name AS item_name, mv.code AS movement_code
       FROM cf_grn_bill_lines x
       JOIN cf_master_records m ON m.id = x.item_id
       LEFT JOIN cf_stock_movements mv ON mv.id = x.movement_id
      WHERE x.company_id = ? AND x.bill_id = ? AND x.deleted_at IS NULL ORDER BY x.line_no`,
    [companyId, Number(id)],
  );
  return {
    ...billHeader(r),
    lines: lines.map((x) => ({
      id: x.id, lineNo: x.line_no, purchaseLineId: x.purchase_line_id,
      movement: x.movement_id ? { id: x.movement_id, code: x.movement_code } : null,
      item: { id: x.item_id, code: x.item_code, name: x.item_name, uom: x.uom },
      quantity: Number(x.quantity), unitPrice: numOrNull(x.unit_price), mrp: numOrNull(x.mrp),
      discount: { mode: x.discount_mode, value: numOrNull(x.discount_value), amount: money2(x.discount_amount) },
      gross: money2(x.gross_amount), taxable: money2(x.taxable_value), hsnCode: x.hsn_code, gstRate: numOrNull(x.gst_rate),
      cgst: money2(x.cgst), sgst: money2(x.sgst), igst: money2(x.igst), lineTotal: money2(x.line_total),
      freightShare: money2(x.freight_alloc), landedValue: money2(x.landed_value), landedUnitCost: numOrNull(x.landed_unit_cost),
    })),
  };
}

/** The bills of one purchase order (the PO screen's "supplier bills"). */
export async function billsOfPurchaseOrder(db, companyId, poId) {
  return (await listBills(db, companyId, { purchaseOrderId: poId })).rows;
}

/**
 * PUT /grn-bills/:id/invoice { no, date } — the invoice that was "to follow" has come. Stock cost is not touched
 * (the money was captured at the GRN); this only completes the document.
 */
export async function completeInvoice(db, c, id, input = {}) {
  const problems = [];
  const no = blank(input.no) ? null : String(input.no).trim();
  const date = readDate(input.date, 'Invoice date', problems);
  if (!no) problems.push('Enter the supplier invoice number.');
  if (no && no.length > INVOICE_NO_MAX) problems.push(`Invoice number: at most ${INVOICE_NO_MAX} characters.`);
  if (!date) problems.push('Enter the supplier invoice date.');
  assertNoProblems(problems, 'The invoice cannot be saved.');
  const [[b]] = await db.query('SELECT id FROM cf_grn_bills WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, Number(id)]);
  if (!b) throw notFound('GRN bill');
  await db.query('UPDATE cf_grn_bills SET invoice_no = ?, invoice_date = ?, invoice_pending = 0 WHERE company_id = ? AND id = ?', [no, date, c.companyId, b.id]);
  return getBill(db, c.companyId, b.id);
}
