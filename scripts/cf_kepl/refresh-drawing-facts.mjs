/**
 * refresh-drawing-facts.mjs — work a line's drawing facts out again (TRUE_AREA, DRAWN_HOLES, DRAWN_HOLE_DIA → weights,
 * areas and every roll-up above them), e.g. after the drawing-size rule changed (drawingValueService.sizeFit,
 * 2026-11-01). Frozen lines are left as they are by the service. DRY RUN BY DEFAULT (rolled back); --apply saves.
 *   node scripts/cf_kepl/refresh-drawing-facts.mjs --company 30005 --line <id> [--line <id> …] --prod [--apply]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv;
const COMPANY = Number(argv[argv.indexOf('--company') + 1]);
const LINES = argv.flatMap((a, i) => (a === '--line' ? [Number(argv[i + 1])] : [])).filter(Boolean);
const APPLY = argv.includes('--apply');
if (!COMPANY || !LINES.length) { console.error('Usage: --company <id> --line <id> [--line <id>] [--prod] [--apply]'); process.exit(2); }
if (argv.includes('--prod')) {
  const env = {}; fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => { l = l.trim(); if (!l || l.startsWith('#')) return; const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim(); });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { refreshDrawingValues, readFactInputs, planFacts } = await imp('apps/cf_erp/services/drawingValueService.js');
const db = await pool.getConnection();
try {
  const [[admin]] = await db.query("SELECT id FROM users WHERE company_id = ? AND email LIKE 'admin@%' ORDER BY id LIMIT 1", [COMPANY]);
  const c = { companyId: COMPANY, userId: admin.id };
  for (const line of LINES) {
    const before = await readFactInputs(db, COMPANY, line);
    const plan = planFacts(before.rows, before.drawings);
    const missing = before.rows.filter((r) => r.isPlatePart && plan.has(r.id) && !(r.held?.get?.('TRUE_AREA') > 0)).length;
    const differs = [...plan.values()].filter((f) => f.sizeDiffers).length;
    await db.beginTransaction();
    const out = await refreshDrawingValues(db, c, line, { force: true });
    console.log(`line ${line}: ${plan.size} rows take their drawing (${missing} newly, ${differs} with a size difference said) — ${JSON.stringify(out ?? {}).slice(0, 200)} — ${APPLY ? 'saved' : 'DRY RUN, rolled back'}`);
    if (APPLY) await db.commit(); else await db.rollback();
  }
} catch (e) { try { await db.rollback(); } catch { /* none */ } console.error('FAILED (rolled back):', e.message); process.exitCode = 1; } finally { db.release(); await pool.end(); process.exit(process.exitCode ?? 0); }
