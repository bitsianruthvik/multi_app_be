/**
 * materialRequiredService.js — MATERIAL REQUIRED, the order's material step (user, 2026-11-12):
 *
 *   "Instead of Material request, we should call it material required. In that we should show what's in the store against
 *    each item. Just for them to view. And they should have a button which says create a material request. There should
 *    be another button to download all required materials. … Only after customer accepts [and the MD accepts] should we
 *    enable the material request button."
 *
 *   GET /orders/:id/materials-required → {
 *     order { id, code, status, orderType }, canRequest, requestWhy, acceptance: 'none' | 'pending' | 'accepted',
 *     items [{ item { id, code, name, uom }, need, issued, reserved, inStore, theirsInStore, short, lines: [lineNo] }],
 *     lines [{ lineId, lineNo, name, supply, known, why, items: [{ itemId, need }] }]
 *   }
 * need: what the order needs of the item (all its lines); inStore: free stock in the stores now (ours, plus the customer's
 * own lots for this order — theirsInStore of it); short: what neither the store nor what is already issued / earmarked for
 * the order covers. A VIEW only: nothing is held or bought here. The needs are materialReadyService.lineNeeds' (the one
 * source the buy list, release and the MR read); the stock is rollOutService.availability's.
 * Round trips: 2 (order, lines) + lineNeeds' + 1 (availability) + the acceptance standing.
 */
import { notFound } from '../lib/errors.js';
import { lineNeeds, openLines } from './materialReadyService.js';
import { availability } from './rollOutService.js';

const r6 = (n) => Math.round(Number(n) * 1e6) / 1e6;
const supplyOf = (v) => (v === 'customer' ? 'customer' : 'we_buy');

/** Whether the order may raise its MR, and in words why not. Pure. acceptance: 'none' | 'pending' | 'accepted'. */
export function requestGate(order, acceptance) {
  if (!['inquiry', 'quoted', 'confirmed', 'draft'].includes(order.status)) return { canRequest: false, requestWhy: `${order.code} is ${order.status}.` };
  if (order.order_type !== 'customer') {
    return order.status === 'confirmed' ? { canRequest: true, requestWhy: null } : { canRequest: false, requestWhy: 'Confirm the order first.' };
  }
  if (order.status === 'confirmed') return { canRequest: true, requestWhy: null };
  return acceptance === 'pending'
    ? { canRequest: false, requestWhy: 'Waiting for the MD to accept the order.' }
    : { canRequest: false, requestWhy: "Waiting for the customer's acceptance." };
}

export async function materialsRequired(db, companyId, orderId) {
  const [[o]] = await db.query('SELECT id, code, status, order_type, customer_id FROM cf_sales_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(orderId)]);
  if (!o) throw notFound('Sales order');
  const { acceptanceStates } = await import('./acceptanceService.js');
  const [lines, acc] = await Promise.all([openLines(db, companyId, { orderIds: [o.id] }), acceptanceStates(db, companyId, [o.id])]);
  const a = acc.get(Number(o.id)) ?? {};
  const acceptance = a.approved || o.status === 'confirmed' ? 'accepted' : a.pending ? 'pending' : 'none';
  const needs = lines.length ? await lineNeeds(db, companyId, lines) : new Map();
  const byItem = new Map();
  const lineRows = lines.map((l) => {
    const n = needs.get(Number(l.id));
    const items = n?.known ? [...n.items.values()] : [];
    for (const e of items) {
      const cur = byItem.get(e.item.id) ?? { item: e.item, need: 0, issued: 0, reserved: 0, lines: [] };
      cur.need = r6(cur.need + e.need); cur.issued = r6(cur.issued + e.issued); cur.reserved = r6(cur.reserved + e.reserved);
      if (!cur.lines.includes(l.line_no)) cur.lines.push(l.line_no);
      byItem.set(e.item.id, cur);
    }
    return {
      lineId: Number(l.id), lineNo: l.line_no, name: l.item_name ?? l.description ?? `Line ${l.line_no}`,
      supply: supplyOf(l.own_supply ?? l.order_supply), known: !!n?.known && !!n?.ready, why: n?.known ? (n.ready ? null : n.why) : n?.why ?? null,
      items: items.map((e) => ({ itemId: e.item.id, need: e.need })),
    };
  });
  const ids = [...byItem.keys()];
  const stock = ids.length ? await availability(db, companyId, ids, { orderId: o.id }) : new Map();
  const items = [...byItem.values()].map((e) => {
    const s = stock.get(e.item.id) ?? { free: 0, theirsFree: 0 };
    const covered = e.issued + e.reserved + Number(s.free);
    return {
      item: { id: e.item.id, code: e.item.code ?? null, name: e.item.name ?? null, uom: e.item.uom ?? null },
      need: e.need, issued: e.issued, reserved: e.reserved, inStore: r6(s.free), theirsInStore: r6(s.theirsFree ?? 0),
      short: r6(Math.max(0, e.need - covered)), lines: e.lines.sort((x, y) => x - y),
    };
  }).sort((x, y) => String(x.item.code ?? x.item.name ?? '').localeCompare(String(y.item.code ?? y.item.name ?? '')));
  return {
    order: { id: o.id, code: o.code, status: o.status, orderType: o.order_type },
    acceptance,
    ...requestGate(o, acceptance),
    items,
    lines: lineRows,
  };
}
