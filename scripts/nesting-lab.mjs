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
function ruinRecreate(rowsIn, specs, margin, deadline, seed = 7) {
  const rng = mulberry32(seed);
  let best = nest(rowsIn, specs, { restarts: 8, margin });
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

    const redone = nest(freed, specs, { restarts: 4, margin, seed: Math.floor(rng() * 1e9) });
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

const ALGOS = [
  ['A greedy', (g) => nest(g.rows, g.candidates, { restarts: 1, margin: MARGIN })],
  ['B restarts x1000', (g) => nest(g.rows, g.candidates, { restarts: 1000, margin: MARGIN })],
  ['C ruin & recreate', (g) => ruinRecreate(g.rows, g.candidates, MARGIN, Date.now() + perGroupBudget)],
  ['D pattern pick', (g) => patternPick(g.rows, g.candidates, MARGIN, 12, Date.now() + perGroupBudget)],
];

const results = [];
for (const [name, run] of ALGOS) {
  const t0 = Date.now();
  let area = 0; let part = 0; let tonnes = 0; let plateCount = 0; let unplaced = 0;
  for (const g of prepared) {
    const res = run(g);
    area += res.plates.reduce((a, p) => a + areaOf(p), 0);
    part += res.plates.reduce((a, p) => a + usedArea(p), 0);
    tonnes += tonnesOf(res.plates, g.thickness);
    plateCount += res.plates.length;
    unplaced += res.unplaced.length;
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
  });
  const r = results[results.length - 1];
  console.log(`${name.padEnd(20)} ${String(r.seconds).padStart(7)}s  ${String(r.plates).padStart(4)} plates  `
    + `${String(r.plateAreaM2).padStart(7)} m2  waste ${String(r.wastePct).padStart(5)}%  ${String(r.steelTonnes).padStart(7)} t`
    + (r.unplaced ? `  UNPLACED ${r.unplaced}` : ''));
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
