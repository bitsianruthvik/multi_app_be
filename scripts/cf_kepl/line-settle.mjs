/**
 * line-settle.mjs — does once, outside the browser, what the Structure step does the first time an order line is opened
 * (salesOrderService.lineStructure: the automatic choices of its selection rows, then the values those choices change, worked
 * out record by record: valueService.refreshValues). On a large imported line that is thousands of round trips: the NRE foot
 * bridge span (362 rows) took 434 s and 2,987 round trips on TiDB, the Raghava 52 m span about 33 s, both past the browser's
 * 30 s limit, so the page said "The server took too long to answer" (2026-11-16).
 *
 * Run it LAST after loading a line by script (standard-import → girder-order → model3d-attach → bolts-load → physics-attach).
 * A line with nothing left to choose takes a second (11 round trips), so it is safe to run on every line and to run again.
 * DRY RUN BY DEFAULT (the work is done and rolled back, so the time printed is the real one); --apply commits one line at a time.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/line-settle.mjs --company 30005 --line 1410005,1410007 --prod [--apply]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company')); const LINES = String(arg('line') ?? '').split(',').map(Number).filter(Boolean);
const APPLY = process.argv.includes('--apply');
if (!COMPANY || !LINES.length) { console.error('Usage: --company <id> --line <id,id> [--prod] [--apply]'); process.exit(2); }
if (process.argv.includes('--prod')) {
  const env = {};
  fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
    l = l.trim(); if (!l || l.startsWith('#')) return;
    const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
  });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { lineStructure } = await imp('apps/cf_erp/services/salesOrderService.js');
try {
  const [[user]] = await pool.query("SELECT id FROM users WHERE company_id = ? ORDER BY (email LIKE 'admin@%') DESC, id LIMIT 1", [COMPANY]);
  const where = process.env.DB_HOST && !/^(localhost|127\.0\.0\.1)$/.test(process.env.DB_HOST) ? 'PRODUCTION' : 'local';
  console.log(`${where} — company ${COMPANY} — ${APPLY ? 'APPLY' : 'DRY RUN (rolled back)'}`);
  for (const lineId of LINES) {
    const db = await pool.getConnection(); let n = 0; const q0 = db.query.bind(db); db.query = (...a) => { n += 1; return q0(...a); };
    const t = Date.now();
    try {
      await db.beginTransaction();
      await lineStructure(db, COMPANY, lineId, { c: { companyId: COMPANY, userId: user.id } });
      if (APPLY) await db.commit(); else await db.rollback();
      console.log(`line ${lineId}: ${Math.round((Date.now() - t) / 1000)} s, ${n} round trips${n <= 15 ? ' (nothing was left to work out)' : ''}`);
    } catch (e) {
      try { await db.rollback(); } catch { /* none */ }
      console.log(`line ${lineId}: FAILED after ${Math.round((Date.now() - t) / 1000)} s (rolled back): ${e.message}`); process.exitCode = 1;
    } finally { db.release(); }
  }
} finally { await pool.end(); }
