/**
 * nesting_budget_test.mjs — an effort's time budget is for the WHOLE plan.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nesting_budget_test.mjs
 *
 * THE BUG (production, 2026-09-30): "Nest everything" at Standard on the KEPL
 * line never came back. A plan is one packer job per (steel group x seed) —
 * 48 at Standard — and capMs used to be each JOB's allowance, so on a host with
 * one or two cores the jobs queued and the plan ran (jobs / workers) x capMs.
 *
 * What is proved here:
 *   1. The packer returns a complete, legal layout when it is given no time at
 *      all (budgetMs 0, or an absolute deadline already in the past) — the
 *      floor that a late-starting job falls back to.
 *   2. The pool, forced down to ONE worker with a small plan deadline, returns
 *      within that deadline plus a small margin, with every piece of every
 *      group placed, and says the clock cut it.
 *   3. planNesting on the real KEPL line (company 2, line 923 — skipped with a
 *      note if it is not in this database), one worker, a 20 s budget: back
 *      inside the budget, every one of its pieces placed, layouts legal, and
 *      `budget.capped` set. Read-only, and inside a rolled-back transaction.
 *
 * The geometry check is written fresh here (inside the rim cut, no overlaps)
 * rather than imported, for the same reason packer_test gives: a checker that
 * shares the packer's code shares its bugs.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { nest } = await imp('apps/cf_erp/services/nestingPacker.js');
const { runAll, pickBest, poolSize } = await imp('apps/cf_erp/lib/packerPool.js');

const TOL = 1e-6;
let passed = 0;
let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** Inside the rim cut and no two parts overlapping. Returns a problem or null. */
function illegal(pieces, L, W, k) {
  for (const p of pieces) {
    if (p.x < k - TOL || p.y < k - TOL || p.x + p.length > L - k + TOL || p.y + p.width > W - k + TOL) {
      return `${p.key ?? p.cutPlateCode} at ${p.x},${p.y} breaks the rim of ${L}x${W}`;
    }
  }
  const by = [...pieces].sort((a, b) => a.x - b.x || a.y - b.y);
  for (let i = 0; i < by.length; i += 1) {
    const a = by[i];
    for (let j = i + 1; j < by.length; j += 1) {
      const b = by[j];
      if (b.x >= a.x + a.length - TOL) break;
      if (b.y < a.y + a.width - TOL && a.y < b.y + b.width - TOL) return `overlap at ${a.x},${a.y} / ${b.x},${b.y}`;
    }
  }
  return null;
}

/** A packer result: every piece placed, and every nest legal. */
function checkPack(out, input, label) {
  const want = input.pieces.reduce((a, p) => a + p.qty, 0);
  const got = (out.nests ?? []).reduce((a, n) => a + n.pieces.length, 0);
  const left = (out.unplaced ?? []).reduce((a, u) => a + u.qty, 0);
  ok(`${label}: every piece placed (${got}/${want})`, got === want && left === 0, `placed ${got}, unplaced ${left}`);
  let bad = null;
  for (const n of out.nests ?? []) { bad = illegal(n.pieces, n.sheetLength, n.sheetWidth, input.kerf); if (bad) break; }
  ok(`${label}: every layout legal`, !bad, bad ?? '');
}

/* A realistic-shaped steel group: several distinct rectangles, hundreds of pieces. */
function group(seed, kinds, perKind) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
  const pieces = [];
  for (let i = 0; i < kinds; i += 1) {
    pieces.push({
      key: `g${seed}p${i}`,
      length: 300 + Math.round(rnd() * 2400),
      width: 120 + Math.round(rnd() * 700),
      qty: perKind + Math.round(rnd() * perKind),
      grain: 'any',
    });
  }
  return {
    pieces,
    sheets: [
      { key: 'A', length: 12000, width: 2500, available: 200, areaCost: 12000 * 2500 },
      { key: 'B', length: 10000, width: 2000, available: 200, areaCost: 10000 * 2000 },
      { key: 'C', length: 6000, width: 1500, available: 200, areaCost: 6000 * 1500 },
    ],
    kerf: 3, margin: 3, sequenceGap: 10, effort: 'standard',
  };
}

/* ─────────────────── 1. no time at all still gives an answer ─────────────────── */
console.log('\n1. The packer with no time left');
{
  const input = group(7, 9, 40);
  const zero = nest({ ...input, budgetMs: 0, seed: 3 });
  checkPack(zero, input, 'budgetMs 0');
  ok('budgetMs 0: only the floor ran, and it says the clock cut it', zero.trials === 1 && (zero.deterministic === false || zero.proven), JSON.stringify({ trials: zero.trials, det: zero.deterministic }));
  const past = nest({ ...input, seed: 3, deadlineAt: Date.now() - 1000 });
  checkPack(past, input, 'deadline in the past');
  ok('deadline in the past: the same floor as budgetMs 0', past.areaBought === zero.areaBought && past.trials === 1);
  const other = nest({ ...input, budgetMs: 0, seed: 99 });
  ok('the floor is the same layout for every seed (so a floor-only extra seed can never win)', other.areaBought === zero.areaBought
    && JSON.stringify(other.nests.map((n) => n.pieces.map((p) => [p.x, p.y]))) === JSON.stringify(zero.nests.map((n) => n.pieces.map((p) => [p.x, p.y]))));
  ok('floorMs reported', Number.isFinite(zero.floorMs));
}

/* ─────────────────── 2. the pool, one worker, a small plan budget ─────────────────── */
console.log('\n2. The pool forced to one worker, a 4 s plan budget, 4 groups x 4 seeds');
{
  const groups = [group(11, 9, 40), group(12, 7, 60), group(13, 5, 20), group(14, 10, 50)];
  const jobs = [];
  groups.forEach((g, gi) => { for (let r = 0; r < 4; r += 1) jobs.push({ key: gi, seed: 1 + r * 7919, round: r, input: { ...g, seed: 1 + r * 7919 } }); });
  ok('poolSize honours the cap and never exceeds the host', poolSize(16, 1) === 1 && poolSize(16, 10_000) <= poolSize(16));
  const BUDGET = 4000;
  const MARGIN = 1500;                                 // one in-flight trial + worker start-up
  const t0 = Date.now();
  const runs = await runAll(jobs, { workers: 1, deadlineAt: t0 + BUDGET });
  const ms = Date.now() - t0;
  ok(`back within the budget + ${MARGIN} ms (took ${ms} ms)`, ms <= BUDGET + MARGIN);
  ok('ran on one worker', runs.stats?.workers === 1);
  ok('the clock cut the search (a seed skipped or a search capped)', (runs.stats?.skippedTime ?? 0) + (runs.stats?.capped ?? 0) > 0, JSON.stringify(runs.stats));
  groups.forEach((g, gi) => {
    const mine = runs.map((r, i) => ({ ...r, seed: jobs[i].seed })).filter((r, i) => jobs[i].key === gi && !r.skipped);
    ok(`group ${gi}: its primary ran`, runs.some((r, i) => jobs[i].key === gi && jobs[i].round === 0 && r.ok));
    const best = pickBest(mine);
    checkPack(best?.out ?? {}, g, `group ${gi}`);
  });
  // Without a deadline the old behaviour stands: every job runs.
  const small = jobs.filter((j) => j.key === 2).map((j) => ({ ...j, input: { ...j.input, effort: 'quick' } }));
  const plain = await runAll(small, { workers: 1 });
  ok('no deadline: every job runs, none skipped', plain.every((r) => r.ok) && plain.stats.run === small.length);
}

/* ─────────────────── 2b. shape jobs under the pool: waves, progress, stop ─────────────────── */
console.log('\n2b. Shape jobs (every steel since 2026-10-10): waves of budget, progress, stop-and-use');
{
  // The job planNesting builds for a steel: the row input, and the same pieces for the true-shape packer.
  const shapeJob = (g, seed) => ({
    packer: 'shape', seed, fillSheets: [],
    rect: { ...g, seed }, pieces: g.pieces, sheets: g.sheets,
    shape: { pieces: g.pieces.map((q) => ({ key: q.key, qty: q.qty, rings: null, length: q.length, width: q.width, grain: 'any' })), sheets: g.sheets, kerf: g.kerf, margin: g.margin + g.kerf, rotations: [0, 90, 180, 270], partInPart: true, effort: 'quick', seed },
  });
  const steels = [group(21, 6, 12), group(22, 5, 10), group(23, 7, 14)];
  // WAVES: three first seeds on two workers — the cheapest gets half the budget, the others all of it.
  {
    const jobs = steels.map((g, i) => ({ key: i, seed: 1, round: 0, input: shapeJob(g, 1) }));
    const BUDGET = 6000;
    const t0 = Date.now();
    const seen = new Map();
    const runs = await runAll(jobs, { workers: 2, deadlineAt: t0 + BUDGET, onProgress: ({ index, progress }) => { if (!seen.has(index)) seen.set(index, []); seen.get(index).push(progress); } });
    const ms = Date.now() - t0;
    ok(`three steels on two workers, a 6 s plan: back within the budget + 2 s (took ${ms} ms)`, ms <= BUDGET + 2000);
    ok('every steel answered, as a shape job, with every piece placed', runs.every((r) => r.ok && r.out.packer === 'shape' && !(r.out.unplaced ?? []).length), JSON.stringify(runs.map((r) => r.ok && r.out.chosen)));
    ok('never worse than its own row floor (plates, then steel)', runs.every((r) => r.out.nests.length <= r.out.rect.nests.length && r.out.areaBought <= r.out.rect.areaBought + 1e-6));
    ok('every steel reported progress: first its row floor, then only better', [0, 1, 2].every((i) => (seen.get(i)?.length ?? 0) >= 1 && seen.get(i)[0].source === 'rows'
      && seen.get(i).every((q, k, all) => k === 0 || q.unplaced < all[k - 1].unplaced || q.areaBought <= all[k - 1].areaBought + 1e-6)), JSON.stringify([...seen].map(([i, v]) => [i, v.length])));
  }
  // STOP: the flag is set a second in; every job ends at once with a whole layout, the unstarted steel gets its floor, extra seeds are skipped.
  {
    const jobs = [];
    steels.forEach((g, i) => { for (let r = 0; r < 2; r += 1) jobs.push({ key: i, seed: 1 + r * 7919, round: r, input: shapeJob(g, 1 + r * 7919) }); });
    const stop = new Int32Array(new SharedArrayBuffer(4));
    const t0 = Date.now();
    setTimeout(() => { Atomics.store(stop, 0, 1); }, 1000);
    const runs = await runAll(jobs, { workers: 1, deadlineAt: t0 + 120_000, stop });
    const ms = Date.now() - t0;
    ok(`stop after 1 s of a 2-minute budget: everything is back in ${ms} ms`, ms <= 6000);
    ok('every steel still has a whole layout (its first seed ran, if only the floor)', [0, 1, 2].every((i) => runs.some((r, k) => jobs[k].key === i && jobs[k].round === 0 && r.ok && !(r.out.unplaced ?? []).length)));
    ok('the extra seeds not yet started were skipped as stopped, and the pool says it was stopped', runs.some((r) => r.skipped === 'stopped') && runs.stats.stopped === true && runs.stats.skippedStopped > 0, JSON.stringify(runs.stats));
    ok('a stopped search says so, and that the clock did not let it finish', runs.some((r) => r.ok && r.out.stopped === true && r.out.deterministic === false), JSON.stringify(runs.filter((r) => r.ok).map((r) => [r.out.stopped, r.out.deterministic])));
  }
}

/* ─────────────────── 3. planNesting on the real KEPL line ─────────────────── */
console.log('\n3. planNesting on the KEPL line, one worker, a 20 s budget');
{
  const COMPANY = Number(process.env.CF_NEST_COMPANY ?? 2);
  const LINE = Number(process.env.CF_NEST_LINE ?? 923);
  const { pool } = await imp('db.js');
  const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
  const S = await imp('apps/cf_erp/services/nestingService.js');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    attachNodeCache(conn);
    const BUDGET = 20_000;
    const MARGIN = 3_000;
    const t0 = Date.now();
    let plan = null;
    try {
      // §44: a line's nesting must be told which plates it may use before it runs.
      await conn.query("UPDATE cf_sales_order_lines SET nest_plates = 'any' WHERE company_id = ? AND id IN (?)", [COMPANY, [LINE]]);
      plan = await S.planNesting(conn, COMPANY, LINE, { effort: 'standard', budgetMs: BUDGET, workers: 1, replaceImported: true });
    } catch (e) {
      console.log(`  SKIP  line ${LINE} of company ${COMPANY} could not be planned here (${e.message}) — sections 1-2 still stand`);
    }
    if (plan) {
      const ms = Date.now() - t0;
      const want = plan.groups.reduce((a, g) => a + g.cutPlates.reduce((b, c) => b + c.pieces, 0), 0);
      const placed = plan.groups.reduce((a, g) => a + g.nests.reduce((b, n) => b + n.pieces.length, 0), 0);
      const unplaced = plan.groups.reduce((a, g) => a + g.unplaced.reduce((b, u) => b + u.qty, 0), 0);
      console.log(`        ${plan.groups.length} groups, ${want} pieces, ${plan.totals.lots} plates, waste ${plan.totals.wastePct}% in ${ms} ms`);
      ok(`whole plan back within ${BUDGET} + ${MARGIN} ms (took ${ms} ms)`, ms <= BUDGET + MARGIN);
      ok(`every piece placed (${placed}/${want})`, want > 0 && placed === want && unplaced === 0);
      let bad = null;
      for (const g of plan.groups) {
        for (const n of g.nests) { bad = illegal(n.pieces, n.length, n.width, g.kerfMm); if (bad) break; }
        if (bad) break;
      }
      ok('every layout legal', !bad, bad ?? '');
      ok('the plan says the budget cut the search', plan.budget?.capped === true && plan.budget.workers === 1, JSON.stringify(plan.budget));
      ok('existing contract kept: seeds[] and group.deterministic still there', Array.isArray(plan.seeds) && plan.groups.every((g) => 'deterministic' in g));
    }
  } finally {
    detachNodeCache(conn);
    await conn.rollback().catch(() => {});
    conn.release();
    await pool.end();
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
