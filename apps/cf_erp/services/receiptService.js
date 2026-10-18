/**
 * receiptService.js — ACCOUNTS › RECEIPTS (init.sql §74). Money received from a customer, against an invoice or an
 * order; part payments; what is still owed per invoice and per order.
 *
 * HOW A RECEIPT IS SPREAD (cf_receipt_allocations): the invoice it was recorded against first (up to what it still
 * owes), then the order's other open billing invoices, oldest first. What is left is ON ACCOUNT for the order and goes
 * onto the next invoice raised (applyOnAccount). Removing a receipt (with a reason) takes its allocations with it.
 *
 * THE CLOSE RULE (user, 2026-10-18): a sales order with accepted terms closes when its post-production stages are all
 * done AND it is fully paid. A receipt that pays the order up closes it (orderBoardService.closeIfDone).
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { round2 } from './priceService.js';
import { todayText, dateText } from './billingService.js';

export const RECEIPT_MODES = { bank: 'Bank transfer (NEFT / RTGS)', cheque: 'Cheque', upi: 'UPI', cash: 'Cash', other: 'Other' };
const blank = (v) => v == null || String(v).trim() === '';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const money = (n) => `₹${Number(round2(n)).toLocaleString('en-IN')}`;

/** The order's issued invoices (billing and dispatch) with what each still owes, oldest first. 1 read. */
async function openInvoices(db, companyId, orderId, { lock = false } = {}) {
  const [rows] = await db.query(
    `SELECT inv.id, inv.invoice_no, inv.invoice_date, inv.due_date, inv.grand_total, inv.invoice_kind,
            COALESCE((SELECT SUM(al.amount) FROM cf_receipt_allocations al WHERE al.company_id = inv.company_id AND al.invoice_id = inv.id AND al.deleted_at IS NULL), 0) AS received
       FROM cf_invoices inv
      WHERE inv.company_id = ? AND inv.order_id = ? AND inv.status = 'issued' AND inv.deleted_at IS NULL
      ORDER BY inv.invoice_date, inv.id${lock ? ' FOR UPDATE' : ''}`,
    [companyId, Number(orderId)],
  );
  return rows.map((r) => ({
    id: r.id, invoiceNo: r.invoice_no, invoiceDate: dateText(r.invoice_date), dueDate: dateText(r.due_date), kind: r.invoice_kind,
    grandTotal: Number(r.grand_total), received: Number(r.received), outstanding: round2(Math.max(0, Number(r.grand_total) - Number(r.received))),
  }));
}

/** Money of the order's receipts not yet on an invoice, per receipt (oldest first). 1 read. */
async function unallocated(db, companyId, orderId) {
  const [rows] = await db.query(
    `SELECT r.id, r.amount, COALESCE((SELECT SUM(al.amount) FROM cf_receipt_allocations al WHERE al.company_id = r.company_id AND al.receipt_id = r.id AND al.deleted_at IS NULL), 0) AS used
       FROM cf_receipts r WHERE r.company_id = ? AND r.order_id = ? AND r.deleted_at IS NULL ORDER BY r.receipt_date, r.id`,
    [companyId, Number(orderId)],
  );
  return rows.map((r) => ({ id: r.id, left: round2(Number(r.amount) - Number(r.used)) })).filter((r) => r.left > 0.004);
}

/** Spreads money over invoices, the first named one first: rows [receiptId, invoiceId, amount]. Pure. */
export function spread(receipts, invoices) {
  const rows = [];
  const inv = invoices.map((i) => ({ ...i, owed: i.outstanding }));
  for (const r of receipts) {
    let left = r.left;
    for (const i of inv) {
      if (left <= 0.004) break;
      if (i.owed <= 0.004) continue;
      const take = round2(Math.min(left, i.owed));
      rows.push([r.id, i.id, take]);
      i.owed = round2(i.owed - take);
      left = round2(left - take);
    }
  }
  return rows;
}

/** Money on account goes onto the order's open invoices, oldest first (after an invoice is raised). 2 reads + ≤ 1 write. */
export async function applyOnAccount(db, c, orderId) {
  const [money, invoices] = await Promise.all([unallocated(db, c.companyId, orderId), openInvoices(db, c.companyId, orderId)]);
  const rows = spread(money, invoices);
  if (rows.length) await insertRows(db, 'cf_receipt_allocations', ['company_id', 'receipt_id', 'invoice_id', 'amount'], rows.map((r) => [c.companyId, ...r]));
  return rows.length;
}

async function requireOrder(db, companyId, orderId) {
  const [[o]] = await db.query(
    `SELECT o.id, o.code, o.order_type, o.status, o.customer_id, p.name AS customer_name FROM cf_sales_orders o LEFT JOIN cf_parties p ON p.id = o.customer_id
      WHERE o.company_id = ? AND o.id = ? AND o.deleted_at IS NULL FOR UPDATE`,
    [companyId, Number(orderId)],
  );
  if (!o) throw notFound('Sales order');
  return o;
}

/**
 * POST /accounts/receipts { orderId | invoiceId, receiptDate?, amount, mode?, reference?, notes? } — a payment received.
 * Against an invoice: that invoice first, the rest onto the order's other open invoices; what is left stays on
 * account. Part payments are normal. Returns { receipt, order: payments(…), closed }.
 */
export async function recordReceipt(db, c, input = {}) {
  const problems = [];
  let invoice = null;
  let orderId = blank(input.orderId) ? null : Number(input.orderId);
  if (!blank(input.invoiceId)) {
    const [[inv]] = await db.query('SELECT id, order_id, status, invoice_no FROM cf_invoices WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, Number(input.invoiceId)]);
    if (!inv) problems.push('That invoice does not exist.');
    else if (inv.status !== 'issued') problems.push(`Invoice ${inv.invoice_no ?? ''} is ${inv.status} — a payment goes against an issued invoice.`.replace('  ', ' '));
    else if (orderId && orderId !== Number(inv.order_id)) problems.push(`Invoice ${inv.invoice_no} is for another order.`);
    else { invoice = inv; orderId = Number(inv.order_id); }
  }
  if (!orderId) problems.push('Choose the order (or the invoice) the payment is for.');
  const date = blank(input.receiptDate) ? todayText() : String(input.receiptDate).slice(0, 10);
  if (!DATE_RE.test(date)) problems.push('The date needs YYYY-MM-DD.');
  else if (date > todayText()) problems.push('A payment is received on a day that has come — not in the future.');
  const amount = Number(input.amount);
  if (blank(input.amount) || !Number.isFinite(amount) || amount <= 0) problems.push('Give the amount received.');
  else if (amount > 1e11) problems.push('That amount is too large.');
  const mode = blank(input.mode) ? 'bank' : String(input.mode);
  if (!RECEIPT_MODES[mode]) problems.push('How was it paid: bank, cheque, UPI, cash or other.');
  assertNoProblems(problems, 'The payment cannot be recorded yet.');
  const o = await requireOrder(db, c.companyId, orderId);
  if (o.order_type !== 'customer') throw invalid('STOCK_ORDER', `${o.code} is a stock order — nobody pays for it.`);
  const [ins] = await db.query(
    'INSERT INTO cf_receipts (company_id, order_id, customer_id, invoice_id, receipt_date, amount, mode, reference, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, o.id, o.customer_id ?? null, invoice?.id ?? null, date, round2(amount), mode, blank(input.reference) ? null : String(input.reference).trim().slice(0, 100),
      blank(input.notes) ? null : String(input.notes).trim().slice(0, 500), c.userId ?? null],
  );
  await db.query('UPDATE cf_receipts SET code = ? WHERE id = ?', [`RC-${String(ins.insertId).padStart(6, '0')}`, ins.insertId]);
  // The named invoice first, then the oldest open ones.
  const invoices = await openInvoices(db, c.companyId, o.id, { lock: true });
  const ordered = invoice ? [...invoices.filter((i) => i.id === invoice.id), ...invoices.filter((i) => i.id !== invoice.id)] : invoices;
  const rows = spread([{ id: ins.insertId, left: round2(amount) }], ordered);
  if (rows.length) await insertRows(db, 'cf_receipt_allocations', ['company_id', 'receipt_id', 'invoice_id', 'amount'], rows.map((r) => [c.companyId, ...r]));
  // Paid up, every stage done, everything shipped → the order closes by itself.
  const { closeIfDone } = await import('./orderBoardService.js');
  const closed = o.status === 'confirmed' ? await closeIfDone(db, c, o.id) : false;
  const placed = round2(rows.reduce((t, r) => t + r[2], 0));
  return {
    receipt: (await listReceipts(db, c.companyId, { id: ins.insertId })).rows[0],
    allocated: placed, onAccount: round2(amount - placed),
    message: placed + 0.004 >= amount ? `${money(amount)} recorded against ${rows.length === 1 ? 'one invoice' : `${rows.length} invoices`}.`
      : `${money(amount)} recorded; ${money(amount - placed)} is kept on account for ${o.code}.`,
    order: await orderPayments(db, c.companyId, o.id),
    closed,
  };
}

/** DELETE /accounts/receipts/:id { reason } — entered by mistake: removed (kept, with the reason), its allocations go. */
export async function removeReceipt(db, c, id, input = {}) {
  if (blank(input.reason)) throw invalid('INVALID', 'Say why the payment is removed.', { problems: ['Say why the payment is removed.'] });
  const [[r]] = await db.query('SELECT id, order_id FROM cf_receipts WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, Number(id)]);
  if (!r) throw notFound('Payment');
  await db.query('UPDATE cf_receipt_allocations SET deleted_at = NOW() WHERE company_id = ? AND receipt_id = ? AND deleted_at IS NULL', [c.companyId, r.id]);
  await db.query('UPDATE cf_receipts SET deleted_at = NOW(), removed_reason = ?, removed_by = ? WHERE company_id = ? AND id = ?', [String(input.reason).trim().slice(0, 255), c.userId ?? null, c.companyId, r.id]);
  // Money of other receipts on account may now cover the invoices this one paid.
  await applyOnAccount(db, c, r.order_id);
  return orderPayments(db, c.companyId, r.order_id);
}

/** An invoice was cancelled: its allocations go, the money is on account again (and onto other open invoices). */
export async function releaseAllocations(db, c, invoiceId, orderId) {
  await db.query('UPDATE cf_receipt_allocations SET deleted_at = NOW() WHERE company_id = ? AND invoice_id = ? AND deleted_at IS NULL', [c.companyId, Number(invoiceId)]);
  await applyOnAccount(db, c, orderId);
}

/** GET /accounts/receipts?orderId=&search=&id= → { rows, modes } newest first (at most 500). 1 read. */
export async function listReceipts(db, companyId, q = {}) {
  const where = ['r.company_id = ?', 'r.deleted_at IS NULL'];
  const args = [companyId];
  if (!blank(q.id)) { where.push('r.id = ?'); args.push(Number(q.id)); }
  if (!blank(q.orderId)) { where.push('r.order_id = ?'); args.push(Number(q.orderId)); }
  if (!blank(q.search)) { where.push('(r.code LIKE ? OR r.reference LIKE ? OR o.code LIKE ? OR p.name LIKE ?)'); const like = `%${String(q.search).trim()}%`; args.push(like, like, like, like); }
  const [rows] = await db.query(
    `SELECT r.*, o.code AS order_code, p.name AS customer_name, inv.invoice_no, u.name AS by_name,
            COALESCE((SELECT SUM(al.amount) FROM cf_receipt_allocations al WHERE al.company_id = r.company_id AND al.receipt_id = r.id AND al.deleted_at IS NULL), 0) AS allocated
       FROM cf_receipts r JOIN cf_sales_orders o ON o.id = r.order_id LEFT JOIN cf_parties p ON p.id = r.customer_id
       LEFT JOIN cf_invoices inv ON inv.id = r.invoice_id LEFT JOIN users u ON u.id = r.created_by
      WHERE ${where.join(' AND ')} ORDER BY r.receipt_date DESC, r.id DESC LIMIT 500`,
    args,
  );
  return {
    rows: rows.map((r) => ({
      id: r.id, code: r.code, date: dateText(r.receipt_date), amount: Number(r.amount), mode: r.mode, modeLabel: RECEIPT_MODES[r.mode] ?? r.mode,
      reference: r.reference ?? null, notes: r.notes ?? null, order: { id: r.order_id, code: r.order_code }, customer: r.customer_name ?? null,
      invoice: r.invoice_id ? { id: r.invoice_id, invoiceNo: r.invoice_no } : null,
      allocated: Number(r.allocated), onAccount: round2(Number(r.amount) - Number(r.allocated)), by: r.by_name ?? null, createdAt: r.created_at,
    })),
    modes: RECEIPT_MODES,
  };
}

/**
 * GET /accounts/orders/:id/payments — one order: its invoices with what each owes, its receipts, the money on account,
 * and the billing summary (milestones billed, still to come). Fixed reads.
 */
export async function orderPayments(db, companyId, orderId) {
  const [[o]] = await db.query('SELECT o.id, o.code, o.status, p.name AS customer_name FROM cf_sales_orders o LEFT JOIN cf_parties p ON p.id = o.customer_id WHERE o.company_id = ? AND o.id = ? AND o.deleted_at IS NULL', [companyId, Number(orderId)]);
  if (!o) throw notFound('Sales order');
  const { orderBilling } = await import('./billingService.js');
  const [invoices, receipts, billing] = await Promise.all([
    openInvoices(db, companyId, o.id), listReceipts(db, companyId, { orderId: o.id }), orderBilling(db, companyId, [o.id]),
  ]);
  const received = round2(receipts.rows.reduce((t, r) => t + r.amount, 0));
  const onAccount = round2(receipts.rows.reduce((t, r) => t + r.onAccount, 0));
  const outstanding = round2(invoices.reduce((t, i) => t + i.outstanding, 0));
  const b = billing.get(Number(o.id))?.summary ?? null;
  return {
    order: { id: o.id, code: o.code, status: o.status, customer: o.customer_name ?? null },
    invoices, receipts: receipts.rows, invoiced: round2(invoices.reduce((t, i) => t + i.grandTotal, 0)), received, onAccount, outstanding,
    billing: b, fullyPaid: b ? b.fullyPaid : outstanding <= 0.5,
  };
}
