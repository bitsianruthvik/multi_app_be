/**
 * stores-kept-zero.mjs — the store keeps these items though none is on the shelf now (user, 2026-11-23: the monthly audit
 * lists zeros too). It lists every item with a balance row in the area, so an item the stores ledger names at zero gets a
 * balance row of 0 there (no lot, no movement — nothing moves). Re-running skips items that already have a row.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/stores-kept-zero.mjs --company 30005 --prod --area 60001 --codes <codes.json> [--apply]
 * DRY RUN BY DEFAULT. To undo: DELETE the rows with quantity 0, last_movement_id NULL and the item codes listed.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company')); const AREA = Number(arg('area'));
const APPLY = process.argv.includes('--apply');
if (!COMPANY || !AREA || !arg('codes')) { console.error('Usage: --company <id> [--prod] --area <id> --codes codes.json [--apply]'); process.exit(2); }
if (process.argv.includes('--prod')) {
  const env = {};
  fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
    l = l.trim(); if (!l || l.startsWith('#')) return;
    const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
  });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const { pool } = await import(pathToFileURL(path.join(__dir, '..', '..', 'db.js')).href);
const codes = JSON.parse(fs.readFileSync(arg('codes'), 'utf8'));
const where = process.env.DB_HOST && !/^(localhost|127\.0\.0\.1)$/.test(process.env.DB_HOST) ? 'PRODUCTION DB' : 'local';
const db = await pool.getConnection();
try {
  const [[area]] = await db.query('SELECT id, name FROM cf_stocking_areas WHERE company_id = ? AND id = ?', [COMPANY, AREA]);
  if (!area) throw new Error(`area ${AREA} is not in company ${COMPANY}`);
  console.log(`${where} — company ${COMPANY} — ${area.name} — ${APPLY ? 'APPLY' : 'DRY RUN (rolled back)'} — ${codes.length} codes`);
  await db.beginTransaction();
  const [items] = await db.query(
    `SELECT m.id, m.code, EXISTS (SELECT 1 FROM cf_stock_balances k WHERE k.company_id = m.company_id AND k.item_id = m.id AND k.stocking_area_id = ?) AS has_row
       FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'catalog'
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.code IN (?)`, [AREA, COMPANY, codes]);
  const found = new Set(items.map((r) => r.code));
  const missing = codes.filter((c) => !found.has(c));
  const add = items.filter((r) => !Number(r.has_row));
  if (add.length) {
    await db.query(`INSERT INTO cf_stock_balances (company_id, stocking_area_id, item_id, batch_id, quantity) VALUES ${add.map(() => '(?, ?, ?, NULL, 0)').join(', ')}`,
      add.flatMap((r) => [COMPANY, AREA, r.id]));
  }
  if (APPLY) await db.commit(); else await db.rollback();
  console.log(`zero rows added ${add.length}; already had a row ${items.length - add.length}; codes not found ${missing.length}${missing.length ? ` (${missing.slice(0, 10).join(', ')})` : ''}`);
} catch (e) { try { await db.rollback(); } catch { /* */ } console.error('FAILED —', e.message); process.exitCode = 1; } finally { db.release(); await pool.end(); }
