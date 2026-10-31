/**
 * save-line-standard.mjs — save an order line's BOM, values and drawings as the NEXT version of its standard (the
 * screen's "Save to the standard"), e.g. after part revisions were loaded onto the line. DRY RUN BY DEFAULT (rolled back).
 *   node scripts/cf_kepl/save-line-standard.mjs --company 30005 --line <id> --note "<why>" --prod [--apply]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company')); const LINE = Number(arg('line')); const NOTE = arg('note') ?? null;
const APPLY = process.argv.includes('--apply');
if (!COMPANY || !LINE) { console.error('Usage: --company <id> --line <id> [--note <text>] [--prod] [--apply]'); process.exit(2); }
if (process.argv.includes('--prod')) {
  const env = {}; fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => { l = l.trim(); if (!l || l.startsWith('#')) return; const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim(); });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { saveLineToStandard } = await imp('apps/cf_erp/services/standardDrawingService.js');
const db = await pool.getConnection();
try {
  const [[admin]] = await db.query("SELECT id FROM users WHERE company_id = ? AND email LIKE 'admin@%' ORDER BY id LIMIT 1", [COMPANY]);
  await db.beginTransaction();
  const r = await saveLineToStandard(db, { companyId: COMPANY, userId: admin.id }, LINE, { note: NOTE });
  console.log(`${APPLY ? 'saved' : 'would save (rolled back)'} ${JSON.stringify(r.saved)}`);
  if (APPLY) await db.commit(); else await db.rollback();
} catch (e) { try { await db.rollback(); } catch { /* none */ } console.error('FAILED (rolled back):', e.message); process.exitCode = 1; } finally { db.release(); await pool.end(); process.exit(process.exitCode ?? 0); }
