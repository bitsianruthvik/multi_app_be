/**
 * nest_v2_scale_bench.mjs — how long, how much memory and how good, on a job the size of the KEPL
 * bridge order (lib/nestScaleJob.mjs). No database: the jobs are built exactly as
 * nestingService.planNesting builds them and go through the SAME worker pool
 * (lib/packerPool.runAll → services/nestingWorker.js → services/packJob.js), under the plan's
 * one deadline. Not a pass/fail suite — it prints a table. (nest_v2_scale_test.mjs is the suite.)
 *
 *   cd multi_app_be && node scripts/cf_kepl/nest_v2_scale_bench.mjs [quick standard deep] [--workers=1] [--budget=ms] [--rect-only] [--fill=40]
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { runAll, pickBest, seedsFor } = await imp('apps/cf_erp/lib/packerPool.js');
const { EFFORT } = await imp('apps/cf_erp/services/nestingPacker.js');
// The run budgets (5 / 10 / 20 min) without pulling the database in: the same table nestingService exports.
const RUN_BUDGET_MS = { quick: 5 * 60_000, standard: 10 * 60_000, deep: 20 * 60_000, long: 60 * 60_000 };
const { rimOf: rimRule } = await imp('apps/cf_erp/services/nestShapes.js');
// BENCH_OLD_RIM=1: the shape path as it was before the rim was made one rule (one kerf, not two).
// BENCH_RIM_EXTRA=1: both packers as they were until 2026-10-10 — TWO kerfs at the plate edge — to measure what one kerf buys.
const rimOf = (k) => (process.env.BENCH_OLD_RIM === '1' ? { ...rimRule(k), shapeMargin: k }
  : process.env.BENCH_RIM_EXTRA != null ? { ...rimRule(k), rectMargin: Number(process.env.BENCH_RIM_EXTRA) * k, shapeMargin: (1 + Number(process.env.BENCH_RIM_EXTRA)) * k, clearance: (1 + Number(process.env.BENCH_RIM_EXTRA)) * k }
    : rimRule(k));
const { scaleGroups, inputsOf } = await imp('scripts/cf_kepl/lib/nestScaleJob.mjs');

const args = process.argv.slice(2);
const flag = (name) => { const a = args.find((x) => x.startsWith(`--${name}`)); return a ? (a.includes('=') ? a.split('=')[1] : true) : null; };
const efforts = args.filter((a) => !a.startsWith('--'));
const workers = flag('workers') ? Number(flag('workers')) : null;
const fillN = flag('fill') ? Number(flag('fill')) : 0;

export async function runPlan(groups, { effort, shapes, workers: cap = null, budgetMs = null, fillSheetsOf = null }) {
  const level = EFFORT[effort === 'long' ? 'deep' : effort];
  const seedCount = level.seeds ?? 1;
  // planNesting's rule: a plan with true-shape jobs has at least the shape packer's own allowance.
  const planBudgetMs = budgetMs ?? (shapes ? RUN_BUDGET_MS[effort] : level.capMs);
  const t0 = Date.now();
  const deadlineAt = t0 + planBudgetMs - Math.min(30_000, Math.round(planBudgetMs * 0.1));
  const jobs = [];
  for (const g of groups) {
    const { packInput, shapeInput } = inputsOf(g, { effort, rim: rimOf(g.kerf), shapes, every: shapes });
    const fillSheets = fillSheetsOf ? fillSheetsOf(g) : [];
    seedsFor(1, seedCount).forEach((seed, round) => jobs.push({
      key: g.key, seed, round,
      input: shapeInput || fillSheets.length
        ? { packer: 'shape', seed, rect: { ...packInput, seed }, shape: { ...(shapeInput ?? inputsOf(g, { effort, rim: rimOf(g.kerf), shapes: true, forceShape: true }).shapeInput), seed }, fillSheets, pieces: packInput.pieces, sheets: packInput.sheets }
        : { ...packInput, seed },
    }));
  }
  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
  let peak = 0;
  const tick = setInterval(() => { const r = process.memoryUsage().rss; if (r > peak) peak = r; }, 50);
  const runs = await runAll(jobs, { workers: cap, deadlineAt });
  clearInterval(tick); lag.disable();
  const wall = Date.now() - t0;
  let plates = 0; let bought = 0; let parts = 0; let off = 0; let shapeTaken = 0; let filled = 0;
  for (const g of groups) {
    const mine = runs.map((r, i) => ({ ...r, seed: jobs[i].seed, key: jobs[i].key })).filter((r) => r.key === g.key && !r.skipped);
    const best = pickBest(mine)?.out ?? {};
    plates += (best.nests ?? []).length;
    bought += Number(best.areaBought) || 0;
    off += (best.unplaced ?? []).reduce((a, u) => a + (Number(u.qty) || 0), 0);
    if (best.chosen === 'shape') shapeTaken += 1;
    filled += (best.fill?.nests ?? []).reduce((a, n) => a + (n.placements?.length ?? 0), 0);
    parts += g.parts.reduce((a, p) => a + (p.rings ? areaOf(p.rings) : p.length * p.width) * p.qty, 0);
  }
  return { effort, shapes, wall, budget: planBudgetMs, peakMb: Math.round(peak / 1048576), lagMaxMs: Math.round(lag.max / 1e6), plates, boughtM2: +(bought / 1e6).toFixed(1), wastePct: +(100 * (1 - parts / bought)).toFixed(2), off, shapeTaken, filled, stats: runs.stats };
}
const ringArea = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(a / 2); };
function areaOf(rings) { const o = Array.isArray(rings) ? { outline: rings[0], cutouts: rings.slice(1), holes: [] } : rings; return ringArea(o.outline) - [...(o.cutouts ?? []), ...(o.holes ?? [])].reduce((a, h) => a + ringArea(h), 0); }

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const groups = scaleGroups();
  const pieces = groups.reduce((a, g) => a + g.parts.reduce((b, p) => b + p.qty, 0), 0);
  const parts = groups.reduce((a, g) => a + g.parts.length, 0);
  const drawn = groups.reduce((a, g) => a + g.parts.filter((p) => p.rings).length, 0);
  console.log(`job: ${pieces} pieces, ${parts} cut plates (${drawn} drawn), ${groups.length} thickness groups`);
  const rows = [];
  for (const effort of efforts.length ? efforts : ['quick']) {
    for (const shapes of flag('rect-only') ? [false] : flag('shape-only') ? [true] : [false, true]) {
      const r = await runPlan(groups, { effort, shapes, workers, budgetMs: flag('budget') ? Number(flag('budget')) : null });
      rows.push(r);
      console.log(JSON.stringify({ ...r, stats: undefined, workers: r.stats?.workers, jobsRun: r.stats?.run, skipped: r.stats?.skippedTime, capped: r.stats?.capped }));
    }
  }
  void fillN;
}
