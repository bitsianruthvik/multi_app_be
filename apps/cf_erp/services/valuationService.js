/**
 * valuationService.js — what stock is worth and what a job has cost, read off
 * the stock ledger (CF_ERP_MONEY_PLAN §2, init.sql §35, decided 2026-09-30).
 * Nothing here writes.
 *
 *   stockValuation   value of stock by item, area or owner: OURS at cost, a
 *                    customer's material apart (the reference cost it came
 *                    with — it costs us nothing)
 *   itemCost         one item: last receipt cost, average cost, stock value
 *   orderCosts       per order line: material issued at cost, scrap value, and
 *                    each nest's plate, wastage and offcut value
 *
 * NOT COSTED IS NOT ZERO. Stock that came in before costs were kept has no
 * cost: its value is left out of every sum and its quantity is reported as
 * `uncostedQty` (stock) or `uncostedRows` (ledger rows), so a screen can say
 * "value unknown for 12 plates" instead of showing a wrong total.
 *
 * Every amount is INR, net of tax (GST sits on top later).
 */
import { notFound } from '../lib/errors.js';
import { loadMaster } from './records.js';
import { listStock } from './stockService.js';

const EPS = 1e-9;
const round2 = (n) => Number(Number(n).toFixed(2));
const round3 = (n) => Number(Number(n).toFixed(3));
const round4 = (n) => Number(Number(n).toFixed(4));
const round6 = (n) => Number(Number(n).toFixed(6));
const numOrNull = (v) => (v == null ? null : Number(v));
const dateOnly = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : d ?? null);
const FALLBACK_DENSITY = 7850;                 // kg/m3, steel — the same fallback nesting uses
export const CURRENCY = 'INR';

const bucket = () => ({ quantity: 0, value: 0, uncostedQty: 0 });
const add = (b, r) => {
  b.quantity = round6(b.quantity + r.quantity);
  b.value = round2(b.value + (r.value ?? 0));
  b.uncostedQty = round6(b.uncostedQty + (r.uncostedQty ?? 0));
};

/**
 * Value of stock. q: { groupBy: item | area | owner (default item), owner?: ours | customer | party id,
 * areaId?, itemId?, purpose? }. Every non-zero balance row, valued (stockService.valueRows).
 * Returns { currency, groupBy, ours, customers, groups: [{ key, label, ours, customers }] } where
 * ours / customers = { quantity, value, uncostedQty } (quantities of different items are only
 * summed within an item group; across items read `value`).
 */
export async function stockValuation(db, companyId, q = {}) {
  const groupBy = ['item', 'area', 'owner'].includes(q.groupBy) ? q.groupBy : 'item';
  const rows = await listStock(db, companyId, { owner: q.owner, areaId: q.areaId, itemId: q.itemId, purpose: q.purpose }, { limit: null });
  const ours = bucket();
  const customers = bucket();
  const groups = new Map();
  for (const r of rows) {
    const theirs = !!r.owner;
    add(theirs ? customers : ours, r);
    let key;
    let label;
    if (groupBy === 'item') { key = `item:${r.item.id}`; label = { item: r.item }; }
    else if (groupBy === 'area') { key = `area:${r.area.id}`; label = { area: r.area }; }
    else { key = theirs ? `party:${r.owner.party.id}` : 'ours'; label = { owner: theirs ? r.owner.party : null }; }
    if (!groups.has(key)) groups.set(key, { key, ...label, ours: bucket(), customers: bucket(), rows: 0 });
    const g = groups.get(key);
    add(theirs ? g.customers : g.ours, r);
    g.rows += 1;
  }
  const out = [...groups.values()].sort((a, b) => (b.ours.value + b.customers.value) - (a.ours.value + a.customers.value)
    || String(a.key).localeCompare(String(b.key)));
  return { currency: CURRENCY, groupBy, ours, customers, groups: out };
}

/**
 * The average cost of our stock of an item: the loose average (cf_item_costs)
 * for an item counted by quantity; for lots, the weighted average of our
 * costed lots on hand. null = nothing costed.
 */
function averageOf(item, pool, rows) {
  const ours = rows.filter((r) => !r.owner);
  if (item.tracked_by === 'quantity' && pool?.avg != null && ours.some((r) => !r.batch)) return pool.avg;
  const costed = ours.filter((r) => r.unitCost != null && r.quantity > EPS);
  const qty = costed.reduce((t, r) => t + r.quantity, 0);
  if (qty > EPS) return round4(costed.reduce((t, r) => t + r.quantity * r.unitCost, 0) / qty);
  return pool?.avg ?? null;
}

/**
 * One item's cost, for its page: { item, currency, lastReceipt, averageCost,
 * costedQty, stock: { ours, customers } }. lastReceipt is the latest costed
 * receipt of OUR stock that was not reversed (a customer's reference cost is
 * not a price we paid).
 */
export async function itemCost(db, companyId, itemId) {
  const item = await loadMaster(db, companyId, Number(itemId));
  if (!item || item.record_kind !== 'item') throw notFound('Item');
  const [[last]] = await db.query(
    `SELECT l.unit_cost, m.id AS movement_id, m.code AS movement_code, m.movement_date, p.id AS party_id, p.name AS party_name
       FROM cf_stock_ledger l
       JOIN cf_stock_movements m ON m.id = l.movement_id AND m.movement_type = 'receipt'
                                AND m.reversal_of_id IS NULL AND m.reversed_by_id IS NULL
       LEFT JOIN cf_stock_batches b ON b.id = l.batch_id
       LEFT JOIN cf_parties p ON p.id = m.party_id
      WHERE l.company_id = ? AND l.item_id = ? AND l.unit_cost IS NOT NULL AND l.quantity > 0 AND b.owner_party_id IS NULL
      ORDER BY m.movement_date DESC, m.id DESC LIMIT 1`,
    [companyId, item.id],
  );
  const [[poolRow]] = await db.query(
    'SELECT avg_unit_cost, costed_qty FROM cf_item_costs WHERE company_id = ? AND item_id = ? AND owner_key = 0',
    [companyId, item.id],
  );
  const pool = poolRow ? { avg: numOrNull(poolRow.avg_unit_cost), qty: Number(poolRow.costed_qty) } : null;
  const rows = await listStock(db, companyId, { itemId: item.id }, { limit: null });
  const ours = bucket();
  const customers = bucket();
  for (const r of rows) add(r.owner ? customers : ours, r);
  return {
    item: { id: item.id, code: item.code, name: item.name, uom: item.uom, trackedBy: item.tracked_by },
    currency: CURRENCY,
    lastReceipt: last ? {
      unitCost: Number(last.unit_cost), date: dateOnly(last.movement_date),
      movement: { id: last.movement_id, code: last.movement_code },
      party: last.party_id ? { id: last.party_id, name: last.party_name } : null,
    } : null,
    averageCost: averageOf(item, pool, rows),
    costedQty: pool ? pool.qty : null,        // loose stock the average covers (quantity items)
    stock: { ours, customers },
  };
}

/* ---- job cost ------------------------------------------------------------------------ */

/** Every revision of an order (they share its number): [ids], with the asked one's row. */
export async function orderFamily(db, companyId, orderId) {
  const [[o]] = await db.query(
    `SELECT o.id, o.code, o.code_active, o.revision, o.status, o.customer_id, p.code AS customer_code, p.name AS customer_name
       FROM cf_sales_orders o LEFT JOIN cf_parties p ON p.id = o.customer_id
      WHERE o.company_id = ? AND o.id = ? AND o.deleted_at IS NULL`,
    [companyId, Number(orderId)],
  );
  if (!o) throw notFound('Sales order');
  const [fam] = await db.query('SELECT id FROM cf_sales_orders WHERE company_id = ? AND code_active = ? AND deleted_at IS NULL', [companyId, o.code_active]);
  return { order: o, ids: fam.length ? fam.map((r) => r.id) : [o.id] };
}

/**
 * Kilograms in one unit of each item: 1 for an item kept in kg (1000 in
 * tonnes); else its stored WEIGHT; else thickness x length x width x density
 * (a plate). null when nothing says. One or two reads.
 */
export async function unitKgOf(db, companyId, itemIds) {
  const ids = [...new Set(itemIds.map(Number))];
  const out = new Map(ids.map((id) => [id, null]));
  if (!ids.length) return out;
  const [uoms] = await db.query('SELECT master_id, uom FROM cf_item_details WHERE company_id = ? AND master_id IN (?)', [companyId, ids]);
  const byUom = new Map(uoms.map((r) => [r.master_id, String(r.uom ?? '').trim().toLowerCase()]));
  const [vals] = await db.query(
    `SELECT v.subject_id, UPPER(s.code) AS code, v.value_number
       FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?) AND v.deleted_at IS NULL
        AND s.code IN ('WEIGHT','THICKNESS','LENGTH','WIDTH','DENSITY') AND v.value_number IS NOT NULL`,
    [companyId, ids],
  );
  const specs = new Map();
  for (const v of vals) {
    if (!specs.has(v.subject_id)) specs.set(v.subject_id, {});
    specs.get(v.subject_id)[v.code] = Number(v.value_number);
  }
  for (const id of ids) {
    const u = byUom.get(id);
    if (u === 'kg' || u === 'kgs') { out.set(id, 1); continue; }
    if (['t', 'mt', 'tonne', 'tonnes', 'ton'].includes(u)) { out.set(id, 1000); continue; }
    const s = specs.get(id) ?? {};
    if (s.WEIGHT > 0) out.set(id, round3(s.WEIGHT));
    else if (s.THICKNESS > 0 && s.LENGTH > 0 && s.WIDTH > 0) out.set(id, round3((s.THICKNESS * s.LENGTH * s.WIDTH / 1e9) * (s.DENSITY > 0 ? s.DENSITY : FALLBACK_DENSITY)));
  }
  return out;
}

/**
 * A nest lot's steel split by where it went, as shares of the plate: parts,
 * offcuts (reusable), scrap (kerf, sequence gaps, rim, wastage) — from the
 * waste recorded when the plan was accepted. null when the lot has none.
 */
export function lotShares(lot) {
  let w = lot.waste_json;
  if (typeof w === 'string') { try { w = JSON.parse(w); } catch { w = null; } }
  const plateArea = Number(w?.plateArea ?? 0);
  if (!(plateArea > 0)) return null;
  const parts = Number(w.partsArea ?? 0) / plateArea;
  const offcut = Number(w.offcut ?? 0) / plateArea;
  return { parts, offcut, scrap: Math.max(0, 1 - parts - offcut) };
}

export const lotPlateKg = (lot) => round3((Number(lot.length_mm) * Number(lot.width_mm) * Number(lot.thickness_mm) / 1e9)
  * (Number(lot.density) > 0 ? Number(lot.density) : FALLBACK_DENSITY));

/**
 * What an order has cost in material, per line (every revision of the order).
 * Material ISSUED to a line is at its cost (ours); a customer's material issued
 * is shown apart at its reference cost — it costs us nothing. Scrap booked
 * against the order is its value. Per line's nest: every plate lot, its steel
 * value (a customer's plate is not ours), and the value of its wastage and
 * offcuts, each a share of the plate by area.
 *
 * A plate lot's value is the cost of that plate size issued to that line, else
 * the plate's average cost, else its last receipt cost; none = not costed.
 *
 * Returns { order, currency, lines: [{ line, issued, customerIssued, scrap, nest }], notOnALine, totals }
 * where issued = { value, quantity, uncostedRows }, scrap = { value, uncostedRows },
 * nest = { lots, customerLots, plateValue, wastageKg, wastageValue, offcutKg, offcutValue, uncostedLots }.
 */
export async function orderCosts(db, companyId, orderId) {
  const { order, ids } = await orderFamily(db, companyId, orderId);
  const [lines] = await db.query(
    `SELECT l.id, l.line_no, l.order_id, o.revision, l.item_id, m.code AS item_code, m.name AS item_name
       FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id JOIN cf_master_records m ON m.id = l.item_id
      WHERE l.company_id = ? AND l.order_id IN (?) AND l.deleted_at IS NULL ORDER BY o.revision, l.line_no, l.id`,
    [companyId, ids],
  );
  const [moves] = await db.query(
    `SELECT m.order_line_id, m.movement_type, l.item_id, (b.owner_party_id IS NOT NULL) AS theirs,
            SUM(-l.quantity) AS qty, SUM(-l.value) AS value, SUM(l.value IS NULL) AS uncosted
       FROM cf_stock_ledger l
       JOIN cf_stock_movements m ON m.id = l.movement_id
       LEFT JOIN cf_stock_batches b ON b.id = l.batch_id
      WHERE l.company_id = ? AND m.order_id IN (?) AND m.movement_type IN ('issue','scrap')
        -- What production made for the order leaving the yard is a SHIPMENT (dispatchService),
        -- not material: production's own lots are left out.
        AND b.production_item_id IS NULL
      GROUP BY m.order_line_id, m.movement_type, l.item_id, (b.owner_party_id IS NOT NULL)`,
    [companyId, ids],
  );
  const lineIds = lines.map((l) => l.id);
  const [lots] = lineIds.length ? await db.query(
    `SELECT id, order_line_id, plate_item_id, lot_no, length_mm, width_mm, thickness_mm, density, waste_json, owner_party_id
       FROM cf_plate_lots WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL`,
    [companyId, lineIds],
  ) : [[]];

  // The cost of a plate size: issued to the line, else its average, else its last receipt.
  const plateIds = [...new Set(lots.map((l) => l.plate_item_id))];
  const avg = new Map();
  const lastCost = new Map();
  if (plateIds.length) {
    const [pools] = await db.query('SELECT item_id, avg_unit_cost FROM cf_item_costs WHERE company_id = ? AND owner_key = 0 AND item_id IN (?) AND avg_unit_cost IS NOT NULL', [companyId, plateIds]);
    for (const p of pools) avg.set(p.item_id, Number(p.avg_unit_cost));
    const [lotCosts] = await db.query(
      `SELECT b.item_id, SUM(k.quantity * b.unit_cost) / SUM(k.quantity) AS avg_cost
         FROM cf_stock_balances k JOIN cf_stock_batches b ON b.id = k.batch_id
        WHERE k.company_id = ? AND b.item_id IN (?) AND k.quantity > 0 AND b.unit_cost IS NOT NULL AND b.owner_party_id IS NULL
        GROUP BY b.item_id`,
      [companyId, plateIds],
    );
    for (const r of lotCosts) if (!avg.has(r.item_id) && r.avg_cost != null) avg.set(r.item_id, Number(r.avg_cost));
    const [lasts] = await db.query(
      `SELECT l.item_id, l.unit_cost FROM cf_stock_ledger l
         JOIN cf_stock_movements m ON m.id = l.movement_id AND m.movement_type = 'receipt' AND m.reversal_of_id IS NULL AND m.reversed_by_id IS NULL
         LEFT JOIN cf_stock_batches b ON b.id = l.batch_id
        WHERE l.company_id = ? AND l.item_id IN (?) AND l.unit_cost IS NOT NULL AND l.quantity > 0 AND b.owner_party_id IS NULL
        ORDER BY m.movement_date DESC, m.id DESC`,
      [companyId, plateIds],
    );
    for (const r of lasts) if (!lastCost.has(r.item_id)) lastCost.set(r.item_id, Number(r.unit_cost));
  }

  const blank = () => ({
    issued: { value: 0, quantity: 0, uncostedRows: 0 },
    customerIssued: { value: 0, quantity: 0, uncostedRows: 0 },
    scrap: { value: 0, uncostedRows: 0 },
    nest: { lots: 0, customerLots: 0, plateValue: 0, wastageKg: 0, wastageValue: 0, offcutKg: 0, offcutValue: 0, uncostedLots: 0 },
    issuedByItem: new Map(),
  });
  const per = new Map(lines.map((l) => [l.id, blank()]));
  const loose = blank();
  for (const m of moves) {
    const e = (m.order_line_id && per.get(m.order_line_id)) || loose;
    if (m.movement_type === 'issue') {
      const t = Number(m.theirs) ? e.customerIssued : e.issued;
      t.value = round2(t.value + Number(m.value ?? 0));
      t.quantity = round6(t.quantity + Number(m.qty));
      t.uncostedRows += Number(m.uncosted);
      if (!Number(m.theirs)) {
        const s = e.issuedByItem.get(m.item_id) ?? { qty: 0, value: 0, costedQty: 0 };
        s.qty += Number(m.qty);
        if (m.value != null) { s.value += Number(m.value); s.costedQty += Number(m.qty); }
        e.issuedByItem.set(m.item_id, s);
      }
    } else if (!Number(m.theirs)) {
      e.scrap.value = round2(e.scrap.value + Number(m.value ?? 0));
      e.scrap.uncostedRows += Number(m.uncosted);
    }
  }
  for (const lot of lots) {
    const e = per.get(lot.order_line_id);
    if (!e) continue;
    e.nest.lots += 1;
    if (lot.owner_party_id) { e.nest.customerLots += 1; continue; }      // their plate: not our cost
    const issued = e.issuedByItem.get(lot.plate_item_id);
    const unit = issued && issued.costedQty > EPS ? issued.value / issued.costedQty
      : avg.get(lot.plate_item_id) ?? lastCost.get(lot.plate_item_id) ?? null;
    const shares = lotShares(lot);
    const kg = lotPlateKg(lot);
    if (shares) {
      e.nest.wastageKg = round3(e.nest.wastageKg + kg * shares.scrap);
      e.nest.offcutKg = round3(e.nest.offcutKg + kg * shares.offcut);
    }
    if (unit == null) { e.nest.uncostedLots += 1; continue; }
    e.nest.plateValue = round2(e.nest.plateValue + unit);
    if (shares) {
      e.nest.wastageValue = round2(e.nest.wastageValue + unit * shares.scrap);
      e.nest.offcutValue = round2(e.nest.offcutValue + unit * shares.offcut);
    }
  }
  const strip = ({ issuedByItem, ...rest }) => rest;
  const outLines = lines.map((l) => ({
    line: { id: l.id, lineNo: l.line_no, orderId: l.order_id, revision: l.revision, item: { id: l.item_id, code: l.item_code, name: l.item_name } },
    ...strip(per.get(l.id)),
  }));
  const totals = outLines.reduce((t, l) => ({
    issuedValue: round2(t.issuedValue + l.issued.value),
    customerIssuedValue: round2(t.customerIssuedValue + l.customerIssued.value),
    scrapValue: round2(t.scrapValue + l.scrap.value),
    plateValue: round2(t.plateValue + l.nest.plateValue),
    wastageValue: round2(t.wastageValue + l.nest.wastageValue),
    offcutValue: round2(t.offcutValue + l.nest.offcutValue),
    uncostedRows: t.uncostedRows + l.issued.uncostedRows + l.scrap.uncostedRows,
  }), {
    issuedValue: round2(loose.issued.value), customerIssuedValue: round2(loose.customerIssued.value), scrapValue: round2(loose.scrap.value),
    plateValue: 0, wastageValue: 0, offcutValue: 0, uncostedRows: loose.issued.uncostedRows + loose.scrap.uncostedRows,
  });
  return {
    order: { id: order.id, code: order.code, revision: order.revision, customer: order.customer_id ? { id: order.customer_id, code: order.customer_code, name: order.customer_name } : null },
    currency: CURRENCY,
    lines: outLines,
    notOnALine: { issued: loose.issued, customerIssued: loose.customerIssued, scrap: loose.scrap },
    totals,
  };
}
