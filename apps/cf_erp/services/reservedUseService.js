/**
 * reservedUseService.js — USING STOCK THAT IS RESERVED FOR A SALES ORDER (init.sql §115; user, 2026-11-21).
 *
 * Stock reserved for an order is refused at give-out (stockService: RESERVED, naming the order). When Stores must use
 * it anyway it ASKS: an item, a quantity, why. Planning AND production each approve (approval types
 * reserved_use_planning / reserved_use_production — two different people). On the second yes that much of the
 * reservation is let go — the newest reservation first, so the order that claimed it last is the one left short —
 * Purchase and Planning get an alert naming each order and what it is now short of, and Stores gives it out the usual
 * way. One no sends the whole ask back. Nothing is given out here.
 */
import { invalid, notFound, CfError } from '../lib/errors.js';
import { requestApproval, withdrawApprovals } from './approvalService.js';
import { raise } from './alertService.js';

const blank = (v) => v == null || String(v).trim() === '';
const r6 = (n) => Math.round(Number(n) * 1e6) / 1e6;
const EPS = 1e-9;
export const RESERVED_TYPES = ['reserved_use_planning', 'reserved_use_production'];
const MATERIAL = '(v.requirement_id IS NOT NULL OR v.held_for_order_id IS NOT NULL)';

/** Who an item's stock is reserved for: [{ reservationId, order: { id, code }, quantity, hold }] — newest first. */
export async function reservedFor(db, companyId, itemId, batchId = null) {
  const [rows] = await db.query(
    `SELECT v.id, v.quantity, v.batch_id, (v.held_for_order_id IS NOT NULL) AS is_hold, o.id AS order_id, o.code AS order_code
       FROM cf_stock_reservations v
       LEFT JOIN cf_material_requirements q ON q.id = v.requirement_id
       LEFT JOIN cf_production_releases r ON r.id = q.release_id
       LEFT JOIN cf_sales_orders o ON o.id = COALESCE(r.order_id, v.held_for_order_id)
      WHERE v.company_id = ? AND v.item_id = ? AND v.status = 'active' AND v.deleted_at IS NULL AND ${MATERIAL}
        ${batchId == null ? '' : 'AND IFNULL(v.batch_id, 0) = ?'}
      ORDER BY v.id DESC`, [companyId, Number(itemId), ...(batchId == null ? [] : [Number(batchId)])]);
  return rows.map((r) => ({ reservationId: r.id, batchId: r.batch_id ?? null, order: r.order_id ? { id: r.order_id, code: r.order_code } : null, quantity: r6(r.quantity), hold: !!Number(r.is_hold) }));
}

async function usableStock(db, companyId, itemId) {
  const [[k]] = await db.query(
    `SELECT COALESCE(SUM(k.quantity), 0) AS q FROM cf_stock_balances k JOIN cf_stocking_areas a ON a.id = k.stocking_area_id
      WHERE k.company_id = ? AND k.item_id = ? AND a.purpose IN ('storage', 'wip')`, [companyId, Number(itemId)]);
  return r6(k.q);
}

const SELECT = `SELECT q.*, m.code AS item_code, m.name AS item_name, i.uom, u.name AS requested_by_name, pu.name AS planning_name, du.name AS production_name
  FROM cf_reserved_use_requests q
  JOIN cf_master_records m ON m.id = q.item_id
  JOIN cf_item_details i ON i.master_id = q.item_id
  LEFT JOIN users u ON u.id = q.requested_by LEFT JOIN users pu ON pu.id = q.planning_by LEFT JOIN users du ON du.id = q.production_by`;
const parse = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
function shape(r) {
  return {
    id: r.id, code: r.code, status: r.status, item: { id: r.item_id, code: r.item_code, name: r.item_name, uom: r.uom }, quantity: r6(r.quantity),
    reason: r.reason, wantedFor: r.wanted_for ?? null, requestedBy: r.requested_by_name ?? null, at: r.created_at,
    planning: r.planning_at ? { by: r.planning_name ?? null, at: r.planning_at } : null,
    production: r.production_at ? { by: r.production_name ?? null, at: r.production_at } : null,
    decisionNote: r.decision_note ?? null, reserved: parse(r.reserved_json) ?? [], released: parse(r.released_json) ?? [],
  };
}

/** GET /stores-desk/reserved-use?status=pending|approved|rejected|all&itemId= */
export async function listRequests(db, companyId, q = {}) {
  const where = ['q.company_id = ?', 'q.deleted_at IS NULL'];
  const args = [companyId];
  const status = String(q.status ?? 'pending');
  if (status !== 'all') { where.push('q.status = ?'); args.push(status); }
  if (!blank(q.itemId)) { where.push('q.item_id = ?'); args.push(Number(q.itemId)); }
  try {
    const [rows] = await db.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY q.id DESC LIMIT 200`, args);
    return { rows: rows.map(shape) };
  } catch (e) { if (e.errno === 1146) return { rows: [] }; throw e; }
}

/**
 * POST /stores-desk/reserved-use { itemId, quantity, reason, wantedFor? } — Stores asks. Refused when nothing of the
 * item is reserved, when the quantity is free anyway (just give it out), when it is more than the store holds, or when
 * an ask for the item is already waiting.
 */
export async function ask(db, c, input = {}) {
  const qty = Number(input.quantity);
  if (blank(input.itemId)) throw invalid('INVALID', 'Choose the item.');
  if (!Number.isFinite(qty) || qty <= 0) throw invalid('INVALID', 'The quantity is a number above zero.');
  const reason = blank(input.reason) ? null : String(input.reason).trim().slice(0, 500);
  if (!reason) throw invalid('REASON', 'Say why reserved stock is needed — planning and production read it.');
  const [[item]] = await db.query(
    "SELECT m.id, m.code, m.name, i.uom FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE m.company_id = ? AND m.id = ? AND m.deleted_at IS NULL AND m.record_kind = 'item' FOR UPDATE",
    [c.companyId, Number(input.itemId)]);
  if (!item) throw notFound('Item');
  const held = await reservedFor(db, c.companyId, item.id);
  const reserved = r6(held.reduce((a, h) => a + h.quantity, 0));
  if (reserved <= EPS) throw invalid('NOT_RESERVED', `Nothing of ${item.name} is reserved — issue it on its material request.`);
  const stock = await usableStock(db, c.companyId, item.id);
  const free = Math.max(0, r6(stock - reserved));
  if (qty > stock + EPS) throw invalid('TOO_MANY', `The store holds only ${stock} ${item.uom ?? ''} of ${item.name}.`);
  if (qty <= free + EPS) throw invalid('FREE', `${free} ${item.uom ?? ''} of ${item.name} is free — issue it on its material request.`);
  const [[waiting]] = await db.query("SELECT code FROM cf_reserved_use_requests WHERE company_id = ? AND item_id = ? AND status = 'pending' AND deleted_at IS NULL LIMIT 1", [c.companyId, item.id]);
  if (waiting) throw invalid('WAITING', `${waiting.code} for ${item.name} is still waiting for planning and production.`);
  const need = r6(qty - free);   // how much of the reservations must be let go
  const [ins] = await db.query(
    'INSERT INTO cf_reserved_use_requests (company_id, item_id, quantity, reason, wanted_for, reserved_json, requested_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, item.id, r6(qty), reason, blank(input.wantedFor) ? null : String(input.wantedFor).trim().slice(0, 255), JSON.stringify({ stock, reserved, free, need, orders: held }), c.userId ?? null]);
  const code = `RU-${String(ins.insertId).padStart(6, '0')}`;
  await db.query('UPDATE cf_reserved_use_requests SET code = ? WHERE id = ?', [code, ins.insertId]);
  const orders = [...new Set(held.map((h) => h.order?.code).filter(Boolean))];
  for (const type of RESERVED_TYPES) {
    await requestApproval(db, c, {
      type, subjectId: ins.insertId, subjectCode: code, orderId: held.find((h) => h.order)?.order.id ?? null,
      title: `Use ${r6(qty)} ${item.uom ?? ''} of ${item.name} reserved for ${orders.join(', ') || 'an order'}`.replace('  ', ' '),
      summary: `Stores holds ${stock}, ${reserved} reserved, ${free} free. ${need} would be taken from the reservation. Why: ${reason}`,
      note: reason, context: { item: { id: item.id, name: item.name, uom: item.uom }, quantity: r6(qty), stock, reserved, free, need, orders: held },
    });
  }
  return getRequest(db, c.companyId, ins.insertId);
}

export async function getRequest(db, companyId, id) {
  const [[r]] = await db.query(`${SELECT} WHERE q.company_id = ? AND q.id = ? AND q.deleted_at IS NULL`, [companyId, Number(id)]);
  if (!r) throw notFound('This request');
  return shape(r);
}

/** Lets `need` of the item's reservations go, newest first. → [{ reservationId, order, quantity }] */
async function letGo(db, c, itemId, need) {
  const out = [];
  let left = need;
  for (const h of await reservedFor(db, c.companyId, itemId)) {
    if (left <= EPS) break;
    const take = Math.min(left, h.quantity);
    if (take >= h.quantity - EPS) await db.query("UPDATE cf_stock_reservations SET status = 'released', closed_at = NOW() WHERE company_id = ? AND id = ? AND status = 'active'", [c.companyId, h.reservationId]);
    else await db.query('UPDATE cf_stock_reservations SET quantity = quantity - ? WHERE company_id = ? AND id = ? AND status = \'active\'', [r6(take), c.companyId, h.reservationId]);
    out.push({ reservationId: h.reservationId, order: h.order, quantity: r6(take) });
    left = r6(left - take);
  }
  return out;
}

const side = (type) => (type === 'reserved_use_planning' ? 'planning' : 'production');

/** Both approval types share this: one yes is recorded; the second yes (by another person) lets the stock go. */
export const reservedUseApprovalHandler = {
  async onApprove(db, c, row) {
    const [[q]] = await db.query('SELECT * FROM cf_reserved_use_requests WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, row.subject_id]);
    if (!q || q.status !== 'pending') throw invalid('NOT_PENDING', 'This request is not waiting for a decision.');
    const me = side(row.approval_type);
    const other = me === 'planning' ? 'production' : 'planning';
    if (q[`${other}_by`] != null && c.userId != null && Number(q[`${other}_by`]) === Number(c.userId)) {
      throw new CfError(403, 'SAME_PERSON', `You already approved this for ${other}. Somebody else approves it for ${me} — it takes two people.`);
    }
    await db.query(`UPDATE cf_reserved_use_requests SET ${me}_by = ?, ${me}_at = NOW() WHERE id = ?`, [c.userId ?? null, q.id]);
    if (q[`${other}_at`] == null) return { waitingFor: other };
    // the second yes: let the stock go, tell Purchase
    const [[item]] = await db.query('SELECT m.id, m.code, m.name, i.uom FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE m.id = ?', [q.item_id]);
    const held = await reservedFor(db, c.companyId, q.item_id);
    const reserved = r6(held.reduce((a, h) => a + h.quantity, 0));
    const stock = await usableStock(db, c.companyId, q.item_id);
    const need = Math.max(0, r6(Number(q.quantity) - Math.max(0, stock - reserved)));
    const released = need > EPS ? await letGo(db, c, q.item_id, need) : [];
    await db.query("UPDATE cf_reserved_use_requests SET status = 'approved', released_json = ? WHERE id = ?", [JSON.stringify(released), q.id]);
    const byOrder = new Map();
    for (const r of released) { const k = r.order?.code ?? 'an order'; byOrder.set(k, { order: r.order, quantity: r6((byOrder.get(k)?.quantity ?? 0) + r.quantity) }); }
    for (const [code, v] of byOrder) {
      await raise(db, c.companyId, {
        key: `reserved_taken:${q.id}:${v.order?.id ?? 0}`, kind: 'reserved_taken', severity: 'warning',
        title: `${code} is short of ${v.quantity} ${item.uom ?? ''} of ${item.name} — its reserved stock was given to Stores`.replace('  ', ' '),
        detail: `${q.code}: planning and production approved. Why: ${q.reason}. Buy it again for ${code}, or release the order's requirement.`,
        departments: ['purchase', 'planning'], orderId: v.order?.id ?? null, orderCode: v.order?.code ?? null, subjectType: 'reserved_use', subjectId: q.id,
        link: v.order ? `orders/${v.order.id}` : 'stores', count: 1,
      });
    }
    return { released, approved: true };
  },
  async onReject(db, c, row, note) {
    await db.query("UPDATE cf_reserved_use_requests SET status = 'rejected', decision_note = ? WHERE company_id = ? AND id = ? AND status = 'pending'",
      [note ? `${side(row.approval_type)}: ${String(note).slice(0, 470)}` : null, c.companyId, row.subject_id]);
    // the other side has nothing left to decide
    await db.query("UPDATE cf_approvals SET status = 'withdrawn', decided_at = NOW(), decision_note = 'The other side sent it back.' WHERE company_id = ? AND subject_type = 'reserved_use' AND subject_id = ? AND status = 'pending' AND id <> ?",
      [c.companyId, row.subject_id, row.id]);
    return { rejected: true };
  },
  async onWithdraw(db, c, row) {
    await db.query("UPDATE cf_reserved_use_requests SET status = 'withdrawn' WHERE company_id = ? AND id = ? AND status = 'pending'", [c.companyId, row.subject_id]);
  },
};

/** POST /stores-desk/reserved-use/:id/withdraw — Stores takes the ask back while it waits. */
export async function withdrawRequest(db, c, id) {
  const [[q]] = await db.query('SELECT id, status FROM cf_reserved_use_requests WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, Number(id)]);
  if (!q) throw notFound('This request');
  if (q.status !== 'pending') throw invalid('NOT_PENDING', 'This request is not waiting any more.');
  await db.query("UPDATE cf_reserved_use_requests SET status = 'withdrawn' WHERE id = ?", [q.id]);
  await withdrawApprovals(db, c, { subjectType: 'reserved_use', subjectId: q.id, types: RESERVED_TYPES, note: 'Taken back by Stores.' });
  return getRequest(db, c.companyId, q.id);
}
