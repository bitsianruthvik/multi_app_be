// Planar geometry: turn flattened LINE / ARC / LWPOLYLINE primitives into closed shapes.
//  1. edges: lines (split where they cross or touch other lines) and arcs (kept whole, as bulges)
//  2. nodes: end points snapped together (SNAP mm)
//  3. dangling edges pruned (repeatedly drop edges with a free end)
//  4. connected components; for each, the faces of the planar graph; the OUTER face (negative
//     signed area) is the component's outline.
// Everything is deterministic: inputs are processed in file order, ties broken by index.

export const SNAP = 0.2;           // mm: end points closer than this are one node
const EPS = 1e-9;

const bulgeArc = (a, b, bulge) => { // centre, radius, start/end angle of a bulge segment a->b
  const ch = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const th = 4 * Math.atan(bulge);
  const r = ch / (2 * Math.sin(Math.abs(th) / 2));
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const d = r * Math.cos(Math.abs(th) / 2) * Math.sign(bulge); // signed distance chord-mid -> centre (to the left for ccw)
  const nx = -(b[1] - a[1]) / ch, ny = (b[0] - a[0]) / ch;
  const cx = mx + nx * d * (Math.abs(th) > Math.PI ? -1 : 1), cy = my + ny * d * (Math.abs(th) > Math.PI ? -1 : 1);
  return { cx, cy, r, th };
};

/** Points along an edge (for area / point-in-polygon / bounding box). */
export function edgePoints(a, b, bulge, stepDeg = 5) {
  if (!bulge) return [a, b];
  const ch = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (ch < EPS) return [a, b];
  const th = 4 * Math.atan(bulge);
  // centre: from a, perpendicular to chord
  const r = ch / (2 * Math.sin(th / 2));
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const h = r * Math.cos(th / 2);
  const ux = (b[0] - a[0]) / ch, uy = (b[1] - a[1]) / ch;
  const cx = mx - uy * h, cy = my + ux * h; // left of the chord for positive th
  const a0 = Math.atan2(a[1] - cy, a[0] - cx);
  const n = Math.max(2, Math.ceil(Math.abs(th) * 180 / Math.PI / stepDeg));
  const R = Math.abs(r);
  const out = [];
  for (let i = 0; i <= n; i++) { const t = a0 + th * i / n; out.push([cx + R * Math.cos(t) * Math.sign(r) * Math.sign(r), cy + R * Math.sin(t)]); }
  // guard against sign confusion: force exact end points
  out[0] = a; out[out.length - 1] = b;
  return out;
}

/** Arc primitive (centre, r, a0->a1 ccw) as end points + bulge. */
function arcAsBulge(o) {
  let sw = o.a1 - o.a0; while (sw <= 0) sw += 2 * Math.PI; while (sw > 2 * Math.PI) sw -= 2 * Math.PI;
  const a = [o.x + o.r * Math.cos(o.a0), o.y + o.r * Math.sin(o.a0)];
  const b = [o.x + o.r * Math.cos(o.a0 + sw), o.y + o.r * Math.sin(o.a0 + sw)];
  return { a, b, bulge: Math.tan(sw / 4) };
}

/** Raw edges from primitives. Returns [{a,b,bulge,src}] (src = primitive index). */
export function rawEdges(prims) {
  const E = [];
  prims.forEach((o, i) => {
    if (o.k === 'L') E.push({ a: [o.x1, o.y1], b: [o.x2, o.y2], bulge: 0, src: i });
    else if (o.k === 'A') { const e = arcAsBulge(o); E.push({ ...e, src: i }); }
    else if (o.k === 'P') {
      const n = o.pts.length;
      for (let k = 0; k < n - (o.closed ? 0 : 1); k++) {
        const p = o.pts[k], q = o.pts[(k + 1) % n];
        E.push({ a: [p[0], p[1]], b: [q[0], q[1]], bulge: p[2] || 0, src: i });
      }
    }
  });
  return E.filter((e) => Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) > 1e-6);
}

/** Split straight edges where they cross / touch other straight edges. Grid-accelerated. */
export function splitEdges(E, tol = SNAP / 2) {
  const CELL = 400;
  const grid = new Map();
  const key = (i, j) => i * 1e7 + j;
  const lines = [];
  E.forEach((e, idx) => { if (!e.bulge) lines.push(idx); });
  for (const idx of lines) {
    const e = E[idx];
    const x0 = Math.floor(Math.min(e.a[0], e.b[0]) / CELL), x1 = Math.floor(Math.max(e.a[0], e.b[0]) / CELL);
    const y0 = Math.floor(Math.min(e.a[1], e.b[1]) / CELL), y1 = Math.floor(Math.max(e.a[1], e.b[1]) / CELL);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 20000) continue; // absurdly long line (title border) — never split
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) { const k = key(i, j); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(idx); }
  }
  const cuts = new Map(); // idx -> [t]
  const addCut = (idx, t) => { if (t <= 1e-9 || t >= 1 - 1e-9) return; if (!cuts.has(idx)) cuts.set(idx, []); cuts.get(idx).push(t); };
  const seen = new Set();
  for (const list of grid.values()) {
    for (let p = 0; p < list.length; p++) for (let q = p + 1; q < list.length; q++) {
      const i = Math.min(list[p], list[q]), j = Math.max(list[p], list[q]);
      const pk = i * 1e6 + j; if (seen.has(pk)) continue; seen.add(pk);
      const A = E[i], B = E[j];
      if (Math.max(A.a[0], A.b[0]) < Math.min(B.a[0], B.b[0]) - tol || Math.max(B.a[0], B.b[0]) < Math.min(A.a[0], A.b[0]) - tol) continue;
      if (Math.max(A.a[1], A.b[1]) < Math.min(B.a[1], B.b[1]) - tol || Math.max(B.a[1], B.b[1]) < Math.min(A.a[1], A.b[1]) - tol) continue;
      const r = [A.b[0] - A.a[0], A.b[1] - A.a[1]], s = [B.b[0] - B.a[0], B.b[1] - B.a[1]];
      const den = r[0] * s[1] - r[1] * s[0];
      const LA = Math.hypot(...r), LB = Math.hypot(...s);
      if (Math.abs(den) > 1e-9 * LA * LB) {
        const qp = [B.a[0] - A.a[0], B.a[1] - A.a[1]];
        const t = (qp[0] * s[1] - qp[1] * s[0]) / den, u = (qp[0] * r[1] - qp[1] * r[0]) / den;
        const ta = tol / LA, tb = tol / LB;
        if (t >= -ta && t <= 1 + ta && u >= -tb && u <= 1 + tb) { addCut(i, t); addCut(j, u); }
      } else {
        // parallel: overlapping collinear pieces — cut each at the other's end points
        const dist = (P, S) => { const L2 = S.len2; const tt = ((P[0] - S.a[0]) * S.r[0] + (P[1] - S.a[1]) * S.r[1]) / L2; const px = S.a[0] + tt * S.r[0], py = S.a[1] + tt * S.r[1]; return [tt, Math.hypot(px - P[0], py - P[1])]; };
        const SA = { a: A.a, r, len2: LA * LA }, SB = { a: B.a, r: s, len2: LB * LB };
        for (const P of [B.a, B.b]) { const [tt, d] = dist(P, SA); if (d <= tol) addCut(i, tt); }
        for (const P of [A.a, A.b]) { const [tt, d] = dist(P, SB); if (d <= tol) addCut(j, tt); }
      }
    }
  }
  // an arc that ends on the middle of a straight line (a fillet meeting an edge) cuts that line there
  E.forEach((e) => {
    if (!e.bulge) return;
    for (const P of [e.a, e.b]) {
      const list = grid.get(key(Math.floor(P[0] / CELL), Math.floor(P[1] / CELL))) ?? [];
      for (const i of list) {
        const A = E[i]; const r = [A.b[0] - A.a[0], A.b[1] - A.a[1]]; const L2 = r[0] * r[0] + r[1] * r[1];
        const t = ((P[0] - A.a[0]) * r[0] + (P[1] - A.a[1]) * r[1]) / L2;
        if (t <= 0 || t >= 1) continue;
        const d = Math.hypot(A.a[0] + t * r[0] - P[0], A.a[1] + t * r[1] - P[1]);
        if (d <= tol) addCut(i, t);
      }
    }
  });
  const out = [];
  E.forEach((e, idx) => {
    const ts = cuts.get(idx);
    if (!ts) { out.push(e); return; }
    const all = [0, ...ts.sort((x, y) => x - y), 1];
    for (let k = 1; k < all.length; k++) {
      if (all[k] - all[k - 1] < 1e-9) continue;
      const P = (t) => [e.a[0] + t * (e.b[0] - e.a[0]), e.a[1] + t * (e.b[1] - e.a[1])];
      out.push({ a: P(all[k - 1]), b: P(all[k]), bulge: 0, src: e.src });
    }
  });
  return out;
}

/** Nodes + edges, dangling pruned. */
export function buildGraph(E, snap = SNAP) {
  const nodes = []; const cell = new Map(); const C = snap * 4;
  const nid = (p) => {
    const ci = Math.floor(p[0] / C), cj = Math.floor(p[1] / C);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
      const l = cell.get(i + ',' + j); if (!l) continue;
      for (const n of l) if (Math.abs(nodes[n][0] - p[0]) <= snap && Math.abs(nodes[n][1] - p[1]) <= snap) return n;
    }
    nodes.push([p[0], p[1]]); const k = ci + ',' + cj; if (!cell.has(k)) cell.set(k, []); cell.get(k).push(nodes.length - 1);
    return nodes.length - 1;
  };
  let edges = [];
  const dup = new Set();
  for (const e of E) {
    const u = nid(e.a), v = nid(e.b);
    if (u === v) continue;
    const k = e.bulge ? `${u}|${v}|${e.bulge.toFixed(6)}` : (u < v ? `${u}|${v}` : `${v}|${u}`);
    if (dup.has(k) || (e.bulge && dup.has(`${v}|${u}|${(-e.bulge).toFixed(6)}`))) continue;
    dup.add(k);
    edges.push({ u, v, bulge: e.bulge, src: e.src });
  }
  // prune dangling
  for (;;) {
    const deg = new Map();
    for (const e of edges) { deg.set(e.u, (deg.get(e.u) || 0) + 1); deg.set(e.v, (deg.get(e.v) || 0) + 1); }
    const keep = edges.filter((e) => deg.get(e.u) > 1 && deg.get(e.v) > 1);
    if (keep.length === edges.length) break;
    edges = keep;
  }
  return { nodes, edges };
}

/** Connected components of a graph: arrays of edge indices. */
export function components(g) {
  const par = new Map();
  const find = (i) => { while (par.get(i) !== i) { par.set(i, par.get(par.get(i))); i = par.get(i); } return i; };
  for (const e of g.edges) { if (!par.has(e.u)) par.set(e.u, e.u); if (!par.has(e.v)) par.set(e.v, e.v); const a = find(e.u), b = find(e.v); if (a !== b) par.set(Math.max(a, b), Math.min(a, b)); }
  const comp = new Map();
  g.edges.forEach((e, i) => { const r = find(e.u); if (!comp.has(r)) comp.set(r, []); comp.get(r).push(i); });
  return [...comp.values()];
}

/** Ring (list of {x,y,bulge}) -> dense polygon points. */
export function ringPoints(ring) {
  const pts = [];
  for (let k = 0; k < ring.length; k++) {
    const p = ring[k], q = ring[(k + 1) % ring.length];
    const seg = edgePoints([p.x, p.y], [q.x, q.y], p.bulge);
    for (let i = 0; i < seg.length - 1; i++) pts.push(seg[i]);
  }
  return pts;
}
export const polyArea = (pts) => { let a = 0; for (let k = 0; k < pts.length; k++) { const p = pts[k], q = pts[(k + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
export const bboxOf = (pts) => pts.reduce((b, p) => ({ x0: Math.min(b.x0, p[0]), y0: Math.min(b.y0, p[1]), x1: Math.max(b.x1, p[0]), y1: Math.max(b.y1, p[1]) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
export const inPoly = (pt, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c; } return c; };

/** Outer face of one component. Returns ring [{x,y,bulge}] (counter-clockwise) or null. */
export function outerFace(g, edgeIdx) {
  const half = []; // {from,to,bulge,ang}
  const out = new Map();
  for (const i of edgeIdx) {
    const e = g.edges[i];
    const A = g.nodes[e.u], B = g.nodes[e.v];
    const chord = Math.atan2(B[1] - A[1], B[0] - A[0]);
    // direction leaving a node: for an arc, towards a point a little way along it (not the exact
    // tangent — a fillet is tangent to the edge it meets, and the tie must break the right way)
    let a1 = chord, a2 = chord + Math.PI;
    if (e.bulge) {
      const p = edgePoints(A, B, e.bulge, 0.5);
      a1 = Math.atan2(p[1][1] - A[1], p[1][0] - A[0]);
      a2 = Math.atan2(p[p.length - 2][1] - B[1], p[p.length - 2][0] - B[0]);
    }
    const h1 = { from: e.u, to: e.v, bulge: e.bulge || 0, ang: a1 };
    const h2 = { from: e.v, to: e.u, bulge: -(e.bulge || 0), ang: a2 };
    h1.twin = half.length + 1; h2.twin = half.length;
    half.push(h1, h2);
  }
  half.forEach((h, i) => { h.ang = Math.atan2(Math.sin(h.ang), Math.cos(h.ang)); if (!out.has(h.from)) out.set(h.from, []); out.get(h.from).push(i); });
  for (const l of out.values()) l.sort((a, b) => half[a].ang - half[b].ang || a - b);
  const pos = new Map(); for (const l of out.values()) l.forEach((h, k) => pos.set(h, k));
  const next = (hi) => { // interior on the left: at the head, take the outgoing edge just clockwise of the twin
    const tw = half[hi].twin; const l = out.get(half[hi].to); const k = pos.get(tw);
    return l[(k - 1 + l.length) % l.length];
  };
  const used = new Uint8Array(half.length);
  let best = null;
  for (let s = 0; s < half.length; s++) {
    if (used[s]) continue;
    const face = []; let h = s; let guard = 0;
    do { used[h] = 1; face.push(h); h = next(h); } while (h !== s && ++guard < 200000);
    if (h !== s) continue;
    const ring = face.map((hi) => ({ x: g.nodes[half[hi].from][0], y: g.nodes[half[hi].from][1], bulge: half[hi].bulge }));
    const a = polyArea(ringPoints(ring));
    if (a < 0 && (!best || -a > best.area)) best = { ring, area: -a };
  }
  if (!best) return null;
  // reverse to counter-clockwise
  const r = best.ring; const n = r.length; const ccw = [];
  for (let k = n - 1; k >= 0; k--) ccw.push({ x: r[(k + 1) % n].x, y: r[(k + 1) % n].y, bulge: -r[k].bulge });
  return { ring: ccw, area: best.area };
}
