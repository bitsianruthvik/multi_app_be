/**
 * purchaseRequestService.js — PURCHASE FLOW v3 (init.sql §71, 2026-10-18; contract TM/CF_ERP_BUYING_V2.md "2026-10-18").
 *
 * The user's flow: the MR is raised from the sales order (nesting decides what it needs); from then on everything
 * happens in Purchase.
 *
 *   MR screen   one table: every MR line with Required, In stock (free — ours, or for a customer-supplied MR the
 *               customer's own lots), TAKE FROM STOCK (typed) and To buy (= required − take from stock). Saving
 *               earmarks what is taken (holds on the MR line, the stock check's own claim) or lets it go, and makes /
 *               updates ONE purchase request (PR) for what is to buy. A customer-supplied MR has no PR: what is still
 *               open goes on the customer's ₹0 PO (requisitionService.askCustomer — unchanged behaviour).
 *               "Locked for this order" = the MR line's earmarked cover (held from stock + received on its POs, both
 *               holds; reserved and issued after release) — it moves as GRNs arrive.
 *   PR          the RFQ itself: rows = PR lines (what to buy), columns = vendors. A cell is that vendor's quote for that
 *               line (rate ₹ per the line's unit, delivery days, remark). "PO raised" per line = the quantity on live
 *               POs for its MR line (cf_purchase_line_orders.pr_line_id — never stored on the PR): a PO closed short
 *               cuts its shares to what arrived, so "PO raised" goes down by itself. Status worked out on every read:
 *               open → partly ordered → ordered → closed.
 *   Raise PO    per vendor column: the vendor's quoted lines, quantity ≤ needed − PO raised; one PO line per item at the
 *               quoted rate, the date = today + delivery days; the PO starts PENDING MD APPROVAL. `addToPoId` puts the
 *               lines on that vendor's PO still waiting for approval instead — one PO may serve several PRs / orders;
 *               every PO line keeps which MR line(s) / order it serves (the existing share model), and the receipt
 *               earmarks the stock back to them (purchaseLinkService.holdOnReceipt).
 *
 * Round trips are fixed (no read or write per line).
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { likeOf } from '../lib/listing.js';
import { availability } from './rollOutService.js';
import { lineReadiness, openLines, today as clockToday, OPEN_ORDER_STATUSES } from './materialReadyService.js';
import {
  readRequisitions, syncLines, claimRows, askCustomer, supplyOf, requireOrderRow, SUPPLY_LABEL, heldMessage,
} from './requisitionService.js';
import { getPurchaseOrder, poStage, PO_STAGE_LABEL, askPoApproval } from './purchaseService.js';
import { CURRENCY } from './priceService.js';

const EPS = 1e-6;
const round6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const fmt = (n) => String(Number(Number(n).toFixed(3)));
const nameOf = (it) => it?.code ?? it?.name ?? 'item';
const unitOf = (it) => (it?.uom ? ` ${it.uom}` : '');
const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return x.toISOString().slice(0, 10);
};
/** Orders a purchase can still be made for (as requisitionService). */
const BUYABLE_ORDER_STATUSES = ['draft', 'inquiry', 'quoted', 'confirmed'];
const LIVE_STAGES = new Set(['pending_approval', 'requested', 'waiting', 'part_received']);

export const PR_STATUS_LABEL = { open: 'Open', partly_ordered: 'Partly ordered', ordered: 'Ordered', closed: 'Closed' };
export const PR_LINE_STATUS_LABEL = { open: 'To order', part: 'Partly ordered', ordered: 'Ordered', received: 'Received', none: 'Nothing to buy' };

// --- the MR screen -------------------------------------------------------------------------

/** Active holds on MR lines that were TAKEN FROM STOCK (not received on a PO): Map prLineId -> [{ id, quantity }], newest first. */
async function stockHoldRows(db, companyId, prLineIds, { lock = false } = {}) {
  const out = new Map();
  if (!prLineIds.length) return out;
  const [rows] = await db.query(
    `SELECT id, pr_line_id, quantity FROM cf_stock_reservations
      WHERE company_id = ? AND pr_line_id IN (?) AND status = 'active' AND deleted_at IS NULL AND purchase_line_id IS NULL AND held_for_order_id IS NOT NULL
      ORDER BY id DESC${lock ? ' FOR UPDATE' : ''}`,
    [companyId, prLineIds],
  );
  for (const r of rows) {
    if (!out.has(r.pr_line_id)) out.set(r.pr_line_id, []);
    out.get(r.pr_line_id).push({ id: r.id, quantity: Number(r.quantity) });
  }
  return out;
}

/** One MR line for the screen, from the requisition's own line and what is free in stock. */
function screenLine(l, { free, held, customer }) {
  const live = l.purchase.filter((p) => p.purchaseOrder.status !== 'cancelled');
  const poRaised = round6(live.reduce((t, p) => t + p.quantity, 0));
  const received = round6(live.reduce((t, p) => t + p.received, 0));
  const onOrder = round6(live.reduce((t, p) => t + p.outstanding, 0));
  const heldFromStock = round6(held.reduce((t, h) => t + h.quantity, 0));
  const takeFromStock = round6(l.stockTake ?? heldFromStock);
  const toBuy = round6(Math.max(0, l.need - takeFromStock));
  const locked = round6(l.cover.earmarked ?? l.cover.stock ?? 0);
  // The most that may be typed: what is taken now plus what is free, never past the need less what is on POs.
  const takeMax = round6(Math.max(takeFromStock, Math.min(takeFromStock + free, customer ? l.need : l.need - poRaised)));
  // §71 (2026-10-18): what the screen PRE-FILLS while nobody has chosen yet — min(required, what could be taken: free
  // stock (ours; the customer's lots for theirs) + what is already held from stock), never past the need less what is
  // on POs. A suggestion only: nothing is earmarked until the MR is saved.
  const proposedTake = l.stockTake != null ? null
    : round6(Math.max(0, Math.min(heldFromStock + free, customer ? l.need : l.need - poRaised)));
  const u = unitOf(l.item);
  const sentence = locked + EPS >= l.need && l.need > EPS ? `All ${fmt(l.need)}${u} is locked for this order.`
    : l.need <= EPS ? 'The line no longer needs this.'
      : `${fmt(locked)}${u} of ${fmt(l.need)} locked for this order${onOrder > EPS ? `, ${fmt(onOrder)} still coming on purchase orders` : ''}.`;
  return {
    id: l.id, item: l.item, required: l.need, inStock: round6(free), takeFromStock, takeChosen: l.stockTake != null, proposedTake, heldFromStock, takeMax,
    toBuy, poRaised, received, onOrder, locked, open: l.cover.open, status: l.status, statusLabel: l.statusLabel, sentence,
    purchase: l.purchase,
  };
}

/** The PRs of some MRs, in short: Map requisitionId -> { id, code, status, statusLabel }. */
async function prsOfRequisitions(db, companyId, reqIds) {
  if (!reqIds.length) return new Map();
  const prs = await readPrs(db, companyId, { requisitionIds: reqIds });
  return new Map(prs.map((p) => [p.requisition.id, { id: p.id, code: p.code, status: p.status, statusLabel: p.statusLabel }]));
}

/**
 * GET /material-requests/:id — the MR screen. `R` (lineReadiness) when the caller has it.
 * Reads: the requisition (engine + 4) + holds, availability, the PR — fixed.
 */
export async function mrScreen(db, companyId, id, { R = null } = {}) {
  const [v] = await readRequisitions(db, companyId, { id }, { R });
  if (!v) throw notFound('Material request');
  const customer = v.supply === 'customer';
  const itemIds = [...new Set(v.lines.map((l) => Number(l.item.id)))];
  const [held, av, prOf] = await Promise.all([
    stockHoldRows(db, companyId, v.lines.map((l) => l.id)),
    itemIds.length ? availability(db, companyId, itemIds, { orderId: v.order.id, holds: 'none' }) : new Map(),
    prsOfRequisitions(db, companyId, [v.id]),
  ]);
  const lines = v.lines.map((l) => {
    const a = av.get(Number(l.item.id));
    return screenLine(l, { free: (customer ? a?.theirsFree : a?.free) ?? 0, held: held.get(l.id) ?? [], customer });
  });
  const pos = new Map();
  for (const l of v.lines) for (const p of l.purchase) if (p.purchaseOrder.status !== 'cancelled') pos.set(p.purchaseOrder.id, { ...p.purchaseOrder, supplier: p.supplier });
  const open = OPEN_ORDER_STATUSES.includes(v.order.status);
  // §73: an MR raised before the customer accepted is shared, not released — nothing is taken or bought until approval.
  const heldMr = !!v.heldForAcceptance;
  return {
    id: v.id, code: v.code, supply: v.supply, supplyLabel: v.supplyLabel,
    order: v.order, line: v.line, status: v.status, statusLabel: v.statusLabel, stale: v.stale, needKnown: v.needKnown, needComplete: v.needComplete,
    heldForAcceptance: heldMr,
    canEdit: open && !heldMr,
    reason: heldMr ? heldMessage(v.code) : open ? null : `${v.order.code} is ${v.order.status} — its material request no longer changes.`,
    lines,
    purchaseRequest: prOf.get(v.id) ?? null,
    purchaseOrders: [...pos.values()],
    sentence: customer
      ? 'The customer supplies this material. What is not in their stock here is asked of them on a purchase order (₹0).'
      : 'Take what you can from stock; the rest goes on the purchase request.',
  };
}

/**
 * GET /material-requests?orderId=&search=&open= — every MR, one row each, with its PR. open (default true): of open
 * orders only. Fixed reads (one requisition read for all of them).
 */
export async function listMrs(db, companyId, q = {}) {
  const onlyOpen = !(q.open === false || q.open === 'false' || q.open === '0');
  const views = await readRequisitions(db, companyId, { open: onlyOpen, orderId: blank(q.orderId) ? null : Number(q.orderId), search: q.search });
  const prOf = await prsOfRequisitions(db, companyId, views.map((v) => v.id));
  return {
    rows: views.map((v) => {
      const live = v.lines.filter((l) => l.status !== 'not_needed');
      const lockedLines = live.filter((l) => (l.cover.earmarked ?? 0) + EPS >= l.need).length;
      return {
        id: v.id, code: v.code, supply: v.supply, supplyLabel: v.supplyLabel, order: v.order, line: v.line,
        status: v.status, statusLabel: v.statusLabel, materials: live.length, lockedLines, heldForAcceptance: !!v.heldForAcceptance,
        lockedWords: live.length ? `${lockedLines} of ${live.length} locked` : 'Nothing to buy',
        purchaseRequest: prOf.get(v.id) ?? null, raisedAt: v.raisedAt,
      };
    }),
  };
}

/**
 * PUT /material-requests/:id { lines: [{ lineId, takeFromStock }], customerDate? } — SAVE THE MR.
 *   take from stock up   → hold the extra from free stock for this MR line (ours; the customer's lots for theirs)
 *   take from stock down → let go of that much of what was held from stock (newest first)
 *   then: we buy  → ONE PR, its lines = to buy (required − take from stock), made or updated
 *         customer → what is still open goes on the customer's ₹0 PO (askCustomer; the promised date as on raise)
 * Refused, everything at once: more than is free, more than the need less what is on POs, giving back stock already
 * reserved for production. Writes are set-based.
 */
export async function saveMr(db, c, id, input = {}) {
  const [[head]] = await db.query(
    `SELECT r.id, r.code, r.order_id, r.order_line_id, r.supply, r.held_for_acceptance, o.code AS order_code, o.status AS order_status
       FROM cf_requisitions r JOIN cf_sales_orders o ON o.id = r.order_id WHERE r.company_id = ? AND r.id = ? AND r.deleted_at IS NULL FOR UPDATE`,
    [c.companyId, Number(id)],
  );
  if (!head) throw notFound('Material request');
  if (Number(head.held_for_acceptance)) throw invalid('HELD_FOR_ACCEPTANCE', heldMessage(head.code));
  if (!OPEN_ORDER_STATUSES.includes(head.order_status)) throw invalid('NOT_OPEN', `${head.order_code} is ${head.order_status} — its material request no longer changes.`);
  let R = await lineReadiness(db, c.companyId, { full: true });
  const s = await syncLines(db, c, [head], R.needs);
  if (s.added || s.changed || s.retired) R = await lineReadiness(db, c.companyId, { full: true });
  const screen = await mrScreen(db, c.companyId, head.id, { R });
  const customer = screen.supply === 'customer';
  const byId = new Map(screen.lines.map((l) => [l.id, l]));
  const rows = Array.isArray(input.lines) ? input.lines : [];
  const problems = [];
  const want = new Map();
  for (const [k, r] of rows.entries()) {
    const l = byId.get(Number(r?.lineId));
    if (!l) { problems.push(`Row ${k + 1}: that line is not on ${screen.code}.`); continue; }
    const t = Number(r?.takeFromStock);
    if (blank(r?.takeFromStock) || !Number.isFinite(t) || t < 0) { problems.push(`${nameOf(l.item)}: take from stock is a number, zero or more.`); continue; }
    if (t > l.required + EPS) { problems.push(`${nameOf(l.item)}: the line needs ${fmt(l.required)}${unitOf(l.item)} — take at most that.`); continue; }
    want.set(l.id, round6(t));
  }
  const itemIds = [...new Set(screen.lines.filter((l) => want.has(l.id)).map((l) => Number(l.item.id)))].sort((a, b) => a - b);
  if (itemIds.length) await db.query('SELECT master_id FROM cf_item_details WHERE company_id = ? AND master_id IN (?) ORDER BY master_id FOR UPDATE', [c.companyId, itemIds]);
  const [av, held] = await Promise.all([
    itemIds.length ? availability(db, c.companyId, itemIds, { orderId: head.order_id, holds: 'none' }) : new Map(),
    stockHoldRows(db, c.companyId, [...want.keys()], { lock: true }),
  ]);
  const holdRows = [];
  const releaseAll = [];
  const releasePart = [];
  const takes = [];
  for (const [lineId, t] of want) {
    const l = byId.get(lineId);
    const base = l.takeFromStock;
    const delta = round6(t - base);
    const u = unitOf(l.item);
    if (delta > EPS) {
      if (!customer && t > l.required - l.poRaised + EPS) {
        problems.push(`${nameOf(l.item)}: ${fmt(l.poRaised)}${u} is already on purchase orders — take at most ${fmt(Math.max(0, l.required - l.poRaised))} from stock.`);
        continue;
      }
      const a = av.get(Number(l.item.id));
      const free = round6((customer ? a?.theirsFree : a?.free) ?? 0);
      if (delta > free + EPS) {
        problems.push(`${nameOf(l.item)}: only ${fmt(free)}${u} is free in ${customer ? "the customer's stock" : 'stock'} — ${fmt(delta)} more cannot be taken.`);
        continue;
      }
      const took = claimRows(a, l.item.trackedBy, delta, { theirsOnly: customer });
      if (took.left > EPS) { problems.push(`${nameOf(l.item)}: ${fmt(took.left)}${u} of it sits in lots that cannot be taken (on hold, or not in a storage area).`); continue; }
      for (const x of took.rows) {
        const lot = x.batchId != null ? a.batches.find((b) => b.batchId === x.batchId) : null;
        if (lot) lot.free = round6(lot.free - x.quantity);
        if (lot?.owner === 'theirs') a.theirsFree = round6(a.theirsFree - x.quantity);
        a.free = round6(a.free - x.quantity);
        holdRows.push([c.companyId, head.order_id, l.id, l.item.id, x.batchId, x.quantity, c.userId ?? null]);
      }
    } else if (delta < -EPS) {
      let give = round6(-delta);
      const mine = held.get(l.id) ?? [];
      const have = round6(mine.reduce((tt, h) => tt + h.quantity, 0));
      if (give > have + EPS) {
        problems.push(`${nameOf(l.item)}: only ${fmt(have)}${u} is still held from stock — the rest is already reserved for production. Take at least ${fmt(round6(base - have))}.`);
        continue;
      }
      for (const h of mine) {
        if (give <= EPS) break;
        const g = round6(Math.min(give, h.quantity));
        if (g + EPS >= h.quantity) releaseAll.push(h.id); else releasePart.push([h.id, round6(h.quantity - g)]);
        give = round6(give - g);
      }
    }
    takes.push([l.id, t]);
  }
  assertNoProblems(problems, `${screen.code} cannot be saved.`);
  await insertRows(db, 'cf_stock_reservations', ['company_id', 'held_for_order_id', 'pr_line_id', 'item_id', 'batch_id', 'quantity', 'created_by'], holdRows);
  if (releaseAll.length) await db.query("UPDATE cf_stock_reservations SET status = 'released', closed_at = NOW() WHERE company_id = ? AND id IN (?) AND status = 'active'", [c.companyId, releaseAll]);
  if (releasePart.length) {
    await db.query(`UPDATE cf_stock_reservations SET quantity = CASE id ${releasePart.map(() => 'WHEN ? THEN ?').join(' ')} END WHERE company_id = ? AND id IN (?)`,
      [...releasePart.flat(), c.companyId, releasePart.map((x) => x[0])]);
  }
  if (takes.length) {
    await db.query(`UPDATE cf_requisition_lines SET stock_take = CASE id ${takes.map(() => 'WHEN ? THEN ?').join(' ')} END WHERE company_id = ? AND id IN (?)`,
      [...takes.flat(), c.companyId, takes.map((x) => x[0])]);
  }
  let customerPurchaseOrders = [];
  if (customer) {
    const o = await requireOrderRow(db, c.companyId, head.order_id);
    const lines = await openLines(db, c.companyId, { orderIds: [head.order_id] });
    customerPurchaseOrders = await askCustomer(db, c, o, [head.id], { date: input.customerDate, lines });
  } else {
    const toBuy = new Map(screen.lines.map((l) => [l.id, round6(Math.max(0, l.required - (want.get(l.id) ?? l.takeFromStock)))]));
    await upsertPr(db, c, head, screen.lines, toBuy);
  }
  const out = await mrScreen(db, c.companyId, head.id);
  return { ...out, saved: { held: holdRows.length, released: releaseAll.length + releasePart.length }, customerPurchaseOrders };
}

/** Makes or updates THE PR of an MR: one line per MR line, quantity = to buy. No PR is made while nothing is to buy. */
async function upsertPr(db, c, head, lines, toBuy) {
  const [[pr]] = await db.query('SELECT id FROM cf_buy_requests WHERE company_id = ? AND requisition_id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, head.id]);
  let prId = pr?.id ?? null;
  if (!prId) {
    if (![...toBuy.values()].some((q) => q > EPS)) return null;
    const [ins] = await db.query('INSERT INTO cf_buy_requests (company_id, requisition_id, order_id, created_by) VALUES (?, ?, ?, ?)', [c.companyId, head.id, head.order_id, c.userId ?? null]);
    prId = ins.insertId;
    await db.query("UPDATE cf_buy_requests SET code = CONCAT('PR-', LPAD(id, 6, '0')) WHERE company_id = ? AND id = ?", [c.companyId, prId]);
  }
  const [have] = await db.query('SELECT id, requisition_line_id, quantity FROM cf_buy_request_lines WHERE company_id = ? AND request_id = ? AND deleted_at IS NULL', [c.companyId, prId]);
  const byRl = new Map(have.map((r) => [Number(r.requisition_line_id), r]));
  const inserts = [];
  const updates = [];
  for (const l of lines) {
    const q = toBuy.get(l.id) ?? 0;
    const row = byRl.get(Number(l.id));
    if (!row) { if (q > EPS) inserts.push([c.companyId, prId, l.id, l.item.id, q, l.item.uom ?? null, c.userId ?? null]); }
    else if (Math.abs(Number(row.quantity) - q) > EPS) updates.push([row.id, q]);
  }
  // A PR line whose MR line went away keeps its row at 0 (its quotes and POs stay readable).
  const listed = new Set(lines.map((l) => Number(l.id)));
  for (const r of have) if (!listed.has(Number(r.requisition_line_id)) && Number(r.quantity) > EPS) updates.push([r.id, 0]);
  await insertRows(db, 'cf_buy_request_lines', ['company_id', 'request_id', 'requisition_line_id', 'item_id', 'quantity', 'uom', 'created_by'], inserts);
  if (updates.length) {
    await db.query(`UPDATE cf_buy_request_lines SET quantity = CASE id ${updates.map(() => 'WHEN ? THEN ?').join(' ')} END WHERE company_id = ? AND id IN (?)`,
      [...updates.flat(), c.companyId, updates.map((u) => u[0])]);
  }
  return prId;
}

// --- the PR --------------------------------------------------------------------------------

/**
 * PRs with their lines, vendor columns, quotes and the POs raised. filter: { id?, ids?, requisitionIds?, orderId?, search? }.
 * 6 reads whatever the number of PRs, lines, vendors or POs.
 */
export async function readPrs(db, companyId, filter = {}) {
  const where = ['br.company_id = ?', 'br.deleted_at IS NULL'];
  const args = [companyId];
  if (filter.id != null) { where.push('br.id = ?'); args.push(Number(filter.id)); }
  if (filter.ids) { if (!filter.ids.length) return []; where.push('br.id IN (?)'); args.push(filter.ids); }
  if (filter.requisitionIds) { if (!filter.requisitionIds.length) return []; where.push('br.requisition_id IN (?)'); args.push(filter.requisitionIds); }
  if (filter.orderId != null) { where.push('br.order_id = ?'); args.push(Number(filter.orderId)); }
  const like = likeOf(filter.search);
  if (like) { where.push('(br.code LIKE ? OR r.code LIKE ? OR o.code LIKE ? OR cu.name LIKE ?)'); args.push(like, like, like, like); }
  const [heads] = await db.query(
    `SELECT br.id, br.code, br.requisition_id, br.order_id, br.notes, br.created_at, r.code AS mr_code, r.order_line_id, sl.line_no,
            o.code AS order_code, o.status AS order_status, o.customer_id, cu.name AS customer_name, m.code AS line_item_code, m.name AS line_item_name, sl.description
       FROM cf_buy_requests br
       JOIN cf_requisitions r ON r.id = br.requisition_id
       JOIN cf_sales_orders o ON o.id = br.order_id
       JOIN cf_sales_order_lines sl ON sl.id = r.order_line_id
       LEFT JOIN cf_master_records m ON m.id = sl.item_id
       LEFT JOIN cf_parties cu ON cu.id = o.customer_id
      WHERE ${where.join(' AND ')}
      ORDER BY br.id DESC
      LIMIT 500`,
    args,
  );
  if (!heads.length) return [];
  const ids = heads.map((h) => h.id);
  const [[lines], [vendors], [quotes]] = await Promise.all([
    db.query(
      `SELECT bl.id, bl.request_id, bl.requisition_line_id, bl.item_id, bl.quantity, COALESCE(bl.uom, i.uom) AS uom, i.tracked_by, m.code AS item_code, m.name AS item_name
         FROM cf_buy_request_lines bl
         JOIN cf_master_records m ON m.id = bl.item_id
         LEFT JOIN cf_item_details i ON i.master_id = bl.item_id AND i.deleted_at IS NULL
        WHERE bl.company_id = ? AND bl.request_id IN (?) AND bl.deleted_at IS NULL
        ORDER BY bl.request_id, m.code, bl.id`,
      [companyId, ids],
    ),
    db.query(
      `SELECT v.id, v.request_id, v.position, v.supplier_id, s.code AS supplier_code, s.name AS supplier_name
         FROM cf_buy_request_vendors v JOIN cf_parties s ON s.id = v.supplier_id
        WHERE v.company_id = ? AND v.request_id IN (?) AND v.deleted_at IS NULL
        ORDER BY v.request_id, v.position, v.id`,
      [companyId, ids],
    ),
    db.query(
      'SELECT id, request_id, vendor_id, line_id, rate, delivery_days, remark FROM cf_buy_request_quotes WHERE company_id = ? AND request_id IN (?) AND deleted_at IS NULL',
      [companyId, ids],
    ),
  ]);
  const rlIds = lines.map((l) => l.requisition_line_id);
  const [shares] = rlIds.length ? await db.query(
    `SELECT a.pr_line_id, a.quantity, a.qty_received, l.id AS po_line_id, p.id AS po_id, p.code AS po_code, p.status, p.approval_status, p.closed_at, p.supplier_id, s.name AS supplier_name
       FROM cf_purchase_line_orders a
       JOIN cf_purchase_order_lines l ON l.id = a.purchase_line_id AND l.deleted_at IS NULL
       JOIN cf_purchase_orders p ON p.id = l.purchase_order_id AND p.deleted_at IS NULL
       LEFT JOIN cf_parties s ON s.id = p.supplier_id
      WHERE a.company_id = ? AND a.pr_line_id IN (?) AND a.deleted_at IS NULL AND p.status <> 'cancelled'
      ORDER BY p.id, a.id`,
    [companyId, rlIds],
  ) : [[]];
  const today = clockToday();
  return heads.map((h) => {
    const mine = lines.filter((l) => l.request_id === h.id);
    const pos = new Map();
    const shaped = mine.map((l) => {
      const sh = shares.filter((x) => Number(x.pr_line_id) === Number(l.requisition_line_id));
      const needed = round6(l.quantity);
      const poRaised = round6(sh.reduce((t, x) => t + Number(x.quantity), 0));
      const received = round6(sh.reduce((t, x) => t + Number(x.qty_received), 0));
      const pending = round6(sh.filter((x) => LIVE_STAGES.has(poStage(x))).reduce((t, x) => t + Math.max(0, Number(x.quantity) - Number(x.qty_received)), 0));
      for (const x of sh) {
        const stage = poStage(x);
        if (!pos.has(x.po_id)) pos.set(x.po_id, { id: x.po_id, code: x.po_code, stage, stageLabel: PO_STAGE_LABEL[stage], supplier: x.supplier_id ? { id: x.supplier_id, name: x.supplier_name } : null, lines: [] });
        pos.get(x.po_id).lines.push({ lineId: l.id, quantity: Number(x.quantity), received: Number(x.qty_received) });
      }
      const status = needed <= EPS ? (poRaised > EPS ? 'ordered' : 'none') : received + EPS >= needed ? 'received' : poRaised + EPS >= needed ? 'ordered' : poRaised > EPS ? 'part' : 'open';
      return {
        id: l.id, mrLineId: l.requisition_line_id,
        item: { id: l.item_id, code: l.item_code, name: l.item_name, uom: l.uom ?? null, trackedBy: l.tracked_by ?? null },
        needed, poRaised, received, pending, open: round6(Math.max(0, needed - poRaised)), status, statusLabel: PR_LINE_STATUS_LABEL[status],
      };
    });
    const counted = shaped.filter((l) => l.needed > EPS);
    const status = !counted.length || counted.every((l) => l.received + EPS >= l.needed) ? 'closed'
      : counted.every((l) => l.poRaised + EPS >= l.needed) ? 'ordered'
        : counted.some((l) => l.poRaised > EPS) ? 'partly_ordered' : 'open';
    const cols = vendors.filter((v) => v.request_id === h.id).map((v) => {
      const cells = {};
      for (const q of quotes.filter((x) => x.vendor_id === v.id)) {
        cells[q.line_id] = { rate: Number(q.rate), deliveryDays: q.delivery_days == null ? null : Number(q.delivery_days), remark: q.remark ?? null };
      }
      const raised = [...pos.values()].filter((p) => Number(p.supplier?.id) === Number(v.supplier_id)).map((p) => ({ id: p.id, code: p.code, stage: p.stage, stageLabel: p.stageLabel }));
      return { id: v.id, position: v.position, supplier: { id: v.supplier_id, code: v.supplier_code, name: v.supplier_name }, quotes: cells, purchaseOrders: raised };
    });
    return {
      id: h.id, code: h.code, status, statusLabel: PR_STATUS_LABEL[status], today,
      requisition: { id: h.requisition_id, code: h.mr_code },
      order: { id: h.order_id, code: h.order_code, status: h.order_status, customer: h.customer_id ? { id: h.customer_id, name: h.customer_name } : null },
      line: { id: h.order_line_id, lineNo: h.line_no, name: h.line_item_name ?? h.description ?? `Line ${h.line_no}` },
      canEdit: BUYABLE_ORDER_STATUSES.includes(h.order_status),
      createdAt: h.created_at, notes: h.notes ?? null,
      lines: shaped, vendors: cols, purchaseOrders: [...pos.values()],
      counts: { lines: counted.length, open: counted.filter((l) => l.open > EPS).length, vendors: cols.length },
    };
  });
}

export async function getPr(db, companyId, id) {
  const [p] = await readPrs(db, companyId, { id });
  if (!p) throw notFound('Purchase request');
  return p;
}

/** GET /purchase-requests?status=open|all|<status>&search=&orderId= */
export async function listPrs(db, companyId, q = {}) {
  const status = blank(q.status) ? 'open' : String(q.status);
  const all = await readPrs(db, companyId, { search: q.search, orderId: blank(q.orderId) ? null : Number(q.orderId) });
  const counts = { open: 0, partly_ordered: 0, ordered: 0, closed: 0 };
  for (const p of all) counts[p.status] += 1;
  const rows = all.filter((p) => (status === 'all' ? true : status === 'open' ? p.status !== 'closed' : p.status === status))
    .map((p) => ({
      id: p.id, code: p.code, status: p.status, statusLabel: p.statusLabel, requisition: p.requisition, order: p.order, line: p.line,
      lines: p.counts.lines, toOrder: p.counts.open, vendors: p.vendors.length, purchaseOrders: p.purchaseOrders.map((x) => ({ id: x.id, code: x.code, stage: x.stage })),
      createdAt: p.createdAt,
    }));
  return { rows, counts: { ...counts, notClosed: counts.open + counts.partly_ordered + counts.ordered, all: all.length } };
}

// --- vendor columns and quotes ------------------------------------------------------------------

async function requirePrRow(db, companyId, id, { lock = false } = {}) {
  const [[p]] = await db.query(
    `SELECT br.id, br.code, br.order_id, o.code AS order_code, o.status AS order_status
       FROM cf_buy_requests br JOIN cf_sales_orders o ON o.id = br.order_id
      WHERE br.company_id = ? AND br.id = ? AND br.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, Number(id)],
  );
  if (!p) throw notFound('Purchase request');
  if (lock && !BUYABLE_ORDER_STATUSES.includes(p.order_status)) throw invalid('NOT_OPEN', `${p.order_code} is ${p.order_status} — nothing more is bought for it.`);
  return p;
}
async function requireVendorRow(db, companyId, vendorId, { lock = false } = {}) {
  const [[v]] = await db.query(
    `SELECT v.id, v.request_id, v.supplier_id, s.name AS supplier_name FROM cf_buy_request_vendors v JOIN cf_parties s ON s.id = v.supplier_id
      WHERE v.company_id = ? AND v.id = ? AND v.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, Number(vendorId)],
  );
  if (!v) throw notFound('Vendor column');
  return v;
}
async function requireVendorParty(db, companyId, supplierId, problems) {
  if (blank(supplierId)) { problems.push('Pick the vendor.'); return null; }
  const [[s]] = await db.query('SELECT id, name, is_supplier, status FROM cf_parties WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(supplierId)]);
  if (!s) { problems.push('That vendor does not exist.'); return null; }
  if (!Number(s.is_supplier)) problems.push(`${s.name} is not marked as a supplier.`);
  if (s.status !== 'active') problems.push(`${s.name} is inactive.`);
  return s;
}

/** POST /purchase-requests/:id/vendors { supplierId } — a vendor column, added at the end. */
export async function addVendor(db, c, prId, input = {}) {
  const pr = await requirePrRow(db, c.companyId, prId, { lock: true });
  const problems = [];
  const s = await requireVendorParty(db, c.companyId, input.supplierId, problems);
  assertNoProblems(problems, 'The vendor cannot be added.');
  const [[dup]] = await db.query('SELECT id FROM cf_buy_request_vendors WHERE company_id = ? AND request_id = ? AND supplier_id = ? AND deleted_at IS NULL', [c.companyId, pr.id, s.id]);
  if (dup) throw invalid('DUPLICATE', `${s.name} already has a column on ${pr.code}.`);
  const [[{ n }]] = await db.query('SELECT COALESCE(MAX(position), 0) AS n FROM cf_buy_request_vendors WHERE company_id = ? AND request_id = ? AND deleted_at IS NULL', [c.companyId, pr.id]);
  await db.query('INSERT INTO cf_buy_request_vendors (company_id, request_id, position, supplier_id, created_by) VALUES (?, ?, ?, ?, ?)', [c.companyId, pr.id, Number(n) + 1, s.id, c.userId ?? null]);
  return getPr(db, c.companyId, pr.id);
}

/** The POs a vendor column has raised (its supplier's live POs serving this PR's lines). 1 read. */
async function posOfColumn(db, companyId, requestId, supplierId) {
  const [rows] = await db.query(
    `SELECT DISTINCT p.code FROM cf_buy_request_lines bl
       JOIN cf_purchase_line_orders a ON a.pr_line_id = bl.requisition_line_id AND a.deleted_at IS NULL
       JOIN cf_purchase_order_lines l ON l.id = a.purchase_line_id AND l.deleted_at IS NULL
       JOIN cf_purchase_orders p ON p.id = l.purchase_order_id AND p.deleted_at IS NULL AND p.status <> 'cancelled'
      WHERE bl.company_id = ? AND bl.request_id = ? AND bl.deleted_at IS NULL AND p.supplier_id = ?`,
    [companyId, requestId, supplierId],
  );
  return rows.map((r) => r.code);
}

/** PUT /purchase-request-vendors/:id { supplierId } — another vendor in this column; its quotes stay with the column. */
export async function setVendor(db, c, vendorId, input = {}) {
  const v = await requireVendorRow(db, c.companyId, vendorId, { lock: true });
  const pr = await requirePrRow(db, c.companyId, v.request_id, { lock: true });
  const problems = [];
  const s = await requireVendorParty(db, c.companyId, input.supplierId, problems);
  assertNoProblems(problems, 'The vendor cannot be changed.');
  if (Number(s.id) === Number(v.supplier_id)) return getPr(db, c.companyId, pr.id);
  const raised = await posOfColumn(db, c.companyId, pr.id, v.supplier_id);
  if (raised.length) throw invalid('HAS_PO', `${raised.join(', ')} was raised from ${v.supplier_name}'s column — add another column for a new vendor.`);
  const [[dup]] = await db.query('SELECT id FROM cf_buy_request_vendors WHERE company_id = ? AND request_id = ? AND supplier_id = ? AND deleted_at IS NULL', [c.companyId, pr.id, s.id]);
  if (dup) throw invalid('DUPLICATE', `${s.name} already has a column on ${pr.code}.`);
  await db.query('UPDATE cf_buy_request_vendors SET supplier_id = ? WHERE company_id = ? AND id = ?', [s.id, c.companyId, v.id]);
  return getPr(db, c.companyId, pr.id);
}

/** DELETE /purchase-request-vendors/:id — the column and its quotes go (refused once a PO was raised from it). */
export async function removeVendor(db, c, vendorId) {
  const v = await requireVendorRow(db, c.companyId, vendorId, { lock: true });
  const pr = await requirePrRow(db, c.companyId, v.request_id, { lock: true });
  const raised = await posOfColumn(db, c.companyId, pr.id, v.supplier_id);
  if (raised.length) throw invalid('HAS_PO', `${raised.join(', ')} was raised from ${v.supplier_name}'s column — it stays.`);
  await db.query('UPDATE cf_buy_request_quotes SET deleted_at = NOW() WHERE company_id = ? AND vendor_id = ? AND deleted_at IS NULL', [c.companyId, v.id]);
  await db.query('UPDATE cf_buy_request_vendors SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, v.id]);
  return getPr(db, c.companyId, pr.id);
}

/**
 * PUT /purchase-request-vendors/:id/quotes { quotes: [{ lineId, rate, deliveryDays?, remark? }] } — that vendor's cells.
 * rate blank = no quote (the cell is cleared). 1 read + ≤ 3 writes.
 */
export async function setQuotes(db, c, vendorId, input = {}) {
  const v = await requireVendorRow(db, c.companyId, vendorId, { lock: true });
  const pr = await requirePrRow(db, c.companyId, v.request_id, { lock: true });
  const list = Array.isArray(input.quotes) ? input.quotes : null;
  if (!list?.length) throw invalid('INVALID', 'Send the quotes: { quotes: [{ lineId, rate, deliveryDays?, remark? }] }.');
  const [[lines], [cells]] = await Promise.all([
    db.query(`SELECT bl.id, m.code, m.name FROM cf_buy_request_lines bl JOIN cf_master_records m ON m.id = bl.item_id
               WHERE bl.company_id = ? AND bl.request_id = ? AND bl.deleted_at IS NULL`, [c.companyId, pr.id]),
    db.query('SELECT id, line_id FROM cf_buy_request_quotes WHERE company_id = ? AND vendor_id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, v.id]),
  ]);
  const lineOf = new Map(lines.map((l) => [l.id, l]));
  const cellOf = new Map(cells.map((x) => [x.line_id, x.id]));
  const problems = [];
  const inserts = []; const updates = []; const clears = [];
  const seen = new Set();
  for (const [k, q] of list.entries()) {
    const l = lineOf.get(Number(q?.lineId));
    if (!l) { problems.push(`Row ${k + 1}: that line is not on ${pr.code}.`); continue; }
    if (seen.has(l.id)) { problems.push(`${l.code ?? l.name}: named twice.`); continue; }
    seen.add(l.id);
    if (blank(q?.rate)) { if (cellOf.has(l.id)) clears.push(cellOf.get(l.id)); continue; }
    const rate = Number(q.rate);
    if (!Number.isFinite(rate) || rate < 0) { problems.push(`${l.code ?? l.name}: the rate is a number, zero or more.`); continue; }
    let days = null;
    if (!blank(q?.deliveryDays)) {
      days = Number(q.deliveryDays);
      if (!Number.isInteger(days) || days < 0 || days > 3650) { problems.push(`${l.code ?? l.name}: delivery days is a whole number, zero or more.`); continue; }
    }
    const remark = blank(q?.remark) ? null : String(q.remark).trim().slice(0, 500);
    if (cellOf.has(l.id)) updates.push({ id: cellOf.get(l.id), rate, days, remark });
    else inserts.push([c.companyId, pr.id, v.id, l.id, rate, days, remark, c.userId ?? null]);
  }
  assertNoProblems(problems, `${v.supplier_name}'s quotes cannot be saved.`);
  await insertRows(db, 'cf_buy_request_quotes', ['company_id', 'request_id', 'vendor_id', 'line_id', 'rate', 'delivery_days', 'remark', 'created_by'], inserts);
  if (updates.length) {
    const ids = updates.map((u) => u.id);
    await db.query(
      `UPDATE cf_buy_request_quotes SET rate = CASE id ${updates.map(() => 'WHEN ? THEN ?').join(' ')} END,
              delivery_days = CASE id ${updates.map(() => 'WHEN ? THEN ?').join(' ')} END,
              remark = CASE id ${updates.map(() => 'WHEN ? THEN ?').join(' ')} END
        WHERE company_id = ? AND id IN (?)`,
      [...updates.flatMap((u) => [u.id, u.rate]), ...updates.flatMap((u) => [u.id, u.days]), ...updates.flatMap((u) => [u.id, u.remark]), c.companyId, ids],
    );
  }
  if (clears.length) await db.query('UPDATE cf_buy_request_quotes SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [c.companyId, clears]);
  return getPr(db, c.companyId, pr.id);
}

// --- raising a PO from a vendor column -----------------------------------------------------------

/**
 * POST /purchase-request-vendors/:id/purchase-orders { lines: [{ lineId, quantity }], addToPoId?, notes? }
 * A PO for that vendor with those PR lines at the quoted rates (quantity 0 = skip it; never more than needed − PO raised).
 * Each PO line's date is today + the quote's delivery days. The PO starts PENDING MD APPROVAL. With addToPoId the lines
 * go on that PO instead (same vendor, still waiting for approval): one PO may serve several PRs and orders.
 * Fixed: ~10 reads and ≤ 6 writes.
 */
export async function raisePo(db, c, vendorId, input = {}) {
  const v = await requireVendorRow(db, c.companyId, vendorId, { lock: true });
  const prRow = await requirePrRow(db, c.companyId, v.request_id, { lock: true });
  const pr = await getPr(db, c.companyId, prRow.id);
  const col = pr.vendors.find((x) => x.id === v.id);
  const list = Array.isArray(input.lines) ? input.lines : [];
  const problems = [];
  const picked = [];
  const seen = new Set();
  const today = clockToday();
  for (const [k, r] of list.entries()) {
    const l = pr.lines.find((x) => x.id === Number(r?.lineId));
    if (!l) { problems.push(`Row ${k + 1}: that line is not on ${pr.code}.`); continue; }
    if (seen.has(l.id)) { problems.push(`${nameOf(l.item)}: named twice.`); continue; }
    seen.add(l.id);
    const q = Number(r?.quantity ?? 0);
    if (!Number.isFinite(q) || q < 0) { problems.push(`${nameOf(l.item)}: the quantity is a number, zero or more.`); continue; }
    if (q <= EPS) continue;
    const quote = col?.quotes?.[l.id];
    if (!quote) { problems.push(`${nameOf(l.item)}: ${v.supplier_name} has not quoted for it — enter a rate first.`); continue; }
    if (q > l.open + EPS) { problems.push(`${nameOf(l.item)}: only ${fmt(l.open)}${unitOf(l.item)} is still to order — ${fmt(q)} is more than the PR needs.`); continue; }
    if (l.item.trackedBy === 'individual') { problems.push(`${nameOf(l.item)}: it is tracked unit by unit — no stock is kept of it yet.`); continue; }
    picked.push({ l, q: round6(q), rate: quote.rate, date: quote.deliveryDays == null ? null : addDays(today, quote.deliveryDays) });
  }
  if (!problems.length && !picked.length) problems.push('Give a quantity for at least one line.');
  let expected = null;
  if (!blank(input.expectedDate)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(input.expectedDate))) expected = String(input.expectedDate);
    else problems.push('The expected delivery date needs YYYY-MM-DD.');
  }
  let target = null;
  if (!blank(input.addToPoId)) {
    const [[p]] = await db.query('SELECT * FROM cf_purchase_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, Number(input.addToPoId)]);
    if (!p) problems.push('That purchase order does not exist.');
    else if (Number(p.supplier_id) !== Number(v.supplier_id)) problems.push(`${p.code} is not to ${v.supplier_name}.`);
    else if (p.approval_status !== 'pending' || !['requested', 'quoting', 'draft'].includes(p.status)) problems.push(`${p.code} is not waiting for Management approval any more — raise a new purchase order.`);
    else if (Number(p.supplied_by_customer ?? 0)) problems.push(`${p.code} is the customer's own purchase order.`);
    else target = p;
  }
  assertNoProblems(problems, 'The purchase order cannot be raised.');

  const itemIds = picked.map((x) => Number(x.l.item.id));
  const [items] = await db.query(
    `SELECT m.id, m.status, i.item_type, i.tracked_by, i.uom FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.id IN (?)`,
    [c.companyId, itemIds],
  );
  const itemOf = new Map(items.map((i) => [Number(i.id), i]));
  for (const x of picked) {
    const it = itemOf.get(Number(x.l.item.id));
    if (!it || it.item_type !== 'catalog') problems.push(`${nameOf(x.l.item)}: it is made on its order — only catalog items are bought.`);
    else if (it.status === 'obsolete') problems.push(`${nameOf(x.l.item)}: the item is obsolete.`);
  }
  let existing = new Map();
  if (target) {
    const [rows] = await db.query('SELECT id, item_id, quantity, unit_price, expected_date, line_no FROM cf_purchase_order_lines WHERE company_id = ? AND purchase_order_id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, target.id]);
    existing = new Map(rows.map((r) => [Number(r.item_id), r]));
    for (const x of picked) {
      const e = existing.get(Number(x.l.item.id));
      if (e && e.unit_price != null && Math.abs(Number(e.unit_price) - x.rate) > 1e-4) {
        problems.push(`${nameOf(x.l.item)}: ${target.code} already has it at ₹${Number(e.unit_price)} — the quote here is ₹${x.rate}. Raise a new purchase order for it.`);
      }
    }
  }
  assertNoProblems(problems, 'The purchase order cannot be raised.');

  let poId = target?.id ?? null;
  if (!poId) {
    const notes = blank(input.notes) ? `Raised from ${pr.code} (${pr.requisition.code}).` : String(input.notes).slice(0, 2000);
    // THE PO's EXPECTED DELIVERY DATE: the one typed, else the latest its lines' delivery days give. Each line keeps the
    // date of its own quote when it differs (a blank line date = the PO's).
    const poDate = expected ?? picked.map((x) => x.date).filter(Boolean).sort().at(-1) ?? null;
    const [ins] = await db.query(
      `INSERT INTO cf_purchase_orders (company_id, code, supplier_id, status, suggested, expected_date, notes, for_order_id, supplied_by_customer, po_type, approval_status, created_by)
       VALUES (?, NULL, ?, 'requested', 0, ?, ?, ?, 0, 'material', 'pending', ?)`,
      [c.companyId, v.supplier_id, poDate, notes, pr.order.id, c.userId ?? null],
    );
    poId = ins.insertId;
    await db.query("UPDATE cf_purchase_orders SET code = CONCAT('PO-', LPAD(id, 6, '0')) WHERE company_id = ? AND id = ?", [c.companyId, poId]);
  } else if (target.for_order_id != null && Number(target.for_order_id) !== Number(pr.order.id)) {
    // It serves more than one order now: the header names none (each line's shares say which).
    await db.query('UPDATE cf_purchase_orders SET for_order_id = NULL, notes = CONCAT(COALESCE(notes, \'\'), ?) WHERE company_id = ? AND id = ?',
      [`\nAlso for ${pr.code} (${pr.requisition.code}).`, c.companyId, poId]);
  } else {
    await db.query('UPDATE cf_purchase_orders SET notes = CONCAT(COALESCE(notes, \'\'), ?) WHERE company_id = ? AND id = ?', [`\nAlso for ${pr.code} (${pr.requisition.code}).`, c.companyId, poId]);
  }
  // Lines: new items inserted, items the PO has already grow (and keep the earlier date).
  const fresh = picked.filter((x) => !existing.has(Number(x.l.item.id)));
  const grow = picked.filter((x) => existing.has(Number(x.l.item.id)));
  const startNo = [...existing.values()].reduce((m, r) => Math.max(m, Number(r.line_no)), 0);
  await insertRows(db, 'cf_purchase_order_lines', ['company_id', 'purchase_order_id', 'line_no', 'item_id', 'quantity', 'uom', 'expected_date', 'unit_price', 'currency'],
    fresh.map((x, i) => [c.companyId, poId, startNo + i + 1, x.l.item.id, x.q, x.l.item.uom ?? itemOf.get(Number(x.l.item.id))?.uom ?? 'nos', x.date, x.rate, CURRENCY]));
  if (grow.length) {
    const ids = grow.map((x) => existing.get(Number(x.l.item.id)).id);
    const earlier = (x) => { const e = existing.get(Number(x.l.item.id)); const was = e.expected_date ? String(e.expected_date instanceof Date ? e.expected_date.toISOString() : e.expected_date).slice(0, 10) : null; return !was ? x.date : !x.date ? was : (x.date < was ? x.date : was); };
    await db.query(
      `UPDATE cf_purchase_order_lines SET quantity = quantity + CASE id ${grow.map(() => 'WHEN ? THEN ?').join(' ')} END,
              expected_date = CASE id ${grow.map(() => 'WHEN ? THEN ?').join(' ')} END,
              unit_price = COALESCE(unit_price, CASE id ${grow.map(() => 'WHEN ? THEN ?').join(' ')} END)
        WHERE company_id = ? AND id IN (?)`,
      [...grow.flatMap((x) => [existing.get(Number(x.l.item.id)).id, x.q]), ...grow.flatMap((x) => [existing.get(Number(x.l.item.id)).id, earlier(x)]),
        ...grow.flatMap((x) => [existing.get(Number(x.l.item.id)).id, x.rate]), c.companyId, ids],
    );
  }
  // The shares: each PO line serves the MR line (and order) of its PR line. A share it already has grows.
  const [poLines] = await db.query('SELECT id, item_id FROM cf_purchase_order_lines WHERE company_id = ? AND purchase_order_id = ? AND deleted_at IS NULL', [c.companyId, poId]);
  const lineOfItem = new Map(poLines.map((l) => [Number(l.item_id), l.id]));
  const [had] = await db.query(
    'SELECT id, purchase_line_id, pr_line_id FROM cf_purchase_line_orders WHERE company_id = ? AND purchase_line_id IN (?) AND pr_line_id IN (?) AND deleted_at IS NULL FOR UPDATE',
    [c.companyId, poLines.map((l) => l.id), picked.map((x) => x.l.mrLineId)],
  );
  const shareOf = new Map(had.map((a) => [`${a.purchase_line_id}:${a.pr_line_id}`, a.id]));
  const shareNew = [];
  const shareGrow = [];
  for (const x of picked) {
    const plId = lineOfItem.get(Number(x.l.item.id));
    const k = `${plId}:${x.l.mrLineId}`;
    if (shareOf.has(k)) shareGrow.push([shareOf.get(k), x.q]);
    else shareNew.push([c.companyId, plId, pr.order.id, x.l.mrLineId, x.q, c.userId ?? null]);
  }
  await insertRows(db, 'cf_purchase_line_orders', ['company_id', 'purchase_line_id', 'order_id', 'pr_line_id', 'quantity', 'created_by'], shareNew);
  if (shareGrow.length) {
    await db.query(`UPDATE cf_purchase_line_orders SET quantity = quantity + CASE id ${shareGrow.map(() => 'WHEN ? THEN ?').join(' ')} END WHERE company_id = ? AND id IN (?)`,
      [...shareGrow.flat(), c.companyId, shareGrow.map((s) => s[0])]);
  }
  // §73: a PO waiting for approval is a row of the Management inbox (a new PO, or lines added to one still waiting).
  await askPoApproval(db, c, poId);
  return { purchaseOrder: await getPurchaseOrder(db, c.companyId, poId), purchaseRequest: await getPr(db, c.companyId, pr.id) };
}

/** POs of a vendor still waiting for Management approval — what "Add to an existing PO" offers. 1 read. */
export async function pendingPosOfVendor(db, companyId, vendorId) {
  const v = await requireVendorRow(db, companyId, vendorId);
  const [rows] = await db.query(
    `SELECT id, code FROM cf_purchase_orders WHERE company_id = ? AND supplier_id = ? AND deleted_at IS NULL AND approval_status = 'pending'
        AND status IN ('requested','quoting','draft') AND supplied_by_customer = 0 ORDER BY id DESC LIMIT 20`,
    [companyId, v.supplier_id],
  );
  return { vendor: { id: v.id, supplier: { id: v.supplier_id, name: v.supplier_name } }, purchaseOrders: rows.map((r) => ({ id: r.id, code: r.code })) };
}

export { SUPPLY_LABEL, supplyOf };
