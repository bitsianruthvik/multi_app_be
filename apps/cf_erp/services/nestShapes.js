/**
 * nestShapes.js — CF_ERP. The few shape questions nesting asks once a part may be more than a
 * rectangle laid square (init.sql §55): what a cut plate's shape is, where its rings land on a
 * plate, whether a laid-out plate is legal, and what a plate of true shapes is made of.
 *
 * Everything here is pure (no database). It sits between nestingService / nestDxfImportService and
 * the two geometry libraries:
 *   lib/nestDxfReader.js      `placeRings` — THE PLACEMENT CONVENTION (normalise to the bounding
 *                             box's min corner → mirror about y → rotate counter-clockwise →
 *                             normalise again → move to x, y).
 *   services/shapePacker.js   `verifyLayout`, `layoutMetrics` — exact checks and free regions.
 *
 * THE PACKER IS REACHED THROUGH ONE ADAPTER (`verifyPlate`, `shapedWaste`). It is imported with a
 * guard, so a broken or missing shapePacker.js never takes rectangle nesting down with it; with no
 * packer `verifyPlate` falls back to the same checks made directly on lib/polyGeom.js (and to
 * bounding boxes when that is missing too), and `shapedWaste` answers null — the caller then
 * charges waste on the boxes round the parts (nestingService.wasteOfLot), which still adds up.
 */
import { DRILL_MAX_DIA_MM } from './partGeometry.js';
import { placeRings as place, rectRings } from '../lib/nestDxfReader.js';

let SP = null;
try { SP = await import('./shapePacker.js'); } catch { SP = null; }
let PG = null;
try { PG = await import('../lib/polyGeom.js'); } catch { PG = null; }

/** 'shapePacker' | 'polyGeom' (the fallback) | 'boxes' (the last resort). */
export const VERIFY_ENGINE = SP?.verifyLayout ? 'shapePacker' : PG?.polygonsOverlap ? 'polyGeom' : 'boxes';
export const hasShapeMetrics = !!SP?.layoutMetrics;
export const shapePacker = () => SP;

/** A customer drawing is rounded to 0.1 mm: anything shallower than this is not an overlap. */
export const IMPORT_TOL_MM = 0.05;

const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const RAD = Math.PI / 180;

/* ───────────────────────────── the rim ───────────────────────────── */

/**
 * THE RIM, ONE RULE FOR BOTH PACKERS — ONE KERF AT THE PLATE EDGE (user, 2026-10-10: "Go with one
 * kerf at the plate edge").
 *
 * "Kerf is charged at the rim": the raw plate's own edge is cut, so a part sits ONE KERF in from
 * it — no nearer (that is what every verifier checks: nestingService.verifyLot for rows and for
 * free layouts, nestRules, verifyPlate; a customer's layout nearer than that is a warning that
 * needs force), and our packers leave no more.
 *
 *   nestingPacker  charges the rim cut ITSELF (one kerf) and reads `margin` as a trim ON TOP of it
 *                  → `rectMargin` = the extra, 0. (Until this decision nestingService handed it
 *                  margin = kerf, so every row nest since 2026-09-25 started TWO kerfs in.)
 *   shapePacker    reads `margin` as the WHOLE clearance → `shapeMargin` = one kerf.
 *
 * `RIM_EXTRA_KERFS` is what is left BEYOND the one kerf that is the rim cut: 0. It is not the
 * clearance — the clearance is (1 + RIM_EXTRA_KERFS) kerfs, so 0 means one kerf, never none.
 *
 * PLATES ALREADY SAVED were laid out two kerfs in. They stay valid (more clearance than the rule
 * asks): nothing re-verifies a saved plate against the packers' figure and nothing re-packs one;
 * only a NEW nesting run lays parts one kerf in.
 */
export const RIM_EXTRA_KERFS = 0;
export function rimOf(kerfMm) {
  const k = Math.max(0, Number(kerfMm) || 0);
  const extra = RIM_EXTRA_KERFS * k;
  return { kerf: k, rectMargin: extra, shapeMargin: extra + k, clearance: extra + k, legalMin: k };
}

/* ───────────────────────────── rings ───────────────────────────── */

const openRing = (r) => {
  if (!Array.isArray(r) || r.length < 3) return null;
  const a = r[0]; const z = r[r.length - 1];
  const out = (Math.abs(a[0] - z[0]) <= 1e-9 && Math.abs(a[1] - z[1]) <= 1e-9 ? r.slice(0, -1) : r).map(([x, y]) => [Number(x), Number(y)]);
  return out.length >= 3 ? out : null;
};
const absArea = (pts) => { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]; return Math.abs(a / 2); };
const boxOf = (pts) => { let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity; for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, y0, x1, y1 }; };

/** A ring that is a circle (as CAD or partGeometry flattens one): its diameter, else null. */
function circleDia(pts) {
  if (pts.length < 12) return null;
  let cx = 0; let cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= pts.length; cy /= pts.length;
  let lo = Infinity; let hi = 0;
  for (const [x, y] of pts) { const d = Math.hypot(x - cx, y - cy); if (d < lo) lo = d; if (d > hi) hi = d; }
  return hi - lo <= Math.max(0.15, 0.002 * hi) ? hi + lo : null;
}

/**
 * Rings as { outline, cutouts, holes }, whichever way they came. partDrawingService hands a
 * drawing over as a list [outline, …inner] that no longer says which inner ring is a torch
 * cut-out and which a DRILLED hole — and the difference matters: a cut-out is room another part
 * may use, a drilled hole is steel until it is drilled. A round ring up to the drill limit is a
 * hole (partGeometry's own rule).
 */
export function ringsObject(rings) {
  if (!rings) return null;
  if (!Array.isArray(rings)) {
    const outline = openRing(rings.outline);
    if (!outline) return null;
    return { outline, cutouts: (rings.cutouts ?? []).map(openRing).filter(Boolean), holes: (rings.holes ?? []).map(openRing).filter(Boolean) };
  }
  const list = (typeof rings[0]?.[0] === 'number' ? [rings] : rings).map(openRing).filter(Boolean);
  if (!list.length) return null;
  const out = { outline: list[0], cutouts: [], holes: [] };
  for (const r of list.slice(1)) {
    const d = circleDia(r);
    (d != null && d <= DRILL_MAX_DIA_MM + 0.2 ? out.holes : out.cutouts).push(r);
  }
  return out;
}

/** Steel in a part: its outline less cut-outs and drilled holes. */
export const ringsArea = (o) => (o ? absArea(o.outline) - o.cutouts.reduce((a, r) => a + absArea(r), 0) - o.holes.reduce((a, r) => a + absArea(r), 0) : 0);

/** A rectangle is its own four corners and nothing else. */
export function isPlainRect(o) {
  if (!o || o.cutouts.length || o.holes.length || o.outline.length !== 4) return false;
  const b = boxOf(o.outline);
  return o.outline.every(([x, y]) => (Math.abs(x - b.x0) < 1e-6 || Math.abs(x - b.x1) < 1e-6) && (Math.abs(y - b.y0) < 1e-6 || Math.abs(y - b.y1) < 1e-6));
}

/**
 * A cut plate's shape: its drawing when partDrawingService has ONE shape for every piece of it
 * (`facts.get(id).rings`, x along its LENGTH), else the rectangle LENGTH × WIDTH.
 * → { rings: { outline, cutouts, holes }, drawn: boolean, area, length, width }
 */
export function shapeOfCutPlate(cp, facts = null) {
  const L = Number(cp?.steel?.length ?? cp?.length);
  const W = Number(cp?.steel?.width ?? cp?.width);
  const drawn = ringsObject(facts?.get?.(Number(cp?.id))?.rings ?? null);
  if (drawn) {
    const b = boxOf(drawn.outline);
    return { rings: drawn, drawn: true, area: r3(ringsArea(drawn)), length: r3(b.x1 - b.x0), width: r3(b.y1 - b.y0) };
  }
  if (!(L > 0 && W > 0)) return null;
  return { rings: ringsObject(rectRings(L, W)), drawn: false, area: r3(L * W), length: L, width: W };
}

/** THE PLACEMENT CONVENTION, on { outline, cutouts, holes }. Points rounded to a tenth of a micron. */
export function placeShape(rings, { x = 0, y = 0, rotationDeg = 0, mirrored = false } = {}) {
  const o = ringsObject(rings);
  if (!o) return null;
  const p = place(o, { x: Number(x), y: Number(y), rotationDeg: Number(rotationDeg) || 0, mirrored: !!mirrored });
  const r = (ring) => ring.map(([px, py]) => [Math.round(px * 1e4) / 1e4, Math.round(py * 1e4) / 1e4]);
  return { outline: r(p.outline), cutouts: p.cutouts.map(r), holes: p.holes.map(r) };
}

/**
 * Placed rings AS AN ANSWER SHOWS THEM: outline and cut-outs as corner lists (mm, 3 decimals),
 * drilled holes as CIRCLES { cx, cy, d } — a hole is round by definition (ringsObject), and a
 * splice plate's sixty holes are sixty small objects this way instead of four thousand points.
 * For the screen only: nothing reads a layout back from these (accept places the DB's own shape).
 */
export function displayRings(o) {
  if (!o) return null;
  const r = (ring) => ring.map(([x, y]) => [r3(x), r3(y)]);
  return {
    outline: r(o.outline),
    cutouts: (o.cutouts ?? []).map(r),
    holes: (o.holes ?? []).map((h) => {
      if (!Array.isArray(h)) return h;                       // already a circle
      let cx = 0; let cy = 0;
      for (const [x, y] of h) { cx += x; cy += y; }
      cx /= h.length; cy /= h.length;
      const rad = h.reduce((a, [x, y]) => a + Math.hypot(x - cx, y - cy), 0) / h.length;
      return { cx: r3(cx), cy: r3(cy), d: Math.round(rad * 20) / 10 };
    }),
  };
}

/** The box round placed rings as { x, y, length, width }. */
export function boxOfShape(o) {
  const b = boxOf(o.outline);
  return { x: r3(b.x0), y: r3(b.y0), length: r3(b.x1 - b.x0), width: r3(b.y1 - b.y0) };
}

/* ───────────────────────────── rotation ───────────────────────────── */

export const normDeg = (deg) => {
  const d = ((Number(deg) % 360) + 360) % 360;
  const q = Math.round(d * 1000) / 1000;
  return q >= 360 ? 0 : q;
};
/** A whole number of quarter turns? */
export const isQuarterTurn = (deg) => { const d = normDeg(deg); return Math.abs(d / 90 - Math.round(d / 90)) < 1e-6; };
/**
 * `rotated` (the pre-§55 column) for a rotation: 1 exactly when the footprint is turned a quarter
 * (90° or 270°), so the old readers that swap length and width keep working. 0 at any other angle.
 */
export const rotatedFlag = (deg) => isQuarterTurn(deg) && [1, 3].includes(((Math.round(normDeg(deg) / 90) % 4) + 4) % 4);
/** The rotation a stored placement row means: its rotation_deg, else (a pre-§55 row) rotated → 90. */
export const rotationOfRow = (row) => (row?.rotation_deg != null ? normDeg(row.rotation_deg) : (Number(row?.rotated) ? 90 : 0));
/** Plain = lies square, not flipped, so its box IS the part when it has no drawing. */
export const isPlainPlacement = (rotationDeg, mirrored) => isQuarterTurn(rotationDeg ?? 0) && !mirrored;

/* ───────────────────────────── is this plate legal? ───────────────────────────── */

const polyOf = (o) => (PG?.toPolygon ? PG.toPolygon(o) : null);

function verifyWithPolyGeom({ length, width, placements, fixed, kerf, margin, tolerance }) {
  // TEMPORARY FALLBACK (no shapePacker.js): the same four checks, made directly on lib/polyGeom.js.
  const items = [...fixed.map((f, i) => ({ ...f, fixed: true, index: -1 - i })), ...placements.map((p, i) => ({ ...p, fixed: false, index: i }))]
    .map((it) => ({ ...it, poly: polyOf(it.rings), bbox: boxOf(it.rings.outline) })).filter((it) => it.poly);
  const problems = [];
  for (const it of items) {
    if (it.fixed) continue;
    const b = it.bbox;
    const out = Math.max(-b.x0, -b.y0, b.x1 - length, b.y1 - width);
    const rim = Math.min(b.x0, b.y0, length - b.x1, width - b.y1);
    if (out > tolerance) problems.push({ kind: 'outside', ai: it.index, detail: `${out.toFixed(3)} mm beyond the ${length} x ${width} mm sheet` });
    else if (rim < margin - tolerance) problems.push({ kind: 'in_rim', ai: it.index, detail: `${Math.max(0, rim).toFixed(3)} mm from the sheet edge, margin is ${margin} mm` });
  }
  const by = items.slice().sort((p, q) => p.bbox.x0 - q.bbox.x0);
  for (let i = 0; i < by.length; i += 1) {
    for (let j = i + 1; j < by.length; j += 1) {
      const A = by[i]; const B = by[j];
      if (B.bbox.x0 > A.bbox.x1 + kerf) break;
      if ((A.fixed && B.fixed) || B.bbox.y0 > A.bbox.y1 + kerf || A.bbox.y0 > B.bbox.y1 + kerf) continue;
      const [a, b] = A.index <= B.index ? [A, B] : [B, A];
      if (PG.polygonsOverlap(A.poly, B.poly, tolerance)) { problems.push({ kind: 'overlap', ai: a.index, bi: b.index, detail: 'the two parts share steel' }); continue; }
      if (kerf > 0) {
        const d = PG.polygonsDistance(A.poly, B.poly, kerf);
        if (d < kerf - tolerance) problems.push({ kind: 'too_close', ai: a.index, bi: b.index, detail: `${d.toFixed(3)} mm apart, kerf is ${kerf} mm` });
      }
    }
  }
  return problems;
}

function verifyWithBoxes({ length, width, placements, fixed, kerf, margin, tolerance }) {
  // TEMPORARY LAST RESORT (no shapePacker.js AND no polyGeom.js): bounding boxes only. It refuses
  // layouts whose parts interlock, so it is never used when either library loads.
  const items = [...fixed.map((f, i) => ({ fixed: true, index: -1 - i, b: boxOf(f.rings.outline) })), ...placements.map((p, i) => ({ fixed: false, index: i, b: boxOf(p.rings.outline) }))];
  const problems = [];
  for (const it of items) {
    if (it.fixed) continue;
    const out = Math.max(-it.b.x0, -it.b.y0, it.b.x1 - length, it.b.y1 - width);
    const rim = Math.min(it.b.x0, it.b.y0, length - it.b.x1, width - it.b.y1);
    if (out > tolerance) problems.push({ kind: 'outside', ai: it.index, detail: `${out.toFixed(3)} mm beyond the sheet` });
    else if (rim < margin - tolerance) problems.push({ kind: 'in_rim', ai: it.index, detail: `${Math.max(0, rim).toFixed(3)} mm from the sheet edge` });
  }
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const A = items[i]; const B = items[j];
      if (A.fixed && B.fixed) continue;
      const sep = Math.max(B.b.x0 - A.b.x1, A.b.x0 - B.b.x1, B.b.y0 - A.b.y1, A.b.y0 - B.b.y1);
      if (sep < -tolerance) problems.push({ kind: 'overlap', ai: A.index, bi: B.index, detail: 'their boxes overlap' });
      else if (sep < kerf - tolerance) problems.push({ kind: 'too_close', ai: A.index, bi: B.index, detail: `${Math.max(0, sep).toFixed(3)} mm apart, kerf is ${kerf} mm` });
    }
  }
  return problems;
}

/**
 * Is a laid-out plate legal? THE ONE ADAPTER over shapePacker.verifyLayout.
 *
 *   length, width   the plate, mm
 *   placements      [{ key, rings }] — rings ALREADY PLACED, in plate mm ({ outline, cutouts, holes })
 *   fixed           the same, for parts that are given and not themselves checked against the rim
 *   kerf            least gap between two parts
 *   margin          least gap to the plate edge; `rim: false` skips the edge-gap check (a file
 *                   that does not draw its plate cannot say where the edge is)
 *   tolerance       how deep an overlap is forgiven
 *
 * → { engine, problems: [{ kind: 'overlap'|'too_close'|'outside'|'in_rim', ai, bi, detail, distance? }],
 *     commonCuts: [{ ai, bi }] }
 * `ai` / `bi` index `placements` (negative = a fixed part). TWO PARTS THAT TOUCH — nearer than the
 * tolerance, sharing no steel — are a COMMON CUT, one line cut once for both, which is how another
 * program draws a shared boundary; they are counted in `commonCuts`, not reported as too close.
 */
export function verifyPlate({ length, width, placements = [], fixed = [], kerf = 0, margin = 0, rim = true, tolerance = IMPORT_TOL_MM } = {}) {
  const L = Number(length); const W = Number(width); const k = Math.max(0, Number(kerf) || 0);
  const m = rim ? Math.max(0, Number(margin) || 0) : 0;
  const arg = { length: L, width: W, placements, fixed, kerf: k, margin: m, tolerance };
  let raw;
  if (VERIFY_ENGINE === 'shapePacker') {
    raw = SP.verifyLayout({
      sheet: { length: L, width: W, fixed: fixed.map((f) => ({ key: f.key, rings: f.rings, placed: true })) },
      placements: placements.map((p) => ({ key: p.key, rings: p.rings, placed: true })),
      kerf: k, margin: m, tolerance,
    }).problems.map((p) => ({ kind: p.kind, ai: p.ai, bi: p.bi ?? null, detail: p.detail }));
  } else raw = VERIFY_ENGINE === 'polyGeom' ? verifyWithPolyGeom(arg) : verifyWithBoxes(arg);

  const ringsAt = (i) => (i >= 0 ? placements[i]?.rings : fixed[-1 - i]?.rings);
  const problems = [];
  const commonCuts = [];
  for (const p of raw) {
    if (p.kind === 'too_close' && PG?.polygonsDistance) {
      const A = polyOf(ringsAt(p.ai)); const B = polyOf(ringsAt(p.bi));
      const d = A && B ? PG.polygonsDistance(A, B, k + 1) : null;
      if (d != null && d <= tolerance) { commonCuts.push({ ai: p.ai, bi: p.bi }); continue; }
      problems.push({ ...p, distance: d == null ? null : r3(d) });
      continue;
    }
    problems.push(p);
  }
  return { engine: VERIFY_ENGINE, problems, commonCuts };
}

/* ───────────────────────────── what a plate of true shapes is made of ───────────────────────────── */

/** x-intervals of a polygon's solid on the line y (even–odd over all its rings). */
function spansAt(rings, y) {
  const xs = [];
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y)) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
    }
  }
  xs.sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k + 1 < xs.length; k += 2) out.push([xs[k], xs[k + 1]]);
  return out;
}

/**
 * The largest axis-aligned rectangle inside a region ({ outline, cutouts }), found on a grid of
 * the region's own corner coordinates (plus a regular step). A cell counts only when it is inside
 * the region along its bottom, middle and top — so the answer is never larger than the truth, and
 * is exact for a region with square corners.
 */
export function largestRectIn(region, { maxLines = 96 } = {}) {
  const rings = [region.outline, ...(region.cutouts ?? [])];
  const b = boxOf(region.outline);
  const lines = (vals, lo, hi) => {
    const step = Math.max((hi - lo) / 40, 1);
    const all = [lo, hi, ...vals];
    for (let v = lo + step; v < hi; v += step) all.push(v);
    all.sort((p, q) => p - q);
    const out = [];
    for (const v of all) if (!out.length || v - out[out.length - 1] > 1e-6) out.push(v);
    if (out.length <= maxLines) return out;
    // Too many corners: keep the regular lines and the extremes — still inside, only coarser.
    const keep = [lo];
    for (let v = lo + step; v < hi; v += step) keep.push(v);
    keep.push(hi);
    return keep;
  };
  const xs = lines(rings.flatMap((r) => r.map((p) => p[0])), b.x0, b.x1);
  const ys = lines(rings.flatMap((r) => r.map((p) => p[1])), b.y0, b.y1);
  const nx = xs.length - 1; const ny = ys.length - 1;
  if (nx < 1 || ny < 1) return null;
  const within = (spans, x0, x1) => spans.some(([a, z]) => a <= x0 + 1e-6 && z >= x1 - 1e-6);
  const h = new Float64Array(nx);
  let best = null;
  for (let j = 0; j < ny; j += 1) {
    const dy = ys[j + 1] - ys[j];
    const e = Math.min(1e-4, dy / 4);
    const rows = [spansAt(rings, ys[j] + e), spansAt(rings, (ys[j] + ys[j + 1]) / 2), spansAt(rings, ys[j + 1] - e)];
    for (let i = 0; i < nx; i += 1) h[i] = rows.every((s) => within(s, xs[i], xs[i + 1])) ? h[i] + dy : 0;
    const st = [];
    for (let i = 0; i <= nx; i += 1) {
      const hh = i < nx ? h[i] : 0;
      let start = xs[i];
      while (st.length && st[st.length - 1].h >= hh - 1e-9) {
        const top = st.pop();
        const len = xs[i] - top.start;
        const area = top.h * len;
        if (!best || area > best.area + 1e-6) best = { area, x: top.start, y: ys[j + 1] - top.h, length: len, width: top.h };
        start = top.start;
      }
      if (hh > 1e-9) st.push({ start, h: hh });
    }
  }
  return best ? { x: r3(best.x), y: r3(best.y), length: r3(best.length), width: r3(best.width) } : null;
}

/**
 * Waste by cause and offcuts for a plate whose parts are TRUE SHAPES (or lie at a free angle),
 * from shapePacker.layoutMetrics' free regions. null when that is not available.
 *
 *   pieces  [{ rings (placed), area (steel in the part) }]
 *
 * Every square millimetre goes to exactly one cause, so they add up to the plate:
 *   parts     Σ area
 *   rim       the kerf-wide band along the plate edge
 *   kerf      inside the rim: every part's kerf halo, less the parts
 *   offcut    the free regions big enough to keep (area and inscribed rectangle)
 *   wastage   every other free region, and what the drill takes out of the parts
 *   sequenceGaps  0 — a free layout has no sequences
 * A part drawn inside the rim (a customer layout saved anyway) eats into `rim`, never below zero.
 */
export function shapedWaste({ length, width, kerf = 0, pieces = [], minOffcutArea = 90000, minOffcutSide = 100 } = {}) {
  if (!hasShapeMetrics || !PG?.toPolygon) return null;
  const L = Number(length); const W = Number(width); const k = Math.max(0, Number(kerf) || 0);
  if (!(L > 2 * k && W > 2 * k)) return null;
  const inner = [[k, k], [L - k, k], [L - k, W - k], [k, W - k]];
  let m;
  try {
    m = SP.layoutMetrics({
      sheet: { length: L, width: W, outline: inner },
      placements: pieces.map((p, i) => ({ key: `p${i}`, rings: p.rings, placed: true })),
      kerf: k, margin: 0, freeRegions: true, minFreeArea: 0,
    });
  } catch { return null; }
  const plate = L * W;
  const innerArea = (L - 2 * k) * (W - 2 * k);
  const parts = pieces.reduce((a, p) => a + Number(p.area ?? ringsArea(p.rings)), 0);
  const solid = pieces.reduce((a, p) => a + absArea(p.rings.outline) - (p.rings.cutouts ?? []).reduce((s, r) => s + absArea(r), 0), 0);
  const drilled = Math.max(0, solid - parts);
  const freeAll = m.freeRegions.reduce((a, r) => a + r.area, 0);
  let rim = plate - innerArea;
  let kerfArea = innerArea - freeAll - solid;
  if (kerfArea < 0) { rim = Math.max(0, rim + kerfArea); kerfArea = 0; }
  const offcuts = [];
  let offcutArea = 0;
  for (const reg of m.freeRegions) {
    if (reg.area < minOffcutArea - 1e-3) continue;
    const region = { outline: reg.rings.outline, cutouts: reg.rings.cutouts ?? [] };
    const rect = largestRectIn(region);
    if (!rect || Math.min(rect.length, rect.width) < minOffcutSide - 1e-6) continue;
    offcutArea += reg.area;
    const rr = (ring) => ring.map(([x, y]) => [r3(x), r3(y)]);
    offcuts.push({
      area: r3(reg.area),
      bbox: { x: r3(reg.bbox.x0), y: r3(reg.bbox.y0), length: r3(reg.bbox.x1 - reg.bbox.x0), width: r3(reg.bbox.y1 - reg.bbox.y0) },
      rect,
      outline: [rr(region.outline), ...region.cutouts.map(rr)],
    });
  }
  offcuts.sort((a, b) => b.area - a.area || a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
  const waste = { kerf: r3(kerfArea), sequenceGaps: 0, rim: r3(rim), offcut: r3(offcutArea), wastage: 0 };
  // What is left is wastage — taken as the remainder, so the causes add up to the plate exactly.
  waste.wastage = r3(Math.max(0, plate - r3(parts) - waste.kerf - waste.rim - waste.offcut));
  void drilled;
  return { plateArea: r3(plate), partsArea: r3(parts), waste, offcuts, basis: 'shapes' };
}

/** cos/sin of a placement, for callers that need the turned size of a rectangle. */
export function turnedBox(length, width, rotationDeg) {
  const t = normDeg(rotationDeg) * RAD;
  const c = Math.abs(Math.cos(t)); const s = Math.abs(Math.sin(t));
  return { length: r3(length * c + width * s), width: r3(length * s + width * c) };
}
