/**
 * shapePacker.js — CF_ERP. Lay parts onto plates by their TRUE SHAPE.
 *
 * "Whatever manual nesting is done would have been done on the real shape so we
 * should do the same." (user, 2026-10-10). nestingPacker.js lays rectangles in
 * rows; this lays the drawn outline, so a gusset tucks into the corner another
 * gusset leaves and a small part can be cut from the window of a frame.
 *
 * ── THE BOUNDARY ────────────────────────────────────────────────────────────
 * PURE GEOMETRY, like nestingPacker.js: no database, no tenant, no order. Kerf
 * and margin arrive as numbers. `scripts/cf_kepl/shape_packer_test.mjs` runs it
 * with made-up shapes and no connection.
 *
 * ── THE PLACEMENT CONVENTION (the DXF importer and the screen rely on this) ──
 * A placement is `{ x, y, rotationDeg, mirrored }` and means, in this order:
 *   1. NORMALISE  shift the piece's rings so the outline's bounding box has its
 *                 minimum corner at (0, 0);
 *   2. MIRROR     if `mirrored`, about the y axis (x → −x);
 *   3. ROTATE     counter-clockwise by `rotationDeg` about the origin;
 *   4. NORMALISE  again — bounding-box minimum back to (0, 0);
 *   5. TRANSLATE  by (x, y).
 * So (x, y) is ALWAYS the lower-left corner of the placed part's bounding box,
 * in sheet millimetres, origin at the sheet's lower-left corner, x along the
 * sheet's length. `placeRings(rings, placement)` is that rule and nothing else;
 * every `rings` in a result came out of it.
 *
 * ── HOW IT PACKS ────────────────────────────────────────────────────────────
 * NO-FIT POLYGONS, BY CONVEX PIECES. Each shape is cut into convex pieces once
 * (lib/polyGeom.js). For two convex pieces the set of positions where one
 * collides with the other is itself a convex polygon — their Minkowski
 * difference — and growing that polygon by the kerf turns "collide" into "come
 * closer than the kerf". A position for a part is legal exactly when it is
 * strictly inside NONE of those polygons, for every part already on the sheet.
 * Nothing is ever rasterised and no polygon is ever unioned: the test is a
 * point against convex polygons, which cannot be made to misbehave by a
 * near-collinear drawing.
 *
 * DROP, THEN SLIDE. On a vertical line each of those convex polygons forbids one
 * interval of heights, so the LOWEST legal height on that line is found exactly,
 * not sampled. The lines tried are the two rims and, for everything already on
 * the sheet, the line where the new part would stand just clear of it. The
 * first line from the left with a legal height wins, and from there the part is
 * slid left and dropped, exactly, again and again until it rests. Because the
 * intervals come from the true shapes, a part slides INTO a concavity, under a
 * slant or down a cut-out when there is room — which is all that interlocking
 * is. Each allowed orientation is tried and the one that keeps the layout
 * shortest is kept.
 *
 * SEARCH OVER ORDER, ORIENTATION AND PLATE. One greedy pass (biggest first) is
 * the floor. Above it a ruin-and-recreate search takes the emptiest plate and a
 * few others — wholly, or only the parts laid last on them — re-orders what
 * came off, puts the emptiest plate's stragglers first, sometimes holds a shape
 * to one orientation family, and rebuilds. A rebuild is kept only if it buys
 * less steel, uses fewer plates, or (failing those) pushes the load together so
 * that the emptiest plate is nearer to empty. That last rule is what saves a
 * plate: nobody empties one in a single move.
 *
 * RECTANGLES TAKE THE FAST PATH. Two rectangles' no-fit polygon is a rectangle
 * and is kept as four numbers, so a job of plain plates never touches a polygon.
 *
 * NEVER WORSE THAN THE RECTANGLE PACKER. Before any of that, nestingPacker runs
 * on the bounding boxes. Its layout is a legal true-shape layout (it leaves at
 * least a kerf everywhere), so it is taken as a candidate and as a hard floor:
 * the answer is never more plates, nor the same plates with more waste. The
 * same goes for a `start` layout handed in.
 *
 * ── THE SHOP'S RULES, AND WHAT BECAME OF THEM ───────────────────────────────
 *   kerf between parts      KEPT. At least `kerf` between any two parts, at
 *                           every point of their outlines, cut-outs included.
 *   kerf banded by plate    KEPT, upstream: kerf is a number handed in
 *     thickness             (cf_cut_settings via nestingService), as before.
 *   rim                     `margin` is the whole clearance to the plate edge.
 *                           nestingPacker adds the kerf to it because the rim is
 *                           cut; here the caller passes margin = rim trim + kerf
 *                           (or sets `kerfAtRim: true` and this does the sum).
 *   grain                   KEPT, same meaning as nestingPacker: 'length' — the
 *                           part's length runs along the plate's length, so 0°
 *                           or 180°; 'width' — turned, 90° or 270°; 'any' —
 *                           whatever `rotations` allows.
 *   common boundary         CHANGED. There is one clearance, the kerf, so every
 *                           pair of facing straight edges exactly a kerf apart
 *                           IS a shared cut; `layoutMetrics.sharedCutMm` measures
 *                           them. The rectangle packer's separate 2-kerf spacing
 *                           for unshared neighbours has no free-shape equivalent.
 *   plate → sequence → row  DROPPED. A free nest has no rows. Pierce order is
 *                           not an output of this file.
 *   plate choice            KEPT: owned/preferred plates first and judged on
 *                           least waste, bought plates on cost per area placed,
 *                           the candidate list sorted explicitly.
 */

import { nest as rectNest, nestAsync as rectNestAsync, rngFor, SEQUENCE_GAP } from './nestingPacker.js';
import {
  cleanRing, ringArea, ringPerimeter, bboxOfRing, orientRing, ringsObject, toPolygon, polygonArea,
  transformRing, pointInRing, polygonsOverlap, polygonsDistance, polygonInside,
  convexHull, convexDecompose, minkowskiDiffConvex, offsetConvex, booleanRegions, simplifyOutward,
} from '../lib/polyGeom.js';

/** Placement tolerance, mm. Positions are exact to rounding; this only absorbs the rounding. */
const EPS = 1e-7;
/** SHAPE_DEBUG=1 prints each improvement the search finds. */
const DEBUG = typeof process !== 'undefined' && !!process.env?.SHAPE_DEBUG;

/**
 * No-fit polygons kept (all clearances together), counted in POLYGONS, not in pairs: a pair of
 * intricate shapes is forty convex pieces against forty — 1,600 polygons — so the old cap on pairs
 * (200,000 of them) was no cap at all. MEASURED 2026-10-10: a 600-piece job of 60 shapes asks for
 * ~117,000 polygons, and kept as typed arrays (ten Float64Arrays a polygon, each a buffer of its
 * own) that was 3–5 kB apiece — half a gigabyte in ONE worker. So a polygon's chains are plain
 * arrays of doubles now (a quarter of the memory, the same speed: the chain lookup sees one kind
 * of array), its corner list is kept only for the search mode that reads it, and past this many
 * polygons the cache is emptied and refilled as needed. The figure is deliberately above what
 * that 60-shape job asks for: emptied at 60,000 it ran at half speed. A rectangle pair is four
 * numbers and is counted as a tenth.
 */
const NFP_CACHE_MAX = 150_000;

/** What `verifyLayout` forgives: a tenth of a micron. */
export const VERIFY_TOL = 1e-4;

/** How far an inside curve may be straightened for collision purposes (see simplifyOutward). */
const SIMPLIFY_TOL = 0.5;

/** Candidate lines tried per placement. Above this they are thinned; the slide puts the precision back. */
const X_CAP = 800;

/** Plate sizes trial-packed each time a plate is opened. */
const TRIAL_MAX = 6;

/**
 * HOW LONG TO LOOK (user, 2026-10-10: "increase the timing of it to 5, 10 and 20 mins").
 *
 * Every level SEARCHES now (ruin and recreate); they differ in the time allowed and in how
 * patient the search is before it calls a layout set. A search ends when the first of these is
 * true — the first three are COUNTED, not timed, so a job that ends by one of them gives the same
 * answer for the same seed on any machine (`deterministic: true`):
 *
 *   1. PROVED   the layout is at the area lower bound (no plate can be saved) and has had a short
 *               stretch of tightening since: 60 rebuilds × `lns`.
 *   2. SET      nothing has improved — no piece more placed, no steel saved, no plate saved, the
 *               emptiest plate not a hundredth emptier — for `patience` rebuilds in a row:
 *               max(200, 20 × pieces, 200 × plates) × `lns`. The patience GROWS WITH THE JOB, on
 *               purpose: a 5-part line is two hundred rebuilds of a millisecond each and answers
 *               at once, whatever the level; a 40-piece line a second or two; a steel of 800
 *               pieces on 15 plates would have to go 16,000 rebuilds — several minutes — with
 *               nothing better before it is called set, so on a big job it is the BUDGET that
 *               ends the search and the time is used. (Measured: with a flat 3,000 a bridge-size
 *               line stopped at 3½ of its 5 minutes with every steel "set".)
 *   3. STOPPED  the caller said stop (`shouldStop`): the best layout so far is the answer.
 *   4. TIME     `capMs` (or `budgetMs` / `deadlineAt`) ran out: the best so far is the answer,
 *               and `deterministic: false` says the clock decided.
 *
 * EVERY ONE OF THE COUNTED RULES IS IN REBUILDS, NEVER IN SECONDS. A box with a tenth of a CPU
 * does a tenth of the rebuilds a minute: its patience lasts ten times as long on the clock, so on a
 * big job it keeps searching for its whole budget, exactly as a fast machine would.
 *
 * `capMs` is the level's allowance when this file is called on its own. Under nestingService one
 * plan has ONE budget for all its steels (nestingService.NEST_BUDGET_MS, shared out by
 * lib/packerPool) and every job is handed its share.
 */
export const SHAPE_EFFORT = Object.freeze({
  quick: { label: 'Quick', rect: 'quick', lns: 1, capMs: 5 * 60_000 },
  normal: { label: 'Normal', rect: 'standard', lns: 2, capMs: 10 * 60_000 },
  deep: { label: 'Deep', rect: 'deep', lns: 4, capMs: 20 * 60_000 },
  // "We can even run it for one hour in production and wait" (user, 2026-10-10).
  long: { label: 'Long', rect: 'deep', lns: 8, capMs: 60 * 60_000 },
});
/** No count ends a search that is still getting somewhere; this only keeps a loop variable finite. */
const MAX_REBUILDS = 50_000_000;

/* ───────────────────────────── the convention ──────────────────────────── */

const rectRings = (length, width) => ({ outline: [[0, 0], [length, 0], [length, width], [0, width]], cutouts: [], holes: [] });

const normDeg = (deg) => {
  const d = ((Number(deg) % 360) + 360) % 360;
  return Math.abs(d - Math.round(d)) < 1e-9 ? Math.round(d) % 360 : d;
};

/**
 * THE placement rule (see the header). `rings` in either accepted form; the
 * answer comes back in the same form, point for point (a repeated closing point
 * stays repeated), so a caller can zip it against what it passed in.
 */
export function placeRings(rings, { x = 0, y = 0, rotationDeg = 0, mirrored = false } = {}) {
  const o = ringsObject(rings);
  if (!o) return null;
  const b0 = bboxOfRing(o.outline);
  const t = { rotationDeg, mirrored: !!mirrored };
  const turned = (ring) => transformRing(ring.map((p) => [p[0] - b0.x0, p[1] - b0.y0]), t);
  const b1 = bboxOfRing(turned(o.outline));
  const put = (ring) => turned(ring).map((p) => [p[0] - b1.x0 + x, p[1] - b1.y0 + y]);
  const out = { outline: put(o.outline), cutouts: o.cutouts.map(put), holes: o.holes.map(put) };
  return Array.isArray(rings) ? (typeof rings[0]?.[0] === 'number' ? out.outline : [out.outline, ...out.cutouts, ...out.holes]) : out;
}

/**
 * The rings of a part ALREADY ON A SHEET (a `fixed` entry or a placement), in
 * sheet millimetres.
 *
 * A placement out of this packer carries rings that are already placed; a row
 * read from the database carries the piece's own rings plus x/y/rotation. Both
 * are accepted: when the rings' bounding box already starts at (x, y) they are
 * taken as placed, otherwise the placement rule is applied to them. `placed:
 * true|false` on the entry settles it explicitly — and is the only way to pass
 * un-placed rings for a ROTATED part sitting at exactly (0, 0).
 */
export function placedRingsOf(entry) {
  const o = ringsObject(entry?.rings)
    ?? (entry && entry.length > 0 && entry.width > 0 ? rectRings(Number(entry.length), Number(entry.width)) : null);
  if (!o) {
    const b = entry?.bbox;
    if (b && b.x1 > b.x0 && b.y1 > b.y0) return { outline: [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]], cutouts: [], holes: [] };
    return null;
  }
  if (entry.placed === true || entry.x == null || entry.y == null) return o;
  const bb = bboxOfRing(o.outline);
  const there = Math.abs(bb.x0 - Number(entry.x)) <= 1e-6 && Math.abs(bb.y0 - Number(entry.y)) <= 1e-6;
  if (entry.placed !== false && there) return o;
  return placeRings(o, { x: Number(entry.x), y: Number(entry.y), rotationDeg: entry.rotationDeg ?? 0, mirrored: !!entry.mirrored });
}

/* ───────────────────────────────── shapes ──────────────────────────────── */

const GRAIN = { any: 'any', length: 'length', width: 'width', along_length: 'length', along_width: 'width' };

function rotationList(rotations) {
  if (rotations && !Array.isArray(rotations) && Number(rotations.stepDeg) > 0) {
    const step = Number(rotations.stepDeg);
    const out = [];
    for (let a = 0; a < 360 - 1e-9; a += step) out.push(normDeg(a));
    return out;
  }
  const list = Array.isArray(rotations) && rotations.length ? rotations : [0, 90, 180, 270];
  return [...new Set(list.map(normDeg))];
}

/** One convex piece as flat arrays plus its box; `box` when it IS its box. */
function mkPiece(ring) {
  const n = ring.length;
  const xs = new Float64Array(n); const ys = new Float64Array(n);
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (let i = 0; i < n; i += 1) {
    xs[i] = ring[i][0]; ys[i] = ring[i][1];
    if (xs[i] < x0) x0 = xs[i]; if (xs[i] > x1) x1 = xs[i];
    if (ys[i] < y0) y0 = ys[i]; if (ys[i] > y1) y1 = ys[i];
  }
  let box = n === 4;
  for (let i = 0; box && i < n; i += 1) {
    if ((Math.abs(xs[i] - x0) > 1e-9 && Math.abs(xs[i] - x1) > 1e-9) || (Math.abs(ys[i] - y0) > 1e-9 && Math.abs(ys[i] - y1) > 1e-9)) box = false;
  }
  return { xs, ys, n, x0, y0, x1, y1, box };
}

/** A ring as a string that is the same for the same loop wherever it starts. */
function ringSig(ring) {
  const r = orientRing(ring, true).map((p) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`);
  let m = 0;
  for (let i = 1; i < r.length; i += 1) if (r[i] < r[m]) m = i;
  return [...r.slice(m), ...r.slice(0, m)].join(';');
}

/** A solid (already simplified) as convex pieces, or — if that ever fails its own audit — its hull. */
function piecesOf(poly, warn, label) {
  const pieces = convexDecompose(poly);
  const want = polygonArea(poly);
  const got = pieces.reduce((s, r) => s + ringArea(r), 0);
  if (pieces.length && Math.abs(got - want) <= 1e-6 * Math.max(1, want)) return pieces;
  // Never expected. The hull is a safe stand-in: it contains the part, so nothing can overlap it.
  warn(`${label}: outline could not be split into convex pieces (${got.toFixed(3)} of ${want.toFixed(3)} mm²); its convex hull is used`);
  return [convexHull(poly.outline)];
}

/** How far a curved OPENING may be straightened: 2% of its smaller side, between the outline's tolerance and 8 mm. */
const holeTolOf = (ctx) => (h) => {
  const b = bboxOfRing(h);
  return Math.min(8, Math.max(ctx.simplifyTol, 0.02 * Math.min(b.x1 - b.x0, b.y1 - b.y0)));
};

/**
 * The convex pieces a solid is collided with.
 *
 * The cost of placing against a shape grows with the SQUARE of its piece count
 * (every piece of one against every piece of the other), so a shape that will
 * not come down to a sane number is traded down, a step at a time, to something
 * cruder that still CONTAINS it: openings filled in, hollows straightened
 * further, and at the last its convex hull. Each step only ever adds clearance.
 */
function collisionPieces(ctx, outline, holes, label) {
  const tol = ctx.simplifyTol;
  const steps = [
    () => simplifyOutward({ outline, holes }, tol, holeTolOf(ctx)),
    holes.length ? () => simplifyOutward({ outline, holes: [] }, tol) : null,
    () => simplifyOutward({ outline, holes: [] }, Math.max(tol, 2)),
    () => simplifyOutward({ outline, holes: [] }, Math.max(tol, 6)),
  ];
  const what = ['', 'its openings are treated as solid', 'its hollows are straightened to 2 mm', 'its hollows are straightened to 6 mm'];
  for (let i = 0; i < steps.length; i += 1) {
    if (!steps[i]) continue;
    const pieces = piecesOf(steps[i](), ctx.warn, label);
    if (pieces.length <= ctx.maxPieces) {
      if (i > 0) ctx.note(`${label}: too intricate to nest against exactly — ${what[i]}`);
      return pieces;
    }
  }
  ctx.note(`${label}: too intricate to nest against exactly — its convex hull is used`);
  return [convexHull(outline)];
}

/**
 * One orientation of one shape: its convex pieces with the bounding-box minimum
 * at (0, 0) — exactly where `placeRings` puts the real rings.
 */
function makeOS(ctx, shape, deg, mirrored) {
  const t = { rotationDeg: deg, mirrored };
  const bb = bboxOfRing(transformRing(shape.exact.outline, t));
  const pieces = shape.basePieces.map((r) => mkPiece(orientRing(transformRing(r, t).map((p) => [p[0] - bb.x0, p[1] - bb.y0]), true)));
  const d = normDeg(deg);
  ctx.nextId += 1;
  return {
    id: ctx.nextId, shape: shape.idx, rotationDeg: d, mirrored: !!mirrored, fam: ((d % 180) + 180) % 180,
    w: bb.x1 - bb.x0, h: bb.y1 - bb.y0, pieces, allBox: pieces.every((p) => p.box),
  };
}

function osSignature(shape, deg, mirrored) {
  const t = { rotationDeg: deg, mirrored };
  const ol = transformRing(shape.exact.outline, t);
  const bb = bboxOfRing(ol);
  const mv = (ring) => transformRing(ring, t).map((p) => [p[0] - bb.x0, p[1] - bb.y0]);
  return [ringSig(mv(shape.exact.outline)), ...shape.exact.holes.map((h) => ringSig(mv(h))).sort()].join('|');
}

function buildShapes(ctx, pieces) {
  if (!Array.isArray(pieces)) throw new TypeError('packShapes: `pieces` must be an array');
  const shapes = [];
  pieces.forEach((p, n) => {
    if (!p || typeof p !== 'object') throw new TypeError(`packShapes: pieces[${n}] is not an object`);
    const qty = Math.trunc(Number(p.qty ?? 1));
    if (!(qty >= 0)) throw new TypeError(`packShapes: pieces[${n}] (${p.key}) has a bad qty`);
    if (qty === 0) return;
    const grain = GRAIN[p.grain ?? 'any'];
    if (!grain) throw new TypeError(`packShapes: pieces[${n}] grain '${p.grain}' is not length|width|any`);
    let raw = ringsObject(p.rings);
    if (!raw) {
      const length = Number(p.length); const width = Number(p.width);
      if (!(length > 0) || !(width > 0)) throw new TypeError(`packShapes: pieces[${n}] (${p.key}) needs rings, or a positive length and width`);
      raw = rectRings(length, width);
    }
    const b0 = bboxOfRing(raw.outline);
    const shift = (ring) => ring.map((q) => [Number(q[0]) - b0.x0, Number(q[1]) - b0.y0]);
    const local = { outline: shift(raw.outline), cutouts: raw.cutouts.map(shift), holes: raw.holes.map(shift) };
    const exact = toPolygon(local);
    if (!exact) throw new TypeError(`packShapes: pieces[${n}] (${p.key}) has an outline with no area`);
    let drilled = 0;
    for (const h of local.holes) drilled += ringArea(cleanRing(h));
    shapes.push({
      idx: shapes.length, key: p.key ?? `piece${n}`, qty, grain, allowMirror: !!p.allowMirror,
      // Rings go back out in the form they came in: partGeometry's array, or the object.
      local: Array.isArray(p.rings) ? [local.outline, ...local.cutouts, ...local.holes] : local, exact, L: b0.x1 - b0.x0, W: b0.y1 - b0.y0,
      area: Math.max(0, polygonArea(exact) - drilled), outlineArea: ringArea(exact.outline),
      basePieces: null, os: [], os0: null, os90: null, isRect: false,
    });
  });

  // A cut-out is worth carrying only if something could be cut from it.
  let smallest = Infinity;
  for (const s of shapes) smallest = Math.min(smallest, s.area);
  const angles = rotationList(ctx.rotations);
  for (const s of shapes) {
    const keep = ctx.partInPart ? s.exact.holes.filter((h) => {
      const b = bboxOfRing(h);
      return ringArea(h) > smallest && Math.min(b.x1 - b.x0, b.y1 - b.y0) > 2 * ctx.kerf;
    }) : [];
    s.basePieces = collisionPieces(ctx, s.exact.outline, keep, `piece ${s.key}`);
    s.isRect = s.basePieces.length === 1 && mkPiece(s.basePieces[0]).box;

    const want = s.grain === 'length' ? [0, 180] : s.grain === 'width' ? [90, 270] : null;
    let allowed = want ? angles.filter((a) => want.includes(a)) : angles.slice();
    if (!allowed.length) allowed = [want ? want[0] : 0];
    const seen = new Set();
    for (const mirrored of (s.allowMirror ? [false, true] : [false])) {
      for (const deg of allowed) {
        const sig = osSignature(s, deg, mirrored);
        if (seen.has(sig)) continue;
        seen.add(sig);
        s.os.push(makeOS(ctx, s, deg, mirrored));
      }
    }
    s.allowedDeg = allowed;
    s.can0 = allowed.includes(0) || allowed.includes(180);
    s.can90 = allowed.includes(90) || allowed.includes(270);
    s.extra = new Map(); // orientations a `start` layout uses that the search itself may not
  }
  return shapes;
}

/** The orientation of a shape for a given placement, made on demand. */
function osFor(ctx, shape, deg, mirrored) {
  const d = normDeg(deg);
  const sig = osSignature(shape, d, !!mirrored);
  if (!shape.sigToOs) {
    shape.sigToOs = new Map();
    for (const o of shape.os) shape.sigToOs.set(osSignature(shape, o.rotationDeg, o.mirrored), o);
  }
  let o = shape.sigToOs.get(sig);
  if (!o) { o = makeOS(ctx, shape, d, !!mirrored); shape.sigToOs.set(sig, o); }
  if (o.rotationDeg === d && o.mirrored === !!mirrored) return o;
  // Same geometry under another name (a rectangle at 180°): keep the caller's name for the output.
  const k = `${d}|${mirrored ? 1 : 0}`;
  let alias = shape.extra.get(k);
  if (!alias) { alias = { ...o, rotationDeg: d, mirrored: !!mirrored }; shape.extra.set(k, alias); }
  return alias;
}

/* ─────────────────────────── the no-fit polygons ───────────────────────── */

/**
 * A convex polygon as two chains that both run in increasing `u`: the low side
 * and the high side. Where a line u = const cuts the polygon is then two binary
 * searches instead of a walk round every edge — and that cut is the innermost
 * operation of the whole packer.
 */
function chainsOf(us, vs) {
  const n = us.length;
  let a = 0; let b = 0;
  for (let i = 1; i < n; i += 1) {
    if (us[i] < us[a] || (us[i] === us[a] && vs[i] < vs[a])) a = i;
    if (us[i] > us[b] || (us[i] === us[b] && vs[i] > vs[b])) b = i;
  }
  const f = []; const g = [];
  for (let i = a; ; i = (i + 1) % n) { f.push(i); if (i === b) break; }
  for (let i = b; ; i = (i + 1) % n) { g.push(i); if (i === a) break; }
  g.reverse();
  // Plain arrays of doubles, on purpose: see NFP_CACHE_MAX.
  const arr = (idx, src) => { const o = new Array(idx.length); for (let i = 0; i < idx.length; i += 1) o[i] = +src[idx[i]]; return o; };
  const one = { u: arr(f, us), v: arr(f, vs) }; const two = { u: arr(g, us), v: arr(g, vs) };
  const um = (us[a] + us[b]) / 2;
  const lowFirst = chainAt(one.u, one.v, um) <= chainAt(two.u, two.v, um);
  const lo = lowFirst ? one : two; const hi = lowFirst ? two : one;
  return { lu: lo.u, lv: lo.v, hu: hi.u, hv: hi.v };
}

/** The chain's v at `u`, or NaN when u is beyond its ends. */
function chainAt(U, V, u) {
  let lo = 0; let hi = U.length - 1;
  if (!(u >= U[0] && u <= U[hi])) return NaN;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (U[mid] <= u) lo = mid; else hi = mid;
  }
  const w = U[hi] - U[lo];
  return w > 0 ? V[lo] + ((V[hi] - V[lo]) * (u - U[lo])) / w : V[lo];
}

/**
 * Where B may NOT be, relative to A, if the two are to stay `c` apart: a list of
 * convex parts (one per pair of convex pieces). `t = B.position − A.position`
 * is forbidden when it is strictly inside any of them.
 *
 * Two rectangles give a rectangle, kept as four numbers: that is the fast path
 * a job of plain plates runs on, and it never touches a polygon.
 */
function getNfp(ctx, A, B, c) {
  let map = ctx.nfp.get(c);
  if (!map) { map = new Map(); ctx.nfp.set(c, map); }
  const key = A.id * 4194304 + B.id;
  let hit = map.get(key);
  if (hit) return hit;
  hit = [];
  if (ctx.nfpHeld >= ctx.nfpMax) { for (const m of ctx.nfp.values()) m.clear(); ctx.nfpHeld = 0; }
  let held = 0;
  for (const pa of A.pieces) {
    for (const pb of B.pieces) {
      if (pa.box && pb.box) {
        hit.push({ x0: pa.x0 - pb.x1 - c, y0: pa.y0 - pb.y1 - c, x1: pa.x1 - pb.x0 + c, y1: pa.y1 - pb.y0 + c, poly: null });
        held += 0.1;
        continue;
      }
      const ra = []; const rb = [];
      for (let i = 0; i < pa.n; i += 1) ra.push([pa.xs[i], pa.ys[i]]);
      for (let i = 0; i < pb.n; i += 1) rb.push([pb.xs[i], pb.ys[i]]);
      const grown = offsetConvex(minkowskiDiffConvex(ra, rb), c);
      const m = mkPiece(grown);
      hit.push({ x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1, poly: { xs: ctx.seeds === 'all' ? Array.from(m.xs) : null, v: chainsOf(m.xs, m.ys), h: chainsOf(m.ys, m.xs) } });
      held += 1;
    }
  }
  ctx.nfpHeld += held;
  map.set(key, hit);
  return hit;
}

/* ─────────────────────────────── sheet state ───────────────────────────── */

function cloneState(st) {
  return {
    ...st, placed: st.placed.slice(), cache: new Map(), failedOS: new Set(st.failedOS), minX: new Map(st.minX),
    pos: new Map([...st.pos].map(([k, v]) => [k, { x: v.x, y: v.y, upto: v.upto }])),
  };
}

/**
 * The sheet as it was after its first `keep` new parts. Any prefix of a legal
 * layout is a legal layout, and the first parts laid are the big ones packed
 * tight against the near end — so this is "keep the good half, redo the rest".
 */
function truncState(ctx, st, keep) {
  const b = st.type.base;
  const out = {
    type: st.type, placed: st.placed.slice(0, st.nBase + keep), nBase: st.nBase, free: b.free, used: 0, nNew: 0,
    maxX: b.maxX, maxY: b.maxY, cache: new Map(), failedOS: new Set(), minX: new Map(), pos: new Map(),
  };
  for (let q = out.nBase; q < out.placed.length; q += 1) {
    const P = out.placed[q];
    const a = ctx.shapes[P.shape].area;
    out.free -= a; out.used += a; out.nNew += 1;
    if (P.x + P.os.w > out.maxX) out.maxX = P.x + P.os.w;
    if (P.y + P.os.h > out.maxY) out.maxY = P.y + P.os.h;
  }
  return out;
}

function commit(ctx, st, os, x, y, shapeIdx) {
  st.placed.push({ os, x, y, c: ctx.kerf, shape: shapeIdx });
  const a = ctx.shapes[shapeIdx].area;
  st.free -= a; st.used += a; st.nNew += 1;
  if (x + os.w > st.maxX) st.maxX = x + os.w;
  if (y + os.h > st.maxY) st.maxY = y + os.h;
}

/** The forbidden parts for orientation B on this sheet, extended as parts land. */
function obstaclesFor(ctx, st, B) {
  let ob = st.cache.get(B.id);
  if (!ob) {
    ob = { upto: 0, x0: [], y0: [], x1: [], y1: [], poly: [], dx: [], dy: [], ord: null, nPoly: 0 };
    st.cache.set(B.id, ob);
  }
  if (ob.upto < st.placed.length) {
    const m = ctx.margin;
    const xLo = m; const xHi = st.type.length - m - B.w; const yLo = m; const yHi = st.type.width - m - B.h;
    for (; ob.upto < st.placed.length; ob.upto += 1) {
      const P = st.placed[ob.upto];
      const nf = getNfp(ctx, P.os, B, P.c);
      for (let i = 0; i < nf.length; i += 1) {
        const part = nf[i];
        const X0 = part.x0 + P.x; const X1 = part.x1 + P.x; const Y0 = part.y0 + P.y; const Y1 = part.y1 + P.y;
        if (X1 <= xLo + EPS || X0 >= xHi - EPS || Y1 <= yLo + EPS || Y0 >= yHi - EPS) continue;
        ob.x0.push(X0); ob.y0.push(Y0); ob.x1.push(X1); ob.y1.push(Y1);
        ob.poly.push(part.poly); ob.dx.push(P.x); ob.dy.push(P.y);
        if (part.poly) ob.nPoly += 1;
      }
    }
    ob.ord = null;
  }
  return ob;
}

const CH = [0, 0];

/** Where the line u = U cuts a convex polygon (given by its chains, shifted by du, dv): [lo, hi] into CH. */
function chord(c, du, dv, U) {
  const ur = U - du;
  const lo = chainAt(c.lu, c.lv, ur);
  if (lo !== lo) return false;
  const hi = chainAt(c.hu, c.hv, ur);
  if (hi !== hi) return false;
  CH[0] = lo + dv; CH[1] = hi + dv;
  return true;
}

/** Slide left along the height y from x until something is touched. */
function slideLeft(ob, x, y, xLo) {
  let best = xLo;
  for (let i = 0, n = ob.x0.length; i < n; i += 1) {
    if (!(ob.y0[i] + EPS < y && y < ob.y1[i] - EPS)) continue;
    let hi = ob.x1[i];
    if (ob.poly[i]) {
      if (hi <= best) continue;
      if (!chord(ob.poly[i].h, ob.dy[i], ob.dx[i], y)) continue;
      hi = CH[1];
    }
    if (hi <= x + EPS && hi > best) best = hi;
  }
  return best < x ? best : x;
}

/** Drop along the line x from y until something is touched. */
function slideDown(ob, x, y, yLo) {
  let best = yLo;
  for (let i = 0, n = ob.x0.length; i < n; i += 1) {
    if (!(ob.x0[i] + EPS < x && x < ob.x1[i] - EPS)) continue;
    let hi = ob.y1[i];
    if (ob.poly[i]) {
      if (hi <= best) continue;
      if (!chord(ob.poly[i].v, ob.dx[i], ob.dy[i], x)) continue;
      hi = CH[1];
    }
    if (hi <= y + EPS && hi > best) best = hi;
  }
  return best < y ? best : y;
}

/**
 * The leftmost-then-lowest resting place for orientation B on this sheet, or
 * null. Reads the sheet, writes only its caches.
 *
 * ADDING PARTS ONLY EVER TAKES SPACE AWAY. So a line that had no room for B has
 * none later either, and the search for the next copy of B may start where the
 * last one ended (`minX`) instead of at the rim. On a plate of two hundred
 * identical stiffeners that is the difference between a pass and a crawl.
 */
function findPosition(ctx, st, B) {
  /*
   * THE LAST ANSWER, IF NOTHING HAS LANDED ON IT. Each part placed invalidates
   * the resting place of the orientation that took it and seldom any other, so
   * the three orientations that lost the comparison still have theirs. Checking
   * a point against the newcomers' no-fit polygons is a few comparisons; finding
   * the place again is a sweep of the whole plate.
   */
  const known = st.pos.get(B.id);
  if (known) {
    let free = true;
    for (let q = known.upto; free && q < st.placed.length; q += 1) {
      const P = st.placed[q];
      const nf = getNfp(ctx, P.os, B, P.c);
      const tx = known.x - P.x; const ty = known.y - P.y;
      for (let i = 0; i < nf.length; i += 1) {
        const part = nf[i];
        if (!(part.x0 + EPS < tx && tx < part.x1 - EPS && part.y0 + EPS < ty && ty < part.y1 - EPS)) continue;
        if (part.poly && !(chord(part.poly.v, 0, 0, tx) && CH[0] + EPS < ty && ty < CH[1] - EPS)) continue;
        free = false; break;
      }
    }
    if (free) { known.upto = st.placed.length; return known; }
    st.pos.delete(B.id);
  }
  const m = ctx.margin;
  const xLo = m; const xHi = st.type.length - m - B.w;
  const yLo = m; const yHi = st.type.width - m - B.h;
  if (xHi < xLo - EPS || yHi < yLo - EPS) return null;
  const ob = obstaclesFor(ctx, st, B);
  const n = ob.x0.length;
  if (!n) { const at = { x: xLo, y: yLo, upto: st.placed.length }; st.pos.set(B.id, at); return at; }

  // Candidate lines: the two rims, and where B would stand just clear of each thing
  // already there. They are only where the search STARTS — the slide below is what
  // finds the resting place — so the far rim matters: a part whose "just clear"
  // line is off the plate may still slide back into a slanted gap from there.
  let need = 2 + n;
  if (ctx.seeds === 'all') for (let i = 0; i < n; i += 1) if (ob.poly[i]) need += ob.poly[i].xs.length;
  if (ctx.cx.length < need) ctx.cx = new Float64Array(need * 2);
  const cx = ctx.cx;
  let k = 0;
  cx[k] = xLo; k += 1;
  cx[k] = xHi > xLo ? xHi : xLo; k += 1;
  for (let i = 0; i < n; i += 1) {
    const pl = ob.poly[i];
    if (pl && ctx.seeds === 'all') {
      const xs = pl.xs; const d = ob.dx[i];
      for (let j = 0; j < xs.length; j += 1) {
        const v = xs[j] + d;
        if (v > xLo + EPS && v <= xHi + EPS) { cx[k] = v < xHi ? v : xHi; k += 1; }
      }
    } else {
      const v = ob.x1[i];
      if (v > xLo + EPS && v <= xHi + EPS) { cx[k] = v < xHi ? v : xHi; k += 1; }
    }
  }
  const cand = cx.subarray(0, k).sort();
  const from = st.minX.get(B.id) ?? -Infinity;
  let first = 0;
  while (first < k && cand[first] < from - EPS) first += 1;
  const live = k - first;
  const stride = live > X_CAP ? live / X_CAP : 1;

  if (!ob.ord) {
    const ord = new Int32Array(n);
    for (let i = 0; i < n; i += 1) ord[i] = i;
    const x0 = ob.x0;
    ob.ord = ord.sort((a, b) => x0[a] - x0[b]);
  }
  const ord = ob.ord;
  if (ctx.act.length < n) ctx.act = new Int32Array(n * 2);
  const act = ctx.act;
  let na = 0; let p = 0;
  let last = -Infinity;

  for (let s = 0; s < live; s += 1) {
    const ci = first + (stride === 1 ? s : Math.min(live - 1, Math.floor(s * stride)));
    if (stride !== 1 && s >= X_CAP) break;
    const x = cand[ci];
    if (x - last <= ctx.seedGap) continue;
    last = x;
    while (p < n && ob.x0[ord[p]] < x - EPS) { act[na] = ord[p]; na += 1; p += 1; }
    // Drop the obstacles this line has passed.
    for (let a = 0; a < na;) { if (ob.x1[act[a]] <= x + EPS) { na -= 1; act[a] = act[na]; } else a += 1; }
    /*
     * THE LOWEST FREE HEIGHT ON THIS LINE. Start at the rim; whenever the height
     * is inside something, jump to that thing's top and look again. Only the
     * obstacles whose BOX holds the current height are cut exactly, which on a
     * line through thirty no-fit polygons is two or three of them per jump.
     */
    let y = yLo;
    for (let again = true; again && y <= yHi + EPS;) {
      again = false;
      for (let a = 0; a < na; a += 1) {
        const i = act[a];
        if (!(ob.y0[i] + EPS < y && y < ob.y1[i] - EPS)) continue;
        let hi = ob.y1[i];
        if (ob.poly[i]) {
          if (!chord(ob.poly[i].v, ob.dx[i], ob.dy[i], x)) continue;
          if (!(CH[0] + EPS < y && y < CH[1] - EPS)) continue;
          hi = CH[1];
        }
        y = hi; again = true;
        if (y > yHi + EPS) break;
      }
    }
    if (y > yHi + EPS) continue;
    if (y > yHi) y = yHi;

    // Rest it: left, then down, until neither moves it.
    let fx = x; let fy = y;
    for (let it = 0; it < 12; it += 1) {
      const nx = slideLeft(ob, fx, fy, xLo);
      const ny = slideDown(ob, nx, fy, yLo);
      const moved = fx - nx > 1e-6 || fy - ny > 1e-6;
      fx = nx; fy = ny;
      if (!moved) break;
    }
    st.minX.set(B.id, Math.min(x, fx));
    const at = { x: fx, y: fy, upto: st.placed.length };
    st.pos.set(B.id, at);
    return at;
  }
  return null;
}

/**
 * The best legal placement of one more copy of `shape` on this sheet, or null.
 * "Best" keeps the layout SHORT: least growth of the used length, then the
 * narrower footprint, then the lower position.
 */
function bestPlacement(ctx, st, shape, opt) {
  let best = null;
  let options = null;
  const fam = opt.mask ? opt.mask.get(shape.idx) : undefined;
  for (let i = 0; i < shape.os.length; i += 1) {
    const B = shape.os[i];
    if (fam !== undefined && B.fam !== fam) continue;
    if (st.failedOS.has(B.id)) continue;
    const pos = findPosition(ctx, st, B);
    if (!pos) { st.failedOS.add(B.id); continue; }
    const r = pos.x + B.w;
    const cnd = { B, x: pos.x, y: pos.y, e: Math.max(st.maxX, r), r };
    if (opt.rng && opt.flip > 0) (options ??= []).push(cnd);
    if (!best
      || cnd.e < best.e - 1e-6
      || (Math.abs(cnd.e - best.e) <= 1e-6 && (cnd.r < best.r - 1e-6
        || (Math.abs(cnd.r - best.r) <= 1e-6 && cnd.y < best.y - 1e-6)))) best = cnd;
  }
  if (best && options && options.length > 1 && opt.rng() < opt.flip) best = options[Math.floor(opt.rng() * options.length)];
  return best;
}

/**
 * Put as many of `pool` (shape indexes, in order) on the sheet as will go.
 * Returns [state, remaining]. With `cow` the sheet handed in is left untouched
 * and a copy is made on the first part that lands — what a kept plate needs
 * while a rebuild is only being tried.
 */
function* fillSheet(ctx, st0, pool, opt, cow) {
  let st = st0;
  let rem = null;
  let landed = 0;
  const dead = new Set();
  const fits = st.type.fits;
  for (let i = 0; i < pool.length; i += 1) {
    const s = pool[i];
    let hit = null;
    if (!dead.has(s)) {
      const shape = ctx.shapes[s];
      if (fits[s] && st.free + 1e-6 >= shape.area) hit = bestPlacement(ctx, st, shape, opt);
      if (!hit) dead.add(s);
    }
    if (hit) {
      if (cow && st === st0) st = cloneState(st0);
      commit(ctx, st, hit.B, hit.x, hit.y, s);
      if (!rem) rem = pool.slice(0, i);
      landed += 1;
      if (landed % 8 === 0) yield;
    } else if (rem) rem.push(s);
  }
  /*
   * THE OBSTACLE LISTS GO, NOW THAT THIS FILL IS OVER. They are the bulk of a sheet's memory (one
   * list per orientation tried, an entry per no-fit polygon of everything on the plate) and they
   * are only read while parts are landing: a sheet that takes a part later is copied with empty
   * lists anyway (cloneState, truncState), and an orientation that found no room is remembered in
   * `failedOS`, which stays. Kept, they made a 100-plate layout cost hundreds of megabytes.
   * Speed-only state: the layout is the same with or without them.
   */
  st.cache = new Map();
  return [st, rem ?? pool];
}

/* ───────────────────────────── plates on offer ─────────────────────────── */

const costOf = (t) => (t.isFixedSheet ? 0 : t.areaCost != null ? t.areaCost : (t.preferred ? 0 : t.area));

/** A pseudo-part for something that is on the sheet and must be kept clear of. */
function obstacleOS(ctx, poly, label, simplify = false) {
  const bb = bboxOfRing(poly.outline);
  const local = {
    outline: poly.outline.map((p) => [p[0] - bb.x0, p[1] - bb.y0]),
    holes: poly.holes.map((h) => h.map((p) => [p[0] - bb.x0, p[1] - bb.y0])),
  };
  const pieces = (simplify ? collisionPieces(ctx, local.outline, local.holes, label) : piecesOf(local, ctx.warn, label))
    .map((r) => mkPiece(orientRing(r, true)));
  ctx.nextId += 1;
  return { os: { id: ctx.nextId, shape: -1, rotationDeg: 0, mirrored: false, fam: 0, w: bb.x1 - bb.x0, h: bb.y1 - bb.y0, pieces, allBox: pieces.every((p) => p.box) }, x: bb.x0, y: bb.y0 };
}

function buildTypes(ctx, sheets) {
  if (!Array.isArray(sheets)) throw new TypeError('packShapes: `sheets` must be an array');
  const out = [];
  sheets.forEach((s, n) => {
    if (!s || typeof s !== 'object') throw new TypeError(`packShapes: sheets[${n}] is not an object`);
    const outline = s.outline ? orientRing(cleanRing(s.outline), true) : null;
    if (outline && outline.length < 3) throw new TypeError(`packShapes: sheets[${n}] (${s.key}) has an outline with no area`);
    const ob = outline ? bboxOfRing(outline) : null;
    const length = Number(s.length ?? ob?.x1);
    const width = Number(s.width ?? ob?.y1);
    if (!(length > 0) || !(width > 0)) throw new TypeError(`packShapes: sheets[${n}] (${s.key}) needs a positive length and width`);
    const fixed = Array.isArray(s.fixed) ? s.fixed : [];
    let available = s.available == null ? Infinity : Number(s.available);
    if (Number.isFinite(available)) available = Math.trunc(available);
    if (!(available >= 0)) throw new TypeError(`packShapes: sheets[${n}] has a bad available`);
    if (available === 0) return;
    // A rectangle drawn as an outline is just a rectangle.
    const plain = outline && outline.length === 4 && Math.abs(ringArea(outline) - length * width) <= 1e-6
      && Math.abs(ob.x0) <= 1e-9 && Math.abs(ob.y0) <= 1e-9;
    out.push({
      key: s.key ?? `sheet${n}`, length, width, available, preferred: !!s.preferred,
      areaCost: s.areaCost == null ? null : Number(s.areaCost),
      outline: plain ? null : outline, fixedRaw: fixed, isFixedSheet: fixed.length > 0,
      area: outline ? ringArea(outline) : length * width, src: s, _i: 0, base: null, fits: null,
    });
  });
  out.sort((a, b) => (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0)
    || costOf(a) - costOf(b) || a.area - b.area || a.length - b.length || a.width - b.width
    || String(a.key).localeCompare(String(b.key)));
  out.forEach((t, i) => { t._i = i; });

  for (const t of out) {
    const st = {
      type: t, placed: [], nBase: 0, free: t.area, used: 0, nNew: 0, maxX: 0, maxY: 0,
      cache: new Map(), failedOS: new Set(), minX: new Map(), pos: new Map(),
    };
    if (t.outline) {
      // Everything inside the bounding box that is NOT plate, kept `margin` away from.
      const pad = 1;
      const frame = [[-pad, -pad], [t.length + pad, -pad], [t.length + pad, t.width + pad], [-pad, t.width + pad]];
      const o = obstacleOS(ctx, { outline: frame, holes: [orientRing(t.outline, false)] }, `sheet ${t.key}`);
      st.placed.push({ os: o.os, x: o.x, y: o.y, c: ctx.margin, shape: -1 });
    }
    t.fixedParts = [];
    for (const f of t.fixedRaw) {
      const rings = placedRingsOf(f);
      const poly = rings && toPolygon(rings, { cutouts: ctx.partInPart });
      if (!poly) throw new TypeError(`packShapes: a fixed part on sheet ${t.key} (${f?.key}) has no outline`);
      const exact = toPolygon(rings);
      let drilled = 0;
      for (const h of rings.holes ?? []) drilled += ringArea(cleanRing(h));
      const o = obstacleOS(ctx, poly, `fixed part ${f.key}`, true);
      st.placed.push({ os: o.os, x: o.x, y: o.y, c: ctx.kerf, shape: -1 });
      const area = Math.max(0, polygonArea(exact) - drilled);
      st.free -= area;
      st.maxX = Math.max(st.maxX, o.x + o.os.w); st.maxY = Math.max(st.maxY, o.y + o.os.h);
      t.fixedParts.push({ key: f.key, rings, area });
    }
    st.nBase = st.placed.length;
    t.base = st;
  }
  return out;
}

/** Can one copy of each shape go on each EMPTY plate? Decides "nobody stocks this". */
function markFits(ctx) {
  for (const t of ctx.types) {
    t.fits = ctx.shapes.map((s) => {
      for (const B of s.os) {
        if (B.w > t.length - 2 * ctx.margin + EPS || B.h > t.width - 2 * ctx.margin + EPS) continue;
        if (!t.base.nBase) return true;
        if (findPosition(ctx, t.base, B)) return true;
      }
      return false;
    });
  }
}

/* ───────────────────────────── building a layout ───────────────────────── */

/**
 * Open one more plate for what is left. Every size on offer is trial-packed and
 * the winner is chosen the way nestingPacker chooses: anything already owned
 * ends the contest and is judged on how little of it is wasted; a bought plate
 * is judged on cost per square millimetre of part it took.
 */
function* openBest(ctx, rem, stock, opt) {
  const distinct = [...new Set(rem)];
  const cands = ctx.types.filter((t) => !t.isFixedSheet && (stock.get(t._i) ?? 0) > 0 && distinct.some((s) => t.fits[s]));
  if (!cands.length) return null;
  if (cands.length === 1) {
    const [st, left] = yield* fillSheet(ctx, cloneState(cands[0].base), rem, opt, false);
    return st.nNew ? { st, rem: left } : null;
  }
  let remArea = 0;
  for (const s of rem) remArea += ctx.shapes[s].area;
  for (const round of [cands.filter((t) => costOf(t) <= 0), cands.filter((t) => costOf(t) > 0)]) {
    if (!round.length) continue;
    const owned = costOf(round[0]) <= 0;
    let list = round;
    if (list.length > TRIAL_MAX) {
      // Too many to try them all: the ones nearest in size to what is left go first.
      const miss = (t) => (t.area >= remArea ? t.area - remArea : (remArea - t.area) * 0.25);
      list = round.slice().sort((a, b) => miss(a) - miss(b) || a._i - b._i).slice(0, TRIAL_MAX);
    }
    const tried = [];
    for (const t of list) {
      const [st, left] = yield* fillSheet(ctx, cloneState(t.base), rem, opt, false);
      if (st.nNew) tried.push({ st, rem: left });
      yield;
    }
    if (!tried.length) continue;
    tried.sort((a, b) => (owned
      ? (a.st.type.area - a.st.used) - (b.st.type.area - b.st.used)
      : (costOf(a.st.type) / a.st.used) - (costOf(b.st.type) / b.st.used))
      || b.st.used - a.st.used || a.st.type._i - b.st.type._i);
    return tried[0];
  }
  return null;
}

/**
 * Lay `pool` out: first into the plates being kept (never moving what is on
 * them), then onto new plates. `kept` are left untouched — a plate that takes a
 * part comes back as a copy. Returns { states, rem } or null if the clock ran out.
 */
function* build(ctx, pool, kept, opt) {
  let rem = pool;
  const states = [];
  for (const k of kept) {
    if (!rem.length) { states.push(k); continue; }
    const [st, left] = yield* fillSheet(ctx, k, rem, opt, true);
    states.push(st); rem = left;
    yield;
    if (opt.abortable && ctx.over()) return null;
  }
  const stock = new Map();
  for (const t of ctx.types) stock.set(t._i, t.isFixedSheet ? 0 : t.available);
  for (const st of states) if (!st.type.isFixedSheet && st.nNew) stock.set(st.type._i, stock.get(st.type._i) - 1);
  while (rem.length && states.length < ctx.maxNests) {
    const pick = yield* openBest(ctx, rem, stock, opt);
    if (!pick) break;
    states.push(pick.st); rem = pick.rem;
    stock.set(pick.st.type._i, stock.get(pick.st.type._i) - 1);
    if (opt.abortable && ctx.over()) return null;
  }
  return { states, rem };
}

/**
 * Swap a plate for a cheaper size that still holds what is on it. Only onto
 * sizes that can be bought again — a drop is one physical piece and two plates
 * shrinking onto it would both believe they had it (nestingPacker's rule).
 */
function shrink(ctx, states) {
  const buyable = ctx.types.filter((t) => t.available === Infinity && !t.isFixedSheet && !t.outline && costOf(t) > 0);
  if (!buyable.length) return states;
  return states.map((st) => {
    const here = costOf(st.type);
    if (here <= 0 || st.type.isFixedSheet || !st.nNew) return st;
    let bestT = null;
    for (const t of buyable) {
      if (costOf(t) >= here - EPS) continue;
      if (st.maxX > t.length - ctx.margin + EPS || st.maxY > t.width - ctx.margin + EPS) continue;
      if (!bestT || costOf(t) < costOf(bestT) - EPS || (Math.abs(costOf(t) - costOf(bestT)) <= EPS && t._i < bestT._i)) bestT = t;
    }
    if (!bestT) return st;
    // Laid from the lower-left corner, so a layout that fits the smaller plate's box simply moves over.
    return {
      ...st, type: bestT, placed: st.placed.slice(), free: bestT.area - st.used,
      cache: new Map(), failedOS: new Set(), minX: new Map(), pos: new Map(),
    };
  });
}

function evaluate(ctx, built, source) {
  const states = shrink(ctx, built.states.filter((st) => st.nNew > 0));
  let cost = 0; let sheetArea = 0; let used = 0; let sumSq = 0; let env = 0;
  for (const st of states) {
    cost += costOf(st.type); sheetArea += st.type.area; used += st.used;
    sumSq += (st.used / st.type.area) ** 2;
    env += st.maxX * st.type.width;
  }
  return { states, rem: built.rem, unplaced: built.rem.length, cost, sheets: states.length, sheetArea, used, sumSq, env, source };
}

/**
 * Parts stranded, then steel bought, then plates, then plate area — the order
 * nestingPacker uses. Below that, the layout that is closer to emptying a plate
 * (loads pushed together), then the one that uses less of each plate's length.
 */
function better(a, b) {
  if (!b) return true;
  if (a.unplaced !== b.unplaced) return a.unplaced < b.unplaced;
  if (Math.abs(a.cost - b.cost) > 1e-6) return a.cost < b.cost;
  if (a.sheets !== b.sheets) return a.sheets < b.sheets;
  if (Math.abs(a.sheetArea - b.sheetArea) > 1e-6) return a.sheetArea < b.sheetArea;
  if (Math.abs(a.sumSq - b.sumSq) > 1e-9) return a.sumSq > b.sumSq;
  return a.env < b.env - 1e-6;
}

/** The promise made about `start` and about the rectangle packer: plates, then waste. */
function notWorse(a, g) {
  if (a.unplaced !== g.unplaced) return a.unplaced < g.unplaced;
  if (a.sheets !== g.sheets) return a.sheets < g.sheets;
  return a.sheetArea <= g.sheetArea + 1e-6;
}

/* ─────────────────────────── layouts handed to us ──────────────────────── */

/** nestingPacker on the bounding boxes, as sheet states. null when it does not apply. */
function* rectFloor(ctx, budgetMs, effort) {
  if (ctx.types.some((t) => t.isFixedSheet)) return null; // it would ignore "fill the fixed sheets first"
  const plain = ctx.types.filter((t) => !t.outline);
  if (!plain.length) return null;
  const pieces = [];
  for (const s of ctx.shapes) {
    if (!ctx.placeable[s.idx]) continue;
    if (!s.can0 && !s.can90) return null; // only odd angles allowed: a bounding-box layout is not one of them
    pieces.push({ key: s.idx, length: s.L, width: s.W, qty: s.qty, grain: s.can0 && s.can90 ? 'any' : s.can0 ? 'length' : 'width' });
  }
  if (!pieces.length) return null;
  // Handed to whoever is driving this generator: the synchronous driver calls `nest`, the
  // asynchronous one awaits `nestAsync` — so a long rectangle search does not hold the event loop.
  const r = yield {
    rect: {
      pieces,
      sheets: plain.map((t) => ({ key: t._i, length: t.length, width: t.width, available: Number.isFinite(t.available) ? t.available : null, preferred: t.preferred, areaCost: t.areaCost })),
      kerf: ctx.kerf, margin: ctx.margin, effort, seed: ctx.seed, budgetMs,
      /*
       * The rectangle packer separates its sequences by a fixed clearance (6 mm),
       * not by the kerf — fine on the 2.5–5 mm kerfs it was written for, and a
       * layout with parts NEARER than the kerf on anything coarser. So the
       * clearance is raised to the kerf when the kerf is the larger; otherwise
       * it is left alone and the run is the very run a caller of `nest` gets.
       */
      ...(ctx.kerf > SEQUENCE_GAP.default ? { sequenceGap: ctx.kerf } : {}),
    },
  };
  if (!r || r.error) {
    ctx.warn(`rectangle floor skipped: ${r ? r.error : 'no answer'}`);
    return null;
  }
  const states = [];
  for (const n of r.nests) {
    const st = cloneState(ctx.types[n.sheetKey].base);
    for (const p of n.pieces) {
      const s = ctx.shapes[p.key];
      const deg = p.rotated ? (s.allowedDeg.includes(90) ? 90 : 270) : (s.allowedDeg.includes(0) ? 0 : 180);
      commit(ctx, st, osFor(ctx, s, deg, false), p.x, p.y, s.idx);
    }
    states.push(st);
  }
  // Trusted only once it has been checked: it was laid by other rules than these.
  for (const st of states) {
    const v = verifyLayout({ sheet: st.type.src, placements: outPlacements(ctx, st, new Map()), kerf: ctx.kerf, margin: ctx.margin });
    if (!v.ok) {
      ctx.note(`rectangle floor not used: its layout breaks this packer's rules (${v.problems[0].kind}: ${v.problems[0].detail})`);
      return null;
    }
  }
  const rem = [];
  for (const u of r.unplaced) for (let i = 0; i < u.qty; i += 1) rem.push(Number(u.key));
  return { states, rem, capped: !r.deterministic };
}

/** A `start` layout as sheet states, or a reason it cannot be used. */
function startStates(ctx, start) {
  const byKey = new Map();
  for (const s of ctx.shapes) { const k = String(s.key); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(s); }
  const typeBy = new Map(ctx.types.map((t) => [String(t.key), t]));
  const left = ctx.shapes.map((s) => s.qty);
  const usedFixed = new Set();
  const states = [];
  for (const n of start) {
    const t = typeBy.get(String(n?.sheetKey));
    if (!t) return { why: `sheet '${n?.sheetKey}' is not among the sheets offered` };
    if (t.isFixedSheet) { if (usedFixed.has(t._i)) return { why: `sheet '${t.key}' appears twice` }; usedFixed.add(t._i); }
    const st = cloneState(t.base);
    for (const p of n.placements ?? []) {
      const s = (byKey.get(String(p.key)) ?? []).find((c) => left[c.idx] > 0);
      if (!s) return { why: `piece '${p.key}' is placed more often than it is wanted` };
      left[s.idx] -= 1;
      const os = osFor(ctx, s, p.rotationDeg ?? 0, !!p.mirrored);
      commit(ctx, st, os, Number(p.x), Number(p.y), s.idx);
    }
    if (st.nNew) states.push(st);
  }
  const rem = [];
  ctx.shapes.forEach((s) => { if (ctx.placeable[s.idx]) for (let i = 0; i < left[s.idx]; i += 1) rem.push(s.idx); });
  return { states, rem };
}

/* ───────────────────────────────── search ──────────────────────────────── */

const ORDERS = {
  area: (s) => [s.L * s.W, Math.max(s.L, s.W)],
  maxdim: (s) => [Math.max(s.L, s.W), s.L * s.W],
  mindim: (s) => [Math.min(s.L, s.W), s.L * s.W],
  solid: (s) => [s.area, Math.max(s.L, s.W)],
};

/**
 * Shape indexes, one per copy; copies of a shape stay together.
 *
 * THE FUSSY GO FIRST: a shape that fits ONLY plates that can run out (an
 * offcut, a size with two in stock) is laid before everything else, whatever
 * its size. Otherwise the one offcut wide enough for a grain-bound web is full
 * of small parts by the time the web's turn comes, and the web is reported as
 * having nowhere to go. Within that, biggest first by the named measure.
 */
function orderPool(ctx, counts, by, rng, noise) {
  const keyed = [];
  for (let i = 0; i < counts.length; i += 1) {
    if (!counts[i]) continue;
    const k = ORDERS[by](ctx.shapes[i]);
    const j = rng ? 1 + noise * (rng() - 0.5) : 1;
    keyed.push([i, k[0] * j, k[1], ctx.fitCount[i]]);
  }
  keyed.sort((a, b) => a[3] - b[3] || b[1] - a[1] || b[2] - a[2] || a[0] - b[0]);
  const out = [];
  for (const [i] of keyed) for (let n = 0; n < counts[i]; n += 1) out.push(i);
  return out;
}

const freshFixed = (ctx) => ctx.types.filter((t) => t.isFixedSheet).map((t) => t.base);

function* search(ctx, input) {
  const counts0 = ctx.shapes.map((s) => (ctx.placeable[s.idx] ? s.qty : 0));
  const nInst = counts0.reduce((a, b) => a + b, 0);
  let best = null; let guard = null;
  let capped = false; let trials = 0;
  let told = null;
  const consider = (sol) => {
    trials += 1;
    if (guard && !notWorse(sol, guard)) return false;
    if (better(sol, best)) {
      best = sol;
      // The caller hears of every layout that is better where it counts: pieces, steel, plates.
      if (ctx.report && (!told || sol.unplaced !== told.unplaced || sol.sheets !== told.sheets || Math.abs(sol.cost - told.cost) > 1e-6)) {
        told = { unplaced: sol.unplaced, sheets: sol.sheets, cost: sol.cost };
        try { ctx.report({ sheets: sol.sheets, areaBought: sol.cost, sheetArea: sol.sheetArea, partArea: sol.used, unplaced: sol.unplaced, source: sol.source, trials, elapsedMs: Date.now() - ctx.t0 }); } catch { /* a listener never breaks a pack */ }
      }
      return true;
    }
    return false;
  };
  // The floor is the better of the layouts handed in; whatever is kept must not be worse than it.
  const setGuard = (sol) => {
    if (!guard || (notWorse(sol, guard) && (!notWorse(guard, sol) || better(sol, guard)))) guard = sol;
    if (best && !notWorse(best, guard)) best = null;
  };
  const plain = { mask: null, rng: null, flip: 0, abortable: false };

  // A layout handed in. Whatever it leaves out is added to it; nothing in it is moved.
  if (Array.isArray(input.start) && input.start.length) {
    const s = startStates(ctx, input.start);
    if (s.why) ctx.warn(`start layout ignored: ${s.why}`);
    else {
      const bad = [];
      for (const st of s.states) {
        const v = verifyLayout({ sheet: st.type.src, placements: outPlacements(ctx, st, new Map()), kerf: ctx.kerf, margin: ctx.margin });
        if (!v.ok) bad.push(`${st.type.key}: ${v.problems[0].kind} (${v.problems[0].a}${v.problems[0].b ? ` / ${v.problems[0].b}` : ''})`);
      }
      if (bad.length) ctx.warn(`start layout ignored: it is not a legal layout — ${bad[0]}`);
      else {
        const fixedKept = freshFixed(ctx).filter((b) => !s.states.some((st) => st.type === b.type));
        const built = yield* build(ctx, s.rem, [...fixedKept, ...s.states], plain);
        const sol = evaluate(ctx, built, 'start');
        setGuard(sol); consider(sol);
      }
    }
  }

  // The rectangle packer on the bounding boxes: a floor for every job it can read.
  if (input.rectFloor !== false) {
    /*
     * How hard the rectangle packer looks. On a job of nothing but rectangles it
     * is the packer this answer is promised never to be worse than, run for run,
     * so it gets the effort that was asked for. On a job with real shapes it is
     * only a floor to stand on — its quick pass costs a fraction of a second and
     * its long search buys nothing the shape search will not beat.
     */
    const left = ctx.deadline - Date.now();
    const allRect = ctx.shapes.every((s) => s.isRect);
    const rectEffort = allRect ? ctx.level.rect : 'quick';
    const share = rectEffort === 'quick' ? Math.min(1500, left) : Math.max(1000, left * 0.35);
    const f = yield* rectFloor(ctx, share, rectEffort);
    yield;
    if (f) {
      if (f.capped) capped = true;
      const built = f.rem.length ? yield* build(ctx, f.rem, f.states, plain) : f;
      const sol = evaluate(ctx, built, 'rect');
      ctx.rectSummary = { sheets: sol.sheets, sheetArea: sol.sheetArea, unplaced: sol.unplaced };
      setGuard(sol);
      consider(sol);
    }
  }

  // The floor of THIS packer: one greedy pass, always run, whatever the clock says.
  const fams = [...new Set(ctx.shapes.flatMap((s) => s.os.map((o) => o.fam)))].sort((a, b) => a - b);
  const plans = [{ by: 'area', fam: null }];
  if (nInst <= 250 || ctx.level.lns) {
    plans.push({ by: 'maxdim', fam: null });
    for (const f of fams.slice(0, 2)) if (fams.length > 1) plans.push({ by: 'area', fam: f });
    if (ctx.level.lns) plans.push({ by: 'solid', fam: null }, { by: 'mindim', fam: null });
  }
  for (let i = 0; i < plans.length; i += 1) {
    if (i > 0 && ctx.over()) { capped = true; break; }
    const pl = plans[i];
    let mask = null;
    if (pl.fam != null) {
      mask = new Map();
      for (const s of ctx.shapes) if (s.os.some((o) => o.fam === pl.fam)) mask.set(s.idx, pl.fam);
    }
    /*
     * The first pass is this packer's own floor and runs whatever the clock says — UNLESS a legal
     * layout is already in hand (the caller's `start`, or the rectangle floor). Then the clock may
     * cut it: on a job of thousands of pieces one pass is seconds, and a plan's budget is a
     * promise. `deterministic: false` says it happened, and the answer is the layout in hand.
     */
    const built = yield* build(ctx, orderPool(ctx, counts0, pl.by, null, 0), freshFixed(ctx), { ...plain, mask, abortable: i > 0 || !!best });
    if (!built) { capped = true; break; }
    consider(evaluate(ctx, built, 'shape'));
  }
  ctx.floorMs = Date.now() - ctx.t0;

  /*
   * THE CHECKPOINT. The best layout, in the form a `start` takes, handed out when a plate has been
   * saved since the last one and otherwise at most every `checkpointMs`. It is a walk over the
   * plates' placements (no geometry) and is asked for once a rebuild at most, between rebuilds —
   * never from inside one.
   */
  let ck = { sol: null, sheets: Infinity, at: 0 };
  const checkpointNow = () => {
    if (!ctx.checkpoint || !best || best === ck.sol) return;
    const now = Date.now();
    if (!(best.sheets < ck.sheets || best.unplaced < (ck.sol?.unplaced ?? Infinity) || now - ck.at >= ctx.checkpointMs)) return;
    ck = { sol: best, sheets: best.sheets, at: now };
    const layout = best.states.filter((st) => !st.type.isFixedSheet).map((st) => ({
      sheetKey: st.type.key,
      placements: st.placed.slice(st.nBase).map((P) => ({ key: ctx.shapes[P.shape].key, x: P.x, y: P.y, rotationDeg: P.os.rotationDeg, mirrored: P.os.mirrored })),
    }));
    try { ctx.checkpoint({ layout, sheets: best.sheets, areaBought: best.cost, unplaced: best.unplaced, trials }); } catch { /* a listener never breaks a pack */ }
  };
  checkpointNow();

  // Ruin and recreate.
  // See SHAPE_EFFORT: what ends a search.
  const lns = ctx.level.lns;
  const iters = lns ? MAX_REBUILDS : 0;
  const patienceOf = (sol) => Math.max(200, 20 * nInst, 200 * sol.sheets) * lns;
  const lower = ctx.lowerBoundSheets;
  let stall = 0;
  let atBound = null;
  let progress = { unplaced: Infinity, cost: Infinity, sheets: Infinity, low: Infinity, it: 0 };
  const singleSize = ctx.types.filter((t) => !t.isFixedSheet).length === 1;
  const orderNames = Object.keys(ORDERS);
  for (let it = 1; it <= iters; it += 1) {
    if (!best || !best.states.length) break;
    // At the area lower bound no plate can be saved: a last stretch of tightening, then stop.
    if (atBound == null && singleSize && best.unplaced === 0 && best.sheets <= lower) atBound = it;
    if (atBound != null && it - atBound > 60 * lns) break;
    /*
     * GIVING UP IS COUNTED, NOT TIMED. The search is getting somewhere while a
     * plate is saved or while the emptiest plate keeps getting emptier (that is
     * how a plate gets saved: a little at a time). A third of the allowance
     * with neither means the layout has set, and the rest would be spent
     * polishing — so it stops, and the same seed still stops at the same place.
     */
    {
      let low = Infinity;
      for (const st of best.states) if (!st.type.isFixedSheet) low = Math.min(low, st.used / st.type.area);
      const p = progress;
      if (best.unplaced < p.unplaced || best.cost < p.cost - 1e-6 || best.sheets < p.sheets || low < p.low - 0.01) {
        progress = { unplaced: best.unplaced, cost: best.cost, sheets: best.sheets, low, it };
      }
      if (it - progress.it > patienceOf(best)) break;
    }
    if (ctx.over()) { capped = true; break; }
    checkpointNow();
    const rng = rngFor(ctx.seed, it);
    const S = best.states;
    const nS = S.length;
    const ruin = new Map(); // sheet index -> how many of its parts to KEEP (0 = tear it all up)
    const tear = (i, whole) => {
      if (ruin.has(i)) return;
      const have = S[i].nNew;
      ruin.set(i, whole || have < 3 ? 0 : Math.floor(have * (0.25 + 0.65 * rng())));
    };
    let worstFirst = -1;
    const pFull = nS <= 3 ? (nInst <= 40 ? 1 : 0.3) : nS <= 8 ? 0.03 : 0;
    const mode = rng();
    if (mode < pFull) for (let i = 0; i < nS; i += 1) tear(i, true);
    else if (mode < pFull + (1 - pFull) * 0.55) {
      // the emptiest plate, and a couple of others for it to be re-mixed with
      let worst = 0;
      for (let i = 1; i < nS; i += 1) if (S[i].used / S[i].type.area < S[worst].used / S[worst].type.area) worst = i;
      tear(worst, true);
      if (rng() < 0.6) worstFirst = worst;
      const extra = 1 + Math.floor(rng() * Math.min(6, 1 + stall / 8));
      for (let e = 0; e < extra; e += 1) tear(Math.floor(rng() * nS), rng() < 0.35);
    } else {
      const k = Math.max(2, Math.round(nS * (0.1 + 0.3 * rng())));
      for (let e = 0; e < k; e += 1) tear(Math.floor(rng() * nS), rng() < 0.35);
    }
    const counts = new Array(ctx.shapes.length).fill(0);
    const lead = new Array(ctx.shapes.length).fill(0);
    for (const [i, keep] of ruin) {
      const into = i === worstFirst ? lead : counts;
      for (let q = S[i].nBase + keep; q < S[i].placed.length; q += 1) into[S[i].placed[q].shape] += 1;
    }
    for (const s of best.rem) counts[s] += 1;
    /*
     * THE STRAGGLERS GO FIRST. The emptiest plate ends up holding the one or two
     * parts nothing else had room for, and re-packing its neighbours in a random
     * order just strands them again. Laid FIRST, they get their place and what
     * falls off the end instead is small — and small parts drop into holes on
     * the plates being kept, which is how the last plate finally empties.
     */
    const pool = [
      ...orderPool(ctx, lead, 'area', null, 0),
      ...orderPool(ctx, counts, orderNames[Math.floor(rng() * orderNames.length)], rng, 0.2 + 0.6 * rng()),
    ];
    for (let i = 0; i < lead.length; i += 1) counts[i] += lead[i];
    // Sometimes hold one shape (or all) to one orientation family for this rebuild.
    let mask = null;
    const mr = rng();
    if (fams.length > 1 && mr < 0.35) {
      mask = new Map();
      const inPool = counts.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
      const some = mr < 0.1 ? inPool : [inPool[Math.floor(rng() * inPool.length)]];
      for (const i of some) {
        const own = [...new Set(ctx.shapes[i].os.map((o) => o.fam))];
        if (own.length > 1) mask.set(i, own[Math.floor(rng() * own.length)]);
      }
    }
    const kept = [];
    const usedFixed = new Set();
    for (let i = 0; i < nS; i += 1) {
      const keep = ruin.get(i);
      if (keep === 0) continue;
      kept.push(keep === undefined ? S[i] : truncState(ctx, S[i], keep));
      if (S[i].type.isFixedSheet) usedFixed.add(S[i].type._i);
    }
    const fixedFirst = freshFixed(ctx).filter((b) => !usedFixed.has(b.type._i));
    const ordered = [...fixedFirst, ...kept.filter((k) => k.type.isFixedSheet), ...kept.filter((k) => !k.type.isFixedSheet)];
    const built = yield* build(ctx, pool, ordered, { mask, rng, flip: rng() < 0.5 ? 0 : 0.15, abortable: true });
    if (!built) { capped = true; break; }
    if (consider(evaluate(ctx, built, 'shape'))) { stall = 0; if (DEBUG) console.log('  lns', it, 'ruin', ruin.size, 'sheets', best.sheets, 'sumSq', best.sumSq.toFixed(4), 'minUtil', Math.min(...best.states.map((q) => q.used / q.type.area)).toFixed(3), Date.now() - ctx.t0, 'ms'); } else stall += 1;
  }
  checkpointNow();
  return { best, guard, capped, trials, stopped: ctx.stopped };
}

/* ─────────────────────────────── the answer ────────────────────────────── */

/** The new placements of one sheet state, in the result's shape. `nBy` numbers the copies per key. */
function outPlacements(ctx, st, nBy) {
  const out = [];
  for (let q = st.nBase; q < st.placed.length; q += 1) {
    const P = st.placed[q];
    const s = ctx.shapes[P.shape];
    const k = String(s.key);
    const n = (nBy.get(k) ?? 0) + 1;
    nBy.set(k, n);
    out.push({
      key: s.key, n, x: P.x, y: P.y, rotationDeg: P.os.rotationDeg, mirrored: P.os.mirrored,
      rings: placeRings(s.local, { x: P.x, y: P.y, rotationDeg: P.os.rotationDeg, mirrored: P.os.mirrored }),
      bbox: { x0: P.x, y0: P.y, x1: P.x + P.os.w, y1: P.y + P.os.h },
    });
  }
  return out;
}

function mergeUnplaced(list) {
  const by = new Map();
  for (const u of list) {
    const k = JSON.stringify([String(u.key), u.reason]);
    const hit = by.get(k);
    if (hit) hit.qty += u.qty; else by.set(k, { ...u });
  }
  return [...by.values()];
}

function* solve(input) {
  const t0 = Date.now();
  const {
    pieces = [], sheets = [], kerf = 0, margin = 0, rotations = [0, 90, 180, 270], partInPart = true,
    effort = 'normal', seed = 1, budgetMs = null, deadlineAt = null, kerfAtRim = false, freeRegions = true,
    simplifyTol = SIMPLIFY_TOL, maxNests = 5000, maxPieces = 48, seeds = 'x1', seedGap = 1e-9,
    // In-thread only (functions do not cross to a worker; services/nestingWorker.js makes them there):
    //   shouldStop()  true = finish now with the best layout so far ("Stop and use this", or a cancel)
    //   onProgress(p) every layout better in pieces, steel or plates: { sheets, areaBought, partArea, unplaced, trials, elapsedMs }
    shouldStop = null, onProgress = null,
    //   onCheckpoint(layout)  the best layout so far AS A `start` (sheetKey + placements, no rings), when a
    //                         plate is saved and at most every `checkpointMs` otherwise — what a run keeps
    //                         so that it can be picked up again after a restart (services/nestRunService.js)
    onCheckpoint = null, checkpointMs = 60_000,
    //   nfpMax  the no-fit-polygon cache's cap, for a job re-run COARSER after its worker ran out of heap
    nfpMax = null,
  } = input ?? {};
  const k = Number(kerf);
  if (!(k >= 0)) throw new TypeError('packShapes: `kerf` must be a number of mm >= 0');
  const m0 = Number(margin);
  if (!(m0 >= 0)) throw new TypeError('packShapes: `margin` must be a number of mm >= 0');
  const m = kerfAtRim ? m0 + k : m0;
  const level = SHAPE_EFFORT[effort === 'standard' ? 'normal' : effort] ?? SHAPE_EFFORT.normal;
  const warnings = [];
  const notes = [];
  const ctx = {
    maxPieces: Math.max(1, Math.trunc(Number(maxPieces))), note: (w) => { if (!notes.includes(w)) notes.push(w); },
    kerf: k, margin: m, rotations, partInPart: partInPart !== false, simplifyTol: Number(simplifyTol) || 0,
    level, seed: Number(seed) | 0, t0, floorMs: null,
    deadline: Math.min(
      t0 + (budgetMs == null ? level.capMs : Math.max(0, Number(budgetMs))),
      deadlineAt == null || !Number.isFinite(Number(deadlineAt)) ? Infinity : Number(deadlineAt),
    ),
    maxNests: Math.max(1, Math.trunc(Number(maxNests))),
    seeds, seedGap: Number(seedGap), nextId: 0, nfp: new Map(), nfpHeld: 0, warn: (w) => { if (!warnings.includes(w)) warnings.push(w); },
    cx: new Float64Array(1024), act: new Int32Array(256),
    shapes: null, types: null, placeable: null, rectSummary: null, lowerBoundSheets: 1,
    stopped: false, report: typeof onProgress === 'function' ? onProgress : null,
    checkpoint: typeof onCheckpoint === 'function' ? onCheckpoint : null, checkpointMs: Math.max(0, Number(checkpointMs) || 0),
    nfpMax: Number(nfpMax) > 0 ? Number(nfpMax) : NFP_CACHE_MAX,
  };
  /** Out of time, or told to stop. (The stop is asked for at most every few milliseconds: it may read shared memory.) */
  let askedAt = 0;
  ctx.over = () => {
    const now = Date.now();
    if (now >= ctx.deadline) return true;
    if (ctx.stopped) return true;
    if (typeof shouldStop === 'function' && now - askedAt >= 5) { askedAt = now; if (shouldStop()) ctx.stopped = true; }
    return ctx.stopped;
  };
  ctx.shapes = buildShapes(ctx, pieces);
  ctx.types = buildTypes(ctx, sheets);
  markFits(ctx);

  const blank = (extra) => ({
    nests: [], unplaced: [], totals: { sheets: 0, partArea: 0, sheetArea: 0, wastePct: 0, cutLengthMm: 0 },
    deterministic: true, tookMs: Date.now() - t0, kerf: k, margin: m, warnings, notes, ...extra,
  });
  if (!ctx.shapes.length) return blank({});

  // What nobody stocks, said up front (nestingPacker's rule): a purchasing answer, not a search.
  const upfront = [];
  const big = ctx.types.length ? ctx.types.reduce((a, t) => (t.area > a.area ? t : a)) : null;
  ctx.placeable = ctx.shapes.map((s) => {
    if (ctx.types.some((t) => t.fits[s.idx])) return true;
    upfront.push({
      key: s.key, qty: s.qty,
      reason: big
        ? `${s.L} x ${s.W} mm does not fit any offered plate in an allowed orientation `
          + `(largest is ${big.length} x ${big.width} mm${m > 0 ? `, less a ${m} mm rim` : ''})`
        : 'no plates were offered',
    });
    return false;
  });
  if (!ctx.placeable.some(Boolean)) return blank({ unplaced: mergeUnplaced(upfront) });
  // 0 = can only go on plates that may run out; 1 = some size that can always be bought again takes it.
  ctx.fitCount = ctx.shapes.map((s) => (ctx.types.some((t) => t.fits[s.idx] && t.available === Infinity && !t.isFixedSheet) ? 1 : 0));

  let needArea = 0;
  ctx.shapes.forEach((s) => { if (ctx.placeable[s.idx]) needArea += s.area * s.qty; });
  const maxArea = Math.max(...ctx.types.map((t) => t.area));
  ctx.lowerBoundSheets = Math.max(1, Math.ceil(needArea / maxArea - 1e-9));

  const { best, guard, capped, trials, stopped } = yield* search(ctx, input ?? {});

  // Out it goes — and every plate is checked, exactly, by code that shares nothing with the placer.
  const nBy = new Map();
  const perKey = new Map();
  const nests = [];
  const stripped = [];
  const order = [...best.states.filter((st) => st.type.isFixedSheet), ...best.states.filter((st) => !st.type.isFixedSheet)];
  for (const st of order) {
    let placements = outPlacements(ctx, st, nBy);
    const sheet = st.type.src;
    const v = verifyLayout({ sheet, placements, kerf: k, margin: m });
    if (!v.ok) {
      if (DEBUG) for (const pr of v.problems.slice(0, 4)) console.log('  unverified', st.type.key, pr.kind, pr.detail, [pr.ai, pr.bi].filter((i) => i != null && i >= 0).map((i) => JSON.stringify({ k: placements[i].key, x: placements[i].x, y: placements[i].y, r: placements[i].rotationDeg, m: placements[i].mirrored })).join(' '));
      // Never expected. A part that cannot be proven legal is not cut: it goes back as unplaced.
      const drop = new Set();
      for (const pr of v.problems) drop.add(pr.bi != null && pr.bi >= 0 ? Math.max(pr.ai, pr.bi) : pr.ai);
      ctx.warn(`sheet ${st.type.key}: ${drop.size} placement(s) failed verification (${v.problems[0].kind}) and were withdrawn`);
      placements = placements.filter((p, i) => { if (!drop.has(i)) return true; stripped.push({ key: p.key, qty: 1, reason: 'could not be placed legally (withdrawn after verification)' }); return false; });
      if (!placements.length) continue;
    }
    const idx = perKey.get(String(st.type.key)) ?? 0;
    perKey.set(String(st.type.key), idx + 1);
    nests.push({
      sheetKey: st.type.key, sheetIndex: idx, sheetLength: st.type.length, sheetWidth: st.type.width,
      preferred: st.type.preferred, fixedCount: st.type.fixedParts.length,
      placements,
      // `freeRegions: false` (packJob): the free regions are a boolean of the plate less every part's
      // halo — two thirds of this packer's time on a big job — and that caller measures the plate itself.
      metrics: layoutMetrics({ sheet, placements, kerf: k, margin: m, freeRegions: freeRegions !== false }),
    });
    yield;
  }
  const left = new Map();
  for (const s of best.rem) left.set(s, (left.get(s) ?? 0) + 1);
  const unplaced = mergeUnplaced([
    ...upfront,
    ...[...left].map(([s, qty]) => ({ key: ctx.shapes[s].key, qty, reason: 'no plate had room left' })),
    ...stripped,
  ]);
  const sheetArea = nests.reduce((a, n) => a + n.metrics.sheetArea, 0);
  const partArea = nests.reduce((a, n) => a + n.metrics.partArea, 0);
  return {
    nests,
    unplaced,
    totals: {
      sheets: nests.length, partArea, sheetArea,
      wastePct: sheetArea > 0 ? (100 * (sheetArea - partArea)) / sheetArea : 0,
      cutLengthMm: nests.reduce((a, n) => a + n.metrics.cutLengthMm, 0),
      /** Steel BOUGHT, as nestingPacker counts it: a plate already owned contributes nothing. */
      areaBought: best.cost,
    },
    /** False only when the clock (or the caller's stop), not a counted rule, ended a search. */
    deterministic: !capped,
    /** True when the caller's `shouldStop` ended it: the answer is the best layout it had. */
    stopped: !!stopped,
    tookMs: Date.now() - t0,
    kerf: k,
    margin: m,
    /** Which layout won: 'shape' (this packer), 'rect' (the rectangle packer's, kept as the floor) or 'start'. */
    source: best.source,
    trials,
    floorMs: ctx.floorMs,
    /** What the rectangle packer made of the bounding boxes, when it ran. */
    rectFloor: ctx.rectSummary,
    guardSource: guard ? guard.source : null,
    /** Things that should never happen and did (a layout withdrawn, a start refused). Empty on a healthy run. */
    warnings,
    /** Things worth knowing that are not faults (a shape too intricate to nest against exactly). */
    notes,
  };
}

/**
 * Lay `pieces` onto `sheets` by their true shape. Synchronous, and the same
 * seed gives the same answer (unless the clock cut the search short —
 * `deterministic` says).
 */
export function packShapes(input) {
  const it = solve(input);
  let r = it.next();
  while (!r.done) {
    let answer;
    if (r.value && r.value.rect) { try { answer = rectNest(r.value.rect); } catch (e) { answer = { error: e.message }; } }
    r = it.next(answer);
  }
  return r.value;
}

const breathe = () => new Promise((resolve) => { setImmediate(resolve); });

/**
 * The same search, letting the server breathe: it drains the identical
 * generator and hands the event loop back every few milliseconds. Same seed,
 * same answer as `packShapes`; `budgetMs` is honoured by both.
 */
export async function packShapesAsync(input) {
  const it = solve(input);
  let last = Date.now();
  let r = it.next();
  while (!r.done) {
    let answer;
    if (r.value && r.value.rect) {
      try { answer = await rectNestAsync(r.value.rect); } catch (e) { answer = { error: e.message }; }
      last = Date.now();
    } else if (Date.now() - last >= 12) { await breathe(); last = Date.now(); }
    r = it.next(answer);
  }
  return r.value;
}

/* ──────────────────────── checking and measuring a layout ──────────────── */

/** Everything on a sheet as exact polygons: the fixed parts, then the placements. */
function itemsOf(sheet, placements) {
  const items = [];
  const add = (entry, fixed, i) => {
    const rings = placedRingsOf(entry);
    const poly = rings && toPolygon(rings);
    if (!poly) return;
    const label = fixed ? `fixed:${entry.key ?? i}` : `${entry.key ?? i}${entry.n != null ? `#${entry.n}` : ''}`;
    items.push({ poly, rings, fixed, index: fixed ? -1 - i : i, label, bbox: bboxOfRing(poly.outline) });
  };
  (sheet?.fixed ?? []).forEach((f, i) => add(f, true, i));
  (placements ?? []).forEach((p, i) => add(p, false, i));
  return items;
}

/**
 * Is this layout legal? Exact geometry on the rings as given — it shares no
 * code with the placement engine.
 *
 *   overlap    two parts share steel
 *   too_close  two parts are nearer than the kerf (a part in a cut-out is
 *              measured to the cut-out's edge)
 *   outside    a part leaves the sheet (its rectangle, or its `outline`)
 *   in_rim     a part is inside the sheet but nearer its edge than `margin`
 *
 * `a` / `b` name the parts ("key#n", or "fixed:key"); `ai` / `bi` are their
 * indexes in `placements` (negative for a fixed part). Fixed parts are not
 * checked against each other or against the rim — they are given.
 */
export function verifyLayout({ sheet, placements, kerf = 0, margin = 0, tolerance = VERIFY_TOL } = {}) {
  const problems = [];
  const tol = tolerance;
  const items = itemsOf(sheet, placements);
  const L = Number(sheet?.length); const W = Number(sheet?.width);
  const sheetPoly = sheet?.outline ? toPolygon([sheet.outline]) : null;

  for (const it of items) {
    if (it.fixed) continue;
    const b = it.bbox;
    if (sheetPoly) {
      const r = polygonInside(it.poly, sheetPoly, tol);
      if (!r.inside) problems.push({ kind: 'outside', a: it.label, ai: it.index, detail: 'part of it lies outside the sheet outline' });
      else if (r.clearance < margin - tol) problems.push({ kind: 'in_rim', a: it.label, ai: it.index, detail: `${r.clearance.toFixed(3)} mm from the sheet edge, margin is ${margin} mm` });
    } else {
      const out = Math.max(-b.x0, -b.y0, b.x1 - L, b.y1 - W);
      const rim = Math.min(b.x0, b.y0, L - b.x1, W - b.y1);
      if (out > tol) problems.push({ kind: 'outside', a: it.label, ai: it.index, detail: `${out.toFixed(3)} mm beyond the ${L} x ${W} mm sheet` });
      else if (rim < margin - tol) problems.push({ kind: 'in_rim', a: it.label, ai: it.index, detail: `${Math.max(0, rim).toFixed(3)} mm from the sheet edge, margin is ${margin} mm` });
    }
  }

  const by = items.slice().sort((p, q) => p.bbox.x0 - q.bbox.x0);
  for (let i = 0; i < by.length; i += 1) {
    const A = by[i];
    for (let j = i + 1; j < by.length; j += 1) {
      const B = by[j];
      if (B.bbox.x0 > A.bbox.x1 + kerf) break;
      if (A.fixed && B.fixed) continue;
      if (B.bbox.y0 > A.bbox.y1 + kerf || A.bbox.y0 > B.bbox.y1 + kerf) continue;
      const [a, b] = A.index <= B.index ? [A, B] : [B, A];
      if (polygonsOverlap(A.poly, B.poly, tol)) {
        problems.push({ kind: 'overlap', a: a.label, b: b.label, ai: a.index, bi: b.index, detail: 'the two parts share steel' });
        continue;
      }
      if (kerf > 0) {
        const d = polygonsDistance(A.poly, B.poly, kerf);
        if (d < kerf - tol) problems.push({ kind: 'too_close', a: a.label, b: b.label, ai: a.index, bi: b.index, detail: `${d.toFixed(3)} mm apart, kerf is ${kerf} mm` });
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * What a laid-out sheet amounts to. Fixed parts on the sheet count: the numbers
 * describe the whole plate, not just what was added.
 *
 *   sheetArea     the plate (its outline's area if it has one)
 *   partArea      steel in parts: outlines less cut-outs and drilled holes
 *   usedArea      plate consumed: outlines of the parts that are not sitting in
 *                 another part's cut-out
 *   boundArea     the rectangle round everything placed (`bbox`)
 *   wastePct      100 · (sheetArea − partArea) / sheetArea
 *   cutLengthMm   every outline and cut-out, less `sharedCutMm`
 *   sharedCutMm   facing straight edges of two parts exactly a kerf apart — one
 *                 cut serves both, so it is counted once
 *   piercings     one per part plus one per cut-out
 *   freeRegions   what is left of the plate once every part AND its kerf halo is
 *                 gone: `[{ rings: { outline, cutouts, holes: [] }, area, bbox }]`,
 *                 largest first. Round halo corners are squared off outward, so
 *                 a region is never reported larger than it is.
 */
export function layoutMetrics({ sheet, placements, kerf = 0, margin = 0, freeRegions: wantFree = true, minFreeArea = null } = {}) {
  const items = itemsOf(sheet, placements);
  const L = Number(sheet?.length); const W = Number(sheet?.width);
  const sheetPoly = sheet?.outline ? toPolygon([sheet.outline]) : { outline: [[0, 0], [L, 0], [L, W], [0, W]], holes: [] };
  const sheetArea = polygonArea(sheetPoly);

  let partArea = 0; let usedArea = 0; let perim = 0; let piercings = 0;
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const it of items) {
    let a = polygonArea(it.poly);
    for (const h of it.rings.holes ?? []) a -= ringArea(cleanRing(h));
    partArea += Math.max(0, a);
    perim += ringPerimeter(it.poly.outline);
    for (const h of it.poly.holes) perim += ringPerimeter(h);
    piercings += 1 + it.poly.holes.length;
    box.x0 = Math.min(box.x0, it.bbox.x0); box.y0 = Math.min(box.y0, it.bbox.y0);
    box.x1 = Math.max(box.x1, it.bbox.x1); box.y1 = Math.max(box.y1, it.bbox.y1);
    // Sitting in somebody's cut-out? Then the plate it uses is already counted.
    let nested = false;
    for (const host of items) {
      if (host === it || !host.poly.holes.length) continue;
      if (it.bbox.x0 < host.bbox.x0 || it.bbox.x1 > host.bbox.x1 || it.bbox.y0 < host.bbox.y0 || it.bbox.y1 > host.bbox.y1) continue;
      if (host.poly.holes.some((h) => pointInRing(it.poly.outline[0], h))) { nested = true; break; }
    }
    if (!nested) usedArea += ringArea(it.poly.outline);
  }

  // Shared cuts: long straight edges of two parts, facing, a kerf apart.
  const minLen = Math.max(10, 3 * kerf);
  const straight = (it) => {
    if (it.straight) return it.straight;
    const out = [];
    for (const ring of [it.poly.outline, ...it.poly.holes]) {
      for (let i = 0, n = ring.length; i < n; i += 1) {
        const a = ring[i]; const b = ring[(i + 1) % n];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len >= minLen) out.push({ ax: a[0], ay: a[1], ux: (b[0] - a[0]) / len, uy: (b[1] - a[1]) / len, len });
      }
    }
    it.straight = out;
    return out;
  };
  let sharedCutMm = 0;
  const by = items.slice().sort((p, q) => p.bbox.x0 - q.bbox.x0);
  for (let i = 0; i < by.length; i += 1) {
    const A = by[i];
    for (let j = i + 1; j < by.length; j += 1) {
      const B = by[j];
      if (B.bbox.x0 > A.bbox.x1 + kerf + 1e-3) break;
      if (B.bbox.y0 > A.bbox.y1 + kerf + 1e-3 || A.bbox.y0 > B.bbox.y1 + kerf + 1e-3) continue;
      for (const e of straight(A)) {
        for (const f of straight(B)) {
          if (e.ux * f.ux + e.uy * f.uy > -(1 - 1e-9)) continue; // not facing
          const off = Math.abs(e.ux * (f.ay - e.ay) - e.uy * (f.ax - e.ax));
          if (Math.abs(off - kerf) > 1e-3) continue;
          const t0 = e.ux * (f.ax - e.ax) + e.uy * (f.ay - e.ay);
          const lo = Math.max(0, t0 - f.len); const hi = Math.min(e.len, t0);
          if (hi - lo > 1e-6) sharedCutMm += hi - lo;
        }
      }
    }
  }

  let free = [];
  if (wantFree) {
    const halos = [];
    for (const it of items) {
      const solid = simplifyOutward(it.poly, SIMPLIFY_TOL);
      for (const c of convexDecompose(solid)) {
        const mk = mkPiece(c);
        halos.push({
          outline: mk.box && kerf > 0
            ? [[mk.x0 - kerf, mk.y0 - kerf], [mk.x1 + kerf, mk.y0 - kerf], [mk.x1 + kerf, mk.y1 + kerf], [mk.x0 - kerf, mk.y1 + kerf]]
            : offsetConvex(c, kerf),
          holes: [],
        });
      }
    }
    const floor = minFreeArea ?? Math.max(1, kerf * kerf);
    free = booleanRegions([sheetPoly], halos, 'difference')
      .filter((r) => r.area >= floor)
      .map((r) => ({ rings: { outline: r.outline, cutouts: r.holes, holes: [] }, area: r.area, bbox: r.bbox }));
  }

  const has = items.length > 0;
  return {
    sheetArea, partArea, usedArea,
    boundArea: has ? (box.x1 - box.x0) * (box.y1 - box.y0) : 0,
    bbox: has ? box : null,
    wastePct: sheetArea > 0 ? (100 * (sheetArea - partArea)) / sheetArea : 0,
    cutLengthMm: perim - sharedCutMm, sharedCutMm, piercings,
    parts: items.length, margin,
    freeRegions: free,
  };
}

/** Internals, for benchmarks. The test deliberately does not use them. */
export const __internals = { EPS, X_CAP, costOf, getNfp, findPosition };
