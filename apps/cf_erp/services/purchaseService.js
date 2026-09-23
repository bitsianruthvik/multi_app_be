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
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { generate } from '../modules/codegen/index.js';
import { availability } from './releaseService.js';
import { postMovement } from './stockService.js';

const EPS = 1e-6;
const round6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const fmt = (n) => Number(Number(n).toFixed(3));
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_\-./]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const PO_STATUSES = ['draft', 'ordered', 'partially_received', 'received', 'cancelled'];
/** Still expecting steel: these are what "on order" counts and what can be received against. */
const OPEN_STATUSES = ['draft', 'ordered', 'partially_received'];
export const PO_STATUS_LABEL = {
  draft: 'Draft', ordered: 'Ordered', partially_received: 'Part received', received: 'Received', cancelled: 'Cancelled',
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
 * What the released jobs need and do not have, item by item.
 * q: { show?: short (default) | all, search?, exceptOrderId? }
 */
export async function buyList(db, companyId, q = {}) {
  const [rows] = await db.query(
    `SELECT q.item_id, m.code AS item_code, m.name AS item_name, i.uom, i.tracked_by,
            SUM(GREATEST(q.quantity - q.issued, 0)) AS wanted,
            SUM(COALESCE(v.reserved, 0)) AS reserved,
            GROUP_CONCAT(DISTINCT o.code ORDER BY o.code SEPARATOR '\u001f') AS orders,
            GROUP_CONCAT(DISTINCT o.id ORDER BY o.id SEPARATOR '\u001f') AS order_ids
       FROM cf_material_requirements q
       JOIN cf_production_releases r ON r.id = q.release_id AND r.deleted_at IS NULL
       JOIN cf_sales_orders o ON o.id = r.order_id AND o.deleted_at IS NULL AND o.status = 'confirmed'
       JOIN cf_master_records m ON m.id = q.item_id AND m.deleted_at IS NULL
       JOIN cf_item_details i ON i.master_id = q.item_id AND i.deleted_at IS NULL
       LEFT JOIN (SELECT requirement_id, SUM(quantity) AS reserved FROM cf_stock_reservations
                   WHERE company_id = ? AND status = 'active' AND deleted_at IS NULL GROUP BY requirement_id) v
              ON v.requirement_id = q.id
      WHERE q.company_id = ? AND q.deleted_at IS NULL
      GROUP BY q.item_id, m.code, m.name, i.uom, i.tracked_by`,
    [companyId, companyId],
  );
  const onOrder = await onOrderByItem(db, companyId, { exceptOrderId: q.exceptOrderId ?? null });
  const free = await availability(db, companyId, rows.map((r) => r.item_id));
  let out = rows.map((r) => {
    const wanted = round6(r.wanted);
    const reserved = round6(r.reserved);
    const freeNow = free.get(r.item_id)?.free ?? 0;
    const oo = onOrder.get(r.item_id) ?? { quantity: 0, orders: [] };
    const uncovered = round6(Math.max(0, wanted - reserved));
    return {
      item: { id: r.item_id, code: r.item_code, name: r.item_name, uom: r.uom, trackedBy: r.tracked_by },
      wanted,
      reserved,
      free: freeNow,
      onOrder: oo.quantity,
      purchaseOrders: oo.orders,
      toBuy: round6(Math.max(0, uncovered - freeNow - oo.quantity)),
      orders: (r.orders ?? '').split('\u001f').filter(Boolean).map((code, k) => ({ code, id: Number((r.order_ids ?? '').split('\u001f')[k]) })),
    };
  });
  if (String(q.show ?? 'short') !== 'all') out = out.filter((r) => r.toBuy > EPS);
  if (!blank(q.search)) {
    const term = String(q.search).trim().toLowerCase();
    out = out.filter((r) => [r.item.code, r.item.name, ...r.orders.map((o) => o.code)].some((t) => t && String(t).toLowerCase().includes(term)));
  }
  return out.sort((a, b) => b.toBuy - a.toBuy || String(a.item.code ?? '').localeCompare(String(b.item.code ?? '')));
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
  if (p.status === 'draft' || p.status === 'cancelled') return p.status;
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

export async function getPurchaseOrder(db, companyId, id) {
  const p = await requireOrder(db, companyId, id);
  const [[sup]] = p.supplier_id
    ? await db.query('SELECT id, code, name FROM cf_parties WHERE company_id = ? AND id = ?', [companyId, p.supplier_id])
    : [[]];
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
  return {
    id: p.id,
    code: p.code,
    status: p.status,
    suggested: !!p.suggested,
    supplier: sup ? { id: sup.id, code: sup.code, name: sup.name } : null,
    expectedDate: p.expected_date,
    orderedAt: p.ordered_at,
    notes: p.notes,
    createdAt: p.created_at,
    totals: { lines: lines.length, ordered, received, outstanding: round6(Math.max(0, ordered - received)) },
    lines: lines.map((l) => ({
      id: l.id,
      lineNo: l.line_no,
      item: { id: l.item_id, code: l.item_code, name: l.item_name, uom: l.uom, trackedBy: l.tracked_by },
      quantity: Number(l.quantity),
      received: Number(l.qty_received),
      outstanding: outstandingOf(l),
      expectedDate: l.expected_date,
      note: l.note,
      receipts: receipts.filter((v) => v.purchase_line_id === l.id)
        .map((v) => ({ id: v.id, code: v.code, date: v.movement_date, quantity: round6(v.quantity) })),
    })),
  };
}

/** q: { status?: open (default) | all | <one status>, supplierId?, search? } */
export async function listPurchaseOrders(db, companyId, q = {}) {
  const status = blank(q.status) ? 'open' : String(q.status);
  const where = ['p.company_id = ?', 'p.deleted_at IS NULL'];
  const args = [companyId];
  if (status === 'open') { where.push('p.status IN (?)'); args.push(OPEN_STATUSES); }
  else if (status !== 'all') { where.push('p.status = ?'); args.push(status); }
  if (!blank(q.supplierId)) { where.push('p.supplier_id = ?'); args.push(Number(q.supplierId)); }
  const [rows] = await db.query(
    `SELECT p.*, s.name AS supplier_name, s.code AS supplier_code,
            (SELECT COUNT(*) FROM cf_purchase_order_lines l WHERE l.purchase_order_id = p.id AND l.deleted_at IS NULL) AS line_count,
            (SELECT COALESCE(SUM(l.quantity), 0) FROM cf_purchase_order_lines l WHERE l.purchase_order_id = p.id AND l.deleted_at IS NULL) AS ordered,
            (SELECT COALESCE(SUM(l.qty_received), 0) FROM cf_purchase_order_lines l WHERE l.purchase_order_id = p.id AND l.deleted_at IS NULL) AS received
       FROM cf_purchase_orders p LEFT JOIN cf_parties s ON s.id = p.supplier_id
      WHERE ${where.join(' AND ')} ORDER BY p.id DESC`,
    args,
  );
  let out = rows.map((p) => ({
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
    },
  }));
  if (!blank(q.search)) {
    const term = String(q.search).trim().toLowerCase();
    out = out.filter((p) => [p.code, p.supplier?.name, p.supplier?.code].some((t) => t && String(t).toLowerCase().includes(term)));
  }
  return out;
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
async function insertOrder(db, c, { code, supplierId, expectedDate, notes, suggested }) {
  const [r] = await db.query(
    `INSERT INTO cf_purchase_orders (company_id, code, supplier_id, status, suggested, expected_date, notes, created_by)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)`,
    [c.companyId, code ?? null, supplierId ?? null, suggested ? 1 : 0, expectedDate ?? null, notes ?? null, c.userId],
  );
  if (!code) await db.query('UPDATE cf_purchase_orders SET code = ? WHERE id = ?', [`PO-${String(r.insertId).padStart(6, '0')}`, r.insertId]);
  return r.insertId;
}

async function requireSupplier(db, companyId, id, problems) {
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
  assertNoProblems(problems);
  if (!code) code = await nextCode(db, c);
  const id = await insertOrder(db, c, { code, supplierId, expectedDate, notes: blank(input.notes) ? null : String(input.notes), suggested: false });
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
  assertNoProblems(problems);
  const [[existing]] = await db.query(
    'SELECT id, quantity FROM cf_purchase_order_lines WHERE company_id = ? AND purchase_order_id = ? AND item_id = ? AND deleted_at IS NULL',
    [c.companyId, p.id, item.id],
  );
  if (existing) {
    await db.query('UPDATE cf_purchase_order_lines SET quantity = ? WHERE company_id = ? AND id = ?',
      [round6(Number(existing.quantity) + quantity), c.companyId, existing.id]);
  } else {
    const [[{ n }]] = await db.query('SELECT COALESCE(MAX(line_no), 0) AS n FROM cf_purchase_order_lines WHERE company_id = ? AND purchase_order_id = ?', [c.companyId, p.id]);
    await db.query(
      `INSERT INTO cf_purchase_order_lines (company_id, purchase_order_id, line_no, item_id, quantity, uom, expected_date, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.companyId, p.id, Number(n) + 1, item.id, quantity, item.uom, expectedDate, blank(input.note) ? null : String(input.note).slice(0, 500)],
    );
  }
  await restate(db, c.companyId, p.id);
  return getPurchaseOrder(db, c.companyId, p.id);
}

export async function updatePurchaseLine(db, c, lineId, input = {}) {
  const l = await requireLine(db, c.companyId, lineId);
  assertOpen({ status: l.po_status, code: l.po_code });
  const problems = [];
  const sets = {};
  if (input.quantity !== undefined) {
    const q = readQty(input.quantity, 'Quantity', problems);
    if (q != null && q + EPS < Number(l.qty_received)) problems.push(`${fmt(l.qty_received)} has already been received on this line — the quantity cannot go below that.`);
    else if (q != null) sets.quantity = q;
  }
  if (input.expectedDate !== undefined) sets.expected_date = readDate(input.expectedDate, 'Expected date', problems);
  if (input.note !== undefined) sets.note = blank(input.note) ? null : String(input.note).slice(0, 500);
  assertNoProblems(problems);
  if (Object.keys(sets).length) {
    await db.query(`UPDATE cf_purchase_order_lines SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(sets), c.companyId, l.id]);
  }
  await restate(db, c.companyId, l.purchase_order_id);
  return getPurchaseOrder(db, c.companyId, l.purchase_order_id);
}

export async function removePurchaseLine(db, c, lineId) {
  const l = await requireLine(db, c.companyId, lineId);
  assertOpen({ status: l.po_status, code: l.po_code }, 'be removed');
  if (Number(l.qty_received) > EPS) throw invalid('RECEIVED', `${fmt(l.qty_received)} has already been received on this line — it cannot be removed.`);
  await db.query('UPDATE cf_purchase_order_lines SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, l.id]);
  await restate(db, c.companyId, l.purchase_order_id);
  return getPurchaseOrder(db, c.companyId, l.purchase_order_id);
}

// --- suggest, send, receive, cancel ----------------------------------------

/**
 * Suggests what to buy: ONE draft order carrying every short item, rewritten
 * in place each time so pressing the button twice does not buy twice. What is
 * already on another open order is netted off — except this order's own lines,
 * which are about to be replaced.
 */
export async function suggestPurchase(db, c) {
  const [[open]] = await db.query(
    "SELECT * FROM cf_purchase_orders WHERE company_id = ? AND suggested = 1 AND status = 'draft' AND deleted_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE",
    [c.companyId],
  );
  const rows = await buyList(db, c.companyId, { show: 'short', exceptOrderId: open?.id ?? null });
  if (!rows.length) {
    if (open) {
      await db.query('UPDATE cf_purchase_order_lines SET deleted_at = NOW() WHERE company_id = ? AND purchase_order_id = ? AND deleted_at IS NULL', [c.companyId, open.id]);
      await db.query("UPDATE cf_purchase_orders SET status = 'cancelled' WHERE company_id = ? AND id = ?", [c.companyId, open.id]);
    }
    return { order: null, lines: 0, message: 'Nothing is short — every released job has its material held or free in stock.' };
  }
  let poId = open?.id ?? null;
  if (poId) {
    await db.query('UPDATE cf_purchase_order_lines SET deleted_at = NOW() WHERE company_id = ? AND purchase_order_id = ? AND deleted_at IS NULL', [c.companyId, poId]);
  } else {
    poId = await insertOrder(db, c, {
      code: await nextCode(db, c, { suggested: true }),
      supplierId: null, expectedDate: null, suggested: true,
      notes: 'Suggested from what the released jobs are short of.',
    });
  }
  let lineNo = 1;
  await db.query(
    `INSERT INTO cf_purchase_order_lines (company_id, purchase_order_id, line_no, item_id, quantity, uom)
     VALUES ?`,
    [rows.map((r) => [c.companyId, poId, lineNo++, r.item.id, r.toBuy, r.item.uom])],
  );
  return { order: await getPurchaseOrder(db, c.companyId, poId), lines: rows.length, message: null };
}

/** Draft → ordered: the buyer has named the supplier and sent it. */
export async function markOrdered(db, c, id, input = {}) {
  const p = await requireOrder(db, c.companyId, id);
  if (p.status !== 'draft') throw invalid('NOT_DRAFT', `${p.code} is already ${PO_STATUS_LABEL[p.status].toLowerCase()}.`);
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
  const p = await requireOrder(db, c.companyId, id);
  if (p.status === 'cancelled') throw invalid('CANCELLED', `${p.code} is already cancelled.`);
  const [[{ n }]] = await db.query('SELECT COALESCE(SUM(qty_received), 0) AS n FROM cf_purchase_order_lines WHERE company_id = ? AND purchase_order_id = ? AND deleted_at IS NULL', [c.companyId, p.id]);
  if (Number(n) > EPS) throw invalid('RECEIVED', `${fmt(n)} has already been received against ${p.code} — it cannot be cancelled.`);
  const note = blank(input.reason) ? p.notes : `${p.notes ? `${p.notes}\n` : ''}Cancelled: ${String(input.reason).slice(0, 255)}`;
  await db.query("UPDATE cf_purchase_orders SET status = 'cancelled', suggested = 0, notes = ? WHERE company_id = ? AND id = ?", [note, c.companyId, p.id]);
  return getPurchaseOrder(db, c.companyId, p.id);
}

/**
 * Books a delivery against one line: an ordinary stock receipt, stamped with
 * the line it came in against. Over-delivery is refused — a note for more than
 * was ordered is a question for the buyer, not a quiet correction.
 */
export async function receiveLine(db, c, lineId, input = {}) {
  const l = await requireLine(db, c.companyId, lineId);
  if (l.po_status === 'draft') throw invalid('NOT_ORDERED', `${l.po_code} has not been sent yet — send it to the supplier first.`);
  assertOpen({ status: l.po_status, code: l.po_code }, 'be received');
  const problems = [];
  const left = outstandingOf(l);
  const quantity = readQty(input.quantity ?? left, 'Quantity', problems);
  if (quantity != null && quantity > left + EPS) problems.push(`Only ${fmt(left)} ${l.uom} of this line is still outstanding.`);
  if (blank(input.stockingAreaId)) problems.push('Say which stocking area it went into.');
  assertNoProblems(problems, 'The delivery cannot be booked.');
  const movement = await postMovement(db, c, {
    movementType: 'receipt',
    toAreaId: input.stockingAreaId,
    partyId: l.supplier_id ?? undefined,
    movementDate: input.movementDate,
    reference: input.reference,
    notes: input.notes,
    lines: [{ itemId: l.item_id, quantity, batchId: input.batchId, batch: input.batch, notes: input.note }],
  });
  await db.query('UPDATE cf_stock_movements SET purchase_line_id = ? WHERE company_id = ? AND id = ?', [l.id, c.companyId, movement.id]);
  await db.query('UPDATE cf_purchase_order_lines SET qty_received = qty_received + ? WHERE company_id = ? AND id = ?', [quantity, c.companyId, l.id]);
  await restate(db, c.companyId, l.purchase_order_id);
  return { movement, order: await getPurchaseOrder(db, c.companyId, l.purchase_order_id) };
}

/** For the nav badge and Home: how many items are short, and how many orders are waiting. */
export async function purchaseCounts(db, companyId) {
  const short = (await buyList(db, companyId, { show: 'short' })).length;
  const [[{ drafts }]] = await db.query("SELECT COUNT(*) AS drafts FROM cf_purchase_orders WHERE company_id = ? AND status = 'draft' AND deleted_at IS NULL", [companyId]);
  const [[{ awaiting }]] = await db.query("SELECT COUNT(*) AS awaiting FROM cf_purchase_orders WHERE company_id = ? AND status IN ('ordered','partially_received') AND deleted_at IS NULL", [companyId]);
  return { toBuy: short, draftOrders: Number(drafts), awaitingDelivery: Number(awaiting) };
}
