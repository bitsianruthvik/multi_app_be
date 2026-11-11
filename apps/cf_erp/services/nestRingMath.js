/**
 * nestRingMath.js — CF_ERP. Small exact ring arithmetic for the length combiner (nestCutStock.js) and the pairing of
 * irregular shapes (nestPairs.js): boxes, areas, boundary distances, point in ring, zero-width spikes. Rings are arrays
 * of [x, y] in mm (open or closed). PURE.
 */

export const bbox = (r) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, y0, x1, y1 }; };
export const boxOfRings = (rings) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const r of rings) for (const [x, y] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, y0, x1, y1 }; };
export const signedArea = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return a / 2; };
export const area = (r) => Math.abs(signedArea(r));
export const shift = (ring, dx, dy) => ring.map(([x, y]) => [x + dx, y + dy]);
export const rectRing = (L, W) => [[0, 0], [L, 0], [L, W], [0, W]];

/** Point strictly inside ring (ray casting). */
export function pointIn(p, r) {
  let c = false; const [x, y] = p;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i]; const [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const cross = (ax, ay, bx, by) => ax * by - ay * bx;
function segsIntersect(a, b, c, d) {
  const d1 = cross(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]);
  const d2 = cross(b[0] - a[0], b[1] - a[1], d[0] - a[0], d[1] - a[1]);
  const d3 = cross(d[0] - c[0], d[1] - c[1], a[0] - c[0], a[1] - c[1]);
  const d4 = cross(d[0] - c[0], d[1] - c[1], b[0] - c[0], b[1] - c[1]);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
export function ptSegDist(p, a, b) {
  const dx = b[0] - a[0]; const dy = b[1] - a[1]; const L = dx * dx + dy * dy;
  let t = L > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function segSegDist(a, b, c, d) {
  if (segsIntersect(a, b, c, d)) return 0;
  return Math.min(ptSegDist(a, c, d), ptSegDist(b, c, d), ptSegDist(c, a, b), ptSegDist(d, a, b));
}
/** Smallest distance between the boundaries of two rings (0 when they cross); stops looking once below `cap`. */
export function ringDist(r1, r2, cap = Infinity) {
  let m = cap;
  const b2 = bbox(r2);
  for (let i = 0, j = r1.length - 1; i < r1.length; j = i++) {
    const a = r1[j]; const b = r1[i];
    const sx0 = Math.min(a[0], b[0]), sx1 = Math.max(a[0], b[0]), sy0 = Math.min(a[1], b[1]), sy1 = Math.max(a[1], b[1]);
    const gx = Math.max(0, b2.x0 - sx1, sx0 - b2.x1), gy = Math.max(0, b2.y0 - sy1, sy0 - b2.y1);
    if (Math.hypot(gx, gy) >= m) continue;
    for (let k = 0, l = r2.length - 1; k < r2.length; l = k++) {
      const d = segSegDist(a, b, r2[l], r2[k]);
      if (d < m) { m = d; if (m === 0) return 0; }
    }
  }
  return m;
}
/** Distance between two ring sets: the smallest boundary distance, 0 when they cross or one holds the other. */
export function setDist(A, B, cap) {
  let m = cap;
  for (const a of A) for (const b of B) {
    const d = ringDist(a, b, m);
    if (d < m) m = d;
    if (m === 0) return 0;
  }
  for (const a of A) for (const b of B) { if (pointIn(b[0], a) || pointIn(a[0], b)) return 0; }
  return m;
}

/** Zero-width spikes dropped (an outline that runs out and straight back: no steel). → ring */
export function dropSpikes(ring) {
  let r = ring.slice(); let changed = true;
  while (changed && r.length > 3) {
    changed = false;
    for (let i = 0; i < r.length && r.length > 3; i++) {
      const p = r[(i - 1 + r.length) % r.length], v = r[i], n = r[(i + 1) % r.length];
      const ax = v[0] - p[0], ay = v[1] - p[1], bx = n[0] - v[0], by = n[1] - v[1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la < 1e-9 || lb < 1e-9) { r.splice(i, 1); changed = true; break; }
      const cr = Math.abs(ax * by - ay * bx) / (la * lb); const dot = ax * bx + ay * by;
      if (cr < 1e-7 && dot < 0) { r.splice(i, 1); changed = true; break; }
    }
  }
  return r;
}

/** The outer ring of a piece as handed to the packers (rings object, ring list, or none → its rectangle). */
export function outlineOf(piece) {
  const r = piece?.rings;
  if (r && !Array.isArray(r) && Array.isArray(r.outline) && r.outline.length >= 3) return r.outline;
  if (Array.isArray(r) && r.length) return typeof r[0]?.[0] === 'number' ? r : r[0];
  return rectRing(Number(piece.length) || 0, Number(piece.width) || 0);
}
