/**
 * purchaseLinkService.js — purchase order lines bought FOR a sales order, and
 * what arrives on them held for it (init.sql §43).
 *
 * A PO line carries ALLOCATIONS (cf_purchase_line_orders): "12 t of this line
 * is for SO-…-0001, 8 t for SO-…-0004". Whatever is not allocated is bought for
 * stock. The PO header's for_order_id is only the default a new line takes.
 *
 * RECEIVING HOLDS. A delivery is handed to the line's allocations in order
 * (oldest allocation first), each up to what it still expects; each share
 * becomes a HOLD — a cf_stock_reservations row with held_for_order_id and
 * purchase_line_id, requirement_id and order_line_id both NULL. availability()
 * subtracts every active reservation, so held stock is free for nobody else.
 *
 * WHOSE HOLD. An order is matched by its NUMBER (code_active), not its id: a
 * revision is another cf_sales_orders row with the same number, and keeps what
 * was held for the revision before it.
 *
 * USING A HOLD. Release takes the order's own holds first (releaseService
 * reserveRelease / reserveOne via ownHoldRows + consumeHolds): the claim moves
 * from the hold to the requirement, so nothing is ever reserved twice.
 * A hold ends when the order closes or is cancelled, or by hand (releaseHold).
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';

const EPS = 1e-6;
const round6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const fmt = (n) => Number(Number(n).toFixed(3));

/** Orders a purchase can be bought for: not closed, lost, cancelled or replaced by a revision. */
const LINKABLE = ['draft', 'inquiry', 'quoted', 'confirmed'];

/** The sales order a purchase is bought for, or a problem pushed. */
export async function requireLinkableOrder(db, companyId, orderId, problems) {
  const [[o]] = await db.query('SELECT id, code, status FROM cf_sales_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(orderId)]);
  if (!o) { problems.push('That sales order does not exist.'); return null; }
  if (!LINKABLE.includes(o.status)) { problems.push(`${o.code} is ${o.status} — a purchase cannot be bought for it.`); return null; }
  return o;
}

/** Allocations of the given PO lines: Map lineId -> [{ id, orderId, orderCode, quantity, received }], oldest first. 1 read. */
export async function allocationsOf(db, companyId, lineIds) {
  const out = new Map();
  if (!lineIds.length) return out;
  const [rows] = await db.query(
    `SELECT a.id, a.purchase_line_id, a.order_id, o.code AS order_code, a.quantity, a.qty_received
       FROM cf_purchase_line_orders a JOIN cf_sales_orders o ON o.id = a.order_id
      WHERE a.company_id = ? AND a.purchase_line_id IN (?) AND a.deleted_at IS NULL
      ORDER BY a.purchase_line_id, a.id`,
    [companyId, lineIds],
  );
  for (const r of rows) {
    if (!out.has(r.purchase_line_id)) out.set(r.purchase_line_id, []);
    out.get(r.purchase_line_id).push({ id: r.id, orderId: r.order_id, orderCode: r.order_code, quantity: Number(r.quantity), received: Number(r.qty_received) });
  }
  return out;
}

/** Distinct sales-order codes per purchase order, for the list. Map poId -> [code]. 1 read. */
export async function orderCodesOfPos(db, companyId, poIds) {
  const out = new Map();
  if (!poIds.length) return out;
  const [rows] = await db.query(
    `SELECT DISTINCT l.purchase_order_id, o.code
       FROM cf_purchase_line_orders a
       JOIN cf_purchase_order_lines l ON l.id = a.purchase_line_id AND l.deleted_at IS NULL
       JOIN cf_sales_orders o ON o.id = a.order_id
      WHERE a.company_id = ? AND l.purchase_order_id IN (?) AND a.deleted_at IS NULL
      ORDER BY l.purchase_order_id, o.code`,
    [companyId, poIds],
  );
  for (const r of rows) {
    if (!out.has(r.purchase_order_id)) out.set(r.purchase_order_id, []);
    out.get(r.purchase_order_id).push(r.code);
  }
  return out;
}

/** Adds `quantity` of a line for an order (to its allocation, if it has one). */
export async function addAllocation(db, c, lineId, orderId, quantity) {
  if (quantity <= EPS) return;
  const [[a]] = await db.query(
    'SELECT id, quantity FROM cf_purchase_line_orders WHERE company_id = ? AND purchase_line_id = ? AND order_id = ? AND deleted_at IS NULL',
    [c.companyId, lineId, orderId],
  );
  if (a) await db.query('UPDATE cf_purchase_line_orders SET quantity = ? WHERE company_id = ? AND id = ?', [round6(Number(a.quantity) + quantity), c.companyId, a.id]);
  else await db.query('INSERT INTO cf_purchase_line_orders (company_id, purchase_line_id, order_id, quantity, created_by) VALUES (?, ?, ?, ?, ?)', [c.companyId, lineId, orderId, round6(quantity), c.userId ?? null]);
}

/**
 * Bulk insert of fresh allocations (Suggest, RFQ create-pos): rows of
 * { lineId, orderId, quantity }. Same line + order are summed. 1 statement.
 */
export async function insertAllocations(db, c, rows) {
  const merged = new Map();
  for (const r of rows) {
    if (!(Number(r.quantity) > EPS)) continue;
    const k = `${r.lineId}:${r.orderId}`;
    merged.set(k, { ...r, quantity: round6((merged.get(k)?.quantity ?? 0) + Number(r.quantity)) });
  }
  if (!merged.size) return;
  await insertRows(db, 'cf_purchase_line_orders', ['company_id', 'purchase_line_id', 'order_id', 'quantity', 'created_by'],
    [...merged.values()].map((r) => [c.companyId, r.lineId, r.orderId, r.quantity, c.userId ?? null]));
}

/** Soft-deletes every allocation of the given lines (Suggest rewrites its lines). */
export async function dropAllocations(db, companyId, lineIds) {
  if (!lineIds.length) return;
  await db.query('UPDATE cf_purchase_line_orders SET deleted_at = NOW() WHERE company_id = ? AND purchase_line_id IN (?) AND deleted_at IS NULL', [companyId, lineIds]);
}

/**
 * Replaces a line's allocations. orders: [{ orderId, quantity }]. Sum ≤ the
 * line's quantity; each at least what was already received against it; an
 * order once. An allocation left out that has received something cannot go.
 */
export async function setAllocations(db, c, line, orders) {
  const problems = [];
  if (!Array.isArray(orders)) throw invalid('INVALID', 'Send the orders this line is bought for, as a list.');
  const current = (await allocationsOf(db, c.companyId, [line.id])).get(line.id) ?? [];
  const byOrder = new Map(current.map((a) => [a.orderId, a]));
  const seen = new Set();
  const want = [];
  for (const [k, o] of orders.entries()) {
    const orderId = Number(o?.orderId);
    const q = Number(o?.quantity);
    if (!Number.isInteger(orderId)) { problems.push(`Row ${k + 1}: choose a sales order.`); continue; }
    if (seen.has(orderId)) { problems.push(`Row ${k + 1}: that sales order is already on this line.`); continue; }
    seen.add(orderId);
    if (!Number.isFinite(q) || q <= 0) { problems.push(`Row ${k + 1}: quantity must be more than zero.`); continue; }
    const had = byOrder.get(orderId);
    if (!had && !(await requireLinkableOrder(db, c.companyId, orderId, problems))) continue;
    if (had && q + EPS < had.received) problems.push(`${had.orderCode}: ${fmt(had.received)} has already arrived for it — the quantity cannot go below that.`);
    want.push({ orderId, quantity: round6(q), had });
  }
  for (const a of current) {
    if (!seen.has(a.orderId) && a.received > EPS) problems.push(`${a.orderCode}: ${fmt(a.received)} has already arrived for it — it cannot be taken off this line.`);
  }
  const total = round6(want.reduce((t, w) => t + w.quantity, 0));
  if (total > Number(line.quantity) + EPS) problems.push(`That is ${fmt(total)} ${line.uom} for orders, but the line is only ${fmt(line.quantity)} ${line.uom}.`);
  assertNoProblems(problems, 'The line cannot be bought for those orders.');
  const gone = current.filter((a) => !seen.has(a.orderId)).map((a) => a.id);
  if (gone.length) await db.query('UPDATE cf_purchase_line_orders SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [c.companyId, gone]);
  for (const w of want) {
    if (w.had) {
      if (Math.abs(w.had.quantity - w.quantity) > EPS) await db.query('UPDATE cf_purchase_line_orders SET quantity = ? WHERE company_id = ? AND id = ?', [w.quantity, c.companyId, w.had.id]);
    } else {
      await db.query('INSERT INTO cf_purchase_line_orders (company_id, purchase_line_id, order_id, quantity, created_by) VALUES (?, ?, ?, ?, ?)', [c.companyId, line.id, w.orderId, w.quantity, c.userId ?? null]);
    }
  }
}

/**
 * The line's quantity is going down to `quantity`: trims allocations, newest
 * first, never below what each has received. Problems pushed when it cannot.
 */
export async function trimAllocations(db, c, line, quantity, problems) {
  const current = (await allocationsOf(db, c.companyId, [line.id])).get(line.id) ?? [];
  let over = round6(current.reduce((t, a) => t + a.quantity, 0) - quantity);
  if (over <= EPS) return;
  const writes = [];
  for (const a of [...current].reverse()) {
    if (over <= EPS) break;
    const cut = Math.min(over, round6(a.quantity - a.received));
    if (cut <= EPS) continue;
    writes.push({ id: a.id, quantity: round6(a.quantity - cut) });
    over = round6(over - cut);
  }
  if (over > EPS) { problems.push(`That leaves less on the line than has already arrived for its sales orders.`); return; }
  for (const w of writes) {
    if (w.quantity <= EPS) await db.query('UPDATE cf_purchase_line_orders SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, w.id]);
    else await db.query('UPDATE cf_purchase_line_orders SET quantity = ? WHERE company_id = ? AND id = ?', [w.quantity, c.companyId, w.id]);
  }
}

/**
 * Hands a delivery of `quantity` on a line to its allocations, oldest first,
 * each up to what it still expects, and holds each share in the stock that
 * came in (batchId: the receipt's batch, or null). Returns [{ orderId, orderCode, quantity }].
 */
export async function holdOnReceipt(db, c, line, quantity, batchId) {
  const current = (await allocationsOf(db, c.companyId, [line.id])).get(line.id) ?? [];
  let left = round6(quantity);
  const held = [];
  for (const a of current) {
    if (left <= EPS) break;
    const take = round6(Math.min(left, Math.max(0, a.quantity - a.received)));
    if (take <= EPS) continue;
    await db.query('UPDATE cf_purchase_line_orders SET qty_received = qty_received + ? WHERE company_id = ? AND id = ?', [take, c.companyId, a.id]);
    held.push({ orderId: a.orderId, orderCode: a.orderCode, quantity: take });
    left = round6(left - take);
  }
  if (held.length) {
    await insertRows(db, 'cf_stock_reservations',
      ['company_id', 'held_for_order_id', 'purchase_line_id', 'item_id', 'batch_id', 'quantity', 'created_by'],
      held.map((h) => [c.companyId, h.orderId, line.id, line.item_id, batchId ?? null, h.quantity, c.userId ?? null]));
  }
  return held;
}

/**
 * Active holds of an order (by its number, so every revision) for the given
 * items, oldest first, locked: [{ id, item_id, batch_id, quantity }]. With
 * itemIds null, every item. 1 read.
 */
export async function ownHoldRows(db, companyId, orderId, itemIds = null, { lock = false } = {}) {
  if (!orderId || (itemIds && !itemIds.length)) return [];
  const [rows] = await db.query(
    `SELECT v.id, v.item_id, v.batch_id, v.quantity, v.purchase_line_id, v.held_for_order_id
       FROM cf_stock_reservations v
       JOIN cf_sales_orders ho ON ho.id = v.held_for_order_id
       JOIN cf_sales_orders so ON so.company_id = ho.company_id AND so.code_active = ho.code_active
      WHERE v.company_id = ? AND so.id = ? AND v.status = 'active' AND v.deleted_at IS NULL AND v.held_for_order_id IS NOT NULL
        ${itemIds ? 'AND v.item_id IN (?)' : ''}
      ORDER BY v.id${lock ? ' FOR UPDATE' : ''}`,
    itemIds ? [companyId, orderId, itemIds] : [companyId, orderId],
  );
  return rows.map((r) => ({ ...r, quantity: Number(r.quantity) }));
}

/**
 * Takes `quantity` of an item (and batch: null = any) off the given
 * hold rows, oldest first, in memory: returns the writes { id, quantity } to
 * make (quantity 0 = consumed). Pure, so release can plan many at once.
 */
export function takeHolds(holds, itemId, batchId, quantity) {
  let left = round6(quantity);
  const writes = [];
  for (const h of holds) {
    if (left <= EPS) break;
    // A claim on loose stock (no batch) is how an item counted by quantity is claimed, whatever lot it sits in.
    if (h.item_id !== itemId || (batchId != null && (h.batch_id ?? 0) !== batchId) || h.quantity <= EPS) continue;
    const take = Math.min(left, h.quantity);
    h.quantity = round6(h.quantity - take);
    left = round6(left - take);
    writes.push({ id: h.id, quantity: h.quantity });
  }
  return writes;
}

/** Writes takeHolds' answer: a hold used up is 'consumed', a part used keeps the rest. Last write per hold wins. */
export async function writeHoldTakes(db, companyId, writes) {
  const last = new Map();
  for (const w of writes) last.set(w.id, w.quantity);
  for (const [id, q] of last) {
    if (q <= EPS) await db.query("UPDATE cf_stock_reservations SET quantity = 0, status = 'consumed', closed_at = NOW() WHERE company_id = ? AND id = ?", [companyId, id]);
    else await db.query('UPDATE cf_stock_reservations SET quantity = ? WHERE company_id = ? AND id = ?', [q, companyId, id]);
  }
}

/** Ends every active hold of an order (by number). On close or cancel. */
export async function releaseOrderHolds(db, companyId, orderId) {
  await db.query(
    `UPDATE cf_stock_reservations v
       JOIN cf_sales_orders ho ON ho.id = v.held_for_order_id
       JOIN cf_sales_orders so ON so.company_id = ho.company_id AND so.code_active = ho.code_active
        SET v.status = 'released', v.closed_at = NOW()
      WHERE v.company_id = ? AND so.id = ? AND v.status = 'active' AND v.held_for_order_id IS NOT NULL`,
    [companyId, orderId],
  );
}

/** POST /stock/holds/:id/release — lets one hold go; the stock is free for any job. */
export async function releaseHold(db, c, id) {
  const [[v]] = await db.query(
    'SELECT id, status FROM cf_stock_reservations WHERE company_id = ? AND id = ? AND held_for_order_id IS NOT NULL AND deleted_at IS NULL FOR UPDATE',
    [c.companyId, Number(id)],
  );
  if (!v) throw notFound('Hold');
  if (v.status !== 'active') throw invalid('INVALID', 'This hold has already ended.');
  await db.query("UPDATE cf_stock_reservations SET status = 'released', closed_at = NOW() WHERE company_id = ? AND id = ?", [c.companyId, v.id]);
  return { ok: true };
}

/** What is held for an order (by number), for its Buying stage. 1 read. */
export async function heldForOrder(db, companyId, orderId) {
  const [rows] = await db.query(
    `SELECT v.id, v.item_id, m.code AS item_code, m.name AS item_name, i.uom, v.quantity,
            v.batch_id, b.code AS batch_code, p.id AS po_id, p.code AS po_code
       FROM cf_stock_reservations v
       JOIN cf_sales_orders ho ON ho.id = v.held_for_order_id
       JOIN cf_sales_orders so ON so.company_id = ho.company_id AND so.code_active = ho.code_active
       JOIN cf_master_records m ON m.id = v.item_id
       JOIN cf_item_details i ON i.master_id = v.item_id
       LEFT JOIN cf_stock_batches b ON b.id = v.batch_id
       LEFT JOIN cf_purchase_order_lines l ON l.id = v.purchase_line_id
       LEFT JOIN cf_purchase_orders p ON p.id = l.purchase_order_id
      WHERE v.company_id = ? AND so.id = ? AND v.status = 'active' AND v.deleted_at IS NULL AND v.held_for_order_id IS NOT NULL
      ORDER BY m.code, v.id`,
    [companyId, Number(orderId)],
  );
  const out = rows.map((r) => ({
    id: r.id,
    item: { id: r.item_id, code: r.item_code, name: r.item_name, uom: r.uom },
    quantity: Number(r.quantity),
    batch: r.batch_id ? { id: r.batch_id, code: r.batch_code } : null,
    purchaseOrder: r.po_id ? { id: r.po_id, code: r.po_code } : null,
  }));
  return { total: out.length, rows: out };
}

/**
 * Active holds per (order NUMBER, item), for the buy list: Map `${codeActive}:${itemId}` -> quantity. 1 read.
 */
export async function holdsByOrderItem(db, companyId, itemIds) {
  const out = new Map();
  if (!itemIds.length) return out;
  const [rows] = await db.query(
    `SELECT ho.code_active, v.item_id, SUM(v.quantity) AS qty
       FROM cf_stock_reservations v JOIN cf_sales_orders ho ON ho.id = v.held_for_order_id
      WHERE v.company_id = ? AND v.item_id IN (?) AND v.status = 'active' AND v.deleted_at IS NULL AND v.held_for_order_id IS NOT NULL
      GROUP BY ho.code_active, v.item_id`,
    [companyId, itemIds],
  );
  for (const r of rows) out.set(`${r.code_active}:${r.item_id}`, round6(r.qty));
  return out;
}

/**
 * Outstanding quantity on OPEN purchase orders bought for an order, per (order
 * NUMBER, item): Map `${codeActive}:${itemId}` -> quantity (allocated − received). 1 read.
 */
export async function linkedOnOrder(db, companyId, openStatuses, { exceptPoId = null } = {}) {
  const [rows] = await db.query(
    `SELECT o.code_active, l.item_id, SUM(GREATEST(a.quantity - a.qty_received, 0)) AS qty
       FROM cf_purchase_line_orders a
       JOIN cf_purchase_order_lines l ON l.id = a.purchase_line_id AND l.deleted_at IS NULL
       JOIN cf_purchase_orders p ON p.id = l.purchase_order_id AND p.deleted_at IS NULL
       JOIN cf_sales_orders o ON o.id = a.order_id
      WHERE a.company_id = ? AND a.deleted_at IS NULL AND p.status IN (?) ${exceptPoId ? 'AND p.id <> ?' : ''}
      GROUP BY o.code_active, l.item_id`,
    exceptPoId ? [companyId, openStatuses, exceptPoId] : [companyId, openStatuses],
  );
  const out = new Map();
  for (const r of rows) if (Number(r.qty) > EPS) out.set(`${r.code_active}:${r.item_id}`, round6(r.qty));
  return out;
}

/** Purchase orders with any line bought for an order (by number). 1 read. */
export async function linkedPoIds(db, companyId, orderId) {
  const [rows] = await db.query(
    `SELECT DISTINCT l.purchase_order_id AS id
       FROM cf_purchase_line_orders a
       JOIN cf_purchase_order_lines l ON l.id = a.purchase_line_id AND l.deleted_at IS NULL
       JOIN cf_sales_orders ao ON ao.id = a.order_id
       JOIN cf_sales_orders so ON so.company_id = ao.company_id AND so.code_active = ao.code_active
      WHERE a.company_id = ? AND so.id = ? AND a.deleted_at IS NULL`,
    [companyId, Number(orderId)],
  );
  return rows.map((r) => r.id);
}

