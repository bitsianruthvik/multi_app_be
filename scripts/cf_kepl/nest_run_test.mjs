/**
 * nest_run_test.mjs — a nesting run that outlives the page, with a budget, a progress curve,
 * "stop and use this" and cancel (services/nestRunService.js, lib/packerPool.js, planNesting).
 *
 *   cd multi_app_be && node scripts/cf_kepl/nest_run_test.mjs
 *   CF_RUN_LINE=923 (default; company 2, a frozen line — the local KEPL copy)
 *
 * THE BUDGETS ARE 5, 10 AND 20 MINUTES (nestingService.NEST_BUDGET_MS). This suite runs them
 * SCALED — CF_NEST_BUDGET_SCALE, set here before anything is asked — so "five minutes" is twelve
 * seconds and the suite takes about a minute. Everything else is real: the real line, the real
 * worker pool, the real packers. (The full-length run is nest_soak_test.mjs, opt-in.)
 *
 *   1. the budgets themselves, and that a plan made inside a request gets the short one
 *   2. a run: running at once, the SAME run on a second start, progress that only goes up, the
 *      best-so-far figure and its curve, back inside the budget, the proposal only when asked
 *   3. the server answers while it runs: the event loop is never held, a database round trip is quick
 *   4. STOP AND USE THIS: the run ends in seconds, `done`, with a whole proposal
 *   5. CANCEL: forgotten at once, its row gone, a new run starts straight away
 *   6. a SMALL line at the Deep level (twenty minutes allowed) answers in seconds — the early stop
 *   7. a refusal arrives as a failed run, in the service's words
 * planNesting writes nothing and every run's row is deleted again: the cf_ tables are re-counted.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import { startRun as startRunReal, currentRun, dismissRun, stopRun, cancelRun, settleRuns, memoryRun } from '../../apps/cf_erp/services/nestRunService.js';
import { NEST_BUDGET_MS, SYNC_PLAN_BUDGET_MS, runBudgetMs, syncBudgetMs, planNesting } from '../../apps/cf_erp/services/nestingService.js';
import { buildFixture } from './lib/nestV2Fixture.mjs';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = 2;
const LINE = Number(process.env.CF_RUN_LINE ?? 923);
const SCALE = 0.04;                                   // 5 min → 12 s, 10 min → 24 s

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${String(detail).slice(0, 500)}` : ''}`);
  condition ? passed++ : failed++;
}
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const section = (s) => console.log(`\n${s}`);
const J = (v) => JSON.stringify(v);

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
// Only the runs THIS suite starts are looked at and removed: the line may hold other people's.
const started = [];
const startRun = (...a) => { const snap = startRunReal(...a); if (snap.runId && !started.includes(snap.runId)) started.push(snap.runId); return snap; };
const runRows = async () => (started.length ? (await pool.query('SELECT run_uid, status FROM cf_nest_runs WHERE company_id = ? AND run_uid IN (?)', [COMPANY, started]))[0] : []);
const dropMine = async () => { if (started.length) await pool.query('DELETE FROM cf_nest_runs WHERE company_id = ? AND run_uid IN (?)', [COMPANY, started]); };
const untilDone = async (line, ms = 120_000) => { const t0 = Date.now(); let s = currentRun(COMPANY, line); while (s.status === 'running' && Date.now() - t0 < ms) { await wait(200); s = currentRun(COMPANY, line); } return s; };

try {
  const c = { companyId: COMPANY, userId: null, userName: 'test' };

  section('1. The budgets');
  delete process.env.CF_NEST_BUDGET_SCALE;
  ok('Quick is 5 minutes, Standard ("normal") 10, Deep 20, Long 60 — for the whole run', NEST_BUDGET_MS.quick === 300_000 && NEST_BUDGET_MS.standard === 600_000 && NEST_BUDGET_MS.deep === 1_200_000 && NEST_BUDGET_MS.long === 3_600_000 && runBudgetMs('long') === 3_600_000
    && runBudgetMs('quick') === 300_000 && runBudgetMs('standard') === 600_000 && runBudgetMs('normal') === 600_000 && runBudgetMs('deep') === 1_200_000);
  ok(`a plan made inside a request is held to ${SYNC_PLAN_BUDGET_MS / 1000} s at every level`, SYNC_PLAN_BUDGET_MS === 20_000 && ['quick', 'standard', 'deep'].every((e) => syncBudgetMs(e) === 20_000));
  process.env.CF_NEST_BUDGET_SCALE = String(SCALE);
  ok('the scale factor (tests only) scales all three', runBudgetMs('quick') === 12_000 && runBudgetMs('standard') === 24_000 && runBudgetMs('deep') === 48_000);

  section('2. A run on the real line: budget, progress, the best so far');
  const t0 = Date.now();
  const first = startRun(COMPANY, c, LINE, { effort: 'quick', seed: 3 });
  ok('start returns at once, running, with its budget', first.status === 'running' && Date.now() - t0 < 200 && first.budgetMs === 12_000 && first.canStop === true, J(first).slice(0, 200));
  const again = startRun(COMPANY, c, LINE, { effort: 'quick' });
  ok('a second start returns the SAME run, not a second one', again.runId === first.runId);
  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
  let last = first; let pctUp = true; let sawPacking = false; let sawBest = null; let slowest = 0;
  for (let i = 0; i < 600 && last.status === 'running'; i += 1) {
    await wait(250);
    const q0 = Date.now();
    await pool.query('SELECT 1');                     // what a health check or any other request costs meanwhile
    slowest = Math.max(slowest, Date.now() - q0);
    const now = currentRun(COMPANY, LINE);
    if (now.progress.pct < last.progress.pct) pctUp = false;
    if (now.phase === 'packing') sawPacking = true;
    if (now.status === 'running' && now.progress.best && !sawBest) sawBest = { ...now.progress.best, elapsedMs: now.elapsedMs };
    last = now;
  }
  lag.disable();
  ok('the run finished', last.status === 'done', J({ status: last.status, error: last.error }));
  ok(`inside its budget (+10 %): ${last.elapsedMs} ms of ${last.budgetMs}`, last.elapsedMs <= last.budgetMs * 1.1);
  ok('progress only went up, and ends at 100', pctUp && last.progress.pct === 100);
  ok('it was seen packing, with jobs counted', sawPacking && last.progress.total > 0 && last.progress.done === last.progress.total, J(last.progress));
  ok(`while it worked it said the best so far for the whole line (first: ${J(sawBest)})`, !!sawBest && sawBest.plates > 0 && sawBest.areaBoughtM2 > 0 && typeof sawBest.wastePct === 'number' && sawBest.unplaced === 0);
  const curve = last.progress.curve;
  const neverWorse = curve.every((pt, i) => i === 0 || pt.unplaced < curve[i - 1].unplaced || (pt.unplaced === curve[i - 1].unplaced && pt.areaBoughtM2 <= curve[i - 1].areaBoughtM2 + 1e-9));
  ok(`the improvement curve has ${curve.length} points, each no worse than the one before, times going up`, curve.length >= 1 && neverWorse && curve.every((pt, i) => i === 0 || pt.atMs >= curve[i - 1].atMs), J(curve.slice(0, 6)));
  console.log(`    curve: ${curve.map((pt) => `${(pt.atMs / 1000).toFixed(1)}s ${pt.plates}pl ${pt.wastePct}%`).join(' → ')}`);
  const texts = last.log.map((l) => l.text);
  ok('the log reads: started (with the budget), reading, steels, packing, tries, measuring, finished',
    /^Started \(quick effort, up to 12 s\)/.test(texts[0]) && texts.some((t) => /^Reading/.test(t)) && texts.some((t) => /steels?/.test(t)) && texts.some((t) => /^Packing/.test(t))
    && texts.some((t) => / — try \d+:/.test(t)) && texts.some((t) => /^Choosing/.test(t)) && texts.some((t) => /^Measuring/.test(t)) && /^Finished/.test(texts.at(-1)), J(texts.slice(0, 8)));
  console.log(`    (${texts.length} log lines, ${Math.round(last.elapsedMs / 1000)} s; last: ${texts.at(-1)})`);
  ok('no proposal unless asked for', last.plan === undefined);
  const withPlan = currentRun(COMPANY, LINE, { withPlan: true });
  ok('asked for, the proposal is there and is a plan', Array.isArray(withPlan.plan?.groups) && withPlan.plan.basis === 'proposal');
  ok('the summary agrees with the plan, and the last point of the curve is the plan', withPlan.summary.plates === withPlan.plan.totals.plates && (curve.at(-1).plates === withPlan.plan.totals.plates || withPlan.plan.imported.lots > 0), J([curve.at(-1), withPlan.plan.totals.plates]));
  ok('the plan says it was a background run with the whole budget, not stopped', withPlan.plan.budget.sync === false && withPlan.plan.budget.stopped === false && withPlan.plan.budget.capMs === 12_000, J(withPlan.plan.budget));
  ok('every steel went through the true-shape packer and says which layout it kept', withPlan.plan.groups.filter((g) => g.nests.length).every((g) => ['shape', 'rectangles'].includes(g.shapes?.taken)), J(withPlan.plan.groups.map((g) => g.shapes?.taken)));

  section('3. The server answers while a run works');
  ok(`the event loop was never held: longest stretch ${Math.round(lag.max / 1e6)} ms`, lag.max / 1e6 <= 250);
  ok(`a database round trip took at most ${slowest} ms meanwhile`, slowest <= 500);
  ok('dismiss forgets it', dismissRun(COMPANY, LINE).ok === true && currentRun(COMPANY, LINE).status === 'none');
  await settleRuns();
  ok('…and its row is deleted', !(await runRows()).some((r) => r.run_uid === first.runId));

  section('4. Stop and use this');
  const s1 = startRun(COMPANY, c, LINE, { effort: 'deep', seed: 1 });          // 48 s allowed
  for (let i = 0; i < 200 && !currentRun(COMPANY, LINE).progress.best; i += 1) await wait(100);
  const atStop = Date.now();
  const asked = stopRun(COMPANY, LINE, { purpose: 'nest' });
  ok('stop is taken while it works', asked.stopRequested === true && asked.canStop === false && asked.status === 'running', J([asked.status, asked.stopRequested]));
  const stopped = await untilDone(LINE, 30_000);
  const took = Date.now() - atStop;
  ok(`the run ends within seconds of the stop (${took} ms), long before its ${s1.budgetMs} ms`, stopped.status === 'done' && took <= 8_000 && stopped.elapsedMs < s1.budgetMs * 0.6, J([stopped.status, took, stopped.elapsedMs]));
  const sp = currentRun(COMPANY, LINE, { withPlan: true });
  const placedAll = sp.plan.groups.every((g) => g.unplaced.length === 0);
  ok('it is a WHOLE proposal — every steel has a layout, every piece a place — and says it was stopped', sp.stopped === true && sp.plan.budget.stopped === true && placedAll && sp.plan.totals.plates > 0 && /Stopped on request/.test(sp.log.map((l) => l.text).join('|')), J([sp.stopped, sp.plan.budget, sp.plan.totals.plates]));
  ok('…the same proposal the best-so-far figure promised, or better', sp.plan.totals.plates <= (stopped.progress.best?.plates ?? Infinity), J([sp.plan.totals.plates, stopped.progress.best]));
  await settleRuns();
  ok('its row is kept, ready (a stopped run is a run)', (await runRows()).some((r) => r.run_uid === s1.runId && r.status === 'ready'));
  dismissRun(COMPANY, LINE);
  await settleRuns();

  section('5. Cancel');
  const c1 = startRun(COMPANY, c, LINE, { effort: 'deep', seed: 1 });
  await wait(1500);
  const cancelled = cancelRun(COMPANY, LINE, { purpose: 'nest' });
  ok('cancel: the run is forgotten at once', cancelled.cancelled === true && cancelled.runId === c1.runId && currentRun(COMPANY, LINE).status === 'none' && memoryRun(COMPANY, LINE) === null);
  const c2 = startRun(COMPANY, c, LINE, { effort: 'quick', seed: 1 });
  ok('a new run starts straight away (it is another run)', c2.status === 'running' && c2.runId !== c1.runId);
  const d2 = await untilDone(LINE, 60_000);
  ok('…and finishes as usual, inside its own budget — the cancelled run\'s workers are not in its way', d2.status === 'done' && d2.elapsedMs <= d2.budgetMs * 1.1, J([d2.status, d2.elapsedMs, d2.budgetMs]));
  await settleRuns();
  const rowsNow = await runRows();
  ok('the cancelled run left no row; the new one has its own', !rowsNow.some((r) => r.run_uid === c1.runId) && rowsNow.some((r) => r.run_uid === c2.runId), J(rowsNow));
  const c3 = startRun(COMPANY, c, LINE, { effort: 'deep' });
  ok('dismissing (DELETE …/runs/current) a run that is still working cancels it', c3.status === 'running' && dismissRun(COMPANY, LINE).cancelled === true && currentRun(COMPANY, LINE).status === 'none');
  await settleRuns();
  await dropMine();

  section('6. A small line at the Deep level answers in seconds');
  delete process.env.CF_NEST_BUDGET_SCALE;            // the real twenty minutes
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction(); attachNodeCache(conn);
    const fx = await buildFixture(conn, { company: COMPANY });
    const tS = Date.now();
    const small = await planNesting(conn, COMPANY, fx.lineId, { effort: 'deep', seed: 1, background: true });
    const ms = Date.now() - tS;
    ok(`39 pieces, 20 minutes allowed: done in ${ms} ms, because nothing improved for the search's patience`, small.budget.capMs === 1_200_000 && ms < 60_000 && small.totals.unplaced === 0, J(small.budget));
    ok('…and the clock had no part in it: every steel\'s search ended by its own counted rule (the same answer on any machine)', small.budget.capped === false && small.groups.every((g) => g.deterministic !== false), J(small.groups.map((g) => g.deterministic)));
    const sync = await planNesting(conn, COMPANY, fx.lineId, { effort: 'deep', seed: 1 });
    ok('the same plan made inside a request has the short budget and says so', sync.budget.sync === true && sync.budget.capMs === SYNC_PLAN_BUDGET_MS, J(sync.budget));
  } finally { await conn.rollback(); detachNodeCache(conn); conn.release(); }
  process.env.CF_NEST_BUDGET_SCALE = String(SCALE);

  section('7. A refusal');
  startRun(COMPANY, c, 99999999, { effort: 'quick' });
  let bad = currentRun(COMPANY, 99999999);
  for (let i = 0; i < 40 && bad.status === 'running'; i += 1) { await wait(100); bad = currentRun(COMPANY, 99999999); }
  ok('a refusal arrives as a failed run, in the service\'s words', bad.status === 'failed' && /Order line/i.test(bad.error?.message ?? ''), J(bad.error));
  ok('...and its log says it stopped', /^Stopped:/.test(bad.log.at(-1)?.text ?? ''));
  dismissRun(COMPANY, 99999999);
  await settleRuns();
} catch (err) {
  failed++;
  console.error('\nERROR', err);
}

await settleRuns().catch(() => {});
await dropMine().catch(() => {});
const after = await counts();
const drift = after.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
ok('nothing is left behind: every cf_ table has the rows it had', drift.length === 0, drift.map((d) => `${d.name} ${before.find((b) => b.name === d.name)?.n}->${d.n}`).join(', '));
console.log(`\n${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : 0);
