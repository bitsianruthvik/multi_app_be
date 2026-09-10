/**
 * drop-cutting-order.mjs — cutting stops being its own document.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 *
 * Blanks were briefly produced by an `order_type='cutting'` order of their own.
 * The reasoning was defensive: on the sales order a blank row looks like a made
 * leaf, so the function that computes blanks would make blanks out of blanks.
 *
 * That is a real problem with a one-line answer — exclude them by the catalog's
 * `material_form` — and the separate document cost far more than it saved.
 * Every job became two things to release, chase and close for one trip through
 * the same shop, and cutting sat outside the production order that owns all the
 * other work on the job.
 *
 * So the blanks move onto the sales order and the production order claims their
 * tasks like any other make work.
 *
 * ── WHAT THIS DOES ───────────────────────────────────────────────────────────
 *
 * Soft-deletes every cutting order with its rows and tasks, then re-runs the
 * accept so the blanks come back in the right place. It REFUSES if any cutting
 * task has been started — that is shop-floor history and moving it is not this
 * script's business.
 *
 * The `'cutting'` enum value is left in the column. Removing a value from an
 * enum rewrites the table, and an unused value costs nothing; `init.sql` no
 * longer adds it, so a fresh database never gets one.
 *
 *   node scripts/drop-cutting-order.mjs           # dry run
 *   node scripts/drop-cutting-order.mjs --apply
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

const APPLY = process.argv.includes('--apply');
const COMPANY = 30005;

const conn = await pool.getConnection();
try {
  if (APPLY) await conn.beginTransaction();

  const [orders] = await conn.query(
    `SELECT id, order_number AS num, source_order_id AS salesOrderId
       FROM fab_orders
      WHERE company_id = ? AND order_type = 'cutting' AND deleted_at IS NULL`,
    [COMPANY],
  );
  console.log(`CUTTING ORDERS — ${orders.length}\n`);

  for (const o of orders) {
    const [[rows]] = await conn.query(
      `SELECT COUNT(*) n FROM fab_items
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`, [COMPANY, o.id]);
    const [[tasks]] = await conn.query(
      `SELECT COUNT(*) n FROM fab_project_tasks
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`, [COMPANY, o.id]);
    const [[started]] = await conn.query(
      `SELECT COUNT(*) n FROM fab_project_tasks
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
          AND (started_at IS NOT NULL OR status IN ('in_progress','paused','done'))`,
      [COMPANY, o.id]);

    console.log(`  ${o.num}  ${rows.n} rows, ${tasks.n} tasks, ${started.n} started`);
    if (Number(started.n) > 0) {
      throw new Error(
        `${o.num} has ${started.n} started task(s). That is shop-floor history — `
        + 'moving it is not this script\'s business. Stop and decide by hand.');
    }
    if (!APPLY) continue;

    await conn.query(
      `UPDATE fab_project_tasks SET deleted_at = NOW()
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`, [COMPANY, o.id]);
    await conn.query(
      `UPDATE fab_task_inputs SET deleted_at = NOW()
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`, [COMPANY, o.id]);
    await conn.query(
      `UPDATE fab_items SET deleted_at = NOW()
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`, [COMPANY, o.id]);
    await conn.query(
      `UPDATE fab_orders SET deleted_at = NOW() WHERE company_id = ? AND id = ?`, [COMPANY, o.id]);
    console.log(`    removed.`);
  }

  if (APPLY) { await conn.commit(); console.log('\nCommitted.'); }
  else console.log('\nDRY RUN — nothing was written. Re-run with --apply.');
} catch (err) {
  if (APPLY) await conn.rollback();
  throw err;
} finally {
  conn.release();
  await pool.end();
}
