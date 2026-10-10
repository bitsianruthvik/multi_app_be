/**
 * nestDxfFixtures.mjs — "customer" nesting DXFs, written the way different nesting programs
 * write them, for nest_dxf_reader_test.mjs and for later end-to-end scenarios. No database.
 *
 * A SHAPE is { name, loops, symmetry }: the first loop is the outline, the rest are openings.
 *   loop = { v: [[x, y, bulge?], …] }   a closed run of corners (bulge as in a DXF polyline)
 *        | { circle: [cx, cy, r] }
 *   symmetry = { rot, mirror }: turned by 360/rot it is itself; mirrored it is itself (about a
 *   vertical line). The test needs this to know which angle the reader should report.
 *
 * makeNestDxf({ plate, parts, style, options }) lays the parts out by THE PLACEMENT CONVENTION
 * (lib/nestDxfReader.js `placeRings`): (x, y) is the placed bounding box's min corner on the plate.
 *
 * STYLES
 *   polyline    closed LWPOLYLINEs (bulges) + CIRCLEs, the plate drawn, a TEXT in each part
 *   segments    loose LINEs and ARCs in no order, NO plate outline, a TEXT in each part
 *   blocks      every part an INSERT (rotation, mirror by x scale −1) of a BLOCK named by its label
 *   commoncut   loose LINEs with every shared cut drawn ONCE (and collinear cuts as one long line)
 *   commoncut-grid  the same, for blocks of equal parts (see gridParts): each shared cut is ONE long line
 *               right across the block, so the cuts CROSS with no end at the crossing; a block set
 *               against the plate's edge shares that edge too
 *   inches      polyline, drawn in inches ($INSUNITS 1)
 *   noisy       polyline at an offset origin, with lead-ins, pierce marks, rapid moves, a border,
 *               a dimension, MTEXT labels and a title block: "PL 16 x 2500 x 12000 E350"
 * `options` overrides any single choice of a style (see STYLES below).
 */
import { readPartDrawing } from '../../../apps/cf_erp/services/partGeometry.js';
import { placeRings } from '../../../apps/cf_erp/lib/nestDxfReader.js';

const RAD = Math.PI / 180;
const ARC_STEP_DEG = 5;

export const STYLES = {
  polyline: { geom: 'polyline', plate: 'polyline', labels: 'text' },
  segments: { geom: 'segments', plate: null, labels: 'text', shuffle: true },
  blocks: { geom: 'blocks', plate: 'polyline', labels: 'block' },
  commoncut: { geom: 'segments', plate: 'segments', labels: 'text', commonCut: true, shuffle: true },
  'commoncut-grid': { geom: 'segments', plate: 'segments', labels: 'text', commonCut: true, shuffle: true, partLayer: 'CUT' },
  inches: { geom: 'polyline', plate: 'polyline', labels: 'text', units: 'in' },
  noisy: { geom: 'polyline', plate: 'polyline', labels: 'mixed', origin: [1234.5, -678.9], leadIns: true, rapidLayer: 'RAPID', border: true, title: ['PL 16 x 2500 x 12000 E350', 'NEST NO: N12', 'DATE 10-10-2026', 'SCALE 1:20'] },
};

/* ───────────────────────────── shapes ───────────────────────────── */

const rectLoop = (x, y, l, w) => ({ v: [[x, y], [x + l, y], [x + l, y + w], [x, y + w]] });
const Q = Math.tan((90 * RAD) / 4);        // the bulge of a quarter circle

/** About eight plate parts of a bridge girder. */
export function girderShapes() {
  const holes = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) holes.push({ circle: [80 + i * 180, 80 + j * 120, 13] });
  return {
    flange: { name: 'flange', symmetry: { rot: 2, mirror: true }, loops: [rectLoop(0, 0, 3000, 450)] },
    // Web: both top corners coped (a concave quarter circle), one obround drain opening off-centre.
    web: {
      name: 'web', symmetry: { rot: 1, mirror: false },
      loops: [
        { v: [[0, 0], [3000, 0], [3000, 1150, -Q], [2950, 1200], [50, 1200, -Q], [0, 1150]] },
        { v: [[1100, 500], [1300, 500, 1], [1300, 700], [1100, 700, 1]] },
      ],
    },
    gusset: { name: 'gusset', symmetry: { rot: 1, mirror: false }, loops: [{ v: [[0, 0], [520, 0], [400, 320], [60, 320]] }] },
    angle: { name: 'angle', symmetry: { rot: 1, mirror: false }, loops: [{ v: [[0, 0], [400, 0], [400, 120], [120, 120], [120, 500], [0, 500]] }] },
    // Stiffener with one corner sniped.
    stiffener: { name: 'stiffener', symmetry: { rot: 1, mirror: false }, loops: [{ v: [[0, 0], [180, 0], [180, 900], [35, 900], [0, 865]] }] },
    disc: { name: 'disc', symmetry: { rot: Infinity, mirror: true }, loops: [{ circle: [250, 250, 250] }, { circle: [250, 250, 11] }] },
    // Splice plate with a 4 × 3 grid of 26 mm holes.
    splice: { name: 'splice', symmetry: { rot: 2, mirror: true }, loops: [rectLoop(0, 0, 700, 400), ...holes] },
    // A frame: a plate with a window.
    frame: { name: 'frame', symmetry: { rot: 2, mirror: true }, loops: [rectLoop(0, 0, 800, 600), rectLoop(150, 150, 500, 300)] },
    // A packer small enough to be nested in the frame's window.
    shim: { name: 'shim', symmetry: { rot: 2, mirror: true }, loops: [rectLoop(0, 0, 300, 180)] },
  };
}

export const rectShape = (length, width, name = `rect ${length}x${width}`) => ({ name, symmetry: { rot: length === width ? 4 : 2, mirror: true }, loops: [rectLoop(0, 0, length, width)] });
export const ringsShape = (rings, name = 'rings') => ({ name, symmetry: { rot: 1, mirror: false }, loops: rings.map((r) => ({ v: r.map(([x, y]) => [x, y]) })) });

function bulgePoints(p, q, bulge) {
  if (!bulge) return [p, q];
  const chord = Math.hypot(q[0] - p[0], q[1] - p[1]);
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
/** A loop as corners (curves flattened in 5° steps, as partGeometry does). */
export function flattenLoop(loop) {
  if (loop.circle) {
    const [cx, cy, r] = loop.circle;
    return Array.from({ length: 72 }, (_, k) => [cx + r * Math.cos(k * 5 * RAD), cy + r * Math.sin(k * 5 * RAD)]);
  }
  const pts = [];
  const n = loop.v.length;
  for (let k = 0; k < n; k++) pts.push(...bulgePoints(loop.v[k].slice(0, 2), loop.v[(k + 1) % n].slice(0, 2), loop.v[k][2] ?? 0).slice(0, -1));
  return pts;
}
const boxOf = (pts) => pts.reduce((b, [x, y]) => ({ x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
const signedArea = (pts) => { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]; return a / 2; };

/* ───────────────────────────── writing DXF ───────────────────────────── */

const f = (n) => String(Number(Number(n).toFixed(8)));
const ent = (...kv) => kv.map(String);
const LINE = (layer, p, q) => ent(0, 'LINE', 8, layer, 10, f(p[0]), 20, f(p[1]), 11, f(q[0]), 21, f(q[1]));
const ARC = (layer, c, r, a0, a1) => ent(0, 'ARC', 8, layer, 10, f(c[0]), 20, f(c[1]), 40, f(r), 50, f(a0), 51, f(a1));
const CIRCLE = (layer, c, r) => ent(0, 'CIRCLE', 8, layer, 10, f(c[0]), 20, f(c[1]), 40, f(r));
const POINT = (layer, p) => ent(0, 'POINT', 8, layer, 10, f(p[0]), 20, f(p[1]));
const LWPOLY = (layer, v) => ent(0, 'LWPOLYLINE', 8, layer, 90, v.length, 70, 1, ...v.flatMap(([x, y, b]) => [10, f(x), 20, f(y), ...(b ? [42, f(b)] : [])]));
const TEXT = (layer, p, h, s, { rot = 0, centred = false } = {}) => ent(0, 'TEXT', 8, layer, 10, f(p[0]), 20, f(p[1]), 40, f(h), 1, s, ...(rot ? [50, f(rot)] : []), ...(centred ? [72, 1, 11, f(p[0]), 21, f(p[1]), 73, 2] : []));
const MTEXT = (layer, p, h, s) => ent(0, 'MTEXT', 8, layer, 10, f(p[0]), 20, f(p[1]), 40, f(h), 71, 5, 1, s);

/** The single-part drawing of a shape, as CAD would save it (what the part's own DXF upload is). */
export function shapeToPartDxf(shape) {
  const body = shape.loops.flatMap((l) => (l.circle ? CIRCLE('PART', l.circle, l.circle[2]) : LWPOLY('PART', l.v)));
  return ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', ...body, '0', 'ENDSEC', '0', 'EOF'].join('\n');
}

/**
 * A matchNest candidate for a shape — its rings read from its own drawing by partGeometry, exactly
 * what the app holds for a cut plate with a drawing. `rings: false` gives a candidate with a
 * size only (a cut plate without a drawing).
 */
export function candidateOf(shape, { key, codes, rings = true } = {}) {
  const g = readPartDrawing(shapeToPartDxf(shape)).geometry;
  if (!g) throw new Error(`fixture shape ${shape.name} does not read as a part`);
  return { key: key ?? shape.name, codes: codes ?? [shape.name], rings: rings ? g.rings : null, length: g.lengthMm, width: g.widthMm };
}

/** Shelf layout: gives every item { shape|…, rotationDeg, mirrored } an x and y on the plate. */
export function shelfLayout(items, plate, { gap = 25, margin = 20 } = {}) {
  let x = margin; let y = margin; let shelf = 0;
  return items.map((it) => {
    const b = boxOf(placeLoops(shapeOfPart(it), { x: 0, y: 0, rotationDeg: it.rotationDeg ?? 0, mirrored: !!it.mirrored }).flatMap(flattenLoop));
    const l = b.x1 - b.x0; const w = b.y1 - b.y0;
    if (x + l > plate.length - margin && x > margin) { x = margin; y += shelf + gap; shelf = 0; }
    if (y + w > plate.width - margin) throw new Error(`shelfLayout: ${it.label ?? shapeOfPart(it).name} does not fit on the plate`);
    const placed = { ...it, x, y };
    x += l + gap; shelf = Math.max(shelf, w);
    return placed;
  });
}

/**
 * A block of cols × rows equal parts touching each other, lower-left corner at (x, y): the parts
 * of a common-cut grid. Give `rect` or `shape`, and the angle every cell is turned by.
 */
export function gridParts({ rect, shape, cols, rows, x = 0, y = 0, rotationDeg = 0, mirrored = false, label }) {
  const one = { rect, shape, rotationDeg, mirrored };
  const b = boxOf(placeLoops(shapeOfPart(one), { x: 0, y: 0, rotationDeg, mirrored }).flatMap(flattenLoop));
  const l = b.x1 - b.x0; const w = b.y1 - b.y0;
  const out = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) out.push({ ...one, x: x + i * l, y: y + j * w, label });
  return out;
}

const shapeOfPart = (p) => p.shape ?? (p.rings ? ringsShape(p.rings) : rectShape(p.rect.length, p.rect.width));

/** A shape's loops placed by the convention: normalise, mirror about y, rotate CCW, normalise, move. */
function placeLoops(shape, { x, y, rotationDeg = 0, mirrored = false }) {
  const flat0 = shape.loops.flatMap(flattenLoop);
  const b0 = boxOf(flat0);
  const flat = placeRings([flat0], { x: 0, y: 0, rotationDeg, mirrored })[0];
  const t = rotationDeg * RAD;
  const q = Math.round(rotationDeg / 90);
  const exact = Math.abs(rotationDeg - q * 90) < 1e-9;
  const cos = exact ? [1, 0, -1, 0][((q % 4) + 4) % 4] : Math.cos(t);
  const sin = exact ? [0, 1, 0, -1][((q % 4) + 4) % 4] : Math.sin(t);
  // placeRings re-normalised by the turned box; find that shift from any one point.
  const turn = ([px, py]) => { const nx = (px - b0.x0) * (mirrored ? -1 : 1); const ny = py - b0.y0; return [nx * cos - ny * sin, nx * sin + ny * cos]; };
  const t0 = turn(flat0[0]);
  const sx = flat[0][0] - t0[0] + x; const sy = flat[0][1] - t0[1] + y;
  const map = (p) => { const u = turn(p); return [u[0] + sx, u[1] + sy]; };
  const loops = shape.loops.map((l) => (l.circle
    ? { circle: [...map(l.circle), l.circle[2]] }
    : { v: l.v.map(([px, py, b]) => [...map([px, py]), (b ?? 0) * (mirrored ? -1 : 1)]) }));
  loops.place = map;
  return loops;
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** The widest stretch of material on a few lines through the part: where its label goes. */
function labelPoint(loops) {
  const rings = loops.map(flattenLoop);
  const b = boxOf(rings[0]);
  let best = null;
  for (const fr of [0.5, 0.31, 0.69, 0.17, 0.83]) {
    const y = b.y0 + (b.y1 - b.y0) * fr + 0.0137;
    const xs = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y)) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) if (!best || xs[k + 1] - xs[k] > best.w) best = { w: xs[k + 1] - xs[k], p: [(xs[k] + xs[k + 1]) / 2, y] };
  }
  return best;
}

/** Loose LINE / ARC / CIRCLE pieces of placed loops: [{ line: [p, q] } | { arc: [c, r, a0, a1] } | { circle: [c, r] }]. */
function piecesOf(loops) {
  const out = [];
  for (const l of loops) {
    if (l.circle) { out.push({ circle: [[l.circle[0], l.circle[1]], l.circle[2]] }); continue; }
    const n = l.v.length;
    for (let k = 0; k < n; k++) {
      const p = l.v[k]; const q = l.v[(k + 1) % n]; const b = p[2] ?? 0;
      if (!b) { out.push({ line: [[p[0], p[1]], [q[0], q[1]]] }); continue; }
      const chord = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const r = (chord * (1 + b * b)) / (4 * Math.abs(b));
      const d = (chord * (1 - b * b)) / (4 * b);
      const c = [(p[0] + q[0]) / 2 - ((q[1] - p[1]) / chord) * d, (p[1] + q[1]) / 2 + ((q[0] - p[0]) / chord) * d];
      const ap = Math.atan2(p[1] - c[1], p[0] - c[0]) / RAD; const aq = Math.atan2(q[1] - c[1], q[0] - c[0]) / RAD;
      out.push({ arc: b > 0 ? [c, r, ap, aq] : [c, r, aq, ap] });
    }
  }
  return out;
}

/** Collinear lines that touch or overlap become one line: the shared cut is drawn once. */
function mergeCollinear(lines) {
  const groups = new Map();
  for (const [p, q] of lines) {
    let dx = q[0] - p[0]; let dy = q[1] - p[1];
    const len = Math.hypot(dx, dy);
    dx /= len; dy /= len;
    if (dx < -1e-9 || (Math.abs(dx) <= 1e-9 && dy < 0)) { dx = -dx; dy = -dy; }
    const off = -p[0] * dy + p[1] * dx;                    // signed distance of the line from the origin
    const key = `${Math.round(Math.atan2(dy, dx) * 1e5)}|${Math.round(off * 1e3)}`;
    if (!groups.has(key)) groups.set(key, { dx, dy, off, spans: [] });
    const g = groups.get(key);
    const s0 = p[0] * g.dx + p[1] * g.dy; const s1 = q[0] * g.dx + q[1] * g.dy;
    g.spans.push([Math.min(s0, s1), Math.max(s0, s1)]);
  }
  const out = [];
  for (const g of groups.values()) {
    g.spans.sort((a, b) => a[0] - b[0]);
    let cur = g.spans[0].slice();
    const flush = () => out.push([[cur[0] * g.dx - g.off * g.dy, cur[0] * g.dy + g.off * g.dx], [cur[1] * g.dx - g.off * g.dy, cur[1] * g.dy + g.off * g.dx]]);
    for (const s of g.spans.slice(1)) { if (s[0] <= cur[1] + 1e-6) cur[1] = Math.max(cur[1], s[1]); else { flush(); cur = s.slice(); } }
    flush();
  }
  return out;
}

/**
 * One plate's nesting DXF.
 * @param {{ plate: { length, width }, parts: Array<{ shape?|rings?|rect?, x, y, rotationDeg?, mirrored?, label? }>, style?: keyof STYLES, options?: object, seed?: number }} spec
 */
export function makeNestDxf({ plate, parts, style = 'polyline', options = {}, seed = 7 }) {
  const o = { geom: 'polyline', plate: 'polyline', labels: 'text', units: 'mm', origin: [0, 0], shuffle: false, commonCut: false, leadIns: false, rapidLayer: 'RAPID', leadLayer: 'TOOLPATH', border: false, title: null, nestedBlocks: false, partLayer: 'PART', plateLayer: 'SHEET', insUnits: undefined, ...(STYLES[style] ?? {}), ...options };
  const u = o.units === 'in' ? 1 / 25.4 : 1;
  const G = (p) => [(p[0] + o.origin[0]) * u, (p[1] + o.origin[1]) * u];
  const rnd = mulberry(seed);
  const body = [];          // entity records, shuffled at the end when the style says so
  const fixed = [];         // plate, words — kept in place
  const blocks = [];
  const lines = [];         // straight cuts in mm (merged for a common-cut nest)
  const leadStarts = [];

  if (o.plate === 'polyline') fixed.push(LWPOLY(o.plateLayer, [[0, 0], [plate.length, 0], [plate.length, plate.width], [0, plate.width]].map(G)));
  if (o.plate === 'segments') { const c = [[0, 0], [plate.length, 0], [plate.length, plate.width], [0, plate.width]]; c.forEach((p, i) => lines.push([p, c[(i + 1) % 4]])); }

  const blockOf = new Map();
  parts.forEach((part, index) => {
    const shape = shapeOfPart(part);
    const at = { x: part.x, y: part.y, rotationDeg: part.rotationDeg ?? 0, mirrored: !!part.mirrored };
    const loops = placeLoops(shape, at);

    if (o.geom === 'polyline') {
      for (const l of loops) body.push(l.circle ? CIRCLE(o.partLayer, G(l.circle), l.circle[2] * u) : LWPOLY(o.partLayer, l.v.map(([x, y, b]) => [...G([x, y]), b])));
    } else if (o.geom === 'segments') {
      for (const pc of piecesOf(loops)) {
        if (pc.line) lines.push(pc.line);
        else if (pc.arc) body.push(ARC(o.partLayer, G(pc.arc[0]), pc.arc[1] * u, pc.arc[2], pc.arc[3]));
        else body.push(CIRCLE(o.partLayer, G(pc.circle[0]), pc.circle[1] * u));
      }
    } else if (o.geom === 'blocks') {
      // The block holds the shape as drawn (not normalised), about an arbitrary base point.
      const name = part.label ?? `${shape.name}_${index}`;
      const flat0 = shape.loops.flatMap(flattenLoop);
      const b0 = boxOf(flat0);
      const base = [b0.x0 + 10, b0.y0 - 5];
      const inner = o.nestedBlocks ? `GEOM_${name}` : name;
      if (!blockOf.has(inner)) {
        blockOf.set(inner, true);
        blocks.push(ent(0, 'BLOCK', 8, '0', 2, inner, 70, 0, 10, f(base[0] * u), 20, f(base[1] * u), 30, 0, 3, inner),
          ...shape.loops.map((l) => (l.circle ? CIRCLE('0', [l.circle[0] * u, l.circle[1] * u], l.circle[2] * u) : LWPOLY('0', l.v.map(([x, y, b]) => [x * u, y * u, b ?? 0])))),
          ent(0, 'ENDBLK', 8, '0'));
      }
      const ins = loops.place(base);                       // where the base point lands on the plate
      const sx = at.mirrored ? -1 : 1;
      if (!o.nestedBlocks) body.push(ent(0, 'INSERT', 8, o.partLayer, 2, inner, 10, f(G(ins)[0]), 20, f(G(ins)[1]), 41, sx, 42, 1, 50, f(at.rotationDeg)));
      else {
        // A wrapper block (named by the label) holds the shape's block turned 30° and moved; the
        // wrapper is placed turned the rest of the way, and carries the mirror.
        const alpha = 30; const d = [40, 25];
        if (!blockOf.has(name)) {
          blockOf.set(name, true);
          blocks.push(ent(0, 'BLOCK', 8, '0', 2, name, 70, 0, 10, 0, 20, 0, 30, 0, 3, name),
            ent(0, 'INSERT', 8, '0', 2, inner, 10, f(d[0] * u), 20, f(d[1] * u), 41, 1, 42, 1, 50, alpha),
            ent(0, 'ENDBLK', 8, '0'));
        }
        // ins + R(beta)·S·(d + R(alpha)·(p − base)); S·R(alpha) = R(−alpha)·S, so beta = angle + alpha when mirrored, else angle − alpha.
        const betaDeg = at.mirrored ? at.rotationDeg + alpha : at.rotationDeg - alpha;
        const beta = betaDeg * RAD;
        const sd = [d[0] * sx, d[1]];
        const w = [ins[0] - (sd[0] * Math.cos(beta) - sd[1] * Math.sin(beta)), ins[1] - (sd[0] * Math.sin(beta) + sd[1] * Math.cos(beta))];
        body.push(ent(0, 'INSERT', 8, o.partLayer, 2, name, 10, f(G(w)[0]), 20, f(G(w)[1]), 41, sx, 42, 1, 50, f(betaDeg)));
      }
    }

    // The label, in the material of the part.
    if (part.label && o.labels !== 'none' && o.labels !== 'block') {
      const lp = labelPoint(loops);
      const h = Math.max(5, Math.min(40, lp.w / (part.label.length + 2)));
      if (o.labels === 'mixed' && index % 3 === 0) fixed.push(MTEXT('LABELS', G(lp.p), h * u, `{\\fArial|b0|i0;\\H1.2x;${part.label}}\\PQTY 1`));
      else if (o.labels === 'mixed' && index % 3 === 1) fixed.push(TEXT('LABELS', G(lp.p), h * u, part.label, { centred: true, rot: at.rotationDeg }));
      else fixed.push(TEXT('TEXT', G(lp.p), h * u, part.label, { rot: o.labels === 'mixed' ? at.rotationDeg : 0 }));
    }

    // Lead-ins: a short line from the scrap onto the contour, ending in the middle of a cut.
    if (o.leadIns) {
      loops.forEach((l, li) => {
        const outline = li === 0;
        let start; let end;
        if (l.circle) {
          const [cx, cy, r] = l.circle;
          end = [cx + r, cy]; start = outline ? [cx + r + 8, cy] : [cx + r - Math.min(8, r / 2), cy];
        } else {
          const flat = flattenLoop(l);
          const s = Math.sign(signedArea(flat));
          const n = l.v.length;
          let k = l.v.findIndex((p, i) => !(p[2] ?? 0) && Math.hypot(l.v[(i + 1) % n][0] - p[0], l.v[(i + 1) % n][1] - p[1]) > 20);
          if (k < 0) k = 0;
          const p = l.v[k]; const q = l.v[(k + 1) % n];
          const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
          const left = [-(q[1] - p[1]) / len, (q[0] - p[0]) / len];
          end = [p[0] + (q[0] - p[0]) * 0.37, p[1] + (q[1] - p[1]) * 0.37];
          const side = (outline ? -1 : 1) * s * 8;         // outside the part, or inside the opening
          start = [end[0] + left[0] * side, end[1] + left[1] * side];
        }
        body.push(LINE(o.leadLayer, G(start), G(end)));
        body.push(POINT('PIERCE', G(start)));
        body.push(CIRCLE(o.leadLayer, G(start), 0.4 * u));
        if (outline) leadStarts.push(start);
      });
    }
  });

  for (const [p, q] of (o.commonCut ? mergeCollinear(lines) : lines)) body.push(LINE(o.geom === 'segments' ? o.partLayer : o.plateLayer, G(p), G(q)));
  for (let i = 1; i < leadStarts.length; i++) body.push(LINE(o.rapidLayer, G(leadStarts[i - 1]), G(leadStarts[i])));

  if (o.border) {
    const m = 300; const c = [[-m, -m - 400], [plate.length + m, -m - 400], [plate.length + m, plate.width + m], [-m, plate.width + m]];
    fixed.push(LWPOLY('BORDER', c.map(G)));
    fixed.push(LINE('TITLE', G([-m, -m]), G([plate.length + m, -m])));
    fixed.push(LINE('DIM', G([0, plate.width + 120]), G([plate.length, plate.width + 120])));
    fixed.push(TEXT('DIM', G([plate.length / 2, plate.width + 140]), 60 * u, String(plate.length)));
  }
  (o.title ?? []).forEach((s, i) => fixed.push(TEXT('TITLE', G([i * 2600 - 200, -520]), 80 * u, s)));

  if (o.shuffle) for (let i = body.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [body[i], body[j]] = [body[j], body[i]]; }

  const insUnits = o.insUnits !== undefined ? o.insUnits : (o.units === 'in' ? 1 : 4);
  const out = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015'];
  if (insUnits != null) out.push('9', '$INSUNITS', '70', String(insUnits));
  out.push('0', 'ENDSEC');
  if (blocks.length) out.push('0', 'SECTION', '2', 'BLOCKS', ...blocks.flat(), '0', 'ENDSEC');
  out.push('0', 'SECTION', '2', 'ENTITIES', ...fixed.flat(), ...body.flat(), '0', 'ENDSEC', '0', 'EOF');
  return `${out.join('\r\n')}\r\n`;
}

/** How many entities a DXF text holds (for the size the speed test states). */
export const entityCount = (dxf) => (dxf.match(/(^|\n)\s*0\r?\n(LINE|ARC|CIRCLE|LWPOLYLINE|POLYLINE|INSERT|TEXT|MTEXT|POINT|ELLIPSE|SPLINE)\r?\n/g) ?? []).length;
