/**
 * priceService.js — what things cost and what they sell for (CF_ERP_MONEY_PLAN §3,
 * init.sql §36).
 *
 * Three prices, one rule set:
 *   - a catalog item's LIST price (cf_item_details.list_price + price_basis);
 *   - a sales order line's RATE (+ rate_basis) — defaults to the item's list price;
 *   - a purchase order line's UNIT PRICE — defaults to the last price paid.
 *
 * A price is quoted per a BASIS: 'unit' (the item's own unit — nos, a plate, a
 * span), 'kg', 'tonne' or 'metre'. Turning a per-kg price into money needs the
 * item's WEIGHT; per metre needs its LENGTH. Both are ordinary item-level values
 * (cf_spec_values, subject 'master'); on an order's root item WEIGHT is the
 * roll-up of its whole structure, so "rate × the line's weight" is rate × the
 * root's WEIGHT × the line quantity — the same number the planner shows in
 * tonnes (plannerService: lineWeight × quantity).
 *
 * AMOUNTS ARE WORKED OUT ON READ, never stored: rate × quantity (× weight) is
 * one multiplication, and a stored amount would go stale the moment a weight
 * roll-up or a quantity changed. The PRICE is stored (it is what was agreed);
 * the amount follows from it.
 *
 * Every price is NET OF TAX. GST sits on top later (HSN, CGST/SGST/IGST) without
 * touching these columns. Currency is INR only for now; the column is there so
 * another currency can come later without a migration.
 */
import { notFound } from '../lib/errors.js';

export const PRICE_BASES = ['unit', 'kg', 'tonne', 'metre'];
export const PRICE_BASIS_LABEL = { unit: 'per unit', kg: 'per kg', tonne: 'per tonne', metre: 'per metre' };
export const CURRENCY = 'INR';
/** A unit price above this is a typo, not a price (DECIMAL(18,4) holds 1e14). */
export const MAX_PRICE = 1e11;

const blank = (v) => v === undefined || v === null || String(v).trim() === '';
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e4) / 1e4;
const round6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
export const num = (v) => (v == null ? null : Number(v));

/**
 * A price typed by a person: blank is "no price" (null), otherwise a number from
 * zero (free of charge is a price) up to MAX_PRICE, kept to 4 decimals.
 */
export function readPrice(v, label, problems) {
  if (blank(v)) return null;
  const n = Number(typeof v === 'string' ? v.replace(/,/g, '').trim() : v);
  if (!Number.isFinite(n)) { problems.push(`${label} is a number.`); return null; }
  if (n < 0) { problems.push(`${label} cannot be negative.`); return null; }
  if (n > MAX_PRICE) { problems.push(`${label} is too large — check the number.`); return null; }
  return round4(n);
}

export function readBasis(v, label, problems) {
  if (blank(v)) return null;
  const s = String(v).trim().toLowerCase();
  if (!PRICE_BASES.includes(s)) { problems.push(`${label} is per unit, kg, tonne or metre.`); return null; }
  return s;
}

/** INR only for now: accepted when omitted or INR, refused otherwise. */
export function readCurrency(v, problems) {
  if (blank(v)) return null;
  const s = String(v).trim().toUpperCase();
  if (s !== CURRENCY) problems.push(`Prices are in ${CURRENCY} for now.`);
  return CURRENCY;
}

// --- measures: an item's WEIGHT and LENGTH, per one of it -----------------------

const KG_PER = { kg: 1, kgs: 1, g: 0.001, gm: 0.001, t: 1000, tonne: 1000, tonnes: 1000, ton: 1000, mt: 1000 };
const M_PER = { m: 1, mtr: 1, metre: 1, meter: 1, mm: 0.001, cm: 0.01, km: 1000 };
const factor = (table, uom) => table[String(uom ?? '').trim().toLowerCase()] ?? null;
/** Kilograms in one of `uom` (kg 1, t 1000 …), or null for a unit that is not a weight. For set-based readers that join WEIGHT themselves. */
export const kgPerUom = (uom) => factor(KG_PER, uom);

/**
 * { weightKg, lengthM } per ONE of each item, from its stored item-level WEIGHT
 * and LENGTH values — one query for any number of items. An unknown unit of
 * measure leaves the measure null rather than guessing.
 */
export async function measuresOf(db, companyId, itemIds) {
  const ids = [...new Set(itemIds.filter((x) => x != null).map(Number))];
  const out = new Map(ids.map((id) => [id, { weightKg: null, lengthM: null }]));
  if (!ids.length) return out;
  const [rows] = await db.query(
    `SELECT v.subject_id AS item_id, s.code, v.value_number, COALESCE(v.uom, s.default_uom) AS uom
       FROM cf_spec_values v
       JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?)
        AND v.deleted_at IS NULL AND v.value_number IS NOT NULL AND s.code IN ('WEIGHT', 'LENGTH')`,
    [companyId, ids],
  );
  for (const r of rows) {
    const m = out.get(Number(r.item_id));
    if (!m) continue;
    if (r.code === 'WEIGHT') { const f = factor(KG_PER, r.uom); if (f != null) m.weightKg = round6(Number(r.value_number) * f); }
    if (r.code === 'LENGTH') { const f = factor(M_PER, r.uom); if (f != null) m.lengthM = round6(Number(r.value_number) * f); }
  }
  return out;
}

/**
 * How much of the basis `quantity` of an item is: 5 plates at 120 kg each are
 * 600 kg, 0.6 t, and — per unit — 5. Returns { billed (6 dp), exact, uom, note }; billed
 * is null (with the reason in `note`) when the measure is missing.
 */
export function billedQuantity(basis, quantity, measure, unitUom = 'nos') {
  const q = Number(quantity);
  const out = (exact, uom) => ({ billed: round6(exact), exact, uom, note: null });
  const none = (uom, what, per) => ({ billed: null, exact: null, uom, note: `It has no ${what} yet, so a price per ${per} cannot be turned into an amount.` });
  switch (basis ?? 'unit') {
    case 'kg': return measure?.weightKg != null ? out(q * measure.weightKg, 'kg') : none('kg', 'WEIGHT', 'kg');
    case 'tonne': return measure?.weightKg != null ? out((q * measure.weightKg) / 1000, 't') : none('t', 'WEIGHT', 'tonne');
    case 'metre': return measure?.lengthM != null ? out(q * measure.lengthM, 'm') : none('m', 'LENGTH', 'metre');
    default: return out(q, unitUom);
  }
}

/** price × billed (from the unrounded billed quantity, so a big rate stays exact to the paisa), or null. */
export function amountOf(price, basis, quantity, measure, unitUom) {
  const { exact, ...b } = billedQuantity(basis, quantity, measure, unitUom);
  if (price == null) return { ...b, amount: null, note: null };
  return { ...b, amount: exact == null ? null : round2(Number(price) * exact) };
}

/** A price on some basis, as a price for ONE of the item (its own unit), or null. */
export function perUnitPrice(price, basis, measure) {
  if (price == null) return null;
  const b = billedQuantity(basis, 1, measure);
  return b.exact == null ? null : round4(Number(price) * b.exact);
}

// --- what we paid ---------------------------------------------------------------

/** A purchase order that went to a supplier. A draft was never agreed; a cancelled one never happened. */
export const SENT_PO_STATUSES = ['ordered', 'partially_received', 'received'];

/**
 * The last price paid for each item: the newest priced line on a purchase order
 * that was sent (by ordered date, then line id). One query for any number of
 * items. `exceptOrderId` leaves one order out (the one being priced).
 * Map itemId → { unitPrice, currency, orderId, orderCode, orderedAt, supplierId, supplierName }.
 */
export async function lastPricesPaid(db, companyId, itemIds, { exceptOrderId = null } = {}) {
  const ids = [...new Set(itemIds.filter((x) => x != null).map(Number))];
  const out = new Map();
  if (!ids.length) return out;
  const [rows] = await db.query(
    `SELECT l.item_id, l.unit_price, l.currency, p.id AS po_id, p.code AS po_code, p.ordered_at, p.created_at,
            p.supplier_id, s.name AS supplier_name
       FROM cf_purchase_order_lines l
       JOIN cf_purchase_orders p ON p.id = l.purchase_order_id AND p.deleted_at IS NULL
       LEFT JOIN cf_parties s ON s.id = p.supplier_id
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.unit_price IS NOT NULL
        AND l.item_id IN (?) AND p.status IN (?) ${exceptOrderId ? 'AND p.id <> ?' : ''}
      ORDER BY COALESCE(p.ordered_at, p.created_at) DESC, l.id DESC`,
    exceptOrderId ? [companyId, ids, SENT_PO_STATUSES, exceptOrderId] : [companyId, ids, SENT_PO_STATUSES],
  );
  for (const r of rows) {
    if (out.has(r.item_id)) continue;
    out.set(r.item_id, {
      unitPrice: Number(r.unit_price),
      currency: r.currency ?? CURRENCY,
      orderId: r.po_id,
      orderCode: r.po_code,
      orderedAt: r.ordered_at ?? r.created_at,
      supplierId: r.supplier_id ?? null,
      supplierName: r.supplier_name ?? null,
    });
  }
  return out;
}

/** List prices of items: Map itemId → { listPrice, priceBasis, currency }. */
export async function listPricesOf(db, companyId, itemIds) {
  const ids = [...new Set(itemIds.filter((x) => x != null).map(Number))];
  const out = new Map();
  if (!ids.length) return out;
  const [rows] = await db.query(
    'SELECT master_id, list_price, price_basis, currency FROM cf_item_details WHERE company_id = ? AND master_id IN (?) AND deleted_at IS NULL',
    [companyId, ids],
  );
  for (const r of rows) out.set(r.master_id, { listPrice: num(r.list_price), priceBasis: r.price_basis ?? 'unit', currency: r.currency ?? CURRENCY });
  return out;
}

/**
 * GET /records/:id/prices — what an item sells for and what we last paid.
 * The stock ledger adds its own keys to this object (last receipt cost,
 * average cost, stock value) — so every key here is named for what it is.
 *
 * { itemId, currency, listPrice, priceBasis, listUnitPrice, lastPurchasePrice,
 *   lastPurchaseDate, lastPurchaseOrder: { id, code } | null, lastPurchaseSupplier: { id, name } | null }
 * `listUnitPrice` is the list price for ONE of the item (a per-kg list price
 * times its WEIGHT), null when the measure is missing.
 */
export async function itemPrices(db, companyId, itemId) {
  const id = Number(itemId);
  const [list, paid, measures] = await Promise.all([
    listPricesOf(db, companyId, [id]),
    lastPricesPaid(db, companyId, [id]),
    measuresOf(db, companyId, [id]),
  ]);
  const l = list.get(id);
  if (!l) throw notFound('Item');
  const p = paid.get(id) ?? null;
  return {
    itemId: id,
    currency: CURRENCY,
    listPrice: l.listPrice,
    priceBasis: l.priceBasis,
    listUnitPrice: perUnitPrice(l.listPrice, l.priceBasis, measures.get(id)),
    lastPurchasePrice: p?.unitPrice ?? null,
    lastPurchaseDate: p?.orderedAt ?? null,
    lastPurchaseOrder: p ? { id: p.orderId, code: p.orderCode } : null,
    lastPurchaseSupplier: p?.supplierId ? { id: p.supplierId, name: p.supplierName } : null,
  };
}
