/**
 * nest_run_test.mjs — a nesting run that outlives the page
 * (services/nestRunService.js, lib/packerPool.js onJob, planNesting onProgress).
 *
 *   cd multi_app_be && node scripts/cf_kepl/nest_run_test.mjs
 *   CF_RUN_LINE=923 (default; company 2, a frozen line)
 *
 * Starts a real run (quick effort, real worker pool) and polls it like the page
 * does: it is running at once and the start call returns before the plan; a
 * second start returns the SAME run; progress only goes up and the log names
 * the phases and the tries; done carries the proposal only when asked; dismiss
 * forgets it. Then a refusal (an unknown line) arrives as a FAILED run with the
 * service's own words. planNesting writes nothing, so nothing to roll back —
 * and the cf_ tables are re-counted to prove it.
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { startRun, currentRun, dismissRun } from '../../apps/cf_erp/services/nestRunService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = 2;
const LINE = Number(process.env.CF_RUN_LINE ?? 923);

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  condition ? passed++ : failed++;
}
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();

try {
  const c = { companyId: COMPANY, userId: null, userName: 'test' };
  const t0 = Date.now();
  const first = startRun(COMPANY, c, LINE, { effort: 'quick', seed: 3 });
  ok('start returns at once, running', first.status === 'running' && Date.now() - t0 < 200, JSON.stringify(first).slice(0, 200));
  const again = startRun(COMPANY, c, LINE, { effort: 'quick' });
  ok('a second start returns the SAME run, not a second one', again.runId === first.runId);
  let last = first;
  let pctUp = true;
  let sawPacking = false;
  for (let i = 0; i < 600 && last.status === 'running'; i += 1) {
    await wait(500);
    const now = currentRun(COMPANY, LINE);
    if (now.progress.pct < last.progress.pct) pctUp = false;
    if (now.phase === 'packing') sawPacking = true;
    last = now;
  }
  ok('the run finished', last.status === 'done', JSON.stringify({ status: last.status, error: last.error }));
  ok('progress only went up, and ends at 100', pctUp && last.progress.pct === 100);
  ok('it was seen packing, with jobs counted', sawPacking && last.progress.total > 0 && last.progress.done === last.progress.total, JSON.stringify(last.progress));
  const texts = last.log.map((l) => l.text);
  ok('the log reads: started, reading, steels, packing, tries, choosing, finished',
    /^Started/.test(texts[0]) && texts.some((t) => /^Reading/.test(t)) && texts.some((t) => /steels?/.test(t)) && texts.some((t) => /^Packing/.test(t))
    && texts.some((t) => / — try \d+:/.test(t)) && texts.some((t) => /^Choosing/.test(t)) && /^Finished/.test(texts.at(-1)), JSON.stringify(texts.slice(0, 8)));
  console.log(`    (${texts.length} log lines, ${Math.round(last.elapsedMs / 1000)} s; last: ${texts.at(-1)})`);
  ok('no proposal unless asked for', last.plan === undefined);
  const withPlan = currentRun(COMPANY, LINE, { withPlan: true });
  ok('asked for, the proposal is there and is a plan', Array.isArray(withPlan.plan?.groups) && withPlan.plan.basis === 'proposal');
  ok('the summary agrees with the plan', withPlan.summary.plates === withPlan.plan.totals.plates);
  ok('dismiss forgets it', dismissRun(COMPANY, LINE).ok === true && currentRun(COMPANY, LINE).status === 'none');

  startRun(COMPANY, c, 99999999, { effort: 'quick' });
  let bad = currentRun(COMPANY, 99999999);
  for (let i = 0; i < 40 && bad.status === 'running'; i += 1) { await wait(100); bad = currentRun(COMPANY, 99999999); }
  ok('a refusal arrives as a failed run, in the service\'s words', bad.status === 'failed' && /Order line/i.test(bad.error?.message ?? ''), JSON.stringify(bad.error));
  ok('...and its log says it stopped', /^Stopped:/.test(bad.log.at(-1)?.text ?? ''));
  dismissRun(COMPANY, 99999999);
} catch (err) {
  failed++;
  console.error('\nERROR', err);
}

const after = await counts();
const drift = after.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
ok('a run writes nothing: every cf_ table has the rows it had', drift.length === 0, drift.map((d) => d.name).join(', '));
console.log(`\n${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : 0);
