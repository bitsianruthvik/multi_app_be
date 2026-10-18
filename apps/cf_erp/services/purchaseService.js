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
import { checkSubstitute, recordSubstitute } from './customerMaterialService.js';
import {
  CURRENCY, readPrice, readCurrency, round2, round4, num, lastPricesPaid, listPricesOf, measuresOf, perUnitPrice,
} from './priceService.js';
import { purchaseOrderTax } from './taxService.js';
import { inProcurementByItem } from './procurementShared.js';
import {
  requireLinkableOrder, allocationsOf, orderCodesOfPos, addAllocation, insertAllocations, dropAllocations,
  setAllocations, trimAllocations, holdOnReceipt, holdsByOrderItem, linkedOnOrder,
} from './purchaseLinkService.js';
import { requestApproval, withdrawApprovals, closeApprovals, pendingFor } from './approvalService.js';

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

/*
 * PURCHASE FLOW v3 (init.sql §71, 2026-10-18). A purchase order has a TYPE — material (default) or contractor (contractor
 * POs come in a later step) — and a STAGE worked out from its status, its approval and its close:
 *   pending_approval  every PO to a vendor starts here (status 'requested', approval_status 'pending'): Management approves it
 *                     (§73: through the Management inbox — cf_erp_approve_purchase_order / _contractor_po). Nothing can be received yet.
 *   waiting           approved (status 'ordered'): waiting for goods. The customer's ₹0 PO starts here — no approval.
 *   part_received     some goods in (several GRNs per PO, from Inventory › Receive against PO).
 *   closed            everything received — the PO closes by itself (status 'received').
 *   closed_short      closed by a person with a reason: what was pending is released (qty_closed) and the PR line's
 *                     "PO raised" goes down by it (the shares are cut to what arrived).
 *   requested         an older PO that was never placed (before §71).   cancelled.
 */
export const PO_TYPES = ['material', 'contractor'];
export const PO_TYPE_LABEL = { material: 'Material', contractor: 'Contractor' };
export const PO_STAGES = ['pending_approval', 'requested', 'waiting', 'part_received', 'closed', 'closed_short', 'cancelled'];
export const PO_STAGE_LABEL = {
  pending_approval: 'Pending Management approval', requested: 'Not placed', waiting: 'Waiting for goods', part_received: 'Part received',
  closed: 'Closed', closed_short: 'Closed short', cancelled: 'Cancelled',
};
/** The stage of a PO row (status, approval_status, closed_at). */
export function poStage(p) {
  if (p.status === 'cancelled') return 'cancelled';
  if (PRE_ORDER_STATUSES.includes(p.status)) return p.approval_status === 'pending' ? 'pending_approval' : 'requested';
  if (p.status === 'ordered') return 'waiting';
  if (p.status === 'partially_received') return 'part_received';
  return p.closed_at ? 'closed_short' : 'closed';
}
/** The same, as SQL over a row aliased `p` — for the list's filter and its counts. */
export const PO_STAGE_SQL = `CASE WHEN p.status = 'cancelled' THEN 'cancelled'
  WHEN p.status IN ('requested','quoting','draft') AND p.approval_status = 'pending' THEN 'pending_approval'
  WHEN p.status IN ('requested','quoting','draft') THEN 'requested'
  WHEN p.status = 'ordered' THEN 'waiting'
  WHEN p.status = 'partially_received' THEN 'part_received'
  WHEN p.closed_at IS NOT NULL THEN 'closed_short' ELSE 'closed' END`;
export const poTypeOf = (v) => (v === 'contractor' ? 'contractor' : 'material');

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

// --- the document ----------------------------------------------------------

async function requireOrder(db, companyId, id) {
  const [[p]] = await db.query('SELECT * FROM cf_purchase_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(id)]);
  if (!p) throw notFound('Purchase order');
  return p;
}

async function requireLine(db, companyId, id) {
  const [[l]] = await db.query(
    `SELECT l.*, p.status AS po_status, p.code AS po_code, p.supplier_id, p.supplied_by_customer, p.for_order_id, p.approval_status, p.closed_at
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

/**
 * EXPECTED DELIVERY DATES (user, 2026-10-18, for the planner): the PO's own date and a line's override; every change of
 * either is recorded (cf_purchase_date_changes, §71) with who and when. rows: [{ poId, lineId|null, from, to }]. 1 write.
 */
async function recordDateChanges(db, c, rows) {
  const real = rows.filter((r) => (r.from ?? null) !== (r.to ?? null));
  if (!real.length) return;
  await db.query(
    `INSERT INTO cf_purchase_date_changes (company_id, purchase_order_id, purchase_line_id, from_date, to_date, changed_by) VALUES ${real.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
    real.flatMap((r) => [c.companyId, r.poId, r.lineId ?? null, r.from ?? null, r.to ?? null, c.userId ?? null]),
  );
}

/** A cancelled or fully received order is history. */
function assertOpen(p, what = 'change') {
  if (p.status === 'cancelled') throw invalid('CANCELLED', `${p.code} was cancelled — nothing more can ${what}.`);
  if (p.status === 'received') throw invalid('CLOSED', `${p.code} is closed — nothing more can ${what}.`);
}

/** What a line still expects. */
const outstandingOf = (l) => round6(Math.max(0, Number(l.quantity) - Number(l.qty_received)));

/** Recomputes the order's status from its lines, after a receipt or a line change. */
async function restate(db, companyId, poId) {
  const p = await requireOrder(db, companyId, poId);
  // A PO closed short by a person stays closed (§71): nothing more is coming on it.
  if (PRE_ORDER_STATUSES.includes(p.status) || p.status === 'cancelled' || p.closed_at) return p.status;
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
    `SELECT p.*, s.id AS sup_id, s.code AS sup_code, s.name AS sup_name, fo.id AS for_id, fo.code AS for_code,
            au.name AS approved_by_name, cu.name AS closed_by_name
       FROM cf_purchase_orders p
       LEFT JOIN cf_parties s ON s.company_id = p.company_id AND s.id = p.supplier_id
       LEFT JOIN cf_sales_orders fo ON fo.company_id = p.company_id AND fo.id = p.for_order_id
       LEFT JOIN users au ON au.id = p.approved_by
       LEFT JOIN users cu ON cu.id = p.closed_by
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
  // Every change of the PO's or a line's expected date, newest first (§71). Tolerates a database without the table.
  const [dateRows] = await db.query(
    `SELECT d.id, d.purchase_line_id, d.from_date, d.to_date, d.changed_at, d.changed_by, u.name AS changed_by_name
       FROM cf_purchase_date_changes d LEFT JOIN users u ON u.id = d.changed_by
      WHERE d.company_id = ? AND d.purchase_order_id = ? AND d.deleted_at IS NULL ORDER BY d.id DESC LIMIT 100`,
    [companyId, p.id],
  ).catch(() => [[]]);
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
  const stage = poStage(p);
  // §73: what waits for Management about this PO (its approval, a close short) — the PO page says so.
  const waiting = (await pendingFor(db, companyId, 'purchase_order', [p.id])).get(Number(p.id)) ?? [];
  return {
    id: p.id,
    code: p.code,
    status: p.status,
    pendingApprovals: waiting.map((a) => ({ id: a.id, type: a.type, typeLabel: a.typeLabel, requestedBy: a.requestedBy, requestedAt: a.requestedAt, note: a.requestNote })),
    // §71: type, stage, the MD's approval and the close.
    type: poTypeOf(p.po_type), typeLabel: PO_TYPE_LABEL[poTypeOf(p.po_type)],
    stage, stageLabel: PO_STAGE_LABEL[stage],
    approval: p.approval_status ? { status: p.approval_status, by: p.approved_by ? { id: p.approved_by, name: p.approved_by_name ?? null } : null, at: p.approved_at ?? null } : null,
    closed: p.closed_at ? { at: p.closed_at, by: p.closed_by ? { id: p.closed_by, name: p.closed_by_name ?? null } : null, reason: p.close_reason ?? null } : null,
    suggested: !!p.suggested,
    supplier: sup ? { id: sup.id, code: sup.code, name: sup.name } : null,
    // §66: the customer's own material, asked of the customer as vendor (₹0); its receipt is their lot.
    suppliedByCustomer: !!Number(p.supplied_by_customer ?? 0),
    // The PO's own expected delivery date; each line may override it (lines[].expectedDate), lines[].effectiveDate is the
    // one that counts (the line's, else the PO's) — what the planner allocates incoming material by.
    expectedDate: p.expected_date,
    dateChanges: dateRows.map((d) => ({
      id: d.id, lineId: d.purchase_line_id ?? null, from: planDate(d.from_date), to: planDate(d.to_date),
      by: d.changed_by ? { id: d.changed_by, name: d.changed_by_name ?? null } : null, at: d.changed_at,
    })),
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
      // §71: ordered / received / pending; what a close short released is not pending any more.
      closedQty: Number(l.qty_closed ?? 0),
      pending: stage === 'cancelled' || stage === 'closed' || stage === 'closed_short' ? 0 : outstandingOf(l),
      unitPrice: num(l.unit_price),
      currency: l.currency ?? CURRENCY,
      amount: l.unit_price == null ? null : round2(Number(l.unit_price) * Number(l.quantity)),
      lastPaid: shapeLastPaid(lastPaid.get(l.item_id)),
      ...lineTax.get(l.id),
      expectedDate: l.expected_date,
      effectiveDate: planDate(l.expected_date) ?? planDate(p.expected_date),
      dateSource: l.expected_date ? 'line' : p.expected_date ? 'po' : null,
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
  if (!blank(q.type) && q.type !== 'all') { base.push('p.po_type = ?'); args.push(poTypeOf(q.type)); }
  const where = [...base];
  const rowArgs = [...args];
  // §71: a STAGE filter (pending_approval, waiting, part_received, closed, closed_short, cancelled, requested) beside the old status one.
  if (!blank(q.stage) && q.stage !== 'all') { where.push(`(${PO_STAGE_SQL}) = ?`); rowArgs.push(String(q.stage)); }
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
      db.query(`SELECT p.status AS k, ${PO_STAGE_SQL} AS g, COUNT(*) AS n ${from} WHERE ${base.join(' AND ')} GROUP BY p.status, g`, args),
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
    type: poTypeOf(p.po_type), typeLabel: PO_TYPE_LABEL[poTypeOf(p.po_type)],
    stage: poStage(p), stageLabel: PO_STAGE_LABEL[poStage(p)],
    suggested: !!p.suggested,
    supplier: p.supplier_id ? { id: p.supplier_id, code: p.supplier_code, name: p.supplier_name } : null,
    suppliedByCustomer: !!Number(p.supplied_by_customer ?? 0),
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
  const [[byStatusStage], [[sum]]] = counted;
  const merge = (key) => { const m = new Map(); for (const r of byStatusStage) m.set(r[key], (m.get(r[key]) ?? 0) + Number(r.n)); return [...m].map(([k, n]) => ({ k, n })); };
  const statusCounts = countsBy(merge('k'), PO_STATUSES);
  const stageCounts = countsBy(merge('g'), PO_STAGES);
  const all = Object.values(statusCounts).reduce((t, n) => t + n, 0);
  const open = OPEN_STATUSES.reduce((t, k) => t + (statusCounts[k] ?? 0), 0);
  return pageOf(out, sum.n, page, {
    counts: {
      status: statusCounts, stage: stageCounts, open, all,
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
  if (sets.expected_date !== undefined) await recordDateChanges(db, c, [{ poId: p.id, lineId: null, from: planDate(p.expected_date), to: sets.expected_date ?? null }]);
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
  if (sets.expected_date !== undefined) await recordDateChanges(db, c, [{ poId: l.purchase_order_id, lineId: l.id, from: planDate(l.expected_date), to: sets.expected_date ?? null }]);
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

/**
 * Requested → SENT FOR MD APPROVAL (§71, 2026-10-18): the buyer has named the supplier; the PO waits for the MD
 * (approval_status 'pending', status stays 'requested' — nothing can be received). approvePurchaseOrder places it.
 * Before §71 this placed it at once.
 */
export async function markOrdered(db, c, id, input = {}) {
  const p = await requireOrder(db, c.companyId, id);
  if (!PRE_ORDER_STATUSES.includes(p.status)) throw invalid('NOT_DRAFT', `${p.code} is already ${PO_STATUS_LABEL[p.status].toLowerCase()}.`);
  if (p.approval_status === 'pending') throw invalid('PENDING_APPROVAL', `${p.code} is already waiting for Management approval.`);
  const problems = [];
  let supplierId = p.supplier_id;
  if (!blank(input.supplierId)) { const s = await requireSupplier(db, c.companyId, input.supplierId, problems); supplierId = s?.id ?? supplierId; }
  if (!supplierId) problems.push('Name the supplier — a purchase order addressed to nobody cannot be sent.');
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM cf_purchase_order_lines WHERE company_id = ? AND purchase_order_id = ? AND deleted_at IS NULL', [c.companyId, p.id]);
  if (!Number(n)) problems.push('Add at least one line first.');
  assertNoProblems(problems, `${p.code} cannot be sent yet.`);
  await db.query(
    "UPDATE cf_purchase_orders SET supplier_id = ?, suggested = 0, approval_status = 'pending', approved_by = NULL, approved_at = NULL WHERE company_id = ? AND id = ?",
    [supplierId, c.companyId, p.id],
  );
  await askPoApproval(db, c, p.id);
  return getPurchaseOrder(db, c.companyId, p.id);
}

/** The approval type of a PO: a contractor's PO has its own (§73). */
const poApprovalType = (p) => (poTypeOf(p.po_type) === 'contractor' ? 'contractor_po' : 'purchase_order');
const PO_APPROVAL_TYPES = ['purchase_order', 'contractor_po'];

/**
 * §73: a PO waiting for approval is a row of the Management inbox (approvalService). Called when a PO is sent for
 * approval (markOrdered) and when a PO is raised from a PR — or lines are added to one still waiting (raisePo).
 * The context is read live in the inbox, so asking again only refreshes the summary. 2 reads + 1 write.
 */
export async function askPoApproval(db, c, poId) {
  const [[p]] = await db.query(
    `SELECT p.id, p.code, p.po_type, p.for_order_id, s.name AS supplier_name,
            (SELECT COALESCE(SUM(l.quantity * l.unit_price), 0) FROM cf_purchase_order_lines l WHERE l.company_id = p.company_id AND l.purchase_order_id = p.id AND l.deleted_at IS NULL) AS amount,
            (SELECT COUNT(*) FROM cf_purchase_order_lines l WHERE l.company_id = p.company_id AND l.purchase_order_id = p.id AND l.deleted_at IS NULL) AS line_count
       FROM cf_purchase_orders p LEFT JOIN cf_parties s ON s.id = p.supplier_id
      WHERE p.company_id = ? AND p.id = ?`,
    [c.companyId, Number(poId)],
  );
  if (!p) return null;
  return requestApproval(db, c, {
    type: poApprovalType(p), subjectId: p.id, subjectCode: p.code, orderId: p.for_order_id ?? null,
    title: `${poTypeOf(p.po_type) === 'contractor' ? 'Contractor PO' : 'Purchase order'} ${p.code} to ${p.supplier_name ?? 'a vendor'}`,
    summary: `${Number(p.line_count)} line${Number(p.line_count) === 1 ? '' : 's'}, ₹${round2(p.amount).toLocaleString('en-IN')} before tax.`,
    amount: round2(p.amount),
  });
}

/**
 * Approving a purchase order to a vendor (§71, moved onto the Management inbox in §73: permission
 * cf_erp_approve_purchase_order, or cf_erp_approve_contractor_po for a contractor's PO — routes/approvals.js and the PO
 * route both decide through approvalService.decide). Pending → placed: status 'ordered' (waiting for goods), ordered_at
 * now; its inbox row is closed as approved. A PO not waiting for approval is refused in words.
 */
export async function approvePurchaseOrder(db, c, id, input = {}) {
  const [[p]] = await db.query('SELECT * FROM cf_purchase_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, Number(id)]);
  if (!p) throw notFound('Purchase order');
  if (p.approval_status !== 'pending' || !PRE_ORDER_STATUSES.includes(p.status)) {
    throw invalid('NOT_PENDING', p.status === 'cancelled' ? `${p.code} was cancelled.` : `${p.code} is not waiting for approval.`);
  }
  if (!p.supplier_id) throw invalid('INVALID', `${p.code} has no vendor — it cannot be placed.`);
  const note = blank(input.note) ? p.notes : `${p.notes ? `${p.notes}\n` : ''}Approved: ${String(input.note).slice(0, 255)}`;
  await db.query(
    "UPDATE cf_purchase_orders SET status = 'ordered', approval_status = 'approved', approved_by = ?, approved_at = NOW(), ordered_at = NOW(), notes = ? WHERE company_id = ? AND id = ?",
    [c.userId ?? null, note, c.companyId, p.id],
  );
  await closeApprovals(db, c, { subjectType: 'purchase_order', subjectId: p.id, types: PO_APPROVAL_TYPES, status: 'approved', note: input.note });
  return getPurchaseOrder(db, c.companyId, p.id);
}

/**
 * Management SENDS BACK a purchase order (§73): it is not placed; it goes back to the buyer as requested (approval
 * cleared, the reason added to its notes), to be changed and sent for approval again — or cancelled.
 */
export async function rejectPurchaseOrder(db, c, id, input = {}) {
  const [[p]] = await db.query('SELECT * FROM cf_purchase_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, Number(id)]);
  if (!p) throw notFound('Purchase order');
  if (p.approval_status !== 'pending' || !PRE_ORDER_STATUSES.includes(p.status)) throw invalid('NOT_PENDING', `${p.code} is not waiting for approval.`);
  if (blank(input.note)) throw invalid('REASON', 'Say why the purchase order is sent back.');
  await db.query(
    'UPDATE cf_purchase_orders SET approval_status = NULL, approved_by = NULL, approved_at = NULL, notes = ? WHERE company_id = ? AND id = ?',
    [`${p.notes ? `${p.notes}\n` : ''}Sent back by Management: ${String(input.note).slice(0, 255)}`, c.companyId, p.id],
  );
  await closeApprovals(db, c, { subjectType: 'purchase_order', subjectId: p.id, types: PO_APPROVAL_TYPES, status: 'rejected', note: input.note });
  return getPurchaseOrder(db, c.companyId, p.id);
}

/** Why a PO cannot be closed short, or null. */
function closeShortRefusal(p) {
  if (!['ordered', 'partially_received'].includes(p.status) || p.closed_at) {
    return p.status === 'received' ? `${p.code} is already closed.` : p.status === 'cancelled' ? `${p.code} was cancelled.`
      : `${p.code} is not placed yet — cancel it instead.`;
  }
  return null;
}

/**
 * POST /purchase-orders/:id/close { reason } — ASK to close the PO short (§73: closing short needs Management's yes,
 * permission cf_erp_approve_po_close_short). Nothing changes on the PO until it is approved; then closePurchaseOrder
 * runs with the reason given here. Asking again while one waits replaces its reason.
 */
export async function requestCloseShort(db, c, id, input = {}) {
  const [[p]] = await db.query(
    `SELECT p.*, s.name AS supplier_name,
            (SELECT COALESCE(SUM(GREATEST(l.quantity - l.qty_received, 0)), 0) FROM cf_purchase_order_lines l WHERE l.company_id = p.company_id AND l.purchase_order_id = p.id AND l.deleted_at IS NULL) AS pending_qty,
            (SELECT COALESCE(SUM(GREATEST(l.quantity - l.qty_received, 0) * l.unit_price), 0) FROM cf_purchase_order_lines l WHERE l.company_id = p.company_id AND l.purchase_order_id = p.id AND l.deleted_at IS NULL) AS pending_amount
       FROM cf_purchase_orders p LEFT JOIN cf_parties s ON s.id = p.supplier_id
      WHERE p.company_id = ? AND p.id = ? AND p.deleted_at IS NULL FOR UPDATE`,
    [c.companyId, Number(id)],
  );
  if (!p) throw notFound('Purchase order');
  if (blank(input.reason)) throw invalid('REASON', 'Say why the purchase order is closed short.');
  const why = closeShortRefusal(p);
  if (why) throw invalid('NOT_OPEN', why);
  const reason = String(input.reason).trim().slice(0, 500);
  await requestApproval(db, c, {
    type: 'po_close_short', subjectId: p.id, subjectCode: p.code, orderId: p.for_order_id ?? null,
    title: `Close ${p.code} short (${p.supplier_name ?? 'vendor'})`,
    summary: `${fmt(p.pending_qty)} still pending would not come. Reason: ${reason}`.slice(0, 500),
    amount: round2(p.pending_amount), note: reason,
  });
  return getPurchaseOrder(db, c.companyId, p.id);
}

/**
 * CLOSE SHORT (§71) — run when Management approves it (§73). The vendor will not send the rest: what is still
 * pending on each line is RELEASED (qty_closed), every share bought for an order / MR line is cut to what arrived for it
 * (so the PR line's "PO raised" goes down by the unfilled quantity and a new PO can be raised for it), and the PO is
 * closed (status 'received', closed_at, reason). Set-based: 1 read + 4 writes whatever the number of lines.
 */
export async function closePurchaseOrder(db, c, id, input = {}) {
  const [[p]] = await db.query('SELECT * FROM cf_purchase_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, Number(id)]);
  if (!p) throw notFound('Purchase order');
  if (blank(input.reason)) throw invalid('REASON', 'Say why the purchase order is closed short.');
  const why = closeShortRefusal(p);
  if (why) throw invalid('NOT_OPEN', why);
  const reason = String(input.reason).trim().slice(0, 500);
  await db.query(
    `UPDATE cf_purchase_order_lines SET qty_closed = GREATEST(quantity - qty_received, 0)
      WHERE company_id = ? AND purchase_order_id = ? AND deleted_at IS NULL`,
    [c.companyId, p.id],
  );
  await db.query(
    `UPDATE cf_purchase_line_orders a JOIN cf_purchase_order_lines l ON l.id = a.purchase_line_id
        SET a.quantity = a.qty_received
      WHERE a.company_id = ? AND l.purchase_order_id = ? AND a.deleted_at IS NULL AND a.quantity > a.qty_received`,
    [c.companyId, p.id],
  );
  await db.query(
    "UPDATE cf_purchase_orders SET status = 'received', closed_at = NOW(), closed_by = ?, close_reason = ?, notes = ? WHERE company_id = ? AND id = ?",
    [c.userId ?? null, reason, `${p.notes ? `${p.notes}\n` : ''}Closed short: ${reason}`, c.companyId, p.id],
  );
  await closeApprovals(db, c, { subjectType: 'purchase_order', subjectId: p.id, types: ['po_close_short'], status: 'approved' });
  return getPurchaseOrder(db, c.companyId, p.id);
}

/**
 * The Management inbox's view of a PO (approvalService HANDLERS): vendor, lines, rates, amount — and for each line the
 * OTHER vendors' quotes on the PR it was raised from (rate, delivery days), so the approver sees how this one compares.
 * Set-based: 3 reads for any number of POs.
 */
async function poContexts(db, companyId, rows) {
  const out = new Map();
  if (!rows.length) return out;
  const poIds = [...new Set(rows.map((r) => Number(r.subject.id)))];
  const [[heads], [lines], [quotes]] = await Promise.all([
    db.query(
      `SELECT p.id, p.code, p.status, p.po_type, p.expected_date, p.for_order_id, p.supplier_id, p.supplied_by_customer, s.name AS supplier_name, fo.code AS for_code
         FROM cf_purchase_orders p LEFT JOIN cf_parties s ON s.id = p.supplier_id LEFT JOIN cf_sales_orders fo ON fo.id = p.for_order_id
        WHERE p.company_id = ? AND p.id IN (?)`, [companyId, poIds]),
    db.query(
      `SELECT l.id, l.purchase_order_id, l.line_no, l.item_id, l.quantity, l.qty_received, l.uom, l.unit_price, l.expected_date, m.code AS item_code, m.name AS item_name
         FROM cf_purchase_order_lines l JOIN cf_master_records m ON m.id = l.item_id
        WHERE l.company_id = ? AND l.purchase_order_id IN (?) AND l.deleted_at IS NULL ORDER BY l.purchase_order_id, l.line_no, l.id`, [companyId, poIds]),
    // Every quote on the PR line each PO line was raised from (through its share's MR line).
    db.query(
      `SELECT DISTINCT a.purchase_line_id, v.supplier_id, s.name AS supplier_name, q.rate, q.delivery_days, q.remark, br.code AS pr_code
         FROM cf_purchase_line_orders a
         JOIN cf_purchase_order_lines l ON l.id = a.purchase_line_id
         JOIN cf_buy_request_lines bl ON bl.company_id = a.company_id AND bl.requisition_line_id = a.pr_line_id AND bl.deleted_at IS NULL
         JOIN cf_buy_requests br ON br.id = bl.request_id
         JOIN cf_buy_request_quotes q ON q.company_id = bl.company_id AND q.line_id = bl.id AND q.deleted_at IS NULL
         JOIN cf_buy_request_vendors v ON v.id = q.vendor_id AND v.deleted_at IS NULL
         JOIN cf_parties s ON s.id = v.supplier_id
        WHERE a.company_id = ? AND l.purchase_order_id IN (?) AND a.deleted_at IS NULL`, [companyId, poIds]),
  ]);
  const headOf = new Map(heads.map((h) => [Number(h.id), h]));
  for (const r of rows) {
    const h = headOf.get(Number(r.subject.id));
    if (!h) continue;
    const mine = lines.filter((l) => Number(l.purchase_order_id) === Number(h.id)).map((l) => {
      const others = quotes.filter((q) => Number(q.purchase_line_id) === Number(l.id));
      const rate = num(l.unit_price);
      const lowest = others.reduce((m, q) => (m == null || Number(q.rate) < m ? Number(q.rate) : m), null);
      return {
        id: l.id, lineNo: l.line_no, item: { id: l.item_id, code: l.item_code, name: l.item_name, uom: l.uom },
        quantity: Number(l.quantity), received: Number(l.qty_received), pending: round6(Math.max(0, Number(l.quantity) - Number(l.qty_received))),
        rate, amount: rate == null ? null : round2(rate * Number(l.quantity)), expectedDate: planDate(l.expected_date),
        quotes: others.map((q) => ({ supplier: { id: q.supplier_id, name: q.supplier_name }, rate: Number(q.rate), deliveryDays: q.delivery_days == null ? null : Number(q.delivery_days), remark: q.remark ?? null, thisVendor: Number(q.supplier_id) === Number(h.supplier_id), pr: q.pr_code })),
        lowestQuote: lowest,
        // "Lowest" / "₹x above the lowest" — what the approver asks first.
        comparison: lowest == null || rate == null ? 'No other quote on its PR.' : rate <= lowest + 1e-6 ? 'The lowest quote.' : `₹${round2(rate - lowest).toLocaleString('en-IN')} per ${l.uom ?? 'unit'} above the lowest quote.`,
      };
    });
    out.set(r.id, {
      kind: 'purchase_order',
      purchaseOrder: { id: h.id, code: h.code, status: h.status, type: poTypeOf(h.po_type), expectedDate: planDate(h.expected_date), forOrder: h.for_order_id ? { id: h.for_order_id, code: h.for_code } : null },
      vendor: h.supplier_id ? { id: h.supplier_id, name: h.supplier_name } : null,
      lines: mine,
      amount: round2(mine.reduce((t, l) => t + (l.amount ?? 0), 0)),
      pendingAmount: round2(mine.reduce((t, l) => t + (l.rate ?? 0) * l.pending, 0)),
      reason: r.requestNote ?? null,
    });
  }
  return out;
}

/** approvalService handler: a purchase order (or a contractor's) waiting for approval. */
export const poApprovalHandler = {
  onApprove: (db, c, row, note) => approvePurchaseOrder(db, c, row.subject_id, { note }),
  onReject: (db, c, row, note) => rejectPurchaseOrder(db, c, row.subject_id, { note }),
  // Taken back by the buyer: the PO goes back to requested, not placed.
  onWithdraw: (db, c, row) => db.query("UPDATE cf_purchase_orders SET approval_status = NULL WHERE company_id = ? AND id = ? AND approval_status = 'pending'", [c.companyId, row.subject_id]),
  context: poContexts,
};

/** approvalService handler: closing a PO short — the reason is the request's note. */
export const closeShortApprovalHandler = {
  onApprove: (db, c, row) => closePurchaseOrder(db, c, row.subject_id, { reason: row.request_note ?? 'Closed short.' }),
  onReject: async () => null,
  context: poContexts,
};

/**
 * GET /purchase-orders/pending-lines?search=&supplierId= — Inventory › Receive against PO: every line still pending
 * on a PO waiting for goods (approved, or the customer's), with what it is for. 1 read.
 */
export async function pendingLines(db, companyId, q = {}) {
  // Step 6 (§85): a contractor's PO moves by its work order's payments (Accounts), never by a GRN.
  const where = ['p.company_id = ?', 'p.deleted_at IS NULL', "p.status IN ('ordered','partially_received')", 'p.closed_at IS NULL', 'l.quantity > l.qty_received', "p.po_type <> 'contractor'"];
  const args = [companyId];
  if (!blank(q.supplierId)) { where.push('p.supplier_id = ?'); args.push(Number(q.supplierId)); }
  const like = likeOf(q.search);
  if (like) { where.push('(p.code LIKE ? OR s.name LIKE ? OR m.code LIKE ? OR m.name LIKE ?)'); args.push(like, like, like, like); }
  const [rows] = await db.query(
    `SELECT p.id AS po_id, p.code AS po_code, p.status, p.supplied_by_customer, p.po_type, s.id AS supplier_id, s.name AS supplier_name,
            l.id, l.line_no, l.item_id, m.code AS item_code, m.name AS item_name, l.uom, i.tracked_by, l.quantity, l.qty_received,
            COALESCE(l.expected_date, p.expected_date) AS due,
            (SELECT GROUP_CONCAT(DISTINCT o.code ORDER BY o.code SEPARATOR ', ') FROM cf_purchase_line_orders a JOIN cf_sales_orders o ON o.id = a.order_id
              WHERE a.purchase_line_id = l.id AND a.deleted_at IS NULL) AS for_orders
       FROM cf_purchase_orders p
       JOIN cf_purchase_order_lines l ON l.purchase_order_id = p.id AND l.deleted_at IS NULL
       JOIN cf_master_records m ON m.id = l.item_id
       LEFT JOIN cf_item_details i ON i.master_id = l.item_id AND i.deleted_at IS NULL
       LEFT JOIN cf_parties s ON s.id = p.supplier_id
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(l.expected_date, p.expected_date) IS NULL, COALESCE(l.expected_date, p.expected_date), p.id, l.line_no
      LIMIT 500`,
    args,
  );
  return {
    rows: rows.map((r) => ({
      purchaseOrder: { id: r.po_id, code: r.po_code, status: r.status, suppliedByCustomer: !!Number(r.supplied_by_customer ?? 0), type: poTypeOf(r.po_type) },
      supplier: r.supplier_id ? { id: r.supplier_id, name: r.supplier_name } : null,
      line: { id: r.id, lineNo: r.line_no },
      item: { id: r.item_id, code: r.item_code, name: r.item_name, uom: r.uom, trackedBy: r.tracked_by ?? null },
      ordered: Number(r.quantity), received: Number(r.qty_received), pending: outstandingOf(r),
      expectedDate: r.due ? String(r.due instanceof Date ? planDate(r.due) : r.due).slice(0, 10) : null,
      forOrders: r.for_orders ? String(r.for_orders).split(', ') : [],
    })),
  };
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
  // §73: nothing about a cancelled PO waits for Management any more.
  await withdrawApprovals(db, c, { subjectType: 'purchase_order', subjectId: p.id, note: 'The purchase order was cancelled.' });
  /*
   * MATERIAL REQUEST (§66): what the PO was bought for is no longer coming — its shares are DROPPED, so the
   * MR lines they served show that quantity OPEN again on the next read, with no step by anybody (nothing was
   * received: a PO with a receipt cannot be cancelled). The MR and the PO still list them, as cancelled.
   */
  await db.query(
    `UPDATE cf_purchase_line_orders a JOIN cf_purchase_order_lines l ON l.id = a.purchase_line_id
        SET a.deleted_at = NOW()
      WHERE a.company_id = ? AND l.purchase_order_id = ? AND a.deleted_at IS NULL`,
    [c.companyId, p.id],
  );
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
  if (PRE_ORDER_STATUSES.includes(l.po_status)) {
    throw invalid('NOT_ORDERED', l.approval_status === 'pending' ? `${l.po_code} is waiting for Management approval — goods are received once Management approves it.` : `${l.po_code} has not been placed yet — send it for Management approval first.`);
  }
  assertOpen({ status: l.po_status, code: l.po_code }, 'be received');
  const problems = [];
  const left = outstandingOf(l);
  const quantity = readQty(input.quantity ?? left, 'Quantity', problems);
  const theirs = !!Number(l.supplied_by_customer ?? 0);
  // §68: the customer may send MORE than asked — it is theirs, not earmarked, and flagged to go back. A supplier may not.
  if (quantity != null && quantity > left + EPS && !theirs) problems.push(`Only ${fmt(left)} ${l.uom} of this line is still outstanding.`);
  if (blank(input.stockingAreaId)) problems.push('Say which stocking area it went into.');
  // §68: a DIFFERENT item than the line — only on a customer's PO, with a reason, as a plate change for the MD.
  const substitute = blank(input.substituteItemId) ? null : await checkSubstitute(db, c.companyId, l, input, problems);
  const receipt = receiptLineFor(l, { ...input, quantity }, problems);
  if (substitute) { receipt.itemId = substitute.received.id; delete receipt.batchId; delete receipt.batch; }
  if (theirs) {
    /*
     * CUSTOMER-SUPPLIED (§66): what arrives is the CUSTOMER's lot (owner = the customer, for the order the
     * PO serves), never ours and never costed as ours. It is then earmarked to the MR line (holdOnReceipt).
     */
    delete receipt.unitCost;
    const [[a]] = await db.query('SELECT order_id FROM cf_purchase_line_orders WHERE company_id = ? AND purchase_line_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [c.companyId, l.id]);
    receipt.ownerPartyId = l.supplier_id;
    receipt.ownerOrderId = a?.order_id ?? l.for_order_id ?? undefined;
  }
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
  // What was bought for a sales order is held for it as it arrives (init.sql §43) — a substitute too, as the item it is.
  const itemIn = substitute ? substitute.received.id : l.item_id;
  const batchIn = movement.lines?.find((x) => x.item?.id === itemIn)?.batch?.id ?? null;
  const held = await holdOnReceipt(db, c, substitute ? { ...l, item_id: itemIn } : l, quantity, batchIn);
  const sub = substitute ? await recordSubstitute(db, c, { l, check: substitute, quantity, movementId: movement.id, batchId: batchIn }) : null;
  await restate(db, c.companyId, l.purchase_order_id);
  const extra = round6(quantity - held.reduce((t, h) => t + h.quantity, 0));
  return {
    movement, held, order: await getPurchaseOrder(db, c.companyId, l.purchase_order_id),
    ...(sub ? { substitute: sub } : {}),
    // §68: more than the MR asked for stays the customer's, not earmarked — it is on the "to return" list.
    ...(theirs && extra > EPS ? { extra: { quantity: extra, text: `${fmt(extra)} ${l.uom} more than asked — it stays the customer's, not earmarked, and is listed to go back to them.` } } : {}),
  };
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
  // §71: POs waiting for the MD.
  const [[{ pending }]] = await db.query("SELECT COUNT(*) AS pending FROM cf_purchase_orders WHERE company_id = ? AND status IN ('requested','quoting','draft') AND approval_status = 'pending' AND deleted_at IS NULL", [companyId]);
  return { toBuy: short, draftOrders: Number(drafts), awaitingDelivery: Number(awaiting), pendingApproval: Number(pending) };
}
