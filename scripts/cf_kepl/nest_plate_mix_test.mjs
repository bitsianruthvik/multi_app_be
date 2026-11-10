/**
 * nest_plate_mix_test.mjs — the 2026-11-10 nesting improvements (nest benchmark SO260018, "IMPROVE EXISTING"). No database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nest_plate_mix_test.mjs
 *
 *   1. nestPlateMix: bolt holes out of the extra searches, plates of an answer as patterns, the cheapest cover of the
 *      demand on one or two sizes (surplus not cut), the tail, nests back;
 *   2. a shape job with a budget and two sizes: the plate mix is never worse than the same job without it, places every
 *      piece once, and every plate it keeps verifies;
 *   3. proposeCustomSize under the mill's lot: no size for fewer plates than the lot; plates topped up to the lot when
 *      that still pays; a plate on a lot size is never moved; the ordering margin is always kept;
 *   4. the custom premium: 10 % by default, a company figure through pickCutSettings.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const PM = await imp('apps/cf_erp/services/nestPlateMix.js');
const { runPackJob } = await imp('apps/cf_erp/services/packJob.js');
const { verifyLayout } = await imp('apps/cf_erp/services/shapePacker.js');
const { proposeCustomSize } = await imp('apps/cf_erp/services/nestCustomPlate.js');
const NC = await imp('apps/cf_erp/services/nestCost.js');
const { pickCutSettings, shapeHabits } = await imp('apps/cf_erp/services/nestingService.js');
const { customPremiumOf, CUSTOM_PREMIUM_PCT_DEFAULT } = await imp('apps/cf_erp/services/shopRules.js');

let passed = 0; let failed = 0;
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || typeof cond !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const rect = (l, w) => ({ outline: [[0, 0], [l, 0], [l, w], [0, w]], cutouts: [], holes: [] });
const circle = (cx, cy, d) => Array.from({ length: 24 }, (_, i) => [cx + d / 2 * Math.cos(2 * Math.PI * i / 24), cy + d / 2 * Math.sin(2 * Math.PI * i / 24)]);

console.log('\n1. nestPlateMix');
{
  const p = { key: 'a', qty: 1, rings: { outline: rect(500, 300).outline, cutouts: [rect(200, 100).outline.map(([x, y]) => [x + 100, y + 100])], holes: [circle(50, 50, 26), circle(450, 250, 80)] } };
  const [lean] = PM.withoutBoltHoles([p]);
  ok('bolt holes (≤ 42 mm) left out, a bigger round hole and the cut-out kept', lean.rings.holes.length === 1 && lean.rings.cutouts.length === 1);
  ok('the piece itself is untouched', p.rings.holes.length === 2);
  ok('pieceArea = outline − cut-outs − holes', Math.abs(PM.pieceArea(p) - (150000 - 20000 - 12 * Math.sin(Math.PI / 12) * (13 * 13 + 40 * 40))) < 1);

  const out = { nests: [
    { sheetKey: 'A', placements: [{ key: 'x', x: 3, y: 3, rotationDeg: 0, bbox: { x0: 3, y0: 3, x1: 903, y1: 503 } }, { key: 'x', x: 909, y: 3, rotationDeg: 0, bbox: { x0: 909, y0: 3, x1: 1809, y1: 503 } }] },
    { sheetKey: 'A', pieces: [{ key: 'y', x: 3, y: 3, length: 400, width: 200, rotated: false }] },
  ] };
  const pl = PM.platesOf(out);
  ok('plates of an answer: placements and row pieces both read', pl.length === 2 && pl[0].counts.get('x') === 2 && pl[1].counts.get('y') === 1);
  ok('the room a pattern needs', pl[0].ex === 1809 && pl[0].ey === 503 && pl[1].ex === 403);

  // two layouts: one wastes a big plate on y; the other packs y with x on a small one
  const sheets = new Map([['A', { length: 2000, width: 1000, areaCost: 2e6, penalty: 0, available: 9 }], ['B', { length: 1000, width: 1000, areaCost: 1e6, penalty: 0, available: 9 }]]);
  const L1 = PM.platesOf(out);
  const L2 = PM.platesOf({ nests: [{ sheetKey: 'B', placements: [{ key: 'x', x: 3, y: 3, rotationDeg: 0, bbox: { x0: 3, y0: 3, x1: 903, y1: 503 } }, { key: 'y', x: 3, y: 509, rotationDeg: 0, bbox: { x0: 3, y0: 509, x1: 403, y1: 709 } }] }] });
  const net = new Map([['x', 450000], ['y', 80000]]);
  const cs = PM.covers([L1, L2], { demand: new Map([['x', 2], ['y', 1]]), sheets, net, margin: 3, rules: { maxSizes: 2, platePenalty: 0, sizePenalty: 0 } });
  ok('covers come cheapest first, every piece covered', cs.length > 0 && cs.every((c, i) => i === 0 || c.cost >= cs[i - 1].cost - 1e-9));
  const best = cs[0];
  const n = new Map(); for (const p0 of best.plates) for (const [k, v] of p0.counts) n.set(k, (n.get(k) ?? 0) + v);
  ok('the cheapest cover places each piece exactly as often as needed', n.get('x') === 2 && n.get('y') === 1, JSON.stringify([...n]));
  ok('…and costs less than the first layout as it stands (2 plates of A)', best.cost < 4e6, String(best.cost));
  ok('a pattern bought only as a size that holds it', best.plates.every((p0) => p0.ex + 3 <= sheets.get(p0.buy).length && p0.ey + 3 <= sheets.get(p0.buy).width));
  const t = PM.tailOf({ plates: [...best.plates, ...best.plates] }, net);
  ok('the tail: at least two plates, and what they hold', t.count >= 2 && t.keep.length === best.plates.length * 2 - t.count);
  ok('nests back in the packer\'s form', PM.nestsOf(best.plates, sheets).every((x) => x.sheetLength > 0 && Array.isArray(x.placements)));
}

console.log('\n2. A shape job with a budget: the plate mix is never worse, and legal');
{
  const pieces = [
    { key: 'p1', qty: 7, length: 2300, width: 700 }, { key: 'p2', qty: 9, length: 1100, width: 450 },
    { key: 'p3', qty: 14, length: 600, width: 380 }, { key: 'p4', qty: 5, length: 3100, width: 900 },
  ].map((p) => ({ ...p, rings: rect(p.length, p.width), grain: 'any', allowMirror: false }));
  const sheets = [{ key: 'S1', length: 6000, width: 2000 }, { key: 'S2', length: 6000, width: 1500 }, { key: 'S3', length: 4000, width: 2000 }]
    .map((s) => ({ ...s, available: 20, preferred: false, areaCost: s.length * s.width, penalty: 0 }));
  const habits = shapeHabits(pickCutSettings([], 12), 12, undefined, true);
  const job = (plateMix) => runPackJob({ packer: 'shape', seed: 3, budgetMs: 8000, deadlineAt: Date.now() + 8000, plateMix,
    rect: { pieces: pieces.map(({ rings, allowMirror, ...p }) => p), sheets, kerf: 3, gap: 3, margin: 0, thickness: 12, sequenceGap: 5, smallThreshold: 200, rowsPerSequence: { small: 2, big: 3 }, effort: 'quick', seed: 3 },
    shape: { pieces, sheets, kerf: 3, margin: 3, rotations: [0, 90, 180, 270], partInPart: true, effort: 'quick', seed: 3, ...habits },
    pieces: pieces.map(({ rings, ...p }) => p), sheets });
  const off = job(false); const on = job(true);
  const rank = (o) => [o.unplaced.reduce((a, u) => a + u.qty, 0), o.sizeOver ?? 0, o.score ?? o.areaBought];
  const [a, b] = [rank(on), rank(off)];
  ok('never worse than the job without the mix (pieces off, sizes over, score)', a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] <= b[2] + 1e-6))), JSON.stringify({ on: a, off: b, src: on.shape?.source }));
  const count = new Map(); for (const n of on.nests) for (const q of n.placements ?? n.pieces ?? []) count.set(q.key, (count.get(q.key) ?? 0) + 1);
  ok('every piece placed exactly once', pieces.every((p) => count.get(p.key) === p.qty), JSON.stringify([...count]));
  const bad = on.nests.filter((n) => n.placements && !verifyLayout({ sheet: { length: n.sheetLength ?? sheets.find((s) => s.key === n.sheetKey).length, width: n.sheetWidth ?? sheets.find((s) => s.key === n.sheetKey).width }, placements: n.placements.map((q) => ({ key: q.key, rings: q.rings })), kerf: 3, margin: 3 }).ok);
  ok('every plate it keeps verifies (kerf between parts, rim)', bad.length === 0, `${bad.length} plates`);
}

console.log('\n3. proposeCustomSize under the mill\'s lot');
{
  // six 10000 × 2500 plates, each used to 6000 × 2000: a 6100 × 2050 plate is the obvious size
  const nests = Array.from({ length: 6 }, () => ({ length: 10000, width: 2500, requiredLength: 6000, requiredWidth: 2000, plateItemId: 1 }));
  const limits = { maxLength: 14000, maxWidth: 3000, minLength: 6000, minWidth: 1250, step: 50, marginLength: 100, marginWidth: 50 };
  const free = proposeCustomSize(nests, { limits, thickness: 20 });
  ok('without a lot: a size for all six plates', !!free && free.moves.length === 6);
  ok('the ordering margin kept (+100 / +50, on the step)', free.length >= 6100 && free.width >= 2050 && free.length % 50 === 0 && free.width % 50 === 0, `${free?.length} x ${free?.width}`);
  const lot7 = proposeCustomSize(nests, { limits, thickness: 20, lot: { pieces: 7 } });
  ok('a lot of 7 from six plates: no size proposed', lot7 === null);
  const mixed = [...nests.slice(0, 3), ...Array.from({ length: 3 }, () => ({ length: 10000, width: 2500, requiredLength: 9800, requiredWidth: 2400, plateItemId: 1 }))];
  const lot5 = proposeCustomSize(mixed, { limits, thickness: 20, lot: { pieces: 5 } });
  ok('a lot of 5: plates topped up to five, or no size at all', lot5 === null || lot5.moves.length >= 5, String(lot5?.moves.length));
  const onLot = nests.map((n, i) => (i < 4 ? { ...n, lotCustom: true } : n));
  const kept = proposeCustomSize(onLot, { limits, thickness: 20 });
  ok('a plate on a lot size is never moved', !kept || kept.moves.every((i) => i >= 4));
  const tight = [{ length: 10000, width: 2500, requiredLength: 6000, requiredWidth: 2480, plateItemId: 1 }];
  const t2 = proposeCustomSize([...tight, ...tight, ...tight], { limits, thickness: 40 });
  ok('a layout 2,480 wide is never bought narrower than 2,530 (the old cap left 20 mm)', !t2 || t2.width >= 2530, `${t2?.length} x ${t2?.width}`);
}

console.log('\n4. The custom premium');
{
  ok('the default is 10 % (TO BE CONFIRMED by the business)', NC.COST_DEFAULTS.customPct === 0.10);
  const [std, cus] = NC.plateCosts([{ length: 12000, width: 2500, kind: 'STANDARD' }, { length: 12000, width: 2500, kind: 'CUSTOM' }]);
  ok('a custom plate costs 10 % more than the same standard one', Math.abs(cus.penalty / std.areaCost - 0.10) < 1e-9 && std.penalty === 0);
  const rows = [];
  Object.defineProperty(rows, 'customPremiumPct', { value: 6, enumerable: false });
  ok('a company figure rides with the cut settings (6 % → 0.06)', pickCutSettings(rows, 16).customPct === 0.06);
  ok('no figure: nothing on the settings, the default applies', pickCutSettings([], 16).customPct === undefined);
  const [, c6] = NC.plateCosts([{ length: 1000, width: 1000, kind: 'STANDARD' }, { length: 1000, width: 1000, kind: 'CUSTOM' }], { customPct: 0.06 });
  ok('plateCosts takes the company figure', Math.abs(c6.penalty - 60000) < 1e-6);
  ok('the figure lives in the custom-plate JSON, sizes on or off', customPremiumOf('{"on":false,"premiumPct":7.5}') === 7.5 && customPremiumOf({ on: true, maxLength: 14000, premiumPct: 12 }) === 12);
  ok('absent, blank or nonsense → null (the default, 10)', customPremiumOf(null) === null && customPremiumOf('{"on":true}') === null && customPremiumOf({ premiumPct: '' }) === null && customPremiumOf({ premiumPct: 250 }) === null && CUSTOM_PREMIUM_PCT_DEFAULT === 10);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
