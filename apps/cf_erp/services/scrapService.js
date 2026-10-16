/**
 * scrapService.js — scrap stock, the scrap rate, losses, and what an offcut's
 * stock says about its status (init.sql §67, CF_ERP_WIP_LEDGER_PLAN.md
 * "Inventory v2", the user's rules of 2026-10-16).
 *
 *   KERF     burnt on the cut. Never stock: a cf_stock_losses row (kind 'kerf').
 *   OFFCUT   a reusable leftover (the existing offcut rule) — its own stock piece.
 *   SCRAP    the physical leftover that is not reusable: plate skeleton, strips,
 *            small bits, scrapped parts. Real stock: the quantity item
 *            "Steel scrap (kg)" (SCRAP-STEEL) in the company's SCRAP area.
 *            Ours is a running total (loose stock); a customer's is their lot,
 *            kept for them and given back (ownershipService.returnToCustomer).
 *
 * VALUE. Our scrap is worth the company's scrap rate (Setup › Cutting, ₹/kg).
 * No rate set = scrap is valued at 0 and the screens say "no scrap rate set".
 * Whatever a piece was worth above its scrap value is written down — a loss row
 * (kind 'scrap_writedown') — so a movement's values still add up:
 * SUM(ledger value) + SUM(loss value) = 0.
 */
import { invalid } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';

export const SCRAP_AREA_CODE = 'SCRAP';
export const SCRAP_ITEM_CODE = 'SCRAP-STEEL';
const SCRAP_NODE_CODE = 'SCRAP';
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const blank = (v) => v == null || String(v).trim() === '';

// --- where scrap lies -------------------------------------------------------------

/**
 * The company's scrap area: any active area whose purpose is 'scrap' (SCRAP
 * first), else one made now — like PROD-WIP, on first need.
 */
export async function scrapArea(db, c) {
  const pick = async () => (await db.query(
    "SELECT * FROM cf_stocking_areas WHERE company_id = ? AND purpose = 'scrap' AND deleted_at IS NULL ORDER BY code = ? DESC, status = 'active' DESC, id LIMIT 1",
    [c.companyId, SCRAP_AREA_CODE],
  ))[0][0];
  const have = await pick();
  if (have) return have;
  const [[taken]] = await db.query('SELECT id FROM cf_stocking_areas WHERE company_id = ? AND code_active = LOWER(?)', [c.companyId, SCRAP_AREA_CODE]);
  await db.query(
    "INSERT INTO cf_stocking_areas (company_id, code, name, purpose, status, notes, created_by) VALUES (?, ?, 'Scrap', 'scrap', 'active', ?, ?)",
    [c.companyId, taken ? `${SCRAP_AREA_CODE}-YARD` : SCRAP_AREA_CODE, 'Steel scrap: plate skeletons, strips, small bits and scrapped pieces. Made by the system.', c.userId ?? null],
  );
  return pick();
}

/**
 * The one scrap item, "Steel scrap (kg)": a catalog item counted by quantity in
 * kg. Filed in a Scrap variant beside the plate offcuts (made on first need).
 * Returns its id, or null when there is nowhere to file it (no plate offcut
 * place and no OFFCUT node) — the scrap then stays a loss, and says so.
 */
export async function scrapItem(db, c, places = null) {
  const [[have]] = await db.query("SELECT id FROM cf_master_records WHERE company_id = ? AND code = ? AND record_kind = 'item' AND deleted_at IS NULL", [c.companyId, SCRAP_ITEM_CODE]);
  if (have) return have.id;
  let [[node]] = await db.query('SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [c.companyId, SCRAP_NODE_CODE]);
  if (!node) {
    const anchorId = places?.plate?.offcutNodeId ?? null;
    const [[anchor]] = await db.query(
      `SELECT id, parent_id, depth FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL AND (id = ? OR code = 'OFFCUT') ORDER BY id = ? DESC LIMIT 1`,
      [c.companyId, anchorId ?? 0, anchorId ?? 0],
    );
    if (!anchor) return null;
    const [r] = await db.query(
      "INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, status) VALUES (?, ?, ?, 'item', ?, 'Scrap', 'active')",
      [c.companyId, anchor.parent_id, anchor.depth, SCRAP_NODE_CODE],
    );
    node = { id: r.insertId };
  }
  const [r] = await db.query(
    "INSERT INTO cf_master_records (company_id, record_kind, code, name, short_name, classification_id, status, created_by) VALUES (?, 'item', ?, 'Steel scrap (kg)', 'SCRAP', ?, 'active', ?)",
    [c.companyId, SCRAP_ITEM_CODE, node.id, c.userId ?? null],
  );
  await db.query(
    "INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing) VALUES (?, ?, 'catalog', 'quantity', 'kg', 'stock')",
    [r.insertId, c.companyId],
  );
  return r.insertId;
}

/** The scrap item's id if it exists — never makes it (readers). */
export async function scrapItemId(db, companyId) {
  const [[have]] = await db.query("SELECT id FROM cf_master_records WHERE company_id = ? AND code = ? AND record_kind = 'item' AND deleted_at IS NULL", [companyId, SCRAP_ITEM_CODE]);
  return have?.id ?? null;
}

// --- the scrap rate -------------------------------------------------------------------

/** { ratePerKg: number | null, note } — null = not set: scrap is valued at 0. A database without §67 reads as not set. */
export async function scrapRate(db, companyId) {
  try {
    const [[s]] = await db.query('SELECT scrap_rate_per_kg FROM cf_company_settings WHERE company_id = ?', [companyId]);
    const rate = s?.scrap_rate_per_kg == null ? null : Number(s.scrap_rate_per_kg);
    return { ratePerKg: rate, currency: 'INR', note: rate == null ? 'No scrap rate set — scrap is valued at 0.' : null };
  } catch (e) {
    if (e?.errno === 1054) return { ratePerKg: null, currency: 'INR', note: 'No scrap rate set — scrap is valued at 0.' };
    throw e;
  }
}

/**
 * Sets the rate (input.ratePerKg: a number ≥ 0, or blank = not set). Our scrap
 * already on the shelf is revalued at it (the item's average is the rate —
 * scrap is kept at a standard value, not at what it came from).
 */
export async function setScrapRate(db, c, input = {}) {
  let rate = null;
  if (!blank(input.ratePerKg)) {
    rate = Number(input.ratePerKg);
    if (!Number.isFinite(rate) || rate < 0 || rate >= 1e9) throw invalid('INVALID', 'The scrap rate is ₹ per kg: a number, zero or more. Leave it empty for "not set".');
    rate = round2(rate);
  }
  await db.query(
    `INSERT INTO cf_company_settings (company_id, scrap_rate_per_kg, updated_by) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE scrap_rate_per_kg = VALUES(scrap_rate_per_kg), updated_by = VALUES(updated_by)`,
    [c.companyId, rate, c.userId ?? null],
  );
  const itemId = await scrapItemId(db, c.companyId);
  if (itemId) {
    // Our loose scrap: the average becomes the rate over all of it (0 when not set).
    await db.query(
      `INSERT INTO cf_item_costs (company_id, item_id, owner_party_id, avg_unit_cost, costed_qty)
       SELECT ?, ?, NULL, ?, COALESCE(SUM(k.quantity), 0) FROM cf_stock_balances k WHERE k.company_id = ? AND k.item_id = ? AND k.batch_id IS NULL
       ON DUPLICATE KEY UPDATE avg_unit_cost = VALUES(avg_unit_cost), costed_qty = VALUES(costed_qty)`,
      [c.companyId, itemId, rate ?? 0, c.companyId, itemId],
    );
  }
  return scrapRate(db, c.companyId);
}

/**
 * What a kilogram of scrap is worth: the rate (0 when not set), never more
 * than what the steel it came from was worth per kg (`perKgCap`, null = no cap).
 */
export function scrapPerKg(rate, perKgCap = null) {
  const r = rate == null ? 0 : Number(rate);
  return perKgCap == null || !Number.isFinite(Number(perKgCap)) ? r : Math.max(0, Math.min(r, Number(perKgCap)));
}

// --- a customer's scrap: their own lot ------------------------------------------------

/**
 * The customer's scrap lot for an order, made on first need: one lot per
 * (customer, order), named "<order>-SCRAP". wants: [{ partyId, orderId, orderCode }].
 * Returns Map `${partyId}:${orderId}` -> batch id. Fixed queries.
 */
export async function customerScrapLots(db, c, itemId, wants) {
  const out = new Map();
  const list = [...new Map(wants.filter((w) => w.partyId).map((w) => [`${w.partyId}:${w.orderId ?? 0}`, w])).values()];
  if (!list.length || !itemId) return out;
  const [have] = await db.query(
    `SELECT id, owner_party_id, owner_order_id FROM cf_stock_batches
      WHERE company_id = ? AND item_id = ? AND owner_party_id IN (?) AND production_item_id IS NULL AND deleted_at IS NULL ORDER BY id`,
    [c.companyId, itemId, list.map((w) => w.partyId)],
  );
  for (const b of have) {
    const k = `${b.owner_party_id}:${b.owner_order_id ?? 0}`;
    if (!out.has(k)) out.set(k, b.id);
  }
  const missing = list.filter((w) => !out.has(`${w.partyId}:${w.orderId ?? 0}`));
  if (!missing.length) return out;
  const want = missing.map((w) => ({ ...w, code: `${w.orderCode ?? `P${w.partyId}`}-SCRAP`.slice(0, 54) }));
  const [taken] = await db.query('SELECT code_active FROM cf_stock_batches WHERE company_id = ? AND code_active IN (?)', [c.companyId, want.map((w) => w.code.toLowerCase())]);
  const takenSet = new Set(taken.map((t) => t.code_active));
  for (const w of want) if (takenSet.has(w.code.toLowerCase())) w.code = `${w.code}-${w.partyId}`;
  await insertRows(db, 'cf_stock_batches', ['company_id', 'item_id', 'code', 'received_on', 'owner_party_id', 'owner_order_id', 'unit_cost', 'notes', 'created_by'],
    want.map((w) => [c.companyId, itemId, w.code, new Date().toISOString().slice(0, 10), w.partyId, w.orderId ?? null, null,
      `The customer's scrap from ${w.orderCode ?? 'their material'} — theirs, to be given back.`, c.userId ?? null]));
  const [made] = await db.query('SELECT id, owner_party_id, owner_order_id FROM cf_stock_batches WHERE company_id = ? AND code_active IN (?)', [c.companyId, want.map((w) => w.code.toLowerCase())]);
  for (const b of made) out.set(`${b.owner_party_id}:${b.owner_order_id ?? 0}`, b.id);
  return out;
}

// --- losses ---------------------------------------------------------------------------

/**
 * Writes loss rows for a movement. rows: [{ kind, itemId, batchId?, ownerPartyId?, orderId?, orderLineId?, plateLotId?, kg?, value?, notes? }].
 * One statement. Value + = lost; a remake (material not recorded) is negative.
 */
export async function writeLosses(db, c, movementId, rows) {
  const list = (rows ?? []).filter((r) => r && r.itemId && ((r.kg != null && Math.abs(r.kg) > 1e-6) || (r.value != null && Math.abs(r.value) >= 0.005) || r.keep));
  if (!list.length) return 0;
  await insertRows(db, 'cf_stock_losses', ['company_id', 'movement_id', 'kind', 'item_id', 'batch_id', 'owner_party_id', 'order_id', 'order_line_id', 'plate_lot_id', 'kg', 'value', 'notes', 'created_by'],
    list.map((r) => [c.companyId, movementId, r.kind, r.itemId, r.batchId ?? null, r.ownerPartyId ?? null, r.orderId ?? null, r.orderLineId ?? null, r.plateLotId ?? null,
      r.kg == null ? null : round3(r.kg), r.value == null ? null : round2(r.value), r.notes ? String(r.notes).slice(0, 255) : null, c.userId ?? null]));
  return list.length;
}

/** The exact opposite of a movement's losses, onto the movement that undoes it. Two statements. */
export async function reverseLosses(db, c, fromMovementId, toMovementId) {
  const [rows] = await db.query('SELECT * FROM cf_stock_losses WHERE company_id = ? AND movement_id = ? AND deleted_at IS NULL', [c.companyId, fromMovementId]);
  if (!rows.length) return 0;
  return writeLosses(db, c, toMovementId, rows.map((r) => ({
    kind: r.kind, itemId: r.item_id, batchId: r.batch_id, ownerPartyId: r.owner_party_id, orderId: r.order_id, orderLineId: r.order_line_id,
    plateLotId: r.plate_lot_id, kg: r.kg == null ? null : -Number(r.kg), value: r.value == null ? null : -Number(r.value), notes: `Undone: ${r.notes ?? r.kind}`, keep: true,
  })));
}

// --- an offcut's status follows its stock ----------------------------------------------

/**
 * After a movement that took offcut pieces out of stock or put them back:
 * an offcut whose stock piece is gone becomes 'scrapped' (a scrap movement)
 * or 'returned' (a return to the customer); one back on a shelf (a reversal)
 * is 'available' again. Fixed queries: one read, at most three updates.
 */
export async function syncOffcutStatus(db, c, batchIds, movementType, movementId) {
  const ids = [...new Set((batchIds ?? []).filter(Boolean).map(Number))];
  if (!ids.length) return { scrapped: 0, returned: 0, available: 0 };
  const [rows] = await db.query(
    `SELECT o.id, o.status, o.batch_id, COALESCE(SUM(IF(a.purpose <> 'scrap', k.quantity, 0)), 0) AS on_hand
       FROM cf_offcuts o
       LEFT JOIN cf_stock_balances k ON k.company_id = o.company_id AND k.batch_id = o.batch_id
       LEFT JOIN cf_stocking_areas a ON a.id = k.stocking_area_id
      WHERE o.company_id = ? AND o.batch_id IN (?) AND o.deleted_at IS NULL
      GROUP BY o.id, o.status, o.batch_id`,
    [c.companyId, ids],
  );
  const gone = rows.filter((r) => Number(r.on_hand) <= 1e-6 && ['available', 'planned'].includes(r.status)).map((r) => r.id);
  const back = rows.filter((r) => Number(r.on_hand) > 1e-6 && ['scrapped', 'returned'].includes(r.status)).map((r) => r.id);
  const out = { scrapped: 0, returned: 0, available: 0 };
  if (gone.length && movementType === 'scrap') {
    await db.query("UPDATE cf_offcuts SET status = 'scrapped' WHERE company_id = ? AND id IN (?)", [c.companyId, gone]);
    out.scrapped = gone.length;
  } else if (gone.length && movementType === 'return') {
    await db.query("UPDATE cf_offcuts SET status = 'returned', returned_movement_id = COALESCE(returned_movement_id, ?) WHERE company_id = ? AND id IN (?)", [movementId ?? null, c.companyId, gone]);
    out.returned = gone.length;
  }
  if (back.length) {
    await db.query("UPDATE cf_offcuts SET status = 'available', returned_movement_id = NULL WHERE company_id = ? AND id IN (?)", [c.companyId, back]);
    out.available = back.length;
  }
  return out;
}

/**
 * GET /stock/losses?orderId=&owner=&kind= — value that left stock without
 * becoming stock (kerf, scrap write-downs, pieces made again), newest first,
 * with totals by kind. Two reads.
 */
export async function listLosses(db, companyId, q = {}) {
  const where = ['x.company_id = ?', 'x.deleted_at IS NULL'];
  const args = [companyId];
  if (!blank(q.orderId)) { where.push('x.order_id = ?'); args.push(Number(q.orderId)); }
  if (!blank(q.kind)) { where.push('x.kind = ?'); args.push(String(q.kind)); }
  if (q.owner === 'ours') where.push('x.owner_party_id IS NULL');
  else if (q.owner === 'customer') where.push('x.owner_party_id IS NOT NULL');
  else if (!blank(q.owner) && Number.isInteger(Number(q.owner))) { where.push('x.owner_party_id = ?'); args.push(Number(q.owner)); }
  try {
    const [[rows], [sums]] = await Promise.all([
      db.query(
        `SELECT x.*, m.code AS movement_code, m.reference, r.code AS item_code, r.name AS item_name, so.code AS order_code, op.name AS owner_name
           FROM cf_stock_losses x
           JOIN cf_stock_movements m ON m.id = x.movement_id
           JOIN cf_master_records r ON r.id = x.item_id
           LEFT JOIN cf_sales_orders so ON so.id = x.order_id
           LEFT JOIN cf_parties op ON op.id = x.owner_party_id
          WHERE ${where.join(' AND ')} ORDER BY x.id DESC LIMIT ${Math.min(Number(q.limit) || 200, 1000)}`, args),
      db.query(`SELECT x.kind, SUM(x.kg) AS kg, SUM(x.value) AS value, COUNT(*) AS n FROM cf_stock_losses x WHERE ${where.join(' AND ')} GROUP BY x.kind`, args),
    ]);
    return {
      totals: Object.fromEntries(sums.map((t) => [t.kind, { kg: t.kg == null ? null : round3(t.kg), value: t.value == null ? null : round2(t.value), rows: Number(t.n) }])),
      rows: rows.map((x) => ({
        id: x.id, kind: x.kind, kg: x.kg == null ? null : Number(x.kg), value: x.value == null ? null : Number(x.value),
        item: { id: x.item_id, code: x.item_code, name: x.item_name }, movement: { id: x.movement_id, code: x.movement_code, reference: x.reference },
        order: x.order_id ? { id: x.order_id, code: x.order_code } : null, owner: x.owner_party_id ? { id: x.owner_party_id, name: x.owner_name } : null,
        plateLotId: x.plate_lot_id, notes: x.notes, createdAt: x.created_at,
      })),
    };
  } catch (e) {
    if (e?.errno === 1146) return { totals: {}, rows: [] };
    throw e;
  }
}
