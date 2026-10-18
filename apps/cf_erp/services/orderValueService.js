/**
 * orderValueService.js — ONE ORDER VALUE (2026-10-18, user: the header showed "Order value ₹6,91,46,903" from the line
 * rates while the customer acceptance said ₹38,72,227 — "that will confuse everybody").
 *
 * THE RULE (every screen that shows an order's value reads it from here — order header, Orders list, Orders board,
 * dashboards, the home order book, the Costs card; Billing and Order costing read the approved acceptance already):
 *   1. The order has APPROVED acceptance terms   → the value is the accepted value (its estimate's `value`).
 *      A rate change waiting for approval does not move it until it is approved (`pendingValue` says what it would be).
 *   2. Terms are SENT and wait for approval       → the value is the value of those terms ("awaiting approval").
 *   3. No terms yet                               → the ESTIMATE from the line rates (qty × the rate typed at Add line).
 *   Rejected / withdrawn terms are not terms: the estimate stands again.
 * `estimate` is always the line-rate figure; `differs` = there are terms and the estimate is not within ₹1 of them —
 * the screens then say "accepted ₹… · estimate ₹…". Line rates are NEVER rewritten from the acceptance (the charges
 * are per operation, per tonne, per m² — they do not map back onto a line's rate); the line rate is the sales estimate.
 */
import { amountOf, measuresOf, num, round2 } from './priceService.js';

const EPS_RUPEE = 1;
const parse = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };

/**
 * Each order's standing terms value. ONE read. Map orderId → { approved: { value, version } | null,
 * pending: { value, version, kind } | null }.
 */
export async function acceptedValuesOf(db, companyId, orderIds) {
  const ids = [...new Set((orderIds ?? []).map(Number).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  let rows;
  try {
    [rows] = await db.query(
      `SELECT order_id, version, kind, status, JSON_EXTRACT(estimate_json, '$.value') AS value
         FROM cf_order_acceptances WHERE company_id = ? AND order_id IN (?) AND deleted_at IS NULL AND status IN ('approved', 'pending')
        ORDER BY order_id, version DESC`,
      [companyId, ids],
    );
  } catch (e) {
    if (e?.errno === 1146) return out;           // a database without §73: no terms anywhere
    throw e;
  }
  for (const r of rows) {
    const id = Number(r.order_id);
    if (!out.has(id)) out.set(id, { approved: null, pending: null });
    const e = out.get(id);
    const value = r.value == null ? null : Number(parse(r.value));
    if (r.status === 'approved' && !e.approved) e.approved = { value: Number.isFinite(value) ? round2(value) : null, version: Number(r.version) };
    if (r.status === 'pending' && !e.pending) e.pending = { value: Number.isFinite(value) ? round2(value) : null, version: Number(r.version), kind: r.kind };
  }
  return out;
}

/**
 * THE RULE, pure. total = the line estimate ({ amount, complete, unpricedLines } as salesOrderService.orderTotal),
 * terms = acceptedValuesOf's entry. Returns { amount | null, basis 'accepted' | 'awaiting_approval' | 'estimate' | 'none',
 * label, estimate | null, estimateComplete, accepted | null, pendingValue | null, differs }.
 */
export function orderValueOf(total, terms = null, { lineCount = null } = {}) {
  const priced = total && (Number(total.amount) > 0 || (lineCount != null ? (total.unpricedLines?.length ?? 0) < lineCount : false));
  const estimate = priced ? round2(Number(total.amount)) : null;
  const estimateComplete = !!total?.complete;
  const base = { estimate, estimateComplete, accepted: null, pendingValue: null, differs: false };
  const diff = (v) => estimate != null && v != null && Math.abs(estimate - v) >= EPS_RUPEE;
  if (terms?.approved && terms.approved.value != null) {
    const v = terms.approved.value;
    return { ...base, amount: v, basis: 'accepted', label: 'accepted', accepted: v, differs: diff(v), version: terms.approved.version,
      pendingValue: terms.pending?.value ?? null };
  }
  if (terms?.pending && terms.pending.value != null) {
    const v = terms.pending.value;
    return { ...base, amount: v, basis: 'awaiting_approval', label: 'terms awaiting approval', accepted: null, pendingValue: v, differs: diff(v), version: terms.pending.version };
  }
  if (estimate != null) return { ...base, amount: estimate, basis: 'estimate', label: estimateComplete ? 'estimate' : 'estimate, not every line priced' };
  return { ...base, amount: null, basis: 'none', label: 'not priced' };
}

/**
 * The value of some orders, read from scratch (Orders board, dashboards): the lines' estimate + the terms. 2–3 reads.
 * Map orderId → orderValueOf(…).
 */
export async function orderValuesFor(db, companyId, orderIds) {
  const ids = [...new Set((orderIds ?? []).map(Number).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const [[lines], terms] = await Promise.all([
    db.query(
      `SELECT l.id, l.order_id, l.item_id, l.quantity, l.rate, l.rate_basis, i.uom
         FROM cf_sales_order_lines l LEFT JOIN cf_item_details i ON i.master_id = l.item_id
        WHERE l.company_id = ? AND l.order_id IN (?) AND l.deleted_at IS NULL`,
      [companyId, ids]),
    acceptedValuesOf(db, companyId, ids),
  ]);
  const measured = lines.filter((l) => l.item_id && (l.rate_basis ?? 'unit') !== 'unit');
  const measures = measured.length ? await measuresOf(db, companyId, measured.map((l) => l.item_id)) : new Map();
  const totals = new Map(ids.map((id) => [id, { amount: 0, complete: true, unpricedLines: [], n: 0 }]));
  for (const l of lines) {
    const t = totals.get(Number(l.order_id));
    t.n += 1;
    if (l.rate == null) { t.unpricedLines.push(l.id); t.complete = false; continue; }
    const a = amountOf(num(l.rate), l.rate_basis ?? 'unit', Number(l.quantity), measures.get(l.item_id), l.uom ?? 'nos');
    if (a.amount == null) { t.complete = false; continue; }
    t.amount += a.amount;
  }
  for (const id of ids) {
    const t = totals.get(id);
    out.set(id, orderValueOf({ ...t, amount: round2(t.amount), complete: t.n > 0 && t.complete }, terms.get(id), { lineCount: t.n }));
  }
  return out;
}
