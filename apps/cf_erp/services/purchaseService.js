/**
 * purchaseService.js — what is short, what was asked for, what arrived.
 *
 * The FAB ERP shape (procurementOrderService.js), narrowed to CF's model.
 * **This is not MRP.** Nothing here plans, nets across time, or explodes a
 * BOM. It answers one question — "what do the jobs we have released need that
 * we do not have?" — and records the answer as a document.
 *
 * WHERE THE DEMAND COMES FROM. Release already wrote it: every material
 * requirement of every release on a confirmed order. A requirement knows what
 * it wants, what has been issued to it and what is reserved for it, so the
 * short quantity is arithmetic, not a forecast:
 *
 *     to buy = wanted - issued - reserved - free stock - already on order
 *
 * PLANNED DEMAND (2026-09-30, CF_ERP_ORDER_FLOW_PLAN): "Buying should happen
 * before production." A line on a confirmed order that is frozen and nested
 * (or has every plate chosen) but not released adds its material too — the
 * requirements release WILL write, worked out in bulk by release's own rule
 * (plannedRows). Released or planned: a line is one or the other.
 *
 * Free stock is what nobody has claimed (reservations are netted off inside
 * `availability`), so an item held for another job is not counted twice.
 *
 * SUGGEST, NEVER RAISE BY ITSELF. "Suggest what to buy" writes ONE draft
 * purchase order, marked `suggested`, and running it again REWRITES that same
 * order rather than raising a second — pressing the button twice must not buy
 * the steel twice (FAB's rule, and the reason for `uq_cpo_suggest`). Lines the
 * buyer edited by hand are rewritten too, which is why an order stops being
 * suggested the moment it is ordered.
 *
 * ADDRESSED TO NOBODY. A suggestion names no supplier: who to buy from is the
 * buyer's call, made when the order is sent. An order cannot leave draft
 * without one — a purchase order addressed to nobody cannot be sent.
 *
 * RECEIVING IS A STOCK RECEIPT. `receiveLine` posts an ordinary receipt
 * movement through stockService — same ledger, same balances, same batches —
 * and stamps the line on it, so "ordered / received / outstanding" is a
 * history of movements rather than a running total nobody can check.
 *
 * PRICES (init.sql §36, priceService). A line carries a UNIT PRICE per its unit,
 * net of tax. Left out, it defaults to the last price paid for the item (the
 * newest priced line on an order that was sent). The amount (price × quantity)
 * and the order total are worked out on read, never stored. A receipt carries
 * the line's price to the stock ledger as its unit cost unless the receiver
 * types another. The buy list estimates what the shortage will cost: the last
 * price paid, else the item's list price turned into a price per unit.
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { countsBy, likeOf, orderBy, pageArgs, pageOf, wantsPage } from '../lib/listing.js';
import { generate } from '../modules/codegen/index.js';
import { availability, plannedLines, plannedMaterialOfLines } from './releaseService.js';
import { postMovement } from './stockService.js';
import {
  CURRENCY, readPrice, readCurrency, round2, round4, num, lastPricesPaid, listPricesOf, measuresOf, perUnitPrice,
} from './priceService.js';
import { purchaseOrderTax } from './taxService.js';
import { inProcurementByItem } from './procurementShared.js';
import {
  requireLinkableOrder, allocationsOf, orderCodesOfPos, addAllocation, insertAllocations, dropAllocations,
  setAllocations, trimAllocations, holdOnReceipt, holdsByOrderItem, linkedOnOrder,
} from './purchaseLinkService.js';

const EPS = 1e-6;
const round6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const fmt = (n) => Number(Number(n).toFixed(3));
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_\-./]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// §46 (CF_ERP_PURCHASE_FLOW_PLAN.md): requested → quoting → ordered → partially_received → received.
// 'draft' is the old word for requested; nothing is written as draft any more.
export const PO_STATUSES = ['requested', 'quoting', 'ordered', 'partially_received', 'received', 'cancelled'];
/** Not yet sent to a supplier: still being requested / quoted — editable, not receivable. */
export const PRE_ORDER_STATUSES = ['requested', 'quoting', 'draft'];
/** Still expecting steel: these are what "on order" counts and what can be received against. */
const OPEN_STATUSES = ['requested', 'quoting', 'draft', 'ordered', 'partially_received'];
export const PO_STATUS_LABEL = {
  requested: 'Requested', quoting: 'Quoting', draft: 'Requested', ordered: 'Ordered', partially_received: 'Part received', received: 'Received', cancelled: 'Cancelled',
};

const readDate = (v, label, problems) => {
  if (blank(v)) return null;
  const s = String(v).trim();
  if (!DATE_RE.test(s)) { problems.push(`${label} needs YYYY-MM-DD.`); return null; }
  return s;
};

const readQty = (v, label, problems) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) { problems.push(`${label} is a number above zero.`); return null; }
  return round6(n);
};

/** An item that can be bought and stocked. Unit-tracked items have no stock yet, so they cannot. */
async function requireItem(db, companyId, itemId, problems) {
  const [[it]] = await db.query(
    `SELECT m.id, m.code, m.name, m.status, i.uom, i.tracked_by
       FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.id = ? AND m.record_kind = 'item' AND m.deleted_at IS NULL`,
    [companyId, Number(itemId)],
  );
  if (!it) { problems.push('That item does not exist.'); return null; }
  if (it.status === 'obsolete') problems.push(`${it.code ?? it.name} is obsolete.`);
  if (it.tracked_by === 'individual') problems.push(`${it.code ?? it.name} is tracked unit by unit — no stock is kept of it yet.`);
  return it;
}

// --- what is short ---------------------------------------------------------

/** Outstanding quantity per item across open purchase orders, with the orders named. */
async function onOrderByItem(db, companyId, { exceptOrderId = null } = {}) {
  const [rows] = await db.query(
    `SELECT l.item_id, l.quantity, l.qty_received, p.id AS po_id, p.code AS po_code, p.status
       FROM cf_purchase_order_lines l
       JOIN cf_purchase_orders p ON p.id = l.purchase_order_id AND p.deleted_at IS NULL
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND p.status IN (?)
        ${exceptOrderId ? 'AND p.id <> ?' : ''}`,
    exceptOrderId ? [companyId, OPEN_STATUSES, exceptOrderId] : [companyId, OPEN_STATUSES],
  );
  const out = new Map();
  for (const r of rows) {
    const left = round6(Math.max(0, Number(r.quantity) - Number(r.qty_received)));
    if (left <= EPS) continue;
    const e = out.get(r.item_id) ?? { quantity: 0, orders: [] };
    e.quantity = round6(e.quantity + left);
    e.orders.push({ id: r.po_id, code: r.po_code, status: r.status, outstanding: left });
    out.set(r.item_id, e);
  }
  return out;
}

/**
 * PLANNED demand (CF_ERP_ORDER_FLOW_PLAN, 2026-09-30): what confirmed, frozen,
 * not-yet-released lines will ask for, so the steel can be bought before
 * release. Only a line whose material is KNOWN counts ("ready"): every cut
 * plate on its nest or with a chosen plate — a plate still "chosen at nesting"
 * has nothing to buy yet. One row per line and item, in order code, line and
 * tree order, from releaseService.plannedMaterialOfLines (release's own rule, in
 * bulk). Round trips: 1 with no such line, 4 with any number of them.
 */
async function plannedRows(db, companyId) {
  const lines = await plannedLines(db, companyId);
  if (!lines.length) return [];
  const material = await plannedMaterialOfLines(db, companyId, lines);
  const out = [];
  for (const line of lines) {
    const m = material.get(Number(line.id));
    if (!m?.ready) continue;
    const byItem = new Map();
    for (const r of m.reqs) {
      const e = byItem.get(r.itemId) ?? {
        item: { id: r.itemId, code: r.design.code ?? null, name: r.design.name ?? null, uom: r.design.uom ?? null, trackedBy: r.design.trackedBy ?? null },
        wanted: 0,
        source: { orderId: line.order_id, orderCode: line.order_code, lineId: line.id, lineNo: line.line_no },
      };
      e.wanted = round6(e.wanted + r.quantity);
      byItem.set(r.itemId, e);
    }
    out.push(...byItem.values());
  }
  return out;
}

/**
 * What the jobs need and do not have: released requirements (as always), plus
 * the PLANNED material of confirmed, frozen lines not released yet (plannedRows).
 * A released row is one per item, `planned: false, source: null`; a planned row
 * is one per line and item, `planned: true, source: { orderId, orderCode, lineId,
 * lineNo }`. A line is released or planned, never both, so nothing is wanted twice.
 * q: { show?: short (default) | all, search?, exceptOrderId?, planned?: only | none }
 */
export async function buyList(db, companyId, q = {}) {
  // One row per item and ORDER, folded into one row per item below: the parts
  // let what is held / bought for an order cover that order only (init.sql §43).
  const [parts] = await db.query(
    `SELECT q.item_id, m.code AS item_code, m.name AS item_name, i.uom, i.tracked_by, o.id AS order_id, o.code AS order_code,
            SUM(GREATEST(q.quantity - q.issued, 0)) AS wanted,
            SUM(COALESCE(v.reserved, 0)) AS reserved
       FROM cf_material_requirements q
       JOIN cf_production_releases r ON r.id = q.release_id AND r.deleted_at IS NULL
       JOIN cf_sales_orders o ON o.id = r.order_id AND o.deleted_at IS NULL AND o.status = 'confirmed'
       JOIN cf_master_records m ON m.id = q.item_id AND m.deleted_at IS NULL
       JOIN cf_item_details i ON i.master_id = q.item_id AND i.deleted_at IS NULL
       LEFT JOIN (SELECT requirement_id, SUM(quantity) AS reserved FROM cf_stock_reservations
                   WHERE company_id = ? AND status = 'active' AND deleted_at IS NULL GROUP BY requirement_id) v
              ON v.requirement_id = q.id
      WHERE q.company_id = ? AND q.deleted_at IS NULL
      GROUP BY q.item_id, m.code, m.name, i.uom, i.tracked_by, o.id, o.code
      ORDER BY q.item_id, o.code`,
    [companyId, companyId],
  );
  const rows = [];
  for (const p of parts) {
    let r = rows[rows.length - 1];
    if (!r || r.item_id !== p.item_id) {
      r = { item_id: p.item_id, item_code: p.item_code, item_name: p.item_name, uom: p.uom, tracked_by: p.tracked_by, parts: [] };
      rows.push(r);
    }
    r.parts.push({ orderId: p.order_id, orderCode: p.order_code, wanted: round6(p.wanted), reserved: round6(p.reserved) });
  }
  const planned = await plannedRows(db, companyId);
  const itemIds = [...new Set([...rows.map((r) => r.item_id), ...planned.map((p) => p.item.id)])];
  const onOrder = await onOrderByItem(db, companyId, { exceptOrderId: q.exceptOrderId ?? null });
  const free = await availability(db, companyId, itemIds);
  const [estimates, inProc, holds, linked] = await Promise.all([
    buyEstimates(db, companyId, itemIds), inProcurementByItem(db, companyId, itemIds),
    holdsByOrderItem(db, companyId, itemIds), linkedOnOrder(db, companyId, OPEN_STATUSES, { exceptPoId: q.exceptOrderId ?? null }),
  ]);
  /*
   * Free stock and what is on order are per ITEM, and an item can now be on a
   * released row and on planned rows at once. Each is handed out once, in
   * order — the released row first, exactly as it always was (so with no
   * planned rows every number is what it was), then the planned rows in order
   * code and line order, each seeing only what the rows before it left. The
   * item's total to buy is therefore wanted − held − free − on order, never
   * counted twice.
   *
   * BOUGHT FOR AN ORDER (init.sql §43). Before that, each order's part of a row
   * is covered by what is HELD for that order (arrived on a PO bought for it),
   * then by what is still coming on POs bought for it — those cover nobody
   * else. Only the rest of a row meets free stock and the UNLINKED part of what
   * is on order. With no links every number is what it was.
   */
  const keyOf = (code, itemId) => `${String(code ?? '').toLowerCase()}:${itemId}`;
  const linkedTotalOf = new Map();
  for (const [k, qty] of linked) {
    const itemId = Number(k.slice(k.lastIndexOf(':') + 1));
    linkedTotalOf.set(itemId, round6((linkedTotalOf.get(itemId) ?? 0) + qty));
  }
  const left = new Map();                            // itemId -> { free, onOrder } still unclaimed
  const leftOf = (id) => {
    if (!left.has(id)) {
      left.set(id, {
        free: free.get(id)?.free ?? 0,
        onOrder: round6(Math.max(0, (onOrder.get(id)?.quantity ?? 0) - (linkedTotalOf.get(id) ?? 0))),
      });
    }
    return left.get(id);
  };
  const claim = (id, uncovered) => {
    const l = leftOf(id);
    const shown = { free: l.free, onOrder: l.onOrder };
    const fromFree = Math.min(l.free, uncovered);
    const fromOrder = Math.min(l.onOrder, Math.max(0, uncovered - fromFree));
    l.free = round6(l.free - fromFree);
    l.onOrder = round6(l.onOrder - fromOrder);
    return { ...shown, toBuy: round6(Math.max(0, uncovered - shown.free - shown.onOrder)) };
  };
  /** An order's part of a row, after its holds and its own POs: { held, linked, rest }. Consumes them. */
  const ownCover = (itemId, orderCode, uncovered) => {
    const k = keyOf(orderCode, itemId);
    const held = round6(Math.min(holds.get(k) ?? 0, uncovered));
    if (held > EPS) holds.set(k, round6(holds.get(k) - held));
    const mine = round6(Math.min(linked.get(k) ?? 0, uncovered - held));
    if (mine > EPS) linked.set(k, round6(linked.get(k) - mine));
    return { held, linked: mine, rest: round6(Math.max(0, uncovered - held - mine)) };
  };
  /** toBuy handed to the orders of a row, LAST order first (earlier orders met free stock first). */
  const splitOf = (cover, toBuy) => {
    const out = [];
    let left2 = toBuy;
    for (const p of [...cover].reverse()) {
      if (left2 <= EPS) break;
      const t = round6(Math.min(left2, p.rest));
      if (t > EPS) out.unshift({ orderId: p.orderId, orderCode: p.orderCode, toBuy: t });
      left2 = round6(left2 - t);
    }
    return out;
  };
  let out = rows.map((r) => {
    const wanted = round6(r.parts.reduce((t, p) => t + p.wanted, 0));
    const reserved = round6(r.parts.reduce((t, p) => t + p.reserved, 0));
    const oo = onOrder.get(r.item_id) ?? { quantity: 0, orders: [] };
    const cover = r.parts.map((p) => ({ ...p, ...ownCover(r.item_id, p.orderCode, round6(Math.max(0, p.wanted - p.reserved))) }));
    const held = round6(cover.reduce((t, p) => t + p.held, 0));
    const mine = round6(cover.reduce((t, p) => t + p.linked, 0));
    const c = claim(r.item_id, round6(cover.reduce((t, p) => t + p.rest, 0)));
    return {
      item: { id: r.item_id, code: r.item_code, name: r.item_name, uom: r.uom, trackedBy: r.tracked_by },
      planned: false,
      source: null,
      wanted,
      reserved,
      held,
      free: c.free,
      onOrder: round6(c.onOrder + mine),
      purchaseOrders: oo.orders,
      toBuy: c.toBuy,
      split: splitOf(cover, c.toBuy),
      orders: r.parts.map((p) => ({ code: p.orderCode, id: p.orderId })),
    };
  });
  for (const p of planned) {
    const oo = onOrder.get(p.item.id) ?? { quantity: 0, orders: [] };
    const own = ownCover(p.item.id, p.source.orderCode, p.wanted);
    const c = claim(p.item.id, own.rest);
    out.push({
      item: p.item,
      planned: true,
      source: p.source,
      wanted: p.wanted,
      reserved: 0,
      held: own.held,
      free: c.free,
      onOrder: round6(c.onOrder + own.linked),
      purchaseOrders: oo.orders,
      toBuy: c.toBuy,
      split: c.toBuy > EPS ? [{ orderId: p.source.orderId, orderCode: p.source.orderCode, toBuy: c.toBuy }] : [],
      orders: [{ code: p.source.orderCode, id: p.source.orderId }],
    });
  }
  out = out.map((row) => withEstimate(row, estimates.get(row.item.id)));
  /*
   * IN REQUEST / IN RFQ (init.sql §39, CF_ERP_PROCUREMENT_PLAN): open purchase
   * request lines not on a PO yet. They do NOT reduce toBuy — only a PO is
   * "on order" (user decision) — but each row says how much of its toBuy is
   * already being handled, handed out per item in the same order as free stock
   * and on-order (RFQ first, the further along), so an item's total is never
   * counted twice. toRequest = toBuy - inRfq - inRequest is what is still to raise.
   */
  const procLeft = new Map();
  out = out.map((row) => {
    const p = inProc.get(row.item.id);
    if (!procLeft.has(row.item.id)) procLeft.set(row.item.id, { rfq: p?.inRfq ?? 0, req: p?.inRequest ?? 0 });
    const l = procLeft.get(row.item.id);
    const inRfq = round6(Math.min(l.rfq, row.toBuy));
    const inRequest = round6(Math.min(l.req, Math.max(0, row.toBuy - inRfq)));
    l.rfq = round6(l.rfq - inRfq);
    l.req = round6(l.req - inRequest);
    return {
      ...row,
      inRequest,
      inRfq,
      toRequest: round6(Math.max(0, row.toBuy - inRfq - inRequest)),
      purchaseRequests: p?.requests ?? [],
      rfqs: p?.rfqs ?? [],
    };
  });
  if (String(q.show ?? 'short') !== 'all') out = out.filter((r) => r.toBuy > EPS);
  // Released / planned only — a filter over the rows above, after the stock was
  // handed out, so a row's numbers do not change with the filter.
  if (q.planned === 'only') out = out.filter((r) => r.planned);
  else if (q.planned === 'none') out = out.filter((r) => !r.planned);
  if (!blank(q.search)) {
    const term = String(q.search).trim().toLowerCase();
    out = out.filter((r) => [r.item.code, r.item.name, ...r.orders.map((o) => o.code)].some((t) => t && String(t).toLowerCase().includes(term)));
  }
  return out.sort((a, b) => b.toBuy - a.toBuy || String(a.item.code ?? '').localeCompare(String(b.item.code ?? ''))
    || Number(a.planned) - Number(b.planned));
}

/**
 * What one of each item is likely to cost: the last price paid, else the list
 * price turned into a price per unit (a per-kg list price × the item's WEIGHT).
 * Three reads for any number of items, whatever the list's length.
 */
export async function buyEstimates(db, companyId, itemIds) {
  if (!itemIds.length) return new Map();
  const [paid, list, measures] = await Promise.all([
    lastPricesPaid(db, companyId, itemIds),
    listPricesOf(db, companyId, itemIds),
    measuresOf(db, companyId, itemIds),
  ]);
  const out = new Map();
  for (const id of itemIds) {
    const p = paid.get(id);
    if (p) { out.set(id, { unitPrice: p.unitPrice, source: 'last_paid', from: { id: p.orderId, code: p.orderCode, date: p.orderedAt } }); continue; }
    const l = list.get(id);
    const unit = l ? perUnitPrice(l.listPrice, l.priceBasis, measures.get(id)) : null;
    out.set(id, unit != null ? { unitPrice: unit, source: 'list', from: null } : { unitPrice: null, source: null, from: null });
  }
  return out;
}

/** Adds the estimate to a buy-list row: estUnitPrice × toBuy = estCost (null when nothing is known). */
function withEstimate(row, est) {
  const unit = est?.unitPrice ?? null;
  return {
    ...row,
    estUnitPrice: unit,
    estSource: est?.source ?? null, // 'last_paid' | 'list' | null
    estFrom: est?.from ?? null, // the purchase order the last price came from
    estCost: unit == null ? null : round2(unit * row.toBuy),
    currency: CURRENCY,
  };
}

/** The buy list's estimated total: what can be priced, and how many short items cannot. */
export function buyListTotal(rows) {
  const priced = rows.filter((r) => r.estCost != null);
  return {
    estCost: round2(priced.reduce((t, r) => t + r.estCost, 0)),
    currency: CURRENCY,
    items: rows.length,
    unpricedItems: rows.filter((r) => r.estCost == null && r.toBuy > EPS).length,
  };
}

// --- the document ----------------------------------------------------------

async function requireOrder(db, companyId, id) {
  const [[p]] = await db.query('SELECT * FROM cf_purchase_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(id)]);
  if (!p) throw notFound('Purchase order');
  return p;
}

async function requireLine(db, companyId, id) {
  const [[l]] = await db.query(
    `SELECT l.*, p.status AS po_status, p.code AS po_code, p.supplier_id
       FROM cf_purchase_order_lines l JOIN cf_purchase_orders p ON p.id = l.purchase_order_id AND p.deleted_at IS NULL
      WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL`,
    [companyId, Number(id)],
  );
  if (!l) throw notFound('Purchase order line');
  return l;
}

/** The OPEN sales orders (by number, so the live revision) some purchase lines are bought for. 1 read. */
async function ordersBoughtFor(db, companyId, { lineIds = null, poId = null }) {
  if (lineIds && !lineIds.length) return [];
  const [rows] = await db.query(
    `SELECT DISTINCT so.id
       FROM cf_purchase_line_orders a
       JOIN cf_purchase_order_lines l ON l.id = a.purchase_line_id
       JOIN cf_sales_orders ao ON ao.id = a.order_id
       JOIN cf_sales_orders so ON so.company_id = ao.company_id AND so.code_active = ao.code_active AND so.status IN ('inquiry','quoted','confirmed')
      WHERE a.company_id = ? AND a.deleted_at IS NULL AND ${poId ? 'l.purchase_order_id = ?' : 'a.purchase_line_id IN (?)'}`,
    [companyId, poId ?? lineIds],
  );
  return rows.map((r) => r.id);
}

/** As a select-list column: the open sales orders (by number) a purchase line (`l`) or a whole PO (`p`) is bought for, comma-joined ids. */
const boughtForColumn = (by) => `(SELECT GROUP_CONCAT(DISTINCT so.id) FROM cf_purchase_line_orders a
         JOIN cf_purchase_order_lines al ON al.id = a.purchase_line_id
         JOIN cf_sales_orders ao ON ao.id = a.order_id
         JOIN cf_sales_orders so ON so.company_id = ao.company_id AND so.code_active = ao.code_active AND so.status IN ('inquiry','quoted','confirmed')
        WHERE a.deleted_at IS NULL AND ${by}) AS bought_for`;
/** …read back. A list long enough to have been cut by GROUP_CONCAT's limit is read again in full. */
async function boughtForOf(db, companyId, row, key) {
  const text = row.bought_for == null ? '' : String(row.bought_for);
  if (text.length >= 1000) return ordersBoughtFor(db, companyId, key);
  return text ? text.split(',').map(Number).sort((x, y) => x - y) : [];
}

/**
 * plannedUnits (§56, TM/CF_ERP_BUYING_V2.md §3): what the change just made did to the PLAN — the planned
 * cards of the orders the purchase line(s) were bought for that are now late or waiting. Worked out by
 * the material-ready engine for those orders only (the others claim as whole lines), so the screen need
 * not read the whole planner after a date edit. `orderIds` are read BEFORE the write (a cut can drop a share).
 */
async function plannedUnitsAfter(db, companyId, orderIds, change, stamp) {
  const { plannedUnitsOfOrders } = await import('./plannerService.js');
  return { change, orderIds, ...(await plannedUnitsOfOrders(db, companyId, orderIds, { stamp })) };
}

/** A cancelled or fully received order is history. */
function assertOpen(p, what = 'change') {
  if (p.status === 'cancelled') throw invalid('CANCELLED', `${p.code} was cancelled — nothing more can ${what}.`);
  if (p.status === 'received') throw invalid('CLOSED', `${p.code} is fully received — nothing more can ${what}.`);
}

/** What a line still expects. */
const outstandingOf = (l) => round6(Math.max(0, Number(l.quantity) - Number(l.qty_received)));

/** Recomputes the order's status from its lines, after a receipt or a line change. */
async function restate(db, companyId, poId) {
  const p = await requireOrder(db, companyId, poId);
  if (PRE_ORDER_STATUSES.includes(p.status) || p.status === 'cancelled') return p.status;
  const [lines] = await db.query(
    'SELECT quantity, qty_received FROM cf_purchase_order_lines WHERE company_id = ? AND purchase_order_id = ? AND deleted_at IS NULL',
    [companyId, poId],
  );
  const any = lines.some((l) => Number(l.qty_received) > EPS);
  const all = lines.length > 0 && lines.every((l) => Number(l.qty_received) >= Number(l.quantity) - EPS);
  const status = all ? 'received' : any ? 'partially_received' : 'ordered';
  if (status !== p.status) await db.query('UPDATE cf_purchase_orders SET status = ? WHERE company_id = ? AND id = ?', [status, companyId, poId]);
  return status;
}

const shapeLastPaid = (p) => (p
  ? { unitPrice: p.unitPrice, orderId: p.orderId, orderCode: p.orderCode, date: p.orderedAt, supplierName: p.supplierName }
  : null);

export async function getPurchaseOrder(db, companyId, id) {
  // The header with its supplier and the sales order it is for: one read (they were three).
  const [[p]] = await db.query(
    `SELECT p.*, s.id AS sup_id, s.code AS sup_code, s.name AS sup_name, fo.id AS for_id, fo.code AS for_code
       FROM cf_purchase_orders p
       LEFT JOIN cf_parties s ON s.company_id = p.company_id AND s.id = p.supplier_id
       LEFT JOIN cf_sales_orders fo ON fo.company_id = p.company_id AND fo.id = p.for_order_id
      WHERE p.company_id = ? AND p.id = ? AND p.deleted_at IS NULL`,
    [companyId, Number(id)],
  );
  if (!p) throw notFound('Purchase order');
  const sup = p.sup_id ? { id: p.sup_id, code: p.sup_code, name: p.sup_name } : null;
  const forOrder = p.for_id ? { id: p.for_id, code: p.for_code } : null;
  const [lines] = await db.query(
    `SELECT l.*, m.code AS item_code, m.name AS item_name, i.tracked_by
       FROM cf_purchase_order_lines l
       JOIN cf_master_records m ON m.id = l.item_id
       JOIN cf_item_details i ON i.master_id = l.item_id
      WHERE l.company_id = ? AND l.purchase_order_id = ? AND l.deleted_at IS NULL
      ORDER BY l.line_no, l.id`,
    [companyId, p.id],
  );
  const [receipts] = await db.query(
    `SELECT v.id, v.code, v.movement_date, v.purchase_line_id, SUM(k.quantity) AS quantity
       FROM cf_stock_movements v JOIN cf_stock_ledger k ON k.movement_id = v.id AND k.deleted_at IS NULL
      WHERE v.company_id = ? AND v.deleted_at IS NULL AND v.purchase_line_id IN
            (SELECT id FROM cf_purchase_order_lines WHERE company_id = ? AND purchase_order_id = ?)
      GROUP BY v.id, v.code, v.movement_date, v.purchase_line_id ORDER BY v.id`,
    [companyId, companyId, p.id],
  );
  const ordered = round6(lines.reduce((t, l) => t + Number(l.quantity), 0));
  const received = round6(lines.reduce((t, l) => t + Number(l.qty_received), 0));
  // Bought for which sales orders (init.sql §43): the header default, and each line's allocations.
  const alloc = await allocationsOf(db, companyId, lines.map((l) => l.id));
  // The last price paid elsewhere, beside each line — the buyer's yardstick.
  const lastPaid = lines.length ? await lastPricesPaid(db, companyId, lines.map((l) => l.item_id), { exceptOrderId: p.id }) : new Map();
  const priced = lines.filter((l) => l.unit_price != null);
  const amount = round2(priced.reduce((t, l) => t + Number(l.unit_price) * Number(l.quantity), 0));
  const amountReceived = round2(priced.reduce((t, l) => t + Number(l.unit_price) * Number(l.qty_received), 0));
  // Input GST (init.sql §37): per line and in total; reverse charge keeps it out of the supplier total.
  const { lineTax, poTax } = await purchaseOrderTax(db, companyId, [p],
    lines.map((l) => ({ id: l.id, purchase_order_id: p.id, item_id: l.item_id, amount: l.unit_price == null ? null : round2(Number(l.unit_price) * Number(l.quantity)) })));
  return {
    id: p.id,
    code: p.code,
    status: p.status,
    suggested: !!p.suggested,
    supplier: sup ? { id: sup.id, code: sup.code, name: sup.name } : null,
    expectedDate: p.expected_date,
    orderedAt: p.ordered_at,
    notes: p.notes,
    reverseCharge: !!Number(p.reverse_charge ?? 0),
    forOrder: forOrder ? { id: forOrder.id, code: forOrder.code } : null,
    // §46: the stock check done (lane "Stock checked") — null until it is.
    stockCheckedAt: p.stock_checked_at ?? null,
    createdAt: p.created_at,
    totals: {
      lines: lines.length, ordered, received, outstanding: round6(Math.max(0, ordered - received)),
      // Money, net of tax (init.sql §36) — priced lines only; unpricedLines counts the rest.
      amount, amountReceived, currency: CURRENCY, unpricedLines: lines.length - priced.length,
      ...poTax.get(p.id),
    },
    lines: lines.map((l) => ({
      id: l.id,
      lineNo: l.line_no,
      item: { id: l.item_id, code: l.item_code, name: l.item_name, uom: l.uom, trackedBy: l.tracked_by },
      quantity: Number(l.quantity),
      received: Number(l.qty_received),
      outstanding: outstandingOf(l),
      unitPrice: num(l.unit_price),
      currency: l.currency ?? CURRENCY,
      amount: l.unit_price == null ? null : round2(Number(l.unit_price) * Number(l.quantity)),
      lastPaid: shapeLastPaid(lastPaid.get(l.item_id)),
      ...lineTax.get(l.id),
      expectedDate: l.expected_date,
      note: l.note,
      orders: alloc.get(l.id) ?? [],
      unlinked: round6(Math.max(0, Number(l.quantity) - (alloc.get(l.id) ?? []).reduce((t, a) => t + a.quantity, 0))),
      receipts: receipts.filter((v) => v.purchase_line_id === l.id)
        .map((v) => ({ id: v.id, code: v.code, date: v.movement_date, quantity: round6(v.quantity) })),
    })),
  };
}

const PO_LINE_SUB = (expr, extra = '') => `(SELECT ${expr} FROM cf_purchase_order_lines l WHERE l.purchase_order_id = p.id AND l.deleted_at IS NULL${extra})`;
const PO_SUBS = {
  lines: PO_LINE_SUB('COUNT(*)'),
  ordered: PO_LINE_SUB('COALESCE(SUM(l.quantity), 0)'),
  received: PO_LINE_SUB('COALESCE(SUM(l.qty_received), 0)'),
  amount: PO_LINE_SUB('COALESCE(SUM(l.quantity * l.unit_price), 0)'),
  unpriced: PO_LINE_SUB('COUNT(*)', ' AND l.unit_price IS NULL'),
};
/** Columns the Purchase orders screen sorts by on the server. */
const PO_SORT = {
  code: 'p.code', status: 'p.status', supplier: 's.name', expected: 'p.expected_date',
  lines: PO_SUBS.lines, ordered: PO_SUBS.ordered, received: PO_SUBS.received,
  outstanding: `GREATEST(${PO_SUBS.ordered} - ${PO_SUBS.received}, 0)`, amount: PO_SUBS.amount,
};

/**
 * q: { status?: open (default) | all | <one status>, supplierId?, search? }
 * With paged=1 / all=1 answers { rows, total, counts, ... } — counts.status is
 * per status over the search + supplier filters (every chip), counts.open / all
 * likewise, and counts.sum the figures of the orders that match everything
 * (amount, outstanding, unpriced lines). Without them: the bare array, as ever.
 */
export async function listPurchaseOrders(db, companyId, q = {}) {
  const status = blank(q.status) ? 'open' : String(q.status);
  const base = ['p.company_id = ?', 'p.deleted_at IS NULL'];
  const args = [companyId];
  if (!blank(q.supplierId)) { base.push('p.supplier_id = ?'); args.push(Number(q.supplierId)); }
  const like = likeOf(q.search);
  if (like) { base.push('(p.code LIKE ? OR s.name LIKE ? OR s.code LIKE ?)'); args.push(like, like, like); }
  const where = [...base];
  const rowArgs = [...args];
  if (status === 'open') { where.push('p.status IN (?)'); rowArgs.push(OPEN_STATUSES); }
  else if (status !== 'all') { where.push('p.status = ?'); rowArgs.push(status); }
  const paged = wantsPage(q);
  const page = paged ? pageArgs(q, { def: 100 }) : null;
  const from = 'FROM cf_purchase_orders p LEFT JOIN cf_parties s ON s.id = p.supplier_id';
  const rowSql = `SELECT p.*, s.name AS supplier_name, s.code AS supplier_code,
            ${PO_SUBS.lines} AS line_count, ${PO_SUBS.ordered} AS ordered, ${PO_SUBS.received} AS received,
            ${PO_SUBS.amount} AS amount, ${PO_SUBS.unpriced} AS unpriced
       ${from}
      WHERE ${where.join(' AND ')} ORDER BY ${orderBy(q, PO_SORT, 'p.id DESC', 'p.id')}`;
  const [[rows], counted] = await Promise.all([
    paged ? db.query(`${rowSql} LIMIT ? OFFSET ?`, [...rowArgs, page.limit, page.offset]) : db.query(rowSql, rowArgs),
    paged ? Promise.all([
      db.query(`SELECT p.status AS k, COUNT(*) AS n ${from} WHERE ${base.join(' AND ')} GROUP BY p.status`, args),
      db.query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(t.amount), 0) AS amount, COALESCE(SUM(GREATEST(t.ordered - t.received, 0)), 0) AS outstanding,
                COALESCE(SUM(t.unpriced), 0) AS unpriced
           FROM (SELECT p.id, ${PO_SUBS.amount} AS amount, ${PO_SUBS.ordered} AS ordered, ${PO_SUBS.received} AS received, ${PO_SUBS.unpriced} AS unpriced
                   ${from} WHERE ${where.join(' AND ')}) t`,
        rowArgs,
      ),
    ]) : null,
  ]);
  // Input GST per order (init.sql §37): the lines of every listed order in one read, then three.
  const poTaxes = new Map();
  if (rows.length) {
    const [pl] = await db.query(
      `SELECT id, purchase_order_id, item_id, IF(unit_price IS NULL, NULL, ROUND(unit_price * quantity, 2)) AS amount
         FROM cf_purchase_order_lines WHERE company_id = ? AND purchase_order_id IN (?) AND deleted_at IS NULL`,
      [companyId, rows.map((p) => p.id)],
    );
    const { poTax } = await purchaseOrderTax(db, companyId, rows, pl.map((l) => ({ ...l, amount: l.amount == null ? null : Number(l.amount) })));
    for (const [k, v] of poTax) poTaxes.set(k, v);
  }
  // Bought for which sales orders (init.sql §43): the header default and every order its lines name.
  const forIds = [...new Set(rows.filter((p) => p.for_order_id).map((p) => p.for_order_id))];
  const [codesOf, forOrders] = await Promise.all([
    orderCodesOfPos(db, companyId, rows.map((p) => p.id)),
    forIds.length
      ? db.query('SELECT id, code FROM cf_sales_orders WHERE company_id = ? AND id IN (?)', [companyId, forIds])
        .then(([r]) => new Map(r.map((o) => [o.id, { id: o.id, code: o.code }])))
      : new Map(),
  ]);
  const out = rows.map((p) => ({
    id: p.id,
    code: p.code,
    status: p.status,
    suggested: !!p.suggested,
    supplier: p.supplier_id ? { id: p.supplier_id, code: p.supplier_code, name: p.supplier_name } : null,
    expectedDate: p.expected_date,
    orderedAt: p.ordered_at,
    createdAt: p.created_at,
    totals: {
      lines: Number(p.line_count),
      ordered: round6(p.ordered),
      received: round6(p.received),
      outstanding: round6(Math.max(0, Number(p.ordered) - Number(p.received))),
      amount: round2(p.amount), currency: CURRENCY, unpricedLines: Number(p.unpriced),
      ...poTaxes.get(p.id),
    },
    reverseCharge: !!Number(p.reverse_charge ?? 0),
    forOrder: forOrders.get(p.for_order_id) ?? null,
    orderCodes: codesOf.get(p.id) ?? [],
  }));
  if (!paged) return out;
  const [[byStatus], [[sum]]] = counted;
  const statusCounts = countsBy(byStatus, PO_STATUSES);
  const all = Object.values(statusCounts).reduce((t, n) => t + n, 0);
  const open = OPEN_STATUSES.reduce((t, k) => t + (statusCounts[k] ?? 0), 0);
  return pageOf(out, sum.n, page, {
    counts: {
      status: statusCounts, open, all,
      sum: { amount: round2(sum.amount), outstanding: round6(sum.outstanding), unpriced: Number(sum.unpriced) },
    },
  });
}

// --- raising and editing ---------------------------------------------------

async function nextCode(db, c, { suggested = false } = {}) {
  const g = await generate(db, c.companyId, 'purchase_order', 'code', { draft: { suggested } }, { consume: true });
  return g?.text ?? null;
}

/**
 * Writes the row, and numbers it PO-000123 when no coding rule answered — a
 * buyer should not have to set up a rule before the first order can be raised
 * (stock movements do the same).
 */
export async function insertOrder(db, c, { code, supplierId, expectedDate, notes, suggested, forOrderId = null }) {
  const [r] = await db.query(
    `INSERT INTO cf_purchase_orders (company_id, code, supplier_id, status, suggested, expected_date, notes, for_order_id, created_by)
     VALUES (?, ?, ?, 'requested', ?, ?, ?, ?, ?)`,
    [c.companyId, code ?? null, supplierId ?? null, suggested ? 1 : 0, expectedDate ?? null, notes ?? null, forOrderId ?? null, c.userId],
  );
  if (!code) await db.query('UPDATE cf_purchase_orders SET code = ? WHERE id = ?', [`PO-${String(r.insertId).padStart(6, '0')}`, r.insertId]);
  return r.insertId;
}

export async function requireSupplier(db, companyId, id, problems) {
  const [[s]] = await db.query('SELECT id, name, is_supplier, status FROM cf_parties WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(id)]);
  if (!s) { problems.push('That supplier does not exist.'); return null; }
  if (!Number(s.is_supplier)) problems.push(`${s.name} is not marked as a supplier.`);
  if (s.status !== 'active') problems.push(`${s.name} is inactive.`);
  return s;
}

export async function createPurchaseOrder(db, c, input = {}) {
  const problems = [];
  let supplierId = null;
  if (!blank(input.supplierId)) { const s = await requireSupplier(db, c.companyId, input.supplierId, problems); supplierId = s?.id ?? null; }
  const expectedDate = readDate(input.expectedDate, 'Expected date', problems);
  let code = blank(input.code) ? null : String(input.code).trim();
  if (code && (!CODE_RE.test(code) || code.length > 100)) problems.push('Order number: up to 100 letters, digits and - _ . /, no spaces.');
  const forOrder = blank(input.forOrderId) ? null : await requireLinkableOrder(db, c.companyId, input.forOrderId, problems);
  assertNoProblems(problems);
  if (!code) code = await nextCode(db, c);
  const id = await insertOrder(db, c, { code, supplierId, expectedDate, notes: blank(input.notes) ? null : String(input.notes), suggested: false, forOrderId: forOrder?.id ?? null });
  return getPurchaseOrder(db, c.companyId, id);
}

export async function updatePurchaseOrder(db, c, id, input = {}) {
  const p = await requireOrder(db, c.companyId, id);
  assertOpen(p);
  const problems = [];
  const sets = {};
  if (input.supplierId !== undefined) {
    if (blank(input.supplierId)) sets.supplier_id = null;
    else { const s = await requireSupplier(db, c.companyId, input.supplierId, problems); if (s) sets.supplier_id = s.id; }
  }
  if (input.expectedDate !== undefined) sets.expected_date = readDate(input.expectedDate, 'Expected date', problems);
  if (input.notes !== undefined) sets.notes = blank(input.notes) ? null : String(input.notes);
  // Reverse charge (init.sql §37): the GST is payable by us, not part of the supplier total.
  if (input.reverseCharge !== undefined) sets.reverse_charge = input.reverseCharge ? 1 : 0;
  // Only the default for lines added from now on: the lines already there keep their orders.
  if (input.forOrderId !== undefined) {
    if (blank(input.forOrderId)) sets.for_order_id = null;
    else { const o = await requireLinkableOrder(db, c.companyId, input.forOrderId, problems); if (o) sets.for_order_id = o.id; }
  }
  assertNoProblems(problems);
  if (Object.keys(sets).length) {
    await db.query(`UPDATE cf_purchase_orders SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(sets), c.companyId, p.id]);
  }
  return getPurchaseOrder(db, c.companyId, p.id);
}

/** Adds a line, or adds to the one this item already has — one line per item. */
export async function addPurchaseLine(db, c, poId, input = {}) {
  const p = await requireOrder(db, c.companyId, poId);
  assertOpen(p, 'be added');
  const problems = [];
  const item = await requireItem(db, c.companyId, input.itemId, problems);
  const quantity = readQty(input.quantity, 'Quantity', problems);
  const expectedDate = readDate(input.expectedDate, 'Expected date', problems);
  const typedPrice = readPrice(input.unitPrice, 'Unit price', problems);
  readCurrency(input.currency, problems);
  // Bought for a sales order (init.sql §43): the one named, else the header's default; null = for stock.
  const forOrderId = input.orderId !== undefined ? (blank(input.orderId) ? null : input.orderId) : p.for_order_id;
  const forOrder = forOrderId == null ? null : await requireLinkableOrder(db, c.companyId, forOrderId, problems);
  assertNoProblems(problems);
  let lineId;
  const [[existing]] = await db.query(
    'SELECT id, quantity, unit_price FROM cf_purchase_order_lines WHERE company_id = ? AND purchase_order_id = ? AND item_id = ? AND deleted_at IS NULL',
    [c.companyId, p.id, item.id],
  );
  if (existing) {
    // A typed price replaces the line's; otherwise the line keeps the one it has.
    await db.query('UPDATE cf_purchase_order_lines SET quantity = ?, unit_price = ? WHERE company_id = ? AND id = ?',
      [round6(Number(existing.quantity) + quantity), typedPrice ?? existing.unit_price, c.companyId, existing.id]);
    lineId = existing.id;
  } else {
    // No price typed: the last price paid for the item, if it was ever bought.
    const unitPrice = typedPrice
      ?? (await lastPricesPaid(db, c.companyId, [item.id], { exceptOrderId: p.id })).get(item.id)?.unitPrice ?? null;
    const [[{ n }]] = await db.query('SELECT COALESCE(MAX(line_no), 0) AS n FROM cf_purchase_order_lines WHERE company_id = ? AND purchase_order_id = ?', [c.companyId, p.id]);
    const [ins] = await db.query(
      `INSERT INTO cf_purchase_order_lines (company_id, purchase_order_id, line_no, item_id, quantity, uom, expected_date, note, unit_price, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.companyId, p.id, Number(n) + 1, item.id, quantity, item.uom, expectedDate, blank(input.note) ? null : String(input.note).slice(0, 500), unitPrice, CURRENCY],
    );
    lineId = ins.insertId;
  }
  if (forOrder) await addAllocation(db, c, lineId, forOrder.id, quantity);
  await restate(db, c.companyId, p.id);
  return getPurchaseOrder(db, c.companyId, p.id);
}

export async function updatePurchaseLine(db, c, lineId, input = {}) {
  /*
   * A date or a quantity can move the PLAN, so the answer says which planned cards it did (plannedUnits).
   * ROUND TRIPS (2026-10-11; ~49 ms each on production, one after another inside the transaction): the
   * orders the line is bought for and the plan-structure stamp ride on the read of the line itself; the
   * order's status is worked out from the purchase order read for the answer (no second read); a date-only
   * edit does not restate at all; and the planned cards come the lean way (plannerService) — 15 in all for
   * a date edit while the plan's structure is kept, where it was 54.
   */
  const asksPlan = input.quantity !== undefined || input.expectedDate !== undefined;
  let l;
  let planStamp;
  let boughtFor = null;
  if (asksPlan) {
    const { planStampColumns, planStampOf } = await import('./plannerService.js');
    const [[row]] = await db.query(
      `SELECT l.*, p.status AS po_status, p.code AS po_code, p.supplier_id,
              ${boughtForColumn('a.purchase_line_id = l.id')}, ${planStampColumns(c.companyId)}
         FROM cf_purchase_order_lines l JOIN cf_purchase_orders p ON p.id = l.purchase_order_id AND p.deleted_at IS NULL
        WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL`,
      [c.companyId, Number(lineId)],
    );
    if (!row) throw notFound('Purchase order line');
    l = row;
    planStamp = planStampOf(row);
    boughtFor = await boughtForOf(db, c.companyId, row, { lineIds: [row.id] });
  } else l = await requireLine(db, c.companyId, lineId);
  assertOpen({ status: l.po_status, code: l.po_code });
  const problems = [];
  const sets = {};
  if (input.quantity !== undefined) {
    const q = readQty(input.quantity, 'Quantity', problems);
    if (q != null && q + EPS < Number(l.qty_received)) problems.push(`${fmt(l.qty_received)} has already been received on this line — the quantity cannot go below that.`);
    else if (q != null) {
      sets.quantity = q;
      // Less on the line: the orders it is bought for give way, newest first, never below what arrived for them.
      if (q < Number(l.quantity) - EPS) await trimAllocations(db, c, l, q, problems);
    }
  }
  if (input.expectedDate !== undefined) sets.expected_date = readDate(input.expectedDate, 'Expected date', problems);
  if (input.note !== undefined) sets.note = blank(input.note) ? null : String(input.note).slice(0, 500);
  // Blank clears the price. What was already received keeps the cost it came in at.
  if (input.unitPrice !== undefined) sets.unit_price = readPrice(input.unitPrice, 'Unit price', problems);
  if (input.currency !== undefined) readCurrency(input.currency, problems);
  assertNoProblems(problems);
  if (Object.keys(sets).length) {
    await db.query(`UPDATE cf_purchase_order_lines SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(sets), c.companyId, l.id]);
  }
  let po = await getPurchaseOrder(db, c.companyId, l.purchase_order_id);
  // The order's status follows its lines — only a quantity can move it, and the lines were just read for the answer.
  if (sets.quantity !== undefined && !PRE_ORDER_STATUSES.includes(po.status) && po.status !== 'cancelled') {
    const any = po.lines.some((x) => x.received > EPS);
    const all = po.lines.length > 0 && po.lines.every((x) => x.received >= x.quantity - EPS);
    const status = all ? 'received' : any ? 'partially_received' : 'ordered';
    if (status !== po.status) {
      await db.query('UPDATE cf_purchase_orders SET status = ? WHERE company_id = ? AND id = ?', [status, c.companyId, po.id]);
      po = { ...po, status };
    }
  }
  // Only a date or a quantity can move the plan; a price or a note does not ask.
  const moved = (sets.expected_date !== undefined && (sets.expected_date ?? null) !== (planDate(l.expected_date) ?? null)) || (sets.quantity !== undefined && sets.quantity < Number(l.quantity) - EPS);
  if (!boughtFor || !moved) return po;
  return {
    ...po,
    plannedUnits: await plannedUnitsAfter(db, c.companyId, boughtFor, {
      purchaseLineId: l.id, purchaseOrder: { id: po.id, code: po.code },
      ...(sets.expected_date !== undefined ? { date: { from: planDate(l.expected_date), to: sets.expected_date ?? null } } : {}),
      ...(sets.quantity !== undefined ? { quantity: { from: Number(l.quantity), to: sets.quantity } } : {}),
    }, planStamp),
  };
}

const planDate = (d) => (d == null ? null : d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10));

export async function removePurchaseLine(db, c, lineId) {
  const l = await requireLine(db, c.companyId, lineId);
  assertOpen({ status: l.po_status, code: l.po_code }, 'be removed');
  if (Number(l.qty_received) > EPS) throw invalid('RECEIVED', `${fmt(l.qty_received)} has already been received on this line — it cannot be removed.`);
  await db.query('UPDATE cf_purchase_order_lines SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, l.id]);
  await dropAllocations(db, c.companyId, [l.id]);
  await restate(db, c.companyId, l.purchase_order_id);
  return getPurchaseOrder(db, c.companyId, l.purchase_order_id);
}

/** PUT /purchase-lines/:id/orders — which sales orders a line is bought for, and how much for each. */
export async function setPurchaseLineOrders(db, c, lineId, input = {}) {
  const l = await requireLine(db, c.companyId, lineId);
  assertOpen({ status: l.po_status, code: l.po_code });
  await setAllocations(db, c, l, input.orders);
  return getPurchaseOrder(db, c.companyId, l.purchase_order_id);
}

// --- suggest, send, receive, cancel ----------------------------------------

/** Requested / quoting → ordered: the buyer has named the supplier and placed it (without an RFQ, or after one). */
export async function markOrdered(db, c, id, input = {}) {
  const p = await requireOrder(db, c.companyId, id);
  if (!PRE_ORDER_STATUSES.includes(p.status)) throw invalid('NOT_DRAFT', `${p.code} is already ${PO_STATUS_LABEL[p.status].toLowerCase()}.`);
  const problems = [];
  let supplierId = p.supplier_id;
  if (!blank(input.supplierId)) { const s = await requireSupplier(db, c.companyId, input.supplierId, problems); supplierId = s?.id ?? supplierId; }
  if (!supplierId) problems.push('Name the supplier — a purchase order addressed to nobody cannot be sent.');
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM cf_purchase_order_lines WHERE company_id = ? AND purchase_order_id = ? AND deleted_at IS NULL', [c.companyId, p.id]);
  if (!Number(n)) problems.push('Add at least one line first.');
  assertNoProblems(problems, `${p.code} cannot be sent yet.`);
  await db.query(
    "UPDATE cf_purchase_orders SET status = 'ordered', supplier_id = ?, suggested = 0, ordered_at = NOW() WHERE company_id = ? AND id = ?",
    [supplierId, c.companyId, p.id],
  );
  return getPurchaseOrder(db, c.companyId, p.id);
}

export async function cancelPurchaseOrder(db, c, id, input = {}) {
  // One read: the order, what has been received against it, the sales orders it is bought for, and the plan-structure stamp.
  const { planStampColumns, planStampOf } = await import('./plannerService.js');
  const [[p]] = await db.query(
    `SELECT p.*, (SELECT COALESCE(SUM(x.qty_received), 0) FROM cf_purchase_order_lines x WHERE x.company_id = p.company_id AND x.purchase_order_id = p.id AND x.deleted_at IS NULL) AS received_total,
            ${boughtForColumn('al.purchase_order_id = p.id')}, ${planStampColumns(c.companyId)}
       FROM cf_purchase_orders p WHERE p.company_id = ? AND p.id = ? AND p.deleted_at IS NULL`,
    [c.companyId, Number(id)],
  );
  if (!p) throw notFound('Purchase order');
  if (p.status === 'cancelled') throw invalid('CANCELLED', `${p.code} is already cancelled.`);
  const n = p.received_total;
  if (Number(n) > EPS) throw invalid('RECEIVED', `${fmt(n)} has already been received against ${p.code} — it cannot be cancelled.`);
  const note = blank(input.reason) ? p.notes : `${p.notes ? `${p.notes}\n` : ''}Cancelled: ${String(input.reason).slice(0, 255)}`;
  const boughtFor = await boughtForOf(db, c.companyId, p, { poId: p.id });
  await db.query("UPDATE cf_purchase_orders SET status = 'cancelled', suggested = 0, notes = ? WHERE company_id = ? AND id = ?", [note, c.companyId, p.id]);
  const po = await getPurchaseOrder(db, c.companyId, p.id);
  return { ...po, plannedUnits: await plannedUnitsAfter(db, c.companyId, boughtFor, { purchaseOrder: { id: p.id, code: p.code }, cancelled: true }, planStampOf(p)) };
}

/**
 * Books a delivery against one line: an ordinary stock receipt, stamped with
 * the line it came in against. Over-delivery is refused — a note for more than
 * was ordered is a question for the buyer, not a quiet correction.
 */
export async function receiveLine(db, c, lineId, input = {}) {
  const l = await requireLine(db, c.companyId, lineId);
  if (PRE_ORDER_STATUSES.includes(l.po_status)) throw invalid('NOT_ORDERED', `${l.po_code} has not been placed yet — place it with a supplier first.`);
  assertOpen({ status: l.po_status, code: l.po_code }, 'be received');
  const problems = [];
  const left = outstandingOf(l);
  const quantity = readQty(input.quantity ?? left, 'Quantity', problems);
  if (quantity != null && quantity > left + EPS) problems.push(`Only ${fmt(left)} ${l.uom} of this line is still outstanding.`);
  if (blank(input.stockingAreaId)) problems.push('Say which stocking area it went into.');
  const receipt = receiptLineFor(l, { ...input, quantity }, problems);
  assertNoProblems(problems, 'The delivery cannot be booked.');
  const movement = await postMovement(db, c, {
    movementType: 'receipt',
    toAreaId: input.stockingAreaId,
    partyId: l.supplier_id ?? undefined,
    movementDate: input.movementDate,
    reference: input.reference,
    notes: input.notes,
    lines: [receipt],
  });
  await db.query('UPDATE cf_stock_movements SET purchase_line_id = ? WHERE company_id = ? AND id = ?', [l.id, c.companyId, movement.id]);
  await db.query('UPDATE cf_purchase_order_lines SET qty_received = qty_received + ? WHERE company_id = ? AND id = ?', [quantity, c.companyId, l.id]);
  // What was bought for a sales order is held for it as it arrives (init.sql §43).
  const held = await holdOnReceipt(db, c, l, quantity, movement.lines?.find((x) => x.item?.id === l.item_id)?.batch?.id ?? null);
  await restate(db, c.companyId, l.purchase_order_id);
  return { movement, held, order: await getPurchaseOrder(db, c.companyId, l.purchase_order_id) };
}

/**
 * The receipt line a delivery posts: item, quantity, batch — and the UNIT COST,
 * the price the receiver typed (`unitCost`) or else the line's unit price. With
 * no price anywhere, unitCost is left out. Exported so a test can check it
 * without posting.
 */
export function receiptLineFor(l, input, problems = []) {
  const typed = readPrice(input.unitCost, 'Unit cost', problems);
  const unitCost = typed ?? (l.unit_price == null ? null : round4(l.unit_price));
  const line = { itemId: l.item_id, quantity: input.quantity, batchId: input.batchId, batch: input.batch, notes: input.note };
  if (unitCost != null) line.unitCost = unitCost;
  return line;
}

/** For the nav badge and Home: how many items are short, and how many orders are waiting. */
export async function purchaseCounts(db, companyId) {
  // Items, not rows: an item short on a released row and a planned row is one item to buy.
  const short = new Set((await buyList(db, companyId, { show: 'short' })).map((r) => r.item.id)).size;
  const [[{ drafts }]] = await db.query("SELECT COUNT(*) AS drafts FROM cf_purchase_orders WHERE company_id = ? AND status IN ('requested','quoting','draft') AND deleted_at IS NULL", [companyId]);
  const [[{ awaiting }]] = await db.query("SELECT COUNT(*) AS awaiting FROM cf_purchase_orders WHERE company_id = ? AND status IN ('ordered','partially_received') AND deleted_at IS NULL", [companyId]);
  return { toBuy: short, draftOrders: Number(drafts), awaitingDelivery: Number(awaiting) };
}
