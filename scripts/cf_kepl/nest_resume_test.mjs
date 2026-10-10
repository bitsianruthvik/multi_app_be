/**
 * nest_resume_test.mjs — LONG RUNS THAT SURVIVE A SLEEP, A DEPLOY OR A CRASH: checkpoints, resume,
 * the atomic claim, its limits, "stop and use this" on a run that is not live, resume at boot, the
 * keep-awake ping, and the offline runner (scripts/cf_kepl/nest-line.mjs). Local only.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nest_resume_test.mjs          # ~3 minutes
 *
 * TIME IS SCALED (CF_NEST_BUDGET_SCALE = 0.1: Quick is 30 s, a checkpoint every 6 s) so the suite
 * runs in minutes; everything else is real — a line the size of the KEPL bridge order
 * (lib/nestScaleFixture.mjs), the real worker pool, the real database. ONE TRANSACTION, ROLLED
 * BACK: the runs are given the test's own connection, and "the process died" is nestRunService's
 * `_kill` (memory gone, workers stopped, the row left exactly as a dead process leaves it); "the
 * heartbeat went stale" is the row's heartbeat_at moved into the past.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.CF_NEST_BUDGET_SCALE = '0.1';
delete process.env.KEEP_AWAKE_URL; delete process.env.RENDER_EXTERNAL_URL;
const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const N = await imp('apps/cf_erp/services/nestingService.js');
const R = await imp('apps/cf_erp/services/nestRunService.js');
const U = await imp('apps/cf_erp/services/nestDxfImportService.js');
const C = await imp('apps/cf_erp/services/nestCompareService.js');
const KA = await imp('apps/cf_erp/lib/keepAwake.js');
const { runPackJob, checkpointOf } = await imp('apps/cf_erp/services/packJob.js');
const { rimOf } = await imp('apps/cf_erp/services/nestShapes.js');
const { buildScaleFixture } = await imp('scripts/cf_kepl/lib/nestScaleFixture.mjs');
const { scaleGroups, inputsOf } = await imp('scripts/cf_kepl/lib/nestScaleJob.mjs');
const F = await imp('scripts/cf_kepl/lib/nestV2Fixture.mjs');
const { nestLine } = await imp('scripts/cf_kepl/lib/nestLineRunner.mjs');

const COMPANY = Number(process.env.CF_NEST_COMPANY ?? 2);
const tag = `NR${Date.now().toString(36).toUpperCase()}`;
let passed = 0; let failed = 0; const fails = [];
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || typeof cond !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 600)}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const J = (v) => JSON.stringify(v);

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const conn = await pool.getConnection();
const c = { companyId: COMPANY, userId: null, userName: 'nest resume test' };

const head = async (line) => (await conn.query('SELECT * FROM cf_nest_runs WHERE company_id = ? AND order_line_id = ? ORDER BY id LIMIT 1', [COMPANY, line]))[0][0] ?? null;
const rowsOf = async (line) => (await conn.query('SELECT id, run_uid, scope, status, resume_count, quick_deaths, error_json, (plan_json IS NOT NULL) AS has_plan FROM cf_nest_runs WHERE company_id = ? AND order_line_id = ? ORDER BY id', [COMPANY, line]))[0];
/** The heartbeat went stale: as after a sleep or a crash, ten minutes ago. */
const stale = (line) => conn.query('UPDATE cf_nest_runs SET heartbeat_at = NOW(3) - INTERVAL 600 SECOND WHERE company_id = ? AND order_line_id = ?', [COMPANY, line]);
const clearRuns = async (line) => { await R._kill(COMPANY, line); await R.settleRuns(); await conn.query('DELETE FROM cf_nest_runs WHERE company_id = ? AND order_line_id = ?', [COMPANY, line]); };
/** Until the run's row holds a checkpoint that `pred` likes (or the run ends). */
async function untilCheckpoint(line, pred = () => true, ms = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await R.settleRuns();
    const h = await head(line);
    const ck = h?.checkpoint_json ? R.unpackCheckpoint(h.checkpoint_json) : null;
    if (ck && pred(ck, h)) return { row: h, ck };
    if (R.memoryRun(COMPANY, line)?.status !== 'running') return { row: h, ck };
    await wait(250);
  }
  return { row: await head(line), ck: null };
}
const untilDone = async (line, ms = 120_000) => { const t0 = Date.now(); while (R.memoryRun(COMPANY, line)?.status === 'running' && Date.now() - t0 < ms) await wait(200); await R.settleRuns(); return R.memoryRun(COMPANY, line); };
const sumOf = (groups, f) => Object.values(groups).reduce((a, g) => a + f(g), 0);

try {
  await conn.beginTransaction();
  attachNodeCache(conn);

  /* ───────────── 0. the pieces: levels, a job picked up again ───────────── */
  section('0. The levels, and a steel picked up again (no database)');
  ok('four levels: quick 5, standard 10, deep 20, LONG 60 minutes', N.NEST_BUDGET_MS.quick === 300_000 && N.NEST_BUDGET_MS.standard === 600_000 && N.NEST_BUDGET_MS.deep === 1_200_000 && N.NEST_BUDGET_MS.long === 3_600_000
    && N.runBudgetMs('long') === 360_000 && N.effortOf('normal') === 'standard' && N.effortOf('long') === 'long' && N.effortOf('nonsense') === 'standard');
  {
    const g = scaleGroups({ pieces: 600, parts: 40, plates: 12 })[3];
    const { packInput, shapeInput } = inputsOf(g, { effort: 'quick', rim: rimOf(g.kerf) });
    const job = { packer: 'shape', seed: 1, rect: packInput, shape: shapeInput, fillSheets: [] };
    const cks = [];
    const first = runPackJob({ ...job, budgetMs: 3000, deadlineAt: Date.now() + 3000, checkpointMs: 500 }, { onCheckpoint: (k) => cks.push(k) });
    ok(`a job hands out checkpoints as it works (${cks.length}), each a layout that can be started from, never a worse one`, cks.length >= 1 && cks.every((k) => Array.isArray(k.start) && k.start.every((n) => n.sheetKey != null && n.placements.every((q) => q.key != null && Number.isFinite(q.x)))) && cks.every((k, i) => i === 0 || k.areaBought <= cks[i - 1].areaBought + 1e-6), J(cks.map((k) => [k.plates, k.areaBought])));
    const kept = checkpointOf(first);
    const t0 = Date.now();
    const done = runPackJob({ ...job, resume: { ...kept, done: true }, budgetMs: 60_000, deadlineAt: Date.now() + 60_000 });
    const tookDone = Date.now() - t0;
    ok(`a FINISHED steel picked up again is not searched again: the same ${kept.plates} plates and steel, back in ${tookDone} ms of the 60 s it was offered`, done.nests.length === kept.plates && Math.abs(done.areaBought - kept.areaBought) <= 1e-6 && tookDone < 5000 && (done.shape?.trials ?? 0) <= 3, J([done.nests.length, done.areaBought, kept.plates, kept.areaBought, done.shape?.trials]));
    const more = runPackJob({ ...job, seed: 7920, resume: { ...kept, done: false }, budgetMs: 2500, deadlineAt: Date.now() + 2500 });
    ok('an UNFINISHED steel picked up again starts from the kept layout: never worse than it', more.unplaced.length === 0 && more.areaBought <= kept.areaBought + 1e-6 && more.nests.length <= kept.plates, J([more.nests.length, more.areaBought]));
    const coarse1 = runPackJob({ ...job, coarse: 1, budgetMs: 2000, deadlineAt: Date.now() + 2000 });
    const coarse2 = runPackJob({ ...job, coarse: 2, budgetMs: 2000, deadlineAt: Date.now() + 2000 });
    ok('a job re-run COARSER (its worker ran out of heap) still answers; coarser again, it is the row layout, and says why', coarse1.coarse === 1 && !coarse1.unplaced.length && coarse1.areaBought <= coarse1.rect.areaBought + 1e-6 && coarse2.coarse === 2 && coarse2.chosen === 'rect' && /out of memory/.test(coarse2.shapeError ?? ''), J([coarse1.chosen, coarse2.chosen, coarse2.shapeError]));
  }

  /* ───────────── the bridge-size line ───────────── */
  section('Fixture');
  const fx = await buildScaleFixture(conn, { company: COMPANY, tag });
  const LINE = fx.lineId;
  console.log(`  ${tag}: line ${LINE} — ${fx.pieces} pieces of ${fx.parts.length} cut plates in ${fx.groups.length} thicknesses`);

  /* ───────────── 1. checkpoints ───────────── */
  section('1. A run checkpoints itself: one UPDATE, a small row');
  const s1 = R.startRun(COMPANY, c, LINE, { effort: 'quick', seed: 1 }, { db: conn });           // 30 s
  const first = await untilCheckpoint(LINE, (ck) => Object.keys(ck.groups ?? {}).length >= fx.groups.length);
  const bytes = String(first.row?.checkpoint_json ?? '').length;
  console.log(`    checkpoint of the bridge-size line: ${(bytes / 1024).toFixed(0)} kB as stored (gzip + base64); ${Object.keys(first.ck?.groups ?? {}).length} steels, ${sumOf(first.ck?.groups ?? {}, (g) => g.plates)} plates`);
  ok('the run\'s head row holds a checkpoint while it works, with a heartbeat, its claim and its budget', !!first.ck && first.ck.v === 1 && first.row.status === 'running' && first.row.heartbeat_at != null && typeof first.row.claim_token === 'string' && Number(first.row.budget_ms) === 30_000 && first.row.checkpoint_at != null, J([first.row?.status, first.row?.budget_ms]));
  ok(`it is SMALL: ${(bytes / 1024).toFixed(0)} kB for ${fx.pieces} pieces — under 1 MB, a sixth of the 6 MB a row may be`, bytes > 1000 && bytes < 1024 * 1024 && bytes < R.CHECKPOINT_CAP);
  ok('it holds every steel\'s best layout as placements (no outlines), and what was asked', Object.values(first.ck.groups).every((g) => (g.start === null || (Array.isArray(g.start) && g.start.every((n) => n.placements.every((q) => q.rings === undefined)))) && Number.isFinite(g.plates)) && typeof Object.values(first.ck.demand ?? {})[0] === 'string', J(Object.entries(first.ck.groups).map(([k, g]) => [k, g.plates, g.done])));
  const snap1 = R.snapshot(R.memoryRun(COMPANY, LINE));
  ok('the progress says when the last checkpoint was written, and that this run was never picked up again', snap1.progress.checkpointAt != null && snap1.progress.checkpointAgeMs >= 0 && snap1.progress.checkpointBytes > 0 && snap1.progress.resumes === 0 && snap1.resumed === false && typeof snap1.progress.keepAwake === 'object', J([snap1.progress.checkpointAt, snap1.progress.resumes]));

  /* ───────────── 2. killed mid-run → the next read resumes ───────────── */
  section('2. The process dies mid-run; the next read of the line picks the run up again');
  await wait(1500);
  const beforeKill = await untilCheckpoint(LINE);
  const usedAtKill = R.snapshot(R.memoryRun(COMPANY, LINE)).elapsedMs;
  await R._kill(COMPANY, LINE);
  const dead = await head(LINE);
  const ckDead = R.unpackCheckpoint(dead.checkpoint_json);
  const platesDead = sumOf(ckDead.groups, (g) => g.plates);
  const areaDead = sumOf(ckDead.groups, (g) => g.areaBought);
  ok('dead: nothing in memory, the row still `running` with its last checkpoint', R.memoryRun(COMPANY, LINE) === null && dead.status === 'running' && !!ckDead && beforeKill.row.run_uid === s1.runId);
  const stillLive = await R.resumeRun(COMPANY, LINE, { db: conn });
  ok('while its heartbeat is fresh nobody picks it up (another process may be working it)', stillLive.live === true && R.memoryRun(COMPANY, LINE) === null, J(stillLive));
  await stale(LINE);
  const back = await R.readRun(COMPANY, LINE, { db: conn });
  ok('the next read (the page\'s poll) picks it up: the SAME run, running again, and says so', back.status === 'running' && back.runId === s1.runId && back.resumed === true && back.progress.resumes === 1 && /Picked up again \(1st time\)/.test(back.log.map((l) => l.text).join('|')), J([back.status, back.runId, back.progress?.resumes]));
  ok('it starts from where it was: its best-so-far figure is the checkpoint\'s, not the row floor', back.progress.best?.plates === platesDead || (R.snapshot(R.memoryRun(COMPANY, LINE)).progress.best?.plates ?? 0) <= platesDead + 0, J([back.progress.best, platesDead]));
  const done2 = await untilDone(LINE);
  const snap2 = R.snapshot(done2, { withPlan: true });
  ok(`it finishes: a whole proposal, every piece placed`, snap2.status === 'done' && snap2.plan.totals.unplaced === 0 && snap2.plan.groups.flatMap((g) => g.nests).reduce((a, n) => a + n.pieces.length, 0) === fx.pieces, J([snap2.status, snap2.error]));
  ok(`the TOTAL budget is honoured across both lives: ${snap2.elapsedMs} ms worked of ${snap2.budgetMs} (it had used ${usedAtKill} when it died)`, snap2.elapsedMs <= snap2.budgetMs * 1.1 && snap2.elapsedMs >= usedAtKill);
  ok(`never worse than the checkpoint it resumed from: ${snap2.plan.totals.plates} plates / ${(snap2.plan.totals.areaBought / 1e6).toFixed(1)} m² against ${platesDead} / ${(areaDead / 1e6).toFixed(1)}`, snap2.plan.totals.areaBought <= areaDead + 1e-3 && snap2.plan.totals.unplaced === 0);
  const rows2 = await rowsOf(LINE);
  ok('its row ends ready, picked up once, the checkpoint cleared', rows2.length === 1 && rows2[0].status === 'ready' && Number(rows2[0].resume_count) === 1 && (await head(LINE)).checkpoint_json === null, J(rows2));
  await clearRuns(LINE);

  /* ───────────── 3. two resumes at once ───────────── */
  section('3. Two resumes at once: exactly one claims');
  R.startRun(COMPANY, c, LINE, { effort: 'quick', seed: 1 }, { db: conn });
  await untilCheckpoint(LINE, (ck) => Object.keys(ck.groups ?? {}).length >= fx.groups.length);
  await R._kill(COMPANY, LINE);
  await stale(LINE);
  const both = await Promise.all([R.resumeRun(COMPANY, LINE, { db: conn }), R.resumeRun(COMPANY, LINE, { db: conn }), R.resumeRun(COMPANY, LINE, { db: conn })]);
  const h3 = await head(LINE);
  ok('three at once: the run was claimed ONCE (resume_count 1, one claim token), and all three see it running', Number(h3.resume_count) === 1 && both.filter((b) => b.snapshot || b.live).length === 3 && both.some((b) => b.snapshot) && R.memoryRun(COMPANY, LINE)?.claim === h3.claim_token, J([h3.resume_count, both.map((b) => Object.keys(b)[0])]));
  // The claim itself, as a second PROCESS would try it: the guarded UPDATE changes nothing while the heartbeat is fresh.
  const [again] = await conn.query("UPDATE cf_nest_runs SET claim_token = 'someone-else', resume_count = resume_count + 1 WHERE id = ? AND status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < NOW(3) - INTERVAL ? SECOND)", [h3.id, R.STALE_MS / 1000]);
  ok('…and the guarded claim of another process changes nothing while this one is alive', again.affectedRows === 0);
  // A process that LOST its claim lets go at its next write: it stops and keeps nothing.
  const mineNow = R.memoryRun(COMPANY, LINE);
  await conn.query("UPDATE cf_nest_runs SET claim_token = 'taken-by-another' WHERE id = ?", [h3.id]);
  for (let i = 0; i < 100 && R.memoryRun(COMPANY, LINE); i += 1) await wait(200);
  await R.settleRuns();
  ok('a process whose claim was taken lets go at its next heartbeat: gone from memory, the row not finished by it', R.memoryRun(COMPANY, LINE) === null && mineNow.lost === true && (await head(LINE)).status === 'running');
  await clearRuns(LINE);

  /* ───────────── 4. limits ───────────── */
  section('4. What ends a run instead of resuming it — each with its reason');
  const startAndKill = async () => { R.startRun(COMPANY, c, LINE, { effort: 'quick', seed: 1 }, { db: conn }); await untilCheckpoint(LINE, (ck) => Object.keys(ck.groups ?? {}).length >= fx.groups.length); await R._kill(COMPANY, LINE); await stale(LINE); };
  await startAndKill();
  await conn.query('UPDATE cf_nest_runs SET resume_count = ? WHERE company_id = ? AND order_line_id = ?', [R.MAX_RESUMES, COMPANY, LINE]);
  const over = await R.readRun(COMPANY, LINE, { db: conn });
  ok(`picked up ${R.MAX_RESUMES} times already: it fails, RESUME_LIMIT, in words`, over.status === 'failed' && over.error?.code === 'RESUME_LIMIT' && /picked up again 10 times/.test(over.error.message) && (await head(LINE)).status === 'failed' && R.memoryRun(COMPANY, LINE) === null, J(over.error));
  await clearRuns(LINE);

  await startAndKill();
  // The last life was a RESUME that died ten seconds after it was claimed — and so did the one before.
  await conn.query('UPDATE cf_nest_runs SET resume_count = 2, quick_deaths = 1, claimed_at = NOW(3) - INTERVAL 610 SECOND, heartbeat_at = NOW(3) - INTERVAL 600 SECOND WHERE company_id = ? AND order_line_id = ?', [COMPANY, LINE]);
  const loop = await R.resumeAtBoot({ db: conn });
  const hLoop = await head(LINE);
  ok('two resumes in a row that died within a minute: not picked up a third time (CRASH_LOOP) — a run that kills the server cannot loop', loop.failed === 1 && loop.resumed === 0 && hLoop.status === 'failed' && JSON.parse(hLoop.error_json).code === 'CRASH_LOOP' && Number(hLoop.quick_deaths) === 2 && R.memoryRun(COMPANY, LINE) === null, J([loop, hLoop.error_json]));
  await clearRuns(LINE);

  await startAndKill();
  await conn.query('UPDATE cf_nest_runs SET resume_count = 3, quick_deaths = 1, claimed_at = NOW(3) - INTERVAL 3600 SECOND, heartbeat_at = NOW(3) - INTERVAL 600 SECOND WHERE company_id = ? AND order_line_id = ?', [COMPANY, LINE]);
  const lived = await R.resumeRun(COMPANY, LINE, { db: conn });
  ok('a resume that had lived fifty minutes before it died clears the count: picked up again', !!lived.snapshot && Number((await head(LINE)).quick_deaths) === 0 && Number((await head(LINE)).resume_count) === 4, J(Object.keys(lived)));
  await clearRuns(LINE);

  await startAndKill();
  await conn.query('UPDATE cf_nest_runs SET checkpoint_json = NULL WHERE company_id = ? AND order_line_id = ?', [COMPANY, LINE]);
  const none = await R.readRun(COMPANY, LINE, { db: conn });
  ok('no checkpoint to continue from: it fails as interrupted, with the reason', none.status === 'failed' && none.error?.code === 'INTERRUPTED' && /never finished/.test(none.error.message), J(none.error));
  await clearRuns(LINE);

  await startAndKill();
  // The line changes while the run is asleep: one part is needed once more.
  const [[bl]] = await conn.query('SELECT bl.id, bl.quantity FROM cf_bom_lines bl JOIN cf_boms b ON b.id = bl.bom_id WHERE b.company_id = ? AND b.parent_id = (SELECT item_id FROM cf_sales_order_lines WHERE id = ?) AND bl.deleted_at IS NULL ORDER BY bl.id LIMIT 1', [COMPANY, LINE]);
  await conn.query('UPDATE cf_bom_lines SET quantity = quantity + 1 WHERE id = ?', [bl.id]);
  const changed = await R.resumeRun(COMPANY, LINE, { db: conn });
  const endedChanged = await untilDone(LINE, 30_000);
  ok('the line\'s demand changed while it slept: picked up, found to answer another question, failed DEMAND_CHANGED — in seconds, not after its budget', !!changed.snapshot && endedChanged?.status === 'failed' && endedChanged.error?.code === 'DEMAND_CHANGED' && /line changed while this run was asleep/.test(endedChanged.error.message) && (await head(LINE)).status === 'failed', J(endedChanged?.error));
  await conn.query('UPDATE cf_bom_lines SET quantity = ? WHERE id = ?', [bl.quantity, bl.id]);
  await clearRuns(LINE);

  /* ───────────── 5. stop and use this, on a run that is not live ───────────── */
  section('5. Stop and use this — on a run the server slept under');
  await startAndKill();
  const ck5 = R.unpackCheckpoint((await head(LINE)).checkpoint_json);
  const area5 = sumOf(ck5.groups, (g) => g.areaBought);
  const t5 = Date.now();
  const stopped = await R.stopRunAnywhere(COMPANY, LINE, { purpose: 'nest', db: conn });
  ok('the stop is taken although nothing was live: the run is picked up with the stop set', stopped.status === 'running' && stopped.stopRequested === true && stopped.resumed === true, J([stopped.status, stopped.stopRequested]));
  const done5 = await untilDone(LINE, 60_000);
  const snap5 = R.snapshot(done5, { withPlan: true });
  ok(`it ends in ${Date.now() - t5} ms with a WHOLE proposal — every piece placed — exactly what the checkpoint held`, snap5.status === 'done' && snap5.stopped === true && Date.now() - t5 < 20_000 && snap5.plan.totals.unplaced === 0 && Math.abs(snap5.plan.totals.areaBought - area5) <= 1e-3, J([snap5.status, snap5.plan?.totals?.areaBought, area5]));
  const acc = await N.acceptNesting(conn, c, LINE, snap5.plan);
  ok('…and that proposal is accepted like any other', acc.lots === snap5.plan.totals.plates && acc.pieces === fx.pieces);
  await N.clearLots(conn, c, LINE, {});
  await clearRuns(LINE);

  /* ───────────── 6. at boot ───────────── */
  section('6. At boot: a run a deploy cut off carries on with nobody opening the screen');
  await startAndKill();
  const boot = await R.resumeAtBoot({ db: conn });
  ok('boot finds the stale run and picks it up', boot.found === 1 && boot.resumed === 1 && boot.failed === 0 && R.memoryRun(COMPANY, LINE)?.status === 'running' && R.memoryRun(COMPANY, LINE).resumes === 1, J(boot));
  const boot2 = await R.resumeAtBoot({ db: conn });
  ok('…exactly once: a second look finds nothing stale', boot2.found === 0 && Number((await head(LINE)).resume_count) === 1, J(boot2));
  const done6 = await untilDone(LINE);
  ok('…and it runs to its end', done6?.status === 'done' && done6.plan.totals.unplaced === 0);
  await clearRuns(LINE);

  /* ───────────── 7. two plans: the finished one is not made again ───────────── */
  section('7. A run of two plans (a comparison): the plan already finished is not made again');
  const half = Object.fromEntries(fx.parts.filter((p, i) => i % 2 === 0).map((p) => [p.cutPlateId, p.qty]));
  R.startRun(COMPANY, c, LINE, { effort: 'quick', seed: 1 }, { db: conn, purpose: 'compare', jobs: [{ scope: 'subset', input: { effort: 'quick', only: half } }, { scope: 'line', input: { effort: 'quick', replaceImported: true } }] });
  // Until the first plan is kept and the second has checkpointed.
  for (let i = 0; i < 400; i += 1) { await wait(250); await R.settleRuns(); const rr = await rowsOf(LINE); const h = await head(LINE); const ck = h?.checkpoint_json ? R.unpackCheckpoint(h.checkpoint_json) : null; if (Number(rr[0]?.has_plan) === 1 && ck?.jobIndex === 1 && Object.keys(ck.groups ?? {}).length >= fx.groups.length) break; if (R.memoryRun(COMPANY, LINE)?.status !== 'running') break; }
  const mid = await rowsOf(LINE);
  const [[kept7]] = await conn.query('SELECT plan_json FROM cf_nest_runs WHERE id = ?', [mid[0].id]);
  await R._kill(COMPANY, LINE);
  await stale(LINE);
  ok('killed during the SECOND plan: the first is already on its row (still `running`), the second is not', mid.length === 2 && Number(mid[0].has_plan) === 1 && Number(mid[1].has_plan) === 0 && mid.every((r) => r.status === 'running'), J(mid));
  await R.resumeRun(COMPANY, LINE, { db: conn, purpose: 'compare' });
  const resumed7 = R.memoryRun(COMPANY, LINE);
  const done7 = await untilDone(LINE);
  const end7 = await rowsOf(LINE);
  const [[after7]] = await conn.query('SELECT plan_json FROM cf_nest_runs WHERE id = ?', [mid[0].id]);
  ok('picked up: only the second plan is worked (the log never mentions the first again), both rows end ready, the first plan byte for byte what it was', done7?.status === 'done' && end7.every((r) => r.status === 'ready' && Number(r.has_plan) === 1) && after7.plan_json === kept7.plan_json
    && !resumed7.log.slice(resumed7.log.findIndex((l) => /Picked up again/.test(l.text))).some((l) => /pieces the uploaded files cover/.test(l.text)), J([done7?.status, done7?.error, end7]));
  await clearRuns(LINE);

  /* ───────────── 8. keep awake ───────────── */
  section('8. Keep awake: the server pings its own public health URL while a run is live');
  {
    const timers = []; const cleared = []; const calls = [];
    let failing = false;
    const stub = { fetch: async (url) => { calls.push(url); if (failing) throw new Error('getaddrinfo ENOTFOUND'); return { status: 200 }; }, setInterval: (fn, ms) => { const t = { fn, ms, unref() { this.unrefd = true; } }; timers.push(t); return t; }, clearInterval: (t) => { cleared.push(t); } };
    KA._keepAwakeTest(stub);
    KA.holdAwake('a');
    ok('no URL configured (a developer\'s machine): nothing happens — no timer, no request', timers.length === 0 && calls.length === 0 && KA.keepAwakeState().on === false && KA.keepAwakeState().configured === false);
    KA._keepAwakeTest(stub);
    process.env.RENDER_EXTERNAL_URL = 'https://example-app.onrender.com/';
    ok('the URL is the platform\'s own (RENDER_EXTERNAL_URL) + /health; KEEP_AWAKE_URL overrides it', KA.keepAwakeUrl() === 'https://example-app.onrender.com/health' && ((process.env.KEEP_AWAKE_URL = 'https://other.example/health'), KA.keepAwakeUrl() === 'https://other.example/health') && (delete process.env.KEEP_AWAKE_URL));
    KA.holdAwake('a');
    await wait(20);
    ok('the first live run starts ONE timer (4 minutes, unref\'d) and pings at once', timers.length === 1 && timers[0].ms === 240_000 && timers[0].unrefd === true && calls.length === 1 && calls[0] === 'https://example-app.onrender.com/health' && KA.keepAwakeState().on === true);
    KA.holdAwake('b');
    timers[0].fn(); await wait(20);
    ok('a second live run does not start a second timer; each tick is one ping', timers.length === 1 && calls.length === 2 && KA.keepAwakeState().runs === 2 && KA.keepAwakeState().lastOkAt != null);
    KA.releaseAwake('a');
    ok('it goes on while one run is still live', cleared.length === 0 && KA.keepAwakeState().on === true);
    failing = true;
    timers[0].fn(); await wait(20);
    ok('a ping that fails is counted and remembered, never thrown', KA.keepAwakeState().failures === 1 && /ENOTFOUND/.test(KA.keepAwakeState().lastError) && KA.keepAwakeState().pings === 3);
    KA.releaseAwake('b');
    ok('the timer is cleared when the last run ends', cleared.length === 1 && cleared[0] === timers[0] && KA.keepAwakeState().on === false);
    // A REAL run with a failing ping: it is held awake while it works, lets go when it ends, and is none the worse.
    const s8 = R.startRun(COMPANY, c, LINE, { effort: 'quick', seed: 1, budgetMs: 6000 }, { db: conn });
    await wait(300);
    const during = R.snapshot(R.memoryRun(COMPANY, LINE));
    const done8 = await untilDone(LINE, 60_000);
    ok('a real run: the server is held awake while it works (seen in its progress), a failing ping changes nothing, and it lets go at the end', s8.status === 'running' && during.progress.keepAwake.on === true && during.progress.keepAwake.runs === 1 && done8.status === 'done' && KA.keepAwakeState().on === false && KA.keepAwakeState().failures >= 2 && timers.length === 2 && cleared.length === 2, J([during.progress.keepAwake, KA.keepAwakeState()]));
    const s9 = R.startRun(COMPANY, c, LINE, { effort: 'quick', seed: 1 }, { db: conn });
    await wait(300);
    R.cancelRun(COMPANY, LINE, {});
    ok('…and a cancelled run lets go at once', s9.status === 'running' && KA.keepAwakeState().on === false);
    delete process.env.RENDER_EXTERNAL_URL;
    KA._keepAwakeTest(null);
    await clearRuns(LINE);
  }

  /* ───────────── 9. the offline runner ───────────── */
  section('9. The offline runner (scripts/cf_kepl/nest-line.mjs): nest here, leave a finished run, the screen takes it from there');
  {
    const small = await F.buildFixture(conn, { company: COMPANY, tagPrefix: 'NO' });
    const [[ord]] = await conn.query('SELECT code FROM cf_sales_orders WHERE id = ?', [small.orderId]);
    const B = F.nestings(small).B;
    const files = [B[0], B[1], B[4]].map((f) => ({ filename: f.filename, file: f.file, ...(f.style === 'segments' ? { plateCode: small.plateCode('PS') } : {}) }));
    await U.uploadNestFiles(conn, c, small.lineId, { files, dryRun: false });
    const runsOf = async () => (await conn.query('SELECT run_uid, scope, purpose, status, demand_hash, started_by_name FROM cf_nest_runs WHERE company_id = ? AND order_line_id = ?', [COMPANY, small.lineId]))[0];
    const dry = await nestLine({ db: conn, companyId: COMPANY, orderCode: ord.code, effort: 'quick', whole: true });
    ok('a dry run nests the line and writes NOTHING', dry.applied === false && dry.runId === null && dry.totals.plates > 0 && dry.totals.unplaced === 0 && dry.curve.length >= 1 && (await runsOf()).length === 0, J(dry.totals));
    const wrote = await nestLine({ db: conn, companyId: COMPANY, orderCode: ord.code, lineNo: 1, effort: 'normal', whole: true, apply: true, startedBy: 'offline runner (test)' });
    const rr = await runsOf();
    ok('with apply it writes ONE finished run: ready, the whole line, with its demand fingerprint, as the server writes its own', wrote.applied === true && rr.length === 1 && rr[0].run_uid === wrote.runId && rr[0].status === 'ready' && rr[0].scope === 'line' && rr[0].purpose === 'nest' && rr[0].demand_hash === wrote.demand.hash && /offline runner/.test(rr[0].started_by_name), J(rr));
    await R._forgetMemory();
    const seen = await R.readRun(COMPANY, small.lineId, { withPlan: true, db: conn });
    ok('the screen\'s poll shows it: a finished run, with its proposal', seen.status === 'done' && seen.runId === wrote.runId && seen.restored === true && seen.replaceImported === true && seen.plan?.totals?.plates === wrote.totals.plates && seen.effort === 'standard', J([seen.status, seen.runId, seen.effort]));
    const cmp = await C.getCompare(conn, COMPANY, small.lineId, {});
    ok('a comparison finds it BY ITS FINGERPRINT as our automatic nesting of the whole line — nothing is packed again', cmp.wholeLine.auto.runId === wrote.runId && cmp.wholeLine.auto.status === 'ready' && cmp.wholeLine.auto.metrics.plates === wrote.totals.plates && cmp.demand.wholeLineHash === wrote.demand.hash && cmp.willReplace.withPlates === wrote.totals.plates, J([cmp.wholeLine.auto.runId, cmp.wholeLine.auto.status]));
    const acc9 = await N.acceptNesting(conn, c, small.lineId, { ...seen.plan, replaceImported: true });
    const lots = (await conn.query("SELECT origin FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND kind = 'plate'", [COMPANY, small.lineId]))[0];
    ok('accepting it is the server\'s own accept: verified against the database and written', acc9.lots === wrote.totals.plates && lots.length === wrote.totals.plates && lots.every((l) => l.origin === 'auto'), J([acc9.lots, lots.length]));
    // Refusals.
    await conn.query("INSERT INTO cf_nest_runs (company_id, order_line_id, run_uid, kind, scope, purpose, status, heartbeat_at, claim_token) VALUES (?, ?, 'live-run-on-the-server', 'auto', 'rest', 'nest', 'running', NOW(3), 'x')", [COMPANY, small.lineId]);
    let busy = null; try { await nestLine({ db: conn, companyId: COMPANY, orderCode: ord.code }); } catch (e) { busy = e; }
    ok('refused while a run is live on the line on the server', busy?.code === 'RUN_BUSY' && /working on line 1/.test(busy.message), busy?.message);
    await conn.query("DELETE FROM cf_nest_runs WHERE run_uid = 'live-run-on-the-server'");
    await conn.query('UPDATE cf_sales_order_lines SET locked_at = NULL WHERE id = ?', [small.lineId]);
    let thawed = null; try { await nestLine({ db: conn, companyId: COMPANY, orderCode: ord.code }); } catch (e) { thawed = e; }
    let missing = null; try { await nestLine({ db: conn, companyId: COMPANY, orderCode: 'NO-SUCH-ORDER' }); } catch (e) { missing = e; }
    ok('refused for a line that is not frozen, and for an order that is not there — in words', /[Ff]reeze/.test(thawed?.message ?? '') && /not found/i.test(missing?.message ?? ''), J([thawed?.message, missing?.message]));
  }
} catch (err) {
  failed += 1; fails.push(`ERROR ${err?.message}`);
  console.error('\nERROR', err);
} finally {
  for (const run of [...R._runs.values()]) { try { await R._kill(run.companyId, run.lineId); } catch { /* cleaning up */ } }
  await R.settleRuns().catch(() => {});
  KA._keepAwakeTest(null);
  try { await conn.rollback(); } catch { /* the original error is the one that matters */ }
  detachNodeCache(conn);
  conn.release();
}

section('Nothing survived the rollback');
const after = await counts();
const drift = after.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
ok('every cf_ table is back to the count it started at', drift.length === 0, drift.map((d) => `${d.name} ${before.find((b) => b.name === d.name)?.n}->${d.n}`).join(', '));
console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  failed: ${fails.join('\n          ')}` : ''}`);
await pool.end();
process.exit(failed ? 1 : 0);
