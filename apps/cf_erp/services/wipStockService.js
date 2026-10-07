/**
 * wipStockService.js — what the production ledger holds (init.sql §45):
 * Stock › Work in progress, and the offcut pieces with their outlines.
 *
 * Read-only. Set-based: a handful of reads for any number of lots.
 */
import { WIP_AREA_CODE } from './productionLedgerService.js';
import { levelName } from './tree.js';
import { likeOf, pageArgs, pageOf, wantsPage, countsBy } from '../lib/listing.js';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };

/** GET /stock/wip?orderId=&search= */
export async function wipStock(db, companyId, q = {}) {
  const [[area]] = await db.query('SELECT id, code, name FROM cf_stocking_areas WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [companyId, WIP_AREA_CODE]);
  const empty = { area: area ?? null, totals: { lots: 0, pieces: 0, value: 0, unpricedLots: 0 }, byLevel: [], orders: [], offcuts: { count: 0, kg: 0, value: 0 } };
  if (!area) return empty;
  const where = ['k.company_id = ?', 'k.stocking_area_id = ?', 'k.quantity > 0'];
  const args = [companyId, area.id];
  if (!blank(q.orderId)) { where.push('r.order_id = ?'); args.push(Number(q.orderId)); }
  const like = likeOf(q.search);
  if (like) { where.push('(b.code LIKE ? OR m.code LIKE ? OR m.name LIKE ? OR o.code LIKE ?)'); args.push(like, like, like, like); }
  const [rows] = await db.query(
    `SELECT k.batch_id, k.item_id, k.quantity, b.code AS batch_code, b.unit_cost, b.production_item_id,
            m.code AS item_code, m.name AS item_name, pi.depth, pi.code AS piece_code,
            r.id AS release_id, r.order_id, r.order_line_id, o.code AS order_code, l.line_no
       FROM cf_stock_balances k
       JOIN cf_stock_batches b ON b.id = k.batch_id
       JOIN cf_master_records m ON m.id = k.item_id
       LEFT JOIN cf_production_items pi ON pi.id = b.production_item_id
       LEFT JOIN cf_production_releases r ON r.id = pi.release_id
       LEFT JOIN cf_sales_orders o ON o.id = r.order_id
       LEFT JOIN cf_sales_order_lines l ON l.id = r.order_line_id
      WHERE ${where.join(' AND ')}
      ORDER BY o.code, l.line_no, pi.depth, pi.sort_order, b.code`,
    args,
  );
  const pieceIds = rows.map((r) => r.production_item_id).filter(Boolean);
  const [inside] = pieceIds.length ? await db.query(
    `SELECT j.parent_item_id, j.quantity, j.value, m.id AS item_id, m.code AS item_code, m.name AS item_name, COALESCE(b.code, pc.code) AS code
       FROM cf_wip_joins j JOIN cf_master_records m ON m.id = j.item_id
       LEFT JOIN cf_stock_batches b ON b.id = j.batch_id
       LEFT JOIN cf_production_items pc ON pc.id = j.child_item_id
      WHERE j.company_id = ? AND j.parent_item_id IN (?) AND j.left_movement_id IS NULL AND j.deleted_at IS NULL
      ORDER BY j.id`, [companyId, pieceIds]) : [[]];
  const contentsOf = new Map();
  for (const j of inside) {
    if (!contentsOf.has(j.parent_item_id)) contentsOf.set(j.parent_item_id, []);
    contentsOf.get(j.parent_item_id).push({ code: j.code ?? null, item: { id: j.item_id, code: j.item_code, name: j.item_name }, quantity: Number(j.quantity), value: j.value == null ? null : round2(j.value) });
  }
  const orders = new Map();
  const levels = new Map();
  const totals = { lots: 0, pieces: 0, value: 0, unpricedLots: 0 };
  let offcuts = { count: 0, kg: 0, value: 0 };
  for (const r of rows) {
    const qty = Number(r.quantity);
    const value = r.unit_cost == null ? null : round2(qty * Number(r.unit_cost));
    if (!r.production_item_id) {
      // A lot in WIP that no piece owns: an offcut piece (or anything else put there).
      offcuts.count += 1; offcuts.value = round2(offcuts.value + (value ?? 0));
      continue;
    }
    totals.lots += 1; totals.pieces += qty;
    if (value == null) totals.unpricedLots += 1; else totals.value = round2(totals.value + value);
    const depth = r.depth == null ? null : Number(r.depth);
    const lv = levels.get(depth) ?? { depth, level: depth == null ? 'Other' : levelName(depth), lots: 0, pieces: 0, value: 0 };
    lv.lots += 1; lv.pieces += qty; lv.value = value == null ? lv.value : round2(lv.value + value);
    levels.set(depth, lv);
    const key = r.order_line_id ?? 0;
    if (!orders.has(key)) orders.set(key, { orderId: r.order_id, orderCode: r.order_code, lineId: r.order_line_id, lineNo: r.line_no, releaseId: r.release_id, lots: [] });
    orders.get(key).lots.push({
      batchId: r.batch_id, code: r.batch_code ?? r.piece_code, item: { id: r.item_id, code: r.item_code, name: r.item_name },
      productionItemId: r.production_item_id, depth, level: depth == null ? 'Other' : levelName(depth),
      quantity: qty, value, unitCost: r.unit_cost == null ? null : Number(r.unit_cost),
      contains: contentsOf.get(r.production_item_id) ?? [],
    });
  }
  // Offcut weight from their own rows (the lot does not know its kg).
  const [[oc]] = await db.query("SELECT COUNT(*) AS n, COALESCE(SUM(weight_kg), 0) AS kg FROM cf_offcuts WHERE company_id = ? AND status = 'available' AND deleted_at IS NULL", [companyId]);
  offcuts = { count: Number(oc.n), kg: round3(oc.kg), value: offcuts.value };
  return {
    area,
    totals: { ...totals, pieces: round3(totals.pieces) },
    byLevel: [...levels.values()].sort((a, b) => (a.depth ?? 99) - (b.depth ?? 99)),
    orders: [...orders.values()],
    offcuts,
  };
}

const OFFCUT_STATUSES = ['planned', 'available', 'used', 'scrapped', 'returned'];

/** GET /offcuts?status=&thickness=&grade=&search= (paged=1 for the list contract). */
export async function listOffcuts(db, companyId, q = {}) {
  const base = ['o.company_id = ?', 'o.deleted_at IS NULL'];
  const args = [companyId];
  if (!blank(q.thickness)) { base.push('o.thickness_mm = ?'); args.push(Number(q.thickness)); }
  if (!blank(q.grade)) { base.push('o.grade = ?'); args.push(String(q.grade)); }
  // Plate offcuts (an outline) or bar offcuts (a length of a section, §48).
  if (!blank(q.kind) && ['plate', 'bar'].includes(String(q.kind))) { base.push('o.kind = ?'); args.push(String(q.kind)); }
  const like = likeOf(q.search);
  if (like) { base.push('(o.offcut_no LIKE ? OR so.code LIKE ? OR o.grade LIKE ?)'); args.push(like, like, like); }
  const status = blank(q.status) ? 'available' : String(q.status);
  const where = [...base];
  const rowArgs = [...args];
  if (status !== 'all') { where.push('o.status = ?'); rowArgs.push(status); }
  const from = `FROM cf_offcuts o
       JOIN cf_sales_order_lines l ON l.id = o.order_line_id
       JOIN cf_sales_orders so ON so.id = l.order_id
       JOIN cf_plate_lots pl ON pl.id = o.plate_lot_id
       LEFT JOIN cf_master_records pm ON pm.id = pl.plate_item_id
       LEFT JOIN cf_stock_batches b ON b.id = o.batch_id
       LEFT JOIN cf_master_records im ON im.id = b.item_id
       LEFT JOIN cf_master_records sm ON sm.id = o.stock_item_id`;
  const paged = wantsPage(q);
  const page = paged ? pageArgs(q, { def: 100 }) : null;
  const sql = `SELECT o.*, so.id AS order_id, so.code AS order_code, l.line_no, pl.lot_no, pl.plate_item_id, pm.code AS plate_code,
                      b.code AS batch_code, b.unit_cost, im.id AS item_id, im.code AS item_code, im.name AS item_name,
                      sm.code AS stock_item_code, sm.name AS stock_item_name
                 ${from} WHERE ${where.join(' AND ')} ORDER BY o.kind, o.thickness_mm, o.area_mm2 DESC, o.id`;
  const [[rows], counted] = await Promise.all([
    paged ? db.query(`${sql} LIMIT ? OFFSET ?`, [...rowArgs, page.limit, page.offset]) : db.query(sql, rowArgs),
    paged ? Promise.all([
      db.query(`SELECT o.status AS k, COUNT(*) AS n ${from} WHERE ${base.join(' AND ')} GROUP BY o.status`, args),
      db.query(`SELECT COUNT(*) AS n ${from} WHERE ${where.join(' AND ')}`, rowArgs),
    ]) : null,
  ]);
  const out = rows.map((o) => ({
    id: o.id, offcutNo: o.offcut_no, status: o.status,
    // 'plate' (an outline on a plate) or 'bar' (a length of a section); a bar
    // offcut carries its length and the stock bar it was cut from.
    kind: o.kind ?? 'plate',
    lengthMm: o.length_mm == null ? null : Number(o.length_mm),
    stockItem: o.stock_item_id ? { id: o.stock_item_id, code: o.stock_item_code ?? null, name: o.stock_item_name ?? null } : null,
    thickness: o.thickness_mm == null ? null : Number(o.thickness_mm), grade: o.grade ?? null, material: o.material ?? null,
    areaMm2: Number(o.area_mm2), weightKg: o.weight_kg == null ? null : Number(o.weight_kg),
    value: o.unit_cost == null ? null : round2(o.unit_cost),
    rect: o.rect_length_mm == null ? null : { length: Number(o.rect_length_mm), width: Number(o.rect_width_mm) },
    bbox: o.bbox_length_mm == null ? null : { x: Number(o.bbox_x_mm ?? 0), y: Number(o.bbox_y_mm ?? 0), length: Number(o.bbox_length_mm), width: Number(o.bbox_width_mm) },
    outline: parseJson(o.outline_json) ?? [],
    origin: { orderId: o.order_id, orderCode: o.order_code, lineNo: o.line_no, lotNo: o.lot_no, plate: { id: o.plate_item_id, code: o.plate_code ?? null } },
    batch: o.batch_id ? { id: o.batch_id, code: o.batch_code } : null,
    item: o.item_id ? { id: o.item_id, code: o.item_code, name: o.item_name } : null,
    createdAt: o.created_at,
  }));
  if (!paged) return out;
  const [[byStatus], [[n]]] = counted;
  return pageOf(out, n.n, page, { counts: { status: countsBy(byStatus, OFFCUT_STATUSES) } });
}
