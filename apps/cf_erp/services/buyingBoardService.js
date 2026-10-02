/**
 * buyingBoardService.js — the Buying board, the stage bar on every procurement
 * document, and an order's material through the same stages.
 *
 * USER DECISION (2026-10-02): "Buying board with stages, a stage bar on each
 * document, and the sales order's Buying stage showing its material through the
 * same stages. Documents on the board — no 'by material' view for now."
 *
 * THE STAGES, left to right:
 *   To buy → Requested → Approved → RFQ out → Quotes in → Awarded → Ordered →
 *   Part received → Received   (+ Closed / cancelled behind a toggle)
 *
 * A card is a DOCUMENT and stands in exactly ONE column — where the work on it
 * is now. A document whose work has passed to the next document leaves the
 * board (it shows under Closed with the toggle), so one piece of work is never
 * counted twice in a column total:
 *   - purchase request: draft / submitted / rejected → Requested; approved with
 *     an open line → Approved; approved with every line in an RFQ or on a PO →
 *     passed on (its RFQ / PO carries the work); closed / cancelled → Closed.
 *   - RFQ: draft / sent with no quote → RFQ out ("draft" tag when not sent);
 *     ≥1 quote → Quotes in; an awarded line not on a PO yet → Awarded;
 *     status awarded (every line on a PO) → passed on; closed / cancelled → Closed.
 *   - purchase order: draft → Awarded ("Draft PO", the supplier is chosen and
 *     the order not sent); ordered → Ordered; partially_received → Part received;
 *     received → Received (last 90 days unless includeClosed); cancelled → Closed.
 *   - To buy: ONE summary card — the buy list's rows still to raise
 *     (toRequest > 0), with their estimated cost.
 *
 * LINKS (what joins one document to the next — the only ones that exist):
 *   request line ──cf_rfq_lines.request_line_id──▶ RFQ line
 *   RFQ line ──cf_rfq_lines.purchase_line_id──▶ PO line (create-pos merges two
 *     RFQ lines of one item into ONE PO line, so this is the trace, not the PO
 *     line's own link columns)
 *   request line ──cf_purchase_order_lines.request_line_id──▶ PO line
 *   PO line ──cf_stock_movements.purchase_line_id──▶ receipt (GRN)
 *   sales order ──cf_purchase_request_lines.source.orders[].id──▶ request line
 * GAPS: a PO raised by hand or by "Suggest what to buy" names no sales order (no
 * request line behind it), so the order filter cannot see it; a released buy-list
 * row is per ITEM across every order that wants it, so an order's "to buy" for a
 * shared item is the item's whole shortage (the row says which orders share it).
 *
 * PERFORMANCE (TiDB ~49 ms a round trip): set-based. The board is the buy list
 * (its own fixed handful) in parallel with 4 aggregate reads (requests, RFQ
 * lines, RFQ suppliers, POs) + 1 receipt aggregate; the order filter adds 2
 * reads first (its request lines, then the RFQs / POs they reach) and 1 for its
 * receipts. No per-document loop touches the database, and no subquery sits
 * inside a JOIN … ON (TiDB refuses that) — derived tables and WHERE subqueries only.
 */
import { invalid, notFound } from '../lib/errors.js';
import { likeOf } from '../lib/listing.js';
import { buyList } from './purchaseService.js';
import { CURRENCY, round2 } from './priceService.js';

const EPS = 1e-6;
const round6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const truthy = (v) => v === '1' || v === 1 || v === true || v === 'true';
const parseJson = (v) => {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
};
const DAY = 86_400_000;
/** How long a fully received purchase order stays on the board without includeClosed. */
export const RECEIVED_DAYS = 90;
const CARD_CAP_DEFAULT = 20;
const CARD_CAP_MAX = 100;

/** The stage sequence — the board's columns and every document's stage bar. */
export const BUYING_STAGES = [
  { key: 'to_buy', label: 'To buy', hint: 'Short on the buy list and not in a purchase request or RFQ yet.' },
  { key: 'requested', label: 'Requested', hint: 'Purchase requests being drafted, waiting for approval, or sent back.' },
  { key: 'approved', label: 'Approved', hint: 'Approved requests with lines not yet sent out for quotes.' },
  { key: 'rfq_out', label: 'RFQ out', hint: 'Requests for quotation with suppliers, no price back yet.' },
  { key: 'quotes_in', label: 'Quotes in', hint: 'At least one quote is in — compare and award.' },
  { key: 'awarded', label: 'Awarded', hint: 'Supplier chosen: awarded lines not on a purchase order yet, and draft purchase orders not sent.' },
  { key: 'ordered', label: 'Ordered', hint: 'Purchase orders sent, nothing received yet.' },
  { key: 'part_received', label: 'Part received', hint: 'Some of the order has come in.' },
  { key: 'received', label: 'Received', hint: `Everything has come in (last ${RECEIVED_DAYS} days).` },
];
export const CLOSED_STAGE = { key: 'closed', label: 'Closed / cancelled', hint: 'Cancelled or closed documents, and those whose work has passed to the next document.' };
const STAGE_INDEX = Object.fromEntries(BUYING_STAGES.map((s, i) => [s.key, i]));

/** Where the "N more" link of a column goes: the list screen with its own status chip. */
const MORE_LINK = {
  to_buy: { path: 'buy-list', query: {} },
  requested: { path: 'purchase-requests', query: { status: 'submitted' } },
  approved: { path: 'purchase-requests', query: { status: 'approved' } },
  rfq_out: { path: 'rfqs', query: { status: 'sent' } },
  quotes_in: { path: 'rfqs', query: { status: 'sent' } },
  awarded: { path: 'purchase-orders', query: { status: 'draft' } },
  ordered: { path: 'purchase-orders', query: { status: 'ordered' } },
  part_received: { path: 'purchase-orders', query: { status: 'partially_received' } },
  received: { path: 'purchase-orders', query: { status: 'received' } },
  closed: { path: 'purchase-orders', query: { status: 'cancelled' } },
};

const REQUEST_STATUS_LABEL = { draft: 'Draft', submitted: 'Waiting for approval', approved: 'Approved', rejected: 'Rejected', closed: 'Closed', cancelled: 'Cancelled' };
const RFQ_STATUS_LABEL = { draft: 'Draft', sent: 'Out for quotes', closed: 'Closed', awarded: 'Awarded', cancelled: 'Cancelled' };
const PO_STATUS_LABEL = { draft: 'Draft', ordered: 'Ordered', partially_received: 'Part received', received: 'Received', cancelled: 'Cancelled' };

const daysSince = (at, now) => {
  if (!at) return null;
  const t = at instanceof Date ? at.getTime() : Date.parse(String(at).length === 10 ? `${at}T00:00:00Z` : at);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DAY)) : null;
};
const dueOf = (date, now, done = false) => {
  if (!date) return null;
  const t = Date.parse(`${String(date).slice(0, 10)}T23:59:59Z`);
  return { date: String(date).slice(0, 10), overdue: !done && Number.isFinite(t) && t < now };
};
/** full = every line priced; part = some; none = no price known (never ₹0). */
const valueState = (lines, unpriced) => (lines === 0 || unpriced >= lines ? 'none' : unpriced > 0 ? 'part' : 'full');

// ---------------------------------------------------------------------------
// Stages of one document (pure — the board and the trace share them)
// ---------------------------------------------------------------------------

/**
 * { column, stage, ended } — `column` is where the board puts the card ('closed'
 * for one that left), `stage` the document's own furthest stage (what its stage
 * bar highlights; null for a cancelled one that never got anywhere), `ended`
 * null | 'passed' | 'closed' | 'cancelled'.
 */
export function requestStage(r) {
  const open = Number(r.open_lines ?? 0);
  const passed = Number(r.passed_lines ?? 0);
  if (r.status === 'cancelled') return { column: 'closed', stage: 'requested', ended: 'cancelled' };
  if (r.status === 'closed') return { column: 'closed', stage: 'approved', ended: passed > 0 ? 'passed' : 'closed' };
  if (r.status === 'approved') {
    if (open > 0 || passed === 0) return { column: 'approved', stage: 'approved', ended: null };
    return { column: 'closed', stage: 'approved', ended: 'passed' };
  }
  return { column: 'requested', stage: 'requested', ended: null };
}

export function rfqStage(q) {
  const quotes = Number(q.quotes ?? 0);
  const awardedOpen = Number(q.awarded_open ?? 0);
  const own = awardedOpen > 0 ? 'awarded' : quotes > 0 ? 'quotes_in' : 'rfq_out';
  if (q.status === 'cancelled') return { column: 'closed', stage: own, ended: 'cancelled' };
  if (q.status === 'awarded') return { column: 'closed', stage: 'awarded', ended: 'passed' };
  if (q.status === 'closed') return { column: 'closed', stage: Number(q.on_po ?? 0) > 0 ? 'awarded' : own, ended: Number(q.on_po ?? 0) > 0 ? 'passed' : 'closed' };
  return { column: own, stage: own, ended: null };
}

export function poStage(p) {
  switch (p.status) {
    case 'draft': return { column: 'awarded', stage: 'awarded', ended: null };
    case 'ordered': return { column: 'ordered', stage: 'ordered', ended: null };
    case 'partially_received': return { column: 'part_received', stage: 'part_received', ended: null };
    case 'received': return { column: 'received', stage: 'received', ended: null };
    default: return { column: 'closed', stage: Number(p.received ?? 0) > EPS ? 'part_received' : 'ordered', ended: 'cancelled' };
  }
}

// ---------------------------------------------------------------------------
// Reads — each ONE aggregate statement (RFQs: two, in parallel)
// ---------------------------------------------------------------------------

/** WHERE pieces shared by the three readers. `ids` null = no id filter; [] = nothing. */
function idFilter(where, args, col, ids) {
  if (ids == null) return true;
  if (!ids.length) return false;
  where.push(`${col} IN (?)`);
  args.push(ids);
  return true;
}

/** Purchase requests as cards. */
export async function readRequests(db, companyId, { ids = null, includeClosed = false, like = null, now = Date.now() } = {}) {
  const where = ['r.company_id = ?', 'r.deleted_at IS NULL'];
  const args = [companyId];
  if (!idFilter(where, args, 'r.id', ids)) return [];
  if (!includeClosed) where.push("r.status IN ('draft','submitted','approved','rejected')");
  if (like) {
    where.push(`(r.code LIKE ? OR u.name LIKE ? OR EXISTS (SELECT 1 FROM cf_purchase_request_lines x JOIN cf_master_records m ON m.id = x.item_id
                  WHERE x.request_id = r.id AND x.deleted_at IS NULL AND (m.code LIKE ? OR m.name LIKE ?)))`);
    args.push(like, like, like, like);
  }
  const [rows] = await db.query(
    `SELECT r.id, r.code, r.status, r.needed_by, r.created_at, r.submitted_at, r.decided_at, r.updated_at, r.requested_by, u.name AS requester,
            COUNT(l.id) AS line_count,
            COALESCE(SUM(l.status = 'open'), 0) AS open_lines,
            COALESCE(SUM(l.status IN ('in_rfq','ordered')), 0) AS passed_lines,
            SUM(l.quantity * l.est_unit_price) AS est,
            COALESCE(SUM(l.est_unit_price IS NULL AND l.id IS NOT NULL), 0) AS unpriced
       FROM cf_purchase_requests r
       LEFT JOIN users u ON u.id = r.requested_by
       LEFT JOIN cf_purchase_request_lines l ON l.request_id = r.id AND l.deleted_at IS NULL AND l.status <> 'cancelled'
      WHERE ${where.join(' AND ')}
      GROUP BY r.id, r.code, r.status, r.needed_by, r.created_at, r.submitted_at, r.decided_at, r.updated_at, r.requested_by, u.name`,
    args,
  );
  return rows.map((r) => {
    const st = requestStage(r);
    const lines = Number(r.line_count);
    const unpriced = Number(r.unpriced);
    const vs = valueState(lines, unpriced);
    const since = r.status === 'approved' ? r.decided_at : r.status === 'submitted' ? r.submitted_at : r.status === 'rejected' ? r.decided_at : r.created_at;
    const tags = [];
    if (r.status === 'draft') tags.push('Draft');
    if (r.status === 'submitted') tags.push('Waiting for approval');
    if (r.status === 'rejected') tags.push('Sent back');
    if (r.status === 'approved' && Number(r.passed_lines) > 0 && Number(r.open_lines) > 0) tags.push(`${Number(r.passed_lines)} of ${Number(r.passed_lines) + Number(r.open_lines)} lines passed on`);
    return {
      type: 'request',
      id: r.id,
      code: r.code,
      status: r.status,
      statusLabel: REQUEST_STATUS_LABEL[r.status] ?? r.status,
      column: st.column,
      stage: st.stage,
      ended: st.ended,
      party: { role: 'Asked by', id: r.requested_by ?? null, name: r.requester ?? null },
      items: lines,
      value: vs === 'none' ? null : round2(r.est ?? 0),
      valueState: vs,
      valueBasis: 'estimate',
      unpricedLines: unpriced,
      currency: CURRENCY,
      since: since ?? r.created_at,
      ageDays: daysSince(since ?? r.created_at, now),
      due: dueOf(r.needed_by, now, !!st.ended),
      tags,
      link: `purchase-requests/${r.id}`,
      updatedAt: r.updated_at,
    };
  });
}

/** RFQs as cards: one read of their lines (with prices), one of their suppliers and quotes. */
export async function readRfqs(db, companyId, { ids = null, includeClosed = false, like = null, supplierId = null, now = Date.now() } = {}) {
  const where = ['q.company_id = ?', 'q.deleted_at IS NULL'];
  const args = [companyId];
  if (!idFilter(where, args, 'q.id', ids)) return [];
  if (!includeClosed) where.push("q.status IN ('draft','sent')");
  if (supplierId) {
    where.push('q.id IN (SELECT s0.rfq_id FROM cf_rfq_suppliers s0 WHERE s0.company_id = ? AND s0.supplier_id = ?)');
    args.push(companyId, supplierId);
  }
  if (like) {
    where.push(`(q.code LIKE ? OR q.notes LIKE ?
                 OR q.id IN (SELECT s1.rfq_id FROM cf_rfq_suppliers s1 JOIN cf_parties p1 ON p1.id = s1.supplier_id WHERE s1.company_id = ? AND (p1.name LIKE ? OR p1.code LIKE ?))
                 OR EXISTS (SELECT 1 FROM cf_rfq_lines x JOIN cf_master_records m ON m.id = x.item_id
                             WHERE x.rfq_id = q.id AND x.deleted_at IS NULL AND (m.code LIKE ? OR m.name LIKE ?)))`);
    args.push(like, like, companyId, like, like, like, like);
  }
  const W = where.join(' AND ');
  const [[lines], [sups]] = await Promise.all([
    db.query(
      `SELECT q.id, q.code, q.status, q.quotes_due, q.sent_at, q.created_at, q.updated_at,
              rl.id AS line_id, rl.quantity, rl.awarded_quote_line_id, rl.purchase_line_id,
              prl.est_unit_price, aql.unit_price AS award_price, mq.min_price
         FROM cf_rfqs q
         LEFT JOIN cf_rfq_lines rl ON rl.rfq_id = q.id AND rl.deleted_at IS NULL
         LEFT JOIN cf_purchase_request_lines prl ON prl.id = rl.request_line_id
         LEFT JOIN cf_quote_lines aql ON aql.id = rl.awarded_quote_line_id
         LEFT JOIN (SELECT ql.rfq_line_id, MIN(ql.unit_price) AS min_price
                      FROM cf_quote_lines ql JOIN cf_quotes qt ON qt.id = ql.quote_id AND qt.deleted_at IS NULL
                     WHERE ql.company_id = ? AND ql.unit_price IS NOT NULL
                     GROUP BY ql.rfq_line_id) mq ON mq.rfq_line_id = rl.id
        WHERE ${W}
        ORDER BY q.id, rl.line_no`,
      [companyId, ...args],
    ),
    db.query(
      `SELECT s.rfq_id, s.supplier_id, s.status AS supplier_status, p.name AS supplier_name, qt.id AS quote_id
         FROM cf_rfq_suppliers s
         JOIN cf_rfqs q ON q.id = s.rfq_id
         JOIN cf_parties p ON p.id = s.supplier_id
         LEFT JOIN cf_quotes qt ON qt.rfq_id = s.rfq_id AND qt.supplier_id = s.supplier_id AND qt.deleted_at IS NULL
        WHERE ${W}
        ORDER BY s.rfq_id, s.id`,
      args,
    ),
  ]);
  const byId = new Map();
  for (const l of lines) {
    let e = byId.get(l.id);
    if (!e) {
      e = { head: l, lines: 0, awarded: 0, awardedOpen: 0, onPo: 0, value: 0, unpriced: 0, basis: new Set(), sups: [], quotes: 0 };
      byId.set(l.id, e);
    }
    if (l.line_id == null) continue;
    e.lines++;
    if (l.awarded_quote_line_id) e.awarded++;
    if (l.purchase_line_id) e.onPo++;
    if (l.awarded_quote_line_id && !l.purchase_line_id) e.awardedOpen++;
    // The best price known for the line: what was awarded, else the cheapest quote, else the request's estimate.
    const price = l.award_price != null ? Number(l.award_price) : l.min_price != null ? Number(l.min_price) : l.est_unit_price != null ? Number(l.est_unit_price) : null;
    if (price == null) e.unpriced++;
    else {
      e.value += price * Number(l.quantity);
      e.basis.add(l.award_price != null ? 'awarded' : l.min_price != null ? 'quoted' : 'estimate');
    }
  }
  for (const s of sups) {
    const e = byId.get(s.rfq_id);
    if (!e) continue;
    e.sups.push({ id: s.supplier_id, name: s.supplier_name, status: s.supplier_status, quoted: !!s.quote_id });
    if (s.quote_id) e.quotes++;
  }
  return [...byId.values()].map((e) => {
    const q = e.head;
    const st = rfqStage({ status: q.status, quotes: e.quotes, awarded_open: e.awardedOpen, on_po: e.onPo });
    const vs = valueState(e.lines, e.unpriced);
    const basis = e.basis.has('estimate') ? (e.basis.size > 1 ? 'mixed' : 'estimate') : e.basis.has('quoted') ? 'quoted' : e.basis.has('awarded') ? 'awarded' : 'estimate';
    const tags = [];
    if (q.status === 'draft') tags.push('Draft · not sent');
    if (e.sups.length) tags.push(`${e.quotes} of ${e.sups.length} quoted`);
    else tags.push('No supplier yet');
    if (e.awardedOpen) tags.push(`${e.awardedOpen} awarded, no PO yet`);
    return {
      type: 'rfq',
      id: q.id,
      code: q.code,
      status: q.status,
      statusLabel: RFQ_STATUS_LABEL[q.status] ?? q.status,
      column: st.column,
      stage: st.stage,
      ended: st.ended,
      party: {
        role: e.sups.length === 1 ? 'Supplier' : 'Suppliers',
        id: e.sups.length === 1 ? e.sups[0].id : null,
        name: e.sups.length ? e.sups.map((s) => s.name).join(', ') : null,
      },
      suppliers: e.sups,
      quotes: e.quotes,
      items: e.lines,
      value: vs === 'none' ? null : round2(e.value),
      valueState: vs,
      valueBasis: basis,
      unpricedLines: e.unpriced,
      currency: CURRENCY,
      since: q.sent_at ?? q.created_at,
      ageDays: daysSince(q.sent_at ?? q.created_at, now),
      due: dueOf(q.quotes_due, now, !!st.ended || e.quotes > 0),
      tags,
      link: `rfqs/${q.id}`,
      updatedAt: q.updated_at,
    };
  });
}

/** Purchase orders as cards; receipts (GRNs) counted per order in a parallel read. */
export async function readPurchaseOrders(db, companyId, { ids = null, includeClosed = false, like = null, supplierId = null, now = Date.now() } = {}) {
  const where = ['p.company_id = ?', 'p.deleted_at IS NULL'];
  const args = [companyId];
  if (!idFilter(where, args, 'p.id', ids)) return [];
  if (!includeClosed) {
    // Fully received orders stay for RECEIVED_DAYS, then drop off the board (they are history, not work).
    where.push(`(p.status IN ('draft','ordered','partially_received') OR (p.status = 'received' AND p.updated_at >= ?))`);
    args.push(new Date(now - RECEIVED_DAYS * DAY));
  }
  if (supplierId) { where.push('p.supplier_id = ?'); args.push(supplierId); }
  if (like) {
    where.push(`(p.code LIKE ? OR s.name LIKE ? OR s.code LIKE ? OR EXISTS (SELECT 1 FROM cf_purchase_order_lines x JOIN cf_master_records m ON m.id = x.item_id
                  WHERE x.purchase_order_id = p.id AND x.deleted_at IS NULL AND (m.code LIKE ? OR m.name LIKE ?)))`);
    args.push(like, like, like, like, like);
  }
  const W = where.join(' AND ');
  const [[rows], [grns]] = await Promise.all([
    db.query(
      `SELECT p.id, p.code, p.status, p.suggested, p.expected_date, p.ordered_at, p.created_at, p.updated_at, p.supplier_id, s.name AS supplier_name,
              COUNT(l.id) AS line_count,
              SUM(l.quantity * l.unit_price) AS amount,
              SUM(l.qty_received * l.unit_price) AS amount_received,
              COALESCE(SUM(l.unit_price IS NULL AND l.id IS NOT NULL), 0) AS unpriced,
              COALESCE(SUM(l.quantity), 0) AS ordered,
              COALESCE(SUM(l.qty_received), 0) AS received,
              COALESCE(SUM(l.quote_line_id IS NOT NULL), 0) AS from_quote
         FROM cf_purchase_orders p
         LEFT JOIN cf_parties s ON s.id = p.supplier_id
         LEFT JOIN cf_purchase_order_lines l ON l.purchase_order_id = p.id AND l.deleted_at IS NULL
        WHERE ${W}
        GROUP BY p.id, p.code, p.status, p.suggested, p.expected_date, p.ordered_at, p.created_at, p.updated_at, p.supplier_id, s.name`,
      args,
    ),
    db.query(
      `SELECT l.purchase_order_id AS po_id, COUNT(DISTINCT v.id) AS grns, MAX(v.movement_date) AS last_date
         FROM cf_stock_movements v
         JOIN cf_purchase_order_lines l ON l.id = v.purchase_line_id
         JOIN cf_purchase_orders p ON p.id = l.purchase_order_id
         LEFT JOIN cf_parties s ON s.id = p.supplier_id
        WHERE v.company_id = ? AND v.deleted_at IS NULL AND v.movement_type = 'receipt'
          AND v.reversal_of_id IS NULL AND v.reversed_by_id IS NULL AND p.status IN ('partially_received','received','cancelled')
          AND ${W}
        GROUP BY l.purchase_order_id`,
      [companyId, ...args],
    ),
  ]);
  const grnBy = new Map(grns.map((g) => [g.po_id, g]));
  return rows.map((p) => {
    const st = poStage(p);
    const lines = Number(p.line_count);
    const unpriced = Number(p.unpriced);
    const vs = valueState(lines, unpriced);
    const g = grnBy.get(p.id);
    const tags = [];
    if (p.status === 'draft') tags.push(p.suggested ? 'Suggested draft · not sent' : 'Draft PO · not sent');
    if (p.status === 'draft' && !p.supplier_id) tags.push('No supplier yet');
    if (p.status === 'partially_received') tags.push(`${round6(p.received)} of ${round6(p.ordered)} in`);
    if (g) tags.push(`${Number(g.grns)} ${Number(g.grns) === 1 ? 'receipt' : 'receipts'}`);
    const since = p.status === 'draft' ? p.created_at : p.status === 'ordered' ? (p.ordered_at ?? p.created_at) : (g?.last_date ?? p.updated_at);
    return {
      type: 'po',
      id: p.id,
      code: p.code,
      status: p.status,
      statusLabel: PO_STATUS_LABEL[p.status] ?? p.status,
      column: st.column,
      stage: st.stage,
      ended: st.ended,
      party: { role: 'Supplier', id: p.supplier_id ?? null, name: p.supplier_name ?? null },
      items: lines,
      value: vs === 'none' ? null : round2(p.amount ?? 0),
      valueReceived: vs === 'none' ? null : round2(p.amount_received ?? 0),
      valueState: vs,
      valueBasis: 'ordered',
      unpricedLines: unpriced,
      currency: CURRENCY,
      ordered: round6(p.ordered),
      received: round6(p.received),
      receipts: g ? { count: Number(g.grns), lastDate: g.last_date } : null,
      fromQuote: Number(p.from_quote) > 0,
      since,
      ageDays: daysSince(since, now),
      due: dueOf(p.expected_date, now, ['received', 'cancelled'].includes(p.status)),
      tags,
      link: `purchase-orders/${p.id}`,
      updatedAt: p.updated_at,
    };
  });
}

// ---------------------------------------------------------------------------
// A sales order's documents
// ---------------------------------------------------------------------------

/**
 * The procurement documents a sales order reaches — its request lines (by their
 * buy-list source) and the RFQs and POs those lines went to. 2 reads. The source
 * is JSON; a LIKE on its text narrows the read and the parsed value decides, so
 * nothing here depends on JSON functions behaving alike in MySQL and TiDB.
 */
export async function orderScope(db, companyId, orderId) {
  const oid = Number(orderId);
  const [cands] = await db.query(
    `SELECT id, request_id, source FROM cf_purchase_request_lines
      WHERE company_id = ? AND deleted_at IS NULL AND source IS NOT NULL AND CAST(source AS CHAR) LIKE ?`,
    [companyId, `%${oid}%`],
  );
  const lines = cands.filter((l) => {
    const s = parseJson(l.source);
    return !!s && ((Array.isArray(s.orders) && s.orders.some((o) => Number(o?.id) === oid))
      || (Array.isArray(s.lines) && s.lines.some((x) => Number(x?.orderId) === oid)));
  });
  const requestLineIds = lines.map((l) => l.id);
  const requestIds = [...new Set(lines.map((l) => l.request_id))];
  if (!requestLineIds.length) return { orderId: oid, requestLineIds, requestIds, rfqIds: [], poIds: [] };
  const [edges] = await db.query(
    `SELECT rl.rfq_id, pol.purchase_order_id
       FROM cf_rfq_lines rl
       LEFT JOIN cf_purchase_order_lines pol ON pol.id = rl.purchase_line_id AND pol.deleted_at IS NULL
      WHERE rl.company_id = ? AND rl.deleted_at IS NULL AND rl.request_line_id IN (?)
     UNION ALL
     SELECT NULL AS rfq_id, l.purchase_order_id
       FROM cf_purchase_order_lines l
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.request_line_id IN (?)`,
    [companyId, requestLineIds, companyId, requestLineIds],
  );
  return {
    orderId: oid,
    requestLineIds,
    requestIds,
    rfqIds: [...new Set(edges.map((e) => e.rfq_id).filter(Boolean))],
    poIds: [...new Set(edges.map((e) => e.purchase_order_id).filter(Boolean))],
  };
}

/** Receipts (GRNs) against the given purchase orders. 1 read. */
async function receiptsOf(db, companyId, poIds, { lineIds = null } = {}) {
  if (!poIds.length) return [];
  const [rows] = await db.query(
    `SELECT v.id, v.code, v.movement_date, l.purchase_order_id, p.code AS po_code, SUM(k.quantity) AS quantity
       FROM cf_stock_movements v
       JOIN cf_purchase_order_lines l ON l.id = v.purchase_line_id
       JOIN cf_purchase_orders p ON p.id = l.purchase_order_id
       JOIN cf_stock_ledger k ON k.movement_id = v.id AND k.deleted_at IS NULL
      WHERE v.company_id = ? AND v.deleted_at IS NULL AND v.movement_type = 'receipt' AND l.purchase_order_id IN (?)
        ${lineIds ? 'AND l.id IN (?)' : ''}
      GROUP BY v.id, v.code, v.movement_date, l.purchase_order_id, p.code
      ORDER BY v.movement_date, v.id`,
    lineIds ? [companyId, poIds, lineIds] : [companyId, poIds],
  );
  return rows.map((r) => ({
    id: r.id, code: r.code, date: r.movement_date, quantity: round6(r.quantity),
    purchaseOrder: { id: r.purchase_order_id, code: r.po_code }, link: `movements/${r.id}`,
  }));
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

const sortCards = (key, cards) => {
  const t = (c) => {
    const v = c.since instanceof Date ? c.since.getTime() : Date.parse(c.since ?? '');
    return Number.isFinite(v) ? v : 0;
  };
  // Work in hand: the oldest first, so what is stuck is on top. History: the newest first.
  if (key === 'received' || key === 'closed') return cards.sort((a, b) => t(b) - t(a) || b.id - a.id);
  return cards.sort((a, b) => t(a) - t(b) || a.id - b.id);
};

/** The To buy summary card from buy-list rows (already filtered). */
function toBuyCard(rows, { orderId = null } = {}) {
  const raise = rows.filter((r) => (r.toRequest ?? r.toBuy) > EPS);
  const handled = rows.filter((r) => r.toBuy > EPS && (r.toRequest ?? r.toBuy) <= EPS);
  const priced = raise.filter((r) => r.estUnitPrice != null);
  const value = round2(priced.reduce((t, r) => t + r.estUnitPrice * (r.toRequest ?? r.toBuy), 0));
  const itemIds = new Set(raise.map((r) => r.item.id));
  const unpricedItems = new Set(raise.filter((r) => r.estUnitPrice == null).map((r) => r.item.id)).size;
  return {
    card: itemIds.size ? {
      type: 'to_buy',
      id: 0,
      code: `${itemIds.size} ${itemIds.size === 1 ? 'item' : 'items'} short`,
      status: 'short',
      statusLabel: 'Short',
      column: 'to_buy',
      stage: 'to_buy',
      ended: null,
      party: null,
      items: itemIds.size,
      value: priced.length ? value : null,
      valueState: !priced.length ? 'none' : unpricedItems ? 'part' : 'full',
      valueBasis: 'estimate',
      unpricedLines: unpricedItems,
      currency: CURRENCY,
      since: null,
      ageDays: null,
      due: null,
      tags: [
        ...(handled.length ? [`${new Set(handled.map((r) => r.item.id)).size} more already in a request or RFQ`] : []),
        ...(raise.some((r) => r.planned) ? ['includes planned material'] : []),
      ],
      link: 'buy-list',
    } : null,
    items: itemIds.size,
    value: priced.length ? value : null,
    unpricedItems,
  };
}

/** A buy-list row as the order's Buying stage lists it. */
function buyRowOut(r, orderId) {
  const toRequest = round6(r.toRequest ?? r.toBuy);
  const others = (r.orders ?? []).filter((o) => Number(o.id) !== Number(orderId));
  return {
    item: r.item,
    planned: !!r.planned,
    source: r.source ?? null,
    toBuy: r.toBuy,
    toRequest,
    inRequest: r.inRequest ?? 0,
    inRfq: r.inRfq ?? 0,
    onOrder: r.onOrder ?? 0,
    estUnitPrice: r.estUnitPrice ?? null,
    estCost: r.estUnitPrice == null ? null : round2(r.estUnitPrice * toRequest),
    purchaseRequests: r.purchaseRequests ?? [],
    rfqs: r.rfqs ?? [],
    purchaseOrders: (r.purchaseOrders ?? []).map((p) => ({ id: p.id, code: p.code, status: p.status })),
    sharedWith: orderId ? others.map((o) => ({ id: o.id, code: o.code })) : [],
  };
}

/**
 * GET /buying/board?supplierId=&orderId=&search=&includeClosed=&limit=&withRows=
 * → { stages, columns: [{ key, label, hint, count, value, unpriced, cards, more, moreLink }],
 *     filters, toBuy: { items, value, unpricedItems, rows? }, receipts? (with orderId) }
 * `limit` caps cards per column (default 20, at most 100); `count` and `value`
 * always cover every card of the column.
 */
export async function buyingBoard(db, companyId, q = {}) {
  const now = Date.now();
  const includeClosed = truthy(q.includeClosed);
  const supplierId = blank(q.supplierId) ? null : Number(q.supplierId);
  const orderId = blank(q.orderId) ? null : Number(q.orderId);
  if ((supplierId != null && !Number.isInteger(supplierId)) || (orderId != null && !Number.isInteger(orderId))) {
    throw invalid('BAD_FILTER', 'supplierId and orderId are whole numbers.');
  }
  const like = likeOf(q.search);
  const cap = Math.min(Math.max(Number(q.limit) || CARD_CAP_DEFAULT, 1), CARD_CAP_MAX);
  const withRows = truthy(q.withRows);

  // The buy list has no supplier: with a supplier chosen, To buy stays empty.
  const buyP = supplierId ? Promise.resolve([]) : buyList(db, companyId, { show: 'short', search: q.search });
  const scope = orderId ? await orderScope(db, companyId, orderId) : null;
  const opts = { includeClosed, like, supplierId, now };
  const [buyRows, requests, rfqs, pos, receipts, order, supplier] = await Promise.all([
    buyP,
    // A request names no supplier yet: with a supplier chosen, Requested / Approved stay empty.
    supplierId ? [] : readRequests(db, companyId, { ...opts, ids: scope ? scope.requestIds : null }),
    readRfqs(db, companyId, { ...opts, ids: scope ? scope.rfqIds : null }),
    readPurchaseOrders(db, companyId, { ...opts, ids: scope ? scope.poIds : null }),
    scope ? receiptsOf(db, companyId, scope.poIds) : null,
    orderId ? db.query('SELECT id, code, status FROM cf_sales_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, orderId]).then(([[o]]) => o ?? null) : null,
    supplierId ? db.query('SELECT id, code, name FROM cf_parties WHERE company_id = ? AND id = ?', [companyId, supplierId]).then(([[s]]) => s ?? null) : null,
  ]);
  const forOrder = orderId
    ? buyRows.filter((r) => (r.orders ?? []).some((o) => Number(o.id) === orderId) || Number(r.source?.orderId) === orderId)
    : buyRows;
  const tb = toBuyCard(forOrder, { orderId });

  const cards = [...requests, ...rfqs, ...pos].filter((c) => includeClosed || c.column !== 'closed');
  if (tb.card) cards.push(tb.card);
  const keys = [...BUYING_STAGES, ...(includeClosed ? [CLOSED_STAGE] : [])];
  const columns = keys.map((s) => {
    const all = sortCards(s.key, cards.filter((c) => c.column === s.key));
    const priced = all.filter((c) => c.value != null);
    const shown = all.slice(0, cap);
    const link = MORE_LINK[s.key];
    return {
      key: s.key,
      label: s.label,
      hint: s.hint,
      count: s.key === 'to_buy' ? tb.items : all.length,
      value: priced.length ? round2(priced.reduce((t, c) => t + c.value, 0)) : null,
      unpriced: all.filter((c) => c.valueState !== 'full').length,
      currency: CURRENCY,
      cards: shown,
      more: all.length - shown.length,
      moreLink: link,
    };
  });
  return {
    stages: BUYING_STAGES,
    columns,
    filters: {
      supplier: supplier ? { id: supplier.id, code: supplier.code, name: supplier.name } : null,
      order: order ? { id: order.id, code: order.code, status: order.status } : null,
      search: blank(q.search) ? null : String(q.search).trim(),
      includeClosed,
    },
    toBuy: {
      items: tb.items,
      value: tb.value,
      unpricedItems: tb.unpricedItems,
      currency: CURRENCY,
      ...(withRows ? { rows: forOrder.map((r) => buyRowOut(r, orderId)) } : {}),
    },
    ...(scope ? { receipts, links: { requestLines: scope.requestLineIds.length } } : {}),
    generatedAt: new Date(now).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// The trace: one document's place in the chain
// ---------------------------------------------------------------------------

const TRACE_TYPES = { request: 'request', pr: 'request', 'purchase-request': 'request', rfq: 'rfq', po: 'po', 'purchase-order': 'po' };

/**
 * GET /procurement/trace?type=request|rfq|po&id=
 * → { type, id, document (its card), stages, stage, ended, requests, rfqs,
 *     purchaseOrders, receipts, reached }
 * The documents joined to this one along its LINES (see the header: request
 * line → RFQ line → PO line → receipt), one hop each way — a PO shows the RFQ
 * and request it came from and the receipts against it; an RFQ its requests and
 * the POs it made; a request its RFQs, POs and their receipts. `reached` = the
 * furthest stage any of them stands at. Round trips: 1 (the edges) + 3 cards
 * readers in parallel (RFQs and POs two each) + 1 receipts.
 */
export async function procurementTrace(db, companyId, q = {}) {
  const type = TRACE_TYPES[String(q.type ?? '').toLowerCase()];
  const id = Number(q.id);
  if (!type) throw invalid('BAD_TYPE', 'type is request, rfq or po.');
  if (!Number.isInteger(id) || id <= 0) throw invalid('BAD_ID', 'id is a whole number.');
  const anchor = type === 'request' ? 'prl.request_id' : type === 'rfq' ? 'rl.rfq_id' : 'pol.purchase_order_id';
  const anchor2 = type === 'request' ? 'prl.request_id' : type === 'po' ? 'pol.purchase_order_id' : null;
  const [edges] = await db.query(
    `SELECT prl.request_id, rl.rfq_id, pol.purchase_order_id, pol.id AS po_line_id
       FROM cf_rfq_lines rl
       LEFT JOIN cf_purchase_request_lines prl ON prl.id = rl.request_line_id
       LEFT JOIN cf_purchase_order_lines pol ON pol.id = rl.purchase_line_id AND pol.deleted_at IS NULL
      WHERE rl.company_id = ? AND rl.deleted_at IS NULL AND ${anchor} = ?
     ${anchor2 ? `UNION ALL
     SELECT prl.request_id, NULL AS rfq_id, pol.purchase_order_id, pol.id AS po_line_id
       FROM cf_purchase_order_lines pol
       JOIN cf_purchase_request_lines prl ON prl.id = pol.request_line_id
      WHERE pol.company_id = ? AND pol.deleted_at IS NULL AND ${anchor2} = ?` : ''}`,
    anchor2 ? [companyId, id, companyId, id] : [companyId, id],
  );
  const set = (k) => [...new Set(edges.map((e) => e[k]).filter(Boolean))];
  const requestIds = type === 'request' ? [id] : set('request_id');
  const rfqIds = type === 'rfq' ? [id] : set('rfq_id');
  const poIds = type === 'po' ? [id] : set('purchase_order_id');
  const opts = { includeClosed: true, now: Date.now() };
  const [requests, rfqs, pos, receipts] = await Promise.all([
    readRequests(db, companyId, { ...opts, ids: requestIds }),
    readRfqs(db, companyId, { ...opts, ids: rfqIds }),
    readPurchaseOrders(db, companyId, { ...opts, ids: poIds }),
    // A request or RFQ sees the receipts on ITS lines' PO lines; a PO sees all of its own.
    receiptsOf(db, companyId, poIds, type === 'po' ? {} : { lineIds: set('po_line_id').length ? set('po_line_id') : [0] }),
  ]);
  const doc = (type === 'request' ? requests : type === 'rfq' ? rfqs : pos).find((c) => c.id === id);
  if (!doc) throw notFound(type === 'request' ? 'Purchase request' : type === 'rfq' ? 'RFQ' : 'Purchase order');
  const strip = (c) => ({
    type: c.type, id: c.id, code: c.code, status: c.status, statusLabel: c.statusLabel, stage: c.stage, ended: c.ended,
    party: c.party, items: c.items, value: c.value, valueState: c.valueState, link: c.link,
  });
  const others = [...requests, ...rfqs, ...pos].filter((c) => !(c.type === type && c.id === id) && c.ended !== 'cancelled');
  let reached = doc.ended === 'cancelled' ? null : doc.stage;
  for (const c of others) if (c.stage && (reached == null || STAGE_INDEX[c.stage] > STAGE_INDEX[reached])) reached = c.stage;
  if (receipts.length && pos.some((p) => p.status === 'received') && (reached == null || STAGE_INDEX.received > STAGE_INDEX[reached])) reached = 'received';
  return {
    type,
    id,
    stages: BUYING_STAGES,
    stage: doc.stage,
    ended: doc.ended,
    document: strip(doc),
    requests: requests.filter((c) => !(type === 'request' && c.id === id)).map(strip),
    rfqs: rfqs.filter((c) => !(type === 'rfq' && c.id === id)).map(strip),
    purchaseOrders: pos.filter((c) => !(type === 'po' && c.id === id)).map(strip),
    receipts,
    reached,
  };
}
