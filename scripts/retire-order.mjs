/**
 * retire-order.mjs — soft-delete ONE order and everything hanging off it.
 *
 * The mirror of restore-order.mjs, and deliberately so: every row is stamped in
 * a single pass, so the restore's timestamp-window trick can put exactly this
 * set back and nothing else. Rows deleted earlier for other reasons keep their
 * own stamps and stay deleted.
 *
 * REFUSES AN ORDER WITH STARTED WORK. A task that has been picked up on the
 * floor is history, and retiring the order it belongs to would hide it rather
 * than delete it — the numbers would still be in the actuals and nothing would
 * explain where they came from.
 *
 *   node scripts/retire-order.mjs <orderId>            # report
 *   node scripts/retire-order.mjs <orderId> --apply
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const ORDER_ID = Number(process.argv[2]);
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
  'SELECT id, order_number, status, customer_name, deleted_at FROM fab_orders WHERE id=? AND company_id=?',
  [ORDER_ID, COMPANY]);
if (!order) { console.error('no such order'); process.exit(1); }
if (order.deleted_at) { console.log(`${order.order_number} is already retired.`); process.exit(0); }
console.log(`${order.order_number} — ${order.customer_name}, status ${order.status}`);

const [[worked]] = await pool.query(
  `SELECT COUNT(*) n FROM fab_project_tasks
    WHERE company_id=? AND order_id=? AND deleted_at IS NULL
      AND (started_at IS NOT NULL OR status IN ('in_progress','paused','done'))`,
  [COMPANY, ORDER_ID]);
if (worked.n > 0) {
  console.error(`REFUSED: ${worked.n} task(s) have been started or finished on the floor.`);
  console.error('Retiring this order would hide that history rather than remove it.');
  process.exit(1);
}
console.log('no started work — safe to retire');

const [items] = await pool.query(
  'SELECT id FROM fab_items WHERE company_id=? AND order_id=? AND deleted_at IS NULL', [COMPANY, ORDER_ID]);
const [tasks] = await pool.query(
  'SELECT id FROM fab_project_tasks WHERE company_id=? AND order_id=? AND deleted_at IS NULL', [COMPANY, ORDER_ID]);
const itemIds = items.map((i) => i.id);
const taskIds = tasks.map((t) => t.id);

const chunks = (a, n = 1000) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const PLAN = [
  ['fab_task_wait_segments', 'task_id', taskIds],
  ['fab_task_events', 'task_id', taskIds],
  ['fab_task_holds', 'task_id', taskIds],
  ['fab_task_workers', 'task_id', taskIds],
  ['fab_task_inputs', 'task_id', taskIds],
  ['fab_plan_entry_tasks', 'task_id', taskIds],
  ['fab_cc_chain_tasks', 'task_id', taskIds],
  ['fab_item_metric_values', 'item_id', itemIds],
  ['fab_item_drawings', 'item_id', itemIds],
  ['fab_stock_pieces', 'wip_item_id', itemIds],
  ['fab_project_tasks', 'order_id', [ORDER_ID]],
  ['fab_plan_run_items', 'order_id', [ORDER_ID]],
  ['fab_plan_entries', 'order_id', [ORDER_ID]],
  ['fab_cc_drum_slots', 'order_id', [ORDER_ID]],
  ['fab_cc_plans', 'order_id', [ORDER_ID]],
  ['fab_dispatch_run_items', 'order_id', [ORDER_ID]],
  ['fab_nest_issues', 'order_id', [ORDER_ID]],
  ['fab_stock_reservations', 'order_id', [ORDER_ID]],
  ['fab_items', 'order_id', [ORDER_ID]],
  ['fab_order_lines', 'order_id', [ORDER_ID]],
];

const report = [];
for (const [table, col, ids] of PLAN) {
  if (!ids.length) continue;
  let n = 0;
  for (const part of chunks(ids)) {
    const where = `WHERE ${col} IN (${part.map(() => '?').join(',')}) AND deleted_at IS NULL`;
    if (APPLY) {
      const [r] = await pool.query(`UPDATE \`${table}\` SET deleted_at = NOW() ${where}`, part);
      n += r.affectedRows;
    } else {
      const [[c]] = await pool.query(`SELECT COUNT(*) n FROM \`${table}\` ${where}`, part);
      n += c.n;
    }
  }
  if (n) report.push({ table, rows: n });
}

let fv = 0;
for (const part of chunks(itemIds)) {
  const where = `WHERE scope='order_item' AND scope_id IN (${part.map(() => '?').join(',')}) AND deleted_at IS NULL`;
  if (APPLY) {
    const [r] = await pool.query(`UPDATE fab_field_values SET deleted_at = NOW() ${where}`, part);
    fv += r.affectedRows;
  } else {
    const [[c]] = await pool.query(`SELECT COUNT(*) n FROM fab_field_values ${where}`, part);
    fv += c.n;
  }
}
if (fv) report.push({ table: 'fab_field_values', rows: fv });

if (APPLY) await pool.query('UPDATE fab_orders SET deleted_at = NOW() WHERE id=? AND company_id=?', [ORDER_ID, COMPANY]);
report.push({ table: 'fab_orders', rows: 1 });
console.table(report);
console.log(`${APPLY ? 'retired' : 'would retire'} ${report.reduce((a, b) => a + b.rows, 0)} rows`);
if (APPLY) console.log(`reversible: node scripts/restore-order.mjs ${ORDER_ID} --apply`);
await pool.end();
