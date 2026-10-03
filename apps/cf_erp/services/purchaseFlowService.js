/**
 * purchaseFlowService.js — ONE purchase order carried through its stages
 * (CF_ERP_PURCHASE_FLOW_PLAN.md, init.sql §46):
 *
 *   Requested → Stock checked → RFQ out → Quotes in → Ordered → Part received → Received
 *
 * Raised from a sales order ("request these items"); the stock check holds what
 * is already on the shelf for that order and cuts the PO to the rest; the RFQ
 * lives UNDER the PO (cf_rfqs.purchase_order_id) and reuses the quote,
 * comparison and per-line award of procurementService; accepting splits the PO
 * per awarded supplier; receiving is purchaseService.receiveLine.
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import {
  buyList, getPurchaseOrder, insertOrder, requireSupplier, PRE_ORDER_STATUSES, PO_STATUS_LABEL,
} from './purchaseService.js';
import { getRfq, rfqComparison, upsertQuote, awardRfq } from './procurementService.js';
import { requireLinkableOrder, insertAllocations, allocationsOf, linkedPoIds, heldForOrder } from './purchaseLinkService.js';
import { availability } from './releaseService.js';
import { lastPricesPaid, CURRENCY, round2 } from './priceService.js';

const EPS = 1e-6;
const round6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const fmt = (n) => Number(Number(n).toFixed(3));
const todayText = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + Number(n)); return x.toISOString().slice(0, 10); };

async function requirePo(db, companyId, id, { lock = false } = {}) {
  const [[p]] = await db.query(`SELECT * FROM cf_purchase_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [companyId, Number(id)]);
  if (!p) throw notFound('Purchase order');
  return p;
}
const assertPreOrder = (p, what) => {
  if (!PRE_ORDER_STATUSES.includes(p.status)) throw invalid('NOT_OPEN', `${p.code} is ${PO_STATUS_LABEL[p.status]?.toLowerCase() ?? p.status} — it can no longer ${what}.`);
};
async function poLines(db, companyId, poId) {
  const [rows] = await db.query(
    `SELECT l.*, m.code AS item_code, m.name AS item_name, i.tracked_by FROM cf_purchase_order_lines l
       JOIN cf_master_records m ON m.id = l.item_id JOIN cf_item_details i ON i.master_id = l.item_id
      WHERE l.company_id = ? AND l.purchase_order_id = ? AND l.deleted_at IS NULL ORDER BY l.line_no, l.id`,
    [companyId, poId],
  );
  return rows;
}

// --- 1. Requested: from a sales order -----------------------------------------------

/** What a sales order is short of, for its "Request items" dialog: [{ item, toBuy, uom }] — this order's share only. */
export async function orderShortfall(db, companyId, orderId) {
  const oid = Number(orderId);
  const rows = await buyList(db, companyId, { show: 'short' });
  const byItem = new Map();
  for (const r of rows) {
    const mine = (r.split ?? []).filter((x) => Number(x.orderId) === oid).reduce((t, x) => t + x.toBuy, 0);
    if (mine <= EPS) continue;
    const e = byItem.get(r.item.id) ?? { item: r.item, uom: r.item.uom, toBuy: 0 };
    e.toBuy = round6(e.toBuy + mine);
    byItem.set(r.item.id, e);
  }
  return [...byItem.values()].sort((a, b) => String(a.item.code ?? '').localeCompare(String(b.item.code ?? '')));
}

/**
 * POST /orders/:id/purchase-request { lines?: [{ itemId, quantity }], notes? }
 * One REQUESTED PO bought for the order. No lines = the order's shortfall.
 */
export async function requestFromOrder(db, c, orderId, input = {}) {
  const problems = [];
  const order = await requireLinkableOrder(db, c.companyId, orderId, problems);
  assertNoProblems(problems, 'Nothing can be requested for that order.');
  let lines = Array.isArray(input.lines) ? input.lines : null;
  if (!lines) lines = (await orderShortfall(db, c.companyId, order.id)).map((r) => ({ itemId: r.item.id, quantity: r.toBuy }));
  const clean = new Map();
  for (const [i, l] of lines.entries()) {
    const itemId = Number(l?.itemId);
    const q = Number(l?.quantity);
    if (!Number.isInteger(itemId)) { problems.push(`Row ${i + 1}: choose an item.`); continue; }
    if (!(q > 0)) continue;                                   // a zero row is simply not requested
    clean.set(itemId, round6((clean.get(itemId) ?? 0) + q));
  }
  if (!clean.size) problems.push(`${order.code} is short of nothing — there is nothing to request.`);
  const ids = [...clean.keys()];
  if (ids.length) {
    const [items] = await db.query("SELECT m.id, m.code, i.item_type, i.uom FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE m.company_id = ? AND m.id IN (?) AND m.deleted_at IS NULL", [c.companyId, ids]);
    const found = new Map(items.map((x) => [x.id, x]));
    for (const id of ids) {
      const it = found.get(id);
      if (!it) problems.push(`Item ${id} does not exist.`);
      else if (it.item_type !== 'catalog') problems.push(`${it.code} is made on its order — only catalog items are bought.`);
    }
    assertNoProblems(problems, 'The request cannot be raised.');
    const poId = await insertOrder(db, c, {
      code: null, supplierId: null, expectedDate: null, suggested: false, forOrderId: order.id,
      notes: blank(input.notes) ? `Requested for ${order.code}.` : String(input.notes),
    });
    const prices = await lastPricesPaid(db, c.companyId, ids);
    await insertRows(db, 'cf_purchase_order_lines', ['company_id', 'purchase_order_id', 'line_no', 'item_id', 'quantity', 'uom', 'unit_price', 'currency'],
      ids.map((id, k) => [c.companyId, poId, k + 1, id, clean.get(id), found.get(id).uom ?? 'nos', prices.get(id)?.unitPrice ?? null, CURRENCY]));
    const [made] = await db.query('SELECT id, item_id, quantity FROM cf_purchase_order_lines WHERE company_id = ? AND purchase_order_id = ? AND deleted_at IS NULL', [c.companyId, poId]);
    await insertAllocations(db, c, made.map((l) => ({ lineId: l.id, orderId: order.id, quantity: Number(l.quantity) })));
    return getPurchaseOrder(db, c.companyId, poId);
  }
  assertNoProblems(problems, 'The request cannot be raised.');
  return null;
}

// --- 2. Stock check ------------------------------------------------------------------

/** The sales order a PO is bought for (header, else its only line order). */
async function orderOfPo(db, companyId, p) {
  if (p.for_order_id) return Number(p.for_order_id);
  const lines = await poLines(db, companyId, p.id);
  const alloc = await allocationsOf(db, companyId, lines.map((l) => l.id));
  const ids = new Set([...alloc.values()].flat().map((a) => a.orderId));
  return ids.size === 1 ? [...ids][0] : null;
}

/** GET /purchase-orders/:id/stock-check — free stock per line now, and what to hold (proposed). */
export async function stockCheck(db, c, poId) {
  const p = await requirePo(db, c.companyId, poId);
  const orderId = await orderOfPo(db, c.companyId, p);
  const lines = await poLines(db, c.companyId, p.id);
  const av = lines.length ? await availability(db, c.companyId, lines.map((l) => l.item_id), { orderId }) : new Map();
  return {
    purchaseOrder: { id: p.id, code: p.code, status: p.status, stockCheckedAt: p.stock_checked_at },
    orderId,
    canHold: !!orderId && PRE_ORDER_STATUSES.includes(p.status),
    lines: lines.map((l) => {
      const free = round6(av.get(l.item_id)?.free ?? 0);
      return {
        lineId: l.id, item: { id: l.item_id, code: l.item_code, name: l.item_name, uom: l.uom },
        quantity: Number(l.quantity), freeInStock: free, proposeHold: round6(Math.min(free, Number(l.quantity))),
      };
    }),
  };
}

/**
 * POST /purchase-orders/:id/stock-check { lines: [{ lineId, hold }] } — holds that
 * much of the stock for the sales order and cuts the PO lines by it (a line held
 * in full drops off). Marks the stock check done even when nothing is held.
 */
export async function applyStockCheck(db, c, poId, input = {}) {
  const p = await requirePo(db, c.companyId, poId, { lock: true });
  assertPreOrder(p, 'have its stock checked');
  const orderId = await orderOfPo(db, c.companyId, p);
  const want = new Map((Array.isArray(input.lines) ? input.lines : []).map((x) => [Number(x.lineId), Number(x.hold)]));
  const lines = await poLines(db, c.companyId, p.id);
  const problems = [];
  if ([...want.values()].some((h) => h > EPS) && !orderId) problems.push(`${p.code} is not bought for one sales order — stock can only be held for an order.`);
  const av = lines.length ? await availability(db, c.companyId, lines.map((l) => l.item_id), { orderId }) : new Map();
  const holds = [];
  for (const l of lines) {
    const h = round6(want.get(l.id) ?? 0);
    if (h <= EPS) continue;
    const e = av.get(l.item_id);
    if (h > Number(l.quantity) + EPS) problems.push(`${l.item_code}: hold at most ${fmt(l.quantity)} (the line).`);
    else if (h > (e?.free ?? 0) + EPS) problems.push(`${l.item_code}: only ${fmt(e?.free ?? 0)} is free in stock.`);
    else holds.push({ l, h, e });
  }
  assertNoProblems(problems, 'The stock cannot be held.');
  for (const { l, h, e } of holds) {
    // Lots first for an item kept by batch (oldest first), else loose stock.
    let left = h;
    const rows = [];
    if (l.tracked_by === 'batch') {
      for (const b of (e?.batches ?? []).filter((x) => x.status === 'available' && x.free > EPS)) {
        if (left <= EPS) break;
        const t = Math.min(left, b.free);
        rows.push([c.companyId, orderId, null, l.item_id, b.batchId, round6(t), c.userId ?? null]);
        left = round6(left - t);
      }
    } else rows.push([c.companyId, orderId, null, l.item_id, null, round6(left), c.userId ?? null]);
    await insertRows(db, 'cf_stock_reservations', ['company_id', 'held_for_order_id', 'purchase_line_id', 'item_id', 'batch_id', 'quantity', 'created_by'], rows);
    const rest = round6(Number(l.quantity) - h);
    if (rest <= EPS) {
      await db.query('UPDATE cf_purchase_order_lines SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, l.id]);
      await db.query('UPDATE cf_purchase_line_orders SET deleted_at = NOW() WHERE company_id = ? AND purchase_line_id = ? AND deleted_at IS NULL', [c.companyId, l.id]);
    } else {
      await db.query('UPDATE cf_purchase_order_lines SET quantity = ? WHERE company_id = ? AND id = ?', [rest, c.companyId, l.id]);
      await db.query('UPDATE cf_purchase_line_orders SET quantity = LEAST(quantity, ?) WHERE company_id = ? AND purchase_line_id = ? AND deleted_at IS NULL', [rest, c.companyId, l.id]);
    }
  }
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM cf_purchase_order_lines WHERE company_id = ? AND purchase_order_id = ? AND deleted_at IS NULL', [c.companyId, p.id]);
  // Everything came from stock: nothing is left to buy.
  if (!Number(n)) await db.query("UPDATE cf_purchase_orders SET status = 'cancelled', stock_checked_at = NOW(), notes = CONCAT(COALESCE(notes, ''), '\nEverything was held from stock — nothing to buy.') WHERE company_id = ? AND id = ?", [c.companyId, p.id]);
  else await db.query('UPDATE cf_purchase_orders SET stock_checked_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, p.id]);
  return { held: holds.map(({ l, h }) => ({ lineId: l.id, itemId: l.item_id, quantity: h })), purchaseOrder: await getPurchaseOrder(db, c.companyId, p.id) };
}

// --- 3. RFQ under the PO ------------------------------------------------------------------

async function rfqOfPo(db, companyId, poId) {
  const [[r]] = await db.query("SELECT * FROM cf_rfqs WHERE company_id = ? AND purchase_order_id = ? AND deleted_at IS NULL AND status <> 'cancelled' ORDER BY id DESC LIMIT 1", [companyId, Number(poId)]);
  return r ?? null;
}

/**
 * POST /purchase-orders/:id/rfq { supplierIds: [], quotesDue?, terms? } — sends
 * the PO's lines to those suppliers (one RFQ under the PO; adding suppliers to
 * a sent RFQ adds them). The PO moves to Quoting.
 */
export async function sendRfq(db, c, poId, input = {}) {
  const p = await requirePo(db, c.companyId, poId, { lock: true });
  assertPreOrder(p, 'be sent for quotes');
  const problems = [];
  const supplierIds = [...new Set((Array.isArray(input.supplierIds) ? input.supplierIds : []).map(Number).filter(Boolean))];
  if (!supplierIds.length) problems.push('Choose at least one supplier to ask.');
  for (const id of supplierIds) await requireSupplier(db, c.companyId, id, problems);
  const lines = await poLines(db, c.companyId, p.id);
  if (!lines.length) problems.push(`${p.code} has no lines to quote.`);
  assertNoProblems(problems, 'The RFQ cannot be sent.');
  let rfq = await rfqOfPo(db, c.companyId, p.id);
  if (!rfq) {
    const [r] = await db.query(
      "INSERT INTO cf_rfqs (company_id, code, status, quotes_due, terms, purchase_order_id, created_by, sent_at) VALUES (?, ?, 'sent', ?, ?, ?, ?, NOW())",
      [c.companyId, `${p.code}-RFQ`, blank(input.quotesDue) ? null : String(input.quotesDue), blank(input.terms) ? null : String(input.terms), p.id, c.userId ?? null],
    );
    rfq = { id: r.insertId };
    await insertRows(db, 'cf_rfq_lines', ['company_id', 'rfq_id', 'line_no', 'item_id', 'quantity', 'uom', 'needed_by', 'po_line_id'],
      lines.map((l, k) => [c.companyId, r.insertId, k + 1, l.item_id, l.quantity, l.uom, l.expected_date ?? null, l.id]));
  }
  const [have] = await db.query('SELECT supplier_id FROM cf_rfq_suppliers WHERE company_id = ? AND rfq_id = ?', [c.companyId, rfq.id]);
  const known = new Set(have.map((r) => r.supplier_id));
  const fresh = supplierIds.filter((id) => !known.has(id));
  if (fresh.length) {
    await insertRows(db, 'cf_rfq_suppliers', ['company_id', 'rfq_id', 'supplier_id', 'status', 'sent_at'],
      fresh.map((id) => [c.companyId, rfq.id, id, 'sent', new Date()]));
  }
  await db.query("UPDATE cf_purchase_orders SET status = 'quoting', stock_checked_at = COALESCE(stock_checked_at, NOW()) WHERE company_id = ? AND id = ?", [c.companyId, p.id]);
  return poQuotes(db, c, p.id);
}

/** GET /purchase-orders/:id/quotes — the RFQ under the PO: suppliers, quotes, and the per-line comparison. */
export async function poQuotes(db, c, poId) {
  const p = await requirePo(db, c.companyId, poId);
  const rfq = await rfqOfPo(db, c.companyId, p.id);
  if (!rfq) return { purchaseOrder: { id: p.id, code: p.code, status: p.status }, rfq: null, comparison: null };
  return { purchaseOrder: { id: p.id, code: p.code, status: p.status }, rfq: await getRfq(db, c, rfq.id), comparison: await rfqComparison(db, c, rfq.id) };
}

/** POST /purchase-orders/:id/quotes { supplierId, …, lines: [{ rfqLineId, unitPrice, leadTimeDays?, qtyOffered? }] } — one supplier's quotation. */
export async function recordQuote(db, c, poId, input = {}) {
  const rfq = await rfqOfPo(db, c.companyId, poId);
  if (!rfq) throw invalid('NO_RFQ', 'Send the RFQ first — a quotation answers it.');
  await upsertQuote(db, c, rfq.id, input);
  return poQuotes(db, c, poId);
}

// --- 4. Accept quotes and place the order (split per supplier) --------------------------

/**
 * POST /purchase-orders/:id/place { awards: [{ rfqLineId, quoteLineId }] } —
 * accepts a quote per line and places the order. The first supplier keeps THIS
 * PO; each other supplier gets a new PO and its lines move there (with their
 * sales-order allocations). Unawarded lines stay behind on a requested PO.
 * Price from the quote, expected date = today + its lead time, supplier set,
 * status ordered.
 */
export async function placeOrder(db, c, poId, input = {}) {
  const p = await requirePo(db, c.companyId, poId, { lock: true });
  assertPreOrder(p, 'be placed');
  const rfq = await rfqOfPo(db, c.companyId, p.id);
  if (!rfq) throw invalid('NO_RFQ', 'Send the RFQ and record the quotations first — or place it straight with a supplier.');
  if (Array.isArray(input.awards) && input.awards.length) await awardRfq(db, c, rfq.id, { awards: input.awards });
  const [rows] = await db.query(
    `SELECT rl.id AS rfq_line_id, rl.po_line_id, rl.quantity, ql.id AS quote_line_id, ql.unit_price, ql.lead_time_days, ql.qty_offered, qt.supplier_id
       FROM cf_rfq_lines rl
       LEFT JOIN cf_quote_lines ql ON ql.id = rl.awarded_quote_line_id
       LEFT JOIN cf_quotes qt ON qt.id = ql.quote_id AND qt.deleted_at IS NULL
      WHERE rl.company_id = ? AND rl.rfq_id = ? AND rl.deleted_at IS NULL AND rl.po_line_id IS NOT NULL`,
    [c.companyId, rfq.id],
  );
  const live = new Set((await poLines(db, c.companyId, p.id)).map((l) => l.id));
  const awarded = rows.filter((r) => r.supplier_id && live.has(r.po_line_id));
  if (!awarded.length) throw invalid('NOTHING_AWARDED', 'Accept at least one quotation line first.');
  const bySupplier = new Map();
  for (const r of awarded) {
    if (!bySupplier.has(r.supplier_id)) bySupplier.set(r.supplier_id, []);
    bySupplier.get(r.supplier_id).push(r);
  }
  const unawarded = [...live].filter((id) => !awarded.some((r) => r.po_line_id === id));
  const today = todayText();
  const placed = [];
  let first = true;
  for (const [supplierId, mine] of bySupplier) {
    let target = p.id;
    if (!first) {
      target = await insertOrder(db, c, { code: null, supplierId, expectedDate: null, suggested: false, forOrderId: p.for_order_id ?? null, notes: `Split from ${p.code} — awarded to this supplier.` });
    }
    first = false;
    let no = 1;
    for (const r of mine) {
      const qty = r.qty_offered != null && Number(r.qty_offered) > 0 ? Math.min(Number(r.qty_offered), Number(r.quantity)) : null;
      await db.query(
        `UPDATE cf_purchase_order_lines SET purchase_order_id = ?, line_no = ?, unit_price = ?, quote_line_id = ?, expected_date = ?${qty != null ? ', quantity = ?' : ''}
          WHERE company_id = ? AND id = ?`,
        [target, no++, r.unit_price, r.quote_line_id, r.lead_time_days != null ? addDays(today, r.lead_time_days) : null, ...(qty != null ? [qty] : []), c.companyId, r.po_line_id],
      );
    }
    const lead = Math.max(0, ...mine.map((r) => Number(r.lead_time_days ?? 0)));
    await db.query("UPDATE cf_purchase_orders SET status = 'ordered', supplier_id = ?, ordered_at = NOW(), suggested = 0, expected_date = ? WHERE company_id = ? AND id = ?",
      [supplierId, lead ? addDays(today, lead) : null, c.companyId, target]);
    await db.query('UPDATE cf_rfq_lines SET purchase_line_id = po_line_id WHERE company_id = ? AND rfq_id = ? AND po_line_id IN (?)', [c.companyId, rfq.id, mine.map((r) => r.po_line_id)]);
    placed.push(target);
  }
  // Lines nobody won stay to buy, on a requested PO of their own.
  if (unawarded.length) {
    const rest = await insertOrder(db, c, { code: null, supplierId: null, expectedDate: null, suggested: false, forOrderId: p.for_order_id ?? null, notes: `Left from ${p.code} — no quotation accepted for these lines.` });
    await db.query('UPDATE cf_purchase_order_lines SET purchase_order_id = ? WHERE company_id = ? AND id IN (?)', [rest, c.companyId, unawarded]);
    if (p.stock_checked_at) await db.query('UPDATE cf_purchase_orders SET stock_checked_at = ? WHERE company_id = ? AND id = ?', [p.stock_checked_at, c.companyId, rest]);
    placed.push(rest);
  }
  await db.query("UPDATE cf_rfqs SET status = 'awarded' WHERE company_id = ? AND id = ?", [c.companyId, rfq.id]);
  const out = [];
  for (const id of placed) out.push(await getPurchaseOrder(db, c.companyId, id));
  return { purchaseOrders: out };
}

// --- the Purchase tab: lanes ------------------------------------------------------------

export const PURCHASE_LANES = [
  { key: 'requested', label: 'Requested', hint: 'Raised from a sales order. Next: check stock.' },
  { key: 'stock_checked', label: 'Stock checked', hint: 'Stock held for the order; the rest is to buy. Next: send the RFQ.' },
  { key: 'rfq_out', label: 'RFQ out', hint: 'Suppliers asked, no quotation recorded yet.' },
  { key: 'quotes_in', label: 'Quotes in', hint: 'Quotations recorded. Next: accept and place the order.' },
  { key: 'ordered', label: 'Ordered', hint: 'Placed with a supplier. Set the expected dates; receive against it.' },
  { key: 'part_received', label: 'Part received', hint: 'Some of it has arrived.' },
  { key: 'received', label: 'Received', hint: 'Everything arrived (last 30 days).' },
];

export function laneOf(p) {
  if (p.status === 'requested' || p.status === 'draft') return p.stock_checked_at ? 'stock_checked' : 'requested';
  if (p.status === 'quoting') return Number(p.quotes ?? 0) > 0 ? 'quotes_in' : 'rfq_out';
  if (p.status === 'ordered') return 'ordered';
  if (p.status === 'partially_received') return 'part_received';
  if (p.status === 'received') return 'received';
  return 'closed';
}

/** GET /purchase/board?orderId=&supplierId=&search= — every open PO in its lane. */
export async function purchaseBoard(db, companyId, q = {}) {
  const where = ['p.company_id = ?', 'p.deleted_at IS NULL', "(p.status IN ('requested','draft','quoting','ordered','partially_received') OR (p.status = 'received' AND p.updated_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)))"];
  const args = [companyId];
  if (!blank(q.supplierId)) { where.push('p.supplier_id = ?'); args.push(Number(q.supplierId)); }
  if (!blank(q.search)) { where.push('(p.code LIKE ? OR s.name LIKE ?)'); args.push(`%${q.search}%`, `%${q.search}%`); }
  if (!blank(q.orderId)) {
    const ids = await linkedPoIds(db, companyId, Number(q.orderId));
    where.push(`(p.for_order_id = ?${ids.length ? ' OR p.id IN (?)' : ''})`);
    args.push(Number(q.orderId), ...(ids.length ? [ids] : []));
  }
  const [rows] = await db.query(
    `SELECT p.*, s.name AS supplier_name, s.code AS supplier_code, fo.code AS for_order_code,
            (SELECT COUNT(*) FROM cf_purchase_order_lines l WHERE l.purchase_order_id = p.id AND l.deleted_at IS NULL) AS line_count,
            (SELECT COALESCE(SUM(l.quantity * l.unit_price), 0) FROM cf_purchase_order_lines l WHERE l.purchase_order_id = p.id AND l.deleted_at IS NULL) AS amount,
            (SELECT COUNT(*) FROM cf_purchase_order_lines l WHERE l.purchase_order_id = p.id AND l.deleted_at IS NULL AND l.unit_price IS NULL) AS unpriced,
            (SELECT COUNT(*) FROM cf_purchase_order_lines l WHERE l.purchase_order_id = p.id AND l.deleted_at IS NULL AND l.expected_date IS NULL) AS undated,
            (SELECT MIN(l.expected_date) FROM cf_purchase_order_lines l WHERE l.purchase_order_id = p.id AND l.deleted_at IS NULL AND l.qty_received < l.quantity) AS next_due,
            (SELECT COUNT(*) FROM cf_rfqs r JOIN cf_rfq_suppliers rs ON rs.rfq_id = r.id WHERE r.purchase_order_id = p.id AND r.deleted_at IS NULL AND r.status <> 'cancelled') AS asked,
            (SELECT COUNT(*) FROM cf_rfqs r JOIN cf_quotes qt ON qt.rfq_id = r.id AND qt.deleted_at IS NULL WHERE r.purchase_order_id = p.id AND r.deleted_at IS NULL AND r.status <> 'cancelled') AS quotes
       FROM cf_purchase_orders p
       LEFT JOIN cf_parties s ON s.id = p.supplier_id
       LEFT JOIN cf_sales_orders fo ON fo.id = p.for_order_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.id DESC`,
    args,
  );
  const today = todayText();
  const cards = rows.map((p) => {
    const lane = laneOf(p);
    const next = p.next_due ? (p.next_due instanceof Date ? p.next_due.toISOString().slice(0, 10) : String(p.next_due).slice(0, 10)) : null;
    const tags = [];
    if (lane === 'rfq_out' || lane === 'quotes_in') tags.push(`${Number(p.quotes)} of ${Number(p.asked)} quoted`);
    if (lane === 'ordered' && Number(p.undated)) tags.push(`${Number(p.undated)} line${Number(p.undated) === 1 ? '' : 's'} without a date`);
    if (Number(p.unpriced) && lane !== 'requested' && lane !== 'stock_checked') tags.push(`${Number(p.unpriced)} unpriced`);
    return {
      id: p.id, code: p.code, lane, status: p.status, statusLabel: PO_STATUS_LABEL[p.status] ?? p.status,
      supplier: p.supplier_id ? { id: p.supplier_id, code: p.supplier_code, name: p.supplier_name } : null,
      forOrder: p.for_order_id ? { id: p.for_order_id, code: p.for_order_code } : null,
      lines: Number(p.line_count), value: Number(p.unpriced) === Number(p.line_count) ? null : round2(p.amount),
      nextDue: next, overdue: !!next && next < today && ['ordered', 'part_received'].includes(lane),
      createdAt: p.created_at, tags,
    };
  });
  return {
    lanes: PURCHASE_LANES.map((l) => {
      const mine = cards.filter((c) => c.lane === l.key);
      return { ...l, count: mine.length, value: round2(mine.reduce((t, c) => t + (c.value ?? 0), 0)), cards: mine };
    }),
  };
}

/** GET /orders/:id/purchase — a sales order's buying: its shortfall, its POs by lane, and the stock held for it. */
export async function orderPurchase(db, companyId, orderId) {
  const [shortfall, board, held] = await Promise.all([orderShortfall(db, companyId, orderId), purchaseBoard(db, companyId, { orderId }), heldForOrder(db, companyId, orderId)]);
  return { shortfall, lanes: board.lanes, held };
}
