/**
 * truss-values.mjs — the required values the Thane truss drawings settle, written into an order line's empty cells
 * through the Values stage's own writer (writeLineValues): IMPACT_CLASS BO (GA note 4, "E350 BO"), HOLE_DIA 26.5 (note 19,
 * M24 HSFG in 26.5 holes), and on the bottom lateral bracing rows MIG weld 10 mm (note 9) × 3.2 m (spades slotted 400
 * into each pipe end, 4 welds × 2 ends) and surface area 10.99 m² (π × 0.324 × 10.8). Coats are left for the coating
 * system. Dry run by default; --apply saves.   node scripts/cf_kepl/truss-values.mjs --line <id> --prod [--apply]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply'); const LINE = Number(arg('line')); const COMPANY = Number(arg('company') ?? 30005);
if (process.argv.includes('--prod')) {
  const env = {}; fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => { l = l.trim(); if (!l || l.startsWith('#')) return; const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim(); });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { readLineValues, writeLineValues } = await imp('apps/cf_erp/services/orderValuesService.js');
const FILL = { IMPACT_CLASS: 'BO', HOLE_DIA: 26.5, MIG_WELD_SIZE: 10, MIG_WELD_LENGTH: 3.2, SURFACE_AREA: 10.99 };
const missing = async () => {
  const v = await readLineValues(pool, COMPANY, LINE); const m = {}; const writes = [];
  for (const g of v.groups ?? []) { if (!g.own) continue; for (const r of g.rows) for (const [spec, cell] of Object.entries(r.cells ?? {})) if (cell.missing) {
    m[spec] = (m[spec] ?? 0) + 1;
    if (FILL[spec] != null) writes.push({ recordId: r.recordId ?? r.id, specCode: spec, value: FILL[spec] });
  } }
  return { m, writes };
};
const { m, writes } = await missing();
console.log('missing before', JSON.stringify(m), `— ${writes.length} to write`);
const db = await pool.getConnection();
try {
  const [[admin]] = await db.query("SELECT id FROM users WHERE company_id = ? AND email LIKE 'admin@%' ORDER BY id LIMIT 1", [COMPANY]);
  await db.beginTransaction();
  const out = await writeLineValues(db, { companyId: COMPANY, userId: admin.id }, LINE, { writes, dryRun: !APPLY });
  await db.commit();
  console.log(out.sentence ?? JSON.stringify(out.counts));
} catch (e) { try { await db.rollback(); } catch { /* none */ } console.error('FAILED', e.message, JSON.stringify(e.problems ?? e.detail?.problems ?? '').slice(0, 500)); process.exitCode = 1; } finally { db.release(); }
if (APPLY) console.log('missing after', JSON.stringify((await missing()).m));
await pool.end();
