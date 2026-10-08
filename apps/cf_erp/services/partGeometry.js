/**
 * partGeometry.js — CF_ERP. What a plate part's DXF drawing says about it (user, 2026-10-08:
 * "Build A" — nest by the rectangle around the drawing, and take cut length, piercings and the
 * true area from the drawing itself).
 *
 * PURE: text in, numbers out. No database, no tenant. scripts/cf_kepl/part_geometry_test.mjs
 * runs it with drawings made up in the test.
 *
 * WHAT IS READ. The ENTITIES section of an ASCII DXF: LINE, ARC, CIRCLE, LWPOLYLINE (with
 * bulges), POLYLINE/VERTEX, ELLIPSE and SPLINE (through its fit points, else its control points).
 * Units from $INSUNITS (inches, cm and m are turned into mm; none means mm). Entities on layers
 * that are plainly not the part — dimensions, text, centre lines, hatching, title blocks — are
 * skipped, and so is anything that does not close into a loop (a leftover dimension line), with a
 * warning that says how many.
 *
 * WHAT IT MEANS. The loops are chained from the segments' ends. The biggest loop is the part's
 * OUTLINE; every loop inside it is either a HOLE (a circle no wider than DRILL_MAX_DIA_MM — drilled,
 * so not cut by the torch and not pierced) or an inner CUT-OUT (cut and pierced). A second loop
 * outside the outline means two parts in one file, which is refused.
 *
 *   lengthMm × widthMm   the rectangle around the outline (x × y, as drawn)
 *   areaMm2              the outline less its cut-outs and holes
 *   cutLengthMm          the outline's length + every cut-out's (arcs measured exactly)
 *   piercings            1 + cut-outs
 *   sideCover            for each side of the rectangle, the share of it the outline runs along —
 *                        a common-line cut with a neighbour only saves that share (plateCutsService)
 *   rings                outline, cut-outs, holes as polygons, origin at the rectangle's corner
 * A binary DXF or a DWG is refused in words.
 */

export const DRILL_MAX_DIA_MM = 50;
const JOIN_TOL = 0.05;           // mm: segment ends closer than this are one point
const ARC_STEP_DEG = 5;          // tessellation of arcs for area and outline
const SKIP_LAYER = /(^|[^A-Z])(DIM|DIMS|DIMENSION|TEXT|NOTE|ANNO|CENT|CENTER|CENTRE|CL|HATCH|TITLE|BORDER|FRAME|DEFPOINTS|VIEWPORT)([^A-Z]|$)/i;
const UNIT = { 0: 1, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 };

const r1 = (n) => Math.round(n * 10) / 10;
const r3 = (n) => Math.round(n * 1000) / 1000;

/** Group-code pairs of an ASCII DXF. */
function pairsOf(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([Number(lines[i].trim()), lines[i + 1].trim()]);
  return out;
}

/** Entities as { type, layer, codes: [[code, value], …] } and the header's $INSUNITS. */
function readSections(pairs) {
  let units = 0;
  const entities = [];
  let section = null;
  for (let i = 0; i < pairs.length; i++) {
    const [c, v] = pairs[i];
    if (c === 0 && v === 'SECTION') { section = pairs[i + 1]?.[1] ?? null; i++; continue; }
    if (c === 0 && v === 'ENDSEC') { section = null; continue; }
    if (section === 'HEADER' && c === 9 && v === '$INSUNITS') { units = Number(pairs[i + 1]?.[1]) || 0; i++; continue; }
    if (section === 'ENTITIES' && c === 0) {
      const e = { type: v, layer: '', codes: [] };
      let j = i + 1;
      for (; j < pairs.length && pairs[j][0] !== 0; j++) {
        if (pairs[j][0] === 8) e.layer = pairs[j][1];
        e.codes.push(pairs[j]);
      }
      entities.push(e);
      i = j - 1;
    }
  }
  return { units, entities };
}

const num = (codes, code, dflt = 0) => { const p = codes.find((x) => x[0] === code); return p ? Number(p[1]) : dflt; };

/**
 * A segment: { a: [x,y], b: [x,y], len, pts: [[x,y]…] (a … b, tessellated) }.
 * Circles are whole loops on their own: { circle: { cx, cy, r } }.
 */
function arcPoints(cx, cy, r, a0, a1) {
  let sweep = a1 - a0;
  if (sweep <= 0) sweep += 360;
  const n = Math.max(2, Math.ceil(sweep / ARC_STEP_DEG));
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const t = ((a0 + (sweep * k) / n) * Math.PI) / 180;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return { pts, len: (Math.PI * r * sweep) / 180 };
}

/** A polyline edge with a bulge (tan of a quarter of the included angle) as points and length. */
function bulgePoints(p, q, bulge) {
  if (!bulge) return { pts: [p, q], len: Math.hypot(q[0] - p[0], q[1] - p[1]) };
  const chord = Math.hypot(q[0] - p[0], q[1] - p[1]);
  const theta = 4 * Math.atan(bulge);                 // included angle, signed: + counter-clockwise
  const r = (chord * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
  // The centre sits off the chord's midpoint along its left normal, by chord·(1 − b²)/(4b) (signed).
  const d = (chord * (1 - bulge * bulge)) / (4 * bulge);
  const cx = (p[0] + q[0]) / 2 - ((q[1] - p[1]) / chord) * d;
  const cy = (p[1] + q[1]) / 2 + ((q[0] - p[0]) / chord) * d;
  const a0 = Math.atan2(p[1] - cy, p[0] - cx);
  const n = Math.max(2, Math.ceil(Math.abs(theta) * 180 / Math.PI / ARC_STEP_DEG));
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const t = a0 + (theta * k) / n;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  pts[0] = p; pts[pts.length - 1] = q;
  return { pts, len: Math.abs(theta) * r };
}

function segmentsOf(entities, scale, warnings) {
  const segs = [];
  const circles = [];
  let skipped = 0;
  const S = (x) => x * scale;
  const add = (pts, len) => { if (pts.length >= 2 && len > 1e-9) segs.push({ a: pts[0], b: pts[pts.length - 1], len, pts }); };
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (e.layer && SKIP_LAYER.test(e.layer)) { skipped++; continue; }
    const c = e.codes;
    switch (e.type) {
      case 'LINE': {
        const p = [S(num(c, 10)), S(num(c, 20))];
        const q = [S(num(c, 11)), S(num(c, 21))];
        add([p, q], Math.hypot(q[0] - p[0], q[1] - p[1]));
        break;
      }
      case 'ARC': {
        const { pts, len } = arcPoints(S(num(c, 10)), S(num(c, 20)), S(num(c, 40)), num(c, 50), num(c, 51));
        add(pts, len);
        break;
      }
      case 'CIRCLE':
        circles.push({ cx: S(num(c, 10)), cy: S(num(c, 20)), r: S(num(c, 40)) });
        break;
      case 'LWPOLYLINE': {
        const closed = (num(c, 70) & 1) === 1;
        const verts = [];
        for (const [code, v] of c) {
          if (code === 10) verts.push({ p: [S(Number(v)), 0], bulge: 0 });
          else if (code === 20 && verts.length) verts[verts.length - 1].p[1] = S(Number(v));
          else if (code === 42 && verts.length) verts[verts.length - 1].bulge = Number(v);
        }
        polyToSegs(verts, closed, add);
        break;
      }
      case 'POLYLINE': {
        const closed = (num(c, 70) & 1) === 1;
        const verts = [];
        let j = i + 1;
        for (; j < entities.length && entities[j].type === 'VERTEX'; j++) {
          verts.push({ p: [S(num(entities[j].codes, 10)), S(num(entities[j].codes, 20))], bulge: num(entities[j].codes, 42) });
        }
        if (entities[j]?.type === 'SEQEND') j++;
        i = j - 1;
        polyToSegs(verts, closed, add);
        break;
      }
      case 'ELLIPSE': {
        const cx = S(num(c, 10)); const cy = S(num(c, 20));
        const mx = S(num(c, 11)); const my = S(num(c, 21));
        const ratio = num(c, 40, 1);
        let t0 = num(c, 41, 0); let t1 = num(c, 42, 2 * Math.PI);
        if (t1 <= t0) t1 += 2 * Math.PI;
        const a = Math.hypot(mx, my); const rot = Math.atan2(my, mx);
        const n = Math.max(8, Math.ceil(((t1 - t0) * 180) / Math.PI / ARC_STEP_DEG));
        const pts = [];
        for (let k = 0; k <= n; k++) {
          const t = t0 + ((t1 - t0) * k) / n;
          const x = a * Math.cos(t); const y = a * ratio * Math.sin(t);
          pts.push([cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]);
        }
        add(pts, pathLength(pts));
        break;
      }
      case 'SPLINE': {
        const fit = []; const ctrl = [];
        for (let k = 0; k < c.length; k++) {
          if (c[k][0] === 11) fit.push([S(Number(c[k][1])), S(Number(c.find((x, m) => m > k && x[0] === 21)?.[1] ?? 0))]);
          if (c[k][0] === 10) ctrl.push([S(Number(c[k][1])), S(Number(c.find((x, m) => m > k && x[0] === 20)?.[1] ?? 0))]);
        }
        const pts = fit.length >= 2 ? fit : ctrl;
        if ((num(c, 70) & 1) === 1 && pts.length > 2) pts.push(pts[0]);
        add(pts, pathLength(pts));
        if (pts.length >= 2) warnings.push('A curve (spline) was read through its points — its length is approximate.');
        break;
      }
      case 'INSERT':
        warnings.push('The drawing places a block; blocks are not read — explode it in CAD if the part is inside one.');
        break;
      default:
        break;
    }
  }
  if (skipped) warnings.push(`${skipped} item${skipped === 1 ? '' : 's'} on dimension, text or centre-line layers ignored.`);
  return { segs, circles };
}

function polyToSegs(verts, closed, add) {
  const n = verts.length;
  const edges = closed ? n : n - 1;
  for (let k = 0; k < edges; k++) {
    const v = verts[k]; const w = verts[(k + 1) % n];
    const { pts, len } = bulgePoints(v.p, w.p, v.bulge);
    add(pts, len);
  }
}

const pathLength = (pts) => { let s = 0; for (let k = 1; k < pts.length; k++) s += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]); return s; };
const near = (p, q) => Math.abs(p[0] - q[0]) <= JOIN_TOL && Math.abs(p[1] - q[1]) <= JOIN_TOL;

/** Chains segments into closed loops: [{ pts, len }]; returns the count of segments left open. */
function chain(segs) {
  const used = new Array(segs.length).fill(false);
  const loops = [];
  let open = 0;
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    let pts = segs[s].pts.slice();
    let len = segs[s].len;
    const members = [s];
    let grew = true;
    while (grew && !near(pts[0], pts[pts.length - 1])) {
      grew = false;
      const end = pts[pts.length - 1];
      for (let t = 0; t < segs.length; t++) {
        if (used[t]) continue;
        const g = segs[t];
        if (near(g.a, end)) { pts = pts.concat(g.pts.slice(1)); }
        else if (near(g.b, end)) { pts = pts.concat(g.pts.slice(0, -1).reverse()); }
        else continue;
        used[t] = true; len += g.len; members.push(t); grew = true;
        break;
      }
    }
    if (near(pts[0], pts[pts.length - 1]) && pts.length >= 4) { pts[pts.length - 1] = pts[0]; loops.push({ pts, len }); }
    else open += members.length;
  }
  return { loops, open };
}

const area = (pts) => { let a = 0; for (let k = 1; k < pts.length; k++) a += pts[k - 1][0] * pts[k][1] - pts[k][0] * pts[k - 1][1]; return a / 2; };
const bboxOf = (pts) => pts.reduce((b, [x, y]) => ({ x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
const inside = (pt, pts) => {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]; const [xj, yj] = pts[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const circlePts = (c) => arcPoints(c.cx, c.cy, c.r, 0, 360).pts;

/** Share of each side of the rectangle that the outline runs along. */
function sideCover(pts, b) {
  const L = b.x1 - b.x0; const W = b.y1 - b.y0;
  const on = { bottom: 0, top: 0, left: 0, right: 0 };
  const T = 0.2;
  for (let k = 1; k < pts.length; k++) {
    const [x0, y0] = pts[k - 1]; const [x1, y1] = pts[k];
    if (Math.abs(y0 - b.y0) <= T && Math.abs(y1 - b.y0) <= T) on.bottom += Math.abs(x1 - x0);
    else if (Math.abs(y0 - b.y1) <= T && Math.abs(y1 - b.y1) <= T) on.top += Math.abs(x1 - x0);
    else if (Math.abs(x0 - b.x0) <= T && Math.abs(x1 - b.x0) <= T) on.left += Math.abs(y1 - y0);
    else if (Math.abs(x0 - b.x1) <= T && Math.abs(x1 - b.x1) <= T) on.right += Math.abs(y1 - y0);
  }
  const f = (v, d) => (d > 0 ? Math.min(1, r3(v / d)) : 0);
  return { bottom: f(on.bottom, L), top: f(on.top, L), left: f(on.left, W), right: f(on.right, W) };
}

/**
 * Reads one drawing. Returns { geometry, warnings, problems } — geometry null when it cannot be
 * read as one part.
 */
export function readPartDrawing(text) {
  const warnings = [];
  const problems = [];
  const head = String(text ?? '').slice(0, 64);
  if (/^AutoCAD Binary DXF/.test(head)) return { geometry: null, warnings, problems: ['This is a binary DXF — save it from CAD as an ASCII (text) DXF.'] };
  if (/^AC10\d\d/.test(head)) return { geometry: null, warnings, problems: ['This is a DWG file — export it from CAD as a DXF.'] };
  if (!/(^|\n)\s*0\s*\r?\n\s*SECTION/.test(String(text ?? ''))) return { geometry: null, warnings, problems: ['This does not read as a DXF file.'] };

  const { units, entities } = readSections(pairsOf(text));
  const scale = UNIT[units] ?? 1;
  if (!(units in UNIT)) warnings.push('The drawing names a unit this reader does not know; it is read as millimetres.');
  const { segs, circles } = segmentsOf(entities, scale, warnings);
  const { loops, open } = chain(segs);
  if (open) warnings.push(`${open} line${open === 1 ? '' : 's'} that do not close into a shape ignored.`);

  const all = [
    ...loops.map((l) => ({ pts: l.pts, len: l.len, circle: null })),
    ...circles.map((c) => ({ pts: circlePts(c), len: 2 * Math.PI * c.r, circle: c })),
  ].map((l) => ({ ...l, a: Math.abs(area(l.pts)), box: bboxOf(l.pts) }));
  if (!all.length) return { geometry: null, warnings, problems: ['No closed outline was found in the drawing.'] };
  all.sort((x, y) => y.a - x.a);
  const outer = all[0];
  if (outer.circle) warnings.push('The part is a circle.');
  const holes = [];
  const cuts = [];
  for (const l of all.slice(1)) {
    const probe = l.circle ? [l.circle.cx, l.circle.cy] : l.pts[0];
    const within = l.box.x0 >= outer.box.x0 - JOIN_TOL && l.box.x1 <= outer.box.x1 + JOIN_TOL && l.box.y0 >= outer.box.y0 - JOIN_TOL && l.box.y1 <= outer.box.y1 + JOIN_TOL && inside(probe, outer.pts);
    if (!within) {
      if (l.a > 0.01 * outer.a) { problems.push('The drawing holds more than one part — put one part in each file.'); break; }
      warnings.push('A small shape outside the part was ignored.');
      continue;
    }
    if (l.circle && 2 * l.circle.r <= DRILL_MAX_DIA_MM + 1e-6) holes.push(l);
    else cuts.push(l);
  }
  if (problems.length) return { geometry: null, warnings, problems };

  const b = outer.box;
  const L = b.x1 - b.x0; const W = b.y1 - b.y0;
  if (!(L > 0 && W > 0)) return { geometry: null, warnings, problems: ['The outline has no size.'] };
  const shift = (pts) => pts.map(([x, y]) => [r1(x - b.x0), r1(y - b.y0)]);
  const areaMm2 = outer.a - cuts.reduce((s, l) => s + l.a, 0) - holes.reduce((s, l) => s + l.a, 0);
  const cutLength = outer.len + cuts.reduce((s, l) => s + l.len, 0);
  return {
    geometry: {
      lengthMm: r1(L), widthMm: r1(W),
      areaMm2: r1(areaMm2), rectAreaMm2: r1(L * W), usePct: r1((areaMm2 / (L * W)) * 100),
      outlineLengthMm: r1(outer.len),
      cutLengthMm: r1(cutLength), piercings: 1 + cuts.length,
      innerCuts: cuts.length, holes: holes.length, holeDiameters: holes.map((h) => r1(2 * h.circle.r)).sort((x, y) => x - y),
      sideCover: sideCover(outer.pts, b),
      rings: [outer, ...cuts, ...holes].map((l) => shift(l.pts)),
    },
    warnings,
    problems,
  };
}

/** A drawing's facts in the part's own orientation: x along its LENGTH. `swap` when the drawing is drawn the other way round. */
export function orientTo(geometry, lengthMm, widthMm) {
  const g = geometry;
  const swap = lengthMm != null && widthMm != null && Math.abs(g.lengthMm - widthMm) + Math.abs(g.widthMm - lengthMm) < Math.abs(g.lengthMm - lengthMm) + Math.abs(g.widthMm - widthMm);
  const sizeMatches = lengthMm == null || widthMm == null ? null
    : (swap ? Math.abs(g.lengthMm - widthMm) <= 1 && Math.abs(g.widthMm - lengthMm) <= 1 : Math.abs(g.lengthMm - lengthMm) <= 1 && Math.abs(g.widthMm - widthMm) <= 1);
  const c = g.sideCover ?? { bottom: 1, top: 1, left: 1, right: 1 };
  // Cover of the sides that run along the part's LENGTH, and along its WIDTH.
  const alongLength = swap ? (c.left + c.right) / 2 : (c.bottom + c.top) / 2;
  const alongWidth = swap ? (c.bottom + c.top) / 2 : (c.left + c.right) / 2;
  return { swap, sizeMatches, alongLength, alongWidth };
}
