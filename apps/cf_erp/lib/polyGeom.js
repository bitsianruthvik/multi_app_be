/**
 * polyGeom.js — CF_ERP. Plane geometry for true-shape nesting.
 *
 * ── THE BOUNDARY ────────────────────────────────────────────────────────────
 * PURE. No database, no tenant, no dependency. Numbers in, numbers out, so
 * `scripts/cf_kepl/shape_packer_test.mjs` can run every function here with
 * made-up shapes.
 *
 * ── THE SHAPES ──────────────────────────────────────────────────────────────
 *   point     [x, y]                       millimetres
 *   ring      [[x, y], …]                  a closed loop. The closing point may
 *                                          or may not be repeated (partGeometry
 *                                          repeats it); `cleanRing` drops it.
 *   polygon   { outline: ring, holes: [ring] }   a solid with openings.
 *             Canonical form (what `toPolygon` returns): outline counter-
 *             clockwise, holes clockwise — the solid is always on the LEFT of
 *             the direction of travel, on every ring.
 *   rings     what partGeometry.readPartDrawing produces and what a nest
 *             placement carries. Either the array form `[outline, …inner]` or
 *             the object form `{ outline, cutouts: [ring], holes: [ring] }`.
 *             `cutouts` are openings a torch cuts (space another part may use);
 *             `holes` are drilled (material until drilled — never free space).
 *
 * ── TWO FAMILIES OF FUNCTION, KEPT APART ON PURPOSE ─────────────────────────
 * 1. EXACT MEASURES on the rings as given — area, distance, overlap, inside.
 *    These are what `verifyLayout` is built from. They share no code with the
 *    packer's placement engine: a checker that reuses the packer's machinery
 *    reuses its bugs.
 * 2. CONSTRUCTIONS the packer places with — convex decomposition, the convex
 *    Minkowski difference, offsetting, and a scan-line boolean. Every one of
 *    them errs OUTWARD when it has to approximate (a round corner becomes the
 *    polygon that circumscribes it), so a layout built on them can only be
 *    slightly looser than necessary, never tighter.
 *
 * ── TOLERANCE ───────────────────────────────────────────────────────────────
 * Drawings arrive rounded to 0.1 mm and arcs arrive as 5° chords, so rings are
 * full of near-collinear points and very short segments. Nothing here divides
 * by a segment length without checking it, and every predicate takes its
 * tolerance explicitly. TOL (1e-7 mm) is "the same point"; it is a tenth of a
 * nanometre of steel and is never a physical clearance.
 */

export const TOL = 1e-7;
const YT = 1e-9; // two scan-line levels closer than this are one level

/* ───────────────────────────── points and rings ────────────────────────── */

const cross = (ax, ay, bx, by) => ax * by - ay * bx;

/**
 * A ring without its repeated closing point, without repeated points and
 * without points that lie on the straight line between their neighbours.
 * May return fewer than three points — callers decide what that means.
 */
export function cleanRing(pts, tol = TOL) {
  const out = [];
  for (const p of pts ?? []) {
    const x = Number(p[0]); const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const q = out[out.length - 1];
    if (q && Math.abs(x - q[0]) <= tol && Math.abs(y - q[1]) <= tol) continue;
    out.push([x, y]);
  }
  const same = (p, q) => Math.abs(p[0] - q[0]) <= tol && Math.abs(p[1] - q[1]) <= tol;
  while (out.length > 1 && same(out[0], out[out.length - 1])) out.pop();
  // b is on the line a–c (or a and c coincide and b is a spike).
  const straight = (a, b, c) => {
    const acx = c[0] - a[0]; const acy = c[1] - a[1];
    const len = Math.hypot(acx, acy);
    return len <= tol || Math.abs(cross(acx, acy, b[0] - a[0], b[1] - a[1])) / len <= tol;
  };
  // One pass with a stack (a region's outline can be tens of thousands of points), then the seam.
  const st = [];
  for (const p of out) {
    while (st.length >= 2 && straight(st[st.length - 2], st[st.length - 1], p)) st.pop();
    if (st.length && same(st[st.length - 1], p)) continue;
    st.push(p);
  }
  let lo = 0; let hi = st.length; // the live ring is st[lo .. hi)
  for (let changed = true; changed && hi - lo >= 3;) {
    changed = false;
    if (same(st[lo], st[hi - 1]) || straight(st[hi - 2], st[hi - 1], st[lo])) { hi -= 1; changed = true; continue; }
    if (straight(st[hi - 1], st[lo], st[lo + 1])) { lo += 1; changed = true; }
  }
  return lo === 0 && hi === st.length ? st : st.slice(lo, hi);
}

/** Signed area: positive when the ring runs counter-clockwise. */
export function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i += 1) {
    const p = ring[i]; const q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export const ringArea = (ring) => Math.abs(signedArea(ring));

export function ringPerimeter(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i += 1) {
    const p = ring[i]; const q = ring[(i + 1) % n];
    s += Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  return s;
}

/** `{ x0, y0, x1, y1 }` — the same shape partGeometry's bboxOf uses. */
export function bboxOfRing(ring) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const p of ring) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return { x0, y0, x1, y1 };
}

export function bboxOfRings(rings) {
  let b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const r of rings) {
    const c = bboxOfRing(r);
    b = { x0: Math.min(b.x0, c.x0), y0: Math.min(b.y0, c.y0), x1: Math.max(b.x1, c.x1), y1: Math.max(b.y1, c.y1) };
  }
  return b;
}

/** The ring running counter-clockwise (`ccw` true) or clockwise. A new array. */
export function orientRing(ring, ccw = true) {
  const r = ring.slice();
  if ((signedArea(r) > 0) !== ccw) r.reverse();
  return r;
}

/* ─────────────────────────────── ring forms ────────────────────────────── */

/** Either accepted form of `rings` as `{ outline, cutouts, holes }` (raw rings, untouched). */
export function ringsObject(rings) {
  if (!rings) return null;
  if (Array.isArray(rings)) {
    if (!rings.length) return null;
    // A bare ring ([[x,y],…]) is taken as the outline alone.
    if (typeof rings[0]?.[0] === 'number') return { outline: rings, cutouts: [], holes: [] };
    return { outline: rings[0], cutouts: rings.slice(1), holes: [] };
  }
  if (!rings.outline) return null;
  return { outline: rings.outline, cutouts: rings.cutouts ?? [], holes: rings.holes ?? [] };
}

/**
 * The canonical polygon of a part: outline counter-clockwise, cut-outs as
 * clockwise holes. Drilled holes are NOT openings (see the header) unless
 * `drilledAsHoles` asks for them. Returns null when the outline has no area.
 */
export function toPolygon(rings, { cutouts = true, drilledAsHoles = false } = {}) {
  const o = ringsObject(rings);
  if (!o) return null;
  const outline = orientRing(cleanRing(o.outline), true);
  if (outline.length < 3 || ringArea(outline) <= TOL) return null;
  const holes = [];
  const inner = cutouts ? [...o.cutouts, ...(drilledAsHoles ? o.holes : [])] : [];
  for (const h of inner) {
    const r = cleanRing(h);
    if (r.length >= 3 && ringArea(r) > TOL) holes.push(orientRing(r, false));
  }
  return { outline, holes };
}

/** Area of the solid: the outline less its holes. */
export function polygonArea(poly) {
  let a = ringArea(poly.outline);
  for (const h of poly.holes ?? []) a -= ringArea(h);
  return a;
}

const polyRings = (poly) => (poly.holes && poly.holes.length ? [poly.outline, ...poly.holes] : [poly.outline]);

/* ─────────────────────────────── transforms ────────────────────────────── */

/**
 * cos and sin of an angle in degrees, EXACT at the quarter turns. A plate part
 * turned 90° must keep its integer millimetres: cos(90°) is 6e-17 in floating
 * point, and that is how a 2500 mm part comes to measure 2500.0000000000005
 * and stop fitting a 2500 mm plate.
 */
export function cosSin(deg) {
  const d = ((Number(deg) % 360) + 360) % 360;
  if (d === 0) return [1, 0];
  if (d === 90) return [0, 1];
  if (d === 180) return [-1, 0];
  if (d === 270) return [0, -1];
  const t = (d * Math.PI) / 180;
  return [Math.cos(t), Math.sin(t)];
}

/**
 * Mirror (about the y axis, x → −x), THEN rotate counter-clockwise about the
 * origin, THEN translate. A mirrored ring comes back with its direction
 * reversed — re-orient it if direction matters.
 */
export function transformRing(ring, { rotationDeg = 0, mirrored = false, dx = 0, dy = 0 } = {}) {
  const [c, s] = cosSin(rotationDeg);
  const out = new Array(ring.length);
  for (let i = 0; i < ring.length; i += 1) {
    const x = mirrored ? -ring[i][0] : ring[i][0];
    const y = ring[i][1];
    out[i] = [c * x - s * y + dx, s * x + c * y + dy];
  }
  return out;
}

export const rotateRing = (ring, deg) => transformRing(ring, { rotationDeg: deg });
export const mirrorRing = (ring) => transformRing(ring, { mirrored: true });
export const translateRing = (ring, dx, dy) => transformRing(ring, { dx, dy });

export function transformPolygon(poly, t) {
  const flip = !!t?.mirrored;
  const fix = (r, ccw) => (flip ? orientRing(transformRing(r, t), ccw) : transformRing(r, t));
  return { outline: fix(poly.outline, true), holes: (poly.holes ?? []).map((h) => fix(h, false)) };
}

/* ─────────────────────────── exact measurements ────────────────────────── */

/** Even–odd: is the point inside the ring? (A point ON the ring may go either way.) */
export function pointInRing(pt, ring) {
  let c = false;
  const px = pt[0]; const py = pt[1];
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i, i += 1) {
    const xi = ring[i][0]; const yi = ring[i][1]; const xj = ring[j][0]; const yj = ring[j][1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export function pointSegDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Shortest distance from a point to a ring's boundary. */
export function pointRingDistance(pt, ring) {
  let best = Infinity;
  for (let i = 0, n = ring.length; i < n; i += 1) {
    const a = ring[i]; const b = ring[(i + 1) % n];
    const d = pointSegDistance(pt[0], pt[1], a[0], a[1], b[0], b[1]);
    if (d < best) best = d;
  }
  return best;
}

/** Shortest distance between two segments; 0 when they cross or touch. */
export function segSegDistance(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = cross(bx - ax, by - ay, cx - ax, cy - ay);
  const d2 = cross(bx - ax, by - ay, dx - ax, dy - ay);
  const d3 = cross(dx - cx, dy - cy, ax - cx, ay - cy);
  const d4 = cross(dx - cx, dy - cy, bx - cx, by - cy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(
    pointSegDistance(ax, ay, cx, cy, dx, dy), pointSegDistance(bx, by, cx, cy, dx, dy),
    pointSegDistance(cx, cy, ax, ay, bx, by), pointSegDistance(dx, dy, ax, ay, bx, by),
  );
}

/** Is the point in the solid of the polygon (inside the outline, in no hole)? Even–odd. */
export function pointInPolygon(pt, poly) {
  if (!pointInRing(pt, poly.outline)) return false;
  for (const h of poly.holes ?? []) if (pointInRing(pt, h)) return false;
  return true;
}

/** Shortest distance from a point to any boundary of the polygon. */
export function pointPolygonBoundaryDistance(pt, poly) {
  let best = pointRingDistance(pt, poly.outline);
  for (const h of poly.holes ?? []) best = Math.min(best, pointRingDistance(pt, h));
  return best;
}

/** In the solid AND more than `tol` from every boundary. */
function strictlyInside(pt, poly, tol) {
  return pointInPolygon(pt, poly) && pointPolygonBoundaryDistance(pt, poly) > tol;
}

/** Edge list of a polygon with a bounding box per edge, for pruning pair tests. */
function edgesOf(poly) {
  const out = [];
  for (const ring of polyRings(poly)) {
    for (let i = 0, n = ring.length; i < n; i += 1) {
      const a = ring[i]; const b = ring[(i + 1) % n];
      out.push({
        ax: a[0], ay: a[1], bx: b[0], by: b[1],
        x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]),
      });
    }
  }
  return out;
}

export function bboxOfPolygon(poly) { return bboxOfRing(poly.outline); }

const bboxGap = (a, b) => Math.hypot(Math.max(0, a.x0 - b.x1, b.x0 - a.x1), Math.max(0, a.y0 - b.y1, b.y0 - a.y1));

/** A point strictly inside the solid (the middle of the widest span of its tallest slab). */
export function interiorPoint(poly) {
  const ys = [...new Set(poly.outline.map((p) => p[1]))].sort((a, b) => a - b);
  let best = null;
  // The few tallest slabs are tried in turn; one of them always has an open span.
  const slabs = [];
  for (let i = 0; i + 1 < ys.length; i += 1) slabs.push([ys[i + 1] - ys[i], (ys[i] + ys[i + 1]) / 2]);
  slabs.sort((a, b) => b[0] - a[0]);
  for (const [, ym] of slabs.slice(0, 4)) {
    const xs = [];
    for (const ring of polyRings(poly)) {
      for (let i = 0, n = ring.length; i < n; i += 1) {
        const a = ring[i]; const b = ring[(i + 1) % n];
        if ((a[1] > ym) !== (b[1] > ym)) xs.push(a[0] + ((b[0] - a[0]) * (ym - a[1])) / (b[1] - a[1]));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const w = xs[i + 1] - xs[i];
      if (!best || w > best.w) best = { w, pt: [(xs[i] + xs[i + 1]) / 2, ym] };
    }
    if (best && best.w > 1e-6) break;
  }
  return best ? best.pt : null;
}

/** Parameters along edge P (0…1) at which edge Q meets it, pushed onto `out`. */
function meetParams(e, f, out) {
  const rx = e.bx - e.ax; const ry = e.by - e.ay;
  const sx = f.bx - f.ax; const sy = f.by - f.ay;
  const qx = f.ax - e.ax; const qy = f.ay - e.ay;
  const den = cross(rx, ry, sx, sy);
  const rl = Math.hypot(rx, ry); const sl = Math.hypot(sx, sy);
  if (rl <= 0) return;
  if (Math.abs(den) > 1e-12 * rl * sl) {
    const t = cross(qx, qy, sx, sy) / den;
    const u = cross(qx, qy, rx, ry) / den;
    if (t > -1e-9 && t < 1 + 1e-9 && u > -1e-9 && u < 1 + 1e-9) out.push(Math.min(1, Math.max(0, t)));
    return;
  }
  // Parallel. Only a collinear overlap matters, and its ends split P.
  if (Math.abs(cross(qx, qy, rx, ry)) / rl > 1e-7) return;
  const t0 = (qx * rx + qy * ry) / (rl * rl);
  const t1 = ((f.bx - e.ax) * rx + (f.by - e.ay) * ry) / (rl * rl);
  if (t0 > 0 && t0 < 1) out.push(t0);
  if (t1 > 0 && t1 < 1) out.push(t1);
}

/** Does any stretch of A's boundary run through the open interior of B's solid? */
function boundaryEnters(ea, eb, polyB, tol) {
  const ts = [];
  for (const e of ea) {
    ts.length = 0;
    ts.push(0, 1);
    for (const f of eb) {
      if (e.x0 > f.x1 + tol || f.x0 > e.x1 + tol || e.y0 > f.y1 + tol || f.y0 > e.y1 + tol) continue;
      meetParams(e, f, ts);
    }
    ts.sort((a, b) => a - b);
    for (let i = 0; i + 1 < ts.length; i += 1) {
      if (ts[i + 1] - ts[i] <= 1e-12) continue;
      const t = (ts[i] + ts[i + 1]) / 2;
      if (strictlyInside([e.ax + t * (e.bx - e.ax), e.ay + t * (e.by - e.ay)], polyB, tol)) return true;
    }
  }
  return false;
}

/**
 * Do the two SOLIDS share area — more than a sliver `tol` deep?
 *
 * Touching does not count: two parts cut edge to edge share a boundary and no
 * steel. Three ways to share area, and each needs its own test:
 *   - a boundary of one runs through the interior of the other (the usual case,
 *     and the one that catches two equal rectangles slid half-way over each
 *     other, where no vertex is inside anything and no two edges cross);
 *   - one lies wholly inside the other (no boundary meets a boundary);
 *   - the two are the same shape in the same place (every boundary lies ON a
 *     boundary) — caught by an interior point.
 * A part sitting in another part's cut-out is none of these and is not an overlap.
 */
export function polygonsOverlap(A, B, tol = TOL) {
  const ba = bboxOfPolygon(A); const bb = bboxOfPolygon(B);
  if (ba.x0 >= bb.x1 - tol || bb.x0 >= ba.x1 - tol || ba.y0 >= bb.y1 - tol || bb.y0 >= ba.y1 - tol) return false;
  const ea = edgesOf(A); const eb = edgesOf(B);
  if (boundaryEnters(ea, eb, B, tol) || boundaryEnters(eb, ea, A, tol)) return true;
  const pa = interiorPoint(A);
  if (pa && strictlyInside(pa, B, tol)) return true;
  const pb = interiorPoint(B);
  if (pb && strictlyInside(pb, A, tol)) return true;
  return false;
}

/**
 * Shortest distance between the BOUNDARIES of two polygons (every ring of
 * each). 0 when they touch or cross. For two solids that do not overlap this
 * is the gap between them — including a part inside another's cut-out, where
 * the gap is measured to the cut-out's edge.
 *
 * `cutoff`: pairs of edges whose boxes are at least this far apart are skipped,
 * so a return value >= cutoff only means "at least cutoff".
 */
export function polygonsDistance(A, B, cutoff = Infinity) {
  let best = cutoff;
  const ea = edgesOf(A); const eb = edgesOf(B);
  for (const e of ea) {
    for (const f of eb) {
      if (bboxGap(e, f) >= best) continue;
      const d = segSegDistance(e.ax, e.ay, e.bx, e.by, f.ax, f.ay, f.bx, f.by);
      if (d < best) { best = d; if (best <= 0) return 0; }
    }
  }
  return best;
}

/**
 * Is `inner` (its outline) wholly inside the solid of `outer`, and how far from
 * outer's boundary does it stay?  → { inside, clearance }
 * `inside` is false as soon as any stretch of inner's outline runs outside.
 */
export function polygonInside(inner, outer, tol = TOL) {
  const ea = edgesOf({ outline: inner.outline, holes: [] });
  const eb = edgesOf(outer);
  const ts = [];
  for (const e of ea) {
    ts.length = 0;
    ts.push(0, 1);
    for (const f of eb) {
      if (e.x0 > f.x1 + tol || f.x0 > e.x1 + tol || e.y0 > f.y1 + tol || f.y0 > e.y1 + tol) continue;
      meetParams(e, f, ts);
    }
    ts.sort((a, b) => a - b);
    for (let i = 0; i + 1 < ts.length; i += 1) {
      if (ts[i + 1] - ts[i] <= 1e-12) continue;
      const t = (ts[i] + ts[i + 1]) / 2;
      const pt = [e.ax + t * (e.bx - e.ax), e.ay + t * (e.by - e.ay)];
      if (!pointInPolygon(pt, outer) && pointPolygonBoundaryDistance(pt, outer) > tol) return { inside: false, clearance: 0 };
    }
  }
  // An opening of outer that inner surrounds: inner's outline never enters it, but its body covers it.
  for (const h of outer.holes ?? []) if (pointInRing(h[0], inner.outline) && pointRingDistance(h[0], inner.outline) > tol) return { inside: false, clearance: 0 };
  return { inside: true, clearance: polygonsDistance({ outline: inner.outline, holes: [] }, outer) };
}

/* ──────────────────────────────── convexity ────────────────────────────── */

/** Convex hull, counter-clockwise, no collinear points (Andrew's monotone chain). */
export function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const n = pts.length;
  if (n < 3) return cleanRing(pts);
  const h = [];
  for (let i = 0; i < n; i += 1) {
    while (h.length >= 2) {
      const a = h[h.length - 2]; const b = h[h.length - 1];
      if (cross(b[0] - a[0], b[1] - a[1], pts[i][0] - b[0], pts[i][1] - b[1]) <= 0) h.pop(); else break;
    }
    h.push(pts[i]);
  }
  const lower = h.length + 1;
  for (let i = n - 2; i >= 0; i -= 1) {
    while (h.length >= lower) {
      const a = h[h.length - 2]; const b = h[h.length - 1];
      if (cross(b[0] - a[0], b[1] - a[1], pts[i][0] - b[0], pts[i][1] - b[1]) <= 0) h.pop(); else break;
    }
    h.push(pts[i]);
  }
  h.pop();
  return cleanRing(h);
}

/** Is the ring convex (either direction), to within `tol` mm of straight at each corner? */
export function isConvex(ring, tol = TOL) {
  const n = ring.length;
  if (n < 3) return false;
  const sgn = signedArea(ring) > 0 ? 1 : -1;
  for (let i = 0; i < n; i += 1) {
    const a = ring[i]; const b = ring[(i + 1) % n]; const c = ring[(i + 2) % n];
    const l = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
    if ((sgn * cross(b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1])) / l < -tol) return false;
  }
  return true;
}

/**
 * A ⊕ (−B) for two convex rings: every vector a − b. With A fixed and B placed
 * at translation t, B's interior meets A's interior exactly when t is strictly
 * inside this polygon — the no-fit polygon of the pair.
 *
 * Built as the hull of the pairwise differences rather than by merging the two
 * edge sequences. The merge is the textbook answer and is linear, but it has to
 * be told what to do about parallel edges and repeated points, and a plate
 * drawing is made of those; the hull cannot be confused by them and the pair is
 * computed once and cached.
 */
export function minkowskiDiffConvex(A, B) {
  const pts = [];
  for (const a of A) for (const b of B) pts.push([a[0] - b[0], a[1] - b[1]]);
  return convexHull(pts);
}

/**
 * A convex ring grown by `d` on every side.
 *
 * The true offset has ROUND corners. This returns the polygon that
 * CIRCUMSCRIBES them — each corner is turned in steps of at most `maxTurnDeg`
 * by lines tangent to the corner's arc — so it contains the true offset and is
 * never more than d·(1/cos(maxTurn/2) − 1) outside it (3.5% of d at 30°).
 * Straight sides are offset exactly.
 */
export function offsetConvex(ring, d, maxTurnDeg = 30) {
  if (!(d > 0)) return ring.map((p) => [p[0], p[1]]);
  const r = orientRing(ring, true);
  const n = r.length;
  const out = [];
  if (n === 1) {
    const m = Math.ceil(360 / maxTurnDeg); const rad = d / Math.cos(Math.PI / m);
    for (let s = 0; s < m; s += 1) out.push([r[0][0] + rad * Math.cos((2 * Math.PI * s) / m), r[0][1] + rad * Math.sin((2 * Math.PI * s) / m)]);
    return out;
  }
  const maxTurn = (maxTurnDeg * Math.PI) / 180;
  for (let i = 0; i < n; i += 1) {
    const a = r[(i + n - 1) % n]; const v = r[i]; const b = r[(i + 1) % n];
    const ix = v[0] - a[0]; const iy = v[1] - a[1];
    const ox = b[0] - v[0]; const oy = b[1] - v[1];
    let phi = Math.atan2(cross(ix, iy, ox, oy), ix * ox + iy * oy);
    if (phi < 0) phi = 0; // a hair of concavity from rounding: treat as straight
    const a0 = Math.atan2(iy, ix) - Math.PI / 2; // outward normal of the incoming edge
    if (phi < 1e-12) { out.push([v[0] + d * Math.cos(a0), v[1] + d * Math.sin(a0)]); continue; }
    const m = Math.max(1, Math.ceil(phi / maxTurn - 1e-9));
    const step = phi / m;
    const rad = d / Math.cos(step / 2);
    for (let s = 0; s < m; s += 1) {
      const t = a0 + (s + 0.5) * step;
      out.push([v[0] + rad * Math.cos(t), v[1] + rad * Math.sin(t)]);
    }
  }
  return out;
}

/* ───────────────────────────── the scan-line ───────────────────────────── */
/*
 * ONE PRIMITIVE DOES THE CONVEX DECOMPOSITION, THE BOOLEANS AND THE OFFSETS.
 *
 * Cut the plane with a horizontal line through every vertex (and, when shapes
 * may cross, every crossing). Between two neighbouring lines no edge starts,
 * ends or crosses another, so the edges that span the slab are simply ordered
 * left to right, and walking them while counting which shapes we are inside
 * splits the slab into trapezoids. That is the whole algorithm: a sort per
 * slab. It needs no triangulation, no hole bridging and no notion of which way
 * a ring runs, so there is nothing in it for a near-degenerate drawing to break.
 *
 * `polys` is `[{ rings: [ring, …], group }]`. A point is inside a poly by
 * EVEN–ODD over that poly's rings (so an outline with holes is just its rings),
 * and `counts[g]` is how many polys of group g contain it. `keep(counts)`
 * decides whether a cell is part of the answer:
 *     union          (c) => c[0] > 0
 *     A minus B      (c) => c[0] > 0 && c[1] === 0
 *     A and B        (c) => c[0] > 0 && c[1] > 0
 */
export function scanCells(polys, keep, { intersections = true, groups = 1 } = {}) {
  const edges = [];
  const ysRaw = [];
  let nGroups = groups;
  for (let pi = 0; pi < polys.length; pi += 1) {
    const g = polys[pi].group | 0;
    if (g + 1 > nGroups) nGroups = g + 1;
    for (const ring of polys[pi].rings) {
      for (let i = 0, n = ring.length; i < n; i += 1) {
        const a = ring[i]; const b = ring[(i + 1) % n];
        ysRaw.push(a[1]);
        if (Math.abs(a[1] - b[1]) <= YT) continue; // horizontal: it lies on a level
        if (a[1] < b[1]) edges.push({ x0: a[0], y0: a[1], x1: b[0], y1: b[1], p: pi, g, xa: 0, xb: 0, xm: 0 });
        else edges.push({ x0: b[0], y0: b[1], x1: a[0], y1: a[1], p: pi, g, xa: 0, xb: 0, xm: 0 });
      }
    }
  }
  edges.sort((a, b) => a.y0 - b.y0);
  const E = edges.length;

  if (intersections) {
    for (let i = 0; i < E; i += 1) {
      const e = edges[i];
      const ex0 = Math.min(e.x0, e.x1); const ex1 = Math.max(e.x0, e.x1);
      for (let j = i + 1; j < E && edges[j].y0 < e.y1; j += 1) {
        const f = edges[j];
        if (f.p === e.p) continue;
        if (Math.min(f.x0, f.x1) > ex1 || Math.max(f.x0, f.x1) < ex0) continue;
        const rx = e.x1 - e.x0; const ry = e.y1 - e.y0; const sx = f.x1 - f.x0; const sy = f.y1 - f.y0;
        const den = cross(rx, ry, sx, sy);
        if (Math.abs(den) <= 1e-14 * (Math.abs(rx) + Math.abs(ry)) * (Math.abs(sx) + Math.abs(sy))) continue;
        const t = cross(f.x0 - e.x0, f.y0 - e.y0, sx, sy) / den;
        const u = cross(f.x0 - e.x0, f.y0 - e.y0, rx, ry) / den;
        if (t > 0 && t < 1 && u > 0 && u < 1) ysRaw.push(e.y0 + t * ry);
      }
    }
  }

  ysRaw.sort((a, b) => a - b);
  const ys = [];
  for (const y of ysRaw) if (!ys.length || y - ys[ys.length - 1] > YT) ys.push(y);

  const xAt = (e, y) => (y <= e.y0 ? e.x0 : y >= e.y1 ? e.x1 : e.x0 + ((e.x1 - e.x0) * (y - e.y0)) / (e.y1 - e.y0));
  const par = new Uint8Array(polys.length);
  const cnt = new Int32Array(nGroups);
  const cells = [];
  let ptr = 0;
  let active = [];
  for (let s = 0; s + 1 < ys.length; s += 1) {
    const ya = ys[s]; const yb = ys[s + 1]; const ym = (ya + yb) / 2;
    while (ptr < E && edges[ptr].y0 < ym) { active.push(edges[ptr]); ptr += 1; }
    let w = 0;
    for (let i = 0; i < active.length; i += 1) if (active[i].y1 > ym) { active[w] = active[i]; w += 1; }
    active.length = w;
    if (!w) continue;
    for (let i = 0; i < w; i += 1) {
      const e = active[i];
      e.xa = xAt(e, ya); e.xb = xAt(e, yb); e.xm = (e.xa + e.xb) / 2;
    }
    const row = active.slice().sort((a, b) => a.xm - b.xm || a.xa - b.xa || a.xb - b.xb);
    let on = false;
    let lxa = 0; let lxb = 0;
    let pend = null; // a cell closed at an edge the next cell may reopen at (two shapes abutting)
    for (let i = 0; i < row.length; i += 1) {
      const e = row[i];
      if (par[e.p]) { par[e.p] = 0; cnt[e.g] -= 1; } else { par[e.p] = 1; cnt[e.g] += 1; }
      const now = !!keep(cnt);
      if (now && !on) {
        on = true;
        if (pend && Math.abs(pend.rxa - e.xa) <= TOL && Math.abs(pend.rxb - e.xb) <= TOL) {
          lxa = pend.lxa; lxb = pend.lxb; pend = null; // same line: the cell carries on
        } else {
          if (pend) { cells.push(pend); pend = null; }
          lxa = e.xa; lxb = e.xb;
        }
      } else if (!now && on) {
        on = false;
        if (Math.abs(e.xa - lxa) > TOL || Math.abs(e.xb - lxb) > TOL) {
          pend = { s, ya, yb, lxa, lxb, rxa: e.xa, rxb: e.xb };
        }
      }
    }
    if (pend) cells.push(pend);
    for (let i = 0; i < row.length; i += 1) par[row[i].p] = 0;
    cnt.fill(0);
  }
  return { cells, ys };
}

/**
 * Trapezoid cells glued, slab over slab, into convex pieces. A cell joins the
 * piece below it when they share their whole common edge and the union is still
 * convex — which is what turns the two slabs of a triangle back into the
 * triangle and the dozens of slabs of a circle back into one polygon.
 */
function cellsToConvex(cells) {
  const pieces = [];
  let open = []; // pieces whose top is the current level
  let level = -1;
  let next = [];
  for (const c of cells) {
    if (c.s !== level) {
      open = c.s === level + 1 ? next : [];
      next = [];
      level = c.s;
    }
    let host = null;
    if (c.rxa - c.lxa > TOL) {
      for (const p of open) {
        if (p.taken || Math.abs(p.topL - c.lxa) > TOL || Math.abs(p.topR - c.rxa) > TOL) continue;
        const L = p.left; const R = p.right;
        const l1 = L[L.length - 2]; const l2 = L[L.length - 1];
        const r1 = R[R.length - 2]; const r2 = R[R.length - 1];
        // Going up: the left side may only bend right, the right side only left.
        const cl = cross(l2[0] - l1[0], l2[1] - l1[1], c.lxb - l2[0], c.yb - l2[1]);
        const cr = cross(r2[0] - r1[0], r2[1] - r1[1], c.rxb - r2[0], c.yb - r2[1]);
        const sl = 1e-9 * (Math.hypot(l2[0] - l1[0], l2[1] - l1[1]) + 1) * (c.yb - c.ya + 1);
        if (cl <= sl && cr >= -sl) { host = p; break; }
      }
    }
    if (host) {
      host.taken = true;
      host.left.push([c.lxb, c.yb]); host.right.push([c.rxb, c.yb]);
      const p = { left: host.left, right: host.right, topL: c.lxb, topR: c.rxb, taken: false, ref: host.ref };
      next.push(p);
    } else {
      const ref = { left: [[c.lxa, c.ya], [c.lxb, c.yb]], right: [[c.rxa, c.ya], [c.rxb, c.yb]] };
      pieces.push(ref);
      next.push({ left: ref.left, right: ref.right, topL: c.lxb, topR: c.rxb, taken: false, ref });
    }
  }
  const out = [];
  for (const p of pieces) {
    const ring = convexHull([...p.left, ...p.right]);
    if (ring.length >= 3 && ringArea(ring) > 1e-9) out.push(ring);
  }
  return out;
}

/**
 * The solid of a polygon (holes honoured) as convex pieces that exactly tile
 * it. Slabs are cut both ways — across and along — and the smaller answer is
 * kept: an L drawn one way round is two pieces and three the other.
 */
export function convexDecompose(poly) {
  const rings = polyRings(poly);
  const a = cellsToConvex(scanCells([{ rings, group: 0 }], (c) => c[0] > 0, { intersections: false }).cells);
  if (a.length <= 1) return a;
  const swap = (ring) => ring.map((p) => [p[1], p[0]]);
  const b = cellsToConvex(scanCells([{ rings: rings.map(swap), group: 0 }], (c) => c[0] > 0, { intersections: false }).cells)
    .map((ring) => orientRing(swap(ring), true));
  return b.length < a.length ? b : a;
}

/**
 * Points that are "the same" share an id, even when rounding put them a hair
 * apart. Every corner of a cell lies exactly on a scan-line level, so a point is
 * looked up by its LEVEL and its x alone — an integer key, three probes.
 */
function pointIndex() {
  const Q = 1e-6;
  const levels = new Map();
  const pts = [];
  return {
    pts,
    id(level, x, y) {
      let m = levels.get(level);
      if (!m) { m = new Map(); levels.set(level, m); }
      const ix = Math.round(x / Q);
      for (let d = -1; d <= 1; d += 1) {
        const hit = m.get(ix + d);
        if (hit !== undefined && Math.abs(pts[hit][0] - x) <= Q / 2) return hit;
      }
      pts.push([x, y]);
      m.set(ix, pts.length - 1);
      return pts.length - 1;
    },
  };
}

/**
 * The outline of a set of cells: `[{ outline, holes, area, bbox }]`, one per
 * connected region, outline counter-clockwise and holes clockwise.
 *
 * A cell's sloping sides are boundary by construction. Its flat sides are
 * boundary only where no cell lies against them on the other side of the level,
 * so those are found by subtracting, on each level, the tops of the cells below
 * from the bottoms of the cells above (and the other way round).
 */
function cellsToRegions(cells, ys, minArea = 1e-9) {
  const index = pointIndex();
  const segs = [];
  const add = (l1, x1, y1, l2, x2, y2) => {
    const a = index.id(l1, x1, y1); const b = index.id(l2, x2, y2);
    if (a !== b) segs.push({ a, b, used: false });
  };
  const bottoms = new Map(); const tops = new Map();
  const put = (m, k, v) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
  for (const c of cells) {
    add(c.s + 1, c.lxb, c.yb, c.s, c.lxa, c.ya); // left side, downwards: the solid is on its left
    add(c.s, c.rxa, c.ya, c.s + 1, c.rxb, c.yb); // right side, upwards
    if (c.rxa - c.lxa > TOL) put(bottoms, c.s, [c.lxa, c.rxa]);
    if (c.rxb - c.lxb > TOL) put(tops, c.s + 1, [c.lxb, c.rxb]);
  }
  const levels = new Set([...bottoms.keys(), ...tops.keys()]);
  for (const lv of levels) {
    const y = ys[lv];
    const B = bottoms.get(lv) ?? []; const T = tops.get(lv) ?? [];
    const xsRaw = [];
    for (const iv of B) xsRaw.push(iv[0], iv[1]);
    for (const iv of T) xsRaw.push(iv[0], iv[1]);
    xsRaw.sort((a, b) => a - b);
    const xs = [];
    for (const x of xsRaw) if (!xs.length || x - xs[xs.length - 1] > TOL) xs.push(x);
    for (let i = 0; i + 1 < xs.length; i += 1) {
      const xm = (xs[i] + xs[i + 1]) / 2;
      let inB = false; let inT = false;
      for (const iv of B) if (iv[0] < xm && xm < iv[1]) { inB = true; break; }
      for (const iv of T) if (iv[0] < xm && xm < iv[1]) { inT = true; break; }
      if (inB && !inT) add(lv, xs[i], y, lv, xs[i + 1], y);
      else if (inT && !inB) add(lv, xs[i + 1], y, lv, xs[i], y);
    }
  }

  const outOf = new Map();
  segs.forEach((s, i) => { const l = outOf.get(s.a); if (l) l.push(i); else outOf.set(s.a, [i]); });
  const P = index.pts;
  const rings = [];
  for (let s0 = 0; s0 < segs.length; s0 += 1) {
    if (segs[s0].used) continue;
    const start = segs[s0].a;
    const ring = [];
    let cur = s0;
    let guard = segs.length + 4;
    let closed = false;
    while (guard > 0) {
      guard -= 1;
      const sg = segs[cur];
      sg.used = true;
      ring.push(P[sg.a]);
      if (sg.b === start) { closed = true; break; }
      // Where two corners of the region touch, take the sharpest LEFT turn: that
      // stays with the patch of solid we are walking round.
      const cand = (outOf.get(sg.b) ?? []).filter((i) => !segs[i].used);
      if (!cand.length) break;
      let pick = cand[0];
      if (cand.length > 1) {
        const dx = P[sg.b][0] - P[sg.a][0]; const dy = P[sg.b][1] - P[sg.a][1];
        let bestTurn = -Infinity;
        for (const i of cand) {
          const ex = P[segs[i].b][0] - P[segs[i].a][0]; const ey = P[segs[i].b][1] - P[segs[i].a][1];
          const turn = Math.atan2(cross(dx, dy, ex, ey), dx * ex + dy * ey);
          if (turn > bestTurn) { bestTurn = turn; pick = i; }
        }
      }
      cur = pick;
    }
    if (closed) {
      const r = cleanRing(ring);
      if (r.length >= 3) rings.push(r);
    }
  }

  const outers = []; const holes = [];
  for (const r of rings) {
    const a = signedArea(r);
    if (a > minArea) outers.push({ outline: r, holes: [], area: a, bbox: bboxOfRing(r) });
    else if (a < -minArea) holes.push({ ring: r, area: -a, bbox: bboxOfRing(r) });
  }
  outers.sort((a, b) => a.area - b.area);
  for (const h of holes) {
    const m = [(h.ring[0][0] + h.ring[1][0]) / 2, (h.ring[0][1] + h.ring[1][1]) / 2];
    for (const o of outers) {
      if (o.area <= h.area) continue;
      if (h.bbox.x0 < o.bbox.x0 - TOL || h.bbox.x1 > o.bbox.x1 + TOL || h.bbox.y0 < o.bbox.y0 - TOL || h.bbox.y1 > o.bbox.y1 + TOL) continue;
      if (pointInRing(m, o.outline) || pointInRing(h.ring[0], o.outline)) { o.holes.push(h.ring); o.area -= h.area; break; }
    }
  }
  return outers.filter((o) => o.area > minArea).sort((a, b) => b.area - a.area);
}

/**
 * Boolean of two SETS of polygons: 'union' (A ∪ B), 'difference' (A − B) or
 * 'intersection' (A ∩ B). Polygons within a set may overlap each other — a set
 * means "the union of these". → `[{ outline, holes, area, bbox }]`.
 */
export function booleanRegions(A, B, op = 'union', { minArea = 1e-9 } = {}) {
  const polys = [
    ...(A ?? []).map((p) => ({ rings: polyRings(p), group: 0 })),
    ...(B ?? []).map((p) => ({ rings: polyRings(p), group: 1 })),
  ];
  const keep = op === 'difference' ? (c) => c[0] > 0 && c[1] === 0
    : op === 'intersection' ? (c) => c[0] > 0 && c[1] > 0
      : (c) => c[0] > 0 || c[1] > 0;
  const { cells, ys } = scanCells(polys, keep, { groups: 2 });
  return cellsToRegions(cells, ys, minArea);
}

/**
 * The polygon grown (d > 0) or shrunk (d < 0) by |d|. → an array of polygons
 * `[{ outline, holes, area, bbox }]`: growing can close a hole or merge
 * nothing, shrinking can split a shape in two or remove it altogether.
 *
 * ROUND CORNERS ARE CIRCUMSCRIBED (see offsetConvex), so the result errs toward
 * MORE clearance: a grown shape is a hair larger than the true offset and a
 * shrunk one a hair smaller. That is the safe direction for both uses here —
 * the kerf halo round a part and the usable area inside a plate's rim.
 */
export function offsetPolygon(poly, d, { maxTurnDeg = 30 } = {}) {
  // Takes a POLYGON ({ outline, holes } — holes are openings). Turn a part's rings into one with toPolygon first.
  const p = poly && poly.outline ? { outline: orientRing(cleanRing(poly.outline), true), holes: (poly.holes ?? []).map((h) => orientRing(cleanRing(h), false)) } : null;
  if (!p || p.outline.length < 3) return [];
  if (!d) return [{ outline: p.outline, holes: p.holes, area: polygonArea(p), bbox: bboxOfRing(p.outline) }];
  if (d > 0) {
    const grown = convexDecompose(p).map((c) => ({ outline: offsetConvex(c, d, maxTurnDeg), holes: [] }));
    return booleanRegions([p, ...grown], [], 'union');
  }
  const k = -d;
  const b = bboxOfRing(p.outline);
  const pad = k + 10;
  const frame = [[b.x0 - pad, b.y0 - pad], [b.x1 + pad, b.y0 - pad], [b.x1 + pad, b.y1 + pad], [b.x0 - pad, b.y1 + pad]];
  // Everything that is NOT the solid: the plane outside the outline, and the holes.
  const outside = [
    ...convexDecompose({ outline: frame, holes: [orientRing(p.outline, false)] }),
    ...p.holes.flatMap((h) => convexDecompose({ outline: orientRing(h, true), holes: [] })),
  ].map((c) => ({ outline: offsetConvex(c, k, maxTurnDeg), holes: [] }));
  return booleanRegions([p], outside, 'difference');
}

/* ────────────────────── simplifying without ever shrinking ─────────────── */

/**
 * Fewer points, and a solid that CONTAINS the original.
 *
 * An inside curve (a cope hole, a radiused notch) arrives as a run of short
 * chords, and every one of them becomes a convex piece the packer has to carry.
 * Replacing a run by one straight chord fills the hollow in by at most `tol` —
 * the collision shape grows a hair, so parts end up at most `tol` further
 * apart, never closer. An OUTSIDE curve is left alone: cutting its corners
 * would shrink the shape, and a convex run costs nothing to decompose anyway.
 *
 * The polygon must be canonical (solid on the left of every ring).
 *
 * `holeTol` (a number, or a function of the hole's ring) lets the openings be
 * straightened more boldly than the outline: an opening only ever gets SMALLER
 * here, and a round window drawn as 72 chords is 72 convex pieces of frame.
 */
export function simplifyOutward(poly, tol = 0.5, holeTol = tol) {
  if (!(tol > 0)) return poly;
  const all = polyRings(poly);
  const simp = (ring, tol) => { // eslint-disable-line no-shadow
    const n = ring.length;
    if (n <= 4) return ring;
    const turn = (i) => {
      const a = ring[(i + n - 1) % n]; const b = ring[i % n]; const c = ring[(i + 1) % n];
      return cross(b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1]);
    };
    // Start on a corner that sticks OUT, so no run of hollow can wrap past the start.
    let s = -1;
    for (let i = 0; i < n; i += 1) if (turn(i) > 0) { s = i; break; }
    if (s < 0) s = 0;
    const out = [];
    let i = 0;
    while (i < n) {
      const a = ring[(s + i) % n];
      let j = i + 1;
      let swept = 0;
      while (j < n) {
        // Try to run the chord on to point j + 1, dropping point j.
        const k = j + 1;
        if (turn(s + j) >= 0) break; // j sticks out: it stays
        const mid = ring[(s + j) % n]; const prev = ring[(s + j - 1) % n]; const nxt = ring[(s + j + 1) % n];
        swept += Math.abs(Math.atan2(
          cross(mid[0] - prev[0], mid[1] - prev[1], nxt[0] - mid[0], nxt[1] - mid[1]),
          (mid[0] - prev[0]) * (nxt[0] - mid[0]) + (mid[1] - prev[1]) * (nxt[1] - mid[1]),
        ));
        if (swept > (2 * Math.PI) / 3) break;
        const e = ring[(s + k) % n];
        const cx = e[0] - a[0]; const cy = e[1] - a[1];
        const cl = Math.hypot(cx, cy);
        if (cl <= TOL) break;
        let okRun = true;
        let bx0 = Math.min(a[0], e[0]); let bx1 = Math.max(a[0], e[0]);
        let by0 = Math.min(a[1], e[1]); let by1 = Math.max(a[1], e[1]);
        for (let q = i + 1; q < k; q += 1) {
          const p = ring[(s + q) % n];
          const side = cross(cx, cy, p[0] - a[0], p[1] - a[1]) / cl; // + = left of the chord = the solid side
          if (side < -1e-9 || side > tol) { okRun = false; break; }
          if (p[0] < bx0) bx0 = p[0]; if (p[0] > bx1) bx1 = p[0];
          if (p[1] < by0) by0 = p[1]; if (p[1] > by1) by1 = p[1];
        }
        if (!okRun) break;
        // Nothing else may sit in the sliver being filled in.
        const lo = (s + i) % n; const span = k - i;
        for (const other of all) {
          for (let q = 0; q < other.length && okRun; q += 1) {
            if (other === ring && ((q - lo + n) % n) <= span) continue;
            const p = other[q];
            if (p[0] >= bx0 - 1e-6 && p[0] <= bx1 + 1e-6 && p[1] >= by0 - 1e-6 && p[1] <= by1 + 1e-6) okRun = false;
          }
          if (!okRun) break;
        }
        if (!okRun) break;
        j = k;
      }
      out.push(a);
      i = j;
    }
    const cleaned = cleanRing(out);
    return cleaned.length >= 3 ? cleaned : ring;
  };
  const outline = simp(poly.outline, tol);
  const holes = (poly.holes ?? []).map((h) => simp(h, Math.max(tol, typeof holeTol === 'function' ? holeTol(h) : holeTol)))
    .filter((h) => ringArea(h) > 1e-6);
  // Belt and braces: an outline may only have grown, a hole may only have shrunk.
  if (ringArea(outline) < ringArea(poly.outline) - 1e-6) return poly;
  return { outline, holes };
}
