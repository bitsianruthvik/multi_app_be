/**
 * wipe-orders.mjs — soft-delete every sales/purchase/manufacturing order and
 * everything that hangs off one.
 *
 * SCOPE: orders only. The catalog, customers, suppliers, flows, plants,
 * resources, workers and PURCHASED stock are left alone — this clears the
 * transactional layer so structure work can start from a clean sheet.
 *
 * WIP stock IS in scope. A WIP piece (`wip_item_id` set) is an order item's
 * steel part-way through the shop; it is not inventory anybody bought, and
 * leaving it behind would point live rows at deleted items. Purchased pieces
 * (`wip_item_id IS NULL`) are untouched.
 *
 * SOFT DELETE, so `deleted_at` is stamped and nothing is dropped. Every read
 * path in the app filters `deleted_at IS NULL`, so the effect is a clean slate
 * with the rows still on disk.
 *
 * DRY RUN BY DEFAULT. Pass --apply to write.
 *
 *   node scripts/wipe-orders.mjs           # report only
 *   node scripts/wipe-orders.mjs --apply   # do it
 */
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const __dir = path.dirname(fileURLToPath(import.meta.url));

const env = {};
fs.readFileSync(path.join(__dir, '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
  l = l.trim(); if (!l || l.startsWith('#')) return;
  const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
});

const conn = await mysql.createConnection({
  host: env.DB_HOST, port: Number(env.DB_PORT) || 4000, user: env.DB_USER,
  password: env.DB_PASSWORD, database: env.DB_NAME, ssl: { rejectUnauthorized: true },
});
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${env.DB_HOST}\n`);

/** Every live order, and the items and tasks under them. */
const [orders] = await conn.query('SELECT id FROM fab_orders WHERE deleted_at IS NULL');
const [items] = await conn.query('SELECT id FROM fab_items WHERE deleted_at IS NULL');
const [tasks] = await conn.query('SELECT id FROM fab_project_tasks WHERE deleted_at IS NULL');
const orderIds = orders.map((r) => r.id);
const itemIds = items.map((r) => r.id);
const taskIds = tasks.map((r) => r.id);

if (!orderIds.length) { console.log('No live orders. Nothing to do.'); await conn.end(); process.exit(0); }
console.log(`orders=${orderIds.length}  items=${itemIds.length}  tasks=${taskIds.length}\n`);

/**
 * Chunked, because these id lists run to tens of thousands and TiDB has a
 * statement size limit. 2000 keeps each IN() well inside it.
 */
const CHUNK = 2000;
const chunks = (arr) => {
  const out = [];
  for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK));
  return out;
};

/** table -> the column linking it to what we are deleting, and which id list. */
const PLAN = [
  // task-scoped, deepest first
  ['fab_task_wait_segments', 'task_id', taskIds],
  ['fab_task_events', 'task_id', taskIds],
  ['fab_task_holds', 'task_id', taskIds],
  ['fab_task_workers', 'task_id', taskIds],
  ['fab_task_inputs', 'task_id', taskIds],
  ['fab_plan_entry_tasks', 'task_id', taskIds],
  ['fab_cc_chain_tasks', 'task_id', taskIds],
  // item-scoped
  ['fab_item_metric_values', 'item_id', itemIds],
  ['fab_item_drawings', 'item_id', itemIds],
  // order-scoped
  ['fab_project_tasks', 'order_id', orderIds],
  ['fab_plan_run_items', 'order_id', orderIds],
  ['fab_plan_entries', 'order_id', orderIds],
  ['fab_cc_drum_slots', 'order_id', orderIds],
  ['fab_cc_plans', 'order_id', orderIds],
  ['fab_dispatch_run_items', 'order_id', orderIds],
  ['fab_nest_issues', 'order_id', orderIds],
  ['fab_stock_reservations', 'order_id', orderIds],
  ['fab_items', 'order_id', orderIds],
  ['fab_order_lines', 'order_id', orderIds],
  ['fab_orders', 'id', orderIds],
];

const report = [];

const countOnly = async (sql, args) => {
  const [[r]] = await conn.query(sql.replace(/^UPDATE (\S+) SET deleted_at = NOW\(\)/, 'SELECT COUNT(*) n FROM $1'), args);
  return r.n;
};

try {
  if (APPLY) await conn.beginTransaction();

  for (const [table, col, ids] of PLAN) {
    let touched = 0;
    for (const part of chunks(ids)) {
      if (!part.length) continue;
      const where = `WHERE ${col} IN (${part.map(() => '?').join(',')}) AND deleted_at IS NULL`;
      if (APPLY) {
        const [r] = await conn.query(`UPDATE \`${table}\` SET deleted_at = NOW() ${where}`, part);
        touched += r.affectedRows;
      } else {
        const [[r]] = await conn.query(`SELECT COUNT(*) n FROM \`${table}\` ${where}`, part);
        touched += r.n;
      }
    }
    report.push({ table, via: col, rows: touched });
  }

  // Field values are scoped by (scope, scope_id), not by a plain item_id column.
  let fv = 0;
  for (const part of chunks(itemIds)) {
    if (!part.length) continue;
    const where = `WHERE scope = 'order_item' AND scope_id IN (${part.map(() => '?').join(',')}) AND deleted_at IS NULL`;
    if (APPLY) {
      const [r] = await conn.query(`UPDATE fab_field_values SET deleted_at = NOW() ${where}`, part);
      fv += r.affectedRows;
    } else {
      const [[r]] = await conn.query(`SELECT COUNT(*) n FROM fab_field_values ${where}`, part);
      fv += r.n;
    }
  }
  report.push({ table: 'fab_field_values', via: "scope='order_item'", rows: fv });

  // WIP stock only. A purchased piece is inventory and stays.
  let wip = 0;
  for (const part of chunks(itemIds)) {
    if (!part.length) continue;
    const where = `WHERE wip_item_id IN (${part.map(() => '?').join(',')}) AND deleted_at IS NULL`;
    if (APPLY) {
      const [r] = await conn.query(`UPDATE fab_stock_pieces SET deleted_at = NOW() ${where}`, part);
      wip += r.affectedRows;
    } else {
      const [[r]] = await conn.query(`SELECT COUNT(*) n FROM fab_stock_pieces ${where}`, part);
      wip += r.n;
    }
  }
  report.push({ table: 'fab_stock_pieces (WIP only)', via: 'wip_item_id', rows: wip });

  if (APPLY) await conn.commit();
} catch (err) {
  if (APPLY) await conn.rollback();
  console.error('FAILED, rolled back:', err.message);
  await conn.end();
  process.exit(1);
}

console.table(report.filter((r) => r.rows > 0));
console.log(`\ntotal rows ${APPLY ? 'soft-deleted' : 'that would be soft-deleted'}: ${report.reduce((a, b) => a + b.rows, 0)}`);

const [[left]] = await conn.query(`SELECT
  (SELECT COUNT(*) FROM fab_orders       WHERE deleted_at IS NULL) orders,
  (SELECT COUNT(*) FROM fab_items        WHERE deleted_at IS NULL) items,
  (SELECT COUNT(*) FROM fab_project_tasks WHERE deleted_at IS NULL) tasks,
  (SELECT COUNT(*) FROM fab_item_catalog WHERE deleted_at IS NULL) catalog_kept,
  (SELECT COUNT(*) FROM fab_stock_pieces WHERE deleted_at IS NULL AND wip_item_id IS NULL) purchased_stock_kept,
  (SELECT COUNT(*) FROM fab_customers    WHERE deleted_at IS NULL) customers_kept`);
console.log('\nafter:', JSON.stringify(left));
await conn.end();
