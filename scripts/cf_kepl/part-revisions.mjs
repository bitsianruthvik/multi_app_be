/**
 * part-revisions.mjs — load a folder of part DXFs onto an order line as the NEXT revision of each part's drawing (by the
 * drawing mark in the file name: `JL2A-GP_32mm_E350.dxf` → JL2A-GP), through uploadDrawings like the screen's upload.
 * Batches of 20, one transaction each. DRY RUN BY DEFAULT (the first batch, rolled back); --apply saves.
 *   node scripts/cf_kepl/part-revisions.mjs --company 30005 --order <id> --line <id> --dir <folder> --prod [--apply]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company')); const ORDER = Number(arg('order')); const LINE = Number(arg('line')); const DIR = path.resolve(arg('dir') ?? '');
const APPLY = process.argv.includes('--apply');
if (process.argv.includes('--prod')) {
  const env = {}; fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => { l = l.trim(); if (!l || l.startsWith('#')) return; const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim(); });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { uploadDrawings } = await imp('apps/cf_erp/services/partDrawingService.js');
const files = fs.readdirSync(DIR).filter((f) => /\.dxf$/i.test(f)).sort();
const db = await pool.getConnection();
const st = {};
try {
  const [[admin]] = await db.query("SELECT id FROM users WHERE company_id = ? AND email LIKE 'admin@%' ORDER BY id LIMIT 1", [COMPANY]);
  const c = { companyId: COMPANY, userId: admin.id };
  console.log(`${files.length} files → order ${ORDER} line ${LINE} — ${APPLY ? 'APPLY' : 'DRY RUN (first batch, rolled back)'}`);
  for (let i = 0; i < files.length; i += 20) {
    const batch = files.slice(i, i + 20).map((f) => ({ name: f, content: fs.readFileSync(path.join(DIR, f)).toString('base64') }));
    await db.beginTransaction();
    const up = await uploadDrawings(db, c, ORDER, LINE, { files: batch, dryRun: false });
    for (const x of up.files ?? []) { st[x.status] = (st[x.status] ?? 0) + 1; if (!['new', 'replaces'].includes(x.status)) console.log(`  ${x.name}: ${x.status} ${(x.problems ?? []).join(' ')}`); }
    if (APPLY) await db.commit(); else { await db.rollback(); console.log(`  first batch: ${JSON.stringify(st)} — rolled back`); break; }
    console.log(`  ${Math.min(i + 20, files.length)}/${files.length} — ${JSON.stringify(st)}`);
  }
} catch (e) { try { await db.rollback(); } catch { /* none */ } console.error('FAILED (that batch rolled back):', e.message); process.exitCode = 1; } finally { db.release(); await pool.end(); process.exit(process.exitCode ?? 0); }
