/**
 * accept-run.mjs — ACCEPT A FINISHED NESTING RUN ON ITS LINE, as the Nesting screen's "Accept" does
 * (POST …/nesting/accept with the run's plan, then the run is taken off the poll). For a run made on another machine
 * by nest-line.mjs: the layout becomes the line's saved nesting — its plates, placements, cuts and the plate lines
 * of its cut pieces — exactly as the server's own accept writes them (nestingService.acceptNesting verifies every plate).
 *
 *   node scripts/cf_kepl/accept-run.mjs --company 30005 --order SO260018 --line 1 --run <run uid> [--prod]            dry run
 *   node scripts/cf_kepl/accept-run.mjs --company 30005 --order SO260018 --line 1 --run <run uid> [--prod] --apply    saves
 * It goes through plateChangeGate like the route, so a line whose plates a purchase order already covers is refused
 * (or becomes a change request) the same way.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const argv = process.argv;
const arg = (k) => { const i = argv.indexOf(`--${k}`); return i > 0 ? argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const ORDER = arg('order');
const LINE_NO = Number(arg('line') ?? 1);
const RUN = arg('run');
const APPLY = argv.includes('--apply');
if (!COMPANY || !ORDER || !RUN) { console.error('Usage: --company <id> --order <code> [--line <no>] --run <uid> [--prod] [--apply]'); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
if (argv.includes('--prod')) {
  const env = {}; fs.readFileSync(path.join(here, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => { l = l.trim(); if (!l || l.startsWith('#')) return; const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim(); });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const imp = (p) => import(pathToFileURL(path.join(here, '..', '..', p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { acceptNesting, getNesting } = await imp('apps/cf_erp/services/nestingService.js');
const { unpackPlan } = await imp('apps/cf_erp/services/nestRunService.js');
const { plateChangeGate } = await imp('apps/cf_erp/services/plateChangeService.js').catch(() => ({ plateChangeGate: null }));

const db = await pool.getConnection();
try {
  const [[line]] = await db.query(
    `SELECT l.id, l.line_no, o.code FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
      WHERE l.company_id = ? AND o.code = ? AND l.line_no = ? AND l.deleted_at IS NULL`, [COMPANY, ORDER, LINE_NO]);
  if (!line) throw new Error(`No line ${LINE_NO} on ${ORDER}.`);
  const [[run]] = await db.query("SELECT id, status, plan_json, plan_encoding FROM cf_nest_runs WHERE company_id = ? AND order_line_id = ? AND run_uid = ? AND deleted_at IS NULL", [COMPANY, line.id, RUN]);
  if (!run) throw new Error(`Run ${RUN} is not on ${ORDER} line ${LINE_NO}.`);
  if (run.status !== 'ready') throw new Error(`Run ${RUN} is ${run.status}, not a finished run.`);
  const plan = unpackPlan(run.plan_json, run.plan_encoding)?.plan;
  if (!plan) throw new Error('The run holds no plan.');
  const [[admin]] = await db.query("SELECT id, name FROM users WHERE company_id = ? AND email LIKE 'admin@%' ORDER BY id LIMIT 1", [COMPANY]);
  const c = { companyId: COMPANY, userId: admin?.id ?? null, userName: admin?.name ?? 'accept-run' };
  await db.beginTransaction();
  const out = plateChangeGate
    ? await plateChangeGate(db, c, line.id, 'accept', plan, (b) => acceptNesting(db, c, line.id, b))
    : await acceptNesting(db, c, line.id, plan);
  if (out?.requested) throw new Error('A purchase order covers this line\'s plates: the accept became a change request — decide it on the screen.');
  await db.query('UPDATE cf_nest_runs SET dismissed_at = NOW() WHERE company_id = ? AND id = ? AND dismissed_at IS NULL', [COMPANY, run.id]);
  const saved = await getNesting(db, COMPANY, line.id);
  console.log(`${ORDER} line ${LINE_NO}: ${out?.lots ?? '?'} plates, ${out?.pieces ?? '?'} pieces saved (replaced ${out?.replacedLots ?? 0}); the line now reads: ${JSON.stringify(saved.totals)}`);
  if (APPLY) { await db.commit(); console.log('SAVED — the nesting is on the line.'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to save.'); }
} catch (e) {
  try { await db.rollback(); } catch { /* none */ }
  console.error('FAILED (rolled back):', e.message, e.problems ? JSON.stringify(e.problems).slice(0, 800) : ''); process.exitCode = 1;
} finally { db.release(); await pool.end(); process.exit(process.exitCode ?? 0); }
