/**
 * shape_packer_test.mjs — the whole test for `apps/cf_erp/services/shapePacker.js`
 * and `apps/cf_erp/lib/polyGeom.js`.
 *
 *   cd multi_app_be && node scripts/cf_kepl/shape_packer_test.mjs
 *
 * NO DATABASE, no tenant, no order: every shape below is made up and
 * hand-checkable, and the arithmetic behind an assertion is written above it.
 *
 * EVERY LAYOUT EVERY TEST PRODUCES goes through `check`, which holds it to:
 *   - `verifyLayout` (exact geometry; itself tested below with planted defects),
 *   - an INDEPENDENT sampling check written fresh in this file — a few thousand
 *     points per sheet, none of which may lie in two parts, in a part and
 *     outside the sheet, or in a part and in the rim. A checker that shares the
 *     packer's code shares the packer's bugs, so this one shares nothing,
 *   - the placement convention: each placement's rings must equal
 *     `placeRings(the piece's rings, the placement)`, and its bbox must start at
 *     (x, y),
 *   - grain, mirroring and quantity conservation.
 */

import {
  packShapes, packShapesAsync, verifyLayout, layoutMetrics, placeRings, placedRingsOf,
} from '../../apps/cf_erp/services/shapePacker.js';
import { nest, mulberry32 } from '../../apps/cf_erp/services/nestingPacker.js';
import * as G from '../../apps/cf_erp/lib/polyGeom.js';

let passed = 0;
let failed = 0;
const notes = [];

function ok(cond, msg) {
  if (cond) passed += 1;
  else { failed += 1; console.log(`   FAIL  ${msg}`); }
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
function eq(got, want, msg, tol = 1e-6) { ok(near(got, want, tol), `${msg} — got ${got}, want ${want}`); }
function is(got, want, msg) { ok(got === want, `${msg} — got ${got}, want ${want}`); }
function note(s) { notes.push(s); }

const ONLY = process.env.ONLY ? process.env.ONLY.toLowerCase() : null; // ONLY=fixed node … runs the tests whose name contains it

async function test(name, fn) {
  if (ONLY && !name.toLowerCase().includes(ONLY)) return;
  console.log(` • ${name}`);
  const before = failed;
  const t0 = Date.now();
  try { await fn(); } catch (e) { failed += 1; console.log(`   FAIL  threw: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e}`); }
  if (failed === before) console.log(`   ok  (${Date.now() - t0} ms)`);
}

/* ─────────────────────────────── shape makers ──────────────────────────── */

const R = (outline, cutouts = [], holes = []) => ({ outline, cutouts, holes });
const rect = (w, h, x = 0, y = 0) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const tri = (w, h) => R([[0, 0], [w, 0], [0, h]]);
const ell = (w, h, a, b) => R([[0, 0], [w, 0], [w, b], [a, b], [a, h], [0, h]]);
const trap = (w, h, t) => R([[0, 0], [w, 0], [w - t, h], [t, h]]);
const circle = (cx, cy, r, n = 72) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
const poly = (outline, holes = []) => ({ outline: G.orientRing(outline, true), holes: holes.map((h) => G.orientRing(h, false)) });

/* ───────────────────────── the independent checkers ────────────────────── */

/** Even–odd point in ring, written here and nowhere else. */
function inRing(x, y, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const inSolid = (x, y, rings) => inRing(x, y, rings.outline) && !(rings.cutouts ?? []).some((h) => inRing(x, y, h));
function ringEdgeDist(x, y, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i += 1) {
    const [ax, ay] = ring[i]; const [bx, by] = ring[(i + 1) % ring.length];
    const dx = bx - ax; const dy = by - ay; const l2 = dx * dx + dy * dy;
    let t = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

/**
 * Sample the sheet. No point may be in two solids; no solid point may be off the
 * sheet or in the rim. Points within 1e-3 of an edge are skipped (they are the
 * exact checker's business).
 */
function sampleCheck(sheet, parts, margin, label, seed = 1) {
  const rng = mulberry32(seed);
  const L = sheet.length; const W = sheet.width;
  const pts = [];
  const nx = 70; const ny = 45;
  for (let i = 0; i < nx; i += 1) for (let j = 0; j < ny; j += 1) pts.push([((i + 0.37) * L) / nx, ((j + 0.61) * W) / ny]);
  for (const p of parts) {
    const b = p.box;
    for (let s = 0; s < 40; s += 1) pts.push([b.x0 + rng() * (b.x1 - b.x0), b.y0 + rng() * (b.y1 - b.y0)]);
  }
  let bad = 0;
  for (const [x, y] of pts) {
    let hits = 0;
    for (const p of parts) {
      const b = p.box;
      if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
      if (!inSolid(x, y, p.rings)) continue;
      if (ringEdgeDist(x, y, p.rings.outline) < 1e-3) continue;
      hits += 1;
      if (p.fixed) continue;
      const onSheet = sheet.outline ? inRing(x, y, sheet.outline) : (x >= 0 && x <= L && y >= 0 && y <= W);
      const rim = sheet.outline ? ringEdgeDist(x, y, sheet.outline) : Math.min(x, y, L - x, W - y);
      if (!onSheet || rim < margin - 1e-3) bad += 1;
    }
    if (hits > 1) bad += 1;
  }
  ok(bad === 0, `${label}: sampling found ${bad} point(s) in two parts, off the sheet or in the rim`);
}

const boxOf = (ring) => ring.reduce((b, [x, y]) => ({ x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
const asRings = (p) => G.ringsObject(p.rings) ?? R(rect(p.length, p.width));

/** Hold a whole result to everything that must be true of it. */
function check(r, input, label, { allowWarnings = false } = {}) {
  const kerf = input.kerf ?? 0;
  const margin = (input.margin ?? 0) + (input.kerfAtRim ? kerf : 0);
  const sheetBy = new Map(input.sheets.map((s) => [String(s.key), s]));
  const pieceBy = new Map();
  for (const p of input.pieces) { const k = String(p.key); if (!pieceBy.has(k)) pieceBy.set(k, []); pieceBy.get(k).push(p); }
  const rot = Array.isArray(input.rotations) ? input.rotations : null;
  if (!allowWarnings) ok(r.warnings.length === 0, `${label}: warnings — ${r.warnings.join(' | ')}`);

  const got = new Map();
  const seenN = new Set();
  r.nests.forEach((n, ni) => {
    const sheet = sheetBy.get(String(n.sheetKey));
    ok(!!sheet, `${label}: nest ${ni} is on sheet '${n.sheetKey}', which was never offered`);
    if (!sheet) return;
    ok(n.placements.length > 0, `${label}: nest ${ni} holds nothing`);
    const sh = { length: sheet.length ?? boxOf(sheet.outline).x1, width: sheet.width ?? boxOf(sheet.outline).y1, outline: sheet.outline ?? null, fixed: sheet.fixed ?? [] };

    const v = verifyLayout({ sheet: sh, placements: n.placements, kerf, margin });
    ok(v.ok, `${label}: nest ${ni} fails verifyLayout — ${v.problems.slice(0, 3).map((p) => `${p.kind} ${p.a}${p.b ? `/${p.b}` : ''} (${p.detail})`).join('; ')}`);

    const parts = [];
    for (const f of sh.fixed) { const rings = placedRingsOf(f); parts.push({ rings, box: boxOf(rings.outline), fixed: true }); }
    for (const p of n.placements) {
      const src = (pieceBy.get(String(p.key)) ?? [])[0];
      ok(!!src, `${label}: '${p.key}' was placed but never asked for`);
      if (!src) continue;
      got.set(String(p.key), (got.get(String(p.key)) ?? 0) + 1);
      ok(!seenN.has(`${p.key}#${p.n}`), `${label}: copy ${p.key}#${p.n} appears twice`);
      seenN.add(`${p.key}#${p.n}`);

      // The convention: the rings are placeRings(piece, placement), point for point.
      const want = placeRings(asRings(src), p);
      const rings = G.ringsObject(p.rings);
      let same = want.outline.length === rings.outline.length && want.cutouts.length === rings.cutouts.length;
      for (let i = 0; same && i < want.outline.length; i += 1) same = near(want.outline[i][0], rings.outline[i][0], 1e-9) && near(want.outline[i][1], rings.outline[i][1], 1e-9);
      ok(same, `${label}: ${p.key}#${p.n} rings are not placeRings(piece, placement)`);
      const b = boxOf(rings.outline);
      ok(near(b.x0, p.x, 1e-7) && near(b.y0, p.y, 1e-7), `${label}: ${p.key}#${p.n} (x, y) is not its bounding-box corner`);
      ok(near(b.x0, p.bbox.x0, 1e-7) && near(b.y1, p.bbox.y1, 1e-7) && near(b.x1, p.bbox.x1, 1e-7), `${label}: ${p.key}#${p.n} bbox is wrong`);

      // Grain and mirroring.
      const g = src.grain ?? 'any';
      if (g === 'length') ok(p.rotationDeg === 0 || p.rotationDeg === 180, `${label}: ${p.key} has grain 'length' and sits at ${p.rotationDeg}°`);
      if (g === 'width') ok(p.rotationDeg === 90 || p.rotationDeg === 270, `${label}: ${p.key} has grain 'width' and sits at ${p.rotationDeg}°`);
      if (g === 'any' && rot) ok(rot.includes(p.rotationDeg), `${label}: ${p.key} sits at ${p.rotationDeg}°, which was not allowed`);
      if (!src.allowMirror) ok(p.mirrored === false, `${label}: ${p.key} was mirrored and may not be`);
      parts.push({ rings, box: b, fixed: false });
    }
    sampleCheck(sh, parts, margin, `${label} nest ${ni}`, ni + 1);

    // The reported numbers are the numbers.
    const sheetArea = sh.outline ? G.ringArea(sh.outline) : sh.length * sh.width;
    eq(n.metrics.sheetArea, sheetArea, `${label}: nest ${ni} sheetArea`, 1e-3);
    ok(n.metrics.partArea <= sheetArea + 1e-6 && n.metrics.partArea > 0, `${label}: nest ${ni} partArea ${n.metrics.partArea} is not within the sheet`);
  });

  // Quantity conservation, across the whole answer, every time.
  for (const u of r.unplaced) {
    ok(typeof u.reason === 'string' && u.reason.length > 0, `${label}: unplaced ${u.key} carries no reason`);
    got.set(String(u.key), (got.get(String(u.key)) ?? 0) + u.qty);
  }
  for (const [k, list] of pieceBy) {
    const want = list.reduce((s, p) => s + (p.qty ?? 1), 0);
    ok((got.get(k) ?? 0) === want, `${label}: ${k} — ${want} asked for, ${got.get(k) ?? 0} accounted for`);
  }
  eq(r.totals.sheets, r.nests.length, `${label}: totals.sheets`);
  eq(r.totals.sheetArea, r.nests.reduce((s, n) => s + n.metrics.sheetArea, 0), `${label}: totals.sheetArea`, 1e-3);
  return r;
}

const run = (input, label, opts) => check(packShapes(input), input, label, opts);

/** nestingPacker on the bounding boxes of the same job. */
function rectOf(input, effort = 'standard') {
  return nest({
    pieces: input.pieces.map((p) => ({ key: p.key, length: p.length ?? boxOf(asRings(p).outline).x1, width: p.width ?? boxOf(asRings(p).outline).y1, qty: p.qty, grain: p.grain })),
    sheets: input.sheets.map((s) => ({ key: s.key, length: s.length, width: s.width, available: s.available === Infinity ? null : s.available, preferred: s.preferred, areaCost: s.areaCost })),
    kerf: input.kerf, margin: input.margin ?? 0, effort, seed: input.seed ?? 1,
  });
}
const trueArea = (p) => { const o = asRings(p); return G.ringArea(o.outline) - o.cutouts.reduce((s, h) => s + G.ringArea(h), 0); };
const rectWaste = (rr, input) => {
  const sheetArea = rr.nests.reduce((s, n) => s + n.sheetArea, 0);
  const by = new Map(input.pieces.map((p) => [String(p.key), p]));
  const partArea = rr.nests.reduce((s, n) => s + n.pieces.reduce((a, p) => a + trueArea(by.get(String(p.key))), 0), 0);
  return (100 * (sheetArea - partArea)) / sheetArea;
};

/* ─────────────────────────────── generated jobs ────────────────────────── */

/** ~`total` pieces of `nShapes` shapes: rectangles, triangles, Ls, trapezoids, coped gussets, frames. */
function bigJob(seed = 7, nShapes = 60, total = 600) {
  const rng = mulberry32(seed);
  const I = (a, b) => Math.round(a + rng() * (b - a));
  const pieces = [];
  for (let i = 0; i < nShapes; i += 1) {
    const kind = i % 6;
    const L = I(300, 3200); const W = I(150, 1100);
    let rings = null;
    if (kind === 1) rings = tri(L, W);
    else if (kind === 2) rings = ell(L, W, I(L * 0.3, L * 0.6), I(W * 0.3, W * 0.6));
    else if (kind === 3) rings = trap(L, W, I(L * 0.1, L * 0.35));
    else if (kind === 4) {
      // a gusset: one corner coped with a quarter circle (5° chords), the opposite one sniped
      const r = Math.min(60, W / 4);
      const arc = [];
      for (let a = 0; a <= 90; a += 5) arc.push([r * Math.cos((a * Math.PI) / 180), r * Math.sin((a * Math.PI) / 180)]);
      rings = R([...arc, [0, W], [Math.round(L * 0.6), W], [L, Math.round(W * 0.4)], [L, 0]]);
    }
    pieces.push({ key: `P${i}`, qty: 0, rings, length: L, width: W, grain: i % 11 === 0 ? 'length' : 'any' });
  }
  for (let n = 0; n < total; n += 1) pieces[Math.floor(rng() * nShapes)].qty += 1;
  return { pieces: pieces.filter((p) => p.qty > 0), sheets: [{ key: 'PL', length: 12000, width: 2500 }], kerf: 3, margin: 5, seed: 1 };
}

/** A random simple polygon: a star-shaped ring, convex or with dents. */
function randomPolygon(rng, w, h) {
  const n = 3 + Math.floor(rng() * 7);
  const concave = rng() < 0.6;
  const pts = [];
  for (let i = 0; i < n; i += 1) {
    const a = (2 * Math.PI * (i + 0.15 + 0.7 * rng())) / n;
    const rad = concave ? 0.35 + 0.65 * rng() : 1;
    pts.push([Math.cos(a) * rad, Math.sin(a) * rad]);
  }
  const b = boxOf(pts);
  return pts.map(([x, y]) => [Math.round(((x - b.x0) / (b.x1 - b.x0)) * w * 10) / 10, Math.round(((y - b.y0) / (b.y1 - b.y0)) * h * 10) / 10]);
}

/* ──────────────────────────────────────────────────────────────────────── */

async function main() {
  console.log('\nshapePacker / polyGeom — true-shape nesting\n');

  /* ───────────────────────────── polyGeom ─────────────────────────────── */

  await test('geometry: area, bbox, orientation, cleaning', () => {
    const L = ell(1000, 1000, 400, 400).outline;
    // 1000×400 + 400×600 = 640 000
    eq(G.ringArea(L), 640000, 'area of the L');
    eq(G.signedArea(L), 640000, 'the L runs counter-clockwise');
    eq(G.signedArea(L.slice().reverse()), -640000, 'reversed, it is clockwise');
    const b = G.bboxOfRing(L);
    ok(b.x0 === 0 && b.y0 === 0 && b.x1 === 1000 && b.y1 === 1000, 'bbox of the L');
    eq(G.ringPerimeter(L), 4000, 'perimeter of the L');
    // closing point repeated, a doubled point, and a point on a straight side: all go
    const messy = [[0, 0], [5, 0], [10, 0], [10, 10], [10, 10], [0, 10], [0, 0]];
    eq(G.cleanRing(messy).length, 4, 'cleanRing leaves the four corners');
    // near-collinear: 1e-9 off the line is the line; 1e-3 off is a corner
    eq(G.cleanRing([[0, 0], [5, 1e-9], [10, 0], [10, 10], [0, 10]]).length, 4, 'a point 1e-9 off a side is on it');
    eq(G.cleanRing([[0, 0], [5, 1e-3], [10, 0], [10, 10], [0, 10]]).length, 5, 'a point 1e-3 off a side is a corner');
    const p = G.toPolygon([[...rect(100, 80), [0, 0]], rect(20, 20, 10, 10)]);
    eq(G.polygonArea(p), 8000 - 400, 'toPolygon: outline less the cut-out');
    ok(G.signedArea(p.outline) > 0 && G.signedArea(p.holes[0]) < 0, 'canonical: outline ccw, hole cw');
    const q = G.toPolygon({ outline: rect(100, 80), cutouts: [rect(20, 20, 10, 10)], holes: [circle(70, 40, 10)] });
    eq(q.holes.length, 1, 'a drilled hole is not an opening');
  });

  await test('geometry: rotation is exact at the quarter turns, mirror flips', () => {
    const ring = [[0, 0], [2500, 0], [2500, 317], [0, 317]];
    const r90 = G.rotateRing(ring, 90);
    // (x, y) -> (-y, x), exactly: no 2500.0000000000005
    ok(r90.every((p) => Number.isInteger(p[0]) && Number.isInteger(p[1])), '90° keeps integers integer');
    ok(r90[1][0] === 0 && r90[1][1] === 2500 && r90[2][0] === -317 && r90[2][1] === 2500, '90° sends (2500,0) to (0,2500) and (2500,317) to (-317,2500)');
    const r360 = G.rotateRing(G.rotateRing(G.rotateRing(G.rotateRing(ring, 90), 90), 90), 90);
    ok(r360.every((p, i) => p[0] === ring[i][0] && p[1] === ring[i][1]), 'four quarter turns are the identity, exactly');
    const r45 = G.rotateRing([[1, 0]], 45);
    eq(r45[0][0], Math.SQRT1_2, '45°: x'); eq(r45[0][1], Math.SQRT1_2, '45°: y');
    eq(G.ringArea(G.rotateRing(ell(1000, 1000, 400, 400).outline, 37)), 640000, 'rotation keeps area', 1e-6);
    const m = G.mirrorRing([[3, 4], [5, 6]]);
    ok(m[0][0] === -3 && m[0][1] === 4, 'mirror is x -> -x');
    const t = G.transformPolygon(poly(ell(10, 10, 4, 4).outline), { mirrored: true, rotationDeg: 90 });
    ok(G.signedArea(t.outline) > 0, 'a mirrored polygon is re-oriented');
    // negative and >360 angles
    ok(G.rotateRing([[1, 0]], -90)[0][1] === -1 && G.rotateRing([[1, 0]], 450)[0][1] === 1, '-90° and 450° are quarter turns too');
  });

  await test('geometry: overlap on touching, near-touching, contained, in-a-hole, identical', () => {
    const A = poly(rect(200, 100));
    ok(!G.polygonsOverlap(A, poly(rect(200, 100, 200, 0))), 'edge to edge is not an overlap');
    ok(!G.polygonsOverlap(A, poly(rect(50, 50, 200, 100))), 'corner to corner is not an overlap');
    ok(!G.polygonsOverlap(A, poly(rect(200, 100, 200 + 1e-9, 0))), 'a nanometre apart is not an overlap');
    ok(G.polygonsOverlap(A, poly(rect(200, 100, 199.99, 0))), '10 microns of intrusion is an overlap');
    // two equal rectangles slid half over: no vertex inside anything, no edges crossing
    ok(G.polygonsOverlap(A, poly(rect(200, 100, 100, 0))), 'equal rectangles slid half-way overlap');
    ok(G.polygonsOverlap(A, poly(rect(200, 100))), 'identical shapes in the same place overlap');
    ok(G.polygonsOverlap(A, poly(rect(20, 20, 50, 40))), 'one wholly inside the other overlaps');
    ok(G.polygonsOverlap(poly(rect(20, 20, 50, 40)), A), '… and the other way round');
    const frame = poly(rect(1000, 800), [rect(600, 400, 200, 200)]);
    ok(!G.polygonsOverlap(frame, poly(rect(100, 100, 300, 300))), 'a part in a cut-out does not overlap its host');
    ok(G.polygonsOverlap(frame, poly(rect(100, 100, 150, 300))), 'a part across the cut-out edge does');
    ok(!G.polygonsOverlap(frame, poly(rect(600, 400, 200, 200))), 'a part exactly filling the cut-out only touches');
    // concave: a square in the notch of an L
    const L = poly(ell(1000, 1000, 400, 400).outline);
    ok(!G.polygonsOverlap(L, poly(rect(500, 500, 450, 450))), 'a square in the notch of an L is clear');
    ok(G.polygonsOverlap(L, poly(rect(500, 500, 350, 450))), 'pushed into the upright, it is not');
    // a triangle whose bounding box overlaps but whose body does not
    ok(!G.polygonsOverlap(poly([[0, 0], [100, 0], [0, 100]]), poly([[100, 100], [100, 10], [10, 100]])), 'two triangles sharing a bounding box need not overlap');
  });

  await test('geometry: distance between polygons', () => {
    const A = poly(rect(100, 100));
    eq(G.polygonsDistance(A, poly(rect(100, 100, 103, 0))), 3, 'two squares 3 apart');
    eq(G.polygonsDistance(A, poly(rect(100, 100, 103, 104))), 5, 'corner to corner, 3 and 4 away, is 5');
    eq(G.polygonsDistance(A, poly(rect(100, 100, 100, 0))), 0, 'touching is 0');
    eq(G.polygonsDistance(A, poly(rect(100, 100, 50, 50))), 0, 'crossing is 0');
    const frame = poly(rect(1000, 800), [rect(600, 400, 200, 200)]);
    eq(G.polygonsDistance(frame, poly(rect(100, 100, 207, 250))), 7, 'in a cut-out, the gap is to the cut-out edge');
    // a hypotenuse against a hypotenuse: the triangles (0,0)(100,0)(0,100) and its mate shifted 10 up
    eq(G.polygonsDistance(poly([[0, 0], [100, 0], [0, 100]]), poly([[100, 110], [100, 10], [0, 110]])), 10 / Math.SQRT2, 'parallel hypotenuses 10 up are 7.07 apart');
    eq(G.polygonsDistance(A, poly(rect(10, 10, 500, 0)), 50), 50, 'beyond the cutoff it says "at least the cutoff"');
    const inside = G.polygonInside(poly(rect(100, 100, 20, 30)), poly(rect(500, 500)));
    ok(inside.inside && near(inside.clearance, 20), 'polygonInside: inside, 20 from the nearest edge');
    ok(!G.polygonInside(poly(rect(100, 100, 450, 30)), poly(rect(500, 500))).inside, 'polygonInside: sticking out is not inside');
    const Lsheet = poly(ell(1000, 1000, 400, 400).outline);
    ok(!G.polygonInside(poly(rect(300, 300, 300, 300)), Lsheet).inside, 'polygonInside: across the notch of an L is not inside');
    ok(G.polygonInside(poly(rect(300, 300, 50, 50)), Lsheet).inside, 'polygonInside: in the body of an L is');
    const holed = poly(rect(1000, 800), [rect(100, 100, 400, 300)]);
    ok(G.polygonInside(poly(rect(200, 200, 50, 50)), holed).inside, 'polygonInside: beside the opening of a holed plate is inside');
    ok(!G.polygonInside(poly(rect(400, 400, 300, 200)), holed).inside, 'polygonInside: a part that surrounds the opening is not inside the solid');
    ok(!G.polygonInside(poly(rect(200, 200, 350, 250)), holed).inside, 'polygonInside: nor one that crosses into it');
  });

  await test('geometry: convex decomposition tiles the solid exactly', () => {
    const cases = [
      ['rectangle', poly(rect(300, 200)), 1],
      ['triangle', poly([[0, 0], [1000, 0], [300, 600]]), 1],
      ['circle (72 chords)', poly(circle(0, 0, 500)), 1],
      ['L', poly(ell(1000, 1000, 400, 400).outline), 2],
      ['L turned 37°', G.transformPolygon(poly(ell(1000, 1000, 400, 400).outline), { rotationDeg: 37 }), 2],
      ['frame', poly(rect(1000, 800), [rect(600, 400, 200, 200)]), 4],
      ['ring', poly(circle(0, 0, 500), [circle(0, 0, 300)]), null],
    ];
    for (const [name, p, want] of cases) {
      const pieces = G.convexDecompose(p);
      eq(pieces.reduce((s, r) => s + G.ringArea(r), 0), G.polygonArea(p), `${name}: the pieces add up to the solid`, 1e-6 * G.polygonArea(p));
      ok(pieces.every((r) => G.isConvex(r) && G.signedArea(r) > 0), `${name}: every piece is convex and counter-clockwise`);
      if (want != null) eq(pieces.length, want, `${name}: piece count`);
    }
    // a hundred random dented polygons
    const rng = mulberry32(11);
    let bad = 0;
    for (let i = 0; i < 100; i += 1) {
      const p = G.toPolygon([randomPolygon(rng, 800, 500)]);
      if (!p) continue;
      const pieces = G.convexDecompose(p);
      const sum = pieces.reduce((s, r) => s + G.ringArea(r), 0);
      if (Math.abs(sum - G.polygonArea(p)) > 1e-6 * G.polygonArea(p) || !pieces.every((r) => G.isConvex(r))) bad += 1;
    }
    eq(bad, 0, '100 random polygons: all tiled exactly by convex pieces');
  });

  await test('geometry: Minkowski difference and offset', () => {
    // square 100 minus square 40: every a − b is the square [-40,100]², side 140
    const nf = G.minkowskiDiffConvex(rect(100, 100), rect(40, 40));
    eq(G.ringArea(nf), 140 * 140, 'no-fit polygon of two squares is the 140 square');
    const b = G.bboxOfRing(nf);
    ok(b.x0 === -40 && b.x1 === 100, '… from -40 to 100');
    // offset of a 100×60 rectangle by 5: (110×70) less corner squares, plus corners.
    // True round offset: 6000 + 2·160·5 + π·25 = 7678.54. The circumscribed corners add ≤ 3.5%.
    const off = G.offsetConvex(rect(100, 60), 5);
    const a = G.ringArea(off);
    ok(a >= 7678.53 && a <= 7700, `offsetConvex: area ${a.toFixed(2)} is the round offset 7678.54, erring outward and under 110×70`);
    ok(G.isConvex(off), 'offsetConvex keeps it convex');
    // never INSIDE the true offset: every original corner is at least 5 from the new boundary
    ok(rect(100, 60).every((p) => G.pointRingDistance(p, off) >= 5 - 1e-9), 'every corner is at least d inside the offset');
    // polygon offsets through the boolean
    const L = poly(ell(1000, 1000, 400, 400).outline);
    const grown = G.offsetPolygon(L, 10);
    // 640000 + 4000·10 + 5 quarter-circles (392.7) − the 10×10 double-counted at the inside corner = 680292.7
    ok(grown.length === 1 && grown[0].area >= 680292 && grown[0].area <= 680320, `offsetPolygon +10 on the L: ${grown[0].area.toFixed(1)} (true 680292.7)`);
    const shrunk = G.offsetPolygon(L, -10);
    // inside: (980×380) + (380×600) + the rounded inside corner (100 − 78.5 = 21.5) = 600421.5
    ok(shrunk.length === 1 && shrunk[0].area <= 600421.5 + 1e-6 && shrunk[0].area >= 600400, `offsetPolygon −10 on the L: ${shrunk[0].area.toFixed(1)} (true 600421.5)`);
    const frame = poly(rect(1000, 800), [rect(600, 400, 200, 200)]);
    const f2 = G.offsetPolygon(frame, -50);
    ok(f2.length === 1 && f2[0].holes.length === 1, 'a frame shrunk by 50 is still a frame');
    eq(G.offsetPolygon(poly(rect(100, 100)), -60).length, 0, 'a 100 square shrunk by 60 is nothing');
    const two = G.offsetPolygon(poly([[0, 0], [300, 0], [300, 100], [160, 100], [160, 10], [140, 10], [140, 100], [0, 100]]), -8);
    eq(two.length, 2, 'shrinking can split a shape in two (a 10 mm neck, shrunk by 8)');
    const closed = G.offsetPolygon(poly(rect(100, 100), [rect(10, 10, 45, 45)]), 6);
    eq(closed[0].holes.length, 0, 'growing closes a hole smaller than twice the offset');
  });

  await test('geometry: booleans and outward-only simplification', () => {
    const A = poly(rect(10, 10)); const B = poly(rect(10, 10, 5, 5));
    eq(G.booleanRegions([A], [B], 'union')[0].area, 175, 'union of two overlapping squares');
    eq(G.booleanRegions([A], [B], 'intersection')[0].area, 25, 'their intersection');
    eq(G.booleanRegions([A], [B], 'difference')[0].area, 75, 'A minus B');
    const d = G.booleanRegions([A], [poly(rect(4, 4, 3, 3))], 'difference');
    ok(d.length === 1 && d[0].holes.length === 1 && near(d[0].area, 84), 'a square minus a square inside it is a frame');
    eq(G.booleanRegions([A], [poly(rect(10, 2, 0, 4))], 'difference').length, 2, 'a square cut right across is two pieces');
    eq(G.booleanRegions([A, poly(rect(10, 10, 10, 0))], [], 'union')[0].outline.length, 4, 'two abutting squares unite into one rectangle');

    // a cope: a 50 mm quarter circle bitten out of a corner, in 5° chords (19 points)
    const arc = [];
    for (let a = 0; a <= 90; a += 5) arc.push([50 * Math.cos((a * Math.PI) / 180), 50 * Math.sin((a * Math.PI) / 180)]);
    const coped = G.toPolygon([[...arc, [0, 300], [500, 300], [500, 0]]]);
    const s = G.simplifyOutward(coped, 0.5);
    ok(s.outline.length < coped.outline.length, `simplifyOutward: ${coped.outline.length} points become ${s.outline.length}`);
    ok(G.polygonArea(s) >= G.polygonArea(coped) && G.polygonArea(s) - G.polygonArea(coped) < 60, 'it only ever grows, and by a sliver');
    ok(coped.outline.every((p) => G.pointInPolygon(p, s) || G.pointPolygonBoundaryDistance(p, s) < 1e-6), 'every original point is in or on the simplified shape');
    ok(coped.outline.every((p) => G.pointPolygonBoundaryDistance(p, s) <= 0.5 + 1e-9), '… and never more than the tolerance inside it');
    ok(G.convexDecompose(s).length < G.convexDecompose(coped).length, 'fewer convex pieces to carry');
    // a convex shape is not touched
    eq(G.simplifyOutward(poly(circle(0, 0, 100)), 0.5).outline.length, 72, 'a convex outline is left alone (cutting its corners would shrink it)');
  });

  /* ─────────────────────────── the convention ─────────────────────────── */

  await test('placeRings is the placement convention', () => {
    const src = R([[10, 20], [110, 20], [10, 70]], [], []); // a triangle NOT at the origin: legs 100 and 50
    // 0°: normalised to the origin, then moved
    let p = placeRings(src, { x: 7, y: 9 });
    ok(p.outline[0][0] === 7 && p.outline[0][1] === 9 && p.outline[1][0] === 107 && p.outline[2][1] === 59, '0°: bbox corner goes to (x, y)');
    // 90° ccw: (x,y)->(-y,x): (0,0),(0,100),(-50,0) -> shifted by +50 in x -> (50,0),(50,100),(0,0)
    p = placeRings(src, { x: 0, y: 0, rotationDeg: 90 });
    ok(p.outline[0][0] === 50 && p.outline[0][1] === 0 && p.outline[1][0] === 50 && p.outline[1][1] === 100 && p.outline[2][0] === 0 && p.outline[2][1] === 0, '90°: turned counter-clockwise and re-normalised');
    // mirror first: (0,0),(-100,0),(0,50) -> +100 -> (100,0),(0,0),(100,50)
    p = placeRings(src, { x: 0, y: 0, mirrored: true });
    ok(p.outline[0][0] === 100 && p.outline[1][0] === 0 && p.outline[2][0] === 100 && p.outline[2][1] === 50, 'mirrored: about the y axis, re-normalised');
    // mirror THEN rotate 90: (0,0),(-100,0),(0,50) -> (0,0),(0,-100),(-50,0) -> +(50,100) -> (50,100),(50,0),(0,100)
    p = placeRings(src, { x: 1000, y: 2000, rotationDeg: 90, mirrored: true });
    ok(p.outline[0][0] === 1050 && p.outline[0][1] === 2100 && p.outline[1][0] === 1050 && p.outline[1][1] === 2000 && p.outline[2][0] === 1000 && p.outline[2][1] === 2100, 'mirror, then rotate, then normalise, then translate');
    // the array form comes back as the array form, closing point and all
    const arr = placeRings([[[0, 0], [10, 0], [10, 5], [0, 5], [0, 0]], [[2, 1], [4, 1], [4, 3], [2, 3]]], { x: 100, y: 100, rotationDeg: 180 });
    ok(Array.isArray(arr) && arr.length === 2 && arr[0].length === 5 && arr[0][0][0] === 110 && arr[0][0][1] === 105, 'array form in, array form out, point for point');
    ok(arr[1][0][0] === 108 && arr[1][0][1] === 104, 'cut-outs move with the outline');
    // a placement out of the packer already carries placed rings; a database row carries local ones
    const placed = placedRingsOf({ rings: p, x: 1000, y: 2000, rotationDeg: 90, mirrored: true });
    ok(placed.outline[0][0] === 1050, 'placedRingsOf leaves already-placed rings alone');
    const fromDb = placedRingsOf({ rings: src, x: 1000, y: 2000, rotationDeg: 90, mirrored: true });
    ok(fromDb.outline[0][0] === 1050 && fromDb.outline[0][1] === 2100, 'placedRingsOf places local rings by the convention');
  });

  /* ───────────────────────────── interlocking ─────────────────────────── */

  await test('right triangles pair up: 16 need 4 sheets as rectangles, 2 as triangles', () => {
    // A 1000×600 right triangle. As a rectangle a 2100×1300 sheet holds 2×2 = 4
    // (3+1000+3+1000+3 = 2009 along, 3+600+3+600+3 = 1209 across), so 16 need 4 sheets.
    // Two triangles hypotenuse to hypotenuse make a 1000×603.5 rectangle (3 mm
    // across a 31° hypotenuse is 3.5 mm up), so a sheet holds 8 and 16 need 2.
    const input = { pieces: [{ key: 'T', qty: 16, rings: tri(1000, 600), length: 1000, width: 600 }], sheets: [{ key: 'S', length: 2100, width: 1300 }], kerf: 3, margin: 3, effort: 'normal', seed: 1 };
    const r = run(input, 'triangles');
    const rr = rectOf(input);
    eq(rr.nests.length, 4, 'the rectangle packer needs 4 sheets');
    eq(r.totals.sheets, 2, 'the shape packer needs 2');
    ok(r.totals.wastePct < rectWaste(rr, input) - 1, `waste ${r.totals.wastePct.toFixed(2)}% is strictly better than the rectangle packer's ${rectWaste(rr, input).toFixed(2)}%`);
    eq(r.unplaced.length, 0, 'nothing left over');
    ok(r.source === 'shape', 'and the winning layout is this packer\'s own');
    note(`triangles: shape ${r.totals.sheets} sheets ${r.totals.wastePct.toFixed(2)}% waste (${r.tookMs} ms)  vs  rectangles ${rr.nests.length} sheets ${rectWaste(rr, input).toFixed(2)}%`);
  });

  await test('L-shapes interlock', () => {
    // 1000×1000 Ls with 400 arms. As rectangles a 3000×1500 sheet holds 2 (1000+1000+… = 2009, only one row),
    // so 8 need 4 sheets. Two Ls nested arm in arm occupy 1000×1403; the shape packer needs 2.
    const input = { pieces: [{ key: 'L', qty: 8, rings: ell(1000, 1000, 400, 400), length: 1000, width: 1000 }], sheets: [{ key: 'S', length: 3000, width: 1500 }], kerf: 3, margin: 3, effort: 'normal', seed: 1 };
    const r = run(input, 'Ls');
    const rr = rectOf(input);
    eq(rr.nests.length, 4, 'the rectangle packer needs 4 sheets');
    ok(r.totals.sheets <= 2, `the shape packer needs ${r.totals.sheets} (2 or fewer)`);
    ok(r.totals.wastePct < rectWaste(rr, input) - 1, `waste ${r.totals.wastePct.toFixed(2)}% beats ${rectWaste(rr, input).toFixed(2)}%`);
    note(`Ls: shape ${r.totals.sheets} sheets ${r.totals.wastePct.toFixed(2)}%  vs  rectangles ${rr.nests.length} sheets ${rectWaste(rr, input).toFixed(2)}%`);
  });

  await test('trapezoids alternate up and down', () => {
    // 1000 wide at the foot, 400 at the head, 500 tall. Side by side as rectangles: 1003 each.
    // 4 fit a 4600×510 strip (3+1000+3+…+3 = 4015; a fifth needs 5018). Alternating up and down
    // the pitch is 700 + 3.5 (3 mm across a side leaning 300 in 500), so 6 need 1000 + 5×703.5 = 4517.5.
    const input = { pieces: [{ key: 'Z', qty: 12, rings: trap(1000, 500, 300), length: 1000, width: 500 }], sheets: [{ key: 'S', length: 4600, width: 510 }], kerf: 3, margin: 0, effort: 'normal', seed: 1 };
    const r = run(input, 'trapezoids');
    const rr = rectOf(input);
    eq(rr.nests.length, 3, 'the rectangle packer needs 3 strips (4 each)');
    eq(r.totals.sheets, 2, 'the shape packer needs 2 (6 each)');
    ok(r.totals.wastePct < rectWaste(rr, input) - 1, `waste ${r.totals.wastePct.toFixed(2)}% beats ${rectWaste(rr, input).toFixed(2)}%`);
    note(`trapezoids: shape ${r.totals.sheets} sheets ${r.totals.wastePct.toFixed(2)}%  vs  rectangles ${rr.nests.length} sheets ${rectWaste(rr, input).toFixed(2)}%`);
  });

  await test('a mixed job of triangles, Ls and trapezoids beats the rectangle packer', () => {
    const input = {
      pieces: [
        { key: 'T', qty: 10, rings: tri(900, 500), length: 900, width: 500 },
        { key: 'L', qty: 6, rings: ell(800, 700, 300, 250), length: 800, width: 700 },
        { key: 'Z', qty: 8, rings: trap(700, 400, 200), length: 700, width: 400 },
        { key: 'R', qty: 6, rings: null, length: 400, width: 250 },
      ],
      sheets: [{ key: 'S', length: 3000, width: 1500 }], kerf: 3, margin: 5, effort: 'normal', seed: 3,
    };
    const r = run(input, 'mixed');
    const rr = rectOf(input);
    ok(r.totals.sheets < rr.nests.length, `sheets: ${r.totals.sheets} against the rectangle packer's ${rr.nests.length}`);
    ok(r.totals.wastePct < rectWaste(rr, input), `waste ${r.totals.wastePct.toFixed(2)}% against ${rectWaste(rr, input).toFixed(2)}%`);
    note(`mixed: shape ${r.totals.sheets} sheets ${r.totals.wastePct.toFixed(2)}%  vs  rectangles ${rr.nests.length} sheets ${rectWaste(rr, input).toFixed(2)}%`);
  });

  /* ───────────────────────────── part in part ─────────────────────────── */

  await test('a small part is cut from the window of a frame', () => {
    // The frame is 1000×800 with a 700×500 window; the sheet is the frame plus its rim and nothing more.
    // Two 300×200 parts can only go in the window: 3+300+3+300+3 = 609 <= 700.
    const frame = R(rect(1000, 800), [rect(700, 500, 150, 150)]);
    const input = { pieces: [{ key: 'F', qty: 1, rings: frame }, { key: 'small', qty: 2, rings: null, length: 300, width: 200 }], sheets: [{ key: 'S', length: 1010, width: 810, available: 1 }], kerf: 3, margin: 5, effort: 'normal' };
    const r = run(input, 'frame');
    eq(r.totals.sheets, 1, 'everything is on the one sheet');
    eq(r.unplaced.length, 0, 'nothing left over');
    const win = { x0: 155 + 3, y0: 155 + 3, x1: 855 - 3, y1: 655 - 3 }; // the window, less a kerf, with the frame at (5,5)
    for (const p of r.nests[0].placements.filter((q) => q.key === 'small')) {
      ok(p.bbox.x0 >= win.x0 - 1e-6 && p.bbox.x1 <= win.x1 + 1e-6 && p.bbox.y0 >= win.y0 - 1e-6 && p.bbox.y1 <= win.y1 + 1e-6, `small#${p.n} sits in the window, a kerf clear of it`);
    }
    // partArea = frame (800000 − 350000) + 2 × 60000; usedArea = the frame's outline only
    eq(r.nests[0].metrics.partArea, 450000 + 120000, 'partArea counts the frame and both small parts');
    eq(r.nests[0].metrics.usedArea, 800000, 'usedArea counts only the frame: the others are in its window');

    // With part-in-part switched off the window is solid: they need a sheet of their own.
    const many = [{ key: 'S', length: 1010, width: 810 }];
    const off = run({ ...input, sheets: many, partInPart: false }, 'frame, partInPart off');
    eq(off.totals.sheets, 2, 'partInPart:false: the small parts go on a second sheet');
    eq(run({ ...input, sheets: many }, 'frame, unlimited sheets').totals.sheets, 1, '… where with it on, one sheet does');

    // A part bigger than the window is never put in it: 720 > 700.
    const big = run({ ...input, sheets: many, pieces: [input.pieces[0], { key: 'wide', qty: 1, rings: null, length: 720, width: 100 }] }, 'frame, part too big for the window');
    eq(big.totals.sheets, 2, 'a part wider than the window goes on another sheet');
    // … and nothing is put in a 50 mm drilled hole, however small: drilled holes are steel.
    const drilled = R(rect(300, 300), [], [circle(150, 150, 25)]);
    const dr = run({ pieces: [{ key: 'D', qty: 1, rings: drilled }, { key: 'dot', qty: 1, rings: null, length: 20, width: 20 }], sheets: [{ key: 'S', length: 310, width: 310 }], kerf: 2, margin: 5 }, 'drilled hole');
    eq(dr.totals.sheets, 2, 'nothing is placed in a drilled hole');
    eq(dr.nests.find((n) => n.placements[0].key === 'D').metrics.partArea, 90000 - G.ringArea(circle(150, 150, 25)), 'but the hole is not counted as steel in the part', 1e-6);
  });

  await test('round parts: discs go inside rings and between them (arcs as 5° chords, rounded to 0.1 mm)', () => {
    // What partGeometry hands over: circles as 72 chords, coordinates rounded to a tenth.
    const c = (cx, cy, r, n = 72) => circle(cx, cy, r, n).map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    const input = {
      pieces: [
        { key: 'ring', qty: 12, rings: R(c(400, 400, 400), [c(400, 400, 260)]) },
        { key: 'disc', qty: 20, rings: R(c(120, 120, 120)) },
        { key: 'flange', qty: 8, rings: R(c(250, 250, 250), [c(250, 250, 90)], Array.from({ length: 8 }, (_, i) => c(250 + 180 * Math.cos((i * Math.PI) / 4), 250 + 180 * Math.sin((i * Math.PI) / 4), 11, 16))) },
        { key: 'bar', qty: 10, rings: null, length: 900, width: 120 },
      ],
      sheets: [{ key: 'S', length: 6000, width: 2000 }], kerf: 4, margin: 8, effort: 'quick',
    };
    const r = run(input, 'round');
    const rr = rectOf(input, 'quick');
    eq(r.unplaced.length, 0, 'everything placed');
    ok(r.totals.sheets < rr.nests.length, `sheets: ${r.totals.sheets} against the rectangle packer's ${rr.nests.length}`);
    // a disc is "in a ring" when its centre is within 140 of a ring's centre (260 − 120 = 140 is as far as it can go)
    const centre = (p) => [(p.bbox.x0 + p.bbox.x1) / 2, (p.bbox.y0 + p.bbox.y1) / 2];
    let inside = 0;
    for (const n of r.nests) {
      const ringsHere = n.placements.filter((p) => p.key === 'ring').map(centre);
      for (const d of n.placements.filter((p) => p.key === 'disc').map(centre)) if (ringsHere.some((q) => Math.hypot(d[0] - q[0], d[1] - q[1]) < 140)) inside += 1;
    }
    ok(inside >= 6, `${inside} of the 20 discs were cut from inside a ring`);
    eq(r.notes.length, 0, 'no shape had to be coarsened');
    // every disc inside a ring really is clear of it by the kerf — measured on the true 72-chord circles
    note(`round parts: shape ${r.totals.sheets} sheet(s) ${r.totals.wastePct.toFixed(2)}% (${inside} discs inside rings, ${r.tookMs} ms)  vs  rectangles ${rr.nests.length} sheets ${rectWaste(rr, input).toFixed(2)}%`);
  });

  await test('a shape too intricate to nest against exactly is coarsened, never mis-nested', () => {
    // A comb with 40 teeth is 41 convex pieces. With maxPieces 16 it is traded for its convex hull —
    // which CONTAINS it, so the layout is still legal (checked on the true comb), just less tight.
    const comb = [[0, 0], [1200, 0], [1200, 60]];
    for (let i = 39; i >= 0; i -= 1) comb.push([i * 30 + 20, 60], [i * 30 + 20, 200], [i * 30 + 5, 200], [i * 30 + 5, 60]);
    comb.push([0, 60]);
    const input = { pieces: [{ key: 'comb', qty: 4, rings: R(comb) }, { key: 'pin', qty: 6, rings: null, length: 100, width: 8 }], sheets: [{ key: 'S', length: 2500, width: 700 }], kerf: 2, margin: 5 };
    const fine = run(input, 'comb, exact');
    eq(fine.notes.length, 0, 'at the default it is nested exactly');
    const coarse = run({ ...input, maxPieces: 16 }, 'comb, coarsened');
    ok(coarse.notes.length === 1 && /comb/.test(coarse.notes[0]), `maxPieces 16: said so — "${coarse.notes[0]}"`);
    eq(coarse.unplaced.length, 0, 'and everything is still placed');
    eq(coarse.warnings.length, 0, 'coarsening is a note, not a fault');
  });

  /* ─────────────────────────── grain and mirroring ────────────────────── */

  await test('grain fixes the orientation; mirroring only when allowed', () => {
    // A 900×300 part on a sheet 950 wide and 2000 long (x is the length). Free, it may stand or lie.
    // grain 'length': only 0°/180°. grain 'width': only 90°/270° — the same meaning as nestingPacker.
    const sheet = [{ key: 'S', length: 2000, width: 950 }];
    const chiral = R([[0, 0], [900, 0], [900, 100], [200, 100], [200, 300], [0, 300]]); // an L: its mirror image is a different part
    const gl = run({ pieces: [{ key: 'A', qty: 6, rings: chiral, grain: 'length' }], sheets: sheet, kerf: 3, margin: 3 }, 'grain length');
    ok(gl.nests.every((n) => n.placements.every((p) => p.rotationDeg === 0 || p.rotationDeg === 180)), "grain 'length': every copy at 0° or 180°");
    ok(gl.nests.some((n) => n.placements.some((p) => p.rotationDeg === 180)), '… and 180° is used (the Ls nest head to toe)');
    const gw = run({ pieces: [{ key: 'A', qty: 4, rings: chiral, grain: 'width' }], sheets: sheet, kerf: 3, margin: 3 }, 'grain width');
    ok(gw.nests.every((n) => n.placements.every((p) => p.rotationDeg === 90 || p.rotationDeg === 270)), "grain 'width': every copy at 90° or 270°");
    // a grain-bound part too long to lie along the sheet is refused, not turned
    const no = run({ pieces: [{ key: 'A', qty: 1, rings: null, length: 900, width: 300, grain: 'width' }], sheets: [{ key: 'S', length: 2000, width: 600 }], kerf: 3, margin: 3 }, 'grain refuses');
    eq(no.unplaced.length, 1, "grain 'width' on a 600-wide sheet: a 900 part cannot be turned to fit, so it is unplaced");
    // rotations restricts a free part
    const only0 = run({ pieces: [{ key: 'A', qty: 5, rings: chiral }], sheets: sheet, kerf: 3, margin: 3, rotations: [0] }, 'rotations [0]');
    ok(only0.nests.every((n) => n.placements.every((p) => p.rotationDeg === 0)), 'rotations: [0] keeps every copy at 0°');
    // free rotation in steps
    const step = run({ pieces: [{ key: 'T', qty: 6, rings: tri(700, 400) }], sheets: [{ key: 'S', length: 2500, width: 1200 }], kerf: 3, margin: 3, rotations: { stepDeg: 45 } }, 'stepDeg 45');
    ok(step.nests.every((n) => n.placements.every((p) => p.rotationDeg % 45 === 0)), 'rotations: { stepDeg: 45 } uses multiples of 45°');
    // mirroring
    const nm = run({ pieces: [{ key: 'A', qty: 8, rings: chiral }], sheets: sheet, kerf: 3, margin: 3, effort: 'normal' }, 'no mirror');
    ok(nm.nests.every((n) => n.placements.every((p) => p.mirrored === false)), 'allowMirror false (the default): never mirrored');
    // An offcut that is exactly the MIRROR IMAGE of the part: no rotation of the part fits it, its
    // mirror image does. So allowed to mirror it is placed (mirrored); not allowed, it is refused.
    const mirrorSheet = [{ key: 'M', available: 1, outline: [[0, 0], [900, 0], [900, 300], [700, 300], [700, 100], [0, 100]] }];
    const m1 = run({ pieces: [{ key: 'A', qty: 1, rings: chiral, allowMirror: true }], sheets: mirrorSheet, kerf: 3, margin: 0 }, 'mirror allowed');
    eq(m1.unplaced.length, 0, 'allowMirror: the part goes on its mirror-image offcut');
    ok(m1.nests[0]?.placements[0].mirrored === true, '… mirrored');
    const m0 = run({ pieces: [{ key: 'A', qty: 1, rings: chiral }], sheets: mirrorSheet, kerf: 3, margin: 0 }, 'mirror not allowed');
    eq(m0.unplaced.length, 1, 'not allowed to mirror, it does not fit at any rotation and is refused');
  });

  /* ───────────────────────────── kerf and margin ──────────────────────── */

  await test('kerf and margin are held exactly', () => {
    // Two 100 squares, kerf 5, margin 10: 10 + 100 + 5 + 100 + 10 = 225 along, 10 + 100 + 10 = 120 across.
    const two = (len) => ({ pieces: [{ key: 'Q', qty: 2, rings: null, length: 100, width: 100 }], sheets: [{ key: 'S', length: len, width: 120, available: 1 }], kerf: 5, margin: 10 });
    const fit = run(two(225), 'kerf: 225');
    eq(fit.nests[0].placements.length, 2, 'a 225 sheet holds both');
    const xs = fit.nests[0].placements.map((p) => p.x).sort((a, b) => a - b);
    eq(xs[0], 10, 'the first is a margin in'); eq(xs[1], 115, 'the second is a kerf beyond the first');
    const tight = run(two(224.99), 'kerf: 224.99');
    eq(tight.nests[0].placements.length, 1, 'a 224.99 sheet holds one');
    eq(tight.unplaced[0].qty, 1, '… and reports the other');
    // kerfAtRim: the rim is cut too, so the clearance to the edge is margin + kerf
    const rim = run({ ...two(235), sheets: [{ key: 'S', length: 235, width: 130, available: 1 }], kerfAtRim: true }, 'kerfAtRim');
    eq(Math.min(...rim.nests[0].placements.map((p) => p.x)), 15, 'kerfAtRim: the first part is margin + kerf in');
    eq(rim.margin, 15, 'and the result says what clearance it used');
    // diagonal neighbours and slanted edges: the kerf is a true distance, not a box gap
    const tr = run({ pieces: [{ key: 'T', qty: 6, rings: tri(400, 300) }], sheets: [{ key: 'S', length: 900, width: 700 }], kerf: 8, margin: 12 }, 'kerf on slants');
    for (const n of tr.nests) {
      for (let i = 0; i < n.placements.length; i += 1) {
        for (let j = i + 1; j < n.placements.length; j += 1) {
          const d = G.polygonsDistance(G.toPolygon(n.placements[i].rings), G.toPolygon(n.placements[j].rings));
          ok(d >= 8 - 1e-6, `triangles ${i} and ${j} are ${d.toFixed(4)} mm apart, kerf is 8`);
        }
      }
    }
    // A kerf WIDER than the rectangle packer's 6 mm sequence clearance. Its layout would put parts
    // 6 mm apart; taken as it stands that is nearer than the kerf. (Found by fuzzing: kerf 12.)
    const wide = run({ pieces: [{ key: 'a', qty: 7, rings: null, length: 873, width: 52 }, { key: 'b', qty: 8, rings: null, length: 82, width: 15 }, { key: 'c', qty: 8, rings: null, length: 1131, width: 624 }], sheets: [{ key: 'S', length: 2000, width: 1000 }], kerf: 12, margin: 3, effort: 'quick' }, 'kerf 12');
    eq(wide.unplaced.length, 0, 'kerf 12: everything placed, every pair a full kerf apart');
    ok(wide.rectFloor != null, 'and the rectangle floor was still usable (run with its sequence clearance raised to the kerf)');
    // kerf 0 and margin 0: parts may touch each other and the edge
    const zero = run({ pieces: [{ key: 'Q', qty: 4, rings: null, length: 100, width: 100 }], sheets: [{ key: 'S', length: 200, width: 200, available: 1 }], kerf: 0, margin: 0 }, 'kerf 0');
    eq(zero.nests[0].placements.length, 4, 'kerf 0, margin 0: four 100 squares fill a 200 square');
    eq(zero.totals.wastePct, 0, '… with no waste at all');
  });

  /* ─────────────────────────────── fixed parts ────────────────────────── */

  await test('a sheet with parts already on it is filled first, and they do not move', () => {
    // A 2000×1000 nest already holds a 1200×990 plate at (5,5) and a triangle. New parts must go
    // round them — and the fresh 2000×1000 sheet must NOT be opened while the old one has room.
    const fixed = [
      { key: 'old-plate', rings: null, length: 1200, width: 600, x: 5, y: 5, rotationDeg: 0, mirrored: false },
      { key: 'old-tri', rings: tri(600, 380), x: 5, y: 610, rotationDeg: 0, mirrored: false },
    ];
    const input = {
      pieces: [{ key: 'N', qty: 4, rings: null, length: 350, width: 480 }, { key: 'T', qty: 1, rings: tri(590, 370) }],
      sheets: [{ key: 'EXISTING', length: 2000, width: 1000, available: 1, fixed }, { key: 'FRESH', length: 2000, width: 1000 }],
      kerf: 3, margin: 5, effort: 'normal',
    };
    const before = JSON.stringify(fixed);
    const r = run(input, 'fixed');
    eq(JSON.stringify(fixed) === before ? 1 : 0, 1, 'the fixed parts handed in are untouched');
    eq(r.totals.sheets, 1, 'everything went onto the existing sheet');
    is(r.nests[0].sheetKey, 'EXISTING', '… the existing one, not a fresh one');
    eq(r.nests[0].placements.length, 5, 'all five new parts are on it');
    eq(r.nests[0].fixedCount, 2, 'and it reports the two that were already there');
    ok(r.nests[0].placements.every((p) => !String(p.key).startsWith('old')), 'fixed parts are not echoed as new placements');
    // the new triangle is the old one's mate: it can only fit hypotenuse to hypotenuse above the old plate
    const t = r.nests[0].placements.find((p) => p.key === 'T');
    ok(t.bbox.x1 <= 1205 + 600 && t.bbox.y0 >= 600, `the new triangle tucked in beside the old one (at ${t.x.toFixed(1)}, ${t.y.toFixed(1)}, ${t.rotationDeg}°)`);
    // metrics describe the whole plate
    eq(r.nests[0].metrics.parts, 7, 'metrics count the fixed parts too');
    // when the existing sheet is full the rest goes to a fresh one
    const more = run({ ...input, pieces: [{ key: 'N', qty: 12, rings: null, length: 350, width: 480 }] }, 'fixed, overflow');
    ok(more.nests[0].sheetKey === 'EXISTING' && more.nests.length >= 2, 'overflow: the existing sheet is used first, then fresh ones');
    eq(more.unplaced.length, 0, 'overflow: nothing left over');
    // placements fed straight back as fixed (their rings are already in sheet mm)
    const again = run({
      pieces: [{ key: 'X', qty: 2, rings: null, length: 100, width: 100 }],
      sheets: [{ key: 'EXISTING', length: 2000, width: 1000, available: 1, fixed: [...fixed, ...r.nests[0].placements] }],
      kerf: 3, margin: 5,
    }, 'fixed, round trip');
    eq(again.nests[0].fixedCount, 7, 'a result\'s placements can be handed back as fixed parts');
  });

  /* ──────────────────────────── an L-shaped offcut ────────────────────── */

  await test('a non-rectangular sheet: parts stay inside an L-shaped offcut', () => {
    // An offcut 2000×1500 with a 1200×900 bite out of its top-right corner: an L of 800 and 600 arms.
    const outline = [[0, 0], [2000, 0], [2000, 600], [800, 600], [800, 1500], [0, 1500]];
    const input = { pieces: [{ key: 'A', qty: 3, rings: null, length: 700, width: 500 }, { key: 'B', qty: 4, rings: tri(500, 400) }], sheets: [{ key: 'OFFCUT', length: 2000, width: 1500, available: 1, outline }], kerf: 3, margin: 10, effort: 'normal' };
    const r = run(input, 'offcut');
    eq(r.unplaced.length, 0, 'everything fits on the offcut');
    eq(r.nests[0].metrics.sheetArea, 2000 * 600 + 800 * 900, 'the sheet area is the L, not its bounding box');
    for (const p of r.nests[0].placements) {
      const inBite = p.bbox.x1 > 800 - 10 + 1e-6 && p.bbox.y1 > 600 - 10 + 1e-6 && G.polygonsOverlap(G.toPolygon(p.rings), poly(rect(1200 + 10, 900 + 10, 790, 590)));
      ok(!inBite, `${p.key}#${p.n} keeps out of the bite and its margin`);
    }
    // An 850 square fits the 2000×1500 bounding box but neither arm of the L (800 and 600 wide): refused.
    const no = run({ ...input, pieces: [{ key: 'BIG', qty: 1, rings: null, length: 850, width: 850 }] }, 'offcut, too big for the L');
    eq(no.unplaced.length, 1, 'a part that fits the bounding box but not the L is unplaced');
    eq(no.nests.length, 0, '… and no nest is invented for it');
    // outline given WITHOUT length/width: they come from the outline
    const bare = run({ ...input, sheets: [{ key: 'OFFCUT', available: 1, outline }] }, 'offcut, no length/width');
    eq(bare.unplaced.length, 0, 'length and width may be left to the outline');
  });

  /* ─────────────────────────────── unplaced ───────────────────────────── */

  await test('a part bigger than every sheet is reported, and the rest are still placed', () => {
    const input = {
      pieces: [{ key: 'HUGE', qty: 2, rings: null, length: 3000, width: 2000 }, { key: 'ok', qty: 5, rings: tri(400, 300) }, { key: 'LONG', qty: 1, rings: R([[0, 0], [2500, 0], [2500, 50], [0, 50]]) }],
      sheets: [{ key: 'S', length: 2000, width: 1000 }], kerf: 3, margin: 5,
    };
    const r = run(input, 'unplaced');
    const u = new Map(r.unplaced.map((x) => [x.key, x]));
    eq(u.get('HUGE')?.qty, 2, 'both copies of the huge part are reported');
    ok(/does not fit any offered plate/.test(u.get('HUGE')?.reason ?? ''), `with a reason a person can read: "${u.get('HUGE')?.reason}"`);
    eq(u.get('LONG')?.qty, 1, 'a part too long in every allowed orientation is reported too');
    eq(r.nests.reduce((s, n) => s + n.placements.length, 0), 5, 'the five that fit are placed');
    // A part that only the one wide offcut can take is laid FIRST, though bigger parts are waiting:
    // a 1200 disc fits the 1500-wide drop and not the 1000-wide stock. Biggest-first would fill
    // the drop with a 2500×900 plate and then report the disc as having nowhere to go.
    const fussy = run({
      pieces: [{ key: 'plate', qty: 3, rings: null, length: 2500, width: 900 }, { key: 'disc', qty: 1, rings: R(circle(600, 600, 600)) }],
      sheets: [{ key: 'DROP', length: 3000, width: 1500, available: 1, preferred: true }, { key: 'STOCK', length: 3000, width: 1000 }], kerf: 3, margin: 5,
    }, 'fussy first');
    eq(fussy.unplaced.length, 0, 'the part only the offcut can take is not crowded out of it');
    is(fussy.nests.find((n) => n.placements.some((p) => p.key === 'disc'))?.sheetKey, 'DROP', '… it is on the offcut');
    // out of plates: 3 available, each holds 2
    const few = run({ pieces: [{ key: 'P', qty: 10, rings: null, length: 900, width: 900 }], sheets: [{ key: 'S', length: 2000, width: 1000, available: 3 }], kerf: 3, margin: 5 }, 'out of plates');
    eq(few.nests.length, 3, 'three plates were available and three were used');
    eq(few.unplaced[0]?.qty, 4, 'the four that did not fit are reported');
    ok(/no plate had room/.test(few.unplaced[0]?.reason ?? ''), 'with the reason');
    // nothing offered at all
    const none = run({ pieces: [{ key: 'P', qty: 1, rings: null, length: 10, width: 10 }], sheets: [], kerf: 3 }, 'no sheets');
    ok(none.nests.length === 0 && /no plates were offered/.test(none.unplaced[0].reason), 'no sheets offered: said so');
    eq(packShapes({ pieces: [], sheets: [], kerf: 3 }).nests.length, 0, 'nothing in, nothing out');
  });

  /* ─────────────────────────────── plate choice ───────────────────────── */

  await test('plate choice follows nestingPacker: owned first, then cost per area placed', () => {
    const parts = [{ key: 'P', qty: 4, rings: tri(900, 500) }];
    // An owned offcut that holds everything ends the contest, however good the bought plate.
    const owned = run({ pieces: parts, sheets: [{ key: 'BUY', length: 3000, width: 1500 }, { key: 'DROP', length: 2000, width: 1100, available: 1, preferred: true }], kerf: 3, margin: 5 }, 'owned first');
    eq(owned.nests.length, 1, 'one plate');
    is(owned.nests[0].sheetKey, 'DROP', 'the owned offcut is used before anything is bought');
    eq(owned.totals.areaBought, 0, 'and nothing is bought');
    // Of two sizes to buy, the one that wastes less of what it costs.
    const sized = run({ pieces: parts, sheets: [{ key: 'BIG', length: 6000, width: 2000 }, { key: 'FIT', length: 2000, width: 1100 }], kerf: 3, margin: 5 }, 'cheaper size');
    is(sized.nests[0].sheetKey, 'FIT', 'the size that fits is bought, not the big one');
    // areaCost overrides the plate's own area
    const priced = run({ pieces: parts, sheets: [{ key: 'BIG', length: 6000, width: 2000, areaCost: 1000 }, { key: 'FIT', length: 2000, width: 1100 }], kerf: 3, margin: 5 }, 'areaCost');
    is(priced.nests[0].sheetKey, 'BIG', 'a plate priced at almost nothing is preferred');
    // input order cannot matter
    const a = packShapes({ pieces: parts, sheets: [{ key: 'A', length: 2500, width: 1200 }, { key: 'B', length: 2000, width: 1100 }], kerf: 3, margin: 5 });
    const b = packShapes({ pieces: parts, sheets: [{ key: 'B', length: 2000, width: 1100 }, { key: 'A', length: 2500, width: 1200 }], kerf: 3, margin: 5 });
    ok(JSON.stringify(a.nests) === JSON.stringify(b.nests), 'the candidate plates are sorted: their input order does not change the answer');
    // availability is honoured
    const lim = run({ pieces: [{ key: 'P', qty: 6, rings: null, length: 900, width: 900 }], sheets: [{ key: 'DROP', length: 1900, width: 950, available: 2, preferred: true }, { key: 'BUY', length: 1900, width: 950 }], kerf: 3, margin: 5 }, 'availability');
    eq(lim.nests.filter((n) => n.sheetKey === 'DROP').length, 2, 'both owned plates are used');
    eq(lim.nests.filter((n) => n.sheetKey === 'BUY').length, 1, 'and exactly one is bought for the rest');
  });

  /* ───────────────────── never worse than the rectangle packer ────────── */

  const rectJobs = () => {
    const rng = mulberry32(5);
    const I = (a, b) => Math.round(a + rng() * (b - a));
    return [
      { name: 'stiffeners and webs', pieces: [{ key: 'web', qty: 6, length: 5990, width: 1195 }, { key: 'stf', qty: 60, length: 1100, width: 180 }, { key: 'pad', qty: 40, length: 300, width: 220 }, { key: 'flg', qty: 8, length: 5990, width: 400, grain: 'length' }], sheets: [{ key: 'PL', length: 12000, width: 2500 }], kerf: 3, margin: 0 },
      { name: 'thirty random sizes, two plate sizes and a drop', pieces: Array.from({ length: 30 }, (_, i) => ({ key: `r${i}`, qty: I(1, 9), length: I(200, 2400), width: I(100, 900), grain: i % 7 === 0 ? 'width' : 'any' })), sheets: [{ key: 'A', length: 6000, width: 2000 }, { key: 'B', length: 8000, width: 2500 }, { key: 'DROP', length: 3000, width: 1500, available: 2, preferred: true }], kerf: 4, margin: 5 },
      { name: 'small parts', pieces: Array.from({ length: 12 }, (_, i) => ({ key: `s${i}`, qty: I(10, 40), length: I(60, 190), width: I(40, 150) })), sheets: [{ key: 'S', length: 2500, width: 1250 }], kerf: 2.5, margin: 0 },
    ];
  };

  await test('all-rectangle jobs: never worse than nestingPacker on the same inputs (3 jobs)', () => {
    for (const job of rectJobs()) {
      const input = { ...job, pieces: job.pieces.map((p) => ({ ...p, rings: null })), effort: 'normal', seed: 2 };
      const t0 = Date.now();
      const rr = nest({ pieces: job.pieces, sheets: job.sheets.map((s) => ({ ...s, available: s.available ?? null })), kerf: job.kerf, margin: job.margin, effort: 'standard', seed: 2 });
      const tRect = Date.now() - t0;
      const r = run(input, `parity: ${job.name}`);
      const rectUnplaced = rr.unplaced.reduce((s, u) => s + u.qty, 0);
      const mine = r.unplaced.reduce((s, u) => s + u.qty, 0);
      ok(mine <= rectUnplaced, `${job.name}: unplaced ${mine} against ${rectUnplaced}`);
      ok(r.totals.sheets <= rr.nests.length, `${job.name}: sheets ${r.totals.sheets} against ${rr.nests.length}`);
      const rectSheetArea = rr.nests.reduce((s, n) => s + n.sheetArea, 0);
      if (mine === rectUnplaced && r.totals.sheets === rr.nests.length) {
        ok(r.totals.sheetArea <= rectSheetArea + 1e-6, `${job.name}: same sheets, so plate area ${r.totals.sheetArea} must not exceed ${rectSheetArea}`);
        ok(r.totals.wastePct <= rr.wastePct + 1e-9, `${job.name}: waste ${r.totals.wastePct.toFixed(3)}% against ${rr.wastePct.toFixed(3)}%`);
      }
      ok(r.totals.areaBought <= rr.areaBought + 1e-6, `${job.name}: steel bought ${r.totals.areaBought} against ${rr.areaBought}`);
      ok(r.rectFloor && r.rectFloor.sheets === rr.nests.length, `${job.name}: the floor it measured itself against is that same run`);
      note(`rect parity — ${job.name}: shape ${r.totals.sheets} sheets ${r.totals.wastePct.toFixed(2)}% [${r.source}] ${r.tookMs} ms  vs  nestingPacker ${rr.nests.length} sheets ${rr.wastePct.toFixed(2)}% ${tRect} ms`);
    }
  });

  await test('a start layout is never made worse — and is improved when it can be', () => {
    // Start from the rectangle packer's own layout of triangles (4 sheets). The answer may not use more.
    const input = { pieces: [{ key: 'T', qty: 16, rings: tri(1000, 600), length: 1000, width: 600 }], sheets: [{ key: 'S', length: 2100, width: 1300 }], kerf: 3, margin: 3, seed: 1 };
    const rr = rectOf(input);
    const start = rr.nests.map((n) => ({ sheetKey: n.sheetKey, placements: n.pieces.map((p) => ({ key: p.key, x: p.x, y: p.y, rotationDeg: p.rotated ? 90 : 0, mirrored: false })) }));
    const improved = run({ ...input, effort: 'normal', start, rectFloor: false }, 'start, improved');
    ok(improved.totals.sheets <= rr.nests.length, `never more sheets than the start (${improved.totals.sheets} against ${rr.nests.length})`);
    eq(improved.totals.sheets, 2, 'and here it is improved to 2');

    // A start that is already as good as it gets is returned as it stands: 2 parts that fill the sheet.
    const tightIn = { pieces: [{ key: 'A', qty: 2, rings: null, length: 1000, width: 500 }], sheets: [{ key: 'S', length: 1000, width: 1003 }], kerf: 3, margin: 0, rectFloor: false };
    const tightStart = [{ sheetKey: 'S', placements: [{ key: 'A', x: 0, y: 503, rotationDeg: 0, mirrored: false }, { key: 'A', x: 0, y: 0, rotationDeg: 180, mirrored: false }] }];
    const kept = run({ ...tightIn, start: tightStart }, 'start, kept');
    eq(kept.totals.sheets, 1, 'still one sheet');
    is(kept.guardSource, 'start', 'the start was the floor');

    // A start that only covers part of the job: its parts stay, the rest are added.
    const part = run({ ...input, effort: 'quick', rectFloor: false, start: [start[0]] }, 'start, partial');
    eq(part.unplaced.length, 0, 'a partial start is completed');
    ok(part.totals.sheets <= 4, 'and is no worse than finishing it naively');

    // An ILLEGAL start is not trusted: two parts on top of each other.
    const badStart = [{ sheetKey: 'S', placements: [{ key: 'T', x: 3, y: 3, rotationDeg: 0 }, { key: 'T', x: 10, y: 10, rotationDeg: 0 }] }];
    const bad = packShapes({ ...input, effort: 'quick', start: badStart });
    check(bad, input, 'start, illegal', { allowWarnings: true });
    ok(bad.warnings.some((w) => /start layout ignored/.test(w)), `an overlapping start is ignored, and said so: "${bad.warnings[0]}"`);

    // On random jobs: the result is never worse than the start in sheets, then waste.
    const rng = mulberry32(21);
    for (let j = 0; j < 4; j += 1) {
      const pieces = Array.from({ length: 6 }, (_, i) => { const w = Math.round(200 + rng() * 700); const h = Math.round(150 + rng() * 500); return { key: `k${i}`, qty: 1 + Math.floor(rng() * 5), rings: i % 2 ? tri(w, h) : null, length: w, width: h }; });
      const job = { pieces, sheets: [{ key: 'S', length: 2400, width: 1200 }], kerf: 3, margin: 4, seed: j };
      const base = rectOf(job, 'quick');
      const st = base.nests.map((n) => ({ sheetKey: n.sheetKey, placements: n.pieces.map((p) => ({ key: p.key, x: p.x, y: p.y, rotationDeg: p.rotated ? 90 : 0 })) }));
      const r = run({ ...job, effort: 'quick', start: st, rectFloor: false }, `start, random ${j}`);
      ok(r.totals.sheets <= base.nests.length, `random ${j}: sheets ${r.totals.sheets} against the start's ${base.nests.length}`);
      if (r.totals.sheets === base.nests.length) ok(r.totals.sheetArea <= base.nests.reduce((s, n) => s + n.sheetArea, 0) + 1e-6, `random ${j}: same sheets, no more plate area`);
    }
  });

  /* ────────────────────────────── determinism ─────────────────────────── */

  await test('same seed, same answer — and the async path agrees', async () => {
    const input = {
      pieces: [{ key: 'T', qty: 9, rings: tri(900, 500) }, { key: 'L', qty: 5, rings: ell(800, 700, 300, 250) }, { key: 'R', qty: 7, rings: null, length: 400, width: 250 }, { key: 'Z', qty: 6, rings: trap(700, 400, 200) }],
      sheets: [{ key: 'S', length: 3000, width: 1500 }], kerf: 3, margin: 5, effort: 'normal', seed: 42,
    };
    const strip = (r) => JSON.stringify(r.nests.map((n) => [n.sheetKey, n.placements.map((p) => [p.key, p.n, p.x, p.y, p.rotationDeg, p.mirrored])]));
    const a = run(input, 'determinism a');
    const b = packShapes(input);
    ok(a.deterministic && b.deterministic, 'neither run was cut short by the clock');
    ok(strip(a) === strip(b), 'two runs with the same seed give the identical layout');
    const c = await packShapesAsync(input);
    ok(strip(a) === strip(c), 'packShapesAsync gives the identical layout');
    const d = packShapes({ ...input, seed: 43 });
    check(d, input, 'determinism, other seed');
    ok(d.totals.sheets <= a.totals.sheets + 1, 'another seed is another search, not another problem');
    // quick is the floor of normal: more effort is never worse
    const q = run({ ...input, effort: 'quick' }, 'effort quick');
    ok(a.totals.sheets < q.totals.sheets || (a.totals.sheets === q.totals.sheets && a.totals.sheetArea <= q.totals.sheetArea + 1e-6), `normal (${a.totals.sheets}) is never worse than quick (${q.totals.sheets})`);
  });

  await test('packShapesAsync lets the event loop through', async () => {
    const job = bigJob(3, 30, 200);
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    const r = await packShapesAsync({ ...job, effort: 'quick' });
    clearInterval(timer);
    check(r, job, 'async');
    ok(ticks >= 3, `the event loop ran ${ticks} times while it packed (${r.tookMs} ms)`);
  });

  /* ─────────────────────────────── performance ────────────────────────── */

  await test('MEASURED: 600 pieces of 60 shapes over 12000×2500 plates — quick ≤ 10 s, normal ≤ 60 s, deep bounded', () => {
    const job = bigJob();
    const total = job.pieces.reduce((s, p) => s + p.qty, 0);
    eq(total, 600, 'the job is 600 pieces');
    const t0 = Date.now();
    const rr = rectOf(job, 'quick');
    const tRect = Date.now() - t0;
    const rw = rectWaste(rr, job);

    const q = run({ ...job, effort: 'quick', budgetMs: 8_000 }, 'perf quick');
    ok(q.tookMs <= 10_000, `quick took ${q.tookMs} ms (limit 10 000)`);
    ok(q.totals.sheets <= rr.nests.length, `quick: ${q.totals.sheets} sheets against the rectangle packer's ${rr.nests.length}`);
    note(`600 pieces — rectangles (quick): ${rr.nests.length} sheets, ${rw.toFixed(2)}% waste, ${tRect} ms`);
    note(`600 pieces — shape quick:  ${q.totals.sheets} sheets, ${q.totals.wastePct.toFixed(2)}% waste, ${q.tookMs} ms [${q.source}]`);

    const n = run({ ...job, effort: 'normal', budgetMs: 30_000 }, 'perf normal');
    ok(n.tookMs <= 60_000, `normal took ${n.tookMs} ms (limit 60 000)`);
    ok(n.totals.sheets <= q.totals.sheets, `normal (${n.totals.sheets}) is never worse than quick (${q.totals.sheets})`);
    note(`600 pieces — shape normal: ${n.totals.sheets} sheets, ${n.totals.wastePct.toFixed(2)}% waste, ${n.tookMs} ms [${n.source}], ${n.trials} layouts tried, deterministic=${n.deterministic}`);

    const budget = 15_000;
    const d = run({ ...job, effort: 'deep', budgetMs: budget }, 'perf deep');
    // The budget stops the SEARCH; one rebuild in flight is finished and the answer is written out.
    ok(d.tookMs <= budget + 5_000, `deep with budgetMs ${budget} took ${d.tookMs} ms`);
    ok(d.totals.sheets <= q.totals.sheets, `deep (${d.totals.sheets}) is never worse than quick (${q.totals.sheets})`);
    note(`600 pieces — shape deep (budget ${budget} ms): ${d.totals.sheets} sheets, ${d.totals.wastePct.toFixed(2)}% waste, ${d.tookMs} ms, deterministic=${d.deterministic}`);

    // A tiny budget still returns a complete, legal answer: the floor always runs.
    const z = run({ ...job, effort: 'normal', budgetMs: 0 }, 'perf, no budget');
    eq(z.unplaced.length, 0, 'budgetMs 0 still places everything');
    ok(z.deterministic === false || z.trials <= 3, 'and says the clock cut it short');
  });

  await test('MEASURED: an all-rectangle 600-piece job takes the fast path', () => {
    const job = bigJob(9, 60, 600);
    const rectJob = { ...job, pieces: job.pieces.map((p) => ({ ...p, rings: null })) };
    const q = run({ ...rectJob, effort: 'quick', budgetMs: 8_000 }, 'rect perf quick');
    ok(q.tookMs <= 10_000, `quick took ${q.tookMs} ms (limit 10 000)`);
    const rr = rectOf(rectJob, 'quick');
    ok(q.totals.sheets <= rr.nests.length, `quick: ${q.totals.sheets} sheets against nestingPacker's ${rr.nests.length}`);
    note(`600 rectangles — shape quick: ${q.totals.sheets} sheets ${q.totals.wastePct.toFixed(2)}% in ${q.tookMs} ms [${q.source}]  vs  nestingPacker quick ${rr.nests.length} sheets ${rr.wastePct.toFixed(2)}%`);
    const n = run({ ...rectJob, effort: 'normal', budgetMs: 30_000 }, 'rect perf normal');
    ok(n.tookMs <= 60_000, `normal took ${n.tookMs} ms (limit 60 000)`);
    const t0 = Date.now();
    const rs = rectOf(rectJob, 'standard');
    const tStd = Date.now() - t0;
    ok(n.totals.sheets <= rs.nests.length, `normal: ${n.totals.sheets} sheets against nestingPacker standard's ${rs.nests.length}`);
    note(`600 rectangles — shape normal: ${n.totals.sheets} sheets ${n.totals.wastePct.toFixed(2)}% in ${n.tookMs} ms [${n.source}], deterministic=${n.deterministic}  vs  nestingPacker standard ${rs.nests.length} sheets ${rs.wastePct.toFixed(2)}% in ${tStd} ms`);
  });

  /* ───────────────────────────── verifyLayout ─────────────────────────── */

  await test('verifyLayout catches each planted defect, and names it', () => {
    const sheet = { length: 1000, width: 600 };
    const P = (key, n, ring) => ({ key, n, rings: R(ring) });
    const good = [P('a', 1, rect(200, 100, 10, 10)), P('b', 1, rect(200, 100, 213, 10)), P('t', 1, [[10, 120], [310, 120], [10, 320]])];
    const v0 = verifyLayout({ sheet, placements: good, kerf: 3, margin: 10 });
    ok(v0.ok && v0.problems.length === 0, 'a legal layout passes');
    const kinds = (v) => v.problems.map((p) => p.kind).sort().join(',');

    let v = verifyLayout({ sheet, placements: [good[0], P('b', 1, rect(200, 100, 150, 50))], kerf: 3, margin: 10 });
    ok(!v.ok && kinds(v) === 'overlap', `overlap is caught (${kinds(v)})`);
    ok(v.problems[0].a === 'a#1' && v.problems[0].b === 'b#1', `and names the two parts (${v.problems[0].a}, ${v.problems[0].b})`);
    v = verifyLayout({ sheet, placements: [good[0], P('b', 1, rect(200, 100, 212, 10))], kerf: 3, margin: 10 });
    ok(!v.ok && kinds(v) === 'too_close', `2 mm apart with a 3 mm kerf is too_close (${kinds(v)})`);
    ok(/2\.000 mm apart/.test(v.problems[0].detail), `and says how close: "${v.problems[0].detail}"`);
    v = verifyLayout({ sheet, placements: [good[0], P('b', 1, rect(200, 100, 210, 10))], kerf: 3, margin: 10 });
    ok(kinds(v) === 'too_close', 'touching with a kerf is too_close, not overlap');
    v = verifyLayout({ sheet, placements: [good[0], P('b', 1, rect(200, 100, 210, 10))], kerf: 0, margin: 10 });
    ok(v.ok, 'touching with kerf 0 is legal');
    v = verifyLayout({ sheet, placements: [P('a', 1, rect(200, 100, 850, 10))], kerf: 3, margin: 10 });
    ok(!v.ok && kinds(v) === 'outside', `past the edge is outside (${kinds(v)})`);
    v = verifyLayout({ sheet, placements: [P('a', 1, rect(200, 100, 795, 10))], kerf: 3, margin: 10 });
    ok(!v.ok && kinds(v) === 'in_rim', `inside the sheet but 5 mm from its edge with a 10 mm margin is in_rim (${kinds(v)})`);
    v = verifyLayout({ sheet, placements: [P('a', 1, rect(200, 100, 790, 10))], kerf: 3, margin: 10 });
    ok(v.ok, 'exactly on the margin is legal');
    // slanted: a triangle's hypotenuse 1 mm from another's, measured truly
    v = verifyLayout({ sheet, placements: [P('t', 1, [[10, 10], [310, 10], [10, 210]]), P('t', 2, [[311.5, 10], [311.5, 210], [11.5, 210]])], kerf: 3, margin: 10 });
    ok(kinds(v) === 'too_close', `slanted edges nearer than the kerf are caught (${kinds(v)}; ${v.problems[0]?.detail})`);
    // identical parts stacked exactly
    v = verifyLayout({ sheet, placements: [good[0], { ...good[0], n: 2 }], kerf: 3, margin: 10 });
    ok(kinds(v) === 'overlap', 'two copies in exactly the same place overlap');
    // a part in a cut-out: legal when clear, too_close when near the cut-out edge, overlap when across it
    const frame = { key: 'f', n: 1, rings: R(rect(600, 400, 10, 10), [rect(400, 200, 110, 110)]) };
    ok(verifyLayout({ sheet, placements: [frame, P('in', 1, rect(100, 100, 200, 150))], kerf: 3, margin: 10 }).ok, 'a part in a cut-out, clear of it, is legal');
    ok(kinds(verifyLayout({ sheet, placements: [frame, P('in', 1, rect(100, 100, 112, 150))], kerf: 3, margin: 10 })) === 'too_close', 'a part 2 mm from the cut-out edge is too_close');
    ok(kinds(verifyLayout({ sheet, placements: [frame, P('in', 1, rect(100, 100, 60, 150))], kerf: 3, margin: 10 })) === 'overlap', 'a part across the cut-out edge overlaps');
    // fixed parts are obstacles
    v = verifyLayout({ sheet: { ...sheet, fixed: [{ key: 'old', rings: R(rect(200, 100, 10, 10)) }] }, placements: [P('b', 1, rect(200, 100, 150, 50))], kerf: 3, margin: 10 });
    ok(kinds(v) === 'overlap' && v.problems[0].a === 'fixed:old', `a new part on a fixed part is an overlap, naming the fixed part (${v.problems[0]?.a})`);
    // a non-rectangular sheet
    const outline = [[0, 0], [1000, 0], [1000, 300], [400, 300], [400, 600], [0, 600]];
    ok(verifyLayout({ sheet: { ...sheet, outline }, placements: [P('a', 1, rect(200, 100, 100, 400))], kerf: 3, margin: 10 }).ok, 'inside the L-shaped sheet is legal');
    ok(kinds(verifyLayout({ sheet: { ...sheet, outline }, placements: [P('a', 1, rect(200, 100, 300, 400))], kerf: 3, margin: 10 })) === 'outside', 'across the notch of the L-shaped sheet is outside');
    ok(kinds(verifyLayout({ sheet: { ...sheet, outline }, placements: [P('a', 1, rect(200, 100, 195, 400))], kerf: 3, margin: 10 })) === 'in_rim', '5 mm from the notch is in_rim');
    // several defects at once are all reported
    v = verifyLayout({ sheet, placements: [P('a', 1, rect(200, 100, 5, 10)), P('b', 1, rect(200, 100, 150, 50)), P('c', 1, rect(100, 100, 950, 400))], kerf: 3, margin: 10 });
    ok(kinds(v) === 'in_rim,outside,overlap', `three defects, three reports (${kinds(v)})`);
  });

  await test('layoutMetrics measures what is there', () => {
    // Two 400×300 plates a 3 mm kerf apart on a 1000×500 sheet, and a frame.
    const sheet = { length: 1000, width: 500 };
    const m = layoutMetrics({ sheet, placements: [{ key: 'a', rings: R(rect(400, 300, 5, 5)) }, { key: 'b', rings: R(rect(400, 300, 408, 5)) }], kerf: 3, margin: 5 });
    eq(m.sheetArea, 500000, 'sheetArea');
    eq(m.partArea, 240000, 'partArea');
    eq(m.usedArea, 240000, 'usedArea');
    eq(m.wastePct, 52, 'wastePct');
    eq(m.boundArea, 803 * 300, 'boundArea is the rectangle round both');
    eq(m.sharedCutMm, 300, 'the two facing 300 mm edges are one cut');
    eq(m.cutLengthMm, 2 * 1400 - 300, 'cut length is both perimeters less the shared cut');
    eq(m.piercings, 2, 'two piercings');
    // free regions: the plate less the parts and their 3 mm halo.
    // parts+halo cover x 2..811, y 2..308 -> 809×306 = 247554 (corners squared off outward)
    const freeArea = m.freeRegions.reduce((s, r) => s + r.area, 0);
    eq(freeArea, 500000 - 809 * 306, 'free area is the plate less the parts and their kerf halo');
    eq(m.freeRegions.length, 1, 'and it is one region (the kerf channel between the parts is not free)');
    ok(m.freeRegions[0].bbox.x1 === 1000 && m.freeRegions[0].bbox.y1 === 500, 'whose bbox reaches the far corner');
    // 4 mm apart: not a shared cut
    const m2 = layoutMetrics({ sheet, placements: [{ key: 'a', rings: R(rect(400, 300, 5, 5)) }, { key: 'b', rings: R(rect(400, 300, 409, 5)) }], kerf: 3, margin: 5 });
    eq(m2.sharedCutMm, 0, 'edges 4 mm apart with a 3 mm kerf are two cuts');
    // a frame with a part in its window: the window's free space is a region of its own
    const fr = layoutMetrics({ sheet, placements: [{ key: 'f', rings: R(rect(600, 400, 5, 5), [rect(400, 200, 105, 105)]) }, { key: 'in', rings: R(rect(100, 100, 108, 108)) }], kerf: 3, margin: 5 });
    eq(fr.piercings, 3, 'a frame is two piercings, the part in it a third');
    eq(fr.usedArea, 240000, 'usedArea: the part in the window uses no more plate');
    eq(fr.partArea, 240000 - 80000 + 10000, 'partArea: frame less its window, plus the part');
    ok(fr.freeRegions.some((r) => r.bbox.x0 >= 105 && r.bbox.x1 <= 505 && r.area < 80000), 'the rest of the window is reported as a free region');
    eq(layoutMetrics({ sheet, placements: [], kerf: 3 }).freeRegions[0].area, 500000, 'an empty sheet is one free region: all of it');
  });

  /* ──────────────────────────────── bad input ─────────────────────────── */

  await test('bad input is refused rather than guessed', () => {
    const bad = (input, why) => {
      let threw = false;
      try { packShapes(input); } catch (e) { threw = e instanceof TypeError; }
      ok(threw, `refused: ${why}`);
    };
    const S = [{ key: 'S', length: 1000, width: 500 }];
    bad({ pieces: 'no', sheets: S, kerf: 3 }, 'pieces not an array');
    bad({ pieces: [{ key: 'a', qty: 1 }], sheets: S, kerf: 3 }, 'a piece with neither rings nor a size');
    bad({ pieces: [{ key: 'a', qty: 1, length: 10, width: 10, grain: 'diagonal' }], sheets: S, kerf: 3 }, 'an unknown grain');
    bad({ pieces: [{ key: 'a', qty: 1, rings: R([[0, 0], [10, 0], [20, 0]]) }], sheets: S, kerf: 3 }, 'an outline with no area');
    bad({ pieces: [{ key: 'a', qty: 1, length: 10, width: 10 }], sheets: [{ key: 'S', length: 0, width: 5 }], kerf: 3 }, 'a sheet with no size');
    bad({ pieces: [{ key: 'a', qty: 1, length: 10, width: 10 }], sheets: S, kerf: -1 }, 'a negative kerf');
    bad({ pieces: [{ key: 'a', qty: 1, length: 10, width: 10 }], sheets: S, kerf: 3, margin: -2 }, 'a negative margin');
    // qty 0 is not an error, it is nothing
    eq(packShapes({ pieces: [{ key: 'a', qty: 0, length: 10, width: 10 }], sheets: S, kerf: 3 }).nests.length, 0, 'qty 0 places nothing');
    // rings in the array form partGeometry writes (closing point repeated, rounded to 0.1)
    const arr = run({ pieces: [{ key: 'g', qty: 3, rings: [[[0, 0], [300.5, 0], [300.5, 120.2], [0, 200.1], [0, 0]], circle(60, 60, 20, 24).map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10])] }], sheets: S, kerf: 3, margin: 5 }, 'array-form rings');
    eq(arr.unplaced.length, 0, 'partGeometry-style rings (array form, closing point repeated) are read');
    ok(Array.isArray(arr.nests[0].placements[0].rings), 'and come back in the form they went in');
  });

  /* ───────────────────────────── property test ────────────────────────── */

  await test('30 random jobs of convex and concave polygons: every layout is legal and every part accounted for', () => {
    const rng = mulberry32(2026);
    let totalParts = 0; let totalPlaced = 0; let worst = 0;
    const t0 = Date.now();
    for (let j = 0; j < 30; j += 1) {
      const nShapes = 2 + Math.floor(rng() * 7);
      const pieces = [];
      for (let i = 0; i < nShapes; i += 1) {
        const w = Math.round(80 + rng() * 900); const h = Math.round(60 + rng() * 600);
        const ring = randomPolygon(rng, w, h);
        const cut = rng() < 0.15 && w > 300 && h > 300;
        pieces.push({
          key: `j${j}s${i}`, qty: 1 + Math.floor(rng() * 6),
          rings: rng() < 0.2 ? null : (cut ? R(rect(w, h), [rect(w * 0.5, h * 0.5, w * 0.25, h * 0.25)]) : R(ring)),
          length: w, width: h,
          grain: rng() < 0.15 ? (rng() < 0.5 ? 'length' : 'width') : 'any',
          allowMirror: rng() < 0.3,
        });
      }
      const input = {
        pieces,
        sheets: rng() < 0.3
          ? [{ key: 'A', length: 1800, width: 1100 }, { key: 'B', length: 2600, width: 1300, available: 2 }]
          : [{ key: 'A', length: Math.round(1500 + rng() * 1500), width: Math.round(900 + rng() * 800) }],
        kerf: [0, 2.5, 3, 5][Math.floor(rng() * 4)], margin: [0, 3, 10][Math.floor(rng() * 3)],
        rotations: rng() < 0.2 ? { stepDeg: 30 } : [0, 90, 180, 270],
        effort: j % 3 === 0 ? 'normal' : 'quick', seed: j,
      };
      const r = run(input, `random ${j}`);
      const asked = pieces.reduce((s, p) => s + p.qty, 0);
      const placed = r.nests.reduce((s, n) => s + n.placements.length, 0);
      const un = r.unplaced.reduce((s, u) => s + u.qty, 0);
      ok(placed === asked - un, `random ${j}: placed ${placed} = asked ${asked} − unplaced ${un}`);
      totalParts += asked; totalPlaced += placed; worst = Math.max(worst, r.tookMs);
    }
    note(`property test: 30 jobs, ${totalParts} parts asked, ${totalPlaced} placed, ${Date.now() - t0} ms in all (slowest job ${worst} ms)`);
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  console.log('');
  for (const n of notes) console.log(`   ${n}`);
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
