/**
 * orderStockService.js — ONE ORDER'S STOCK, as the Stores ledger shows the store (user, 2026-11-23: "in the stock tab inside
 * Sales Order, can you make it easier to see the current stock inside the sales order? This should become lot more like the
 * ledger screen as a lot of entries will come into this. And maybe, we can track the WIPs too over here").
 *
 * An order's stock is, across its revisions (orderFamily):
 *   customer   the customer's lots supplied for this order (owner_order_id), still in a store area
 *   held       our lots held for this order (cf_stock_reservations.held_for_order_id) — not yet on an MR line / a step
 *   reserved   reserved for a production step of this order (requirement → release → order)
 *   issued     given out to this order (issues naming it, less what came back), and gone into its production
 *   wip        the order's production pieces (a lot each, cf_stock_batches.production_item_id) in a WIP area
 *   finished   the same in a dispatch area (made, not dispatched)
 *
 *   GET /stores-desk/orders/:id/stock            { order, tiles, items: [{ item, customer, held, reserved, issued, lots[] }], wip: { pieces[], byArea[] } }
 *   GET /stores-desk/orders/:id/stock/entries    every ledger entry of the order, newest first, paged:
 *                                                ?from=&to=&type=&search=&itemId=&offset=&limit=   (a movement naming the order,
 *                                                a lot of the order — the customer's, held for it, or one of its pieces)
 * Fixed reads, whatever the size of the order.
 */
import { orderFamily } from './valuationService.js';
import { pageArgs, likeOf, pageOf } from '../lib/listing.js';

const r6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const blank = (v) => v == null || String(v).trim() === '';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STORE = ['storage', 'quarantine'];
const TYPES = ['receipt', 'issue', 'transfer', 'adjustment', 'scrap', 'return', 'transform'];
const dateText = (d) => (d == null ? null : d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10));

// the order's production pieces (a lot each), as a sub-select on the order ids
const PIECES = `SELECT pi.id FROM cf_production_items pi JOIN cf_production_releases pr ON pr.id = pi.release_id AND pr.deleted_at IS NULL
                 WHERE pi.company_id = ? AND pi.deleted_at IS NULL AND pr.order_id IN (?)`;

export async function orderStock(db, companyId, orderId) {
  const { order, ids } = await orderFamily(db, companyId, orderId);
  const [[cust], [held], [resv], [issued], [wip]] = await Promise.all([
    // the customer's lots for this order, in a store area
    db.query(
      `SELECT k.item_id, b.id AS lot_id, b.code AS lot_code, b.supplier_ref, b.received_on, br.name AS brand, b.status, a.name AS area, SUM(k.quantity) AS q
         FROM cf_stock_balances k JOIN cf_stock_batches b ON b.id = k.batch_id JOIN cf_stocking_areas a ON a.id = k.stocking_area_id AND a.purpose IN (?)
         LEFT JOIN cf_brands br ON br.id = b.brand_id
        WHERE k.company_id = ? AND b.owner_order_id IN (?) AND b.production_item_id IS NULL
        GROUP BY k.item_id, b.id, b.code, b.supplier_ref, b.received_on, br.name, b.status, a.name HAVING SUM(k.quantity) > 0.0000001`,
      [STORE, companyId, ids]),
    // our stock held for this order (active holds), with its lot
    db.query(
      `SELECT v.item_id, v.batch_id AS lot_id, b.code AS lot_code, b.supplier_ref, b.received_on, br.name AS brand, b.status, (v.pr_line_id IS NOT NULL) AS on_mr, SUM(v.quantity) AS q,
              MAX((SELECT a.name FROM cf_stock_balances k JOIN cf_stocking_areas a ON a.id = k.stocking_area_id WHERE k.company_id = v.company_id AND k.batch_id = v.batch_id AND k.quantity > 0 ORDER BY k.quantity DESC LIMIT 1)) AS area
         FROM cf_stock_reservations v LEFT JOIN cf_stock_batches b ON b.id = v.batch_id LEFT JOIN cf_brands br ON br.id = b.brand_id
        WHERE v.company_id = ? AND v.held_for_order_id IN (?) AND v.status = 'active' AND v.deleted_at IS NULL
        GROUP BY v.item_id, v.batch_id, b.code, b.supplier_ref, b.received_on, br.name, b.status, (v.pr_line_id IS NOT NULL)`,
      [companyId, ids]),
    // reserved for a production step of this order
    db.query(
      `SELECT v.item_id, SUM(v.quantity) AS q FROM cf_stock_reservations v
         JOIN cf_material_requirements r ON r.id = v.requirement_id JOIN cf_production_releases pr ON pr.id = r.release_id
        WHERE v.company_id = ? AND v.status = 'active' AND v.deleted_at IS NULL AND pr.order_id IN (?) GROUP BY v.item_id`,
      [companyId, ids]),
    // given out to this order (an issue naming it), less what came back on its reversal or a return naming it
    db.query(
      `SELECT l.item_id, SUM(-l.quantity) AS q, MAX(mm.movement_date) AS last_on FROM cf_stock_ledger l JOIN cf_stock_movements mm ON mm.id = l.movement_id
         JOIN cf_stocking_areas a ON a.id = l.stocking_area_id AND a.purpose IN (?)
        WHERE l.company_id = ? AND l.deleted_at IS NULL AND mm.order_id IN (?) AND mm.movement_type IN ('issue', 'return') GROUP BY l.item_id`,
      [STORE, companyId, ids]),
    // the order's pieces where they lie now: WIP or the dispatch yard
    db.query(
      `SELECT k.item_id, b.id AS lot_id, b.code AS lot_code, pi.code AS piece_code, pi.depth, ol.line_no, a.id AS area_id, a.name AS area, a.purpose, SUM(k.quantity) AS q,
              (SELECT MAX(mm.movement_date) FROM cf_stock_ledger l2 JOIN cf_stock_movements mm ON mm.id = l2.movement_id WHERE l2.company_id = k.company_id AND l2.batch_id = b.id) AS since
         FROM cf_stock_balances k JOIN cf_stock_batches b ON b.id = k.batch_id
         JOIN cf_production_items pi ON pi.id = b.production_item_id JOIN cf_production_releases pr ON pr.id = pi.release_id AND pr.deleted_at IS NULL
         LEFT JOIN cf_sales_order_lines ol ON ol.id = pr.order_line_id
         JOIN cf_stocking_areas a ON a.id = k.stocking_area_id AND a.purpose IN ('wip', 'dispatch')
        WHERE k.company_id = ? AND pr.order_id IN (?)
        GROUP BY k.item_id, b.id, b.code, pi.code, pi.depth, ol.line_no, a.id, a.name, a.purpose HAVING SUM(k.quantity) > 0.0000001
        ORDER BY ol.line_no, pi.depth, pi.code LIMIT 2000`,
      [companyId, ids]),
  ]);

  const itemIds = [...new Set([...cust, ...held, ...resv, ...issued, ...wip].map((r) => Number(r.item_id)))];
  const [items] = itemIds.length
    ? await db.query(`SELECT m.id, m.code, m.name, i.uom FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE m.company_id = ? AND m.id IN (?)`, [companyId, itemIds])
    : [[]];
  const itemOf = new Map(items.map((m) => [Number(m.id), { id: Number(m.id), code: m.code, name: m.name, uom: m.uom }]));
  const lot = (r, kind) => ({ kind, id: r.lot_id == null ? null : Number(r.lot_id), code: r.lot_code ?? null, heat: r.supplier_ref ?? null, brand: r.brand ?? null,
    receivedOn: dateText(r.received_on), status: r.status ?? null, area: r.area ?? null, onMr: r.on_mr == null ? undefined : !!Number(r.on_mr), quantity: r6(r.q) });

  const byItem = new Map();
  const row = (id) => { if (!byItem.has(id)) byItem.set(id, { item: itemOf.get(id), customer: 0, held: 0, reserved: 0, issued: 0, lastIssued: null, lots: [] }); return byItem.get(id); };
  for (const r of cust) { const x = row(Number(r.item_id)); x.customer = r6(x.customer + Number(r.q)); x.lots.push(lot(r, 'customer')); }
  for (const r of held) { const x = row(Number(r.item_id)); x.held = r6(x.held + Number(r.q)); x.lots.push(lot(r, 'held')); }
  for (const r of resv) row(Number(r.item_id)).reserved = r6(Number(r.q));
  for (const r of issued) { if (Math.abs(Number(r.q)) < 1e-9) continue; const x = row(Number(r.item_id)); x.issued = r6(Number(r.q)); x.lastIssued = dateText(r.last_on); }
  const list = [...byItem.values()].filter((x) => x.item).sort((a, b) => String(a.item.name).localeCompare(String(b.item.name)) || a.item.id - b.item.id);

  const pieces = wip.map((r) => ({ item: itemOf.get(Number(r.item_id)) ?? null, lotId: Number(r.lot_id), lotCode: r.lot_code, pieceCode: r.piece_code ?? r.lot_code,
    lineNo: r.line_no == null ? null : Number(r.line_no), depth: Number(r.depth), area: { id: Number(r.area_id), name: r.area, purpose: r.purpose }, quantity: r6(r.q), since: dateText(r.since) }));
  const areaSum = new Map();
  for (const p of pieces) { const a = areaSum.get(p.area.id) ?? { ...p.area, pieces: 0, quantity: 0 }; a.pieces++; a.quantity = r6(a.quantity + p.quantity); areaSum.set(p.area.id, a); }

  return {
    order: { id: order.id, code: order.code, status: order.status, customer: order.customer_id ? { id: order.customer_id, name: order.customer_name } : null, revisions: ids.length },
    tiles: {
      items: list.length,
      customerLots: list.reduce((s, x) => s + x.lots.filter((l) => l.kind === 'customer').length, 0),
      heldLots: list.reduce((s, x) => s + x.lots.filter((l) => l.kind === 'held').length, 0),
      reservedItems: list.filter((x) => x.reserved > 0).length,
      issuedItems: list.filter((x) => x.issued > 0).length,
      wipPieces: pieces.filter((p) => p.area.purpose === 'wip').length,
      finishedPieces: pieces.filter((p) => p.area.purpose === 'dispatch').length,
    },
    items: list,
    wip: { pieces, byArea: [...areaSum.values()] },
  };
}

export async function orderStockEntries(db, companyId, orderId, q = {}) {
  const { ids } = await orderFamily(db, companyId, orderId);
  const page = pageArgs(q, { def: 100 });
  const where = ['l.company_id = ?', 'l.deleted_at IS NULL',
    `(mm.order_id IN (?) OR b.owner_order_id IN (?) OR b.production_item_id IN (${PIECES})
      OR l.batch_id IN (SELECT v.batch_id FROM cf_stock_reservations v WHERE v.company_id = ? AND v.held_for_order_id IN (?) AND v.batch_id IS NOT NULL AND v.deleted_at IS NULL))`];
  const params = [companyId, ids, ids, companyId, ids, companyId, ids];
  if (DATE_RE.test(String(q.from ?? ''))) { where.push('mm.movement_date >= ?'); params.push(String(q.from)); }
  if (DATE_RE.test(String(q.to ?? ''))) { where.push('mm.movement_date <= ?'); params.push(String(q.to)); }
  if (TYPES.includes(q.type)) { where.push('mm.movement_type = ?'); params.push(q.type); }
  if (!blank(q.itemId)) { where.push('l.item_id = ?'); params.push(Number(q.itemId)); }
  if (q.wip === '1') where.push('b.production_item_id IS NOT NULL');
  if (q.wip === '0') where.push('b.production_item_id IS NULL');
  const like = likeOf(q.search);
  if (like) { where.push('(m.name LIKE ? OR m.code LIKE ? OR b.code LIKE ? OR b.supplier_ref LIKE ? OR mm.code LIKE ? OR mm.reference LIKE ?)'); params.push(like, like, like, like, like, like); }
  const FROM = `FROM cf_stock_ledger l JOIN cf_stock_movements mm ON mm.id = l.movement_id
      JOIN cf_master_records m ON m.id = l.item_id JOIN cf_item_details i ON i.master_id = l.item_id
      JOIN cf_stocking_areas a ON a.id = l.stocking_area_id
      LEFT JOIN cf_stock_batches b ON b.id = l.batch_id
      LEFT JOIN cf_production_items pi ON pi.id = b.production_item_id
      LEFT JOIN users u ON u.id = mm.created_by
     WHERE ${where.join(' AND ')}`;
  const [[rows], [[{ n }]], [types]] = await Promise.all([
    db.query(
      `SELECT l.id, l.quantity, l.notes, mm.id AS movement_id, mm.code AS movement_code, mm.movement_type, mm.movement_date, mm.reference, mm.reason,
              mm.reversal_of_id, mm.reversed_by_id, m.id AS item_id, m.code AS item_code, m.name AS item_name, i.uom,
              b.id AS lot_id, b.code AS lot_code, b.supplier_ref, b.owner_order_id, b.production_item_id, pi.code AS piece_code,
              a.name AS area, a.purpose, u.name AS by_name
         ${FROM} ORDER BY mm.movement_date DESC, l.id DESC LIMIT ? OFFSET ?`, [...params, page.limit, page.offset]),
    db.query(`SELECT COUNT(*) AS n ${FROM}`, params),
    db.query(`SELECT mm.movement_type AS t, COUNT(*) AS n ${FROM} GROUP BY mm.movement_type`, params),
  ]);
  return pageOf(rows.map((r) => ({
    id: Number(r.id), date: dateText(r.movement_date), movement: { id: Number(r.movement_id), code: r.movement_code, type: r.movement_type, reference: r.reference ?? null, reason: r.reason ?? null,
      reversed: r.reversed_by_id != null, reversal: r.reversal_of_id != null },
    item: { id: Number(r.item_id), code: r.item_code, name: r.item_name, uom: r.uom },
    lot: r.lot_id == null ? null : { id: Number(r.lot_id), code: r.lot_code, heat: r.supplier_ref ?? null, piece: r.piece_code ?? null,
      kind: r.production_item_id != null ? 'piece' : r.owner_order_id != null ? 'customer' : 'ours' },
    area: { name: r.area, purpose: r.purpose }, quantity: r6(r.quantity), notes: r.notes ?? null, by: r.by_name ?? null,
  })), Number(n), page, { counts: { types: Object.fromEntries(types.map((t) => [t.t, Number(t.n)])) } });
}
