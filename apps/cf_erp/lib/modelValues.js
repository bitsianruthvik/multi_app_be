/**
 * modelValues.js — PURE: what a structure's 3D model (cf-erp-model3d/2) says about each mark (2026-11-08, user: "the values
 * should compute when we upload the 3D json"; TM/plans/values-from-model.md). No database here —
 * services/modelValueService.js reads the stored model and the rows and writes what this works out.
 *
 * THE MODEL. `parts` { id: { pts, t, holes?: [[x, y, dia]], cuts?: [[[x, y] …]] } } — a flat shape in its own x/y, t thick;
 * `elements` [{ mark, in: [level, …, top], n: [copy per level], part?, seg?: [i, k], o, u, v, w, member?, studs? }] — every
 * placed piece (a world point is o + x·u + y·v + z·w, z from 0 to t); `boltSet` { cols, rows } — every bolt with its
 * start point, direction and grip.
 *
 * A PIECE is the elements of one mark in one copy of its assembly (same `in` and `n`). Most pieces are one element; a
 * piece drawn in segments (`seg`) is several: a flange split at a camber kink (the segments share their width — joined
 * end to end), an angle's two legs (they share their length — folded along it), a bent plate (neither — its legs are
 * added along the bend). A `member` element is a section bar between two points; `studs` is a grid of shear studs.
 *
 * WHAT IT GIVES, per mark (sizes in mm; areas in mm²):
 *   pieceShape      kind 'plate' | 'section' | 'member', lengthMm, widthMm (plates only), t, areaMm2 (outline less cut-outs
 *                   and holes, plates only), cutLengthMm (outline + cut-outs), holes, holeDiameters
 *   holeDrillThickness  the most a bolt through any of the mark's holes clamps (its grip) — the plies drilled together;
 *                   null when no bolt passes through the mark's holes
 *   pieceCounts     how many pieces of each mark the model places (a stud grid: its studs)
 *   weldLengths     per assembly level: the length of every T-joint between its plates (a plate's edge on another's
 *                   face), × 2 for a fillet each side, in ONE copy of the level
 *   weldSizeFor     a weld size the drawing set's bom.json `welds` gives for an assembly, by its name
 */

const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const up = (s) => String(s ?? '').trim().toUpperCase();
/** partDrawingService.normMark's rule (kept here so this file stays pure): "BC1 F1.dxf" → "BC1-F1". */
export const normMark = (s) => String(s ?? '').replace(/\.(dxf|pdf)$/i, '').trim().replace(/[\s_-]+/g, '-').toUpperCase();

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a) => Math.sqrt(dot(a, a));

/** A closed ring (the first point may or may not repeat at the end). */
function ring(pts) {
  const p = (pts ?? []).map((q) => [Number(q[0]), Number(q[1])]);
  if (p.length > 1 && Math.abs(p[0][0] - p.at(-1)[0]) < 1e-9 && Math.abs(p[0][1] - p.at(-1)[1]) < 1e-9) p.pop();
  return p;
}
export function polygonArea(pts) {
  const p = ring(pts); let a = 0;
  for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i]; const [x2, y2] = p[(i + 1) % p.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}
export function polygonPerimeter(pts) {
  const p = ring(pts); let s = 0;
  for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i]; const [x2, y2] = p[(i + 1) % p.length]; s += Math.hypot(x2 - x1, y2 - y1); }
  return s;
}
function bbox(pts) {
  const p = ring(pts);
  if (!p.length) return { dx: 0, dy: 0, minX: 0, minY: 0 };
  const xs = p.map((q) => q[0]); const ys = p.map((q) => q[1]);
  return { dx: Math.max(...xs) - Math.min(...xs), dy: Math.max(...ys) - Math.min(...ys), minX: Math.min(...xs), minY: Math.min(...ys) };
}
function inPolygon(x, y, pts) {
  const p = ring(pts); let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i]; const [xj, yj] = p[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** One part's flat facts. */
export function partFacts(part) {
  const holes = (part?.holes ?? []).map((h) => Number(h[2])).filter((d) => d > 0);
  const cuts = part?.cuts ?? [];
  const holeArea = holes.reduce((t, d) => t + (Math.PI * d * d) / 4, 0);
  const b = bbox(part?.pts);
  return {
    dx: b.dx, dy: b.dy, t: Number(part?.t) || null,
    areaMm2: polygonArea(part?.pts) - cuts.reduce((t, c) => t + polygonArea(c), 0) - holeArea,
    cutLengthMm: polygonPerimeter(part?.pts) + cuts.reduce((t, c) => t + polygonPerimeter(c), 0),
    holes: holes.length, holeDiameters: holes,
  };
}

const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

/**
 * The shape of one piece from its parts (one per segment, in segment order). → { kind, lengthMm, widthMm, t, areaMm2,
 * cutLengthMm, holes, holeDiameters, how } — `how` says which rule joined the segments ('one' | 'end to end' | 'folded' |
 * 'bent'); null fields are what the model cannot say for this piece.
 */
export function pieceShape(parts) {
  const fs = parts.map(partFacts);
  if (!fs.length) return null;
  const ts = [...new Set(fs.map((f) => f.t))];
  const t = ts.length === 1 ? ts[0] : null;
  const holeDiameters = fs.flatMap((f) => f.holeDiameters);
  const base = { t, holes: holeDiameters.length, holeDiameters, areaMm2: fs.reduce((s, f) => s + f.areaMm2, 0) };
  const per = fs.reduce((s, f) => s + f.cutLengthMm, 0);
  const sorted = (a, b) => (a >= b ? [a, b] : [b, a]);
  // A profile drawn as its cross-section and extruded by t (an angle 75 × 75 drawn 576 long; a tee cut in two
  // segments 3741.5 + 72): a section, its length is the sum of the t's; its wall and holes are not in this drawing.
  if (fs.some((f) => f.t != null && f.t > Math.max(f.dx, f.dy))) {
    return { kind: 'section', lengthMm: r3(fs.reduce((s, f) => s + f.t, 0)), widthMm: null, t: null, areaMm2: null, cutLengthMm: null, holes: null, holeDiameters: [], how: 'profile' };
  }
  if (fs.length === 1) {
    const [L, W] = sorted(fs[0].dx, fs[0].dy);
    return { kind: 'plate', lengthMm: r3(L), widthMm: r3(W), cutLengthMm: per, ...base, how: 'one' };
  }
  const k = fs.length - 1;
  if (fs.every((f) => near(f.dy, fs[0].dy))) {          // joined end to end along x (a flange split at a kink)
    const [L, W] = sorted(fs.reduce((s, f) => s + f.dx, 0), fs[0].dy);
    return { kind: 'plate', lengthMm: r3(L), widthMm: r3(W), cutLengthMm: per - 2 * k * fs[0].dy, ...base, how: 'end to end' };
  }
  if (fs.every((f) => near(f.dx, fs[0].dx))) {          // folded along x: an angle's legs — a section, its length only
    return { kind: 'section', lengthMm: r3(fs[0].dx), widthMm: null, cutLengthMm: null, ...base, areaMm2: null, how: 'folded' };
  }
  // BENT: the flat size depends on how the legs meet at the bend (U1-P2's legs add up to the sheet's 1259, L0-P1's
  // 450 + 153.5 do not make its 820 × 505) — not guessed: its part file (the flat shape) gives it, else a person.
  return { kind: 'plate', lengthMm: null, widthMm: null, cutLengthMm: null, ...base, areaMm2: null, how: 'bent' };
}

const copyKey = (e) => `${up(e.mark)}|${(e.in ?? []).join('<')}|${(e.n ?? []).join(',')}`;

/**
 * The model's pieces, in element order: [{ mark, els }]. `n` numbers the copies of the LEVELS, not the pieces (a box
 * member holds two flanges of one mark in one copy), so a piece is an element without `seg` or with seg[0] = 0, and the
 * elements right after it with the same mark, level and copy and seg[0] > 0 are its other segments.
 */
export function piecesOfModel(model) {
  const out = []; const open = new Map();
  for (const e of model?.elements ?? []) {
    if (e.mark == null || e.mark === '') continue;
    const k = copyKey(e);
    if (e.seg && Number(e.seg[0]) > 0 && open.has(k)) { open.get(k).els.push(e); continue; }
    const p = { mark: String(e.mark), els: [e] };
    out.push(p); open.set(k, p);
  }
  return out;
}

/**
 * The model's marks: Map normMark → { mark, pieces: count, shape, variants (distinct part lists seen), levels }.
 * Studs count as their grid; a member is one piece with kind 'member'.
 */
export function marksOfModel(model) {
  const pieces = piecesOfModel(model);
  const out = new Map();
  for (const p of pieces) {
    const m = normMark(p.mark);
    if (!out.has(m)) out.set(m, { mark: p.mark, pieces: 0, shape: null, variants: new Set(), first: p });
    const x = out.get(m);
    const studs = p.els.find((e) => e.studs);
    if (studs) { x.pieces += p.els.reduce((s, e) => s + (e.studs ? (Number(e.studs.ni) || 1) * (Number(e.studs.nj) || 1) : 1), 0); x.kind = 'studs'; continue; }
    x.pieces += 1;
    const segs = p.els.slice().sort((a, b) => (a.seg?.[0] ?? 0) - (b.seg?.[0] ?? 0));
    x.variants.add(segs.map((e) => e.part ?? (e.member ? 'member' : '?')).join('+'));
  }
  for (const x of out.values()) {
    if (x.kind === 'studs') { x.shape = { kind: 'studs' }; continue; }
    const segs = x.first.els.slice().sort((a, b) => (a.seg?.[0] ?? 0) - (b.seg?.[0] ?? 0));
    const mem = segs.find((e) => e.member);
    if (mem) {
      const L = len3(sub(mem.member.b, mem.member.a));
      x.shape = { kind: 'member', lengthMm: r3(L), widthMm: null, t: Number(mem.member.section?.t) || null, areaMm2: null, cutLengthMm: null, holes: null, holeDiameters: [], how: 'member' };
      continue;
    }
    const parts = segs.map((e) => model.parts?.[e.part]).filter(Boolean);
    x.shape = parts.length === segs.length ? pieceShape(parts) : null;
    // Variants of one mark (mirrored hole patterns, #2) with another outline or thickness: said, the first one used.
    if (x.variants.size > 1) {
      const shapes = pieces.filter((p) => normMark(p.mark) === normMark(x.mark))
        .map((p) => p.els.slice().sort((a, b) => (a.seg?.[0] ?? 0) - (b.seg?.[0] ?? 0)).map((e) => model.parts?.[e.part]).filter(Boolean))
        .filter((ps) => ps.length).map(pieceShape);
      const differs = shapes.some((s) => !s || !x.shape || s.t !== x.shape.t || !near(s.lengthMm, x.shape.lengthMm) || (s.widthMm != null && !near(s.widthMm, x.shape.widthMm)) || s.holes !== x.shape.holes);
      if (differs) x.variantsDiffer = true;
    }
    delete x.first;
  }
  for (const x of out.values()) { delete x.first; x.variants = [...x.variants]; }
  return out;
}

/** Map normMark(level) → every element of ONE copy of that level (its first copy), with the level's name. */
function levelCopies(model) {
  const firstKey = new Map(); const out = new Map();
  for (const e of model?.elements ?? []) {
    const lv = e.in?.[0];
    if (lv == null) continue;
    const m = normMark(lv);
    const key = `${(e.in ?? []).join('<')}|${(e.n ?? []).join(',')}`;
    if (!firstKey.has(m)) { firstKey.set(m, key); out.set(m, []); }
    if (firstKey.get(m) === key) out.get(m).push(e);
  }
  return out;
}

/** An element's frame and part, ready for world points. */
function frameOf(model, e) {
  const p = e.part ? model.parts?.[e.part] : null;
  if (!p || !e.o || !e.u || !e.v || !e.w) return null;
  return { e, p, o: e.o, u: e.u, v: e.v, w: e.w, t: Number(p.t) || 0, pts: ring(p.pts) };
}
const world = (f, x, y, z) => [f.o[0] + x * f.u[0] + y * f.v[0] + z * f.w[0], f.o[1] + x * f.u[1] + y * f.v[1] + z * f.w[1], f.o[2] + x * f.u[2] + y * f.v[2] + z * f.w[2]];
const local = (f, P) => { const d = sub(P, f.o); return [dot(d, f.u), dot(d, f.v), dot(d, f.w)]; };

/**
 * The plies a bolt clamps where it passes through each mark's holes: Map normMark → { grip (the most), bolts (how many
 * pass through the mark's holes, over every piece) }. A bolt passes through a hole when its line runs along the plate's
 * normal through the hole (within the hole's radius) and the plate lies inside its grip.
 */
export function holeDrillThickness(model) {
  const bs = model?.boltSet;
  const out = new Map();
  if (!bs?.rows?.length) return out;
  const col = new Map((bs.cols ?? []).map((c, i) => [c, i]));
  const at = (r, c) => Number(r[col.get(c)]);
  const CELL = 100;
  const cell = (x, y, z) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
  const grid = new Map();
  const bolts = bs.rows.map((r) => ({ p: [at(r, 'x'), at(r, 'y'), at(r, 'z')], n: [at(r, 'nx'), at(r, 'ny'), at(r, 'nz')], grip: at(r, 'grip'), d: at(r, 'd') }));
  bolts.forEach((b, i) => {
    const nl = len3(b.n) || 1; b.n = b.n.map((x) => x / nl);
    const seen = new Set();
    for (let s = 0; s <= b.grip + CELL / 2; s += CELL / 2) {
      const q = [b.p[0] + s * b.n[0], b.p[1] + s * b.n[1], b.p[2] + s * b.n[2]];
      const k = cell(...q);
      if (seen.has(k)) continue; seen.add(k);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
  });
  for (const e of model.elements ?? []) {
    const f = frameOf(model, e);
    if (!f || !f.p.holes?.length) continue;
    const m = normMark(e.mark);
    for (const h of f.p.holes) {
      const c0 = world(f, Number(h[0]), Number(h[1]), 0); const c1 = world(f, Number(h[0]), Number(h[1]), f.t);
      const mid = world(f, Number(h[0]), Number(h[1]), f.t / 2);
      const r = Number(h[2]) / 2 + 1;
      for (const i of grid.get(cell(...mid)) ?? []) {
        const b = bolts[i];
        if (Math.abs(dot(b.n, f.w)) < 0.9) continue;
        const s = dot(sub(mid, b.p), b.n);
        const off = sub(sub(mid, b.p), b.n.map((x) => x * s));
        if (len3(off) > r) continue;
        const s0 = dot(sub(c0, b.p), b.n); const s1 = dot(sub(c1, b.p), b.n);
        if (Math.min(s0, s1) < -1 || Math.max(s0, s1) > b.grip + 1) continue;
        const x = out.get(m) ?? { grip: 0, bolts: 0 };
        x.grip = Math.max(x.grip, b.grip); x.bolts += 1;
        out.set(m, x);
        break;   // one bolt a hole
      }
    }
  }
  return out;
}

/** PURE: model pieces per mark, the studs of a grid each. Map normMark → count. */
export function pieceCounts(model) {
  return new Map([...marksOfModel(model)].map(([m, x]) => [m, x.pieces]));
}

/**
 * The T-joints of each assembly level (one copy): Map normMark(level) → { mm (fillet both sides), joints, skipped? }.
 * Plates A and B at right angles where an edge of A lies on a face of B: the part of that edge inside B's outline is a
 * joint. Two segments of one piece (an angle's legs, a bent plate) are not a joint.
 */
export function weldLengths(model, { maxElements = 400 } = {}) {
  const out = new Map();
  const pieceOf = new Map();
  for (const p of piecesOfModel(model)) for (const e of p.els) pieceOf.set(e, p);
  for (const [lv, els] of levelCopies(model)) {
    const fr = els.map((e) => frameOf(model, e)).filter(Boolean);
    for (const f of fr) f.piece = pieceOf.get(f.e);
    if (fr.length > maxElements) { out.set(lv, { mm: null, joints: 0, skipped: `${fr.length} pieces` }); continue; }
    let mm = 0; let joints = 0;
    for (const A of fr) {
      for (const B of fr) {
        if (A === B || Math.abs(dot(A.w, B.w)) > 0.1) continue;
        if (A.piece === B.piece) continue;
        const pts = A.pts;
        for (let i = 0; i < pts.length; i++) {
          const a = world(A, pts[i][0], pts[i][1], A.t / 2); const b = world(A, pts[(i + 1) % pts.length][0], pts[(i + 1) % pts.length][1], A.t / 2);
          const la = local(B, a); const lb = local(B, b);
          const onFace = (z) => Math.abs(la[2] - z) <= 1.5 && Math.abs(lb[2] - z) <= 1.5;
          if (!onFace(0) && !onFace(B.t)) continue;
          const L = len3(sub(b, a));
          if (L < 5) continue;
          const N = 20; let inside = 0;
          for (let k = 0; k <= N; k++) {
            const x = la[0] + ((lb[0] - la[0]) * k) / N; const y = la[1] + ((lb[1] - la[1]) * k) / N;
            if (inPolygon(x, y, B.pts)) inside += 1;
          }
          if (!inside) continue;
          mm += 2 * L * (inside / (N + 1)); joints += 1;
        }
      }
    }
    out.set(lv, { mm: r3(mm), joints });
  }
  return out;
}

const GENERIC = new Set(['members', 'member', 'webs', 'flanges', 'flange', 'with', 'from', 'welds', 'weld', 'plates', 'plate', 'joint', 'joints', 'each']);
/** A weld size bom.json's `welds` gives for an assembly, by its name: every telling word of the weld's place ("stringer web to flanges" → stringer) in the name. */
export function weldSizeFor(welds, name) {
  const n = String(name ?? '').toLowerCase();
  for (const w of welds ?? []) {
    const where = String(w.where ?? '').toLowerCase().split(',')[0];
    const words = where.split(/[^a-z]+/).filter((x) => x.length >= 4 && !GENERIC.has(x));
    // "stringer web to flanges": the place is the words before "web"/"to" — the member named.
    const named = words.filter((x) => x !== 'web');
    if (named.length && named.every((x) => n.includes(x)) && Number(w.sizeMm) > 0) return { mm: Number(w.sizeMm), where: w.where };
  }
  return null;
}

/** mm or mm² in a specification's unit. */
export function inUom(value, kind, uom) {
  if (value == null) return null;
  const u = String(uom ?? '').toLowerCase().replace('²', '2');
  if (kind === 'len') return u === 'm' ? value / 1000 : u === 'cm' ? value / 10 : value;
  if (kind === 'area') return ['m2', 'sqm', 'sq m'].includes(u) ? value / 1e6 : u === 'cm2' ? value / 100 : value;
  return value;
}
