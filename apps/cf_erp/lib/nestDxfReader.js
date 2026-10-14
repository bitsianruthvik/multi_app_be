/**
 * nestDxfReader.js — CF_ERP. Reads a CUSTOMER'S nesting DXF (one file = one plate) and says which
 * of our cut plates each shape in it is, and exactly where it sits (user, 2026-10-10: "We should
 * ideally be able to just upload nesting files and it should copy the entire nesting from the
 * customer").
 *
 * PURE: text in, shapes and placements out. No database, no tenant, no order.
 * scripts/cf_kepl/nest_dxf_reader_test.mjs runs it with files written by
 * scripts/cf_kepl/lib/nestDxfFixtures.mjs, the way different nesting programs write them.
 *
 * ── readNestDxf: WHAT IS READ ───────────────────────────────────────────────
 * HEADER ($INSUNITS — inches, feet, cm and m become mm), BLOCKS and ENTITIES of an ASCII DXF:
 * LINE, ARC, CIRCLE, LWPOLYLINE (bulges), POLYLINE/VERTEX, ELLIPSE, SPLINE (through its fit
 * points, else its control points — the same flattening as services/partGeometry.js, 5° steps),
 * INSERT (rotation, scale, mirror, arrays, blocks inside blocks, a negative extrusion), and the
 * words: TEXT, MTEXT, ATTRIB.
 *
 * ── HOW SHAPES ARE FOUND ────────────────────────────────────────────────────
 * A closed polyline or a circle is a loop as drawn. Everything else (loose LINEs and ARCs) goes
 * into ONE graph: ends closer than the join tolerance are one point, a line is split where
 * another line ends on it, the same line drawn twice is one line. Lines that are on no closed
 * path (lead-ins, rapid moves, a leftover dimension) are dropped with a warning, and the loops
 * are the FACES of what is left — which is why a common-cut nest works: the shared cut is drawn
 * once and closes both of its neighbours.
 * Two straight cuts of one connected drawing that CROSS with no end at the crossing (a block of
 * equal parts: a rim and long cuts right across it) get a point there, so every cell is a face.
 * GAPS (2026-10-13): before the lines on no closed path are dropped, two loose ends that are a
 * sloppy corner or a micro-joint apart are joined (GAP_CLOSE_MM) and a warning says so. What is
 * still dropped is looked at as chains: inside a part it is marking; a plain run in the scrap that
 * would enclose a part is AN OUTLINE LEFT OPEN — a `problem` (OPEN_CONTOUR) or a `caution`
 * (SHAPE_IGNORED), never only a warning.
 * Parts common-cut against the plate's own edge leave no loop round them all: they fill their
 * rectangle exactly, and what is left of the plate (`skeleton`) is not a part. A part lying across
 * the plate's edge is returned with `outsidePlate` / `outsideMm`.
 *
 * The loops then nest inside each other. The largest one holding all the others is the PLATE
 * (unless everything inside it is a drilled hole — then it is one part with its holes; and unless
 * it is a drawing FRAME: not a size a plate comes in, with a rectangle inside it that is). A second
 * plate beside the first is a `problem` (MULTIPLE_PLATES); any other closed shape beside the plate
 * comes back in `outside`;
 * the loops directly inside it are PARTS; a loop inside a part is its cut-out or hole — or MARKING,
 * told by its layer and colour (see `kindOf` in readNestDxf); a loop
 * inside a cut-out is a part again (a small part nested in a window), and so on down.
 * Parts come out in PLATE coordinates: the plate's lower-left corner is (0,0), in mm.
 *
 * ── matchNest: WHICH CUT PLATE EACH PART IS ─────────────────────────────────
 * Label first (a text inside the part, or its block's name, that is one of a candidate's codes —
 * and only when the shape agrees); then the shape itself at ANY angle and either hand; then the
 * rectangle around it. THE PLACEMENT CONVENTION (shared with the packer) is `placeRings`.
 */
import { DRILL_MAX_DIA_MM } from '../services/partGeometry.js';
import { invalid } from './errors.js';

const ARC_STEP_DEG = 5;                 // the same flattening as partGeometry.js
const JOIN_TOL = 0.1;                   // mm: ends closer than this are one point
/*
 * GAPS IN AN OUTLINE (2026-10-13). Real files leave them: a micro-joint (tab) is 0.2 – 1.5 mm of
 * contour left uncut so the part stays in the skeleton, and hand-drawn CAD stops a line a few
 * tenths short of its corner. Two loose ends are joined when they are
 *   - up to CORNER_GAP_MM apart, whichever way they point (a sloppy corner), or
 *   - up to GAP_CLOSE_MM apart AND each points at the other (a tab: the cut carries straight on).
 * 2 mm is under the narrowest kerf this shop cuts with (2.5 mm), so two DIFFERENT parts are never
 * that close; and the "pointing at each other" rule keeps a lead-in's loose end from being joined
 * to its neighbour's. Anything wider stays open and is SAID (OPEN_CONTOUR), never dropped quietly.
 */
export const GAP_CLOSE_MM = 2;
const CORNER_GAP_MM = 0.5;
const FACING_COS = Math.cos((20 * Math.PI) / 180);
/** An open chain is "a part left open" from this much enclosed steel (50 × 50) and this many straight runs. */
const OPEN_PART_MIN_AREA = 2500;
const OPEN_PART_MIN_SEGMENTS = 3;
/** Its ends this near each other (or within a tenth of its length) → an outline with a gap: it blocks. */
const OPEN_PART_GAP_BLOCK_MM = 25;
/** Kerf compensation (matchNest): the most a file's outlines may be drawn outside the part, per side. */
export const KERF_OFFSET_MAX_MM = 3;
/** A ProNest part may be nested this much LONGER than its cut piece (a cutting / trimming allowance on the long side). */
export const CUT_ALLOWANCE_MAX_MM = 25;
const MIN_LOOP_AREA = 1;                // mm²: anything smaller is not a shape
const PIERCE_MAX_DIA = 2;               // mm: a circle this small is a pierce mark, not a hole
const MAX_CHARS = 40e6;
const MAX_PRIMITIVES = 250000;
const MAX_BLOCK_DEPTH = 12;
const UNIT = { 0: 1, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 };
const UNIT_NAME = { 0: 'mm', 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' };
const B = '(^|[^A-Z])';
const E = '([^A-Z]|$)';
/** Layers that are plainly not something cut out of the plate. Their words are still read. */
const SKIP_LAYER = new RegExp(`${B}(DIM|DIMS|DIMENSION|TEXT|NOTE|ANNO|CENT|CENTER|CENTRE|CL|HATCH|TITLE|BORDER|FRAME|DEFPOINTS|VIEWPORT|RAPID|RAPIDS|TRAVERSE|LEAD|LEADS|LEADIN|LEADINS|LEADOUT|LEADOUTS|PIERCE|PIERCING|MARK|MARKS|MARKING|MARKINGS|SCRIBE|SCRIBING|ETCH|ETCHING|ENGRAVE|ENGRAVING)${E}`, 'i');
const OFFCUT_LAYER = /(OFFCUT|REMNANT|SCRAP|SKELETON|WASTE)/i;
/** Entities this reader does not read, that can hold a shape: said when a file has them. */
const UNREAD_SHAPES = new Set(['HATCH', 'SOLID', 'TRACE', '3DFACE', 'REGION', 'MLINE', 'BODY', '3DSOLID', 'MESH', 'SURFACE', 'WIPEOUT']);
const PLATE_LAYER = new RegExp(`${B}(PLATE|SHEET|STOCK|MATERIAL|RAWPLATE)${E}`, 'i');

const r4 = (n) => Math.round(n * 1e4) / 1e4;
const r1 = (n) => Math.round(n * 10) / 10;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const RAD = Math.PI / 180;

/* ───────────────────────────── small geometry (private) ───────────────────────────── */

const signedArea = (pts) => { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]; return a / 2; };
const perimeterOf = (pts) => { let s = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]); return s; };
const boxOf = (pts) => { let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity; for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, y0, x1, y1 }; };
const boxOfRings = (rings) => boxOf(rings.flat());
function centroidOf(pts) {
  let a = 0; let cx = 0; let cy = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const w = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    a += w; cx += (pts[j][0] + pts[i][0]) * w; cy += (pts[j][1] + pts[i][1]) * w;
  }
  if (Math.abs(a) < 1e-12) { const b = boxOf(pts); return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]; }
  return [cx / (3 * a), cy / (3 * a)];
}
function insidePoly(pt, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]; const [xj, yj] = pts[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function distToSeg(p, a, b) {
  const dx = b[0] - a[0]; const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function distToRing(p, ring) {
  let d = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const x = distToSeg(p, ring[j], ring[i]); if (x < d) d = x; }
  return d;
}
/** A point strictly inside a ring (the middle of its first crossing of a line through it). */
function interiorPoint(pts) {
  const b = boxOf(pts);
  for (const f of [0.5137, 0.3719, 0.6841, 0.2113, 0.8327]) {
    const y = b.y0 + (b.y1 - b.y0) * f;
    const xs = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i]; const [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y)) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
    }
    xs.sort((p, q) => p - q);
    if (xs.length >= 2 && xs[1] - xs[0] > 1e-6) return [(xs[0] + xs[1]) / 2, y];
  }
  return centroidOf(pts);
}
/** A closed ring as an open list of distinct corners, counter-clockwise. */
function cleanRing(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > 1e-7 || Math.abs(q[1] - p[1]) > 1e-7) out.push([p[0], p[1]]);
  }
  while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) <= 1e-7 && Math.abs(out[0][1] - out[out.length - 1][1]) <= 1e-7) out.pop();
  if (out.length >= 3 && signedArea(out) < 0) out.reverse();
  return out;
}
/** A ring that is a circle (as CAD or we flatten one): { cx, cy, r }, else null. */
function circleOf(pts) {
  if (pts.length < 12) return null;
  const [cx, cy] = centroidOf(pts);
  let lo = Infinity; let hi = 0;
  for (const [x, y] of pts) { const d = Math.hypot(x - cx, y - cy); if (d < lo) lo = d; if (d > hi) hi = d; }
  return hi - lo <= Math.max(0.15, 0.002 * hi) ? { cx, cy, r: (hi + lo) / 2 } : null;   // 0.15: corners rounded to 0.1 mm
}
function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  const up = [];
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop();
  return lo.concat(up);
}
/** The smallest rectangle round a ring at any angle: { angleDeg (of side a), a, b, corners }. */
function minRect(pts) {
  const hull = convexHull(pts);
  let best = null;
  for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) {
    const dx = hull[i][0] - hull[j][0]; const dy = hull[i][1] - hull[j][1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const ux = dx / len; const uy = dy / len;
    let s0 = Infinity; let s1 = -Infinity; let t0 = Infinity; let t1 = -Infinity;
    for (const [x, y] of hull) {
      const s = x * ux + y * uy; const t = -x * uy + y * ux;
      if (s < s0) s0 = s; if (s > s1) s1 = s; if (t < t0) t0 = t; if (t > t1) t1 = t;
    }
    const area = (s1 - s0) * (t1 - t0);
    if (!best || area < best.area - 1e-6) {
      const at = (s, t) => [s * ux - t * uy, s * uy + t * ux];
      best = { area, angleDeg: Math.atan2(uy, ux) / RAD, a: s1 - s0, b: t1 - t0, corners: [at(s0, t0), at(s1, t0), at(s1, t1), at(s0, t1)] };
    }
  }
  return best ?? { area: 0, angleDeg: 0, a: 0, b: 0, corners: pts.slice(0, 4) };
}

/* ───────────────────────────── the placement convention ───────────────────────────── */

/** Rings as a list [outline, …inner] of open corner lists, whichever way they were given. */
function ringList(rings) {
  if (!rings) return [];
  const list = Array.isArray(rings) ? rings : [rings.outline, ...(rings.cutouts ?? []), ...(rings.holes ?? [])];
  return list.filter((r) => Array.isArray(r) && r.length >= 3).map((r) => {
    const a = r[0]; const z = r[r.length - 1];
    return (Math.abs(a[0] - z[0]) <= 1e-9 && Math.abs(a[1] - z[1]) <= 1e-9 ? r.slice(0, -1) : r).map(([x, y]) => [Number(x), Number(y)]);
  });
}
const mapRings = (rings, f) => (Array.isArray(rings)
  ? rings.map((r) => r.map(f))
  : { outline: (rings.outline ?? []).map(f), cutouts: (rings.cutouts ?? []).map((r) => r.map(f)), holes: (rings.holes ?? []).map((r) => r.map(f)) });

/** The rectangle length × width as rings. */
export const rectRings = (length, width) => [[[0, 0], [Number(length), 0], [Number(length), Number(width)], [0, Number(width)]]];

/** A candidate's rings: its drawing, else the rectangle length × width. */
export const candidateRings = (c) => (ringList(c?.rings).length ? c.rings : rectRings(c.length, c.width));

/**
 * THE PLACEMENT CONVENTION, exactly: normalise the rings so the bounding box's min corner is
 * (0,0); mirror about the y axis when `mirrored`; rotate counter-clockwise by `rotationDeg` about
 * the origin; normalise the bounding box's min corner to (0,0) again; move by (x, y). So (x, y)
 * is the placed bounding box's min corner. Rings come back in the form they were given
 * ([outline, …] or { outline, cutouts, holes }).
 */
export function placeRings(rings, { x = 0, y = 0, rotationDeg = 0, mirrored = false } = {}) {
  const b0 = boxOfRings(ringList(rings));
  const t = Number(rotationDeg) * RAD;
  // Quarter turns are exact, so a part turned 90° lands on whole numbers.
  const q = Math.round(Number(rotationDeg) / 90);
  const exact = Math.abs(Number(rotationDeg) - q * 90) < 1e-9;
  const cos = exact ? [1, 0, -1, 0][((q % 4) + 4) % 4] : Math.cos(t);
  const sin = exact ? [0, 1, 0, -1][((q % 4) + 4) % 4] : Math.sin(t);
  const turned = mapRings(rings, ([px, py]) => {
    const nx = (px - b0.x0) * (mirrored ? -1 : 1); const ny = py - b0.y0;
    return [nx * cos - ny * sin, nx * sin + ny * cos];
  });
  const b1 = boxOfRings(ringList(turned));
  return mapRings(turned, ([px, py]) => [px - b1.x0 + Number(x), py - b1.y0 + Number(y)]);
}

/**
 * How far two sets of rings are from being the same drawing: the furthest any corner of one is
 * from the boundary of the other (both ways, ring against its nearest ring). Infinity when one
 * has a ring the other has not.
 */
export function ringsDeviation(a, b) {
  const A = ringList(a); const Bq = ringList(b);
  if (A.length !== Bq.length || !A.length) return Infinity;
  return deviation(A, Bq, Infinity);
}

/** Furthest corner-to-boundary distance, outline to outline and each inner ring to its nearest; stops past `limit`. */
function deviation(A, Bq, limit, cA = null, cB = null, rA = null, rB = null) {
  const pairs = [[A[0], Bq[0]]];
  let worst = 0;
  if (A.length > 1) {
    const ca = cA ?? A.slice(1).map(centroidOf); const cb = cB ?? Bq.slice(1).map(centroidOf);
    const used = new Array(cb.length).fill(false);
    for (let i = 0; i < ca.length; i++) {
      let best = -1; let bd = Infinity;
      for (let j = 0; j < cb.length; j++) {
        if (used[j]) continue;
        const d = Math.hypot(ca[i][0] - cb[j][0], ca[i][1] - cb[j][1]);
        if (d < bd) { bd = d; best = j; }
      }
      if (best < 0) return Infinity;
      used[best] = true;
      // Two round holes: centre against centre and radius against radius (72 corners each would say the same, slowly).
      if (rA?.[i] != null && rB?.[best] != null) { worst = Math.max(worst, bd + Math.abs(rA[i] - rB[best])); if (worst > limit) return worst; continue; }
      pairs.push([A[i + 1], Bq[best + 1]]);
    }
  }
  for (const [p, q] of pairs) {
    for (const v of p) { const d = distToRing(v, q); if (d > worst) { worst = d; if (worst > limit) return worst; } }
    for (const v of q) { const d = distToRing(v, p); if (d > worst) { worst = d; if (worst > limit) return worst; } }
  }
  return worst;
}

/* ───────────────────────────── reading the DXF ───────────────────────────── */

function toText(input) {
  if (input == null) throw invalid('BAD_FILE', 'There is no file to read.');
  let text;
  if (typeof input === 'string') text = input;
  else if (input instanceof Uint8Array) {
    if (input.length > MAX_CHARS) throw invalid('TOO_BIG', 'That file is more than this reads in one go — a nesting DXF is one plate.');
    const head = input.subarray(0, 4096);
    if (head.includes(0)) {
      const s = Buffer.from(head).toString('latin1');
      if (/^AC10\d\d/.test(s)) throw invalid('BAD_FILE', 'This is a DWG file — export the nest from the nesting program as a DXF.');
      if (/^AutoCAD Binary DXF/.test(s)) throw invalid('BAD_FILE', 'This is a binary DXF — save it as an ASCII (text) DXF.');
      throw invalid('BAD_FILE', 'This does not read as a DXF file.');
    }
    text = Buffer.from(input).toString('utf8');
  } else throw invalid('BAD_FILE', 'This does not read as a DXF file.');
  if (text.length > MAX_CHARS) throw invalid('TOO_BIG', 'That file is more than this reads in one go — a nesting DXF is one plate.');
  const head = text.slice(0, 64).replace(/^﻿/, '');
  if (/^AutoCAD Binary DXF/.test(head)) throw invalid('BAD_FILE', 'This is a binary DXF — save it as an ASCII (text) DXF.');
  if (/^AC10\d\d/.test(head)) throw invalid('BAD_FILE', 'This is a DWG file — export the nest from the nesting program as a DXF.');
  if (text.slice(0, 4096).includes('\u0000') || !/(^|\n)\s*0\s*\r?\n\s*SECTION/.test(text)) throw invalid('BAD_FILE', 'This does not read as a DXF file.');
  return text;
}

function pairsOf(text) {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([Number(lines[i].trim()), lines[i + 1].trim()]);
  return out;
}

/** { units, entities, blocks: Map(name → { base, entities }) } — an entity is { type, layer, codes }. */
function readSections(pairs) {
  let units = null;
  const entities = [];
  const blocks = new Map();
  let section = null;
  let block = null;
  for (let i = 0; i < pairs.length; i++) {
    const [c, v] = pairs[i];
    if (c === 0 && v === 'SECTION') { section = pairs[i + 1]?.[1] ?? null; i++; continue; }
    if (c === 0 && v === 'ENDSEC') { section = null; block = null; continue; }
    if (section === 'HEADER' && c === 9 && v === '$INSUNITS') { units = Number(pairs[i + 1]?.[1]) || 0; i++; continue; }
    if ((section === 'ENTITIES' || section === 'BLOCKS') && c === 0) {
      const e = { type: v, layer: '0', codes: [] };
      let j = i + 1;
      for (; j < pairs.length && pairs[j][0] !== 0; j++) {
        if (pairs[j][0] === 8) e.layer = pairs[j][1];
        else if (pairs[j][0] === 62) e.color = Number(pairs[j][1]);
        e.codes.push(pairs[j]);
      }
      i = j - 1;
      if (section === 'ENTITIES') entities.push(e);
      else if (v === 'BLOCK') {
        block = { name: str(e.codes, 2), base: [num(e.codes, 10), num(e.codes, 20)], entities: [] };
        if (block.name) blocks.set(block.name.toUpperCase(), block);
      } else if (v === 'ENDBLK') block = null;
      else if (block) block.entities.push(e);
    }
  }
  return { units, entities, blocks };
}

const num = (codes, code, dflt = 0) => { for (const p of codes) if (p[0] === code) { const n = Number(p[1]); return Number.isFinite(n) ? n : dflt; } return dflt; };
const str = (codes, code, dflt = '') => { for (const p of codes) if (p[0] === code) return p[1]; return dflt; };
const has = (codes, code) => codes.some((p) => p[0] === code);

/* An affine map [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const compose = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const FLIP = [-1, 0, 0, 1, 0, 0];

function arcPoints(cx, cy, r, a0, a1) {
  let sweep = a1 - a0;
  if (sweep <= 0) sweep += 360;
  const n = Math.max(2, Math.ceil(sweep / ARC_STEP_DEG));
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const t = (a0 + (sweep * k) / n) * RAD;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return pts;
}
function bulgePoints(p, q, bulge) {
  const chord = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (!bulge || chord < 1e-12) return [p, q];
  const theta = 4 * Math.atan(bulge);
  const r = (chord * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
  const d = (chord * (1 - bulge * bulge)) / (4 * bulge);
  const cx = (p[0] + q[0]) / 2 - ((q[1] - p[1]) / chord) * d;
  const cy = (p[1] + q[1]) / 2 + ((q[0] - p[0]) / chord) * d;
  const a0 = Math.atan2(p[1] - cy, p[0] - cx);
  const n = Math.max(2, Math.ceil((Math.abs(theta) / RAD) / ARC_STEP_DEG));
  const pts = [];
  for (let k = 0; k <= n; k++) { const t = a0 + (theta * k) / n; pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  pts[0] = p; pts[pts.length - 1] = q;
  return pts;
}

/** MTEXT without its formatting codes; paragraphs become lines. */
function plainMtext(s) {
  return s
    .replace(/\\P/g, '\n')
    .replace(/\\[ACFHQTWfacqhtw][^;\\]*;/g, '')
    .replace(/\\S([^;]*);/g, '$1')
    .replace(/\\[LlOoKk]/g, '')
    .replace(/\\~/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\\\\/g, '\\');
}

/**
 * Every entity, blocks opened out, as loose paths, closed rings and words — in file units × scale.
 */
function explode(dxf, scale, warnings, cautions = [], dropStyles = null) {
  const open = [];      // { pts, line, layer, chain, style }
  const closed = [];    // { pts, layer, chain, style }
  const texts = [];     // { text, at, alt, layer, chain }
  const stats = { skippedLayer: 0, pierce: 0, unknownBlocks: new Set(), tooDeep: false, splines: 0, splinesByControl: 0, count: 0, marking: 0, unread: new Map() };
  let instance = 0;
  /*
   * STYLE = the layer and the entity's own colour (group 62; by-layer and by-block count as none):
   * what a nesting program tells a cut from a marking by when both are drawn on the plate.
   */
  let style = '0|';

  const bump = () => { if (++stats.count > MAX_PRIMITIVES) throw invalid('TOO_BIG', 'That file holds more shapes than one plate can — is it one nest per file?'); };
  const path = (m, pts, layer, chain, line = false) => {
    if (pts.length < 2) return;
    bump();
    open.push({ pts: pts.map((p) => apply(m, p)), line, layer, chain, style });
  };
  const ring = (m, pts, layer, chain) => { bump(); closed.push({ pts: pts.map((p) => apply(m, p)), layer, chain, style }); };
  const poly = (m, verts, isClosed, layer, chain) => {
    if (verts.length < 2) return;
    const n = verts.length;
    if (isClosed && n >= 2) {
      const pts = [];
      for (let k = 0; k < n; k++) { const seg = bulgePoints(verts[k].p, verts[(k + 1) % n].p, verts[k].bulge); pts.push(...seg.slice(0, -1)); }
      ring(m, pts, layer, chain);
      return;
    }
    for (let k = 0; k < n - 1; k++) {
      const seg = bulgePoints(verts[k].p, verts[k + 1].p, verts[k].bulge);
      path(m, seg, layer, chain, !verts[k].bulge);
    }
  };

  const walk = (list, m0, inheritLayer, chain, depth) => {
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const c = e.codes;
      const layer = e.layer === '0' && inheritLayer != null ? inheritLayer : e.layer;
      const m = num(c, 230, 1) < 0 ? compose(m0, FLIP) : m0;
      const isText = e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'ATTRIB';
      if (!isText && e.type !== 'INSERT' && SKIP_LAYER.test(layer)) {
        if (e.type !== 'VERTEX' && e.type !== 'SEQEND') stats.skippedLayer++;
        continue;
      }
      style = `${layer}|${e.color == null || e.color === 256 || e.color === 0 ? '' : e.color}`;
      // A style the caller says is marking (readNestDxf `markingStyles`): not a cut, so not read as one.
      if (!isText && e.type !== 'INSERT' && dropStyles?.has(style)) {
        if (e.type !== 'VERTEX' && e.type !== 'SEQEND') stats.marking++;
        continue;
      }
      switch (e.type) {
        case 'LINE':
          path(m, [[num(c, 10), num(c, 20)], [num(c, 11), num(c, 21)]], layer, chain, true);
          break;
        case 'ARC':
          path(m, arcPoints(num(c, 10), num(c, 20), num(c, 40), num(c, 50), num(c, 51)), layer, chain);
          break;
        case 'CIRCLE': {
          const r = num(c, 40);
          if (2 * r * scale <= PIERCE_MAX_DIA) { stats.pierce++; break; }
          ring(m, arcPoints(num(c, 10), num(c, 20), r, 0, 360).slice(0, -1), layer, chain);
          break;
        }
        case 'POINT':
          stats.pierce++;
          break;
        case 'LWPOLYLINE': {
          const verts = [];
          for (const [code, v] of c) {
            if (code === 10) verts.push({ p: [Number(v), 0], bulge: 0 });
            else if (code === 20 && verts.length) verts[verts.length - 1].p[1] = Number(v);
            else if (code === 42 && verts.length) verts[verts.length - 1].bulge = Number(v);
          }
          poly(m, verts, (num(c, 70) & 1) === 1, layer, chain);
          break;
        }
        case 'POLYLINE': {
          const verts = [];
          let j = i + 1;
          for (; j < list.length && list[j].type === 'VERTEX'; j++) verts.push({ p: [num(list[j].codes, 10), num(list[j].codes, 20)], bulge: num(list[j].codes, 42) });
          if (list[j]?.type === 'SEQEND') j++;
          i = j - 1;
          poly(m, verts, (num(c, 70) & 1) === 1, layer, chain);
          break;
        }
        case 'ELLIPSE': {
          const cx = num(c, 10); const cy = num(c, 20);
          const mx = num(c, 11); const my = num(c, 21);
          const ratio = num(c, 40, 1);
          const t0 = num(c, 41, 0); let t1 = num(c, 42, 2 * Math.PI);
          if (t1 <= t0) t1 += 2 * Math.PI;
          const a = Math.hypot(mx, my); const rot = Math.atan2(my, mx);
          const n = Math.max(8, Math.ceil(((t1 - t0) / RAD) / ARC_STEP_DEG));
          const pts = [];
          for (let k = 0; k <= n; k++) {
            const t = t0 + ((t1 - t0) * k) / n;
            const x = a * Math.cos(t); const y = a * ratio * Math.sin(t);
            pts.push([cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]);
          }
          if (Math.abs(t1 - t0 - 2 * Math.PI) < 1e-6) ring(m, pts.slice(0, -1), layer, chain);
          else path(m, pts, layer, chain);
          break;
        }
        case 'SPLINE': {
          const fit = []; const ctrl = [];
          for (let k = 0; k < c.length; k++) {
            if (c[k][0] === 11) fit.push([Number(c[k][1]), Number(c.find((x, q) => q > k && x[0] === 21)?.[1] ?? 0)]);
            if (c[k][0] === 10) ctrl.push([Number(c[k][1]), Number(c.find((x, q) => q > k && x[0] === 20)?.[1] ?? 0)]);
          }
          const pts = fit.length >= 2 ? fit : ctrl;
          if (pts.length < 2) break;
          stats.splines++;
          if (fit.length < 2) stats.splinesByControl++;
          if ((num(c, 70) & 1) === 1 && pts.length > 2) ring(m, pts, layer, chain);
          else path(m, pts, layer, chain);
          break;
        }
        case 'TEXT': case 'ATTRIB': case 'MTEXT': {
          let s = e.type === 'MTEXT' ? plainMtext(c.filter((p) => p[0] === 3).map((p) => p[1]).join('') + str(c, 1)) : str(c, 1);
          s = s.replace(/%%[cdpCDP]/g, '').trim();
          if (!s) break;
          const aligned = e.type !== 'MTEXT' && (num(c, 72) !== 0 || num(c, e.type === 'ATTRIB' ? 74 : 73) !== 0) && has(c, 11);
          const p = aligned ? [num(c, 11), num(c, 21)] : [num(c, 10), num(c, 20)];
          const h = num(c, 40, 0); const rot = num(c, 50, 0) * RAD;
          // Where the middle of the words roughly is, for a label that starts just outside its part.
          const first = s.split('\n')[0];
          const alt = aligned || e.type === 'MTEXT' ? p : [p[0] + Math.cos(rot) * 0.35 * h * first.length - Math.sin(rot) * 0.5 * h, p[1] + Math.sin(rot) * 0.35 * h * first.length + Math.cos(rot) * 0.5 * h];
          texts.push({ text: s, at: apply(m, p), alt: apply(m, alt), layer, chain });
          break;
        }
        case 'INSERT': {
          const name = str(c, 2);
          // Its attributes follow it, up to SEQEND; they are read as words by the loop itself.
          const block = dxf.blocks.get(name.toUpperCase());
          if (!block) { stats.unknownBlocks.add(name); break; }
          if (depth >= MAX_BLOCK_DEPTH) { stats.tooDeep = true; break; }
          const sx = num(c, 41, 1); const sy = num(c, 42, 1);
          const rot = num(c, 50, 0) * RAD;
          const cos = Math.cos(rot); const sin = Math.sin(rot);
          const cols = Math.max(1, num(c, 70, 1)); const rows = Math.max(1, num(c, 71, 1));
          const dx = num(c, 44, 0); const dy = num(c, 45, 0);
          const ix = num(c, 10); const iy = num(c, 20);
          for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
              const ox = col * dx; const oy = row * dy;
              // ins + R·(S·(p − base) + array offset)
              const local = [
                cos * sx, sin * sx, -sin * sy, cos * sy,
                ix + cos * (ox - sx * block.base[0]) - sin * (oy - sy * block.base[1]),
                iy + sin * (ox - sx * block.base[0]) + cos * (oy - sy * block.base[1]),
              ];
              const anonymous = !name || name.startsWith('*');
              walk(block.entities, compose(m, local), layer, [...chain, { id: ++instance, name: anonymous ? null : name }], depth + 1);
            }
          }
          break;
        }
        default:
          if (UNREAD_SHAPES.has(e.type)) stats.unread.set(e.type, (stats.unread.get(e.type) ?? 0) + 1);
          break;
      }
    }
  };
  walk(dxf.entities, [scale, 0, 0, scale, 0, 0], null, [], 0);

  if (stats.skippedLayer) warnings.push(`${plural(stats.skippedLayer, 'item', 'items')} on dimension, border, lead-in or rapid-move layers ignored.`);
  if (stats.pierce) warnings.push(`${plural(stats.pierce, 'pierce mark', 'pierce marks')} ignored.`);
  if (stats.marking) warnings.push(`${plural(stats.marking, 'line', 'lines')} drawn in a marking colour or layer read as marking, not as cuts.`);
  if (stats.splines - stats.splinesByControl) warnings.push(`${plural(stats.splines - stats.splinesByControl, 'curve (spline) was', 'curves (splines) were')} read through their points — their shape is approximate.`);
  // What could have been a part and was not read is never only a note: these need the user's eye.
  if (stats.splinesByControl) cautions.push({ code: 'CURVE_APPROXIMATE', message: `${plural(stats.splinesByControl, 'curve is a spline', 'curves are splines')} given only by control points, which this reads as straight runs between those points — the outline is approximate, several mm off on a tight curve. Export the nest with its curves as arcs or polylines, or save anyway.` });
  for (const n of stats.unknownBlocks) cautions.push({ code: 'SHAPE_IGNORED', message: `the file places a block called "${n}" that it does not define — whatever is in it (a part, perhaps) is missing. Export the nest again with its blocks, or save anyway.` });
  if (stats.tooDeep) cautions.push({ code: 'SHAPE_IGNORED', message: 'blocks inside blocks deeper than this reads were left out — a part may be missing. Explode the blocks in the nesting program and export again, or save anyway.' });
  if (stats.unread.size) {
    const total = [...stats.unread.values()].reduce((a, q) => a + q, 0);
    cautions.push({ code: 'SHAPE_IGNORED', message: `the file holds ${[...stats.unread].map(([k, q]) => `${q} ${k}`).join(', ')} ${total === 1 ? 'item' : 'items'} — filled areas and solids, which this does not read. A part drawn only that way is missing. Export outlines as lines or polylines, or save anyway.` });
  }
  return { open, closed, texts };
}

/* ───────────────────────────── loose lines → closed loops ───────────────────────────── */

/**
 * The closed loops a set of loose paths makes: the faces of their graph, after the paths on no
 * closed path are dropped. Returns { loops: [{ pts, layer, chain }], strays }.
 */
function loopsFromPaths(paths, tol, gapTol = 0) {
  const loops = [];
  if (!paths.length) return { loops, strays: 0, chains: [], closedGaps: [], splitStyles: [] };

  // 1. Ends that are one point.
  const nodes = [];
  const grid = new Map();
  const g = tol * 2;
  const nodeAt = (p) => {
    const gx = Math.floor(p[0] / g); const gy = Math.floor(p[1] / g);
    for (let i = gx - 1; i <= gx + 1; i++) {
      for (let j = gy - 1; j <= gy + 1; j++) {
        const cell = grid.get(`${i},${j}`);
        if (!cell) continue;
        for (const id of cell) if (Math.abs(nodes[id][0] - p[0]) <= tol && Math.abs(nodes[id][1] - p[1]) <= tol) return id;
      }
    }
    const id = nodes.length;
    nodes.push([p[0], p[1]]);
    const key = `${gx},${gy}`;
    const cell = grid.get(key);
    if (cell) cell.push(id); else grid.set(key, [id]);
    return id;
  };
  const edges = [];
  for (const s of paths) {
    const a = s.pts[0]; const z = s.pts[s.pts.length - 1];
    if (s.pts.length >= 4 && Math.abs(a[0] - z[0]) <= tol && Math.abs(a[1] - z[1]) <= tol) { loops.push({ pts: s.pts.slice(0, -1), layer: s.layer, chain: s.chain, style: s.style }); continue; }
    edges.push({ u: nodeAt(a), v: nodeAt(z), pts: s.pts, line: s.line && s.pts.length === 2, layer: s.layer, chain: s.chain, style: s.style });
  }

  // 2. A straight line is cut wherever a node lies on it (a T of a common cut, a lead-in, a crossing);
  //    3. the same cut drawn twice is one cut.
  const tidy = (list) => {
    const byX = nodes.map((p, id) => id).sort((p, q) => nodes[p][0] - nodes[q][0]);
    const xs = byX.map((id) => nodes[id][0]);
    const lowerBound = (x) => { let lo = 0; let hi = xs.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] < x) lo = mid + 1; else hi = mid; } return lo; };
    const split = [];
    for (const e of list) {
      if (!e.line) { split.push(e); continue; }
      const p = nodes[e.u]; const q = nodes[e.v];
      const dx = q[0] - p[0]; const dy = q[1] - p[1];
      const len = Math.hypot(dx, dy);
      if (len <= tol) continue;
      const y0 = Math.min(p[1], q[1]) - tol; const y1 = Math.max(p[1], q[1]) + tol;
      const x1 = Math.max(p[0], q[0]) + tol;
      const on = [];
      for (let k = lowerBound(Math.min(p[0], q[0]) - tol); k < xs.length && xs[k] <= x1; k++) {
        const id = byX[k];
        if (id === e.u || id === e.v) continue;
        const n = nodes[id];
        if (n[1] < y0 || n[1] > y1) continue;
        const t = ((n[0] - p[0]) * dx + (n[1] - p[1]) * dy) / len;          // distance along
        if (t <= tol || t >= len - tol) continue;
        if (Math.abs((n[0] - p[0]) * dy - (n[1] - p[1]) * dx) / len > tol) continue;
        on.push({ id, t });
      }
      if (!on.length) { split.push(e); continue; }
      on.sort((a, b) => a.t - b.t);
      let prev = e.u;
      for (const o of [...on, { id: e.v }]) {
        if (o.id !== prev) split.push({ u: prev, v: o.id, pts: [nodes[prev], nodes[o.id]], line: true, layer: e.layer, chain: e.chain, style: e.style });
        prev = o.id;
      }
    }
    const seen = new Set();
    const out = [];
    for (const e of split) {
      if (e.u === e.v) continue;
      const mid = e.line ? [(nodes[e.u][0] + nodes[e.v][0]) / 2, (nodes[e.u][1] + nodes[e.v][1]) / 2] : midOfPath(e.pts);
      const key = `${Math.min(e.u, e.v)}|${Math.max(e.u, e.v)}|${Math.round(mid[0] / (tol * 2))}|${Math.round(mid[1] / (tol * 2))}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
    return out;
  };

  // 4. Drop every edge that is on no closed path (a bridge of the graph): lead-ins, rapid moves.
  const closedOnly = (list) => {
    const adj = nodes.map(() => []);
    list.forEach((e, i) => { adj[e.u].push([i, e.v]); adj[e.v].push([i, e.u]); });
    const disc = new Int32Array(nodes.length).fill(-1);
    const low = new Int32Array(nodes.length);
    const bridge = new Uint8Array(list.length);
    let clock = 0;
    for (let root = 0; root < nodes.length; root++) {
      if (disc[root] !== -1 || !adj[root].length) continue;
      const stack = [[root, -1, 0]];
      disc[root] = low[root] = clock++;
      while (stack.length) {
        const top = stack[stack.length - 1];
        const [u, via] = top;
        if (top[2] < adj[u].length) {
          const [ei, v] = adj[u][top[2]++];
          if (ei === via) continue;
          if (disc[v] === -1) { disc[v] = low[v] = clock++; stack.push([v, ei, 0]); }
          else if (disc[v] < low[u]) low[u] = disc[v];
        } else {
          stack.pop();
          if (stack.length) {
            const parent = stack[stack.length - 1][0];
            if (low[u] < low[parent]) low[parent] = low[u];
            if (low[u] > disc[parent]) bridge[via] = 1;
          }
        }
      }
    }
    return list.filter((e, i) => !bridge[i]);
  };

  /**
   * 5. COMMON CUTS THAT CROSS: one long cut across another with no end at the crossing (a 2 × 2
   * block of parts is drawn as a rim and a cross). A node is made at every true crossing of two
   * straight cuts of the SAME connected drawing — never between two separate contours, so a part
   * lying across the plate's edge stays one part. Lines are looked up through a grid, not pairwise.
   */
  const crossings = (list) => {
    const comp = nodes.map((p, i) => i);
    const find = (x) => { while (comp[x] !== x) { comp[x] = comp[comp[x]]; x = comp[x]; } return x; };
    for (const e of list) { const a = find(e.u); const b = find(e.v); if (a !== b) comp[a] = b; }
    const lines = list.filter((e) => e.line);
    if (lines.length < 2) return 0;
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const e of lines) for (const n of [nodes[e.u], nodes[e.v]]) { if (n[0] < x0) x0 = n[0]; if (n[0] > x1) x1 = n[0]; if (n[1] < y0) y0 = n[1]; if (n[1] > y1) y1 = n[1]; }
    const c = Math.max(20 * tol, Math.max(x1 - x0, y1 - y0) / 256, 1);
    const K = 4096;
    const cells = new Map();
    const put = (ix, iy, e) => { const k = (ix + 8) * K + iy + 8; const cell = cells.get(k); if (cell) cell.push(e); else cells.set(k, [e]); };
    for (const e of lines) {
      const p = nodes[e.u]; const q = nodes[e.v];
      const [a, b] = p[0] <= q[0] ? [p, q] : [q, p];
      const steep = b[0] - a[0] <= 1e-12;
      const slope = steep ? 0 : (b[1] - a[1]) / (b[0] - a[0]);
      const i0 = Math.floor((a[0] - x0 - tol) / c); const i1 = Math.floor((b[0] - x0 + tol) / c);
      for (let ix = i0; ix <= i1; ix++) {
        // The stretch of the line inside this column of cells, and the rows it passes through.
        const xa = Math.max(a[0], x0 + ix * c - tol); const xb = Math.min(b[0], x0 + (ix + 1) * c + tol);
        const ya = steep ? a[1] : a[1] + slope * (xa - a[0]);
        const yb = steep ? b[1] : a[1] + slope * (xb - a[0]);
        const j0 = Math.floor((Math.min(ya, yb) - y0 - tol) / c); const j1 = Math.floor((Math.max(ya, yb) - y0 + tol) / c);
        for (let iy = j0; iy <= j1; iy++) put(ix, iy, e);
      }
    }
    let made = 0;
    for (const cell of cells.values()) {
      if (cell.length < 2) continue;
      for (let i = 0; i < cell.length; i++) {
        const e = cell[i];
        const p = nodes[e.u]; const q = nodes[e.v];
        const rx = q[0] - p[0]; const ry = q[1] - p[1];
        const rl = Math.hypot(rx, ry);
        for (let j = i + 1; j < cell.length; j++) {
          const f = cell[j];
          if (e.u === f.u || e.u === f.v || e.v === f.u || e.v === f.v || find(e.u) !== find(f.u)) continue;
          const a = nodes[f.u]; const b = nodes[f.v];
          const sx = b[0] - a[0]; const sy = b[1] - a[1];
          const den = rx * sy - ry * sx;
          const sl = Math.hypot(sx, sy);
          if (Math.abs(den) < 1e-9 * rl * sl) continue;                       // parallel
          const t = ((a[0] - p[0]) * sy - (a[1] - p[1]) * sx) / den;
          const w = ((a[0] - p[0]) * ry - (a[1] - p[1]) * rx) / den;
          // Strictly inside both: an end ON the other line is a T, which the split already handles.
          if (t * rl <= tol || (1 - t) * rl <= tol || w * sl <= tol || (1 - w) * sl <= tol) continue;
          const before = nodes.length;
          nodeAt([p[0] + t * rx, p[1] + t * ry]);
          if (nodes.length > before) made++;
        }
      }
    }
    return made;
  };

  /**
   * 3b. GAPS (see GAP_CLOSE_MM): two loose ends — nodes only one line reaches — that are a sloppy
   * corner or a tab apart are joined by a straight cut. Nearest pairs first, each end once.
   * Returns the joins made: [{ edge, gap, at }].
   */
  const closeGaps = (list) => {
    const deg = new Int32Array(nodes.length);
    const dir = new Array(nodes.length);
    for (const e of list) {
      const p = e.pts; const n = p.length;
      deg[e.u]++; deg[e.v]++;
      dir[e.u] = [p[0][0] - p[1][0], p[0][1] - p[1][1]];                  // the way the line would carry on past its end
      dir[e.v] = [p[n - 1][0] - p[n - 2][0], p[n - 1][1] - p[n - 2][1]];
    }
    const loose = [];
    for (let id = 0; id < nodes.length; id++) if (deg[id] === 1) loose.push(id);
    if (loose.length < 2) return [];
    const cell = new Map();
    const key = (p) => `${Math.floor(p[0] / gapTol)},${Math.floor(p[1] / gapTol)}`;
    for (const id of loose) { const k = key(nodes[id]); if (cell.has(k)) cell.get(k).push(id); else cell.set(k, [id]); }
    const pairs = [];
    for (const a of loose) {
      const gx = Math.floor(nodes[a][0] / gapTol); const gy = Math.floor(nodes[a][1] / gapTol);
      for (let i = gx - 1; i <= gx + 1; i++) {
        for (let j = gy - 1; j <= gy + 1; j++) {
          for (const b of cell.get(`${i},${j}`) ?? []) {
            if (b <= a) continue;
            const d = Math.hypot(nodes[b][0] - nodes[a][0], nodes[b][1] - nodes[a][1]);
            if (d <= gapTol) pairs.push({ a, b, d });
          }
        }
      }
    }
    pairs.sort((p, q) => p.d - q.d);
    const used = new Set();
    const made = [];
    for (const { a, b, d } of pairs) {
      if (used.has(a) || used.has(b) || d < 1e-9) continue;
      if (d > CORNER_GAP_MM) {
        const ux = (nodes[b][0] - nodes[a][0]) / d; const uy = (nodes[b][1] - nodes[a][1]) / d;
        const la = Math.hypot(dir[a][0], dir[a][1]) || 1; const lb = Math.hypot(dir[b][0], dir[b][1]) || 1;
        if ((dir[a][0] * ux + dir[a][1] * uy) / la < FACING_COS || (-dir[b][0] * ux - dir[b][1] * uy) / lb < FACING_COS) continue;
      }
      used.add(a); used.add(b);
      const edge = { u: a, v: b, pts: [nodes[a], nodes[b]], line: true, layer: list.find((e) => e.u === a || e.v === a).layer, chain: [], style: null, closing: true };
      made.push({ edge, gap: d, at: [(nodes[a][0] + nodes[b][0]) / 2, (nodes[a][1] + nodes[b][1]) / 2] });
    }
    return made;
  };

  const first = tidy(edges);
  const joins = gapTol > tol ? closeGaps(first) : [];
  for (const j of joins) { const near = first.find((e) => e.u === j.edge.u || e.v === j.edge.u); j.edge.chain = near.chain; j.edge.style = near.style; first.push(j.edge); }
  let live = closedOnly(first);
  let kept = new Set(live);
  const dropped = first.filter((e) => !kept.has(e));
  if (crossings(live)) {
    const again = tidy(live);
    live = closedOnly(again);
    kept = new Set(live);
    for (const e of again) if (!kept.has(e)) dropped.push(e);
  }
  // A join that closed nothing (its chain is still on no closed path) was not a gap in an outline.
  const closedGaps = joins.filter((j) => !dropped.includes(j.edge)).map((j) => ({ gap: j.gap, at: j.at }));
  const stray = dropped.filter((e) => !e.closing);
  const strays = stray.length;

  /**
   * 4b. WHAT WAS DROPPED, as chains: the dropped lines that hang together. Each says whether it
   * is one plain run from end to end touching nothing that was kept (`simple` — the shape of an
   * outline left open, as against a lead-in, which hangs off a contour, or a dimension, which
   * branches), its ends, its length and points to probe where it lies.
   */
  const chains = [];
  if (stray.length) {
    const liveNode = new Uint8Array(nodes.length);
    for (const e of live) { liveNode[e.u] = 1; liveNode[e.v] = 1; }
    const comp = new Map();
    const find = (x) => { let r = x; while (comp.get(r) !== r) r = comp.get(r); comp.set(x, r); return r; };
    for (const e of stray) { for (const id of [e.u, e.v]) if (!comp.has(id)) comp.set(id, id); const a = find(e.u); const b = find(e.v); if (a !== b) comp.set(a, b); }
    const groups = new Map();
    for (const e of stray) { const r = find(e.u); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(e); }
    const lenOf = (e) => { let s = 0; for (let k = 1; k < e.pts.length; k++) s += Math.hypot(e.pts[k][0] - e.pts[k - 1][0], e.pts[k][1] - e.pts[k - 1][1]); return s; };
    for (const list of groups.values()) {
      const deg = new Map();
      let length = 0; let segments = 0; let touchesLive = false;
      const styleLen = new Map();
      for (const e of list) {
        const l = lenOf(e);
        length += l; segments += e.pts.length - 1;
        styleLen.set(e.style, (styleLen.get(e.style) ?? 0) + l);
        for (const id of [e.u, e.v]) { deg.set(id, (deg.get(id) ?? 0) + 1); if (liveNode[id]) touchesLive = true; }
      }
      const ends = [...deg].filter(([, d]) => d === 1).map(([id]) => id);
      const simple = !touchesLive && ends.length === 2 && [...deg.values()].every((d) => d <= 2);
      let pts = null;
      if (simple) {
        // Walk it from one end to the other.
        const at = new Map();
        for (const e of list) for (const id of [e.u, e.v]) { if (!at.has(id)) at.set(id, []); at.get(id).push(e); }
        pts = [];
        let node = ends[0]; let via = null;
        for (let guard = list.length; guard-- > 0;) {
          const e = at.get(node).find((x) => x !== via);
          if (!e) break;
          const seq = e.u === node ? e.pts : e.pts.slice().reverse();
          for (let k = pts.length ? 1 : 0; k < seq.length; k++) pts.push(seq[k]);
          via = e; node = e.u === node ? e.v : e.u;
        }
      }
      // Probes: the middle of every straight run, and of long runs every 25 mm or so (at most ~200 a chain).
      const probes = [];
      const step = Math.max(25, length / 200);
      for (const e of list) {
        for (let k = 1; k < e.pts.length; k++) {
          const p = e.pts[k - 1]; const q = e.pts[k];
          const n = Math.max(1, Math.round(Math.hypot(q[0] - p[0], q[1] - p[1]) / step));
          for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; probes.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
        }
      }
      chains.push({
        lines: list.length, length, segments, simple, touchesLive, pts, probes,
        style: [...styleLen].sort((a, b) => b[1] - a[1])[0][0],
        ends: ends.length === 2 ? [nodes[ends[0]], nodes[ends[1]]] : null,
      });
    }
  }

  // 6. Faces: leave each node by the next edge clockwise from the one arrived on. Every bounded
  //    face is a loop; `shared` is the share of its boundary that is also another face's.
  const out = nodes.map(() => []);
  const angle = new Float64Array(live.length * 2);
  live.forEach((e, i) => {
    const p = e.pts; const n = p.length;
    angle[2 * i] = Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0]);
    angle[2 * i + 1] = Math.atan2(p[n - 2][1] - p[n - 1][1], p[n - 2][0] - p[n - 1][0]);
    out[e.u].push(2 * i); out[e.v].push(2 * i + 1);
  });
  const pos = new Int32Array(live.length * 2);
  for (const list of out) { list.sort((a, b) => angle[a] - angle[b]); list.forEach((h, k) => { pos[h] = k; }); }
  const faceOf = new Int32Array(live.length * 2).fill(-1);
  const visited = new Uint8Array(live.length * 2);
  const faces = [];
  for (let h0 = 0; h0 < live.length * 2; h0++) {
    if (visited[h0]) continue;
    const pts = [];
    const halves = [];
    let h = h0;
    let guard = live.length * 2 + 2;
    while (!visited[h] && guard-- > 0) {
      visited[h] = 1;
      halves.push(h);
      const e = live[h >> 1];
      const seq = (h & 1) ? e.pts.slice().reverse() : e.pts;
      for (let k = 0; k < seq.length - 1; k++) pts.push(seq[k]);
      const at = (h & 1) ? e.u : e.v;
      const list = out[at];
      h = list[(pos[h ^ 1] - 1 + list.length) % list.length];
    }
    if (pts.length >= 3 && signedArea(pts) > MIN_LOOP_AREA) {
      for (const x of halves) faceOf[x] = faces.length;
      const e = live[h0 >> 1];
      faces.push({ pts, layer: e.layer, chain: e.chain, halves });
    }
  }
  const lengthOf = (e) => { let s = 0; for (let k = 1; k < e.pts.length; k++) s += Math.hypot(e.pts[k][0] - e.pts[k - 1][0], e.pts[k][1] - e.pts[k - 1][1]); return s; };
  for (const fc of faces) {
    let all = 0; let both = 0;
    const styleLen = new Map();
    for (const x of fc.halves) { const e = live[x >> 1]; const l = lengthOf(e); all += l; if (faceOf[x ^ 1] !== -1) both += l; styleLen.set(e.style, (styleLen.get(e.style) ?? 0) + l); }
    // A face is drawn in the style most of its boundary is drawn in.
    fc.style = [...styleLen].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    loops.push({ pts: fc.pts, layer: fc.layer, chain: fc.chain, style: fc.style, shared: all > 0 ? both / all : 0 });
  }
  // A cut shared by two faces, drawn in a style that is neither face's own: it may be a MARKING line
  // from edge to edge of one part, not a cut between two (readNestDxf `splitStyles`).
  const splitStyles = new Set();
  live.forEach((e, i) => {
    const a = faceOf[2 * i]; const b = faceOf[2 * i + 1];
    if (a !== -1 && b !== -1 && a !== b && e.style != null && faces[a].style !== e.style && faces[b].style !== e.style) splitStyles.add(e.style);
  });
  return { loops, strays, chains, closedGaps, splitStyles: [...splitStyles] };
}
const midOfPath = (pts) => pts[pts.length >> 1];

/* ───────────────────────────── hints from words ───────────────────────────── */

const GRADE = /(?:^|[^A-Z0-9])((?:IS\s?2062\s*)?E\s?\d{3}\s?(?:BR|B0|BO|A|C)?|S\d{3}(?:J[R02]|K2|NL?|ML?)?(?:\+N)?|FE\s?\d{3}\s?[A-Z]{0,2}|A\d{2,3}\s?GR\.?\s?\d+|ASTM\s?A\d{2,3}|A36|SA\s?\d{3}\s?(?:GR\.?\s?\d+)?|Q\d{3}[A-E]?|HARDOX\s?\d{3}|SS\s?\d{3}L?|IS\s?2062)(?![A-Z0-9])/i;
const N = '(\\d+(?:\\.\\d+)?)';
const X = '\\s*(?:mm)?\\s*[x×*]\\s*';
const SIZE3 = new RegExp(`${N}${X}${N}${X}${N}`, 'i');
const SIZE2 = new RegExp(`${N}${X}${N}`, 'i');

function hintsFrom(strings, filename) {
  const h = { thicknessMm: null, grade: null, nestNo: null, plateSize: null };
  const read = (s) => {
    const three = s.match(SIZE3);
    if (three) {
      const v = three.slice(1, 4).map(Number).sort((a, b) => a - b);
      if (h.plateSize == null && v[1] >= 50) h.plateSize = { length: v[2], width: v[1] };
      if (h.thicknessMm == null && v[0] > 0 && v[0] <= 300 && v[1] >= 50) h.thicknessMm = v[0];
    } else if (h.plateSize == null) {
      const two = s.match(SIZE2);
      if (two) { const v = two.slice(1, 3).map(Number).sort((a, b) => a - b); if (v[0] >= 50) h.plateSize = { length: v[1], width: v[0] }; }
    }
    if (h.thicknessMm == null) {
      // A thickness is read from WORDS only in a form that says it is one: THK 12, 12 THK, T = 12, PL 12
      // (and the L x W x T size above). A bare "25 mm" is a dimension somebody left on the drawing.
      const t = s.match(/(?:THK|THICK(?:NESS)?)\s*[=:.]?\s*(\d+(?:\.\d+)?)/i) ?? s.match(/(\d+(?:\.\d+)?)\s*(?:mm)?\s*(?:THK|THICK)(?![a-z])/i)
        ?? s.match(/(?:^|[^A-Z0-9])T\s*[=:]\s*(\d+(?:\.\d+)?)/i) ?? s.match(/(?:^|[^A-Z0-9])PL\.?\s*(\d+(?:\.\d+)?)(?![0-9]*\s*[x×*])/i);
      if (t && Number(t[1]) > 0 && Number(t[1]) <= 300) h.thicknessMm = Number(t[1]);
      else {
        // …and "12 mm" as a field of its own in a title line of several fields (our own CNC export:
        // "Nest N-007 | Plate P | 12 mm | E350 | 3000 x 1000").
        const fields = s.split(/\s*[|;,]\s*/);
        const f = fields.length >= 2 ? fields.map((x) => x.trim().match(/^(\d+(?:\.\d+)?)\s*mm$/i)).find(Boolean) : null;
        if (f && Number(f[1]) > 0 && Number(f[1]) <= 300) h.thicknessMm = Number(f[1]);
      }
    }
    if (h.grade == null) { const m = s.match(GRADE); if (m) h.grade = m[1].replace(/\s+/g, ' ').trim().toUpperCase(); }
    if (h.nestNo == null) {
      const m = s.match(/(?:^|[^A-Z])(?:NEST|PROGRAM|PROGRAMME|PROG|PRG|LAYOUT)(?:\s*(?:NO|NUMBER|NAME|ID)\b\.?)?\s*[:=#\s]\s*#?\s*([A-Z0-9][A-Z0-9._\-/]*)/i);
      if (m && /\d/.test(m[1])) h.nestNo = m[1];
    }
  };
  for (const s of strings) for (const line of String(s).split('\n')) read(line);

  if (filename) {
    const base = String(filename).split(/[\\/]/).pop().replace(/\.[A-Za-z0-9]{1,5}$/, '');
    const left = [];
    for (const tok of base.split(/[_\s,;]+/).filter(Boolean)) {
      let m;
      if ((m = tok.match(/^(\d+(?:\.\d+)?)\s*(?:mm|thk|t)$/i)) || (m = tok.match(/^(?:t|thk)(\d+(?:\.\d+)?)$/i))) { if (h.thicknessMm == null) h.thicknessMm = Number(m[1]); continue; }
      if ((m = tok.match(/^(\d+(?:\.\d+)?)[x×](\d+(?:\.\d+)?)(?:[x×](\d+(?:\.\d+)?))?$/i))) {
        const v = m.slice(1).filter((q) => q != null).map(Number).sort((a, b) => a - b);
        if (h.plateSize == null) h.plateSize = { length: v[v.length - 1], width: v[v.length - 2] };
        if (v.length === 3 && h.thicknessMm == null) h.thicknessMm = v[0];
        continue;
      }
      m = tok.match(GRADE);
      if (m && m[1].length === tok.length) { if (h.grade == null) h.grade = tok.toUpperCase(); continue; }
      left.push(tok);
    }
    if (h.nestNo == null && left.length) h.nestNo = left.find((t) => /^(?:N|NEST|P|PRG|PROG)?[-#]?\d+[A-Z]?$/i.test(t)) ?? left[0];
  }
  return h;
}

/**
 * The thickness and grade a FILE NAME carries beside its mark or code: TFL1_25mm_E350.dxf,
 * L(1,5)-1-TFL1_t25.dxf. Tokens are set off by an underscore, a space, a comma or a semicolon —
 * OUTSIDE brackets, so the comma of L(1,5) is not one — and a token that reads as a thickness
 * (25mm, 25thk, t25, thk25) or as a grade is a hint. The FIRST token never is: a name is a mark or
 * a code first (a part marked E350 keeps its mark).
 * → { thicknessMm, grade, hintTokens: [], rest: [], restText } — restText is the name without its
 *   ending and its hint tokens, the other tokens as they were written.
 */
export function nameTokenHints(filename) {
  const base = String(filename ?? '').split(/[\\/]/).pop().replace(/\.(dxf|pdf)$/i, '').trim();
  const tokens = [];   // { text, lead } — lead: the separators written before it
  let cur = ''; let lead = ''; let depth = 0; let gap = '';
  for (const ch of base) {
    if (ch === '(') depth += 1;
    if (!depth && /[_\s,;]/.test(ch)) {
      if (cur) { tokens.push({ text: cur, lead }); cur = ''; gap = ''; }
      gap += ch;
    } else { if (!cur) lead = gap; cur += ch; }
    if (ch === ')') depth = Math.max(0, depth - 1);
  }
  if (cur) tokens.push({ text: cur, lead });
  const out = { thicknessMm: null, grade: null, hintTokens: [], rest: [], restText: '' };
  tokens.forEach((t, i) => {
    const tok = t.text;
    if (i > 0) {
      const m = tok.match(/^(\d+(?:\.\d+)?)\s*(?:mm|thk|t)$/i) ?? tok.match(/^(?:t|thk)(\d+(?:\.\d+)?)$/i);
      if (m && Number(m[1]) > 0 && Number(m[1]) <= 300) { if (out.thicknessMm == null) out.thicknessMm = Number(m[1]); out.hintTokens.push(tok); return; }
      const g = tok.match(GRADE);
      if (g && g[1].length === tok.length) { if (out.grade == null) out.grade = tok.toUpperCase(); out.hintTokens.push(tok); return; }
    }
    out.restText += (out.rest.length ? t.lead || '_' : '') + tok;
    out.rest.push(tok);
  });
  return out;
}

/**
 * The thickness and grade a part drawing's own WORDS state (its title block, a note): every TEXT,
 * MTEXT and attribute of the file, blocks included, read without building any geometry. Stricter
 * than a nest's title hints — a part drawing is full of dimensions, so a bare "150 mm" is NOT a
 * thickness here: only THK / THICK / T= / PL forms and a full L x W x T size are.
 * → { thicknessMm, grade, texts } — nulls when the file says neither (or does not read).
 */
export function dxfTextHints(text) {
  const out = { thicknessMm: null, grade: null, texts: 0 };
  let dxf;
  try { dxf = readSections(pairsOf(String(text ?? ''))); } catch { return out; }
  const strings = [];
  const take = (e) => {
    if (!['TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF'].includes(e.type)) return;
    let s = e.type === 'MTEXT' ? plainMtext(e.codes.filter((p) => p[0] === 3).map((p) => p[1]).join('') + str(e.codes, 1)) : str(e.codes, 1);
    s = s.replace(/%%[cdpCDP]/g, '').trim();
    if (s) strings.push(s);
  };
  dxf.entities.forEach(take);
  for (const b of dxf.blocks.values()) b.entities.forEach(take);
  out.texts = strings.length;
  for (const s of strings) {
    for (const line of s.split('\n')) {
      if (out.thicknessMm == null) {
        const t = line.match(/(?:THK|THICK(?:NESS)?)\s*[=:.]?\s*(\d+(?:\.\d+)?)/i) ?? line.match(/(\d+(?:\.\d+)?)\s*(?:mm)?\s*(?:THK|THICK)(?![a-z])/i)
          ?? line.match(/(?:^|[^A-Z0-9])T\s*[=:]\s*(\d+(?:\.\d+)?)/i) ?? line.match(/(?:^|[^A-Z0-9])PL(?:T|ATE)?\.?\s*(\d+(?:\.\d+)?)\s*(?:mm)?(?![0-9]*\s*[x×*])/i);
        const three = t ? null : line.match(SIZE3);
        if (t && Number(t[1]) > 0 && Number(t[1]) <= 300) out.thicknessMm = Number(t[1]);
        else if (three) { const v = three.slice(1, 4).map(Number).sort((a, b) => a - b); if (v[0] > 0 && v[0] <= 300 && v[1] >= 50) out.thicknessMm = v[0]; }
      }
      if (out.grade == null) { const m = line.match(GRADE); if (m) out.grade = m[1].replace(/\s+/g, ' ').trim().toUpperCase(); }
    }
  }
  return out;
}

/* ───────────────────────────── readNestDxf ───────────────────────────── */

/**
 * Reads one plate's nesting DXF.
 *
 * @param {string|Uint8Array} text  the file
 * @param {{ filename?: string, joinTolMm?: number, gapTolMm?: number, plateOutline?: boolean, plateSize?: { length, width },
 *           plateSizes?: Array<{ length, width }>, units?: 'in', markingStyles?: string[] }} [opts]
 *        gapTolMm: the widest gap in an outline that is closed (GAP_CLOSE_MM; 0 closes nothing).
 *        plateSizes: every size a plate comes in (the catalog's) — tells the plate from a frame round it, and two plates from two parts.
 *        units: 'in' reads a file whose header names no unit as inches.
 *        markingStyles: styles ("LAYER|colour", as `splitStyles` gives them) to read as marking, not as cuts.
 *        plateSize: the plate's size when the caller knows it (mm) — a common-cut nest whose rim is that size has its plate drawn.
 *        plateOutline: say outright
 *        that the file does (true) or does not (false) draw the plate, instead of letting the reader judge
 * @returns {{
 *   units: string,                 // what the file was drawn in ('mm' | 'in' | …); everything returned is mm
 *   plate: { length, width, outline, origin, found: 'outline'|'bounds' },
 *   parts: Array<{ id, rings: { outline, cutouts, holes }, bbox: { x, y, length, width }, area, labels: string[], labelFrom: 'inside'|'block'|'near'|null, layer, within: string|null }>,
 *   texts: Array<{ text, at }>,
 *   hints: { thicknessMm, grade, nestNo, plateSize },
 *   offcuts: Array<{ outline, bbox, label }>,   // loops on an offcut / remnant layer (our own export draws them)
 *   skeleton: { outline, bbox } | null,         // what is left of the plate, when parts are common-cut against its edge
 *   (each part also says: commonCut 0…1, outsidePlate, outsideMm; and — when closed shapes inside it
 *    may be marking — ringsNoMarks, areaNoMarks, unsureMarks, unsureStyle)
 *   unitsStated: boolean, plates: number, closedGaps: number,
 *   outside: Array<{ rings, bbox, area, labels, inFrame, layer }>,   // closed shapes beside the plate
 *   splitStyles: string[], markingStyles: string[],
 *   problems: Array<{ code: 'OPEN_CONTOUR'|'MULTIPLE_PLATES', message, … }>,                // block the file
 *   cautions: Array<{ code: 'SHAPE_IGNORED'|'CURVE_APPROXIMATE', message, … }>,             // need the user's eye
 *   warnings: string[],                                                                    // notes
 * }}
 * @throws an Error with .code 'BAD_FILE' | 'EMPTY_NEST' | 'TOO_BIG'
 */
export function readNestDxf(text, { filename, joinTolMm = JOIN_TOL, gapTolMm = GAP_CLOSE_MM, plateOutline, plateSize, plateSizes, units, markingStyles } = {}) {
  const warnings = [];
  const problems = [];      // { code, message, … } — block the file
  const cautions = [];      // { code, message, … } — need the user's eye (a save needs force)
  const dxf = readSections(pairsOf(toText(text)));
  const unitsStated = dxf.units != null && dxf.units !== 0;
  const unitCode = units === 'in' ? 1 : dxf.units ?? 0;
  const scale = UNIT[unitCode] ?? 1;
  if (!(unitCode in UNIT)) warnings.push('The file names a unit this reader does not know; it is read as millimetres.');
  const tol = Math.max(0.01, Number(joinTolMm) || JOIN_TOL);
  const gapTol = Math.max(0, Number(gapTolMm) || 0);

  const raw = explode(dxf, scale, warnings, cautions, markingStyles?.length ? new Set(markingStyles) : null);
  // A line on an offcut / remnant layer (the crop line that marks the piece to keep) is not a cut of
  // the nest: it must not split the plate it runs across. Such lines close only among themselves.
  const cutPaths = raw.open.filter((p) => !OFFCUT_LAYER.test(p.layer));
  const offPaths = raw.open.filter((p) => OFFCUT_LAYER.test(p.layer));
  const fromPaths = loopsFromPaths(cutPaths, tol, gapTol);
  const fromOff = loopsFromPaths(offPaths, tol, 0);
  if (fromOff.strays) warnings.push(`${plural(fromOff.strays, 'line', 'lines')} on an offcut / remnant layer (a crop line) ignored — not a cut of the nest.`);

  // Every loop, counter-clockwise, biggest first; a contour drawn twice is one contour.
  let loops = [];
  for (const l of [...raw.closed, ...fromPaths.loops, ...fromOff.loops]) {
    const pts = cleanRing(l.pts);
    if (pts.length < 3) continue;
    const area = signedArea(pts);
    if (area < MIN_LOOP_AREA) continue;
    loops.push({ pts, area, box: boxOf(pts), layer: l.layer ?? '0', style: l.style ?? null, chain: l.chain ?? [], shared: l.shared ?? 0, outsideMm: 0, parent: null, kids: [] });
  }
  loops.sort((a, b) => b.area - a.area);
  const sameBox = (a, b) => Math.abs(a.x0 - b.x0) <= 2 * tol && Math.abs(a.y0 - b.y0) <= 2 * tol && Math.abs(a.x1 - b.x1) <= 2 * tol && Math.abs(a.y1 - b.y1) <= 2 * tol;
  loops = loops.filter((l, i) => {
    for (let j = i - 1; j >= 0 && loops[j].area - l.area <= 4 * tol * (l.box.x1 - l.box.x0 + l.box.y1 - l.box.y0) + 1e-6; j--) if (sameBox(loops[j].box, l.box)) return false;
    return true;
  });

  const offcutLoops = loops.filter((l) => OFFCUT_LAYER.test(l.layer));
  loops = loops.filter((l) => !OFFCUT_LAYER.test(l.layer));
  if (!loops.length) throw invalid('EMPTY_NEST', 'No closed shape was found in the file — there is nothing nested in it.');

  // Which loop sits directly inside which: the smallest loop that holds it.
  for (let i = 1; i < loops.length; i++) {
    const l = loops[i];
    let probe = null;
    for (let j = i - 1; j >= 0; j--) {
      const o = loops[j];
      if (l.box.x0 < o.box.x0 - tol || l.box.x1 > o.box.x1 + tol || l.box.y0 < o.box.y0 - tol || l.box.y1 > o.box.y1 + tol) continue;
      probe ??= interiorPoint(l.pts);
      if (insidePoly(probe, o.pts)) { l.parent = o; o.kids.push(l); break; }
    }
  }
  const roots = loops.filter((l) => !l.parent);

  // The words, and what they say about the plate (needed to tell a plate from one big part).
  const titleHints = hintsFrom(raw.texts.map((t) => t.text), null);
  const nameHints = hintsFrom([], filename);
  const sizeIs = (box, size) => {
    if (!size) return false;
    const d = [box.x1 - box.x0, box.y1 - box.y0].sort((a, b) => a - b);
    return Math.abs(d[1] - size.length) <= 1 && Math.abs(d[0] - size.width) <= 1;
  };
  const sizeOf = (s) => (s && Number(s.length) > 0 && Number(s.width) > 0 ? { length: Math.max(Number(s.length), Number(s.width)), width: Math.min(Number(s.length), Number(s.width)) } : null);
  const boxSize = (b) => sizeOf({ length: b.x1 - b.x0, width: b.y1 - b.y0 });
  const sizeWordsOf = (b) => `${r1(Math.max(b.x1 - b.x0, b.y1 - b.y0))} x ${r1(Math.min(b.x1 - b.x0, b.y1 - b.y0))}`;

  // THE PLATE: the loop on a plate layer, else the one loop that holds all the others — unless
  // that reads as a single part with its holes.
  // A size "a plate comes in": the plate named by the caller, the size the title or the file name
  // states, or any plate of the catalog (`plateSizes`).
  const known = sizeOf(plateSize);
  const catalog = (plateSizes ?? []).map(sizeOf).filter(Boolean);
  const isPlateSize = (box) => sizeIs(box, titleHints.plateSize) || sizeIs(box, known) || sizeIs(box, nameHints.plateSize) || catalog.some((s) => sizeIs(box, s));
  const isRect = (l) => l.area >= 0.98 * (l.box.x1 - l.box.x0) * (l.box.y1 - l.box.y0);
  const ancestorsOf = (l) => { const out = []; for (let p = l.parent; p; p = p.parent) out.push(p); return out; };
  /** A loop that is not inside the plate but lies partly over it: a part across the plate's edge. */
  const straddles = (l, b) => Math.min(l.box.x1, b.x1) - Math.max(l.box.x0, b.x0) > tol && Math.min(l.box.y1, b.y1) - Math.max(l.box.y0, b.y0) > tol
    && (l.box.x0 < b.x0 - tol || l.box.x1 > b.x1 + tol || l.box.y0 < b.y0 - tol || l.box.y1 > b.y1 + tol);
  const textIn = (l) => raw.texts.some((t) => [t.at, t.alt].some((q) => insidePoly(q, l.pts) && !l.kids.some((k) => insidePoly(q, k.pts))));
  /** Its loops are parts (one has a label in it, or openings of its own) — not the bare holes of one part. */
  const holdsParts = (l) => l.kids.some((k) => k.kids.length) || raw.texts.some((t) => l.kids.some((k) => insidePoly(t.at, k.pts) || insidePoly(t.alt, k.pts)));

  let plateLoop = null;
  if (plateOutline !== false) {
    // On a plate layer: the biggest loop that is not inside another loop of a plate layer (the first that holds something).
    const onLayer = loops.filter((l) => PLATE_LAYER.test(l.layer) && !ancestorsOf(l).some((a) => PLATE_LAYER.test(a.layer)));
    plateLoop = onLayer.find((l) => l.kids.length) ?? onLayer[0] ?? null;
  }
  if (plateLoop && !plateLoop.kids.length) throw invalid('EMPTY_NEST', 'The file draws a plate with nothing nested on it.');
  if (!plateLoop && plateOutline !== false && roots[0].kids.length) {
    const r = roots[0];
    const others = roots.slice(1);
    // The other loops outside it may only be parts lying across its edge — and then it must be a plain rectangle.
    const holdsAll = others.every((l) => straddles(l, r.box)) && (!others.length || isRect(r));
    if (holdsAll) {
      const textInKid = raw.texts.some((t) => r.kids.some((k) => insidePoly(t.at, k.pts) || insidePoly(t.alt, k.pts)));
      // One part with its drilled holes and nothing else: every loop inside is a bare hole on the part's own layer.
      const drilled = (k) => { const c = circleOf(k.pts); return !!c && 2 * c.r <= DRILL_MAX_DIA_MM + 1e-6; };
      const onePart = !others.length && plateOutline !== true && !isPlateSize(r.box) && !textInKid && r.kids.every((k) => !k.kids.length && k.layer === r.layer && drilled(k));
      if (!onePart) plateLoop = r;
      /*
       * A FRAME ROUND THE PLATE with no layer to say so (a drawing sheet flattened to layer 0): the
       * outermost rectangle is then the sheet's border, not the plate. When it is not a size a plate
       * comes in and exactly one rectangle inside it is — one that holds loops of its own — that
       * inner rectangle is the plate and the outer one a frame. Again, for a frame inside a frame.
       */
      while (plateLoop && isRect(plateLoop) && !isPlateSize(plateLoop.box)) {
        const sized = plateLoop.kids.filter((k) => k.kids.length && isRect(k) && isPlateSize(k.box));
        if (!sized.length) break;
        plateLoop = sized[0];       // two of them are two plates on one sheet: said below
      }
    } else {
      // No loop holds the others. Rectangles side by side that each hold parts, each a size a plate
      // comes in (or all one size): several plates in one file. The first is read, and the file is refused.
      const like = roots.filter((l) => isRect(l) && l.kids.length && (isPlateSize(l.box) || holdsParts(l)));
      if (like.length >= 2 && (like.filter((l) => isPlateSize(l.box)).length >= 2 || like.every((l) => sizeIs(l.box, boxSize(like[0].box))))) plateLoop = like[0];
    }
  }
  const frames = plateLoop ? ancestorsOf(plateLoop) : [];
  let partLoops;
  let plate;
  let skeleton = null;
  const outsideLoops = [];        // { loop, inFrame } — closed shapes that are neither the plate nor on it
  let plates = 1;
  if (plateLoop) {
    partLoops = plateLoop.kids.slice();
    const b = plateLoop.box;
    let across = 0;
    const consider = (l, inFrame) => {
      // A PART ACROSS THE PLATE'S EDGE is still a part: it is returned, flagged, with how far out it reaches.
      if (straddles(l, b)) { l.outsideMm = Math.max(b.x0 - l.box.x0, l.box.x1 - b.x1, b.y0 - l.box.y0, l.box.y1 - b.y1, 0); partLoops.push(l); across++; } else outsideLoops.push({ loop: l, inFrame });
    };
    const top = frames.length ? frames[frames.length - 1] : plateLoop;
    for (const l of roots) if (l !== top) consider(l, false);
    let inner = plateLoop;
    for (const fr of frames) { for (const k of fr.kids) if (k !== inner) consider(k, true); inner = fr; }
    if (frames.length) warnings.push(`A frame (${sizeWordsOf(frames[0].box)}) is drawn round the plate: the plate is the ${sizeWordsOf(b)} rectangle inside it.`);
    /*
     * MORE THAN ONE PLATE IN THE FILE (a job exported as "all sheets"). One file is one plate, so the
     * file is REFUSED in words — never read as its first plate with the others dropped. Another plate
     * is a rectangle outside this one that holds loops and is on a plate layer, or is this plate's
     * size, or a size a plate comes in.
     */
    const otherPlates = outsideLoops.filter((o) => isRect(o.loop) && o.loop.kids.length && (PLATE_LAYER.test(o.loop.layer) || sizeIs(o.loop.box, boxSize(b)) || isPlateSize(o.loop.box)));
    if (otherPlates.length) {
      plates = 1 + otherPlates.length;
      const sizes = [...new Set([plateLoop, ...otherPlates.map((o) => o.loop)].map((l) => sizeWordsOf(l.box)))];
      problems.push({ code: 'MULTIPLE_PLATES', plates, message: `it holds ${plates} plates (${sizes.length === 1 ? `each ${sizes[0]}` : sizes.join(', ')}). One file is one plate — export each plate as its own file and upload them together. Nothing of this file is taken.` });
      for (const o of otherPlates) outsideLoops.splice(outsideLoops.indexOf(o), 1);
    }
    if (across) warnings.push(`${plural(across, 'part lies', 'parts lie')} partly off the plate.`);
    if (outsideLoops.length) warnings.push(`${plural(outsideLoops.length, 'shape', 'shapes')} drawn outside the plate ignored.`);
    plate = { length: r4(b.x1 - b.x0), width: r4(b.y1 - b.y0), origin: [b.x0, b.y0], outline: plateLoop.pts, found: 'outline' };
    if (!partLoops.length) throw invalid('EMPTY_NEST', 'The file draws a plate with nothing nested on it.');
  } else {
    const b = boxOf(roots.flatMap((l) => [[l.box.x0, l.box.y0], [l.box.x1, l.box.y1]]));
    // COMMON-CUT AGAINST THE PLATE'S EDGE: the plate's outline is then the rim of the parts themselves, so no
    // loop holds the others — but together they fill their rectangle exactly. What is left of the plate
    // (the skeleton) is the biggest of them when it has loops inside it and no label of its own; the
    // loops inside it are parts lying free on the plate.
    const boxArea = (b.x1 - b.x0) * (b.y1 - b.y0);
    const tiled = roots.length >= 2 && Math.abs(roots.reduce((sum, l) => sum + l.area, 0) - boxArea) <= 1e-4 * boxArea;
    if (tiled && plateOutline !== false && roots[0].kids.length && !textIn(roots[0])) skeleton = roots[0];
    partLoops = skeleton ? [...roots.filter((l) => l !== skeleton), ...skeleton.kids] : roots;
    const drawn = tiled && plateOutline !== false && (plateOutline === true || isPlateSize(b) || !!skeleton);
    plate = { length: r4(b.x1 - b.x0), width: r4(b.y1 - b.y0), origin: [b.x0, b.y0], outline: [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]], found: drawn ? 'outline' : 'bounds' };
    if (!drawn) warnings.push('The file does not draw the plate itself, so the plate here is only the rectangle round the parts — positions are measured from its lower-left corner.');
  }
  // When the plate found is no size a plate comes in, a rectangle inside it that holds everything else may be the real plate.
  if (plateLoop && !isPlateSize(plateLoop.box)) {
    const holders = plateLoop.kids.filter((k) => k.kids.length);
    if (holders.length === 1 && isRect(holders[0]) && isRect(plateLoop)) plate.inside = boxSize(holders[0].box);
  }
  const [ox, oy] = plate.origin;
  const local = (pts) => pts.map(([x, y]) => [r4(x - ox), r4(y - oy)]);
  const here = (p) => `(${r1(p[0] - ox)}, ${r1(p[1] - oy)})`;
  plate.outline = local(plate.outline);
  plate.origin = [r4(ox / scale), r4(oy / scale)];       // where the plate's corner is in the FILE, in the file's units

  /*
   * WHAT DID NOT CLOSE INTO A SHAPE (the chains of dropped lines) — said by what it most likely is:
   *   - lying wholly inside one part: marking (a layout line, scribed letters) or the lead-in of a
   *     cut-out. Not a cut. Its style, when it is not the part's own, is a MARKING style: closed
   *     shapes drawn in it inside parts are marking too, never cut-outs;
   *   - one plain run of lines in the scrap that would enclose a part's worth of steel if its ends
   *     met: AN OUTLINE LEFT OPEN. Ends near each other → the file is refused (OPEN_CONTOUR), with
   *     where and how wide; far apart → a warning that needs the user's eye (SHAPE_IGNORED);
   *   - anything else: lead-ins, rapid moves, a leftover dimension — a note, as before.
   */
  const homeOf = (pt) => partLoops.find((l) => pt[0] >= l.box.x0 && pt[0] <= l.box.x1 && pt[1] >= l.box.y0 && pt[1] <= l.box.y1 && insidePoly(pt, l.pts)) ?? null;
  const markStyles = new Set(markingStyles ?? []);
  let leadLike = 0; let inParts = 0;
  for (const ch of fromPaths.chains) {
    const homes = new Set(ch.probes.map(homeOf));
    if (homes.size === 1 && !homes.has(null)) {
      inParts += ch.lines;
      const home = [...homes][0];
      if (ch.style != null && home.style != null && ch.style !== home.style) markStyles.add(ch.style);
      continue;
    }
    const enclosed = ch.simple && ch.segments >= OPEN_PART_MIN_SEGMENTS && homes.size === 1 ? Math.abs(signedArea(ch.pts)) : 0;
    if (enclosed < OPEN_PART_MIN_AREA) { leadLike += ch.lines; continue; }
    const gap = Math.hypot(ch.ends[0][0] - ch.ends[1][0], ch.ends[0][1] - ch.ends[1][1]);
    const cb = boxOf(ch.pts);
    const where = `about ${sizeWordsOf(cb)} at ${here([cb.x0, cb.y0])}`;
    const mid = [(ch.ends[0][0] + ch.ends[1][0]) / 2, (ch.ends[0][1] + ch.ends[1][1]) / 2];
    const extra = { at: [r1(mid[0] - ox), r1(mid[1] - oy)], gapMm: r1(gap), bbox: { x: r4(cb.x0 - ox), y: r4(cb.y0 - oy), length: r4(cb.x1 - cb.x0), width: r4(cb.y1 - cb.y0) } };
    if (gap <= Math.max(OPEN_PART_GAP_BLOCK_MM, 0.1 * ch.length)) {
      problems.push({ code: 'OPEN_CONTOUR', ...extra, message: `a shape ${where} is not a closed outline: its ends are ${r1(gap)} mm apart at ${here(mid)}. Close it in the nesting program and export again.` });
    } else {
      cautions.push({ code: 'SHAPE_IGNORED', ...extra, message: `a run of lines ${where} does not close into a shape (its ends are ${r1(gap)} mm apart), so it is not read as a part. If it is a part, close its outline in the nesting program and export again — or save anyway.` });
    }
  }
  if (leadLike) warnings.push(`${plural(leadLike, 'line that does', 'lines that do')} not close into a shape ignored (lead-ins, rapid moves).`);
  if (inParts) warnings.push(`${plural(inParts, 'open line', 'open lines')} inside parts ignored: marking, or the lead-ins of cut-outs — not cuts.`);
  if (fromPaths.closedGaps.length) {
    const widest = fromPaths.closedGaps.reduce((a, g) => (g.gap > a.gap ? g : a));
    warnings.push(`${plural(fromPaths.closedGaps.length, 'gap', 'gaps')} in ${fromPaths.closedGaps.length === 1 ? 'an outline' : 'outlines'} closed (${fromPaths.closedGaps.length === 1 ? '' : 'the widest '}${r1(widest.gap) || '< 0.1'} mm, at ${here(widest.at)}): a micro-joint left uncut, or a line drawn short of its corner.`);
  }

  // PARTS, all the way down: a loop inside a part is its cut-out; a loop inside a cut-out is a part.
  /*
   * …unless it is MARKING. A closed shape inside a part is
   *   'cut'     a round hole of drilling size, or drawn in the part's own style (layer and colour);
   *   'mark'    drawn in a marking style (see above): never a cut-out, left out of the part;
   *   'unsure'  drawn in another style with nothing to say which it is. The part then comes with
   *             its rings both ways (`rings` with, `ringsNoMarks` without) and matchNest lets the
   *             cut plate's own drawing decide.
   */
  const drillHole = (k) => { const c = circleOf(k.pts); return !!c && 2 * c.r <= DRILL_MAX_DIA_MM + 1e-6; };
  const kindOf = (loop, c) => (drillHole(c) || c.style == null || loop.style == null || c.style === loop.style ? 'cut' : markStyles.has(c.style) ? 'mark' : 'unsure');
  const parts = [];
  let marksLeftOut = 0;
  const take = (loop, within) => {
    const inner = []; const unsure = [];
    for (const c of loop.kids) {
      const kind = kindOf(loop, c);
      if (kind === 'mark') { marksLeftOut += 1; continue; }
      inner.push(c);
      if (kind === 'unsure') unsure.push(c);
    }
    const part = { loop, within, inner, unsure, labels: [], labelFrom: null };
    parts.push(part);
    for (const cut of inner) for (const nested of cut.kids) take(nested, part);
  };
  for (const l of partLoops) take(l, null);
  if (marksLeftOut) warnings.push(`${plural(marksLeftOut, 'closed shape', 'closed shapes')} inside parts, drawn in the layer or colour of the marking lines, read as marking (scribed letters) — not as cut-outs.`);
  parts.sort((a, b) => Math.round(a.loop.box.y0) - Math.round(b.loop.box.y0) || a.loop.box.x0 - b.loop.box.x0 || a.loop.box.y0 - b.loop.box.y0);
  parts.forEach((p, i) => { p.id = `P${i + 1}`; });

  // LABELS. A text inside a part (and not in one of its openings) is that part's; then the name
  // of the block the part is an INSERT of; then, for a part still unnamed, the nearest short text.
  const bySize = parts.slice().sort((a, b) => a.loop.area - b.loop.area);
  const holder = (pt) => bySize.find((p) => pt[0] >= p.loop.box.x0 && pt[0] <= p.loop.box.x1 && pt[1] >= p.loop.box.y0 && pt[1] <= p.loop.box.y1
    && insidePoly(pt, p.loop.pts) && !p.inner.some((c) => !p.unsure.includes(c) && insidePoly(pt, c.pts))) ?? null;
  const offcuts = offcutLoops.map((l) => ({ loop: l, label: null }));
  const outside = outsideLoops.map((o) => ({ ...o, labels: [] }));
  const loose = [];
  for (const t of raw.texts) {
    const lines = t.text.split('\n').map((s) => s.trim()).filter(Boolean);
    if (OFFCUT_LAYER.test(t.layer)) {
      const o = offcuts.find((c) => insidePoly(t.at, c.loop.pts));
      if (o) o.label ??= lines[0] ?? null;
      continue;
    }
    const p = holder(t.at) ?? holder(t.alt);
    if (p) { for (const s of lines) if (!p.labels.includes(s)) p.labels.push(s); p.labelFrom = 'inside'; } else {
      loose.push({ ...t, lines });
      const o = outside.find((x) => insidePoly(t.at, x.loop.pts) && !x.loop.kids.some((k) => insidePoly(t.at, k.pts)));
      if (o && lines[0] && o.labels.length < 3) o.labels.push(lines[0]);
    }
  }
  const perInstance = new Map();
  for (const p of parts) for (const c of p.loop.chain) perInstance.set(c.id, (perInstance.get(c.id) ?? 0) + 1);
  for (const p of parts) {
    for (const c of p.loop.chain.slice().reverse()) {
      if (!c.name || perInstance.get(c.id) !== 1 || p.labels.includes(c.name)) continue;
      p.labels.push(c.name);
      p.labelFrom ??= 'block';
    }
  }
  const short = loose.filter((t) => t.lines.length === 1 && t.text.length <= 40 && t.text.split(/\s+/).length <= 3 && !SIZE2.test(t.text));
  for (const t of short) {
    let best = null; let bd = Infinity;
    for (const p of parts) { const d = Math.min(distToRing(t.at, p.loop.pts), distToRing(t.alt, p.loop.pts)); if (d < bd) { bd = d; best = p; } }
    const reach = best ? Math.min(500, Math.max(50, 0.5 * Math.max(best.loop.box.x1 - best.loop.box.x0, best.loop.box.y1 - best.loop.box.y0))) : 0;
    if (best && bd <= reach && !best.labelFrom && (best.near == null || bd < best.near.d)) best.near = { d: bd, text: t.text };
  }
  for (const p of parts) if (!p.labelFrom && p.near) { p.labels.push(p.near.text); p.labelFrom = 'near'; }

  /*
   * HINTS: what the words outside the parts and the FILE NAME say about the plate. THE FILE NAME
   * WINS — somebody typed it to say what the plate is; a loose text is whatever was left on the
   * drawing (a title, but also a dimension). A text that disagrees with the name is a note.
   */
  const wordHints = hintsFrom(loose.map((t) => t.text), null);
  const sameSizeHint = (a, b) => Math.abs(a.length - b.length) <= 1 && Math.abs(a.width - b.width) <= 1;
  const hints = {
    thicknessMm: nameHints.thicknessMm ?? wordHints.thicknessMm,
    grade: nameHints.grade ?? wordHints.grade,
    nestNo: wordHints.nestNo ?? nameHints.nestNo,
    plateSize: nameHints.plateSize ?? wordHints.plateSize,
    from: {
      thicknessMm: nameHints.thicknessMm != null ? 'file name' : wordHints.thicknessMm != null ? 'words' : null,
      grade: nameHints.grade != null ? 'file name' : wordHints.grade != null ? 'words' : null,
      plateSize: nameHints.plateSize != null ? 'file name' : wordHints.plateSize != null ? 'words' : null,
    },
  };
  if (nameHints.thicknessMm != null && wordHints.thicknessMm != null && Math.abs(nameHints.thicknessMm - wordHints.thicknessMm) > 0.01) {
    warnings.push(`The words in the file say ${wordHints.thicknessMm} mm thick and the file name says ${nameHints.thicknessMm} mm — the file name is taken.`);
  }
  if (nameHints.plateSize && wordHints.plateSize && !sameSizeHint(nameHints.plateSize, wordHints.plateSize)) {
    warnings.push(`The words in the file mention ${wordHints.plateSize.length} x ${wordHints.plateSize.width} and the file name says the plate is ${nameHints.plateSize.length} x ${nameHints.plateSize.width} — the file name is taken.`);
  }
  if (plate.found === 'outline' && hints.plateSize && !sizeIs({ x0: 0, y0: 0, x1: plate.length, y1: plate.width }, hints.plateSize)) {
    const d = [plate.length, plate.width].sort((a, b) => b - a);
    const ratio = hints.plateSize.length / (d[0] || 1);
    warnings.push(`The ${hints.from.plateSize === 'file name' ? 'file name says' : 'words in the file say'} the plate is ${hints.plateSize.length} x ${hints.plateSize.width}, but the plate drawn is ${r1(d[0])} x ${r1(d[1])}.${!unitsStated && units !== 'in' && Math.abs(ratio - 25.4) < 0.3 ? ' The file does not say its units — it looks drawn in inches.' : ''}`);
  }

  const boxOut = (b) => ({ x: r4(b.x0 - ox), y: r4(b.y0 - oy), length: r4(b.x1 - b.x0), width: r4(b.y1 - b.y0) });
  const ringsOf = (loop, inner) => {
    const cutouts = []; const holes = [];
    for (const c of inner) (drillHole(c) ? holes : cutouts).push(local(c.pts));
    return { outline: local(loop.pts), cutouts, holes };
  };
  return {
    units: UNIT_NAME[unitCode] ?? 'mm',
    unitsStated: unitsStated || units === 'in',     // false: the header names no unit, so millimetres were assumed
    plate,
    plates,                                         // how many plates the file holds (more than 1 is a MULTIPLE_PLATES problem)
    parts: parts.map((p) => {
      const sure = p.unsure.length ? p.inner.filter((c) => !p.unsure.includes(c)) : p.inner;
      return {
        id: p.id,
        rings: ringsOf(p.loop, p.inner),
        bbox: boxOut(p.loop.box),
        area: r4(p.loop.area - p.inner.reduce((s, c) => s + c.area, 0)),
        // Closed shapes inside it in ANOTHER layer / colour than its outline, that may be marking: the part without them.
        ...(p.unsure.length ? {
          ringsNoMarks: ringsOf(p.loop, sure),
          areaNoMarks: r4(p.loop.area - sure.reduce((s, c) => s + c.area, 0)),
          unsureMarks: p.unsure.length,
          unsureStyle: styleWords(p.unsure[0].style),
        } : {}),
        labels: p.labels,
        labelFrom: p.labelFrom,
        layer: p.loop.layer,
        within: p.within?.id ?? null,
        commonCut: Math.round(p.loop.shared * 1000) / 1000,     // share of its outline that is a cut shared with a neighbour
        outsidePlate: p.loop.outsideMm > 0,
        outsideMm: r4(p.loop.outsideMm),                        // how far past the plate's edge it reaches
      };
    }),
    texts: raw.texts.map((t) => ({ text: t.text, at: [r4(t.at[0] - ox), r4(t.at[1] - oy)] })),
    hints,
    offcuts: offcuts.map((o) => ({ outline: local(o.loop.pts), bbox: boxOut(o.loop.box), label: o.label })),
    skeleton: skeleton ? { outline: local(skeleton.pts), bbox: boxOut(skeleton.box) } : null,
    // Closed shapes that are neither the plate nor on it (and not another plate): the caller says what they are.
    outside: outside.map((o) => ({ rings: ringsOf(o.loop, o.loop.kids), bbox: boxOut(o.loop.box), area: r4(o.loop.area), labels: o.labels, inFrame: o.inFrame, layer: o.loop.layer })),
    // Styles in which a line runs from edge to edge of what would otherwise be one shape: read again with
    // `markingStyles` set to these, the file may make more sense (the caller decides — it knows the cut plates).
    splitStyles: fromPaths.splitStyles,
    markingStyles: [...markStyles],
    closedGaps: fromPaths.closedGaps.length,
    problems,
    cautions,
    warnings,
  };
}
/** "layer X" / "colour 2 on layer X" — a style in words. */
export function styleWords(style) {
  const s = String(style ?? '');
  const i = s.lastIndexOf('|');
  const layer = i < 0 ? s : s.slice(0, i); const colour = i < 0 ? '' : s.slice(i + 1);
  return colour ? `colour ${colour} on layer ${layer}` : `layer ${layer}`;
}

/* ───────────────────────────── matchNest ───────────────────────────── */

const CORNER_DEG = 25;          // a turn sharper than this is a corner (a flattened arc turns 5°)
const SMOOTH_DEG = 6;
const MAX_SLACK = 2;            // mm: the most that flattening a curve differently may add to the tolerance

/** What is needed to compare a shape: its rings, centre, corners, and how coarsely its curves are flattened. */
function shapeOf(rings, { normalise }) {
  let list = ringList(rings).map(cleanRing).filter((r) => r.length >= 3);
  if (!list.length) return null;
  if (normalise) { const b = boxOf(list[0]); list = list.map((r) => r.map(([x, y]) => [x - b.x0, y - b.y0])); }
  const outline = list[0];
  const c = centroidOf(outline);
  const inner = list.slice(1);
  const innerC = inner.map(centroidOf);
  const innerR = inner.map((r) => circleOf(r)?.r ?? null);
  const feats = [];
  let slack = 0;
  for (const ring of list) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const p = ring[(i + n - 1) % n]; const q = ring[i]; const r = ring[(i + 1) % n];
      const l0 = Math.hypot(q[0] - p[0], q[1] - p[1]); const l1 = Math.hypot(r[0] - q[0], r[1] - q[1]);
      let turn = Math.abs(Math.atan2(r[1] - q[1], r[0] - q[0]) - Math.atan2(q[1] - p[1], q[0] - p[0])) / RAD;
      if (turn > 180) turn = 360 - turn;
      if (turn > 1e-3 && turn <= SMOOTH_DEG) slack = Math.max(slack, (Math.max(l0, l1) / 2) * Math.tan((turn * RAD) / 4));
      if (ring === outline && turn > CORNER_DEG && Math.max(l0, l1) >= 1.5) feats.push({ p: q, kind: 0, d: Math.hypot(q[0] - c[0], q[1] - c[1]) });
    }
  }
  innerC.forEach((p) => feats.push({ p, kind: 1, d: Math.hypot(p[0] - c[0], p[1] - c[1]) }));
  // Second moments of the outline's corners about its centre: the long axis, when it has one.
  let sxx = 0; let syy = 0; let sxy = 0;
  for (const [x, y] of outline) { sxx += (x - c[0]) ** 2; syy += (y - c[1]) ** 2; sxy += (x - c[0]) * (y - c[1]); }
  const axis = Math.hypot(sxx - syy, 2 * sxy) > 0.02 * (sxx + syy) ? (0.5 * Math.atan2(2 * sxy, sxx - syy)) / RAD : null;
  const area = signedArea(outline);
  const perim = perimeterOf(outline);
  const mbr = minRect(outline);
  const b = boxOf(outline);
  return {
    list, outline, inner, innerC, innerR, c, feats, slack: Math.min(MAX_SLACK, slack), axis, area, perim, mbr,
    length: b.x1 - b.x0, width: b.y1 - b.y0,
    isRect: !inner.length && Math.abs(mbr.a * mbr.b - area) <= perim * 0.25,
  };
}

const normDeg = (d) => { let x = d % 360; if (x < 0) x += 360; if (x >= 360 - 5e-5) x = 0; return x; };

/**
 * Does the candidate's shape lie on the part's, at some angle and hand? Returns the canonical
 * placement { x, y, rotationDeg, mirrored, error } (not mirrored before mirrored, then the
 * smallest angle — so a symmetric shape always reports the same one), else null.
 */
function fitShape(cand, part, tol) {
  const tolEff = tol + Math.max(cand.slack, part.slack);
  if (cand.inner.length !== part.inner.length) return null;
  if (Math.abs(cand.area - part.area) > (cand.perim + part.perim) / 2 * tolEff + 1e-6) return null;
  if (Math.abs(cand.perim - part.perim) > 0.01 * part.perim + 8 * tolEff * (1 + part.inner.length)) return null;

  const fits = [];
  for (const mirrored of [false, true]) {
    // The other hand is only looked at when this one does not already fit well.
    if (mirrored && fits.some((f) => f.error <= 0.5 * tolEff)) break;
    const mx = mirrored ? -1 : 1;
    const M = (p) => [p[0] * mx, p[1]];
    const cc = M(cand.c);
    const lists = cand.list.map((r) => r.map(M));
    const feats = cand.feats.map((f) => ({ ...f, p: M(f.p) }));

    // Angles worth trying: a far corner (or hole centre) of the candidate laid on each like one of the part.
    const tries = [0, 90, 180, 270];
    const anchors = feats.filter((f) => f.d > Math.max(1, 4 * tolEff)).sort((a, b) => b.d - a.d).slice(0, 3);
    for (const a of anchors) {
      const a0 = Math.atan2(a.p[1] - cc[1], a.p[0] - cc[0]);
      for (const f of part.feats) {
        if (f.kind !== a.kind || Math.abs(f.d - a.d) > 2 * tolEff + 0.2) continue;
        tries.push((Math.atan2(f.p[1] - part.c[1], f.p[0] - part.c[0]) - a0) / RAD);
        if (tries.length > 400) break;
      }
    }
    if (cand.axis != null && part.axis != null) { const d = part.axis - (mirrored ? -cand.axis : cand.axis); tries.push(d, d + 180); }

    const tried = new Set();
    const done = new Set();
    for (const t0 of tries) {
      let theta = normDeg(t0);
      const key = Math.round(theta * 50);
      if (tried.has(key)) continue;
      tried.add(key);
      // Centre on centre, then tighten on every corner / hole centre that finds its twin.
      let shift = null;
      for (let pass = 0; pass < 3; pass++) {
        const cos = Math.cos(theta * RAD); const sin = Math.sin(theta * RAD);
        const T = (p) => [(p[0] - cc[0]) * cos - (p[1] - cc[1]) * sin + part.c[0] + (shift?.[0] ?? 0), (p[0] - cc[0]) * sin + (p[1] - cc[1]) * cos + part.c[1] + (shift?.[1] ?? 0)];
        const pairs = [];
        const reach = Math.max(1, 3 * tolEff);
        if (feats.length >= 2) {
          for (const f of feats) {
            const q = T(f.p);
            let best = null; let bd = reach;
            for (const g of part.feats) { if (g.kind !== f.kind) continue; const d = Math.hypot(g.p[0] - q[0], g.p[1] - q[1]); if (d < bd) { bd = d; best = g; } }
            if (best) pairs.push([q, best.p]);
          }
        }
        if (pairs.length < 2) {
          // No corners to hold on to (an ellipse, a blob): every point to the nearest point of the other outline.
          if (pass === 0 && feats.length >= 2) break;
          pairs.length = 0;
          for (const v of lists[0]) { const q = T(v); const near = nearestOnRing(q, part.outline); if (near.d <= Math.max(reach, 0.05 * Math.sqrt(part.area))) pairs.push([q, near.p]); }
          if (pairs.length < 3) break;
        }
        let ax = 0; let ay = 0; let bx = 0; let by = 0;
        for (const [a, b] of pairs) { ax += a[0]; ay += a[1]; bx += b[0]; by += b[1]; }
        ax /= pairs.length; ay /= pairs.length; bx /= pairs.length; by /= pairs.length;
        let dot = 0; let crs = 0;
        for (const [a, b] of pairs) { const ux = a[0] - ax; const uy = a[1] - ay; const vx = b[0] - bx; const vy = b[1] - by; dot += ux * vx + uy * vy; crs += ux * vy - uy * vx; }
        const dTheta = Math.atan2(crs, dot);
        // New map: rotate the current one by dTheta about (ax, ay), then move (ax, ay) onto (bx, by).
        const cosD = Math.cos(dTheta); const sinD = Math.sin(dTheta);
        const centre = T(cc);
        const moved = [(centre[0] - ax) * cosD - (centre[1] - ay) * sinD + bx, (centre[0] - ax) * sinD + (centre[1] - ay) * cosD + by];
        theta = normDeg(theta + dTheta / RAD);
        shift = [moved[0] - part.c[0], moved[1] - part.c[1]];
        if (Math.abs(dTheta) < 1e-7) break;
      }
      const finish = (deg) => {
        const rotationDeg = normDeg(Math.round(deg * 1e4) / 1e4);
        // The centre keeps its place; the corner the convention measures from follows from it.
        const centreAt = [part.c[0] + (shift?.[0] ?? 0), part.c[1] + (shift?.[1] ?? 0)];
        const turned = placeRings(cand.list, { x: 0, y: 0, rotationDeg, mirrored });
        const tc = centroidOf(turned[0]);
        const x = Math.round((centreAt[0] - tc[0]) * 1e4) / 1e4; const y = Math.round((centreAt[1] - tc[1]) * 1e4) / 1e4;
        const placed = turned.map((r) => r.map(([px, py]) => [px + x, py + y]));
        const error = deviation(placed, part.list, tolEff, null, part.innerC, cand.innerR, part.innerR);
        return error <= tolEff ? { x, y, rotationDeg, mirrored, error } : null;
      };
      const refined = `${Math.round(theta * 100)}|${Math.round((shift?.[0] ?? 0) * 50)}|${Math.round((shift?.[1] ?? 0) * 50)}`;
      if (done.has(refined)) continue;
      done.add(refined);
      const snap = Math.round(theta / 90) * 90;
      const fit = (Math.abs(theta - snap) < 0.003 ? finish(snap) : null) ?? finish(theta);
      if (fit) fits.push(fit);
    }
  }
  if (!fits.length) return null;
  const best = Math.min(...fits.map((f) => f.error));
  const equal = fits.filter((f) => f.error <= best + Math.max(0.02, 0.1 * tolEff));
  equal.sort((a, b) => Number(a.mirrored) - Number(b.mirrored) || a.rotationDeg - b.rotationDeg);
  // Two angles a hair apart are the same answer; keep the better one of the first cluster.
  let pick = equal[0];
  for (const f of equal) if (f.mirrored === equal[0].mirrored && f.rotationDeg - equal[0].rotationDeg < 0.02 && f.error < pick.error) pick = f;
  return { ...pick, tolEff };
}

function nearestOnRing(p, ring) {
  let best = { d: Infinity, p: ring[0] };
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]; const b = ring[i];
    const dx = b[0] - a[0]; const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const q = [a[0] + t * dx, a[1] + t * dy];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < best.d) best = { d, p: q };
  }
  return best;
}

/** The rectangle round the part against the candidate's length × width, at the part's own angle. */
function fitSize(cand, part, tol) {
  const t = Math.max(tol, part.isRect && !cand.hasRings ? tol : 1);
  const { a, b, angleDeg, corners } = part.mbr;
  const options = [];
  if (Math.abs(a - cand.length) <= t && Math.abs(b - cand.width) <= t) options.push(angleDeg, angleDeg + 180);
  if (Math.abs(a - cand.width) <= t && Math.abs(b - cand.length) <= t) options.push(angleDeg + 90, angleDeg + 270);
  if (!options.length) return null;
  let rotationDeg = Math.min(...options.map((d) => normDeg(Math.round(d * 1e4) / 1e4)));
  const snap = Math.round(rotationDeg / 90) * 90;
  if (Math.abs(rotationDeg - snap) < 0.003) rotationDeg = normDeg(snap);
  const box = boxOf(corners);
  const error = Math.min(Math.max(Math.abs(a - cand.length), Math.abs(b - cand.width)), Math.max(Math.abs(a - cand.width), Math.abs(b - cand.length)));
  return { x: r4(box.x0), y: r4(box.y0), rotationDeg, mirrored: false, error, tolEff: t };
}

const normCode = (s) => String(s ?? '').toUpperCase().replace(/[\s\-_]+/g, '');
const sizeWords = (a, b) => `${r1(Math.max(a, b))} x ${r1(Math.min(a, b))}`;

/**
 * Says which candidate every part of a read nest is, and where it sits (see `placeRings`).
 *
 * @param nest        what readNestDxf returned
 * @param candidates  [{ key, codes: string[], rings | null, length, width }] — rings as partGeometry
 *                    gives them ([outline, …inner]) or as { outline, cutouts, holes }
 * @param opts        { toleranceMm = 0.5, kerfOffsetMaxMm = KERF_OFFSET_MAX_MM (0 = never),
 *                      prefer = null | (candidateKey) => boolean — ProNest parts only: the candidates to look among first }
 * @returns {{ placements, unmatched, counts, ambiguous, kerfOffsetMm, nominal }}
 *   placements[]: { partId, candidateKey, x, y, rotationDeg, mirrored, by: 'label'|'shape'|'size', confidence, error, marksLeftOut? }
 *   kerfOffsetMm: 0, or the one offset every part was drawn oversize by; then `nominal` is a
 *                 Map partId → { full, bare } — the parts' rings at nominal size
 *   ambiguous[]:  { partId, candidateKeys, options: placement[] } — the placement it would have as each
 *
 * A PART OF A PRONEST JOB (lib/nifReader.nestOfNif sets `outlineOnly`, `labelFrom: 'name'` and
 * `nameSize` on it; a DXF part has none of them and is read exactly as before) goes down a longer
 * ladder, stopping at the first rung that gives an answer:
 *   label      one of the candidates' codes standing in the part's NAME — the shop's free text,
 *              "16MM-WEB PL1-2150X6130- 4": a code is looked for as whole words of it, never as the
 *              thickness, the size or the quantity it also holds;
 *   shape      the OUTLINE alone against the candidate's outline (the shop drills holes later, so
 *              holes and openings on either side are not compared), any angle, either hand;
 *   size       the rectangle round the outline = the candidate's length × width;
 *   name size  the size written in the name = the candidate's length × width, when the outline
 *              itself is another size because it was altered for cutting (a web drawn wider for
 *              camber): `by: 'name size'`, with `outlineDiffers { drawn: [a, b], cutPiece: [l, w] }`.
 * A label whose candidate is neither the outline's shape nor the name's size does not end the
 * search (the name is a loose label): the other rungs are tried over every candidate first.
 */
export function matchNest(nest, candidates, { toleranceMm = 0.5, kerfOffsetMaxMm = KERF_OFFSET_MAX_MM, prefer = null } = {}) {
  const tol = Number(toleranceMm) > 0 ? Number(toleranceMm) : 0.5;
  const cands = (candidates ?? []).map((c) => {
    const hasRings = ringList(c.rings).length > 0;
    const shape = shapeOf(hasRings ? c.rings : rectRings(c.length, c.width), { normalise: true });
    return {
      key: c.key, hasRings, shape,
      // The outline alone (no holes, no openings): what a ProNest part is compared with.
      bare: shape && shape.inner.length ? shapeOf([shape.outline], { normalise: true }) : shape,
      name: (c.codes ?? []).find((s) => String(s ?? '').trim()) ?? String(c.key),
      length: Number(c.length) > 0 ? Number(c.length) : shape?.length ?? 0,
      width: Number(c.width) > 0 ? Number(c.width) : shape?.width ?? 0,
    };
  }).filter((c) => c.shape);
  const byCode = new Map();
  for (const c of candidates ?? []) {
    const k = cands.find((x) => x.key === c.key);
    if (!k) continue;
    for (const code of c.codes ?? []) { const n = normCode(code); if (!n) continue; if (!byCode.has(n)) byCode.set(n, []); if (!byCode.get(n).includes(k)) byCode.get(n).push(k); }
  }
  /** The candidates a label names: the whole label, else one of its words. */
  const named = (label) => {
    const whole = byCode.get(normCode(label));
    if (whole) return whole;
    const out = [];
    const words = String(label).split(/[\s,;:|()[\]=]+/).filter(Boolean);
    for (const w of words) for (const k of byCode.get(normCode(w)) ?? []) if (!out.includes(k)) out.push(k);
    if (out.length) return out;
    // A part named after the file it was imported from — CODE_12THK_4NOS, CODE.dxf: the code is the
    // start of the word, up to an underscore (the longest such start that is a code).
    for (const w of words) {
      const bits = w.replace(/\.(dxf|dwg)$/i, '').split('_');
      for (let n = bits.length; n >= 1; n--) {
        const hit = byCode.get(normCode(bits.slice(0, n).join('_')));
        if (hit) { for (const k of hit) if (!out.includes(k)) out.push(k); break; }
      }
    }
    return out;
  };
  /**
   * The candidates whose code stands in a ProNest part NAME: the whole name, else a run of its
   * words (split at spaces, dashes and underscores — a code may hold those itself) that is a code.
   * Never a word that is only a number, a thickness ("16MM") or a size ("2150X6130"): every name
   * ends in a quantity, and a drawing mark "4" must not answer to it.
   */
  const codeWord = (n) => n.length >= 2 && /[A-Z]/.test(n) && !/^\d+(\.\d+)?MM$/.test(n) && !/^\d+(\.\d+)?X\d/.test(n);
  const namedIn = (name) => {
    const whole = byCode.get(normCode(name));
    if (whole) return whole;
    const atoms = String(name).toUpperCase().split(/[\s\-_]+/).filter(Boolean);
    const out = [];
    for (let i = 0; i < atoms.length; i++) {
      let run = '';
      for (let j = i; j < atoms.length && j < i + 8; j++) {
        run += atoms[j];
        if (!codeWord(run)) continue;
        for (const k of byCode.get(run) ?? []) if (!out.includes(k)) out.push(k);
      }
    }
    return out;
  };

  const preferred = typeof prefer === 'function' ? cands.filter((c) => prefer(c.key)) : null;

  /** tier 2 = the shape itself (or a true rectangle of the right size); tier 1 = only the rectangle round it. */
  const tryFit = (c, shape, outlineOnly = false) => {
    const exact = fitShape(outlineOnly ? c.bare : c.shape, shape, tol);
    if (exact) return { ...exact, tier: 2, by: c.hasRings ? 'shape' : 'size' };
    if (!c.hasRings || shape.isRect) { const loose = fitSize(c, shape, tol); if (loose) return { ...loose, tier: 1, by: 'size' }; }
    return null;
  };
  const placement = (part, c, fit, by) => {
    const ratio = Math.min(1, fit.error / (fit.tolEff || tol));
    // tier 0: only the size in the part's name agrees (a ProNest part whose outline was altered for cutting).
    const base = fit.tier === 0 ? (by === 'label' ? 0.6 : 0.4) : fit.tier === 1 ? (by === 'label' ? 0.7 : 0.5) : by === 'label' ? 1 : by === 'shape' ? 0.9 : 0.75;
    return {
      partId: part.id, candidateKey: c.key, x: fit.x, y: fit.y, rotationDeg: fit.rotationDeg, mirrored: fit.mirrored, by, confidence: Math.round((base - (fit.tier === 2 ? 0.2 * ratio : 0)) * 100) / 100, error: Math.round(fit.error * 1e3) / 1e3,
      ...(fit.outlineDiffers ? { outlineDiffers: fit.outlineDiffers } : {}),
      ...(fit.allowanceMm != null ? { allowanceMm: fit.allowanceMm } : {}),
    };
  };
  /**
   * The size in a ProNest part's NAME against the candidate's length × width (±1 mm: names are whole
   * numbers). The candidate is laid along the rectangle round the outline, its length on the side
   * nearer its own; where it sits is the outline's own box.
   */
  const fitNameSize = (c, shape, nameSize, drawnSize = null) => {
    if (!nameSize || !(c.length > 0 && c.width > 0)) return null;
    const [n0, n1] = nameSize;
    let off = Math.min(Math.max(Math.abs(n0 - c.length), Math.abs(n1 - c.width)), Math.max(Math.abs(n0 - c.width), Math.abs(n1 - c.length)));
    let allowanceMm = null;
    if (!(off <= 1)) {
      // CUTTING ALLOWANCE (2026-10-14, from a shop's real jobs): the long side is nested a little OVER the finished
      // length — flanges 6135 for 6120, 11950 / 11955 for 11940, webs 6130 for 6120 — and trimmed after welding.
      // The short side is the finished width exactly. Accepted up to CUT_ALLOWANCE_MAX_MM over, never under.
      const [nl, nw] = n0 >= n1 ? [n0, n1] : [n1, n0];
      const [cl, cw] = c.length >= c.width ? [c.length, c.width] : [c.width, c.length];
      const over = nl - cl;
      if (!(Math.abs(nw - cw) <= 1 && over > 1 && over <= CUT_ALLOWANCE_MAX_MM)) return null;
      allowanceMm = r1(over); off = over;
    }
    const { a, b, angleDeg, corners } = shape.mbr;
    const along = Math.abs(a - c.length) + Math.abs(b - c.width) <= Math.abs(a - c.width) + Math.abs(b - c.length);
    let rotationDeg = Math.min(...(along ? [angleDeg, angleDeg + 180] : [angleDeg + 90, angleDeg + 270]).map((d) => normDeg(Math.round(d * 1e4) / 1e4)));
    const snap = Math.round(rotationDeg / 90) * 90;
    if (Math.abs(rotationDeg - snap) < 0.003) rotationDeg = normDeg(snap);
    const box = boxOf(corners);
    return {
      x: r4(box.x0), y: r4(box.y0), rotationDeg, mirrored: false, error: off, tolEff: 1, tier: 0, ...(allowanceMm != null ? { allowanceMm } : {}),
      // `drawn`: the part as it lies in its own drawing when the job says so (the smallest rectangle round a cambered web is a tilted one).
      outlineDiffers: { drawn: (drawnSize ?? [a, b]).slice().sort((p, q) => q - p).map(r1), cutPiece: [r1(Math.max(c.length, c.width)), r1(Math.min(c.length, c.width))] },
    };
  };

  /** Candidates that fit EXACTLY beat those that fit only with a cutting allowance; among those, the smallest allowance. */
  const exactFirst = (hits) => {
    const exact = hits.filter((h) => h.f.allowanceMm == null);
    if (exact.length) return exact;
    const least = Math.min(...hits.map((h) => h.f.allowanceMm));
    return hits.filter((h) => h.f.allowanceMm - least < 0.05);
  };

  /** One part, with the rings given: { placed, tier } | { ambiguous, tier } | { unmatched }. */
  const decide = (part, rings, pool = cands) => {
    const loose = !!part.outlineOnly;                  // a ProNest part: its outline alone, and its name a loose label
    const shape = shapeOf(loose ? [ringList(rings)[0] ?? []] : rings, { normalise: false });
    if (!shape) return { unmatched: { partId: part.id, bbox: part.bbox, labels: part.labels ?? [], why: 'Its outline could not be read.' } };
    const size = sizeWords(shape.mbr.a, shape.mbr.b);
    const fitOf = new Map();
    const fit = (c) => { if (!fitOf.has(c)) fitOf.set(c, tryFit(c, shape, loose)); return fitOf.get(c); };
    const byName = (list) => (loose && part.nameSize ? list.map((c) => ({ c, f: fitNameSize(c, shape, part.nameSize, part.drawnSize ?? null) })).filter((h) => h.f) : []);
    const best = (list) => {
      const hits = list.map((c) => ({ c, f: fit(c) })).filter((h) => h.f);
      const top = Math.max(0, ...hits.map((h) => h.f.tier));
      return hits.filter((h) => h.f.tier === top);
    };
    const settle = (hits, by) => (hits.length === 1
      ? { placed: placement(part, hits[0].c, hits[0].f, by ?? hits[0].f.by), tier: hits[0].f.tier }
      : { ambiguous: { partId: part.id, candidateKeys: hits.map((h) => h.c.key), options: hits.map((h) => placement(part, h.c, h.f, by ?? h.f.by)) }, tier: hits[0].f.tier });

    // 1. The label, when the shape agrees.
    const labelled = [];
    for (const l of part.labels ?? []) for (const c of (loose ? namedIn(l) : named(l))) if (pool.includes(c) && !labelled.includes(c)) labelled.push(c);
    const sure = part.labelFrom !== 'near';            // a text only NEAR the part is a guess at its label
    let mislabelled = null;                            // a ProNest name that names a candidate of another shape: said only if nothing else explains the part
    if (labelled.length) {
      const hits = best(labelled);
      if (hits.length) return settle(hits, 'label');
      // The name holds the code AND the size of the cut piece, and the outline was altered for cutting.
      const sized = byName(labelled);
      if (sized.length) return settle(sized, 'label');
      if (sure) {
        const c = labelled[0];
        const other = best(pool.filter((k) => !labelled.includes(k)));
        const really = other.length ? ` It has the shape of ${other.map((h) => h.c.name).join(' or ')}.` : '';
        const their = sizeWords(c.length, c.width);
        const same = their === size;
        const said = { unmatched: {
          partId: part.id, bbox: part.bbox, labels: part.labels,
          why: `It is labelled "${loose ? c.name : part.labels.find((l) => named(l).includes(c)) ?? c.name}", but it is not the shape of ${c.name} — ${c.name} is ${their}${same ? ' with a different outline or holes' : `, this is ${size}`}.${really}`,
        } };
        if (!loose) return said;
        mislabelled = said;
      }
    }

    // 2. The shape at any angle and hand; 3. the rectangle round it.
    const hits = best(pool);
    if (hits.length) return settle(hits, null);
    // 4. (a ProNest part) the size written in its name, when its outline is another size.
    const sized = byName(pool);
    if (sized.length) return settle(exactFirst(sized), 'name size');
    // 5. (a ProNest part) no size in its name, or none that fits: the OUTLINE's own size, over by a cutting allowance.
    if (loose) {
      const { a, b } = shape.mbr;
      const drawn = pool.map((c) => ({ c, f: fitNameSize(c, shape, [a, b], part.drawnSize ?? null) })).filter((h) => h.f);
      if (drawn.length) return settle(exactFirst(drawn), 'size');
    }
    if (mislabelled) return mislabelled;
    const said = (part.labels ?? []).length && !labelled.length ? `Its label "${part.labels[0]}" is not one of the codes, and none` : 'None';
    // A face closed in by cuts it shares with its neighbours, that is nobody's shape: most likely the scrap between them.
    const maybeScrap = Number(part.commonCut) > 0 && !(part.labels ?? []).length;
    return { unmatched: {
      partId: part.id, bbox: part.bbox, labels: part.labels ?? [], maybeScrap,
      why: `${said} of the cut plates is this shape (${size}${shape.inner.length ? `, ${plural(shape.inner.length, 'opening', 'openings')}` : ''}).${maybeScrap ? ' It is closed in by cuts it shares with the parts round it, so it may be the scrap between parts.' : ''}`,
    } };
  };

  /**
   * Every part. `ringsFor(part)` gives the rings to read it by (its own, or — kerf compensation —
   * the nominal ones). A part that comes with closed shapes inside it that MAY BE MARKING
   * (`ringsNoMarks`, see readNestDxf) is read with them first — when the cut plate's drawing has
   * those openings they are cut-outs — and without them only when that explains it better; the
   * placement then says `marksLeftOut`.
   */
  const pass = (ringsFor) => {
    const out = { placements: [], unmatched: [], ambiguous: [] };
    for (const part of nest?.parts ?? []) {
      const { full, bare } = ringsFor(part);
      // A ProNest part is looked for among the cut plates its plate could be cut into FIRST (`prefer`: the
      // job states the thickness) — a thicker or far thinner one of the same shape must not win on a higher
      // rung — and among all of them only when none of those is it (the answer then says the thickness).
      let res = part.outlineOnly && preferred ? decide(part, full, preferred) : decide(part, full);
      if (part.outlineOnly && preferred && res.unmatched) { const wide = decide(part, full); if (!wide.unmatched) res = wide; }
      if (part.outlineOnly) {
        // Matched by its outline whatever is inside it. Closed shapes inside it that MAY BE MARKING are
        // cut-outs only when the cut plate's own drawing has them, where they are; else they are left out.
        if (bare && !res.unmatched) {
          const whole = shapeOf(full, { normalise: false });
          const has = (key) => { const c = cands.find((k) => k.key === key); return !!(c?.hasRings && whole && c.shape.inner.length === whole.inner.length && fitShape(c.shape, whole, tol)); };
          for (const o of res.placed ? [res.placed] : res.ambiguous.options) if (!has(o.candidateKey)) o.marksLeftOut = part.unsureMarks ?? 0;
        }
      } else if (bare && !(res.placed && res.tier === 2)) {
        const alt = decide(part, bare);
        if (!alt.unmatched && (res.unmatched || alt.tier > res.tier)) {
          res = alt;
          const n = part.unsureMarks ?? 0;
          if (res.placed) res.placed.marksLeftOut = n; else for (const o of res.ambiguous.options) o.marksLeftOut = n;
        }
      }
      if (res.placed) out.placements.push(res.placed);
      else if (res.ambiguous) out.ambiguous.push(res.ambiguous);
      else out.unmatched.push(res.unmatched);
    }
    return out;
  };
  const tally = (list) => { const counts = Object.fromEntries(cands.map((c) => [c.key, 0])); for (const pl of list) counts[pl.candidateKey]++; return counts; };

  let found = pass((part) => ({ full: part.rings, bare: part.ringsNoMarks ?? null }));
  let kerfOffsetMm = 0;
  let nominal = null;
  /*
   * KERF-COMPENSATED OUTLINES (a toolpath export: the path of the torch's centre, every outline
   * drawn half a kerf OUTSIDE its part). Looked for only when some part of the file matched nothing as
   * drawn: if every part is then bigger than some cut plate by ONE offset, the same on all sides
   * and for every part (at most `kerfOffsetMaxMm` a side), the parts are read at their nominal
   * size — each outline taken in by that offset, each opening let out by it — and matched with the
   * ordinary tolerance. All of them must then match; otherwise the answer is the first one.
   */
  const parts = nest?.parts ?? [];
  // (A part with curves may match as drawn even so — a flattened curve is given some slack — which is
  // why the test is "some part matched nothing", and every part, matched or not, must show the offset.)
  if (kerfOffsetMaxMm > 0 && parts.length && found.unmatched.some((u) => !u.maybeScrap)) {
    const perPart = parts.map((part) => {
      const shape = shapeOf(part.rings, { normalise: false });
      const list = [];
      if (shape) {
        for (const c of cands) {
          for (const [l, w] of [[c.shape.mbr.a, c.shape.mbr.b], [c.shape.mbr.b, c.shape.mbr.a]]) {
            const da = shape.mbr.a - l; const db = shape.mbr.b - w;
            if (Math.abs(da - db) <= 0.3 && da + db > 2 * tol && (da + db) / 4 <= kerfOffsetMaxMm + 0.05) list.push((da + db) / 4);
          }
        }
      }
      return list;
    });
    if (perPart.every((l) => l.length)) {
      for (const d0 of [...new Set(perPart[0].map((d) => Math.round(d * 20) / 20))]) {
        const near = perPart.map((l) => l.reduce((a, d) => (Math.abs(d - d0) < Math.abs(a - d0) ? d : a)));
        if (near.some((d) => Math.abs(d - d0) > 0.15)) continue;
        const offset = near.reduce((a, d) => a + d, 0) / near.length;
        const taken = new Map(parts.map((part) => [part.id, { full: offsetRings(part.rings, offset), bare: part.ringsNoMarks ? offsetRings(part.ringsNoMarks, offset) : null }]));
        const again = pass((part) => taken.get(part.id));
        if (!again.unmatched.length) {
          found = again;
          kerfOffsetMm = Math.round(offset * 100) / 100;
          nominal = new Map([...taken].map(([id, r]) => [id, r]));
          break;
        }
      }
    }
  }
  return { ...found, counts: tally(found.placements), kerfOffsetMm, nominal };
}

/** A counter-clockwise ring moved IN by d all round (out when d < 0): each corner to where its two sides, moved, meet. */
function offsetRing(ring, d) {
  const n = ring.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = ring[(i + n - 1) % n]; const q = ring[i]; const r = ring[(i + 1) % n];
    let ax = q[0] - p[0]; let ay = q[1] - p[1]; let bx = r[0] - q[0]; let by = r[1] - q[1];
    const la = Math.hypot(ax, ay); const lb = Math.hypot(bx, by);
    if (la < 1e-9 || lb < 1e-9) continue;
    ax /= la; ay /= la; bx /= lb; by /= lb;
    const k = 1 + ax * bx + ay * by;                         // 1 + the normals' dot product
    const pt = k < 1e-3 ? [q[0] - d * ay, q[1] + d * ax] : [q[0] + (d * (-ay - by)) / k, q[1] + (d * (ax + bx)) / k];
    // A rounded corner of the torch path (an arc of radius d) comes in to one point: keep it once.
    const last = out[out.length - 1];
    if (!last || Math.hypot(last[0] - pt[0], last[1] - pt[1]) > 0.05) out.push(pt);
  }
  while (out.length > 3 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 0.05) out.pop();
  return out;
}
/** Rings { outline, cutouts, holes } as drawn round the torch's centre line → the part itself: outline in by d, openings out by d. */
function offsetRings(rings, d) {
  const ccw = (r) => cleanRing(r);
  return { outline: offsetRing(ccw(rings.outline), d), cutouts: (rings.cutouts ?? []).map((r) => offsetRing(ccw(r), -d)), holes: (rings.holes ?? []).map((r) => offsetRing(ccw(r), -d)) };
}
