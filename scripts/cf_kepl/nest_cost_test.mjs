/**
 * nest_cost_test.mjs — what the AI plate nesting learned from the ProNest comparison (2026-10-18,
 * TM/nest_learning/COMPARE.md "what the AI should still learn" 1–6). No database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nest_cost_test.mjs
 *
 *   1. the cost rules (nestCost.js): plate price from the catalog rate, CUSTOM / short plates, handling,
 *      a penalty per extra size, kept remnants valued, sizes over the company's limit ranked first;
 *   2. plate-size discipline in the true-shape packer: never more sizes than the limit when fewer place everything;
 *   3. "fewest plates of the largest size that fits" is always tried (NITHINSAI 20 mm: one long plate, not two short);
 *   4. shop spacing on true shapes: a pair that cannot share a cut keeps the shop's block gap, a pair that can is a kerf apart;
 *   5. identical parts edge to edge on one shared cut, by default, where it costs no steel;
 *   6. the cut order: a small part filling a gap does not make the big parts after it "back-steps";
 *   7. what planNesting hands the packer (nestingService.shapeHabits) and how rows / shapes / seeds are ranked
 *      (packJob, packerPool.pickBest).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const NC = await imp('apps/cf_erp/services/nestCost.js');
const { packShapes, verifyLayout } = await imp('apps/cf_erp/services/shapePacker.js');
const { runPackJob } = await imp('apps/cf_erp/services/packJob.js');
const { pickBest } = await imp('apps/cf_erp/lib/packerPool.js');
const AC = await imp('apps/cf_erp/services/aiCutPlan.js');
const { shapeHabits } = await imp('apps/cf_erp/services/nestingService.js');
const { polygonsDistance, toPolygon } = await imp('apps/cf_erp/lib/polyGeom.js');

let passed = 0; let failed = 0;
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || typeof cond !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const J = (v) => JSON.stringify(v);
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const rect = (l, w) => ({ outline: [[0, 0], [l, 0], [l, w], [0, w]], cutouts: [], holes: [] });
const sizesOf = (out) => new Set(out.nests.map((n) => `${Math.max(n.sheetLength, n.sheetWidth)}x${Math.min(n.sheetLength, n.sheetWidth)}`));

console.log('\n1. The cost rules (nestCost.js)');
{
  ok('kg → mm² of plate: 7.85 kg is 1 000 000 mm² of 1 mm plate, 100 000 of 10 mm', near(NC.kgToArea(7.85, 1), 1e6) && near(NC.kgToArea(7.85, 10), 1e5));
  ok('a list price per tonne / per kg / per plate → per kg; none → null', NC.ratePerKg(62000, 'tonne', 100) === 62 && NC.ratePerKg(60, 'kg', 100) === 60 && NC.ratePerKg(5000, 'unit', 100) === 50 && NC.ratePerKg(null, 'tonne', 100) === null);
  const pc = NC.plateCosts([
    { length: 12000, width: 2000, kind: 'STANDARD', ratePerKg: null },
    { length: 12000, width: 2000, kind: 'CUSTOM', ratePerKg: null },
    { length: 2500, width: 2000, kind: 'STANDARD', ratePerKg: null },
  ]);
  ok('no price set: a plate costs its area; CUSTOM +2 %; a short plate (under half the longest) +3 %',
    pc[0].areaCost === 24e6 && pc[0].penalty === 0 && near(pc[1].penalty, 0.02 * 24e6) && near(pc[2].penalty, 0.03 * 5e6), J(pc));
  const pr = NC.plateCosts([{ length: 1000, width: 1000, kind: 'STANDARD', ratePerKg: 60 }, { length: 1000, width: 1000, kind: 'STANDARD', ratePerKg: 66 }, { length: 1000, width: 1000, kind: 'STANDARD', ratePerKg: 72 }, { length: 1000, width: 1000, kind: 'STANDARD' }]);
  ok('priced plates: area × rate ÷ the median rate; an unpriced one at the median', near(pr[0].areaCost, 1e6 * 60 / 66) && near(pr[1].areaCost, 1e6) && near(pr[2].areaCost, 1e6 * 72 / 66) && pr[3].areaCost === 1e6, J(pr));
  const R = NC.costRulesFor(20, { offcutMinArea: 90000, offcutMinSide: 100 });
  ok('the rules at 20 mm: at most 2 sizes, 150 kg per extra size, 20 kg handling a plate, remnants at half', R.maxSizes === 2 && near(R.sizePenalty, NC.kgToArea(150, 20)) && near(R.platePenalty, NC.kgToArea(20, 20)) && R.offcutValue === 0.5);
  ok('the company limit: 3 → 3, 0 → no limit', NC.costRulesFor(20, { maxSizes: 3 }).maxSizes === 3 && NC.costRulesFor(20, { maxSizes: 0 }).maxSizes === null);
  const rem = (maxX, maxY) => NC.remnantArea({ length: 12000, width: 2000, maxX, maxY, margin: 5, gap: 4, minArea: 90000, minSide: 100 });
  ok('a remnant: the clean strip at the plate end (full width) when it passes the offcut rule; 95 mm is scrap', near(rem(10000, 1995), (12000 - 10000 - 4 - 5) * 1990) && rem(11896, 1995) === 0, J([rem(10000, 1995), rem(11896, 1995)]));
  ok('…or the strip along the far side, if it is bigger', near(rem(11990, 1000), (2000 - 1000 - 4 - 5) * (11990 - 5)));
  const sheets = new Map([['a', { length: 12000, width: 2000, areaCost: 24e6, penalty: 0 }], ['b', { length: 7600, width: 2000, areaCost: 15.2e6, penalty: 1e5 }], ['c', { length: 6000, width: 2000, areaCost: 12e6, penalty: 0 }], ['own', { length: 6000, width: 2000, areaCost: 0, preferred: true }]]);
  const s1 = NC.layoutScore([{ sheetKey: 'a', extent: { maxX: 11990, maxY: 1995 } }, { sheetKey: 'b', extent: { maxX: 7590, maxY: 1995 } }, { sheetKey: 'c', extent: { maxX: 5990, maxY: 1995 } }, { sheetKey: 'own', extent: { maxX: 100, maxY: 100 } }], sheets, R);
  ok('a layout\'s score: price + penalties + handling per plate bought + a penalty per extra size; the customer\'s plate is not bought and is no size',
    s1.cost === 51.2e6 && s1.plates === 3 && s1.sizes === 3 && s1.sizeOver === 1 && near(s1.score, 51.2e6 + 1e5 + 3 * R.platePenalty + 2 * R.sizePenalty), J(s1));
  const s2 = NC.layoutScore([{ sheetKey: 'a', extent: { maxX: 6000, maxY: 1995 } }], sheets, R);
  ok('…less half the steel of a kept remnant at the plate end', near(s2.score, 24e6 + R.platePenalty - 0.5 * (12000 - 6000 - 0) * 2000), J(s2));
  ok('without rules the score is the steel bought, as before', NC.layoutScore([{ sheetKey: 'a' }, { sheetKey: 'b' }], sheets, null).score === 39.2e6);
  ok('ranking: pieces left off, then sizes over the limit, then the score', NC.compareScored({ off: 0, sizeOver: 1, score: 1 }, { off: 0, sizeOver: 0, score: 9 }) > 0 && NC.compareScored({ off: 0, sizeOver: 0, score: 9 }, { off: 1, sizeOver: 0, score: 1 }) < 0 && NC.compareScored({ off: 0, score: 2 }, { off: 0, score: 3 }) < 0);
}

console.log('\n2. Plate-size discipline: no more sizes than the limit when fewer place everything');
{
  // Three parts, each a near-perfect fit for its own plate size (and no two share a plate): by steel alone, three sizes.
  const sheets = [{ key: 'A', length: 3000, width: 1000 }, { key: 'B', length: 2000, width: 1000 }, { key: 'C', length: 1200, width: 1000 }].map((s) => ({ ...s, areaCost: s.length * s.width, available: 5 }));
  const pieces = [{ key: 'p1', qty: 1, rings: rect(2980, 980) }, { key: 'p2', qty: 1, rings: rect(1980, 980) }, { key: 'p3', qty: 1, rings: rect(1180, 980) }];
  const base = { pieces, sheets, kerf: 3, margin: 5, effort: 'quick', seed: 1, budgetMs: 4000 };
  const free = packShapes(base);
  const ruled = packShapes({ ...base, costRules: NC.costRulesFor(10, { maxSizes: 2 }) });
  ok('by steel alone: three plates of three sizes', free.unplaced.length === 0 && sizesOf(free).size === 3, J([...sizesOf(free)]));
  ok('with the limit 2: every piece placed, on at most 2 sizes', ruled.unplaced.length === 0 && sizesOf(ruled).size <= 2 && ruled.totals.sizeOver === 0, J({ sizes: [...sizesOf(ruled)], over: ruled.totals.sizeOver }));
  ok('…and it says what it ranked by: areaBought stays the steel, score adds the rules', ruled.totals.areaBought === ruled.nests.reduce((a, n) => a + n.sheetLength * n.sheetWidth, 0) && ruled.totals.score > ruled.totals.areaBought - 1e9, J(ruled.totals));
  const big = packShapes({ ...base, pieces: [...pieces, { key: 'p4', qty: 1, rings: rect(3500, 900) }], sheets: [...sheets, { key: 'D', length: 4000, width: 1000, areaCost: 4e6, available: 1 }], costRules: NC.costRulesFor(10, { maxSizes: 1 }) });
  ok('a piece only another size holds is never left off for the limit (the limit ranks below pieces placed)', big.unplaced.length === 0, J(big.unplaced));
}

console.log('\n3. Fewest plates of the largest size that fits, always tried');
{
  // NITHINSAI 20 mm in small: seven 1500 × 1900 parts. One 12000 × 2000 holds them all (24 m²); the greedy
  // opens the 7600 × 2000 first (it is fuller) and needs two of them (30.4 m²).
  const sheets = [{ key: 'short', length: 7600, width: 2000, areaCost: 7600 * 2000, available: 4 }, { key: 'long', length: 12000, width: 2000, areaCost: 24e6, available: 3 }];
  const out = packShapes({ pieces: [{ key: 'w', qty: 7, rings: rect(1500, 1900) }], sheets, kerf: 4, margin: 5, rotations: [0, 180], effort: 'quick', seed: 1, budgetMs: 4000 });
  ok('one 12000 × 2000 plate, not two 7600 × 2000', out.unplaced.length === 0 && out.nests.length === 1 && out.nests[0].sheetKey === 'long' && out.totals.areaBought === 24e6, J(out.nests.map((n) => n.sheetKey)));
  // …and the largest is shrunk to the cheapest plate that holds the layout when a cheaper one does
  const s2 = [...sheets, { key: 'huge', length: 12500, width: 2500, areaCost: 12500 * 2500, available: 2 }];
  const o2 = packShapes({ pieces: [{ key: 'w', qty: 7, rings: rect(1500, 1900) }], sheets: s2, kerf: 4, margin: 5, rotations: [0, 180], effort: 'quick', seed: 1, budgetMs: 4000, costRules: NC.costRulesFor(20) });
  ok('offered a still larger plate: still one 12000 × 2000 (the one-size layouts that look cheapest are tried too)', o2.unplaced.length === 0 && o2.nests.length === 1 && o2.nests[0].sheetKey === 'long', J(o2.nests.map((n) => n.sheetKey)));
}

console.log('\n4–5. Shop spacing on true shapes; identical parts on one shared cut');
{
  const k = 3; const gap = 13;
  const tri = { outline: [[0, 0], [120, 0], [0, 90]], cutouts: [], holes: [] };
  const pieces = [{ key: 'r', qty: 12, rings: rect(600, 200) }, { key: 't', qty: 8, rings: tri }];
  const sheet = { key: 'P', length: 3000, width: 1500, areaCost: 4.5e6, available: 3 };
  const out = packShapes({ pieces, sheets: [sheet], kerf: k, margin: 5, effort: 'quick', seed: 1, budgetMs: 4000, gap, sharedCuts: true });
  const placed = out.nests.flatMap((n) => n.placements.map((p) => ({ key: p.key, poly: toPolygon(p.rings), nest: n.sheetIndex })));
  let rt = Infinity; let rrShared = 0; let rrBand = 0;
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = placed[i]; const b = placed[j];
      if (a.nest !== b.nest) continue;
      const d = polygonsDistance(a.poly, b.poly, 50);
      if ((a.key === 'r') !== (b.key === 'r')) rt = Math.min(rt, d);
      if (a.key === 'r' && b.key === 'r') { if (Math.abs(d - k) < 0.01) rrShared += 1; else if (d < gap - 1e-3) rrBand += 1; }
    }
  }
  ok('every part placed, every plate legal at one kerf', out.unplaced.length === 0 && out.nests.every((n) => verifyLayout({ sheet, placements: n.placements, kerf: k, margin: 5 }).ok));
  ok(`a strip and a small triangle (no facing edges of like length) are at least the block gap (${gap} mm) apart`, rt >= gap - 1e-3, String(rt));
  // (Two strips CAN share a cut, so a kerf is their clearance: a pair may still end up between a kerf and the gap
  // where a third part pins it — measured, not refused; see COMPARE.md "after".)
  ok('identical strips go edge to edge one kerf apart (shared cuts)', rrShared >= 8 && rrShared > rrBand, J({ rrShared, rrBand }));
  const off = packShapes({ pieces, sheets: [sheet], kerf: k, margin: 5, effort: 'quick', seed: 1, budgetMs: 4000 });
  ok('without the setting (no gap) the clearance is the kerf for every pair, as before', off.unplaced.length === 0 && off.nests.every((n) => verifyLayout({ sheet, placements: n.placements, kerf: k, margin: 5 }).ok));
  // Notched stiffeners: shared spots are offered and taken where they make the layout no longer.
  const notch = { outline: [[0, 0], [400, 0], [400, 150], [40, 150], [40, 120], [0, 120]], cutouts: [], holes: [] };
  const sh = packShapes({ pieces: [{ key: 's', qty: 20, rings: notch }], sheets: [{ key: 'P', length: 2500, width: 1000, areaCost: 2.5e6, available: 2 }], kerf: k, margin: 5, effort: 'quick', seed: 1, budgetMs: 4000, sharedCuts: true });
  const ns = packShapes({ pieces: [{ key: 's', qty: 20, rings: notch }], sheets: [{ key: 'P', length: 2500, width: 1000, areaCost: 2.5e6, available: 2 }], kerf: k, margin: 5, effort: 'quick', seed: 1, budgetMs: 4000 });
  const inBlocks = (o) => o.nests.reduce((a, n) => a + AC.planCuts({ plate: { length: n.sheetLength, width: n.sheetWidth }, pieces: n.placements.map((p, i) => ({ key: i, rings: p.rings })), rules: AC.aiRulesOf({ kerfMm: k }), options: { marking: false, sequences: false } }).counts.inBlocks, 0);
  ok('identical stiffeners: the shared-cut preference costs no plate, and puts more of them in shared-line blocks',
    sh.unplaced.length === 0 && sh.nests.length <= ns.nests.length && sh.totals.areaBought <= ns.totals.areaBought + 1e-6 && inBlocks(sh) >= inBlocks(ns) && inBlocks(sh) >= 10,
    J({ sh: [sh.nests.length, inBlocks(sh)], ns: [ns.nests.length, inBlocks(ns)] }));
}

console.log('\n6. The cut order: a small part filling a gap is cut where its block is');
{
  const box = (x, y, l, w) => ({ outline: [[x, y], [x + l, y], [x + l, y + w], [x, y + w]], cutouts: [], holes: [] });
  // A 3 m strip from the plate start, a small part in the gap at its far end, a big part behind it.
  const pieces = [
    { key: 'strip', code: 'S', rings: box(5, 5, 3000, 100) },
    { key: 'small', code: 's', rings: box(2900, 108, 50, 50) },
    { key: 'big', code: 'B', rings: box(100, 300, 1000, 400) },
  ];
  const plan = AC.planCuts({ plate: { length: 4000, width: 1000 }, pieces, rules: AC.aiRulesOf({ kerfMm: 3 }), options: { marking: false, sequences: false } });
  const order = plan.units.map((u) => plan.parts[u.members[0]].key);
  ok('the small part is cut straight after the strip whose gap it fills', order.join() === 'strip,small,big', order.join());
  ok('…and the big part after it is NOT a step back along the plate: the plan passes', plan.check.ok && !plan.units.some((u) => u.backStep && !u.small), J(plan.check.problems));
}

console.log('\n7. What planNesting hands the packer, and how answers are ranked');
{
  const s = { kerfMm: 3, partGapMm: 5, groupGapMm: 13, offcutMinAreaMm2: 90000, offcutMinSideMm: 100 };
  const on = shapeHabits({ ...s, shopSpacing: true }, 16, undefined, true);
  const off = shapeHabits(s, 16, 3, true);
  const legacy = shapeHabits(s, 16, undefined, false);
  ok('shop spacing on: the block gap between parts that cannot share a cut; shared cuts on; the default limit 2', on.gap === 13 && on.sharedCuts === true && on.costRules.maxSizes === 2);
  ok('shop spacing off: the kerf, as before; the company limit (3) handed on', off.gap === 3 && off.costRules.maxSizes === 3);
  ok('plateDiscipline: false — no cost rules (steel bought alone)', legacy.costRules === null);
  const run = (seed, area, score, sizeOver = 0) => ({ ok: true, seed, out: { nests: [], unplaced: [], areaBought: area, score, sizeOver } });
  ok('pickBest: fewer sizes over the limit, then the lower score — not the lower steel', pickBest([run(1, 10, 30), run(2, 20, 25)]).seed === 2 && pickBest([run(1, 10, 10, 1), run(2, 20, 25)]).seed === 2);
  ok('pickBest without a score: steel bought, the lower seed on a tie, as before', pickBest([{ ok: true, seed: 3, out: { nests: [], unplaced: [], areaBought: 5 } }, { ok: true, seed: 1, out: { nests: [], unplaced: [], areaBought: 5 } }]).seed === 1);
  // packJob: with cost rules a shape job answers `score` and `sizeOver`
  const sheets = [{ key: 'A', length: 3000, width: 1000, areaCost: 3e6, available: 5 }, { key: 'B', length: 2000, width: 1000, areaCost: 2e6, available: 5 }, { key: 'C', length: 1000, width: 1000, areaCost: 1e6, available: 5 }];
  const pieces = [{ key: 'p1', qty: 1, length: 2980, width: 980 }, { key: 'p2', qty: 1, length: 1980, width: 980 }, { key: 'p3', qty: 1, length: 980, width: 980 }];
  const job = runPackJob({
    packer: 'shape', seed: 1, budgetMs: 4000,
    rect: { pieces: pieces.map((p) => ({ ...p, grain: 'any' })), sheets, kerf: 3, gap: 3, margin: 2, effort: 'quick', seed: 1 },
    shape: { pieces: pieces.map((p) => ({ ...p, rings: null, grain: 'any' })), sheets, kerf: 3, margin: 5, effort: 'quick', seed: 1, costRules: NC.costRulesFor(10, { maxSizes: 2 }) },
  });
  const used = new Set(job.nests.map((n) => n.sheetKey));
  ok('a shape job with cost rules: the layout it keeps uses ≤ 2 sizes and says its score', job.unplaced.length === 0 && used.size <= 2 && job.sizeOver === 0 && Number.isFinite(job.score) && job.score !== job.areaBought, J({ used: [...used], score: job.score, area: job.areaBought, chosen: job.chosen }));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
