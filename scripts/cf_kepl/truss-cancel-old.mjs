/**
 * truss-cancel-old.mjs — user 2026-10-31: "Cancel SO260016 and redo it with real gusset shapes". Cancels the first
 * truss order (setOrderStatus → cancelled, as the screen does) and retires its standard EB427-NEC-TCR-DW-3451B
 * (#6150003, soft delete, its 3D model with it) so the corrected import takes the number. One transaction; dry run
 * by default, --apply commits.   node scripts/cf_kepl/truss-cancel-old.mjs --prod [--apply]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
if (process.argv.includes('--prod')) {
  const env = {}; fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => { l = l.trim(); if (!l || l.startsWith('#')) return; const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim(); });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { setOrderStatus } = await imp('apps/cf_erp/services/salesOrderService.js');
const COMPANY = 30005; const ORDER = 930004; const STD = 6150003;
const db = await pool.getConnection();
try {
  const [[admin]] = await db.query("SELECT id FROM users WHERE company_id = ? AND email LIKE 'admin@%' ORDER BY id LIMIT 1", [COMPANY]);
  const c = { companyId: COMPANY, userId: admin.id };
  await db.beginTransaction();
  const [[o]] = await db.query('SELECT code, status FROM cf_sales_orders WHERE company_id = ? AND id = ?', [COMPANY, ORDER]);
  if (o.code !== 'SO260016') throw new Error(`Order ${ORDER} is ${o.code}, not SO260016.`);
  await setOrderStatus(db, c, ORDER, 'cancelled', { fromRoute: true });
  const [[o2]] = await db.query('SELECT status FROM cf_sales_orders WHERE id = ?', [ORDER]);
  const [s] = await db.query('UPDATE cf_standard_drawings SET deleted_at = NOW() WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [COMPANY, STD]);
  const [f] = await db.query("UPDATE cf_standard_drawing_files SET deleted_at = NOW() WHERE company_id = ? AND standard_id = ? AND kind = 'model' AND deleted_at IS NULL", [COMPANY, STD]);
  console.log(`SO260016: ${o.status} → ${o2.status}; standard #${STD} retired (${s.affectedRows}); models off (${f.affectedRows})`);
  if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('Dry run — rolled back.'); }
} catch (e) { try { await db.rollback(); } catch { /* none */ } console.error('FAILED (rolled back):', e.message); process.exitCode = 1; } finally { db.release(); await pool.end(); process.exit(process.exitCode ?? 0); }
