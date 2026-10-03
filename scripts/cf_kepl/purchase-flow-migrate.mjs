/**
 * purchase-flow-migrate.mjs — moves open purchase requests into the one-PO flow
 * (CF_ERP_PURCHASE_FLOW_PLAN.md §3): each open request (draft / submitted /
 * approved, with lines still open) becomes a REQUESTED purchase order — its
 * open lines, each bought for the sales orders its buy-list source named — and
 * the request is closed with a note naming the PO.
 *
 *   node scripts/cf_kepl/purchase-flow-migrate.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/purchase-flow-migrate.mjs --company 30005 --apply    (commits)
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { insertOrder } from '../../apps/cf_erp/services/purchaseService.js';
import { insertAllocations } from '../../apps/cf_erp/services/purchaseLinkService.js';
import { splitTo } from '../../apps/cf_erp/services/procurementService.js';
import { insertRows } from '../../apps/cf_erp/lib/db.js';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--apply]');
const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

const db = await pool.getConnection();
try {
  await db.beginTransaction();
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const [reqs] = await db.query("SELECT * FROM cf_purchase_requests WHERE company_id = ? AND deleted_at IS NULL AND status IN ('draft','submitted','approved') ORDER BY id", [COMPANY]);
  for (const r of reqs) {
    const [lines] = await db.query("SELECT * FROM cf_purchase_request_lines WHERE company_id = ? AND request_id = ? AND deleted_at IS NULL AND status = 'open' ORDER BY line_no", [COMPANY, r.id]);
    if (!lines.length) { console.log(`${r.code}: no open lines — left as it is`); continue; }
    const orders = new Set();
    for (const l of lines) for (const x of splitTo(parse(l.source)?.split ?? [], Number(l.quantity))) orders.add(x.orderId);
    const poId = await insertOrder(db, c, { code: null, supplierId: null, expectedDate: r.needed_by ?? null, suggested: false, forOrderId: orders.size === 1 ? [...orders][0] : null, notes: `Moved from purchase request ${r.code}.` });
    const byItem = new Map();
    for (const l of lines) {
      const e = byItem.get(l.item_id) ?? { itemId: l.item_id, uom: l.uom, qty: 0, price: l.est_unit_price, split: [] };
      e.qty += Number(l.quantity);
      const src = parse(l.source);
      e.split.push(...splitTo(src?.split ?? (src?.orders?.length === 1 ? [{ orderId: Number(src.orders[0].id), orderCode: src.orders[0].code, quantity: Number(l.quantity) }] : []), Number(l.quantity)));
      byItem.set(l.item_id, e);
    }
    const rows = [...byItem.values()];
    await insertRows(db, 'cf_purchase_order_lines', ['company_id', 'purchase_order_id', 'line_no', 'item_id', 'quantity', 'uom', 'unit_price', 'currency', 'request_line_id'],
      rows.map((e, k) => [COMPANY, poId, k + 1, e.itemId, e.qty, e.uom ?? 'nos', e.price ?? null, 'INR', lines.find((l) => l.item_id === e.itemId).id]));
    const [made] = await db.query('SELECT id, item_id FROM cf_purchase_order_lines WHERE company_id = ? AND purchase_order_id = ? AND deleted_at IS NULL', [COMPANY, poId]);
    const lineOf = new Map(made.map((m) => [m.item_id, m.id]));
    await insertAllocations(db, c, rows.flatMap((e) => e.split.map((x) => ({ lineId: lineOf.get(e.itemId), orderId: x.orderId, quantity: x.quantity }))));
    await db.query("UPDATE cf_purchase_request_lines SET status = 'ordered' WHERE company_id = ? AND id IN (?)", [COMPANY, lines.map((l) => l.id)]);
    const [[po]] = await db.query('SELECT code FROM cf_purchase_orders WHERE id = ?', [poId]);
    await db.query("UPDATE cf_purchase_requests SET status = 'closed', decision_note = ? WHERE company_id = ? AND id = ?", [`Moved to ${po.code} (one-PO purchase flow).`, COMPANY, r.id]);
    console.log(`${r.code}: ${rows.length} line(s) → ${po.code} (requested${orders.size ? `, for ${orders.size} order(s)` : ''})`);
  }
  const [[d]] = await db.query("SELECT COUNT(*) n FROM cf_purchase_orders WHERE company_id = ? AND status = 'draft' AND deleted_at IS NULL", [COMPANY]);
  console.log(`draft POs left: ${d.n} (init.sql §46 makes them requested)`);
  if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
} catch (err) {
  await db.rollback();
  console.error('ERROR', err.message);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
