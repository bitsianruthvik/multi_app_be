/**
 * procurementService.js — purchase request -> RFQ -> quotes -> comparison ->
 * award -> draft POs (init.sql §39, TM/CF_ERP_PROCUREMENT_PLAN.md).
 *
 * USER DECISIONS (2026-10-01): a purchase request needs ONE approver before it
 * can go for quotes; an RFQ goes out as a document per supplier (print + a ready
 * email the buyer sends from their own mail) and quotes are TYPED in by the buyer.
 * DEFAULTS (Claude): compare and award PER LINE; prices are net of tax (input GST
 * is recoverable, so the comparison ranks on net landed cost); INR; only POs count
 * as "on order".
 *
 * THE LOCK. A request line's status keeps it in ONE open RFQ at a time:
 *   open -> in_rfq (makeRfq, only from an APPROVED request) -> ordered (create-pos)
 *   | cancelled. Closing or cancelling an RFQ puts its un-ordered lines back to open.
 * makeRfq reads the lines FOR UPDATE, so two buyers cannot put one line in two RFQs.
 *
 * SELF-APPROVAL. The person who raised a request cannot approve it unless they are
 * an admin (Claude's choice, 2026-10-01: one approver means a SECOND person; an
 * admin may approve their own because they can grant themselves the permission
 * anyway). Rejecting one's own request is allowed — it is no riskier than cancelling.
 *
 * LANDED COST. A quote's freight is shared over its priced lines by line AMOUNT
 * (unit price x quantity offered); landed unit = unit price + freight share / qty.
 * An expired quote (valid_until before today) is shown, flagged, and never
 * cheapest, fastest or recommended. The recommendation prefers suppliers offering
 * the full quantity and falls back to a part offer only when no full one is valid.
 *
 * PERFORMANCE (TiDB ~49 ms a round trip): list = 1 read; request detail = 3 reads
 * in parallel; RFQ detail = 5 in parallel; comparison = 5 in parallel + 1
 * (last paid); create-pos is set-based (a fixed number of statements plus one code
 * per supplier). No per-line loop touches the database.
 */
import { CfError, invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { countsBy, likeOf, orderBy, pageArgs, pageOf, wantsPage } from '../lib/listing.js';
import { generate } from '../modules/codegen/index.js';
import { buyList, buyEstimates, insertOrder, requireSupplier } from './purchaseService.js';
import { CURRENCY, readPrice, round2, round4, num, lastPricesPaid } from './priceService.js';
import { companyTax } from './taxService.js';
import { todayText } from './invoiceService.js';

export const PR_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'closed', 'cancelled'];
export const PR_LINE_STATUSES = ['open', 'in_rfq', 'ordered', 'cancelled'];
export const RFQ_STATUSES = ['draft', 'sent', 'closed', 'awarded', 'cancelled'];
export const RFQ_SUPPLIER_STATUSES = ['invited', 'sent', 'quoted', 'declined'];

const EPS = 1e-6;
const round6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v, max) => (blank(v) ? null : String(v).trim().slice(0, max));
const EDITABLE = ['draft', 'rejected'];
const RFQ_OPEN = ['draft', 'sent'];
const forbidden = (message) => new CfError(403, 'FORBIDDEN', message);
const userOf = (id, name) => (id ? { id, name: name ?? null } : null);
const EVENT_STATUS = { created: 'draft', submitted: 'submitted', approved: 'approved', rejected: 'rejected', cancelled: 'cancelled', closed: 'closed' };

function readDate(v, label, problems) {
  if (blank(v)) return null;
  const s = String(v).trim().slice(0, 10);
  if (!DATE_RE.test(s)) { problems.push(`${label} needs YYYY-MM-DD.`); return null; }
  return s;
}
function readQty(v, label, problems) {
  const n = Number(typeof v === 'string' ? v.replace(/,/g, '') : v);
  if (!Number.isFinite(n) || n <= 0) { problems.push(`${label} is a number above zero.`); return null; }
  return round6(n);
}
function readMoney(v, label, problems) {
  const p = readPrice(v, label, problems);
  return p == null ? null : round2(p);
}
function readRate(v, label, problems) {
  if (blank(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) { problems.push(`${label} is a percentage from 0 to 100.`); return null; }
  return Math.round(n * 100) / 100;
}
function readDays(v, label, problems) {
  if (blank(v)) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 3650) { problems.push(`${label} is a whole number of days.`); return null; }
  return n;
}
const addDays = (dateText, days) => {
  const d = new Date(`${dateText}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const parseJson = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

/** Items that can be bought — one read for any number. Returns Map id -> item. */
async function requireItems(db, companyId, ids, problems) {
  const want = [...new Set(ids.filter((x) => x != null).map(Number))];
  if (!want.length) return new Map();
  const [rows] = await db.query(
    `SELECT m.id, m.code, m.name, m.status, i.uom, i.tracked_by
       FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.id IN (?) AND m.record_kind = 'item' AND m.deleted_at IS NULL`,
    [companyId, want],
  );
  const out = new Map(rows.map((r) => [r.id, r]));
  for (const id of want) {
    const it = out.get(id);
    if (!it) { problems.push(`Item ${id} does not exist.`); continue; }
    if (it.status === 'obsolete') problems.push(`${it.code ?? it.name} is obsolete.`);
    if (it.tracked_by === 'individual') problems.push(`${it.code ?? it.name} is tracked unit by unit — no stock is kept of it yet.`);
  }
  return out;
}

/** A document number from the code generator, or null (the caller falls back to PREFIX-000123). */
async function nextCode(db, companyId, entity) {
  const g = await generate(db, companyId, entity, 'code', { draft: {} }, { consume: true });
  return g?.text ?? null;
}

async function event(db, c, requestId, action, note = null) {
  await db.query('INSERT INTO cf_purchase_request_events (company_id, request_id, action, note, user_id) VALUES (?, ?, ?, ?, ?)',
    [c.companyId, requestId, action, note, c.userId ?? null]);
}

// ============================================================================
// PURCHASE REQUESTS
// ============================================================================

async function requireRequest(db, companyId, id, { lock = false } = {}) {
  const [[r]] = await db.query(
    `SELECT * FROM cf_purchase_requests WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, Number(id)],
  );
  if (!r) throw notFound('Purchase request');
  return r;
}

function requestAllowed(r, lines, c) {
  const manage = c.canManage !== false;
  const approver = !!c.canApprove;
  const own = r.requested_by != null && Number(r.requested_by) === Number(c.userId);
  const anyInRfq = lines.some((l) => l.status === 'in_rfq');
  return {
    edit: manage && EDITABLE.includes(r.status),
    submit: manage && EDITABLE.includes(r.status) && lines.length > 0,
    approve: approver && r.status === 'submitted' && (!own || !!c.isAdmin),
    reject: approver && r.status === 'submitted',
    cancel: manage && ['draft', 'submitted', 'approved', 'rejected'].includes(r.status) && !anyInRfq,
    makeRfq: manage && r.status === 'approved' && lines.some((l) => l.status === 'open'),
  };
}

/** GET /purchase-requests/:id — 3 reads, in parallel. */
export async function getRequest(db, c, id) {
  const companyId = c.companyId;
  const [[[r]], [lines], [events]] = await Promise.all([
    db.query(
      `SELECT p.*, ru.name AS requester_name, du.name AS decider_name
         FROM cf_purchase_requests p
         LEFT JOIN users ru ON ru.id = p.requested_by
         LEFT JOIN users du ON du.id = p.decided_by
        WHERE p.company_id = ? AND p.id = ? AND p.deleted_at IS NULL`,
      [companyId, Number(id)],
    ),
    // The RFQ a line is in (an open one) or was ordered through, and its PO —
    // a nested join, no subquery in any ON (TiDB).
    db.query(
      `SELECT l.*, m.code AS item_code, m.name AS item_name,
              q.id AS rfq_id, q.code AS rfq_code, q.status AS rfq_status,
              po.id AS po_id, po.code AS po_code
         FROM cf_purchase_request_lines l
         JOIN cf_master_records m ON m.id = l.item_id
         LEFT JOIN (cf_rfq_lines rl JOIN cf_rfqs q ON q.id = rl.rfq_id AND q.deleted_at IS NULL AND q.status <> 'cancelled')
                ON rl.request_line_id = l.id AND rl.deleted_at IS NULL AND (q.status <> 'closed' OR rl.purchase_line_id IS NOT NULL)
         LEFT JOIN cf_purchase_order_lines pl ON pl.id = rl.purchase_line_id
         LEFT JOIN cf_purchase_orders po ON po.id = pl.purchase_order_id AND po.deleted_at IS NULL
        WHERE l.company_id = ? AND l.request_id = ? AND l.deleted_at IS NULL
        ORDER BY l.line_no, l.id, rl.id DESC`,
      [companyId, Number(id)],
    ),
    db.query(
      `SELECT e.action, e.note, e.created_at, e.user_id, u.name AS user_name
         FROM cf_purchase_request_events e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.company_id = ? AND e.request_id = ? ORDER BY e.id`,
      [companyId, Number(id)],
    ),
  ]);
  if (!r) throw notFound('Purchase request');
  const seen = new Set();
  const shaped = [];
  for (const l of lines) {
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    const est = num(l.est_unit_price);
    shaped.push({
      id: l.id,
      lineNo: l.line_no,
      item: { id: l.item_id, code: l.item_code, name: l.item_name, uom: l.uom },
      quantity: Number(l.quantity),
      neededBy: l.needed_by ?? null,
      estUnitPrice: est,
      estAmount: est == null ? null : round2(est * Number(l.quantity)),
      status: l.status,
      source: parseJson(l.source),
      notes: l.notes ?? null,
      rfq: l.rfq_id ? { id: l.rfq_id, code: l.rfq_code, status: l.rfq_status } : null,
      po: l.po_id ? { id: l.po_id, code: l.po_code } : null,
    });
  }
  const priced = shaped.filter((l) => l.estAmount != null);
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    neededBy: r.needed_by ?? null,
    notes: r.notes ?? null,
    requestedBy: userOf(r.requested_by, r.requester_name),
    submittedAt: r.submitted_at ?? null,
    decidedBy: userOf(r.decided_by, r.decider_name),
    decidedAt: r.decided_at ?? null,
    decisionNote: r.decision_note ?? null,
    createdAt: r.created_at,
    currency: CURRENCY,
    estTotal: round2(priced.reduce((t, l) => t + l.estAmount, 0)),
    unpricedLines: shaped.length - priced.length,
    lines: shaped,
    allowed: requestAllowed(r, shaped, c),
    // `by` and `user` are the same person (the FE reads `by`); `status` is the
    // request status the action left it in (created/edited leave it draft).
    history: events.map((e) => ({
      action: e.action,
      status: EVENT_STATUS[e.action] ?? null,
      note: e.note ?? null,
      by: userOf(e.user_id, e.user_name) ?? { id: null, name: null },
      user: userOf(e.user_id, e.user_name),
      at: e.created_at,
    })),
  };
}

const REQUEST_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'closed', 'cancelled'];
const REQUEST_OPEN = ['draft', 'submitted', 'approved'];
/** Columns the Purchase requests screen sorts by on the server. */
const REQUEST_SORT = {
  code: 'p.code', status: 'p.status', lines: 'COUNT(l.id)', estTotal: 'COALESCE(SUM(l.quantity * l.est_unit_price), 0)',
  neededBy: 'p.needed_by', by: 'ru.name',
};

/**
 * GET /purchase-requests?status=&q= — status: open (draft/submitted/approved) | all (default) | <one status>.
 * paged=1 / all=1 add total + counts { status, open, all, estimated, lines, unpricedLines } (the last three over
 * the requests that match everything); without them the answer is { rows } as before.
 */
export async function listRequests(db, companyId, q = {}) {
  const base = ['p.company_id = ?', 'p.deleted_at IS NULL'];
  const args = [companyId];
  const status = blank(q.status) ? 'all' : String(q.status);
  const like = likeOf(q.q ?? q.search);
  if (like) { base.push('(p.code LIKE ? OR p.notes LIKE ? OR ru.name LIKE ?)'); args.push(like, like, like); }
  const where = [...base];
  if (status === 'open') where.push(`p.status IN (${REQUEST_OPEN.map((x) => `'${x}'`).join(',')})`);
  else if (status !== 'all') { where.push('p.status = ?'); args.push(status); }
  // the chip's status is the last arg only when it is a single status
  const rowArgs = args;
  const baseArgs = args.slice(0, args.length - (status !== 'all' && status !== 'open' ? 1 : 0));
  const paged = wantsPage(q);
  const page = paged ? pageArgs(q, { def: 100 }) : null;
  const users = 'LEFT JOIN users ru ON ru.id = p.requested_by';
  const rowSql = `SELECT p.id, p.code, p.status, p.needed_by, p.requested_by, ru.name AS requester_name, p.submitted_at,
            p.decided_by, du.name AS decider_name, p.decided_at, p.created_at,
            COUNT(l.id) AS line_count,
            COALESCE(SUM(l.quantity * l.est_unit_price), 0) AS est_total,
            SUM(CASE WHEN l.id IS NOT NULL AND l.est_unit_price IS NULL THEN 1 ELSE 0 END) AS unpriced
       FROM cf_purchase_requests p
       ${users}
       LEFT JOIN users du ON du.id = p.decided_by
       LEFT JOIN cf_purchase_request_lines l ON l.request_id = p.id AND l.deleted_at IS NULL
      WHERE ${where.join(' AND ')}
      GROUP BY p.id, p.code, p.status, p.needed_by, p.requested_by, ru.name, p.submitted_at, p.decided_by, du.name, p.decided_at, p.created_at
      ORDER BY ${orderBy(q, REQUEST_SORT, 'p.id DESC', 'p.id')}`;
  const [[rows], counted] = await Promise.all([
    paged ? db.query(`${rowSql} LIMIT ? OFFSET ?`, [...rowArgs, page.limit, page.offset]) : db.query(rowSql, rowArgs),
    paged ? Promise.all([
      db.query(`SELECT p.status AS k, COUNT(*) AS n FROM cf_purchase_requests p ${users} WHERE ${base.join(' AND ')} GROUP BY p.status`, baseArgs),
      db.query(
        `SELECT COUNT(DISTINCT p.id) AS n, COUNT(l.id) AS line_total, COALESCE(SUM(l.quantity * l.est_unit_price), 0) AS estimated,
                COALESCE(SUM(CASE WHEN l.id IS NOT NULL AND l.est_unit_price IS NULL THEN 1 ELSE 0 END), 0) AS unpriced
           FROM cf_purchase_requests p ${users}
           LEFT JOIN cf_purchase_request_lines l ON l.request_id = p.id AND l.deleted_at IS NULL
          WHERE ${where.join(' AND ')}`,
        rowArgs,
      ),
    ]) : null,
  ]);
  const shaped = rows.map((p) => ({
      id: p.id,
      code: p.code,
      status: p.status,
      lines: Number(p.line_count),
      estTotal: round2(p.est_total),
      unpricedLines: Number(p.unpriced ?? 0),
      currency: CURRENCY,
      neededBy: p.needed_by ?? null,
      requestedBy: userOf(p.requested_by, p.requester_name),
      submittedAt: p.submitted_at ?? null,
      decidedBy: userOf(p.decided_by, p.decider_name),
      decidedAt: p.decided_at ?? null,
      createdAt: p.created_at,
  }));
  if (!paged) return { rows: shaped };
  const [[byStatus], [[sum]]] = counted;
  const statusCounts = countsBy(byStatus, REQUEST_STATUSES);
  const all = Object.values(statusCounts).reduce((t, n) => t + n, 0);
  const open = REQUEST_OPEN.reduce((t, k) => t + (statusCounts[k] ?? 0), 0);
  return pageOf(shaped, sum.n, page, {
    counts: { status: statusCounts, open, all, estimated: round2(sum.estimated), lines: Number(sum.line_total), unpricedLines: Number(sum.unpriced) },
  });
}

/** Validates request lines in bulk; est price defaults to last paid -> list price. */
async function readRequestLines(db, companyId, input, problems) {
  if (!Array.isArray(input) || !input.length) { problems.push('Add at least one line.'); return []; }
  const items = await requireItems(db, companyId, input.map((l) => l?.itemId), problems);
  const typed = input.map((l, k) => {
    const label = `Line ${k + 1}`;
    if (blank(l?.itemId)) problems.push(`${label}: choose an item.`);
    return {
      itemId: Number(l?.itemId),
      quantity: readQty(l?.quantity, `${label}: quantity`, problems),
      neededBy: readDate(l?.neededBy, `${label}: needed by`, problems),
      estUnitPrice: readPrice(l?.estUnitPrice, `${label}: estimated price`, problems),
      notes: text(l?.notes, 500),
      source: l?.source ?? null,
    };
  });
  if (problems.length) return typed;
  const missing = typed.filter((l) => l.estUnitPrice == null).map((l) => l.itemId);
  const est = missing.length ? await buyEstimates(db, companyId, missing) : new Map();
  return typed.map((l) => ({
    ...l,
    uom: items.get(l.itemId)?.uom ?? 'nos',
    estUnitPrice: l.estUnitPrice ?? est.get(l.itemId)?.unitPrice ?? null,
  }));
}

async function insertRequestLines(db, companyId, requestId, firstLineNo, lines) {
  let no = firstLineNo;
  await insertRows(db, 'cf_purchase_request_lines',
    ['company_id', 'request_id', 'line_no', 'item_id', 'quantity', 'uom', 'needed_by', 'est_unit_price', 'source', 'status', 'notes'],
    lines.map((l) => [companyId, requestId, no++, l.itemId, l.quantity, l.uom, l.neededBy, l.estUnitPrice,
      l.source == null ? null : JSON.stringify(l.source), 'open', l.notes ?? null]));
}

async function insertRequest(db, c, { neededBy, notes }) {
  const code = await nextCode(db, c.companyId, 'purchase_request');
  const [r] = await db.query(
    `INSERT INTO cf_purchase_requests (company_id, code, status, needed_by, notes, requested_by, created_by)
     VALUES (?, ?, 'draft', ?, ?, ?, ?)`,
    [c.companyId, code, neededBy, notes, c.userId ?? null, c.userId ?? null],
  );
  if (!code) await db.query('UPDATE cf_purchase_requests SET code = ? WHERE id = ?', [`PR-${String(r.insertId).padStart(6, '0')}`, r.insertId]);
  await event(db, c, r.insertId, 'created');
  return r.insertId;
}

/** POST /purchase-requests { neededBy, notes, lines: [{ itemId, quantity, neededBy?, estUnitPrice?, notes? }] } */
export async function createRequest(db, c, input = {}) {
  const problems = [];
  const neededBy = readDate(input.neededBy, 'Needed by', problems);
  const lines = await readRequestLines(db, c.companyId, input.lines, problems);
  assertNoProblems(problems, 'The purchase request cannot be raised yet.');
  const id = await insertRequest(db, c, { neededBy, notes: text(input.notes, 5000) });
  await insertRequestLines(db, c.companyId, id, 1, lines);
  return getRequest(db, c, id);
}

/**
 * POST /buy-list/request { rows: [{ itemId, quantity? }] | all: true, neededBy?, notes? }
 *
 * A draft request from the buy list. SKIPS WHAT IS ALREADY BEING HANDLED: per
 * item, the most it takes is the buy list's `toRequest` (toBuy − in RFQ − in
 * request, summed over the item's released and planned rows). A row with no
 * quantity takes all of it; a larger quantity is trimmed to it; an item with
 * nothing left to request is skipped. Each line is priced last paid -> list
 * price and keeps its buy-list source (orders and lines). Returns the new
 * request plus `skipped: [{ itemId, code, reason, requested?, taken? }]`.
 */
export async function requestFromBuyList(db, c, input = {}) {
  const problems = [];
  const neededBy = readDate(input.neededBy, 'Needed by', problems);
  const all = input.all === true || input.all === 'true';
  if (!all && (!Array.isArray(input.rows) || !input.rows.length)) problems.push('Choose rows of the buy list, or all.');
  assertNoProblems(problems);
  const rows = await buyList(db, c.companyId, { show: 'short' });
  const byItem = new Map();
  for (const r of rows) {
    const e = byItem.get(r.item.id) ?? {
      item: r.item, toRequest: 0, estUnitPrice: r.estUnitPrice, orders: new Map(), lines: [], planned: false,
    };
    e.toRequest = round6(e.toRequest + (r.toRequest ?? r.toBuy));
    for (const o of r.orders ?? []) e.orders.set(o.id, o);
    if (r.source) e.lines.push({ orderId: r.source.orderId, orderCode: r.source.orderCode, lineId: r.source.lineId, lineNo: r.source.lineNo });
    if (r.planned) e.planned = true;
    byItem.set(r.item.id, e);
  }
  const skipped = [];
  const take = [];
  const wanted = all
    ? [...byItem.values()].map((e) => ({ itemId: e.item.id, quantity: null }))
    : input.rows.map((r) => ({ itemId: Number(r?.itemId), quantity: r?.quantity }));
  for (const w of wanted) {
    const e = byItem.get(w.itemId);
    if (!e) { skipped.push({ itemId: w.itemId, code: null, reason: 'not short on the buy list' }); continue; }
    if (e.toRequest <= EPS) {
      skipped.push({ itemId: w.itemId, code: e.item.code, reason: 'already in a purchase request or RFQ' });
      continue;
    }
    let qty = e.toRequest;
    if (!blank(w.quantity)) {
      const asked = readQty(w.quantity, `${e.item.code ?? e.item.name}: quantity`, problems);
      if (asked == null) continue;
      if (asked > e.toRequest + EPS) skipped.push({ itemId: w.itemId, code: e.item.code, reason: 'trimmed to what is not already requested', requested: asked, taken: e.toRequest });
      else qty = asked;
    }
    take.push({
      itemId: e.item.id,
      quantity: round6(qty),
      uom: e.item.uom ?? 'nos',
      neededBy: null,
      estUnitPrice: e.estUnitPrice ?? null,
      notes: null,
      source: { from: 'buy_list', planned: e.planned, orders: [...e.orders.values()], lines: e.lines },
    });
  }
  assertNoProblems(problems);
  if (!take.length) {
    throw invalid('NOTHING_TO_REQUEST', 'Nothing to request — every chosen item is already in a purchase request or RFQ, or is not short.', { skipped });
  }
  const id = await insertRequest(db, c, { neededBy, notes: text(input.notes, 5000) ?? 'Raised from the buy list.' });
  await insertRequestLines(db, c.companyId, id, 1, take);
  return { ...(await getRequest(db, c, id)), skipped };
}

function assertEditable(r) {
  if (!EDITABLE.includes(r.status)) throw invalid('NOT_EDITABLE', `${r.code} is ${r.status} — only a draft or a rejected request can be changed.`);
}

/** PUT /purchase-requests/:id { neededBy?, notes? } */
export async function updateRequest(db, c, id, input = {}) {
  const r = await requireRequest(db, c.companyId, id);
  assertEditable(r);
  const problems = [];
  const sets = {};
  if (input.neededBy !== undefined) sets.needed_by = readDate(input.neededBy, 'Needed by', problems);
  if (input.notes !== undefined) sets.notes = text(input.notes, 5000);
  assertNoProblems(problems);
  if (Object.keys(sets).length) {
    await db.query(`UPDATE cf_purchase_requests SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(sets), c.companyId, r.id]);
  }
  return getRequest(db, c, r.id);
}

/** POST /purchase-requests/:id/lines { itemId, quantity, neededBy?, estUnitPrice?, notes? } */
export async function addRequestLine(db, c, id, input = {}) {
  const r = await requireRequest(db, c.companyId, id);
  assertEditable(r);
  const problems = [];
  const lines = await readRequestLines(db, c.companyId, [input], problems);
  assertNoProblems(problems);
  const [[{ n }]] = await db.query('SELECT COALESCE(MAX(line_no), 0) AS n FROM cf_purchase_request_lines WHERE company_id = ? AND request_id = ?', [c.companyId, r.id]);
  await insertRequestLines(db, c.companyId, r.id, Number(n) + 1, lines);
  return getRequest(db, c, r.id);
}

async function requireRequestLine(db, companyId, lineId) {
  const [[l]] = await db.query(
    `SELECT l.*, r.status AS request_status, r.code AS request_code
       FROM cf_purchase_request_lines l JOIN cf_purchase_requests r ON r.id = l.request_id AND r.deleted_at IS NULL
      WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL`,
    [companyId, Number(lineId)],
  );
  if (!l) throw notFound('Purchase request line');
  return l;
}

/** PUT /purchase-request-lines/:id { quantity?, neededBy?, estUnitPrice?, notes? } */
export async function updateRequestLine(db, c, lineId, input = {}) {
  const l = await requireRequestLine(db, c.companyId, lineId);
  assertEditable({ status: l.request_status, code: l.request_code });
  const problems = [];
  const sets = {};
  if (input.quantity !== undefined) sets.quantity = readQty(input.quantity, 'Quantity', problems);
  if (input.neededBy !== undefined) sets.needed_by = readDate(input.neededBy, 'Needed by', problems);
  if (input.estUnitPrice !== undefined) sets.est_unit_price = readPrice(input.estUnitPrice, 'Estimated price', problems);
  if (input.notes !== undefined) sets.notes = text(input.notes, 500);
  assertNoProblems(problems);
  if (Object.keys(sets).length) {
    await db.query(`UPDATE cf_purchase_request_lines SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(sets), c.companyId, l.id]);
  }
  return getRequest(db, c, l.request_id);
}

/** DELETE /purchase-request-lines/:id */
export async function removeRequestLine(db, c, lineId) {
  const l = await requireRequestLine(db, c.companyId, lineId);
  assertEditable({ status: l.request_status, code: l.request_code });
  await db.query('UPDATE cf_purchase_request_lines SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, l.id]);
  return getRequest(db, c, l.request_id);
}

/** POST /purchase-requests/:id/submit — draft or rejected -> submitted. */
export async function submitRequest(db, c, id) {
  const r = await requireRequest(db, c.companyId, id, { lock: true });
  if (!EDITABLE.includes(r.status)) throw invalid('NOT_EDITABLE', `${r.code} is ${r.status} — only a draft or a rejected request can be submitted.`);
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM cf_purchase_request_lines WHERE company_id = ? AND request_id = ? AND deleted_at IS NULL', [c.companyId, r.id]);
  if (!Number(n)) throw invalid('NO_LINES', 'Add at least one line before submitting.');
  await db.query(
    `UPDATE cf_purchase_requests SET status = 'submitted', submitted_at = NOW(), decided_by = NULL, decided_at = NULL, decision_note = NULL
      WHERE company_id = ? AND id = ?`,
    [c.companyId, r.id],
  );
  await event(db, c, r.id, 'submitted');
  return getRequest(db, c, r.id);
}

/** POST /purchase-requests/:id/approve { note? } — needs cf_erp_purchase_approve; not one's own unless admin. */
export async function approveRequest(db, c, id, input = {}) {
  if (!c.canApprove) throw forbidden('Approving a purchase request needs the approve permission (cf_erp_purchase_approve).');
  const r = await requireRequest(db, c.companyId, id, { lock: true });
  if (r.status !== 'submitted') throw invalid('NOT_SUBMITTED', `${r.code} is ${r.status} — only a submitted request can be approved.`);
  if (r.requested_by != null && Number(r.requested_by) === Number(c.userId) && !c.isAdmin) {
    throw forbidden(`You raised ${r.code} — somebody else has to approve it.`);
  }
  const note = text(input.note, 500);
  await db.query(
    "UPDATE cf_purchase_requests SET status = 'approved', decided_by = ?, decided_at = NOW(), decision_note = ? WHERE company_id = ? AND id = ?",
    [c.userId ?? null, note, c.companyId, r.id],
  );
  await event(db, c, r.id, 'approved', note);
  return getRequest(db, c, r.id);
}

/** POST /purchase-requests/:id/reject { note } — the note is required. */
export async function rejectRequest(db, c, id, input = {}) {
  if (!c.canApprove) throw forbidden('Rejecting a purchase request needs the approve permission (cf_erp_purchase_approve).');
  const r = await requireRequest(db, c.companyId, id, { lock: true });
  if (r.status !== 'submitted') throw invalid('NOT_SUBMITTED', `${r.code} is ${r.status} — only a submitted request can be rejected.`);
  const note = text(input.note, 500);
  if (!note) throw invalid('NOTE_REQUIRED', 'Say why it is rejected — the requester sees the note.');
  await db.query(
    "UPDATE cf_purchase_requests SET status = 'rejected', decided_by = ?, decided_at = NOW(), decision_note = ? WHERE company_id = ? AND id = ?",
    [c.userId ?? null, note, c.companyId, r.id],
  );
  await event(db, c, r.id, 'rejected', note);
  return getRequest(db, c, r.id);
}

/**
 * POST /purchase-requests/:id/cancel { note? } — open lines are cancelled. Refused
 * while a line is in an RFQ (close or cancel the RFQ first). A request with some
 * lines already ordered ends `closed`, otherwise `cancelled`.
 */
export async function cancelRequest(db, c, id, input = {}) {
  const r = await requireRequest(db, c.companyId, id, { lock: true });
  if (!['draft', 'submitted', 'approved', 'rejected'].includes(r.status)) throw invalid('NOT_OPEN', `${r.code} is already ${r.status}.`);
  const [lines] = await db.query('SELECT status FROM cf_purchase_request_lines WHERE company_id = ? AND request_id = ? AND deleted_at IS NULL', [c.companyId, r.id]);
  if (lines.some((l) => l.status === 'in_rfq')) throw invalid('IN_RFQ', `Some lines of ${r.code} are in an RFQ — close or cancel the RFQ first.`);
  const status = lines.some((l) => l.status === 'ordered') ? 'closed' : 'cancelled';
  await db.query("UPDATE cf_purchase_request_lines SET status = 'cancelled' WHERE company_id = ? AND request_id = ? AND status = 'open' AND deleted_at IS NULL", [c.companyId, r.id]);
  await db.query('UPDATE cf_purchase_requests SET status = ? WHERE company_id = ? AND id = ?', [status, c.companyId, r.id]);
  await event(db, c, r.id, status === 'closed' ? 'closed' : 'cancelled', text(input.note, 500));
  return getRequest(db, c, r.id);
}

/**
 * Closes every request (of these ids) that is approved and has no open or in-RFQ
 * line left — everything ordered or cancelled. 2 statements + 1 for the events.
 */
async function closeFinishedRequests(db, c, requestIds) {
  const ids = [...new Set(requestIds.filter(Boolean))];
  if (!ids.length) return [];
  const [done] = await db.query(
    `SELECT r.id FROM cf_purchase_requests r
      WHERE r.company_id = ? AND r.id IN (?) AND r.status = 'approved' AND r.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM cf_purchase_request_lines l
                         WHERE l.request_id = r.id AND l.deleted_at IS NULL AND l.status IN ('open','in_rfq'))`,
    [c.companyId, ids],
  );
  if (!done.length) return [];
  const closed = done.map((d) => d.id);
  await db.query("UPDATE cf_purchase_requests SET status = 'closed' WHERE company_id = ? AND id IN (?)", [c.companyId, closed]);
  await insertRows(db, 'cf_purchase_request_events', ['company_id', 'request_id', 'action', 'note', 'user_id'],
    closed.map((rid) => [c.companyId, rid, 'closed', 'Every line is ordered or cancelled.', c.userId ?? null]));
  return closed;
}

// ============================================================================
// RFQs
// ============================================================================

async function requireRfq(db, companyId, id, { lock = false } = {}) {
  const [[q]] = await db.query(
    `SELECT * FROM cf_rfqs WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, Number(id)],
  );
  if (!q) throw notFound('RFQ');
  return q;
}

function assertRfqOpen(q, what = 'change') {
  if (!RFQ_OPEN.includes(q.status)) throw invalid('RFQ_NOT_OPEN', `${q.code} is ${q.status} — nothing more can ${what}.`);
}

/**
 * POST /rfqs { requestLineIds: [...] | requestId, quotesDue?, terms?, notes?, supplierIds? }
 * Only lines of an APPROVED request that are still open (not in another RFQ) —
 * read FOR UPDATE, so a line cannot land in two RFQs. requestId takes every
 * open line of that request.
 */
export async function createRfq(db, c, input = {}) {
  const problems = [];
  const quotesDue = readDate(input.quotesDue, 'Quotes due', problems);
  const byIds = Array.isArray(input.requestLineIds) && input.requestLineIds.length;
  if (!byIds && blank(input.requestId)) problems.push('Choose the approved request lines to ask quotes for.');
  assertNoProblems(problems);
  const ids = byIds ? [...new Set(input.requestLineIds.map(Number))] : null;
  const [lines] = await db.query(
    `SELECT l.*, r.status AS request_status, r.code AS request_code, r.needed_by AS request_needed_by, m.code AS item_code
       FROM cf_purchase_request_lines l
       JOIN cf_purchase_requests r ON r.id = l.request_id AND r.deleted_at IS NULL
       JOIN cf_master_records m ON m.id = l.item_id
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND ${byIds ? 'l.id IN (?)' : 'l.request_id = ?'}
      ORDER BY l.request_id, l.line_no, l.id
      FOR UPDATE`,
    [c.companyId, byIds ? ids : Number(input.requestId)],
  );
  let use = lines;
  if (byIds) {
    const found = new Set(lines.map((l) => l.id));
    for (const id of ids) if (!found.has(id)) problems.push(`Request line ${id} does not exist.`);
    for (const l of lines) {
      const name = `${l.request_code} line ${l.line_no} (${l.item_code})`;
      if (l.request_status !== 'approved') problems.push(`${name}: the request is ${l.request_status} — only an approved request can go for quotes.`);
      else if (l.status === 'in_rfq') problems.push(`${name} is already in an RFQ.`);
      else if (l.status !== 'open') problems.push(`${name} is ${l.status}.`);
    }
  } else {
    if (!lines.length) problems.push('That request has no lines.');
    else if (lines[0].request_status !== 'approved') problems.push(`${lines[0].request_code} is ${lines[0].request_status} — only an approved request can go for quotes.`);
    use = lines.filter((l) => l.status === 'open');
    if (!problems.length && !use.length) problems.push(`Every line of ${lines[0].request_code} is already in an RFQ, ordered or cancelled.`);
  }
  assertNoProblems(problems, 'The RFQ cannot be made.');
  const code = await nextCode(db, c.companyId, 'rfq');
  const [ins] = await db.query(
    `INSERT INTO cf_rfqs (company_id, code, status, quotes_due, terms, notes, created_by) VALUES (?, ?, 'draft', ?, ?, ?, ?)`,
    [c.companyId, code, quotesDue, text(input.terms, 10000), text(input.notes, 5000), c.userId ?? null],
  );
  const rfqId = ins.insertId;
  if (!code) await db.query('UPDATE cf_rfqs SET code = ? WHERE id = ?', [`RFQ-${String(rfqId).padStart(6, '0')}`, rfqId]);
  let no = 1;
  await insertRows(db, 'cf_rfq_lines', ['company_id', 'rfq_id', 'line_no', 'request_line_id', 'item_id', 'quantity', 'uom', 'needed_by'],
    use.map((l) => [c.companyId, rfqId, no++, l.id, l.item_id, l.quantity, l.uom, l.needed_by ?? l.request_needed_by ?? null]));
  await db.query("UPDATE cf_purchase_request_lines SET status = 'in_rfq' WHERE company_id = ? AND id IN (?)", [c.companyId, use.map((l) => l.id)]);
  if (Array.isArray(input.supplierIds) && input.supplierIds.length) {
    await addSuppliersBulk(db, c, rfqId, input.supplierIds.map((s) => ({ supplierId: s })));
  }
  return getRfq(db, c, rfqId);
}

function rfqAllowed(q, lines, quotes, c) {
  const manage = c.canManage !== false;
  const open = RFQ_OPEN.includes(q.status);
  const anyOrdered = lines.some((l) => l.po);
  const awardedNotOrdered = lines.some((l) => l.awardedQuoteLineId && !l.po);
  return {
    edit: manage && open,
    addSupplier: manage && open,
    enterQuote: manage && open,
    quote: manage && open,                 // the same as enterQuote (the FE's name)
    award: manage && open && quotes.length > 0,
    createPos: manage && open && awardedNotOrdered,
    close: manage && ['draft', 'sent', 'awarded'].includes(q.status),
    cancel: manage && open && !anyOrdered,
  };
}

/** GET /rfqs/:id — 5 reads, in parallel. */
export async function getRfq(db, c, id) {
  const companyId = c.companyId;
  const rid = Number(id);
  const [[[q]], [lines], [sups], [quotes], [qlines]] = await Promise.all([
    db.query(
      'SELECT r.*, u.name AS creator_name FROM cf_rfqs r LEFT JOIN users u ON u.id = r.created_by WHERE r.company_id = ? AND r.id = ? AND r.deleted_at IS NULL',
      [companyId, rid],
    ),
    db.query(
      `SELECT rl.*, m.code AS item_code, m.name AS item_name, pl.request_id, pr.code AS request_code,
              aq.supplier_id AS award_supplier_id, ap.name AS award_supplier_name, aql.unit_price AS award_unit_price,
              pol.purchase_order_id AS po_id, po.code AS po_code, po.supplier_id AS po_supplier_id, pop.name AS po_supplier_name
         FROM cf_rfq_lines rl
         JOIN cf_master_records m ON m.id = rl.item_id
         LEFT JOIN cf_purchase_request_lines pl ON pl.id = rl.request_line_id
         LEFT JOIN cf_purchase_requests pr ON pr.id = pl.request_id
         LEFT JOIN cf_quote_lines aql ON aql.id = rl.awarded_quote_line_id
         LEFT JOIN cf_quotes aq ON aq.id = aql.quote_id
         LEFT JOIN cf_parties ap ON ap.id = aq.supplier_id
         LEFT JOIN cf_purchase_order_lines pol ON pol.id = rl.purchase_line_id
         LEFT JOIN cf_purchase_orders po ON po.id = pol.purchase_order_id
         LEFT JOIN cf_parties pop ON pop.id = po.supplier_id
        WHERE rl.company_id = ? AND rl.rfq_id = ? AND rl.deleted_at IS NULL
        ORDER BY rl.line_no, rl.id`,
      [companyId, rid],
    ),
    db.query(
      `SELECT s.*, p.code AS supplier_code, p.name AS supplier_name, p.email AS supplier_email
         FROM cf_rfq_suppliers s JOIN cf_parties p ON p.id = s.supplier_id
        WHERE s.company_id = ? AND s.rfq_id = ? ORDER BY s.id`,
      [companyId, rid],
    ),
    db.query('SELECT * FROM cf_quotes WHERE company_id = ? AND rfq_id = ? AND deleted_at IS NULL ORDER BY id', [companyId, rid]),
    db.query(
      `SELECT ql.* FROM cf_quote_lines ql JOIN cf_quotes qt ON qt.id = ql.quote_id AND qt.deleted_at IS NULL
        WHERE ql.company_id = ? AND qt.rfq_id = ? ORDER BY ql.id`,
      [companyId, rid],
    ),
  ]);
  if (!q) throw notFound('RFQ');
  const today = todayText();
  const shapedLines = lines.map((l) => ({
    id: l.id,
    lineNo: l.line_no,
    item: { id: l.item_id, code: l.item_code, name: l.item_name, uom: l.uom },
    quantity: Number(l.quantity),
    uom: l.uom,
    neededBy: l.needed_by ?? null,
    requestLine: l.request_line_id ? { id: l.request_line_id, requestId: l.request_id, requestCode: l.request_code } : null,
    request: l.request_id ? { id: l.request_id, code: l.request_code } : null,
    awardedQuoteLineId: l.awarded_quote_line_id ?? null,
    award: l.awarded_quote_line_id
      ? { quoteLineId: l.awarded_quote_line_id, supplierId: l.award_supplier_id, supplierName: l.award_supplier_name, unitPrice: num(l.award_unit_price) }
      : null,
    po: l.po_id ? { id: l.po_id, code: l.po_code } : null,
  }));
  const linesOfQuote = new Map();
  for (const ql of qlines) {
    if (!linesOfQuote.has(ql.quote_id)) linesOfQuote.set(ql.quote_id, []);
    linesOfQuote.get(ql.quote_id).push(ql);
  }
  const qtyOf = new Map(lines.map((l) => [l.id, Number(l.quantity)]));
  const shapedQuotes = quotes.map((qt) => {
    const ls = linesOfQuote.get(qt.id) ?? [];
    const priced = ls.filter((x) => x.unit_price != null);
    const total = round2(priced.reduce((t, x) => t + Number(x.unit_price) * basisQty(x, qtyOf.get(x.rfq_line_id)), 0));
    return {
      id: qt.id,
      supplierId: qt.supplier_id,
      quoteRef: qt.quote_ref ?? null,
      receivedOn: qt.received_on ?? null,
      validUntil: qt.valid_until ?? null,
      expired: qt.valid_until != null && qt.valid_until < today,
      paymentTerms: qt.payment_terms ?? null,
      freightAmount: num(qt.freight_amount),
      currency: qt.currency ?? CURRENCY,
      notes: qt.notes ?? null,
      linesQuoted: priced.length,
      total,
      lines: ls.map((x) => ({
        id: x.id,
        rfqLineId: x.rfq_line_id,
        unitPrice: num(x.unit_price),
        gstRate: num(x.gst_rate),
        leadTimeDays: x.lead_time_days ?? null,
        qtyOffered: num(x.qty_offered),
        remark: x.remark ?? null,
      })),
    };
  });
  const quoteBySupplier = new Map(shapedQuotes.map((x) => [x.supplierId, x]));
  // The POs made from this RFQ (create-pos), once each, in line order.
  const purchaseOrders = [];
  for (const l of lines) {
    if (l.po_id && !purchaseOrders.some((p) => p.id === l.po_id)) {
      purchaseOrders.push({ id: l.po_id, code: l.po_code, supplier: l.po_supplier_id ? { id: l.po_supplier_id, name: l.po_supplier_name } : null });
    }
  }
  return {
    id: q.id,
    code: q.code,
    status: q.status,
    quotesDue: q.quotes_due ?? null,
    terms: q.terms ?? null,
    notes: q.notes ?? null,
    createdBy: userOf(q.created_by, q.creator_name),
    sentAt: q.sent_at ?? null,
    createdAt: q.created_at,
    lines: shapedLines,
    suppliers: sups.map((s) => ({
      id: s.id,
      supplier: { id: s.supplier_id, code: s.supplier_code, name: s.supplier_name, email: s.supplier_email ?? null },
      contactEmail: s.contact_email ?? s.supplier_email ?? null,
      status: s.status,
      sentAt: s.sent_at ?? null,
      quote: quoteBySupplier.has(s.supplier_id) ? { id: quoteBySupplier.get(s.supplier_id).id } : null,
    })),
    quotes: shapedQuotes,
    purchaseOrders,
    allowed: rfqAllowed(q, shapedLines, shapedQuotes, c),
  };
}

/** The quantity a quote line's amount is worked on: what is offered, never more than asked. */
function basisQty(ql, asked) {
  const a = Number(asked ?? 0);
  const off = ql.qty_offered == null ? null : Number(ql.qty_offered);
  return off == null ? a : Math.min(off, a);
}

/** Columns the RFQs screen sorts by on the server. */
const RFQ_SORT = {
  code: 'r.code', status: 'r.status', due: 'r.quotes_due',
  lines: 'COUNT(DISTINCT rl.id)', suppliers: 'COUNT(DISTINCT s.id)', quotes: 'COUNT(DISTINCT qt.id)',
};

/**
 * GET /rfqs?status=&q= — status: open (draft/sent) | all (default) | <one status>.
 * paged=1 / all=1 add total + counts { status, open, all }; otherwise { rows } as before.
 */
export async function listRfqs(db, companyId, q = {}) {
  const base = ['r.company_id = ?', 'r.deleted_at IS NULL'];
  const args = [companyId];
  const status = blank(q.status) ? 'all' : String(q.status);
  const like = likeOf(q.q ?? q.search);
  if (like) { base.push('(r.code LIKE ? OR r.notes LIKE ?)'); args.push(like, like); }
  const where = [...base];
  const rowArgs = [...args];
  if (status === 'open') where.push("r.status IN ('draft','sent')");
  else if (status !== 'all') { where.push('r.status = ?'); rowArgs.push(status); }
  const paged = wantsPage(q);
  const page = paged ? pageArgs(q, { def: 100 }) : null;
  const rowSql = `SELECT r.id, r.code, r.status, r.quotes_due, r.sent_at, r.created_at,
            COUNT(DISTINCT rl.id) AS line_count,
            COUNT(DISTINCT s.id) AS supplier_count,
            COUNT(DISTINCT qt.id) AS quote_count,
            COUNT(DISTINCT CASE WHEN rl.purchase_line_id IS NOT NULL THEN rl.id END) AS ordered_count
       FROM cf_rfqs r
       LEFT JOIN cf_rfq_lines rl ON rl.rfq_id = r.id AND rl.deleted_at IS NULL
       LEFT JOIN cf_rfq_suppliers s ON s.rfq_id = r.id
       LEFT JOIN cf_quotes qt ON qt.rfq_id = r.id AND qt.deleted_at IS NULL
      WHERE ${where.join(' AND ')}
      GROUP BY r.id, r.code, r.status, r.quotes_due, r.sent_at, r.created_at
      ORDER BY ${orderBy(q, RFQ_SORT, 'r.id DESC', 'r.id')}`;
  const [[rows], counted] = await Promise.all([
    paged ? db.query(`${rowSql} LIMIT ? OFFSET ?`, [...rowArgs, page.limit, page.offset]) : db.query(rowSql, rowArgs),
    paged ? Promise.all([
      db.query(`SELECT r.status AS k, COUNT(*) AS n FROM cf_rfqs r WHERE ${base.join(' AND ')} GROUP BY r.status`, args),
      db.query(`SELECT COUNT(*) AS n FROM cf_rfqs r WHERE ${where.join(' AND ')}`, rowArgs),
    ]) : null,
  ]);
  const shaped = rows.map((r) => ({
    id: r.id,
    code: r.code,
    status: r.status,
    quotesDue: r.quotes_due ?? null,
    lines: Number(r.line_count),
    suppliers: Number(r.supplier_count),
    quotes: Number(r.quote_count),
    linesOrdered: Number(r.ordered_count),
    sentAt: r.sent_at ?? null,
    createdAt: r.created_at,
  }));
  if (!paged) return { rows: shaped };
  const [[byStatus], [[{ n: total }]]] = counted;
  const statusCounts = countsBy(byStatus, RFQ_STATUSES);
  const all = Object.values(statusCounts).reduce((t, n) => t + n, 0);
  return pageOf(shaped, total, page, { counts: { status: statusCounts, open: statusCounts.draft + statusCounts.sent, all } });
}

/** PUT /rfqs/:id { quotesDue?, terms?, notes? } */
export async function updateRfq(db, c, id, input = {}) {
  const q = await requireRfq(db, c.companyId, id);
  assertRfqOpen(q);
  const problems = [];
  const sets = {};
  if (input.quotesDue !== undefined) sets.quotes_due = readDate(input.quotesDue, 'Quotes due', problems);
  if (input.terms !== undefined) sets.terms = text(input.terms, 10000);
  if (input.notes !== undefined) sets.notes = text(input.notes, 5000);
  assertNoProblems(problems);
  if (Object.keys(sets).length) {
    await db.query(`UPDATE cf_rfqs SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(sets), c.companyId, q.id]);
  }
  return getRfq(db, c, q.id);
}

async function addSuppliersBulk(db, c, rfqId, entries) {
  const problems = [];
  const rows = [];
  for (const e of entries) {
    const s = await requireSupplier(db, c.companyId, e.supplierId, problems);
    if (s) rows.push([c.companyId, rfqId, s.id, 'invited', text(e.contactEmail, 255)]);
  }
  assertNoProblems(problems, 'The supplier cannot be added.');
  await insertRows(db, 'cf_rfq_suppliers', ['company_id', 'rfq_id', 'supplier_id', 'status', 'contact_email'], rows);
}

/** POST /rfqs/:id/suppliers { supplierId, contactEmail? } — contactEmail defaults to the party's email on read. */
export async function addRfqSupplier(db, c, id, input = {}) {
  const q = await requireRfq(db, c.companyId, id);
  assertRfqOpen(q, 'be added');
  if (blank(input.supplierId)) throw invalid('INVALID', 'Choose a supplier.');
  if (!blank(input.contactEmail) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input.contactEmail).trim())) {
    throw invalid('INVALID', 'That email address does not look right.');
  }
  await addSuppliersBulk(db, c, q.id, [input]);
  return getRfq(db, c, q.id);
}

async function requireRfqSupplier(db, companyId, rfqId, supplierId) {
  const [[s]] = await db.query(
    `SELECT s.*, p.name AS supplier_name FROM cf_rfq_suppliers s JOIN cf_parties p ON p.id = s.supplier_id
      WHERE s.company_id = ? AND s.rfq_id = ? AND s.supplier_id = ?`,
    [companyId, rfqId, Number(supplierId)],
  );
  if (!s) throw notFound('That supplier on this RFQ');
  return s;
}

/** DELETE /rfqs/:id/suppliers/:supplierId — refused once the supplier has quoted. */
export async function removeRfqSupplier(db, c, id, supplierId) {
  const q = await requireRfq(db, c.companyId, id);
  assertRfqOpen(q, 'be removed');
  const s = await requireRfqSupplier(db, c.companyId, q.id, supplierId);
  const [[quote]] = await db.query('SELECT id FROM cf_quotes WHERE company_id = ? AND rfq_id = ? AND supplier_id = ? AND deleted_at IS NULL', [c.companyId, q.id, s.supplier_id]);
  if (quote) throw invalid('HAS_QUOTE', `${s.supplier_name} has quoted on ${q.code} — the quote stays on record, so the supplier stays too. Mark it declined instead.`);
  await db.query('DELETE FROM cf_rfq_suppliers WHERE company_id = ? AND id = ?', [c.companyId, s.id]);
  return getRfq(db, c, q.id);
}

/** POST /rfqs/:id/mark-sent { supplierId } — the buyer sent it from their own mail. The RFQ goes draft -> sent. */
export async function markRfqSent(db, c, id, input = {}) {
  const q = await requireRfq(db, c.companyId, id, { lock: true });
  assertRfqOpen(q, 'be sent');
  const s = await requireRfqSupplier(db, c.companyId, q.id, input.supplierId);
  await db.query(
    "UPDATE cf_rfq_suppliers SET status = IF(status = 'invited', 'sent', status), sent_at = NOW() WHERE company_id = ? AND id = ?",
    [c.companyId, s.id],
  );
  if (q.status === 'draft') await db.query("UPDATE cf_rfqs SET status = 'sent', sent_at = NOW() WHERE company_id = ? AND id = ?", [c.companyId, q.id]);
  return getRfq(db, c, q.id);
}

/** POST /rfqs/:id/suppliers/:supplierId/decline */
export async function declineRfqSupplier(db, c, id, supplierId) {
  const q = await requireRfq(db, c.companyId, id);
  assertRfqOpen(q);
  const s = await requireRfqSupplier(db, c.companyId, q.id, supplierId);
  await db.query("UPDATE cf_rfq_suppliers SET status = 'declined' WHERE company_id = ? AND id = ?", [c.companyId, s.id]);
  return getRfq(db, c, q.id);
}

/** POST /rfqs/:id/close — no more quotes; lines not on a PO go back to their requests (open). */
export async function closeRfq(db, c, id) {
  const q = await requireRfq(db, c.companyId, id, { lock: true });
  if (['closed', 'cancelled'].includes(q.status)) throw invalid('RFQ_NOT_OPEN', `${q.code} is already ${q.status}.`);
  await freeRequestLines(db, c, q.id);
  await db.query("UPDATE cf_rfqs SET status = 'closed' WHERE company_id = ? AND id = ?", [c.companyId, q.id]);
  return getRfq(db, c, q.id);
}

/** POST /rfqs/:id/cancel — only while nothing of it is on a PO; its request lines go back to open. */
export async function cancelRfq(db, c, id) {
  const q = await requireRfq(db, c.companyId, id, { lock: true });
  assertRfqOpen(q, 'be cancelled');
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM cf_rfq_lines WHERE company_id = ? AND rfq_id = ? AND purchase_line_id IS NOT NULL AND deleted_at IS NULL', [c.companyId, q.id]);
  if (Number(n)) throw invalid('HAS_PO', `Purchase orders were already made from ${q.code} — close it instead.`);
  await freeRequestLines(db, c, q.id);
  await db.query("UPDATE cf_rfqs SET status = 'cancelled' WHERE company_id = ? AND id = ?", [c.companyId, q.id]);
  return getRfq(db, c, q.id);
}

async function freeRequestLines(db, c, rfqId) {
  await db.query(
    `UPDATE cf_purchase_request_lines l JOIN cf_rfq_lines rl ON rl.request_line_id = l.id AND rl.deleted_at IS NULL
        SET l.status = 'open'
      WHERE l.company_id = ? AND rl.rfq_id = ? AND rl.purchase_line_id IS NULL AND l.status = 'in_rfq'`,
    [c.companyId, rfqId],
  );
}

// ---- the RFQ on paper and in an email -------------------------------------------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const qtyText = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 }));
const dmy = (d) => (d ? `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}/${String(d).slice(0, 4)}` : '—');

/** What print and email both need: the RFQ, the supplier on it and who we are. 7 reads, one wave. */
async function documentData(db, c, id, supplierId) {
  if (blank(supplierId)) throw invalid('INVALID', 'Say which supplier the RFQ is for (supplierId).');
  const [rfq, tax, [[company]]] = await Promise.all([
    getRfq(db, c, id),
    companyTax(db, c.companyId),
    db.query('SELECT name FROM companies WHERE id = ?', [c.companyId]),
  ]);
  const sup = rfq.suppliers.find((s) => s.supplier.id === Number(supplierId));
  if (!sup) throw notFound('That supplier on this RFQ');
  const [[party]] = await db.query('SELECT address, contact_name, phone, tax_number FROM cf_parties WHERE company_id = ? AND id = ?', [c.companyId, sup.supplier.id]);
  return {
    rfq,
    sup,
    party: party ?? {},
    us: {
      name: tax.legalName ?? company?.name ?? '',
      tradeName: tax.tradeName,
      address: [tax.address1, tax.address2, tax.city, tax.pincode].filter((x) => !blank(x)).join(', '),
      gstin: tax.gstin,
    },
  };
}

/** GET /rfqs/:id/print?supplierId= — A4 HTML, no external assets, a blank price column for the supplier to fill. */
export async function rfqPrintHtml(db, c, id, supplierId) {
  const { rfq, sup, party, us } = await documentData(db, c, id, supplierId);
  const rows = rfq.lines.map((l, k) => `<tr><td class="n">${k + 1}</td><td>${esc(l.item.code ?? '')}<div class="sub">${esc(l.item.name ?? '')}</div></td>
      <td class="n">${qtyText(l.quantity)}</td><td>${esc(l.uom ?? '')}</td><td>${esc(dmy(l.neededBy))}</td>
      <td class="blank"></td><td class="blank"></td><td class="blank"></td></tr>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`RFQ ${rfq.code} — ${sup.supplier.name}`)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10.5px; color: #111; background: #fff; margin: 0; }
  .page { max-width: 186mm; margin: 0 auto; padding: 4mm 0; }
  h1 { font-size: 17px; margin: 0; letter-spacing: .04em; }
  table { width: 100%; border-collapse: collapse; }
  .box td { border: 1px solid #555; vertical-align: top; padding: 4px 6px; width: 50%; }
  .k { color: #555; font-size: 9px; text-transform: uppercase; letter-spacing: .03em; }
  .lines th, .lines td { border: 1px solid #555; padding: 4px; }
  .lines th { background: #eee; font-size: 9.5px; text-align: left; }
  .lines td.blank { width: 17mm; }
  .n { text-align: right; white-space: nowrap; }
  .sub { color: #555; font-size: 8.5px; }
  .block { border: 1px solid #555; padding: 4px 6px; margin-top: 6px; white-space: pre-wrap; }
  .ask td { border: 1px solid #555; padding: 6px; height: 9mm; vertical-align: top; width: 33%; }
  .sign { text-align: right; height: 20mm; vertical-align: bottom; }
  @media print { .page { padding: 0; } }
</style></head>
<body><div class="page">
<table><tr><td><h1>REQUEST FOR QUOTATION</h1></td><td class="n"><b>${esc(rfq.code)}</b><br>Date: ${esc(dmy(todayText()))}</td></tr></table>
<table class="box" style="margin-top:6px"><tr>
  <td><div class="k">From</div><b>${esc(us.name)}</b>${us.tradeName && us.tradeName !== us.name ? `<br>${esc(us.tradeName)}` : ''}<br>${esc(us.address)}${us.gstin ? `<br>GSTIN: ${esc(us.gstin)}` : ''}</td>
  <td><div class="k">To</div><b>${esc(sup.supplier.name)}</b>${party.contact_name ? `<br>Attn: ${esc(party.contact_name)}` : ''}${party.address ? `<br>${esc(party.address)}` : ''}${sup.contactEmail ? `<br>${esc(sup.contactEmail)}` : ''}${party.phone ? `<br>${esc(party.phone)}` : ''}</td>
</tr><tr>
  <td><div class="k">Please quote by</div><b>${esc(dmy(rfq.quotesDue))}</b></td>
  <td><div class="k">Prices</div>In INR, per the unit shown, net of GST — state the GST rate separately.</td>
</tr></table>
<table class="lines" style="margin-top:6px">
<thead><tr><th>#</th><th>Item</th><th class="n">Qty</th><th>Unit</th><th>Needed by</th><th>Unit price ₹</th><th>GST %</th><th>Lead time (days)</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<table class="ask" style="margin-top:6px"><tr><td><div class="k">Freight ₹ (if extra)</div></td><td><div class="k">Payment terms</div></td><td><div class="k">Quote valid until</div></td></tr></table>
${rfq.terms ? `<div class="block"><div class="k">Terms</div>${esc(rfq.terms)}</div>` : ''}
<table style="margin-top:10px"><tr><td class="sub">Please reply with this sheet filled in, or your own quotation quoting ${esc(rfq.code)}.</td><td class="sign">For ${esc(us.name)}<br><br><br>Authorised signatory</td></tr></table>
</div></body></html>`;
}

/** GET /rfqs/:id/email?supplierId= — { to, subject, body } for a mailto link (plain text). */
export async function rfqEmail(db, c, id, supplierId) {
  const { rfq, sup, us } = await documentData(db, c, id, supplierId);
  const lines = rfq.lines.map((l, k) => `${k + 1}. ${l.item.code ?? ''}${l.item.name ? ` — ${l.item.name}` : ''}: ${qtyText(l.quantity)} ${l.uom ?? ''}${l.neededBy ? `, needed by ${dmy(l.neededBy)}` : ''}`);
  const body = [
    `Dear ${sup.supplier.name},`,
    '',
    `Please quote for the following (our RFQ ${rfq.code})${rfq.quotesDue ? ` by ${dmy(rfq.quotesDue)}` : ''}:`,
    '',
    ...lines,
    '',
    'For each line please give the unit price in INR (net of GST), the GST rate and the lead time in days.',
    'Please also state freight (if extra), payment terms and how long the quote is valid.',
    ...(rfq.terms ? ['', 'Terms:', rfq.terms] : []),
    '',
    'Regards,',
    us.name,
  ].join('\n');
  return { to: sup.contactEmail ?? '', subject: `Request for quotation ${rfq.code} — ${us.name}`, body };
}

// ============================================================================
// QUOTES
// ============================================================================

/**
 * POST /rfqs/:id/quotes { supplierId, quoteRef?, receivedOn?, validUntil?, paymentTerms?,
 *   freightAmount?, notes?, lines: [{ rfqLineId, unitPrice, gstRate?, leadTimeDays?, qtyOffered?, remark? }] }
 * UPSERT per supplier: the supplier's live quote is updated, else made. Quote
 * lines are updated in place (an award points at them); a line left out keeps
 * what it had; unitPrice blank = not quoted. A line already on a PO cannot
 * change its price. Header fields left out (undefined) keep their value.
 * The supplier must be on the RFQ; it becomes `quoted`. Returns the RFQ detail.
 */
export async function upsertQuote(db, c, id, input = {}) {
  const q = await requireRfq(db, c.companyId, id, { lock: true });
  assertRfqOpen(q, 'be quoted');
  if (blank(input.supplierId)) throw invalid('INVALID', 'Say which supplier the quote is from.');
  const s = await requireRfqSupplier(db, c.companyId, q.id, input.supplierId);
  const problems = [];
  const head = {};
  if (input.quoteRef !== undefined) head.quote_ref = text(input.quoteRef, 100);
  if (input.receivedOn !== undefined) head.received_on = readDate(input.receivedOn, 'Received on', problems);
  if (input.validUntil !== undefined) head.valid_until = readDate(input.validUntil, 'Valid until', problems);
  if (input.paymentTerms !== undefined) head.payment_terms = text(input.paymentTerms, 255);
  if (input.freightAmount !== undefined) head.freight_amount = readMoney(input.freightAmount, 'Freight', problems);
  if (input.notes !== undefined) head.notes = text(input.notes, 5000);
  const [[rfqLines], [[existing]]] = await Promise.all([
    db.query('SELECT id, line_no, quantity, purchase_line_id FROM cf_rfq_lines WHERE company_id = ? AND rfq_id = ? AND deleted_at IS NULL', [c.companyId, q.id]),
    db.query('SELECT * FROM cf_quotes WHERE company_id = ? AND rfq_id = ? AND supplier_id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, q.id, s.supplier_id]),
  ]);
  const lineById = new Map(rfqLines.map((l) => [l.id, l]));
  const oldLines = existing
    ? new Map((await db.query('SELECT * FROM cf_quote_lines WHERE company_id = ? AND quote_id = ?', [c.companyId, existing.id]))[0].map((x) => [x.rfq_line_id, x]))
    : new Map();
  const lines = [];
  const seen = new Set();
  for (const [k, l] of (Array.isArray(input.lines) ? input.lines : []).entries()) {
    const rl = lineById.get(Number(l?.rfqLineId));
    const label = rl ? `Line ${rl.line_no}` : `Row ${k + 1}`;
    if (!rl) { problems.push(`${label}: that line is not on ${q.code}.`); continue; }
    if (seen.has(rl.id)) { problems.push(`${label} is given twice.`); continue; }
    seen.add(rl.id);
    const row = {
      rfqLineId: rl.id,
      unitPrice: readPrice(l.unitPrice, `${label}: unit price`, problems),
      gstRate: readRate(l.gstRate, `${label}: GST`, problems),
      leadTimeDays: readDays(l.leadTimeDays, `${label}: lead time`, problems),
      qtyOffered: blank(l.qtyOffered) ? null : readQty(l.qtyOffered, `${label}: quantity offered`, problems),
      remark: text(l.remark, 500),
    };
    const old = oldLines.get(rl.id);
    if (rl.purchase_line_id && (num(old?.unit_price) !== row.unitPrice || num(old?.qty_offered) !== row.qtyOffered)) {
      problems.push(`${label} is already on a purchase order — its price and quantity cannot change here.`);
    }
    lines.push(row);
  }
  assertNoProblems(problems, 'The quote cannot be saved.');
  let quoteId = existing?.id;
  if (existing) {
    if (Object.keys(head).length) {
      await db.query(`UPDATE cf_quotes SET ${Object.keys(head).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
        [...Object.values(head), c.companyId, existing.id]);
    }
  } else {
    const [ins] = await db.query(
      `INSERT INTO cf_quotes (company_id, rfq_id, supplier_id, quote_ref, received_on, valid_until, payment_terms, freight_amount, currency, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.companyId, q.id, s.supplier_id, head.quote_ref ?? null, head.received_on ?? todayText(), head.valid_until ?? null,
        head.payment_terms ?? null, head.freight_amount ?? null, CURRENCY, head.notes ?? null, c.userId ?? null],
    );
    quoteId = ins.insertId;
  }
  if (lines.length) {
    const holes = lines.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    await db.query(
      `INSERT INTO cf_quote_lines (company_id, quote_id, rfq_line_id, unit_price, gst_rate, lead_time_days, qty_offered, remark)
       VALUES ${holes}
       ON DUPLICATE KEY UPDATE unit_price = VALUES(unit_price), gst_rate = VALUES(gst_rate), lead_time_days = VALUES(lead_time_days),
                               qty_offered = VALUES(qty_offered), remark = VALUES(remark)`,
      lines.flatMap((l) => [c.companyId, quoteId, l.rfqLineId, l.unitPrice, l.gstRate, l.leadTimeDays, l.qtyOffered, l.remark]),
    );
  }
  await db.query("UPDATE cf_rfq_suppliers SET status = 'quoted' WHERE company_id = ? AND id = ?", [c.companyId, s.id]);
  return getRfq(db, c, q.id);
}

/**
 * GET /quotes/:id — one quote to prefill the quote dialog: the header, the
 * supplier, and one row per RFQ line (unquoted lines come back with nulls, so the
 * grid is always complete). 2 reads.
 */
export async function getQuote(db, c, quoteId) {
  const [[qt]] = await db.query(
    `SELECT qt.*, p.code AS supplier_code, p.name AS supplier_name, r.code AS rfq_code, r.status AS rfq_status
       FROM cf_quotes qt JOIN cf_parties p ON p.id = qt.supplier_id JOIN cf_rfqs r ON r.id = qt.rfq_id
      WHERE qt.company_id = ? AND qt.id = ? AND qt.deleted_at IS NULL`,
    [c.companyId, Number(quoteId)],
  );
  if (!qt) throw notFound('Quote');
  const [rows] = await db.query(
    `SELECT rl.id AS rfq_line_id, rl.line_no, rl.item_id, rl.quantity, rl.uom, m.code AS item_code, m.name AS item_name,
            ql.id, ql.unit_price, ql.gst_rate, ql.lead_time_days, ql.qty_offered, ql.remark
       FROM cf_rfq_lines rl
       JOIN cf_master_records m ON m.id = rl.item_id
       LEFT JOIN cf_quote_lines ql ON ql.rfq_line_id = rl.id AND ql.quote_id = ?
      WHERE rl.company_id = ? AND rl.rfq_id = ? AND rl.deleted_at IS NULL
      ORDER BY rl.line_no, rl.id`,
    [qt.id, c.companyId, qt.rfq_id],
  );
  return {
    id: qt.id,
    rfq: { id: qt.rfq_id, code: qt.rfq_code, status: qt.rfq_status },
    supplierId: qt.supplier_id,
    supplier: { id: qt.supplier_id, code: qt.supplier_code, name: qt.supplier_name },
    quoteRef: qt.quote_ref ?? null,
    receivedOn: qt.received_on ?? null,
    validUntil: qt.valid_until ?? null,
    expired: qt.valid_until != null && qt.valid_until < todayText(),
    paymentTerms: qt.payment_terms ?? null,
    freightAmount: num(qt.freight_amount),
    currency: qt.currency ?? CURRENCY,
    notes: qt.notes ?? null,
    lines: rows.map((r) => ({
      id: r.id ?? null,
      rfqLineId: r.rfq_line_id,
      lineNo: r.line_no,
      item: { id: r.item_id, code: r.item_code, name: r.item_name, uom: r.uom },
      quantity: Number(r.quantity),
      unitPrice: num(r.unit_price),
      gstRate: num(r.gst_rate),
      leadTimeDays: r.lead_time_days ?? null,
      qtyOffered: num(r.qty_offered),
      remark: r.remark ?? null,
    })),
  };
}

/** PUT /quotes/:id { …same fields as POST /rfqs/:id/quotes, without supplierId } */
export async function updateQuote(db, c, quoteId, input = {}) {
  const [[qt]] = await db.query('SELECT rfq_id, supplier_id FROM cf_quotes WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, Number(quoteId)]);
  if (!qt) throw notFound('Quote');
  return upsertQuote(db, c, qt.rfq_id, { ...input, supplierId: qt.supplier_id });
}

// ============================================================================
// COMPARISON, AWARD, PURCHASE ORDERS
// ============================================================================

/**
 * GET /rfqs/:id/comparison — lines × suppliers. 5 reads in parallel + 1 (last paid).
 * cells: { supplierId, quoteId, quoteLineId, unitPrice, qtyOffered, partial, amount,
 *   freightShare, landedUnit, gstRate, leadTimeDays, valid, expired, cheapest, fastest,
 *   awarded, remark, lastPaid }
 */
export async function rfqComparison(db, c, id) {
  const rfq = await getRfq(db, c, id);
  const lastPaid = await lastPricesPaid(db, c.companyId, rfq.lines.map((l) => l.item.id));
  const qtyOf = new Map(rfq.lines.map((l) => [l.id, l.quantity]));
  // Freight shared by line amount, per quote.
  const quoteInfo = new Map();
  for (const qt of rfq.quotes) {
    const amounts = new Map();
    for (const ql of qt.lines) {
      if (ql.unitPrice == null) continue;
      const basis = basisQty({ qty_offered: ql.qtyOffered }, qtyOf.get(ql.rfqLineId));
      amounts.set(ql.rfqLineId, { amount: ql.unitPrice * basis, basis });
    }
    const sum = [...amounts.values()].reduce((t, a) => t + a.amount, 0);
    quoteInfo.set(qt.supplierId, { quote: qt, amounts, sum, byLine: new Map(qt.lines.map((ql) => [ql.rfqLineId, ql])) });
  }
  const supplierIds = [...new Set([...rfq.suppliers.map((s) => s.supplier.id), ...rfq.quotes.map((q) => q.supplierId)])];
  const nameOf = new Map(rfq.suppliers.map((s) => [s.supplier.id, s.supplier.name]));
  const lines = rfq.lines.map((l) => {
    const lp = lastPaid.get(l.item.id);
    const lastPaidOut = lp ? { price: lp.unitPrice, date: lp.orderedAt, orderCode: lp.orderCode, supplierName: lp.supplierName } : null;
    const cells = supplierIds.map((sid) => {
      const info = quoteInfo.get(sid);
      const ql = info?.byLine.get(l.id);
      const expired = !!info?.quote.expired;
      const priced = ql?.unitPrice != null;
      const a = info?.amounts.get(l.id);
      const freight = info?.quote.freightAmount ?? 0;
      // The share is shown to the paisa; landed unit is worked from the unrounded share.
      const rawShare = priced && freight && info.sum > 0 ? (freight * a.amount) / info.sum : 0;
      const freightShare = priced ? round2(rawShare) : null;
      const landedUnit = priced ? round4(ql.unitPrice + (a.basis > 0 ? rawShare / a.basis : 0)) : null;
      return {
        supplierId: sid,
        quoteId: info?.quote.id ?? null,
        quoteLineId: ql?.id ?? null,
        unitPrice: priced ? ql.unitPrice : null,
        qtyOffered: ql?.qtyOffered ?? null,
        partial: priced && ql.qtyOffered != null && ql.qtyOffered + EPS < l.quantity,
        amount: priced ? round2(a.amount) : null,
        freightShare,
        landedUnit,
        gstRate: ql?.gstRate ?? null,
        leadTimeDays: ql?.leadTimeDays ?? null,
        valid: priced && !expired,
        expired,
        cheapest: false,
        fastest: false,
        awarded: !!ql && l.awardedQuoteLineId === ql.id,
        remark: ql?.remark ?? null,
        lastPaid: lastPaidOut,
      };
    });
    const valid = cells.filter((x) => x.valid);
    if (valid.length) {
      const minLanded = Math.min(...valid.map((x) => x.landedUnit));
      for (const x of valid) if (Math.abs(x.landedUnit - minLanded) < 1e-9) x.cheapest = true;
      const timed = valid.filter((x) => x.leadTimeDays != null);
      if (timed.length) {
        const minLead = Math.min(...timed.map((x) => x.leadTimeDays));
        for (const x of timed) if (x.leadTimeDays === minLead) x.fastest = true;
      }
    }
    return { rfqLine: l, lastPaid: lastPaidOut, cells };
  });
  // Recommend: cheapest landed among valid FULL offers, then (ties) the faster;
  // a part offer only when no valid full one exists. Expired never.
  const pick = (cells) => [...cells].sort((a, b) => a.landedUnit - b.landedUnit
    || (a.leadTimeDays ?? 1e9) - (b.leadTimeDays ?? 1e9) || a.supplierId - b.supplierId)[0] ?? null;
  const perLine = lines.map((ln) => {
    const valid = ln.cells.filter((x) => x.valid);
    const best = pick(valid.filter((x) => !x.partial)) ?? pick(valid);
    return { rfqLineId: ln.rfqLine.id, supplierId: best?.supplierId ?? null, quoteLineId: best?.quoteLineId ?? null, partial: !!best?.partial };
  });
  const suppliers = supplierIds.map((sid) => {
    const info = quoteInfo.get(sid);
    const total = info ? round2(info.sum) : null;
    const freight = info?.quote.freightAmount ?? null;
    return {
      id: sid,
      name: nameOf.get(sid) ?? null,
      quoteId: info?.quote.id ?? null,
      validUntil: info?.quote.validUntil ?? null,
      expired: !!info?.quote.expired,
      total,
      freightAmount: freight,
      landedTotal: info && info.amounts.size ? round2(info.sum + (freight ?? 0)) : null,
      linesQuoted: info ? info.amounts.size : 0,
      paymentTerms: info?.quote.paymentTerms ?? null,
    };
  });
  return { rfq: { id: rfq.id, code: rfq.code, status: rfq.status }, currency: CURRENCY, lines, suppliers, recommendation: { perLine } };
}

/**
 * POST /rfqs/:id/award { awards: [{ rfqLineId, quoteLineId | null }] } — per line.
 * null clears an award. The quote line must be for that RFQ line and priced; a
 * line already on a PO cannot be re-awarded. An expired quote may be awarded
 * (the buyer may have had the price re-confirmed) — it is only never recommended.
 */
export async function awardRfq(db, c, id, input = {}) {
  const q = await requireRfq(db, c.companyId, id, { lock: true });
  assertRfqOpen(q, 'be awarded');
  const awards = Array.isArray(input.awards) ? input.awards : [];
  if (!awards.length) throw invalid('INVALID', 'Say which supplier wins each line.');
  const [[rfqLines], [qlines]] = await Promise.all([
    db.query('SELECT id, line_no, purchase_line_id FROM cf_rfq_lines WHERE company_id = ? AND rfq_id = ? AND deleted_at IS NULL', [c.companyId, q.id]),
    db.query(
      `SELECT ql.id, ql.rfq_line_id, ql.unit_price FROM cf_quote_lines ql JOIN cf_quotes qt ON qt.id = ql.quote_id AND qt.deleted_at IS NULL
        WHERE ql.company_id = ? AND qt.rfq_id = ?`,
      [c.companyId, q.id],
    ),
  ]);
  const lineById = new Map(rfqLines.map((l) => [l.id, l]));
  const qlById = new Map(qlines.map((x) => [x.id, x]));
  const problems = [];
  const sets = [];
  for (const a of awards) {
    const rl = lineById.get(Number(a?.rfqLineId));
    if (!rl) { problems.push(`Line ${a?.rfqLineId} is not on ${q.code}.`); continue; }
    if (rl.purchase_line_id) { problems.push(`Line ${rl.line_no} is already on a purchase order.`); continue; }
    if (a.quoteLineId == null || a.quoteLineId === '') { sets.push([rl.id, null]); continue; }
    const ql = qlById.get(Number(a.quoteLineId));
    if (!ql || ql.rfq_line_id !== rl.id) { problems.push(`Line ${rl.line_no}: that quote is not for this line.`); continue; }
    if (ql.unit_price == null) { problems.push(`Line ${rl.line_no}: that supplier did not quote a price for it.`); continue; }
    sets.push([rl.id, ql.id]);
  }
  assertNoProblems(problems, 'The award cannot be saved.');
  await db.query(
    `UPDATE cf_rfq_lines SET awarded_quote_line_id = CASE id ${sets.map(() => 'WHEN ? THEN ?').join(' ')} END
      WHERE company_id = ? AND id IN (?)`,
    [...sets.flat(), c.companyId, sets.map((s) => s[0])],
  );
  return getRfq(db, c, q.id);
}

/**
 * POST /rfqs/:id/create-pos — one DRAFT purchase order per awarded supplier, for
 * the awarded lines not yet on a PO. unit_price from the quote line; quantity =
 * the quantity offered when the supplier offered less (the rest goes back to the
 * buy list as short), else the RFQ quantity; expected date = today + lead time.
 * A PO holds one line per item (uq_cpol_item): two RFQ lines of the same item to
 * one supplier become ONE PO line (quantities summed, price weighted by quantity,
 * quote_line_id / request_line_id of the first); cf_rfq_lines.purchase_line_id
 * links every one. GST: the PO line has no rate column — PO tax comes from the
 * item (taxService.purchaseOrderTax), so the quote's rate is not copied.
 * Then: request lines -> ordered, finished requests -> closed, RFQ -> awarded
 * once every line is on a PO. Set-based: ~10 statements + one code per supplier.
 */
export async function createPosFromRfq(db, c, id) {
  const q = await requireRfq(db, c.companyId, id, { lock: true });
  assertRfqOpen(q, 'be ordered');
  const [awarded] = await db.query(
    `SELECT rl.id, rl.item_id, rl.quantity, rl.uom, rl.request_line_id, pl.request_id,
            ql.id AS quote_line_id, ql.unit_price, ql.lead_time_days, ql.qty_offered,
            qt.supplier_id, qt.quote_ref, qt.payment_terms, qt.freight_amount, p.name AS supplier_name, p.code AS supplier_code
       FROM cf_rfq_lines rl
       JOIN cf_quote_lines ql ON ql.id = rl.awarded_quote_line_id
       JOIN cf_quotes qt ON qt.id = ql.quote_id AND qt.deleted_at IS NULL
       JOIN cf_parties p ON p.id = qt.supplier_id
       LEFT JOIN cf_purchase_request_lines pl ON pl.id = rl.request_line_id
      WHERE rl.company_id = ? AND rl.rfq_id = ? AND rl.deleted_at IS NULL AND rl.purchase_line_id IS NULL
      ORDER BY rl.line_no, rl.id`,
    [c.companyId, q.id],
  );
  if (!awarded.length) throw invalid('NOTHING_AWARDED', `Nothing on ${q.code} is awarded and not yet ordered — award the lines first.`);
  if (awarded.some((a) => a.unit_price == null)) throw invalid('UNPRICED', 'An awarded quote line has no price — award another supplier or enter the price.');
  const today = todayText();
  const bySupplier = new Map();
  for (const a of awarded) {
    if (!bySupplier.has(a.supplier_id)) bySupplier.set(a.supplier_id, { supplier: { id: a.supplier_id, code: a.supplier_code, name: a.supplier_name }, head: a, lines: [] });
    bySupplier.get(a.supplier_id).lines.push(a);
  }
  // One PO per supplier (a code each — the code generator is per document).
  const pos = [];
  for (const g of bySupplier.values()) {
    const lead = Math.max(0, ...g.lines.map((l) => Number(l.lead_time_days ?? 0)));
    const g2 = await generate(db, c.companyId, 'purchase_order', 'code', { draft: { supplierId: g.supplier.id, suggested: false } }, { consume: true });
    const notes = [
      `From ${q.code}${g.head.quote_ref ? ` — quote ${g.head.quote_ref}` : ''}.`,
      g.head.payment_terms ? `Payment: ${g.head.payment_terms}.` : null,
      g.head.freight_amount != null && Number(g.head.freight_amount) > 0 ? `Freight as quoted: ₹${round2(g.head.freight_amount)}.` : null,
    ].filter(Boolean).join(' ');
    const poId = await insertOrder(db, c, { code: g2?.text ?? null, supplierId: g.supplier.id, expectedDate: lead ? addDays(today, lead) : null, notes, suggested: false });
    // Merge same-item lines into one PO line.
    const byItem = new Map();
    for (const l of g.lines) {
      const qty = round6(l.qty_offered != null ? Math.min(Number(l.qty_offered), Number(l.quantity)) : Number(l.quantity));
      const e = byItem.get(l.item_id) ?? { itemId: l.item_id, uom: l.uom, qty: 0, money: 0, lead: 0, quoteLineId: l.quote_line_id, requestLineId: l.request_line_id, rfqLineIds: [] };
      e.qty = round6(e.qty + qty);
      e.money += qty * Number(l.unit_price);
      e.lead = Math.max(e.lead, Number(l.lead_time_days ?? 0));
      e.rfqLineIds.push(l.id);
      byItem.set(l.item_id, e);
    }
    pos.push({ poId, supplier: g.supplier, items: [...byItem.values()] });
  }
  const rows = [];
  for (const p of pos) {
    let no = 1;
    for (const e of p.items) {
      rows.push([c.companyId, p.poId, no++, e.itemId, e.qty, e.uom, e.lead ? addDays(today, e.lead) : null,
        e.qty > 0 ? round4(e.money / e.qty) : null, CURRENCY, e.quoteLineId, e.requestLineId ?? null]);
    }
  }
  await insertRows(db, 'cf_purchase_order_lines',
    ['company_id', 'purchase_order_id', 'line_no', 'item_id', 'quantity', 'uom', 'expected_date', 'unit_price', 'currency', 'quote_line_id', 'request_line_id'], rows);
  const [poLines] = await db.query(
    `SELECT l.id, l.purchase_order_id, l.item_id, l.quantity, l.unit_price, l.quote_line_id, l.request_line_id, p.code
       FROM cf_purchase_order_lines l JOIN cf_purchase_orders p ON p.id = l.purchase_order_id
      WHERE l.company_id = ? AND l.purchase_order_id IN (?) AND l.deleted_at IS NULL ORDER BY l.purchase_order_id, l.line_no`,
    [c.companyId, pos.map((p) => p.poId)],
  );
  const lineOf = new Map(poLines.map((l) => [`${l.purchase_order_id}:${l.item_id}`, l]));
  const links = [];
  for (const p of pos) for (const e of p.items) for (const rid of e.rfqLineIds) links.push([rid, lineOf.get(`${p.poId}:${e.itemId}`).id]);
  await db.query(
    `UPDATE cf_rfq_lines SET purchase_line_id = CASE id ${links.map(() => 'WHEN ? THEN ?').join(' ')} END WHERE company_id = ? AND id IN (?)`,
    [...links.flat(), c.companyId, links.map((x) => x[0])],
  );
  const requestLineIds = awarded.map((a) => a.request_line_id).filter(Boolean);
  if (requestLineIds.length) {
    await db.query("UPDATE cf_purchase_request_lines SET status = 'ordered' WHERE company_id = ? AND id IN (?)", [c.companyId, requestLineIds]);
  }
  await closeFinishedRequests(db, c, awarded.map((a) => a.request_id));
  await db.query(
    `UPDATE cf_rfqs r SET r.status = 'awarded'
      WHERE r.company_id = ? AND r.id = ?
        AND NOT EXISTS (SELECT 1 FROM cf_rfq_lines rl WHERE rl.rfq_id = r.id AND rl.deleted_at IS NULL AND rl.purchase_line_id IS NULL)`,
    [c.companyId, q.id],
  );
  const codeOf = new Map(poLines.map((l) => [l.purchase_order_id, l.code]));
  return {
    purchaseOrders: pos.map((p) => ({
      id: p.poId,
      code: codeOf.get(p.poId),
      supplier: p.supplier,
      lines: poLines.filter((l) => l.purchase_order_id === p.poId).map((l) => ({
        id: l.id, itemId: l.item_id, quantity: Number(l.quantity), unitPrice: num(l.unit_price),
        quoteLineId: l.quote_line_id ?? null, requestLineId: l.request_line_id ?? null,
      })),
    })),
    rfq: await getRfq(db, c, q.id),
  };
}

/** Party references for the parties module: a supplier on an RFQ stays. */
export async function procurementPartyReferences(db, companyId, partyId) {
  const [rows] = await db.query(
    `SELECT DISTINCT r.code FROM cf_rfq_suppliers s JOIN cf_rfqs r ON r.id = s.rfq_id AND r.deleted_at IS NULL
      WHERE s.company_id = ? AND s.supplier_id = ? ORDER BY r.code DESC LIMIT 6`,
    [companyId, partyId],
  );
  return rows.length ? [`it is a supplier on ${rows.map((r) => r.code).join(', ')}`] : [];
}

