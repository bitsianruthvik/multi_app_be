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
 * Parts common-cut against the plate's own edge leave no loop round them all: they fill their
 * rectangle exactly, and what is left of the plate (`skeleton`) is not a part. A part lying across
 * the plate's edge is returned with `outsidePlate` / `outsideMm`.
 *
 * The loops then nest inside each other. The largest one holding all the others is the PLATE
 * (unless everything inside it is a drilled hole — then it is one part with its holes);
 * the loops directly inside it are PARTS; a loop inside a part is its cut-out or hole; a loop
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
const SKIP_LAYER = new RegExp(`${B}(DIM|DIMS|DIMENSION|TEXT|NOTE|ANNO|CENT|CENTER|CENTRE|CL|HATCH|TITLE|BORDER|FRAME|DEFPOINTS|VIEWPORT|RAPID|RAPIDS|TRAVERSE|LEAD|LEADS|LEADIN|LEADINS|LEADOUT|LEADOUTS|PIERCE|PIERCING|MARK|MARKING|SCRIBE|ETCH|ENGRAVE)${E}`, 'i');
const OFFCUT_LAYER = /(OFFCUT|REMNANT|SCRAP|SKELETON|WASTE)/i;
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
function explode(dxf, scale, warnings) {
  const open = [];      // { pts, line, layer, chain }
  const closed = [];    // { pts, layer, chain }
  const texts = [];     // { text, at, alt, layer, chain }
  const stats = { skippedLayer: 0, pierce: 0, unknownBlocks: new Set(), tooDeep: false, splines: 0, count: 0 };
  let instance = 0;

  const bump = () => { if (++stats.count > MAX_PRIMITIVES) throw invalid('TOO_BIG', 'That file holds more shapes than one plate can — is it one nest per file?'); };
  const path = (m, pts, layer, chain, line = false) => {
    if (pts.length < 2) return;
    bump();
    open.push({ pts: pts.map((p) => apply(m, p)), line, layer, chain });
  };
  const ring = (m, pts, layer, chain) => { bump(); closed.push({ pts: pts.map((p) => apply(m, p)), layer, chain }); };
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
          break;
      }
    }
  };
  walk(dxf.entities, [scale, 0, 0, scale, 0, 0], null, [], 0);

  if (stats.skippedLayer) warnings.push(`${plural(stats.skippedLayer, 'item', 'items')} on dimension, border, lead-in or rapid-move layers ignored.`);
  if (stats.pierce) warnings.push(`${plural(stats.pierce, 'pierce mark', 'pierce marks')} ignored.`);
  if (stats.splines) warnings.push(`${plural(stats.splines, 'curve (spline) was', 'curves (splines) were')} read through their points — their shape is approximate.`);
  for (const n of stats.unknownBlocks) warnings.push(`The file places a block called "${n}" that it does not define — whatever is in it is missing.`);
  if (stats.tooDeep) warnings.push('Blocks inside blocks deeper than this reads were left out.');
  return { open, closed, texts };
}

/* ───────────────────────────── loose lines → closed loops ───────────────────────────── */

/**
 * The closed loops a set of loose paths makes: the faces of their graph, after the paths on no
 * closed path are dropped. Returns { loops: [{ pts, layer, chain }], strays }.
 */
function loopsFromPaths(paths, tol) {
  const loops = [];
  if (!paths.length) return { loops, strays: 0 };

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
    if (s.pts.length >= 4 && Math.abs(a[0] - z[0]) <= tol && Math.abs(a[1] - z[1]) <= tol) { loops.push({ pts: s.pts.slice(0, -1), layer: s.layer, chain: s.chain }); continue; }
    edges.push({ u: nodeAt(a), v: nodeAt(z), pts: s.pts, line: s.line && s.pts.length === 2, layer: s.layer, chain: s.chain });
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
        if (o.id !== prev) split.push({ u: prev, v: o.id, pts: [nodes[prev], nodes[o.id]], line: true, layer: e.layer, chain: e.chain });
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

  const first = tidy(edges);
  let live = closedOnly(first);
  let strays = first.length - live.length;
  if (crossings(live)) {
    const again = tidy(live);
    live = closedOnly(again);
    strays += again.length - live.length;
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
    for (const x of fc.halves) { const l = lengthOf(live[x >> 1]); all += l; if (faceOf[x ^ 1] !== -1) both += l; }
    loops.push({ pts: fc.pts, layer: fc.layer, chain: fc.chain, shared: all > 0 ? both / all : 0 });
  }
  return { loops, strays };
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
      const t = s.match(/(?:THK|THICK(?:NESS)?)\s*[=:.]?\s*(\d+(?:\.\d+)?)/i) ?? s.match(/(?:^|[^A-Z0-9])T\s*[=:]\s*(\d+(?:\.\d+)?)/i)
        ?? s.match(/(?:^|[^0-9.x×*])(\d+(?:\.\d+)?)\s*mm(?![a-z])(?!\s*[x×*])/i) ?? s.match(/(?:^|[^A-Z0-9])PL\.?\s*(\d+(?:\.\d+)?)(?![0-9]*\s*[x×*])/i);
      if (t && Number(t[1]) > 0 && Number(t[1]) <= 300) h.thicknessMm = Number(t[1]);
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

/* ───────────────────────────── readNestDxf ───────────────────────────── */

/**
 * Reads one plate's nesting DXF.
 *
 * @param {string|Uint8Array} text  the file
 * @param {{ filename?: string, joinTolMm?: number, plateOutline?: boolean, plateSize?: { length, width } }} [opts]
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
 *   (each part also says: commonCut 0…1, outsidePlate, outsideMm)
 *   warnings: string[],
 * }}
 * @throws an Error with .code 'BAD_FILE' | 'EMPTY_NEST' | 'TOO_BIG'
 */
export function readNestDxf(text, { filename, joinTolMm = JOIN_TOL, plateOutline, plateSize } = {}) {
  const warnings = [];
  const dxf = readSections(pairsOf(toText(text)));
  const unitCode = dxf.units ?? 0;
  const scale = UNIT[unitCode] ?? 1;
  if (!(unitCode in UNIT)) warnings.push('The file names a unit this reader does not know; it is read as millimetres.');
  const tol = Math.max(0.01, Number(joinTolMm) || JOIN_TOL);

  const raw = explode(dxf, scale, warnings);
  const fromPaths = loopsFromPaths(raw.open, tol);
  if (fromPaths.strays) warnings.push(`${plural(fromPaths.strays, 'line that does', 'lines that do')} not close into a shape ignored (lead-ins, rapid moves).`);

  // Every loop, counter-clockwise, biggest first; a contour drawn twice is one contour.
  let loops = [];
  for (const l of [...raw.closed, ...fromPaths.loops]) {
    const pts = cleanRing(l.pts);
    if (pts.length < 3) continue;
    const area = signedArea(pts);
    if (area < MIN_LOOP_AREA) continue;
    loops.push({ pts, area, box: boxOf(pts), layer: l.layer ?? '0', chain: l.chain ?? [], shared: l.shared ?? 0, outsideMm: 0, parent: null, kids: [] });
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
  const sizeIs = (box, size) => {
    if (!size) return false;
    const d = [box.x1 - box.x0, box.y1 - box.y0].sort((a, b) => a - b);
    return Math.abs(d[1] - size.length) <= 1 && Math.abs(d[0] - size.width) <= 1;
  };

  // THE PLATE: the loop on a plate layer, else the one loop that holds all the others — unless
  // that reads as a single part with its holes.
  const known = plateSize && Number(plateSize.length) > 0 && Number(plateSize.width) > 0
    ? { length: Math.max(Number(plateSize.length), Number(plateSize.width)), width: Math.min(Number(plateSize.length), Number(plateSize.width)) } : null;
  const isPlateSize = (box) => sizeIs(box, titleHints.plateSize) || sizeIs(box, known);
  /** A loop that is not inside the plate but lies partly over it: a part across the plate's edge. */
  const straddles = (l, b) => Math.min(l.box.x1, b.x1) - Math.max(l.box.x0, b.x0) > tol && Math.min(l.box.y1, b.y1) - Math.max(l.box.y0, b.y0) > tol
    && (l.box.x0 < b.x0 - tol || l.box.x1 > b.x1 + tol || l.box.y0 < b.y0 - tol || l.box.y1 > b.y1 + tol);
  const textIn = (l) => raw.texts.some((t) => [t.at, t.alt].some((q) => insidePoly(q, l.pts) && !l.kids.some((k) => insidePoly(q, k.pts))));

  let plateLoop = plateOutline === false ? null : loops.find((l) => PLATE_LAYER.test(l.layer)) ?? null;
  if (plateLoop && !plateLoop.kids.length) throw invalid('EMPTY_NEST', 'The file draws a plate with nothing nested on it.');
  if (!plateLoop && plateOutline !== false && roots[0].kids.length) {
    const r = roots[0];
    const others = roots.slice(1);
    // The other loops outside it may only be parts lying across its edge — and then it must be a plain rectangle.
    const holdsAll = others.every((l) => straddles(l, r.box)) && (!others.length || r.area >= 0.98 * (r.box.x1 - r.box.x0) * (r.box.y1 - r.box.y0));
    if (holdsAll) {
      const textInKid = raw.texts.some((t) => r.kids.some((k) => insidePoly(t.at, k.pts) || insidePoly(t.alt, k.pts)));
      // One part with its drilled holes and nothing else: every loop inside is a bare hole on the part's own layer.
      const drilled = (k) => { const c = circleOf(k.pts); return !!c && 2 * c.r <= DRILL_MAX_DIA_MM + 1e-6; };
      const onePart = !others.length && plateOutline !== true && !isPlateSize(r.box) && !textInKid && r.kids.every((k) => !k.kids.length && k.layer === r.layer && drilled(k));
      if (!onePart) plateLoop = r;
    }
  }
  let partLoops;
  let plate;
  let skeleton = null;
  if (plateLoop) {
    partLoops = plateLoop.kids.slice();
    const b = plateLoop.box;
    let across = 0; let outside = 0;
    for (const l of roots) {
      if (l === plateLoop) continue;
      // A PART ACROSS THE PLATE'S EDGE is still a part: it is returned, flagged, with how far out it reaches.
      if (!plateLoop.parent && straddles(l, b)) { l.outsideMm = Math.max(b.x0 - l.box.x0, l.box.x1 - b.x1, b.y0 - l.box.y0, l.box.y1 - b.y1, 0); partLoops.push(l); across++; } else outside++;
    }
    if (across) warnings.push(`${plural(across, 'part lies', 'parts lie')} partly off the plate.`);
    if (outside) warnings.push(`${plural(outside, 'shape', 'shapes')} drawn outside the plate ignored.`);
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
  const [ox, oy] = plate.origin;
  const local = (pts) => pts.map(([x, y]) => [r4(x - ox), r4(y - oy)]);
  plate.outline = local(plate.outline);
  plate.origin = [r4(ox / scale), r4(oy / scale)];       // where the plate's corner is in the FILE, in the file's units

  // PARTS, all the way down: a loop inside a part is its cut-out; a loop inside a cut-out is a part.
  const parts = [];
  const take = (loop, within) => {
    const part = { loop, within, inner: loop.kids, labels: [], labelFrom: null };
    parts.push(part);
    for (const cut of loop.kids) for (const nested of cut.kids) take(nested, part);
  };
  for (const l of partLoops) take(l, null);
  parts.sort((a, b) => Math.round(a.loop.box.y0) - Math.round(b.loop.box.y0) || a.loop.box.x0 - b.loop.box.x0 || a.loop.box.y0 - b.loop.box.y0);
  parts.forEach((p, i) => { p.id = `P${i + 1}`; });

  // LABELS. A text inside a part (and not in one of its openings) is that part's; then the name
  // of the block the part is an INSERT of; then, for a part still unnamed, the nearest short text.
  const bySize = parts.slice().sort((a, b) => a.loop.area - b.loop.area);
  const holder = (pt) => bySize.find((p) => pt[0] >= p.loop.box.x0 && pt[0] <= p.loop.box.x1 && pt[1] >= p.loop.box.y0 && pt[1] <= p.loop.box.y1
    && insidePoly(pt, p.loop.pts) && !p.inner.some((c) => insidePoly(pt, c.pts))) ?? null;
  const offcuts = offcutLoops.map((l) => ({ loop: l, label: null }));
  const loose = [];
  for (const t of raw.texts) {
    const lines = t.text.split('\n').map((s) => s.trim()).filter(Boolean);
    if (OFFCUT_LAYER.test(t.layer)) {
      const o = offcuts.find((c) => insidePoly(t.at, c.loop.pts));
      if (o) o.label ??= lines[0] ?? null;
      continue;
    }
    const p = holder(t.at) ?? holder(t.alt);
    if (p) { for (const s of lines) if (!p.labels.includes(s)) p.labels.push(s); p.labelFrom = 'inside'; } else loose.push({ ...t, lines });
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

  const hints = hintsFrom(loose.map((t) => t.text), filename);
  if (plate.found === 'outline' && hints.plateSize && !sizeIs({ x0: 0, y0: 0, x1: plate.length, y1: plate.width }, hints.plateSize)) {
    const d = [plate.length, plate.width].sort((a, b) => b - a);
    const ratio = hints.plateSize.length / (d[0] || 1);
    warnings.push(`The words in the file say the plate is ${hints.plateSize.length} x ${hints.plateSize.width}, but the plate drawn is ${r1(d[0])} x ${r1(d[1])}.${dxf.units == null && Math.abs(ratio - 25.4) < 0.3 ? ' The file does not say its units — it looks drawn in inches.' : ''}`);
  }

  const boxOut = (b) => ({ x: r4(b.x0 - ox), y: r4(b.y0 - oy), length: r4(b.x1 - b.x0), width: r4(b.y1 - b.y0) });
  return {
    units: UNIT_NAME[unitCode] ?? 'mm',
    plate,
    parts: parts.map((p) => {
      const cutouts = []; const holes = [];
      for (const c of p.inner) { const circ = circleOf(c.pts); (circ && 2 * circ.r <= DRILL_MAX_DIA_MM + 1e-6 ? holes : cutouts).push(local(c.pts)); }
      return {
        id: p.id,
        rings: { outline: local(p.loop.pts), cutouts, holes },
        bbox: boxOut(p.loop.box),
        area: r4(p.loop.area - p.inner.reduce((s, c) => s + c.area, 0)),
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
    warnings,
  };
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
 * @returns {{ placements, unmatched, counts, ambiguous }}
 *   placements[]: { partId, candidateKey, x, y, rotationDeg, mirrored, by: 'label'|'shape'|'size', confidence, error }
 *   ambiguous[]:  { partId, candidateKeys, options: placement[] } — the placement it would have as each
 */
export function matchNest(nest, candidates, { toleranceMm = 0.5 } = {}) {
  const tol = Number(toleranceMm) > 0 ? Number(toleranceMm) : 0.5;
  const cands = (candidates ?? []).map((c) => {
    const hasRings = ringList(c.rings).length > 0;
    const shape = shapeOf(hasRings ? c.rings : rectRings(c.length, c.width), { normalise: true });
    return {
      key: c.key, hasRings, shape,
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
    for (const w of String(label).split(/[\s,;:|()[\]=]+/)) for (const k of byCode.get(normCode(w)) ?? []) if (!out.includes(k)) out.push(k);
    return out;
  };

  const placements = []; const unmatched = []; const ambiguous = [];
  const counts = Object.fromEntries(cands.map((c) => [c.key, 0]));

  /** tier 2 = the shape itself (or a true rectangle of the right size); tier 1 = only the rectangle round it. */
  const tryFit = (c, shape) => {
    const exact = fitShape(c.shape, shape, tol);
    if (exact) return { ...exact, tier: 2, by: c.hasRings ? 'shape' : 'size' };
    if (!c.hasRings || shape.isRect) { const loose = fitSize(c, shape, tol); if (loose) return { ...loose, tier: 1, by: 'size' }; }
    return null;
  };
  const placement = (part, c, fit, by) => {
    const ratio = Math.min(1, fit.error / (fit.tolEff || tol));
    const base = fit.tier === 1 ? (by === 'label' ? 0.7 : 0.5) : by === 'label' ? 1 : by === 'shape' ? 0.9 : 0.75;
    return { partId: part.id, candidateKey: c.key, x: fit.x, y: fit.y, rotationDeg: fit.rotationDeg, mirrored: fit.mirrored, by, confidence: Math.round((base - (fit.tier === 1 ? 0 : 0.2 * ratio)) * 100) / 100, error: Math.round(fit.error * 1e3) / 1e3 };
  };

  for (const part of nest?.parts ?? []) {
    const shape = shapeOf(part.rings, { normalise: false });
    if (!shape) { unmatched.push({ partId: part.id, bbox: part.bbox, labels: part.labels ?? [], why: 'Its outline could not be read.' }); continue; }
    const size = sizeWords(shape.mbr.a, shape.mbr.b);
    const fitOf = new Map();
    const fit = (c) => { if (!fitOf.has(c)) fitOf.set(c, tryFit(c, shape)); return fitOf.get(c); };
    const best = (list) => {
      const hits = list.map((c) => ({ c, f: fit(c) })).filter((h) => h.f);
      const top = Math.max(0, ...hits.map((h) => h.f.tier));
      return hits.filter((h) => h.f.tier === top);
    };

    // 1. The label, when the shape agrees.
    const labelled = [];
    for (const l of part.labels ?? []) for (const c of named(l)) if (!labelled.includes(c)) labelled.push(c);
    const sure = part.labelFrom !== 'near';            // a text only NEAR the part is a guess at its label
    if (labelled.length) {
      const hits = best(labelled);
      if (hits.length === 1) { placements.push(placement(part, hits[0].c, hits[0].f, 'label')); counts[hits[0].c.key]++; continue; }
      if (hits.length > 1) { ambiguous.push({ partId: part.id, candidateKeys: hits.map((h) => h.c.key), options: hits.map((h) => placement(part, h.c, h.f, 'label')) }); continue; }
      if (sure) {
        const c = labelled[0];
        const other = best(cands.filter((k) => !labelled.includes(k)));
        const really = other.length ? ` It has the shape of ${other.map((h) => h.c.name).join(' or ')}.` : '';
        const their = sizeWords(c.length, c.width);
        const same = their === size;
        unmatched.push({
          partId: part.id, bbox: part.bbox, labels: part.labels,
          why: `It is labelled "${part.labels.find((l) => named(l).includes(c)) ?? c.name}", but it is not the shape of ${c.name} — ${c.name} is ${their}${same ? ' with a different outline or holes' : `, this is ${size}`}.${really}`,
        });
        continue;
      }
    }

    // 2. The shape at any angle and hand; 3. the rectangle round it.
    const hits = best(cands);
    if (hits.length === 1) { placements.push(placement(part, hits[0].c, hits[0].f, hits[0].f.by)); counts[hits[0].c.key]++; continue; }
    if (hits.length > 1) { ambiguous.push({ partId: part.id, candidateKeys: hits.map((h) => h.c.key), options: hits.map((h) => placement(part, h.c, h.f, h.f.by)) }); continue; }
    const said = (part.labels ?? []).length && !labelled.length ? `Its label "${part.labels[0]}" is not one of the codes, and none` : 'None';
    // A face closed in by cuts it shares with its neighbours, that is nobody's shape: most likely the scrap between them.
    const maybeScrap = Number(part.commonCut) > 0 && !(part.labels ?? []).length;
    unmatched.push({
      partId: part.id, bbox: part.bbox, labels: part.labels ?? [], maybeScrap,
      why: `${said} of the cut plates is this shape (${size}${shape.inner.length ? `, ${plural(shape.inner.length, 'opening', 'openings')}` : ''}).${maybeScrap ? ' It is closed in by cuts it shares with the parts round it, so it may be the scrap between parts.' : ''}`,
    });
  }
  return { placements, unmatched, counts, ambiguous };
}
