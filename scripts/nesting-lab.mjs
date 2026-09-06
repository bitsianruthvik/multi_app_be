/**
 * nesting-lab.mjs — four nesting strategies on the same real order, compared.
 *
 * NOT PRODUCTION. The shipped packer is A and B below; C and D live here so
 * they can be measured against real parts before anything is decided. Nothing
 * is written to the database.
 *
 * All four are scored the same way: PLATE AREA BOUGHT. Utilisation is a
 * per-plate ratio and improves by using more plates, so it is the wrong
 * objective; area bought is the money. Every run uses the same cutting margin.
 *
 *   A  Greedy            one deterministic pass — today's answer
 *   B  GRASP restarts    run it N times with the choice wobbled, keep the best
 *   C  Ruin & recreate   from B, tear up a few plates and re-nest their parts
 *   D  Pattern picking   for every plate size try K fills, commit the best one
 *
 *   node scripts/nesting-lab.mjs <orderId> [margin] [budgetSeconds]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const orderId = Number(process.argv[2]);
const MARGIN = Number(process.argv[3] ?? 50);
const BUDGET = Number(process.argv[4] ?? 300);

const __dir = path.dirname(fileURLToPath(import.meta.url));
const env = {};
fs.readFileSync(path.join(__dir, '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
  l = l.trim(); if (!l || l.startsWith('#')) return;
  const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
});
Object.assign(process.env, {
  DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER,
  DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true',
});

const { pool } = await import('../db.js');
const {
  nest, fillOne, mulberry32, areaOf, usedArea, rowFitsSpec,
} = await import('../apps/fab_erp/services/nestingPacker.js');
const {
  nestableParts, plateCatalog, offcutSpecs,
} = await import('../apps/fab_erp/services/nestingSuggestService.js');
const { plateFits } = await import('../apps/fab_erp/services/materialMatchService.js');

const COMPANY = 30005;
const DENSITY = 7.85 / 1000; // t per m2 per mm

// ── prepare the same groups the suggestor builds ───────────────────────────
const { rows: allRows } = await nestableParts(COMPANY, orderId, { includeNested: true });
const plates = await plateCatalog(COMPANY);
const offcuts = await offcutSpecs(COMPANY, [...new Set(allRows.map((r) => r.currentMaterialId).filter(Boolean))]);

const groups = new Map();
for (const r of allRows) {
  const grade = r.grade ?? null;
  const material = r.material ?? null;
  if (grade == null || material == null) continue; // refused, as production does
  const key = `${r.thickness}|${grade}|${material}`;
  if (!groups.has(key)) groups.set(key, { thickness: r.thickness, grade, material, rows: [] });
  groups.get(key).rows.push(r);
}
const prepared = [...groups.values()].map((g) => ({
  ...g,
  candidates: [
    ...offcuts.filter((o) => g.rows.some((r) => r.currentMaterialId === o.catalogItemId)),
    ...plates.filter((p) => plateFits(g, p)),
  ],
})).filter((g) => g.candidates.length);

console.log(`order ${orderId} · margin ${MARGIN} mm · ${prepared.length} groups · `
  + `${prepared.reduce((a, g) => a + g.rows.length, 0)} rows\n`);

const tonnesOf = (plateList, thickness) =>
  plateList.reduce((a, p) => a + (areaOf(p) / 1e6) * thickness * DENSITY, 0);

// ── C: ruin & recreate ─────────────────────────────────────────────────────
/**
 * Tear up a few plates and rebuild just those parts.
 *
 * A greedy answer is locally sensible everywhere and globally mediocre; the
 * cheapest way out is to destroy part of it and let the same greedy rebuild
 * that part against fresh choices. Kept only if the total area falls, so it
 * can never end worse than what it started from.
 */
function ruinRecreate(rowsIn, specs, margin, deadline, seed = 7, jitterPlacement = false) {
  const rng = mulberry32(seed);
  let best = nest(rowsIn, specs, { restarts: 8, margin, jitterPlacement, seed });
  let bestArea = best.plates.reduce((a, p) => a + areaOf(p), 0);

  while (Date.now() < deadline) {
    const keep = [];
    const freed = [];
    for (const p of best.plates) {
      // Bias the tear-up towards the emptiest plates — they are the ones worth
      // rebuilding, and a full plate rebuilt is almost always the same plate.
      const emptiness = 1 - usedArea(p) / areaOf(p);
      if (rng() < 0.15 + emptiness) freed.push(...p.rows); else keep.push(p);
    }
    if (!freed.length) continue;

    const redone = nest(freed, specs, {
      restarts: 4, margin, jitterPlacement, seed: Math.floor(rng() * 1e9),
    });
    if (redone.unplaced.length) continue;
    const area = keep.reduce((a, p) => a + areaOf(p), 0)
      + redone.plates.reduce((a, p) => a + areaOf(p), 0);
    if (area < bestArea) {
      best = { plates: [...keep, ...redone.plates], unplaced: [] };
      bestArea = area;
    }
  }
  return best;
}

// ── D: pattern picking ─────────────────────────────────────────────────────
/**
 * For each plate size, try K random fills; commit the single best pattern.
 *
 * The shipped loop tries every size ONCE, deterministically, and commits the
 * winner. This tries each size K ways before committing, so the plate it opens
 * is the best of many layouts rather than the best of one. Closer in spirit to
 * classic cutting stock, where you enumerate good patterns and then choose.
 */
function patternPick(rowsIn, specs, margin, K, deadline) {
  const rng = mulberry32(99);
  const out = [];
  let remaining = rowsIn.filter((r) => specs.some((s) => rowFitsSpec(r, s, margin)));
  const unplaced = rowsIn.filter((r) => !specs.some((s) => rowFitsSpec(r, s, margin)));

  while (remaining.length && out.length < 5000) {
    let best = null;
    for (const spec of specs) {
      for (let k = 0; k < K; k += 1) {
        if (Date.now() > deadline && best) break;
        const { plate, taken } = fillOne(spec, remaining, k === 0 ? null : rng, margin);
        if (!taken.size) continue;
        // Area efficiency of the plate we would BUY, not of what we place.
        const score = usedArea(plate) / areaOf(plate);
        if (!best || score > best.score) best = { plate, taken, score };
      }
    }
    if (!best) break;
    out.push(best.plate);
    remaining = remaining.filter((r) => !best.taken.has(r.key));
  }
  return { plates: out, unplaced: unplaced.map((r) => ({ row: r })) };
}

// ── run them ───────────────────────────────────────────────────────────────
const perGroupBudget = (BUDGET * 1000) / Math.max(1, prepared.length);

/**
 * E — SMALLEST VIABLE PLATE FIRST.
 *
 * Take the biggest part still unplaced, open the SMALLEST plate that can hold
 * it, fill that plate with whatever else fits, repeat.
 *
 * Different from the shipped loop in one specific way: that one tries every
 * plate size and keeps the best UTILISATION, which is a ratio. A ratio can be
 * flattered by a big sheet that happens to pack tidily, so the packer can burn
 * a 12 m plate on work a 3 m plate would have carried. This rule cannot do
 * that — the size is decided by the largest part that has to fit, and nothing
 * bigger is ever considered.
 *
 * The biggest part sets the floor because it is the binding constraint: any
 * plate too small for it is useless this round, and any plate bigger than the
 * smallest one that holds it is speculative.
 */
function smallestViable(rowsIn, specs, margin) {
  const fits = (r, s) => rowFitsSpec(r, s, margin);
  const out = [];
  let remaining = rowsIn.filter((r) => specs.some((s) => fits(r, s)));
  const unplaced = rowsIn.filter((r) => !specs.some((s) => fits(r, s))).map((row) => ({ row }));

  while (remaining.length && out.length < 5000) {
    const biggest = remaining.reduce((a, b) => (
      Math.max(b.length, b.width) > Math.max(a.length, a.width) ? b : a));
    const viable = specs
      .filter((s) => fits(biggest, s))
      .sort((a, b) => (a.length * a.width) - (b.length * b.width));
    if (!viable.length) {
      unplaced.push({ row: biggest });
      remaining = remaining.filter((r) => r !== biggest);
      continue;
    }
    const { plate, taken } = fillOne(viable[0], remaining, null, margin);
    if (!taken.size) { unplaced.push({ row: biggest }); remaining = remaining.filter((r) => r !== biggest); continue; }
    out.push(plate);
    remaining = remaining.filter((r) => !taken.has(r.key));
  }
  return { plates: out, unplaced };
}

/**
 * F — MERGE UPWARDS (agglomerative).
 *
 * Start with every part on its own smallest plate — the worst possible answer —
 * then repeatedly pair groups up and keep the merge whenever one plate costs
 * less than the two it replaces. Pairs become fours, fours become eights, so
 * group size doubles per pass rather than crawling 2, 3, 4.
 *
 * MONOTONE: a merge is kept only if the area falls, so this can never end worse
 * than where it started. That is its real virtue and also its problem — it
 * begins 1,090 plates away from a good answer and has to climb the whole way,
 * where ruin & recreate starts from a good answer and repairs it.
 *
 * Several random pairings, because which groups happen to meet decides what can
 * merge; a bad shuffle strands two halves that belonged together.
 */
function agglomerate(rowsIn, specs, margin, deadline, seeds = 5) {
  const fits = (r, s) => rowFitsSpec(r, s, margin);
  const placeable = rowsIn.filter((r) => specs.some((s) => fits(r, s)));
  const unplaced = rowsIn.filter((r) => !specs.some((s) => fits(r, s))).map((row) => ({ row }));
  const bySize = [...specs].sort((a, b) => (a.length * a.width) - (b.length * b.width));

  /** The cheapest single plate holding this whole set of rows, or null. */
  const bestPlateFor = (rows) => {
    for (const spec of bySize) {
      const { plate, taken } = fillOne(spec, rows, null, margin);
      if (taken.size === rows.length) return plate;
    }
    return null;
  };

  let best = null;
  let bestArea = Infinity;
  for (let s = 0; s < seeds && Date.now() < deadline; s += 1) {
    const rng = mulberry32(4242 + s * 104729);
    let groups = placeable.map((r) => ({ rows: [r], plate: bestPlateFor([r]) })).filter((g) => g.plate);

    let improved = true;
    while (improved && Date.now() < deadline) {
      improved = false;
      // Random pairing: shuffle, then try to merge neighbours.
      const order = [...groups].sort(() => rng() - 0.5);
      const next = [];
      for (let i = 0; i < order.length; i += 2) {
        const a = order[i];
        const b = order[i + 1];
        if (!b) { next.push(a); continue; }
        const merged = bestPlateFor([...a.rows, ...b.rows]);
        if (merged && areaOf(merged) < areaOf(a.plate) + areaOf(b.plate)) {
          next.push({ rows: [...a.rows, ...b.rows], plate: merged });
          improved = true;
        } else { next.push(a, b); }
      }
      groups = next;
    }
    const area = groups.reduce((acc, g) => acc + areaOf(g.plate), 0);
    if (area < bestArea) { bestArea = area; best = groups.map((g) => g.plate); }
  }
  return { plates: best ?? [], unplaced };
}

/**
 * MULTI-START ruin & recreate: several independent runs, budget split, best kept.
 *
 * A single long run keeps improving ONE arrangement, and can settle into a shape
 * it cannot dig its way out of. Several shorter runs each begin somewhere
 * different, so a bad opening costs a slice of the budget rather than all of it.
 * Which wins is an empirical question, not a theoretical one — hence both.
 */
function multiStart(rowsIn, specs, margin, totalMs, starts, jitterPlacement = false) {
  const slice = totalMs / starts;
  let best = null;
  let bestArea = Infinity;
  for (let i = 0; i < starts; i += 1) {
    const r = ruinRecreate(rowsIn, specs, margin, Date.now() + slice, 1000 + i * 7919, jitterPlacement);
    const area = r.plates.reduce((a, p) => a + areaOf(p), 0);
    if (area < bestArea) { best = r; bestArea = area; }
  }
  return best;
}

/**
 * A LADDER THAT SEPARATES THE TWO VARIABLES.
 *
 * "More starts with orientation" mixes two changes, and if the result moves
 * there is no way to say which did it. So the ladder walks the start count with
 * orientation ON, and carries two orientation-OFF controls at the same counts.
 * Every row gets the same wall-clock budget, which is the only fair comparison
 * when the budget is what is being spent.
 *
 * Expect a turning point. The budget is SPLIT across starts, so each start gets
 * less time as the count rises — and each one spends a fixed slice building its
 * initial solution before any ruin & recreate happens. Past some count every
 * start is doing nothing but that initial solve, and multi-start collapses into
 * plain restarts, which we already know is the weaker search.
 */
const ALGOS = [
  ['A  greedy', (g) => nest(g.rows, g.candidates, { restarts: 1, margin: MARGIN })],
  ['x4  no-orient', (g) => multiStart(g.rows, g.candidates, MARGIN, perGroupBudget, 4, false)],
  ['x4  + orient', (g) => multiStart(g.rows, g.candidates, MARGIN, perGroupBudget, 4, true)],
  ['x8  + orient', (g) => multiStart(g.rows, g.candidates, MARGIN, perGroupBudget, 8, true)],
  ['x8  no-orient', (g) => multiStart(g.rows, g.candidates, MARGIN, perGroupBudget, 8, false)],
  ['x16 + orient', (g) => multiStart(g.rows, g.candidates, MARGIN, perGroupBudget, 16, true)],
  ['x32 + orient', (g) => multiStart(g.rows, g.candidates, MARGIN, perGroupBudget, 32, true)],
];

const results = [];
for (const [name, run] of ALGOS) {
  const t0 = Date.now();
  let area = 0; let part = 0; let tonnes = 0; let plateCount = 0; let unplaced = 0;
  /**
   * ROWS ACTUALLY ON A PLATE, counted from the result rather than trusted.
   *
   * An algorithm that quietly drops a part reports less area, less tonnage and
   * a better score — it looks like the winner. F did exactly that on its first
   * run, coming out ~430 m2 of part short while claiming the lowest area. The
   * total has to equal the rows fed in, or the number means nothing.
   */
  let rowsIn = 0; let rowsOut = 0;
  for (const g of prepared) {
    const res = run(g);
    area += res.plates.reduce((a, p) => a + areaOf(p), 0);
    part += res.plates.reduce((a, p) => a + usedArea(p), 0);
    tonnes += tonnesOf(res.plates, g.thickness);
    plateCount += res.plates.length;
    unplaced += res.unplaced.length;
    rowsIn += g.rows.length;
    rowsOut += res.plates.reduce((a, p) => a + p.rows.length, 0) + res.unplaced.length;
  }
  const secs = Math.round((Date.now() - t0) / 100) / 10;
  results.push({
    algorithm: name,
    seconds: secs,
    plates: plateCount,
    plateAreaM2: Math.round(area / 1e6 * 10) / 10,
    wastePct: Math.round((1 - part / area) * 1000) / 10,
    steelTonnes: Math.round(tonnes * 100) / 100,
    unplaced,
    rowsLost: rowsIn - rowsOut,
  });
  const r = results[results.length - 1];
  console.log(`${name.padEnd(20)} ${String(r.seconds).padStart(7)}s  ${String(r.plates).padStart(4)} plates  `
    + `${String(r.plateAreaM2).padStart(7)} m2  waste ${String(r.wastePct).padStart(5)}%  ${String(r.steelTonnes).padStart(7)} t`
    + (r.unplaced ? `  UNPLACED ${r.unplaced}` : '')
    + (r.rowsLost ? `  *** LOST ${r.rowsLost} ROWS — RESULT INVALID ***` : ''));
}

console.log('\n=== comparison ===');
console.table(results);
const base = results[0];
for (const r of results.slice(1)) {
  const d = base.steelTonnes - r.steelTonnes;
  console.log(`${r.algorithm.padEnd(20)} ${d >= 0 ? 'saves' : 'COSTS'} ${Math.abs(d).toFixed(2)} t `
    + `(${((d / base.steelTonnes) * 100).toFixed(2)}%) for ${r.seconds}s`);
}
await pool.end();
