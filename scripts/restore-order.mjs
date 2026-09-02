/**
 * restore-order.mjs — undo the 2026-09-02 wipe for ONE order.
 *
 * KEYED ON THE WIPE'S TIMESTAMP, not on "everything deleted for this order".
 * Placebo holds 63 soft-deleted orders and only 10 are the wipe's; the rest were
 * deleted earlier by other work and must stay that way. The same is true inside
 * an order: `SO-20260902-0001` has 1,172 item rows, most of them deleted long
 * before the wipe. Restoring by order id alone would resurrect all of them.
 *
 * IT ALSO REPAIRS `is_leaf`. The structure migration's backfill carried
 * `AND deleted_at IS NULL`, so rows that were already soft-deleted never got it
 * and come back with `is_leaf = 0` on every row — which reads as "no part is cut
 * from anything", and nesting would silently offer nothing. `node_kind` and
 * `depth` were backfilled without that filter, so only leaf-ness needs redoing.
 *
 *   node scripts/restore-order.mjs <orderId>            # report
 *   node scripts/restore-order.mjs <orderId> --apply
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const ORDER_ID = Number(process.argv[2]);
if (!Number.isFinite(ORDER_ID)) { console.error('usage: restore-order.mjs <orderId> [--apply]'); process.exit(1); }

const __dir = path.dirname(fileURLToPath(import.meta.url));
const env = {};
fs.readFileSync(path.join(__dir, '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
  l = l.trim(); if (!l || l.startsWith('#')) return;
  const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
});
Object.assign(process.env, {
  DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER,
  DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true',
});

const { pool } = await import('../db.js');
const COMPANY = 30005;

const [[order]] = await pool.query(
  'SELECT id, order_number, customer_name, status, deleted_at FROM fab_orders WHERE id = ? AND company_id = ?',
  [ORDER_ID, COMPANY]);
if (!order) { console.error('no such order'); process.exit(1); }
if (!order.deleted_at) { console.log(`${order.order_number} is not deleted — nothing to do.`); process.exit(0); }

/**
 * A window, not an equality. `NOW()` is evaluated per statement, and the wipe
 * ran a dozen of them, so rows can differ by a second or two either side.
 */
const ts = order.deleted_at;
const from = new Date(ts.getTime() - 5000);
const to = new Date(ts.getTime() + 120000);
console.log(`${order.order_number} (#${order.id}) — ${order.customer_name}, status ${order.status}`);
console.log(`wipe stamp ${ts.toISOString()}, restoring rows deleted between ${from.toISOString()} and ${to.toISOString()}\n`);

const [items] = await pool.query(
  'SELECT id FROM fab_items WHERE company_id=? AND order_id=? AND deleted_at BETWEEN ? AND ?',
  [COMPANY, ORDER_ID, from, to]);
const itemIds = items.map((i) => i.id);

const [[everDeleted]] = await pool.query(
  'SELECT COUNT(*) n FROM fab_items WHERE company_id=? AND order_id=? AND deleted_at IS NOT NULL',
  [COMPANY, ORDER_ID]);
console.log(`items: ${itemIds.length} from the wipe (of ${everDeleted.n} deleted in total — the rest stay deleted)`);

const chunks = (a, n = 1000) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

/** table -> the column tying it to this order, and the ids to match. */
const PLAN = [
  ['fab_order_lines', 'order_id', [ORDER_ID]],
  ['fab_project_tasks', 'order_id', [ORDER_ID]],
  ['fab_plan_entries', 'order_id', [ORDER_ID]],
  ['fab_plan_run_items', 'order_id', [ORDER_ID]],
  ['fab_stock_reservations', 'order_id', [ORDER_ID]],
  ['fab_nest_issues', 'order_id', [ORDER_ID]],
  ['fab_item_metric_values', 'item_id', itemIds],
  ['fab_item_drawings', 'item_id', itemIds],
  ['fab_stock_pieces', 'wip_item_id', itemIds],
];

const report = [];
for (const [table, col, ids] of PLAN) {
  if (!ids.length) continue;
  let n = 0;
  for (const part of chunks(ids)) {
    const where = `WHERE ${col} IN (${part.map(() => '?').join(',')}) AND deleted_at BETWEEN ? AND ?`;
    if (APPLY) {
      const [r] = await pool.query(`UPDATE \`${table}\` SET deleted_at = NULL ${where}`, [...part, from, to]);
      n += r.affectedRows;
    } else {
      const [[c]] = await pool.query(`SELECT COUNT(*) n FROM \`${table}\` ${where}`, [...part, from, to]);
      n += c.n;
    }
  }
  if (n) report.push({ table, rows: n });
}

// Field values hang off (scope, scope_id), not a plain item_id column.
let fv = 0;
for (const part of chunks(itemIds)) {
  const where = `WHERE scope='order_item' AND scope_id IN (${part.map(() => '?').join(',')}) AND deleted_at BETWEEN ? AND ?`;
  if (APPLY) {
    const [r] = await pool.query(`UPDATE fab_field_values SET deleted_at = NULL ${where}`, [...part, from, to]);
    fv += r.affectedRows;
  } else {
    const [[c]] = await pool.query(`SELECT COUNT(*) n FROM fab_field_values ${where}`, [...part, from, to]);
    fv += c.n;
  }
}
if (fv) report.push({ table: 'fab_field_values', rows: fv });

if (APPLY) {
  for (const part of chunks(itemIds)) {
    await pool.query(
      `UPDATE fab_items SET deleted_at = NULL WHERE company_id=? AND id IN (${part.map(() => '?').join(',')})`,
      [COMPANY, ...part]);
  }
  await pool.query('UPDATE fab_orders SET deleted_at = NULL WHERE id = ? AND company_id = ?', [ORDER_ID, COMPANY]);
}
report.push({ table: 'fab_items', rows: itemIds.length });
report.push({ table: 'fab_orders', rows: 1 });
console.table(report);

if (!APPLY) { console.log('\nDRY RUN — pass --apply to restore.'); await pool.end(); process.exit(0); }

// ── repair is_leaf, which the migration could not backfill on deleted rows ──
await pool.query(
  `UPDATE fab_items i SET i.is_leaf = 0
    WHERE i.company_id=? AND i.order_id=? AND i.deleted_at IS NULL
      AND (i.node_kind='material'
           OR EXISTS (SELECT 1 FROM (SELECT parent_item_id, deleted_at, node_kind FROM fab_items) k
                       WHERE k.parent_item_id=i.id AND k.deleted_at IS NULL AND k.node_kind='structure'))`,
  [COMPANY, ORDER_ID]);
await pool.query(
  `UPDATE fab_items i SET i.is_leaf = 1
    WHERE i.company_id=? AND i.order_id=? AND i.deleted_at IS NULL AND i.node_kind='structure'
      AND NOT EXISTS (SELECT 1 FROM (SELECT parent_item_id, deleted_at, node_kind FROM fab_items) k
                       WHERE k.parent_item_id=i.id AND k.deleted_at IS NULL AND k.node_kind='structure')`,
  [COMPANY, ORDER_ID]);

const [[shape]] = await pool.query(
  `SELECT COUNT(*) items, SUM(is_leaf=1) leaves, SUM(node_kind='material') material, MAX(depth) maxDepth
     FROM fab_items WHERE company_id=? AND order_id=? AND deleted_at IS NULL`, [COMPANY, ORDER_ID]);
console.log(`\nrestored shape: ${shape.items} items, ${shape.leaves} leaves, ${shape.material} material links, max depth ${shape.maxDepth}`);
await pool.end();
