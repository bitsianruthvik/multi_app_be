/**
 * nest_extras_test.mjs — the length combiner (nestCutStock.js), the pairing of irregular shapes (nestPairs.js) and their
 * phase / switches (nestExtras.js), 2026-11-11. No database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nest_extras_test.mjs
 *
 *   1. switches: `combiner` / `pairs` in the custom-plate JSON, ON unless set false;
 *   2. the combiner on a steel of long plates: every piece once, every plate verifies, the size limit kept;
 *   3. never worse: the combiner phase takes its answer only when the pool's ranking says it is better — against an
 *      impossibly good packer answer it is never taken, and whatever it does the steel's score never goes up;
 *   4. time: a job past its hard wall clock is killed, its worker replaced, the next job still runs; a phase with no time
 *      leaves the packers' answer in place;
 *   5. pairs: clusters of irregular parts, every member put back EXACTLY (its own placement gives the same outline), a
 *      kerf between members; a pairs job places every piece once, verifies, and explodes with no failure.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const CS = await imp('apps/cf_erp/services/nestCutStock.js');
const PR = await imp('apps/cf_erp/services/nestPairs.js');
const EX = await imp('apps/cf_erp/services/nestExtras.js');
const { runPackJob } = await imp('apps/cf_erp/services/packJob.js');
const { verifyLayout, placeRings } = await imp('apps/cf_erp/services/shapePacker.js');
const { runAll } = await imp('apps/cf_erp/lib/packerPool.js');
const NC = await imp('apps/cf_erp/services/nestCost.js');
const { setDist, bbox } = await imp('apps/cf_erp/services/nestRingMath.js');

let passed = 0; let failed = 0;
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || typeof cond !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const rect = (l, w) => ({ outline: [[0, 0], [l, 0], [l, w], [0, w]], cutouts: [], holes: [] });
const KERF = 5; const T = 32;

/** A shape job's input, as nestingService builds it. */
function jobOf(pieces, sizes, { effort = 'quick', budgetMs = 8000 } = {}) {
  const costs = NC.plateCosts(sizes.map(([L, W]) => ({ length: L, width: W, kind: 'STANDARD' })));
  const sheets = sizes.map(([L, W], i) => ({ key: `pl${i}`, length: L, width: W, available: 60, preferred: false, areaCost: costs[i].areaCost, penalty: costs[i].penalty }));
  const rectPieces = pieces.map((p) => ({ key: p.key, length: p.length, width: p.width, qty: p.qty, grain: 'any' }));
  return {
    packer: 'shape', seed: 1, budgetMs, deadlineAt: Date.now() + budgetMs, pieces: rectPieces, sheets,
    rect: { pieces: rectPieces, sheets: sheets.map(({ penalty, ...s }) => s), kerf: KERF, gap: KERF, margin: 0, thickness: T, sequenceGap: 0, smallThreshold: 200, rowsPerSequence: { small: 2, big: 3 }, guillotine: false, effort, seed: 1 },
    shape: { pieces: pieces.map((p) => ({ ...p, grain: 'any', allowMirror: false })), sheets, kerf: KERF, margin: KERF, rotations: [0, 90, 180, 270], partInPart: true, effort, seed: 1,
      costRules: NC.costRulesFor(T, {}), gap: KERF, sharedCuts: true },
  };
}
const verifyAll = (out, sheets, ringsBy = new Map()) => (out.nests ?? []).every((n) => {
  const s = sheets.find((x) => x.key === n.sheetKey) ?? { length: n.sheetLength, width: n.sheetWidth };
  return verifyLayout({ sheet: { length: s.length, width: s.width }, placements: n.placements.map((q) => ({ key: q.key, rings: q.rings ?? placeRings(ringsBy.get(String(q.key)), q) })), kerf: KERF, margin: KERF }).ok;
});
const counts = (out) => { const m = new Map(); for (const n of out.nests ?? []) for (const q of n.placements ?? []) m.set(String(q.key), (m.get(String(q.key)) ?? 0) + 1); return m; };
const sameCounts = (out, pieces) => pieces.every((p) => (counts(out).get(p.key) ?? 0) === p.qty) && [...counts(out).keys()].every((k) => pieces.some((p) => p.key === k));

console.log('\n1. switches');
{
  ok('absent → both on', JSON.stringify(EX.extrasOf(null)) === '{"combiner":true,"pairs":true}');
  ok('set false in the JSON → off, the other on', JSON.stringify(EX.extrasOf('{"on":true,"premiumPct":10,"combiner":false}')) === '{"combiner":false,"pairs":true}' && EX.extrasOf({ pairs: false }).pairs === false);
}

// long plates whose lengths add up to a plate, and a few short ones
const LONG = [
  { key: 'W7300', qty: 6, length: 7300, width: 1075, rings: rect(7300, 1075) },
  { key: 'W4495', qty: 6, length: 4495, width: 1075, rings: rect(4495, 1075) },
  { key: 'F9975', qty: 4, length: 9975, width: 650, rings: rect(9975, 650) },
  { key: 'S600', qty: 10, length: 600, width: 300, rings: rect(600, 300) },
];
const SIZES = [[12000, 2500], [10000, 2500], [12000, 2000]];

console.log('\n2. the combiner on long plates');
let csOut = null; let packed = null;
{
  const base = jobOf(LONG, SIZES);
  packed = runPackJob(base);
  const job = { ...base, packer: 'cutstock', budgetMs: 60_000, deadlineAt: Date.now() + 60_000, cutstock: { effort: 'quick', engine: null } };
  csOut = await runPackJob(job);
  ok('an answer', !csOut.none, csOut.none ?? '');
  if (!csOut.none) {
    ok('every piece exactly once', sameCounts(csOut, LONG));
    ok('every plate verifies (kerf, rim, no overlap)', verifyAll(csOut, base.shape.sheets, new Map(LONG.map((p) => [p.key, p.rings]))));
    ok('no more plate sizes than the limit (2)', new Set(csOut.nests.map((n) => n.sheetKey)).size <= 2 && csOut.sizeOver === 0);
    ok('scored by the plan\'s own rules', Number.isFinite(csOut.score) && csOut.score > 0);
    console.log(`     packers ${packed.nests.length} plates score ${Math.round(packed.score)}; combiner ${csOut.nests.length} plates score ${Math.round(csOut.score)}`);
  }
}

console.log('\n3. never worse');
{
  const base = jobOf(LONG, SIZES);
  // an impossibly good packer answer: the combiner can never beat it
  const fake = { ...packed, score: 1, areaBought: 1 };
  const outBy = new Map([['g', fake]]);
  const sheets = base.shape.sheets.slice();
  const rep = await EX.cutStockPhase([{ key: 'g', base, sheets, custom: null, seed: 1 }], outBy, { effort: 'quick', standIn: () => { throw new Error('no stand-in expected'); } });
  ok('against a better answer the combiner is not taken', rep[0]?.taken === false && outBy.get('g') === fake, JSON.stringify(rep[0]));
  const outBy2 = new Map([['g', packed]]);
  const rep2 = await EX.cutStockPhase([{ key: 'g', base, sheets, custom: null, seed: 1 }], outBy2, { effort: 'quick', standIn: () => null });
  const after = outBy2.get('g');
  ok('the steel\'s score never goes up', Number(after.score) <= Number(packed.score) + 1e-6, `${after.score} vs ${packed.score}`);
  ok('taken only when strictly better', !rep2[0]?.taken || Number(after.score) < Number(packed.score) - 1e-6);
  ok('a second run of the same pieces comes from the cache', (await EX.cutStockPhase([{ key: 'g', base, sheets, custom: null, seed: 1 }], new Map([['g', packed]]), { effort: 'quick', standIn: () => null }))[0]?.cached === true);
  const one = new Map([['g', { ...packed, nests: packed.nests.slice(0, 1) }]]);
  ok('a steel on one plate is not tried', (await EX.cutStockPhase([{ key: 'g', base, sheets, custom: null, seed: 1 }], one, { effort: 'quick', standIn: () => null }))[0]?.ran === false);
}

console.log('\n4. time');
{
  EX.clearExtrasCache();
  const base = jobOf(LONG, SIZES);
  const slow = { ...base, packer: 'cutstock', cutstock: { effort: 'deep', engine: null }, budgetMs: 600_000, deadlineAt: Date.now() + 600_000, hardDeadlineAt: Date.now() + 300 };
  const t0 = Date.now();
  const runs = await runAll([{ key: 'a', round: 0, seed: 1, input: slow }, { key: 'b', round: 0, seed: 1, input: { ...base, budgetMs: 3000, deadlineAt: Date.now() + 3000 } }], { workers: 1 });
  ok('the job past its hard limit is killed and answers no layout', runs[0]?.ok === false && runs[0]?.killed === true, JSON.stringify(runs[0]));
  ok('the next job still runs (worker replaced)', runs[1]?.ok === true && (runs[1].out?.nests ?? []).length > 0);
  ok('within seconds, not the job\'s own ten minutes', Date.now() - t0 < 30_000, `${Date.now() - t0} ms`);
  const outBy = new Map([['g', packed]]);
  const rep = await EX.cutStockPhase([{ key: 'g', base, sheets: base.shape.sheets.slice(), custom: null, seed: 1 }], outBy, { effort: 'quick', budgetMs: 1, standIn: () => null });
  ok('a phase with no time leaves the packers\' answer', outBy.get('g') === packed && rep[0]?.taken !== true, JSON.stringify(rep[0]));
}

console.log('\n5. pairs');
{
  // an L (fill 0.5) and a triangle-ish gusset: two of them nest into each other's notch
  const L = { outline: [[0, 0], [1200, 0], [1200, 300], [300, 300], [300, 1200], [0, 1200]], cutouts: [], holes: [] };
  const G = { outline: [[0, 0], [900, 0], [0, 700]], cutouts: [], holes: [] };
  const pieces = [{ key: 'L', qty: 8, length: 1200, width: 1200, rings: L }, { key: 'G', qty: 6, length: 900, width: 700, rings: G }];
  const found = PR.findClusters(pieces, { kerf: KERF, fit: { long: 11980, short: 2480 }, budgetMs: 20_000 });
  ok('clusters found for parts that fit into each other', found.clusters.length > 0, JSON.stringify(found).slice(0, 200));
  const ringsOf = new Map(pieces.map((p) => [p.key, p.rings]));
  let exact = true; let apart = true;
  for (const c of found.clusters) {
    const rings = c.members.map((m) => placeRings({ outline: ringsOf.get(m.key).outline, cutouts: [], holes: [] }, { x: m.x, y: m.y, rotationDeg: m.rot }).outline);
    for (let i = 0; i < rings.length; i++) for (let j = i + 1; j < rings.length; j++) if (setDist([rings[i]], [rings[j]], KERF + 1) < KERF) apart = false;
    const b = bbox(c.outline);
    for (const rot of [0, 90, 180, 270]) {
      const ex = PR.explodeNests([{ sheetKey: 's', placements: [{ key: c.key, x: 1000, y: 500, rotationDeg: rot }] }], new Map([[c.key, c]]), ringsOf);
      if (ex.failures) exact = false;
      for (const q of ex.nests[0].placements) {
        const own = placeRings(ringsOf.get(q.key), { x: q.x, y: q.y, rotationDeg: q.rotationDeg });
        if (own.outline.some(([x, y], k) => Math.abs(x - q.rings.outline[k][0]) > 1e-6 || Math.abs(y - q.rings.outline[k][1]) > 1e-6)) exact = false;
      }
      void b;
    }
  }
  ok('every member put back exactly, at every quarter turn of its cluster', exact);
  ok('members a kerf apart inside a cluster', apart);
  const base = jobOf(pieces, [[3000, 1500], [2500, 1250]], { budgetMs: 8000 });
  const out = await runPackJob({ ...base, packer: 'pairs', pairs: { searchMs: 15_000 } });
  ok('a pairs job places every piece once, real parts only', sameCounts(out, pieces) && (out.unplaced ?? []).length === 0);
  ok('its plates verify', verifyAll(out, base.shape.sheets, new Map(pieces.map((p) => [p.key, p.rings]))));
  ok('it used clusters and exploded them all', out.pairs?.used > 0 && out.pairs?.explodeFailures === 0, JSON.stringify(out.pairs ?? {}).slice(0, 200));
  const again = await runPackJob({ ...base, packer: 'pairs', pairs: { clusters: out.pairs.clusters, searchMs: 15_000 } });
  ok('handed its clusters again, it skips the search', again.pairs?.cached === true && sameCounts(again, pieces));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
