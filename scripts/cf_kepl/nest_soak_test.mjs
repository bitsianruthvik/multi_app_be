/**
 * nest_soak_test.mjs — A FULL-LENGTH NESTING RUN, IN REAL TIME. OPT-IN: it does nothing unless
 * NEST_SOAK=1 (a default run of the suites must not take five minutes).
 *
 *   cd multi_app_be && NEST_SOAK=1 node scripts/cf_kepl/nest_soak_test.mjs          # Quick: 5 minutes
 *   NEST_SOAK=1 SOAK_EFFORT=deep node scripts/cf_kepl/nest_soak_test.mjs            # Deep: 20 minutes
 *   NEST_SOAK=1 SOAK_EFFORT=long CF_NEST_MEMORY_MB=512 node scripts/cf_kepl/nest_soak_test.mjs
 *        # THE PRODUCTION PROFILE: an hour, on what a 512 MB instance is given — ONE worker with a
 *        # ~150 MB heap (lib/packerPool reads CF_NEST_MEMORY_MB as it reads the container's limit).
 *        # Then the memory must stay under 400 MB. (A tenth of a CPU cannot be imitated here; the
 *        # search's stopping rules are counted in rebuilds, so a slower box only does fewer.)
 *
 * A line the size of the KEPL bridge order (lib/nestScaleFixture.mjs — its own data, one
 * transaction, rolled back) is nested by a BACKGROUND RUN (nestRunService.startRun, the real
 * worker pool) for the level's whole budget. Meanwhile, as a page and a load balancer would:
 *   - the run is polled every second (its best-so-far figure → the IMPROVEMENT CURVE printed at the end);
 *   - GET /api/x/cf_erp/health is fetched over real HTTP every second, and its slowest answer kept;
 *   - the event loop's longest stretch and the process's peak memory are measured.
 * Asserted: the run ends inside its budget (+10 %) with every piece placed; the layout only ever
 * gets better; it is never worse than the row packer; health always answers (≤ 1 s) and the event
 * loop is never held (≤ 250 ms); memory stays under 1 GB.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';

if (process.env.NEST_SOAK !== '1') {
  console.log('nest_soak_test: skipped (opt-in — set NEST_SOAK=1; it runs a bridge-size line for the full budget, 5 minutes at Quick).');
  console.log('\n0 passed, 0 failed');
  process.exit(0);
}

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { default: express } = await import('express');
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const N = await imp('apps/cf_erp/services/nestingService.js');
const R = await imp('apps/cf_erp/services/nestRunService.js');
const { default: cfApp } = await imp('apps/cf_erp/app.js');
const { buildScaleFixture } = await imp('scripts/cf_kepl/lib/nestScaleFixture.mjs');

const COMPANY = Number(process.env.CF_NEST_COMPANY ?? 2);
const EFFORT = ['quick', 'standard', 'deep', 'long'].includes(process.env.SOAK_EFFORT) ? process.env.SOAK_EFFORT : 'quick';
const PROFILE_MB = Number(process.env.CF_NEST_MEMORY_MB) || null;
const MEMORY_LIMIT_MB = PROFILE_MB ? 400 : 1024;
const tag = `SK${Date.now().toString(36).toUpperCase()}`;
delete process.env.CF_NEST_BUDGET_SCALE;              // real time

let passed = 0; let failed = 0;
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || typeof cond !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 500)}` : ''}`); }
}
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

const app = express();
app.use(express.json({ limit: '50mb' }));
cfApp.register(app);
const server = await new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
const base = `http://127.0.0.1:${server.address().port}/api/x/cf_erp`;

const conn = await pool.getConnection();
const c = { companyId: COMPANY, userId: null, userName: 'nest soak' };
try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const fx = await buildScaleFixture(conn, { company: COMPANY, tag });
  console.log(`\n${tag}: line ${fx.lineId} — ${fx.pieces} pieces of ${fx.parts.length} cut plates (${fx.drawn} drawn), ${fx.groups.length} thicknesses. ${EFFORT}: up to ${N.runBudgetMs(EFFORT) / 60000} minutes.`);
  const rows = await N.planNesting(conn, COMPANY, fx.lineId, { effort: 'quick', seed: 1, shapes: false });
  console.log(`the row packer alone: ${rows.totals.plates} plates, ${(rows.totals.areaBought / 1e6).toFixed(1)} m² bought`);

  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
  let peak = 0; let slowestHealth = 0; let healthFails = 0; let healthCalls = 0; let ckMax = 0;
  const mem = setInterval(() => { const r = process.memoryUsage().rss; if (r > peak) peak = r; }, 100);
  const snap0 = R.startRun(COMPANY, c, fx.lineId, { effort: EFFORT, seed: 1 }, { db: conn });
  let snap = snap0;
  while (snap.status === 'running') {
    await wait(1000);
    const t = Date.now();
    try { const r = await fetch(`${base}/health`); if (!r.ok) healthFails += 1; await r.text(); } catch { healthFails += 1; }
    healthCalls += 1;
    slowestHealth = Math.max(slowestHealth, Date.now() - t);
    snap = R.memoryRun(COMPANY, fx.lineId) ? R.snapshot(R.memoryRun(COMPANY, fx.lineId)) : snap;
    if (snap.progress.checkpointBytes) { ckMax = Math.max(ckMax, snap.progress.checkpointBytes); }
    if (healthCalls % (EFFORT === 'long' ? 300 : 30) === 0) console.log(`  … ${Math.round(snap.elapsedMs / 1000)} s of ${Math.round(snap.budgetMs / 1000)}: ${snap.progress.best ? `${snap.progress.best.plates} plates, ${snap.progress.best.wastePct}% waste` : 'no figure yet'} (jobs ${snap.progress.done}/${snap.progress.total})`);
  }
  clearInterval(mem); lag.disable();
  await R.settleRuns();
  const done = R.snapshot(R.memoryRun(COMPANY, fx.lineId), { withPlan: true });
  const plan = done.plan;
  const curve = done.progress.curve;

  console.log('\nIMPROVEMENT CURVE (best layout of the whole line so far)');
  console.log('  at        plates   bought m²   waste %');
  for (const pt of curve) console.log(`  ${`${(pt.atMs / 1000).toFixed(1)} s`.padEnd(9)} ${String(pt.plates).padEnd(8)} ${String(pt.areaBoughtM2).padEnd(11)} ${pt.wastePct}`);
  console.log(`  final     ${plan.totals.plates} plates, ${(plan.totals.areaBought / 1e6).toFixed(3)} m², waste ${plan.totals.wastePct}% (by weight ${((1 - plan.totals.partsKg / plan.totals.weightKg) * 100).toFixed(2)}%)`);
  console.log(`  run: ${done.elapsedMs} ms of ${done.budgetMs}; workers ${plan.budget.workers}; jobs ${plan.budget.jobsRun}/${plan.budget.jobs} (skipped for time ${plan.budget.seedsSkippedForTime}); clock-cut ${plan.budget.jobsCapped}`);
  console.log(`  peak memory ${Math.round(peak / 1048576)} MB · event loop longest stretch ${Math.round(lag.max / 1e6)} ms (p99 ${Math.round(lag.percentile(99) / 1e6)} ms) · health: ${healthCalls} calls, slowest ${slowestHealth} ms, failed ${healthFails}`);
  console.log(`  checkpoints: largest ${(ckMax / 1024).toFixed(0)} kB as stored${PROFILE_MB ? ` · profile: ${PROFILE_MB} MB instance` : ''}`);
  console.log(`  layouts kept: ${plan.groups.map((g) => `${g.thickness}:${g.shapes?.taken ?? '-'}`).join('  ')}\n`);

  ok('the run finished, a whole proposal', done.status === 'done' && plan.totals.unplaced === 0 && plan.groups.flatMap((g) => g.nests).reduce((a, n) => a + n.pieces.length, 0) === fx.pieces, JSON.stringify([done.status, done.error]));
  ok(`inside its budget (+10 %): ${done.elapsedMs} ms of ${done.budgetMs}`, done.elapsedMs <= done.budgetMs * 1.1);
  ok(`the layout only ever got better (${curve.length} points)`, curve.length >= 2 && curve.every((pt, i) => i === 0 || pt.unplaced < curve[i - 1].unplaced || (pt.unplaced === curve[i - 1].unplaced && pt.areaBoughtM2 <= curve[i - 1].areaBoughtM2 + 1e-9)));
  ok(`never worse than the row packer: ${plan.totals.plates} plates against ${rows.totals.plates}`, plan.totals.plates <= rows.totals.plates && plan.totals.areaBought <= rows.totals.areaBought + 1e-6);
  ok(`it kept finding better layouts late: the last improvement came at ${(curve.at(-1).atMs / 1000).toFixed(0)} s`, curve.at(-1).atMs >= Math.min(60_000, done.budgetMs * 0.2));
  ok(`health answered every second, never slower than 1 s (slowest ${slowestHealth} ms)`, healthFails === 0 && slowestHealth <= 1000);
  ok(`the event loop was never held (longest stretch ${Math.round(lag.max / 1e6)} ms)`, lag.max / 1e6 <= 250);
  ok(`memory stayed under ${MEMORY_LIMIT_MB} MB (peak ${Math.round(peak / 1048576)} MB with ${plan.budget.workers} worker${plan.budget.workers === 1 ? '' : 's'})`, peak < MEMORY_LIMIT_MB * 1048576);
  if (PROFILE_MB) ok('on that profile the pool ran ONE worker', plan.budget.workers === 1);
  ok(`its checkpoints stayed small (largest ${(ckMax / 1024).toFixed(0)} kB — a row may be 6 MB)`, ckMax > 0 && ckMax < 1024 * 1024);
} catch (err) {
  failed += 1;
  console.error('\nERROR', err);
} finally {
  await R.settleRuns().catch(() => {});
  try { await conn.rollback(); } catch { /* the original error is the one that matters */ }
  detachNodeCache(conn);
  conn.release();
  await new Promise((resolve) => { server.close(resolve); });
}
console.log(`\n${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : 0);
