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

/**
 * Allocations of the given PO lines: Map lineId -> [{ id, orderId, orderCode, quantity, received,
 * prLineId, requisition }], oldest first. prLineId (init.sql §56) is the requisition line the share
 * is for — null when it is bought for the order as a whole; `requisition` then names it
 * ({ id, code, lineNo }). 1 read.
 */
export async function allocationsOf(db, companyId, lineIds) {
  const out = new Map();
  if (!lineIds.length) return out;
  const [rows] = await db.query(
    `SELECT a.id, a.purchase_line_id, a.order_id, o.code AS order_code, a.quantity, a.qty_received, a.pr_line_id,
            rq.id AS requisition_id, rq.code AS requisition_code, sl.line_no AS requisition_line_no
       FROM cf_purchase_line_orders a JOIN cf_sales_orders o ON o.id = a.order_id
       LEFT JOIN cf_requisition_lines prl ON prl.id = a.pr_line_id
       LEFT JOIN cf_requisitions rq ON rq.id = prl.requisition_id
       LEFT JOIN cf_sales_order_lines sl ON sl.id = rq.order_line_id
      WHERE a.company_id = ? AND a.purchase_line_id IN (?) AND a.deleted_at IS NULL
      ORDER BY a.purchase_line_id, a.id`,
    [companyId, lineIds],
  );
  for (const r of rows) {
    if (!out.has(r.purchase_line_id)) out.set(r.purchase_line_id, []);
    const row = { id: r.id, orderId: r.order_id, orderCode: r.order_code, quantity: Number(r.quantity), received: Number(r.qty_received) };
    // Only a share bought for a requisition line says so: every older reader sees the shape it always did.
    if (r.pr_line_id != null) {
      row.prLineId = r.pr_line_id;
      row.requisition = r.requisition_id ? { id: r.requisition_id, code: r.requisition_code, lineNo: r.requisition_line_no ?? null } : null;
    }
    out.get(r.purchase_line_id).push(row);
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
  // The order's own share: one bought for a requisition line of it (§56) is another row, and is left alone.
  const [[a]] = await db.query(
    'SELECT id, quantity FROM cf_purchase_line_orders WHERE company_id = ? AND purchase_line_id = ? AND order_id = ? AND pr_line_id IS NULL AND deleted_at IS NULL',
    [c.companyId, lineId, orderId],
  );
  if (a) await db.query('UPDATE cf_purchase_line_orders SET quantity = ? WHERE company_id = ? AND id = ?', [round6(Number(a.quantity) + quantity), c.companyId, a.id]);
  else await db.query('INSERT INTO cf_purchase_line_orders (company_id, purchase_line_id, order_id, quantity, created_by) VALUES (?, ?, ?, ?, ?)', [c.companyId, lineId, orderId, round6(quantity), c.userId ?? null]);
}

/**
 * Bulk insert of fresh allocations (Suggest, RFQ create-pos): rows of
 * { lineId, orderId, quantity, prLineId? }. Same line + order (+ requisition
 * line, §56) are summed. 1 statement.
 */
export async function insertAllocations(db, c, rows) {
  const merged = new Map();
  for (const r of rows) {
    if (!(Number(r.quantity) > EPS)) continue;
    const k = `${r.lineId}:${r.orderId}:${r.prLineId ?? 0}`;
    merged.set(k, { ...r, quantity: round6((merged.get(k)?.quantity ?? 0) + Number(r.quantity)) });
  }
  if (!merged.size) return;
  await insertRows(db, 'cf_purchase_line_orders', ['company_id', 'purchase_line_id', 'order_id', 'pr_line_id', 'quantity', 'created_by'],
    [...merged.values()].map((r) => [c.companyId, r.lineId, r.orderId, r.prLineId ?? null, r.quantity, c.userId ?? null]));
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
  /*
   * A row is an order, or (§56) a requisition line of an order: { orderId,
   * quantity, prLineId? }. A row that names no requisition line keeps the one
   * the order's share already has here — the screen that only knows orders
   * must not cut a share loose from its requisition by saving it.
   */
  const keyOf = (orderId, prLineId) => `${orderId}:${prLineId ?? 0}`;
  const byKey = new Map(current.map((a) => [keyOf(a.orderId, a.prLineId), a]));
  const used = new Set();
  const seen = new Set();
  const want = [];
  for (const [k, o] of orders.entries()) {
    const orderId = Number(o?.orderId);
    const q = Number(o?.quantity);
    if (!Number.isInteger(orderId)) { problems.push(`Row ${k + 1}: choose a sales order.`); continue; }
    const named = o?.prLineId === undefined || o?.prLineId === null || o?.prLineId === '' ? null : Number(o.prLineId);
    let had = named != null ? byKey.get(keyOf(orderId, named)) ?? null : null;
    if (named == null) had = current.find((a) => a.orderId === orderId && !used.has(a.id)) ?? null;
    const prLineId = named ?? had?.prLineId ?? null;
    const key = keyOf(orderId, prLineId);
    if (seen.has(key)) { problems.push(`Row ${k + 1}: that sales order is already on this line.`); continue; }
    seen.add(key);
    if (had) used.add(had.id);
    if (!Number.isFinite(q) || q <= 0) { problems.push(`Row ${k + 1}: quantity must be more than zero.`); continue; }
    if (!had && !(await requireLinkableOrder(db, c.companyId, orderId, problems))) continue;
    if (had && q + EPS < had.received) problems.push(`${had.orderCode}: ${fmt(had.received)} has already arrived for it — the quantity cannot go below that.`);
    want.push({ orderId, prLineId, quantity: round6(q), had });
  }
  for (const a of current) {
    if (!used.has(a.id) && a.received > EPS) problems.push(`${a.orderCode}: ${fmt(a.received)} has already arrived for it — it cannot be taken off this line.`);
  }
  const fresh = want.filter((w) => !w.had && w.prLineId != null);
  if (fresh.length) {
    const [rows] = await db.query(
      `SELECT pl.id, pl.item_id FROM cf_requisition_lines pl JOIN cf_requisitions r ON r.id = pl.requisition_id AND r.deleted_at IS NULL
        WHERE pl.company_id = ? AND pl.id IN (?) AND pl.deleted_at IS NULL`,
      [c.companyId, fresh.map((w) => w.prLineId)],
    );
    const known = new Map(rows.map((r) => [r.id, r]));
    for (const w of fresh) {
      const pl = known.get(w.prLineId);
      if (!pl) problems.push('That requisition line does not exist.');
      else if (Number(pl.item_id) !== Number(line.item_id)) problems.push('That requisition line asks for a different item than this purchase line.');
    }
  }
  const total = round6(want.reduce((t, w) => t + w.quantity, 0));
  if (total > Number(line.quantity) + EPS) problems.push(`That is ${fmt(total)} ${line.uom} for orders, but the line is only ${fmt(line.quantity)} ${line.uom}.`);
  assertNoProblems(problems, 'The line cannot be bought for those orders.');
  const gone = current.filter((a) => !used.has(a.id)).map((a) => a.id);
  if (gone.length) await db.query('UPDATE cf_purchase_line_orders SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [c.companyId, gone]);
  for (const w of want) {
    if (w.had) {
      if (Math.abs(w.had.quantity - w.quantity) > EPS) await db.query('UPDATE cf_purchase_line_orders SET quantity = ? WHERE company_id = ? AND id = ?', [w.quantity, c.companyId, w.had.id]);
    } else {
      await db.query('INSERT INTO cf_purchase_line_orders (company_id, purchase_line_id, order_id, pr_line_id, quantity, created_by) VALUES (?, ?, ?, ?, ?, ?)', [c.companyId, line.id, w.orderId, w.prLineId, w.quantity, c.userId ?? null]);
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
    held.push({ orderId: a.orderId, orderCode: a.orderCode, quantity: take, ...(a.prLineId != null ? { prLineId: a.prLineId } : {}) });
    left = round6(left - take);
  }
  if (held.length) {
    // The hold lands on the requisition line the share was bought for (§56): two lines of one order never count it twice.
    await insertRows(db, 'cf_stock_reservations',
      ['company_id', 'held_for_order_id', 'pr_line_id', 'purchase_line_id', 'item_id', 'batch_id', 'quantity', 'created_by'],
      held.map((h) => [c.companyId, h.orderId, h.prLineId ?? null, line.id, line.item_id, batchId ?? null, h.quantity, c.userId ?? null]));
  }
  return held;
}

/**
 * Active holds of an order (by its number, so every revision) for the given
 * items, oldest first, locked: [{ id, item_id, batch_id, quantity, line_id }].
 * line_id (§56) is the order line whose requisition line owns the hold — null
 * for a hold of the order as a whole. With itemIds null, every item. 1 read.
 */
export async function ownHoldRows(db, companyId, orderId, itemIds = null, { lock = false } = {}) {
  if (!orderId || (itemIds && !itemIds.length)) return [];
  const [rows] = await db.query(
    `SELECT v.id, v.item_id, v.batch_id, v.quantity, v.purchase_line_id, v.held_for_order_id, v.pr_line_id,
            (SELECT prl.order_line_id FROM cf_requisition_lines prl WHERE prl.id = v.pr_line_id AND prl.deleted_at IS NULL) AS line_id
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
 * `lineId` (§56): the order line the claim is for — its own requisition line's
 * holds go first, then the order's; a hold of ANOTHER line of the order is
 * never taken. Left out: any hold of the order, oldest first, as before.
 */
export function takeHolds(holds, itemId, batchId, quantity, lineId = null) {
  let left = round6(quantity);
  const writes = [];
  const passes = lineId == null
    ? [() => true]
    : [(h) => h.line_id != null && Number(h.line_id) === Number(lineId), (h) => h.line_id == null];
  for (const mine of passes) {
    for (const h of holds) {
      if (left <= EPS) break;
      // A claim on loose stock (no batch) is how an item counted by quantity is claimed, whatever lot it sits in.
      if (!mine(h) || h.item_id !== itemId || (batchId != null && (h.batch_id ?? 0) !== batchId) || h.quantity <= EPS) continue;
      const take = Math.min(left, h.quantity);
      h.quantity = round6(h.quantity - take);
      left = round6(left - take);
      writes.push({ id: h.id, quantity: h.quantity });
    }
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
    `SELECT v.id, v.item_id, m.code AS item_code, m.name AS item_name, i.uom, v.quantity, v.pr_line_id,
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
    // §56: the requisition line the hold belongs to (null = held for the order as a whole).
    prLineId: r.pr_line_id ?? null,
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


/**
 * A RECEIPT ON A PURCHASE LINE IS REVERSED (stockService.reverseMovement, §56).
 * The steel goes back out, so what it did on arrival is undone, exactly as far
 * as it must be:
 *   - of the stock that leaves, whatever is still HELD from this purchase line
 *     (holdOnReceipt's holds, on that lot) and would no longer be on the shelf
 *     is let go — newest hold first, and only the part the shelf cannot keep;
 *     each share's allocation gets its qty_received back down, so the
 *     requisition line shows it as still coming and the engine goes back to
 *     the PO line's date (or to waiting);
 *   - the purchase line's qty_received falls by the quantity reversed, and the
 *     purchase order's status follows (received → part received → ordered).
 * REFUSED, in words, only when that stock has moved on to production: it is
 * reserved for a release's requirement, or already issued — the sentence names
 * the sales order (and line) that has it.
 * legs: [{ itemId, batchId, quantity (> 0, what leaves), label }]. Fixed reads per leg (a receipt has one).
 */
export async function unreceive(db, c, movement, legs) {
  const [[line]] = await db.query(
    `SELECT l.id, l.purchase_order_id, l.quantity, l.qty_received, l.uom, p.code AS po_code, p.status AS po_status
       FROM cf_purchase_order_lines l JOIN cf_purchase_orders p ON p.id = l.purchase_order_id
      WHERE l.company_id = ? AND l.id = ? FOR UPDATE`,
    [c.companyId, movement.purchase_line_id],
  );
  if (!line) return { released: [] };
  const released = [];
  let total = 0;
  for (const leg of legs) {
    const qty = round6(leg.quantity);
    total = round6(total + qty);
    const batchKey = leg.batchId ?? 0;
    const [[{ usable }]] = await db.query(
      `SELECT COALESCE(SUM(k.quantity), 0) AS usable FROM cf_stock_balances k JOIN cf_stocking_areas a ON a.id = k.stocking_area_id
        WHERE k.company_id = ? AND k.item_id = ? AND k.batch_key = ? AND a.purpose IN ('storage','wip')`,
      [c.companyId, leg.itemId, batchKey],
    );
    if (Number(usable) + EPS < qty) {
      // Less on the shelf than came in: it was issued to production.
      const [who] = await db.query(
        `SELECT DISTINCT o.code, ol.line_no FROM cf_stock_ledger k
           JOIN cf_stock_movements v ON v.id = k.movement_id AND v.movement_type = 'issue' AND v.deleted_at IS NULL AND v.reversed_by_id IS NULL
           JOIN cf_sales_orders o ON o.id = v.order_id
           LEFT JOIN cf_sales_order_lines ol ON ol.id = v.order_line_id
          WHERE k.company_id = ? AND k.item_id = ? AND IFNULL(k.batch_id, 0) = ? AND k.quantity < 0 AND k.deleted_at IS NULL ORDER BY o.code`,
        [c.companyId, leg.itemId, batchKey],
      );
      if (who.length) {
        throw invalid('ISSUED', `${movement.code} cannot be reversed — ${fmt(round6(qty - Number(usable)))} ${line.uom} of ${leg.label} has already been issued to production for ${who.map((w) => `${w.code}${w.line_no ? ` line ${w.line_no}` : ''}`).join(', ')}. Only ${fmt(usable)} is still in stock.`);
      }
      continue;                                      // stockService says the rest (moved, scrapped …)
    }
    const [res] = await db.query(
      `SELECT v.id, v.quantity, v.requirement_id, v.held_for_order_id, v.pr_line_id, v.purchase_line_id, o.code AS order_code, ol.line_no
         FROM cf_stock_reservations v
         LEFT JOIN cf_material_requirements q ON q.id = v.requirement_id
         LEFT JOIN cf_production_releases r ON r.id = q.release_id
         LEFT JOIN cf_sales_orders o ON o.id = COALESCE(r.order_id, v.held_for_order_id)
         LEFT JOIN cf_sales_order_lines ol ON ol.id = r.order_line_id
        WHERE v.company_id = ? AND v.item_id = ? AND IFNULL(v.batch_id, 0) = ? AND v.status = 'active' AND v.deleted_at IS NULL
          AND (v.requirement_id IS NOT NULL OR v.held_for_order_id IS NOT NULL)
        ORDER BY v.id DESC FOR UPDATE`,
      [c.companyId, leg.itemId, batchKey],
    );
    const reserved = round6(res.reduce((t, v) => t + Number(v.quantity), 0));
    let excess = round6(reserved - (Number(usable) - qty));   // what the shelf can no longer keep reserved
    if (excess <= EPS) continue;
    const mine = res.filter((v) => v.held_for_order_id != null && v.purchase_line_id === line.id);
    const mineQty = round6(mine.reduce((t, v) => t + Number(v.quantity), 0));
    if (mineQty + EPS < excess) {
      const prod = res.filter((v) => v.requirement_id != null);
      const names = [...new Set(prod.map((v) => `${v.order_code}${v.line_no ? ` line ${v.line_no}` : ''}`))];
      if (names.length) {
        throw invalid('RESERVED', `${movement.code} cannot be reversed — ${fmt(round6(excess - mineQty))} ${line.uom} of ${leg.label} from it is already reserved for production: ${names.join(', ')}. Let that reservation go first (Production › the line › its material), then reverse the receipt.`);
      }
      // Held by hand for another order: stockService's own refusal names it.
      excess = mineQty;
    }
    for (const v of mine) {
      if (excess <= EPS) break;
      const t = round6(Math.min(excess, Number(v.quantity)));
      const left = round6(Number(v.quantity) - t);
      if (left <= EPS) await db.query("UPDATE cf_stock_reservations SET status = 'released', closed_at = NOW() WHERE company_id = ? AND id = ?", [c.companyId, v.id]);
      else await db.query('UPDATE cf_stock_reservations SET quantity = ? WHERE company_id = ? AND id = ?', [left, c.companyId, v.id]);
      // The share it arrived for is still to come again.
      await db.query(
        `UPDATE cf_purchase_line_orders SET qty_received = GREATEST(qty_received - ?, 0)
          WHERE company_id = ? AND purchase_line_id = ? AND order_id = ? AND pr_line_id <=> ? AND deleted_at IS NULL`,
        [t, c.companyId, line.id, v.held_for_order_id, v.pr_line_id ?? null],
      );
      released.push({ holdId: v.id, orderId: v.held_for_order_id, orderCode: v.order_code, prLineId: v.pr_line_id ?? null, quantity: t });
      excess = round6(excess - t);
    }
  }
  const received = round6(Math.max(0, Number(line.qty_received) - total));
  await db.query('UPDATE cf_purchase_order_lines SET qty_received = ? WHERE company_id = ? AND id = ?', [received, c.companyId, line.id]);
  // Shares can never have received more than the line has (a hold let go by hand earlier): newest give way.
  const [allocs] = await db.query('SELECT id, qty_received FROM cf_purchase_line_orders WHERE company_id = ? AND purchase_line_id = ? AND deleted_at IS NULL ORDER BY id DESC', [c.companyId, line.id]);
  let over = round6(allocs.reduce((t, a) => t + Number(a.qty_received), 0) - received);
  for (const a of allocs) {
    if (over <= EPS) break;
    const t = round6(Math.min(over, Number(a.qty_received)));
    if (t <= EPS) continue;
    await db.query('UPDATE cf_purchase_line_orders SET qty_received = ? WHERE company_id = ? AND id = ?', [round6(Number(a.qty_received) - t), c.companyId, a.id]);
    over = round6(over - t);
  }
  if (['ordered', 'partially_received', 'received'].includes(line.po_status)) {
    const [rows] = await db.query('SELECT quantity, qty_received FROM cf_purchase_order_lines WHERE company_id = ? AND purchase_order_id = ? AND deleted_at IS NULL', [c.companyId, line.purchase_order_id]);
    const any = rows.some((r) => Number(r.qty_received) > EPS);
    const full = rows.length > 0 && rows.every((r) => Number(r.qty_received) >= Number(r.quantity) - EPS);
    const status = full ? 'received' : any ? 'partially_received' : 'ordered';
    if (status !== line.po_status) await db.query('UPDATE cf_purchase_orders SET status = ? WHERE company_id = ? AND id = ?', [status, c.companyId, line.purchase_order_id]);
  }
  return { purchaseLineId: line.id, purchaseOrderId: line.purchase_order_id, received, released };
}
