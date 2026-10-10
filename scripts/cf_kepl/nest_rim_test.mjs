/**
 * nest_rim_test.mjs — THE RIM AND THE KERF ARE ONE RULE FOR BOTH PACKERS (nestShapes.rimOf).
 * No database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nest_rim_test.mjs
 *
 * The same rectangles are nested through the two paths a steel group can take
 * (nestingService.planNesting → packJob):
 *   rows    nestingPacker, handed `margin: rimOf(k).rectMargin`
 *   shapes  shapePacker,   handed `margin: rimOf(k).shapeMargin`
 * and the layouts are MEASURED here (boxes, written fresh): the least distance from any part to
 * the plate edge, and the least gap between two parts. Both must be the same on both paths —
 * the rim `rimOf(k).clearance`, the gap one kerf — for every kerf band the shop cuts with.
 * Then the shape JOB itself (packJob, as the worker runs it) on a steel with one drawn part, and
 * the verifier's rule: a layout is legal down to ONE kerf at the edge, whichever packer laid it.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { nest } = await imp('apps/cf_erp/services/nestingPacker.js');
const { packShapes } = await imp('apps/cf_erp/services/shapePacker.js');
const { runPackJob } = await imp('apps/cf_erp/services/packJob.js');
const { rimOf, verifyPlate, RIM_EXTRA_KERFS } = await imp('apps/cf_erp/services/nestShapes.js');
const { girderShapes, candidateOf } = await imp('scripts/cf_kepl/lib/nestDxfFixtures.mjs');

let passed = 0; let failed = 0;
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || typeof cond !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** Boxes on one plate → { rim: least distance to the plate edge, gap: least gap between two boxes }. */
function measure(boxes, L, W) {
  let rim = Infinity; let gap = Infinity;
  for (const b of boxes) rim = Math.min(rim, b.x, b.y, L - b.x - b.l, W - b.y - b.w);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]; const b = boxes[j];
      const sx = Math.max(b.x - (a.x + a.l), a.x - (b.x + b.l));
      const sy = Math.max(b.y - (a.y + a.w), a.y - (b.y + b.w));
      // Apart on one axis: the gap is that distance; apart on both: the corner-to-corner distance.
      const d = sx > 0 && sy > 0 ? Math.hypot(sx, sy) : Math.max(sx, sy);
      gap = Math.min(gap, d);
    }
  }
  return { rim, gap };
}
const least = (ms) => ({ rim: Math.min(...ms.map((m) => m.rim)), gap: Math.min(...ms.map((m) => m.gap)) });
const rowBoxes = (n) => n.pieces.map((p) => ({ x: p.x, y: p.y, l: p.length, w: p.width }));
const shapeBoxes = (n) => n.placements.map((p) => ({ x: p.bbox.x0, y: p.bbox.y0, l: p.bbox.x1 - p.bbox.x0, w: p.bbox.y1 - p.bbox.y0 }));
const near = (a, b) => Math.abs(a - b) <= 1e-6;

const SHEET = { key: 'S', length: 3000, width: 1500, available: 50, areaCost: 3000 * 1500 };
const RECTS = [
  { key: 'a', length: 500, width: 300, qty: 9, grain: 'any' },
  { key: 'b', length: 700, width: 300, qty: 6, grain: 'any' },
  { key: 'c', length: 240, width: 160, qty: 14, grain: 'any' },
];

console.log(`\n1. The same rectangles through both packers (RIM_EXTRA_KERFS = ${RIM_EXTRA_KERFS})`);
for (const k of [2.5, 3, 4, 5]) {
  const rim = rimOf(k);
  const rows = nest({ pieces: RECTS, sheets: [SHEET], kerf: k, gap: k, margin: rim.rectMargin, thickness: 16, sequenceGap: 5, smallThreshold: 200, rowsPerSequence: { small: 2, big: 3 }, effort: 'quick', seed: 1 });
  // rectFloor: false — the true-shape engine's OWN placements, not the row layout it would otherwise stand on.
  const shapes = packShapes({ pieces: RECTS.map((p) => ({ ...p, rings: null })), sheets: [SHEET], kerf: k, margin: rim.shapeMargin, rotations: [0, 90, 180, 270], effort: 'quick', seed: 1, rectFloor: false });
  const a = least(rows.nests.map((n) => measure(rowBoxes(n), SHEET.length, SHEET.width)));
  const b = least(shapes.nests.map((n) => measure(shapeBoxes(n), SHEET.length, SHEET.width)));
  ok(`kerf ${k}: everything placed on both, and the true-shape layout is the shape engine's own`, !rows.unplaced.length && !shapes.unplaced.length && shapes.source === 'shape', JSON.stringify([rows.unplaced, shapes.unplaced, shapes.source]));
  ok(`kerf ${k}: the least distance to the plate edge is ${rim.clearance} mm on both (rows ${a.rim}, shapes ${b.rim})`, near(a.rim, rim.clearance) && near(b.rim, rim.clearance) && near(a.rim, b.rim));
  ok(`kerf ${k}: the least gap between two parts is one kerf on both (rows ${a.gap}, shapes ${b.gap})`, near(a.gap, k) && near(b.gap, k) && near(a.gap, b.gap));
}

console.log('\n2. The shape job as the worker runs it (packJob), on a steel with one drawn part');
{
  const k = 3; const rim = rimOf(k);
  const g = candidateOf(girderShapes().gusset, { key: 'g' });
  const rect = { pieces: [...RECTS, { key: 'g', length: g.length, width: g.width, qty: 8, grain: 'any' }], sheets: [SHEET], kerf: k, gap: k, margin: rim.rectMargin, thickness: 16, sequenceGap: 5, smallThreshold: 200, rowsPerSequence: { small: 2, big: 3 }, effort: 'quick', seed: 1 };
  const shape = { pieces: [...RECTS.map((p) => ({ ...p, rings: null })), { key: 'g', qty: 8, rings: g.rings, length: g.length, width: g.width, grain: 'any' }], sheets: [SHEET], kerf: k, margin: rim.shapeMargin, rotations: [0, 90, 180, 270], partInPart: true, effort: 'quick', seed: 1 };
  const out = runPackJob({ packer: 'shape', seed: 1, rect, shape, fillSheets: [] });
  const rowsM = least(out.rect.nests.map((n) => measure(rowBoxes(n), SHEET.length, SHEET.width)));
  ok('the job answers with both layouts and says which it took', ['shape', 'rect'].includes(out.chosen) && !!out.rect && !!out.shape, out.chosen);
  const shapeM = least(out.shape.nests.map((n) => measure(shapeBoxes(n), SHEET.length, SHEET.width)));
  ok(`whichever is taken, the plate edge is ${rim.clearance} mm away on both (rows ${rowsM.rim}, shapes ${shapeM.rim})`, near(rowsM.rim, rim.clearance) && shapeM.rim >= rim.clearance - 1e-6);
  // Every plate of the true-shape layout, checked on the outlines at the PACKERS' clearance: nothing nearer the edge, nothing nearer than a kerf.
  let problems = 0;
  for (const n of out.shape.nests) problems += verifyPlate({ length: SHEET.length, width: SHEET.width, kerf: k, margin: rim.clearance, tolerance: 0.005, placements: n.placements.map((p, i) => ({ key: i, rings: p.rings })) }).problems.length;
  ok('…and on the true outlines nothing is nearer the edge than that, nor nearer another part than the kerf', problems === 0, String(problems));
}

console.log('\n3. What a verifier holds a layout to: one kerf at the edge, whoever laid it');
{
  const k = 3; const rim = rimOf(k);
  const box = (x, y, l, w) => ({ outline: [[x, y], [x + l, y], [x + l, y + w], [x, y + w]], cutouts: [], holes: [] });
  const at = (d) => verifyPlate({ length: 1000, width: 500, kerf: k, margin: rim.legalMin, tolerance: 0.005, placements: [{ key: 0, rings: box(d, d, 200, 100) }] }).problems.map((p) => p.kind);
  ok(`ONE kerf at the plate edge: the legal minimum is ${rim.legalMin} mm and the packers leave exactly ${rim.clearance} (never zero)`, rim.legalMin === k && rim.clearance === k * (1 + RIM_EXTRA_KERFS) && rim.clearance === k && rim.rectMargin === 0 && rim.shapeMargin === rim.rectMargin + k);
  ok('a part exactly one kerf in is legal; a hair nearer is "in_rim"; off the plate is "outside"', at(k).length === 0 && at(k - 0.1).join() === 'in_rim' && at(-1).join() === 'outside', JSON.stringify([at(k), at(k - 0.1), at(-1)]));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
