/**
 * nestGeometry.js — CF_ERP. What a laid-out plate is made of, and its CNC file.
 *
 * ── THE BOUNDARY ────────────────────────────────────────────────────────────
 * PURE GEOMETRY, like nestingPacker.js: no database, no tenant, no order.
 * `scripts/cf_kepl/nest_geometry_test.mjs` runs it with made-up numbers.
 *
 * ── WASTE BY CAUSE (CF_ERP_NESTING_PLAN, "Decided 2026-09-29") ─────────────
 * Every square millimetre of the plate is given to exactly ONE cause, in this
 * priority, so the causes add up to the plate and nothing is counted twice:
 *
 *   1. parts          the pieces themselves (true size)
 *   2. kerf           each piece's halo one kerf wide, clipped to the plate.
 *                     Two pieces sharing a boundary are one kerf apart, so
 *                     their halos overlap and the shared cut is charged once.
 *   3. sequenceGaps   the band between two consecutive sequences, beyond the
 *                     kerf halos. With the packer's 6 mm gap and a 3 mm kerf
 *                     that band is empty — the gap is all kerf — and that is
 *                     the honest answer, not a bug.
 *   4. rim            a kerf-wide band along the plate edge (the rim is cut).
 *   5. offcut / wastage   what is left, split into 4-connected regions. A
 *                     region is a reusable OFFCUT when its area is at least
 *                     minOffcutArea AND the short side of its largest
 *                     inscribed axis-aligned rectangle is at least
 *                     minOffcutSide (a long sliver between rows is not
 *                     reusable). Everything else is wastage.
 *
 * ── HOW: A COORDINATE-COMPRESSED CELL GRID ─────────────────────────────────
 * Every edge that matters (plate, rim, each piece and its halo, each band) is
 * a grid line; the cells between them are uniform, so painting and summing
 * cells is exact — no rasterisation error, and a 300-piece plate is a few
 * hundred thousand cells, a few milliseconds.
 *
 * Coordinates are the packer's: x along the plate LENGTH, y along its WIDTH,
 * origin at the plate corner (drawn bottom-left). Rows run along x and
 * sequences stack in y; a layout whose sequences sit side by side in x is
 * handled too (the band is then vertical).
 *
 * ── PIECES WITHOUT A LAYOUT ─────────────────────────────────────────────────
 * A piece with null x/y is on the plate but nobody knows where (an imported
 * nest our packer could not fit). The geometry ignores it; partsArea still
 * counts it, and its area plus a one-kerf pitch allowance ((L+k)(W+k) − LW,
 * charged to kerf) is taken out of the free area. With any such piece there
 * are NO offcuts — we cannot say where the free steel is — so the remaining
 * free area is all wastage. If the unlaid pieces need more than the free area
 * the identity cannot hold; the shortfall is reported as `overflow` (mm²).
 *
 * ── CUT LENGTH AND PIERCES (an approximation, documented) ──────────────────
 * cutLength = Σ piece perimeters − every stretch of edge two pieces SHARE
 * (facing edges exactly one kerf apart and overlapping — one cut serves both,
 * the packer's common boundary). The plate's own rim is not added: the cut
 * that frees a piece next to the rim is that piece's own edge. Lead-ins and
 * rapid moves are the CNC software's business. pierces = one per laid piece.
 */

const Q = 1e4;                    // coordinate key quantum: 0.1 µm
const EPS = 1e-6;
const keyOf = (v) => Math.round(v * Q);
const r3 = (v) => Math.round(v * 1000) / 1000;

/* ─────────────────────────────── analyseNest ───────────────────────────── */

/**
 * @param {{ length:number, width:number, kerf?:number, seqGapMin?:number,
 *           pieces: Array<{x:number|null, y:number|null, length:number, width:number,
 *                          seqNo?:number, rowNo?:number}>,
 *           minOffcutArea?:number, minOffcutSide?:number }} input
 * @returns {{ plateArea:number, partsArea:number,
 *             waste:{kerf:number, sequenceGaps:number, rim:number, offcut:number, wastage:number},
 *             offcuts:Array<{area:number, bbox:{x,y,length,width}, rect:{x,y,length,width},
 *                            outline:Array<Array<[number,number]>>}>,
 *             cutLength:number, pierces:number,
 *             laid:number, unlaid:number, overflow:number, warnings:string[] }}
 */
export function analyseNest({
  length, width, kerf = 0, seqGapMin = 0, pieces = [],
  minOffcutArea = 90000, minOffcutSide = 100,
} = {}) {
  const L = Number(length);
  const W = Number(width);
  if (!(L > 0) || !(W > 0)) throw new TypeError('analyseNest: plate length and width must be positive numbers');
  const k = Math.max(0, Number(kerf) || 0);
  const minArea = Number(minOffcutArea ?? 90000);
  const minSide = Number(minOffcutSide ?? 100);
  const gapMin = Number(seqGapMin) || 0;
  const warnings = [];

  /* the pieces: laid (with a position) and unlaid (null x/y) */
  const laid = [];
  let unlaidParts = 0;
  let unlaidKerf = 0;
  let unlaidCount = 0;
  let overhang = 0;
  for (const p of pieces ?? []) {
    const l = Number(p?.length);
    const w = Number(p?.width);
    if (!(l > 0) || !(w > 0)) { warnings.push('A piece with no size was ignored.'); continue; }
    const hasXY = p.x != null && p.y != null && p.x !== '' && p.y !== ''
      && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y));
    if (!hasXY) {
      unlaidCount += 1;
      unlaidParts += l * w;
      unlaidKerf += (l + k) * (w + k) - l * w;
      continue;
    }
    const x0 = Number(p.x);
    const y0 = Number(p.y);
    if (x0 < -EPS || y0 < -EPS || x0 + l > L + EPS || y0 + w > W + EPS) overhang += 1;
    laid.push({
      x0, y0, x1: x0 + l, y1: y0 + w, l, w,
      seq: p.seqNo ?? p.seq_no ?? p.sequence ?? 1,
    });
  }
  if (overhang) warnings.push(`${overhang} piece(s) hang over the plate edge; only the part on the plate is counted.`);

  const cx = (v) => Math.min(L, Math.max(0, v));
  const cy = (v) => Math.min(W, Math.max(0, v));

  /* sequence-gap bands */
  const bands = [];
  if (laid.length) {
    const ext = new Map();
    for (const p of laid) {
      const e = ext.get(p.seq);
      if (!e) ext.set(p.seq, { x0: p.x0, x1: p.x1, y0: p.y0, y1: p.y1 });
      else {
        e.x0 = Math.min(e.x0, p.x0); e.x1 = Math.max(e.x1, p.x1);
        e.y0 = Math.min(e.y0, p.y0); e.y1 = Math.max(e.y1, p.y1);
      }
    }
    const seqs = [...ext.keys()].sort((a, b) => Number(a) - Number(b));
    for (let n = 1; n < seqs.length; n += 1) {
      const a = ext.get(seqs[n - 1]);
      const b = ext.get(seqs[n]);
      let band = null;
      let gap = null;
      if (a.y1 <= b.y0 + EPS || b.y1 <= a.y0 + EPS) {
        const [lo, hi] = a.y1 <= b.y0 + EPS ? [a.y1, b.y0] : [b.y1, a.y0];
        gap = hi - lo;
        const bx0 = Math.max(a.x0, b.x0) - k;
        const bx1 = Math.min(a.x1, b.x1) + k;
        if (hi > lo + EPS && bx1 > bx0 + EPS) band = { x0: bx0, x1: bx1, y0: lo, y1: hi };
      } else if (a.x1 <= b.x0 + EPS || b.x1 <= a.x0 + EPS) {
        const [lo, hi] = a.x1 <= b.x0 + EPS ? [a.x1, b.x0] : [b.x1, a.x0];
        gap = hi - lo;
        const by0 = Math.max(a.y0, b.y0) - k;
        const by1 = Math.min(a.y1, b.y1) + k;
        if (hi > lo + EPS && by1 > by0 + EPS) band = { x0: lo, x1: hi, y0: by0, y1: by1 };
      } else {
        warnings.push(`Sequences ${seqs[n - 1]} and ${seqs[n]} overlap each other.`);
      }
      if (gap != null && gapMin > 0 && gap < gapMin - 1e-3) {
        warnings.push(`Sequences ${seqs[n - 1]} and ${seqs[n]} are only ${r3(gap)} mm apart; the minimum is ${gapMin} mm.`);
      }
      if (band) bands.push(band);
    }
  }

  /* the compressed grid */
  const xsRaw = [0, L, cx(k), cx(L - k)];
  const ysRaw = [0, W, cy(k), cy(W - k)];
  for (const p of laid) {
    xsRaw.push(cx(p.x0), cx(p.x1), cx(p.x0 - k), cx(p.x1 + k));
    ysRaw.push(cy(p.y0), cy(p.y1), cy(p.y0 - k), cy(p.y1 + k));
  }
  for (const b of bands) { xsRaw.push(cx(b.x0), cx(b.x1)); ysRaw.push(cy(b.y0), cy(b.y1)); }
  const xs = uniqSorted(xsRaw);
  const ys = uniqSorted(ysRaw);
  const xIdx = new Map(xs.map((v, i) => [keyOf(v), i]));
  const yIdx = new Map(ys.map((v, i) => [keyOf(v), i]));
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const ix = (v) => xIdx.get(keyOf(cx(v)));
  const iy = (v) => yIdx.get(keyOf(cy(v)));
  const cls = new Uint8Array(nx * ny);   // 0 free, 1 part, 2 kerf, 3 seq gap, 4 rim

  let overlapCells = 0;
  const paint = (x0, x1, y0, y1, val) => {
    const i0 = ix(x0); const i1 = ix(x1); const j0 = iy(y0); const j1 = iy(y1);
    for (let j = j0; j < j1; j += 1) {
      const row = j * nx;
      for (let i = i0; i < i1; i += 1) {
        const c = row + i;
        if (val === 1) { if (cls[c] === 1) overlapCells += 1; cls[c] = 1; } else if (cls[c] === 0) cls[c] = val;
      }
    }
  };
  for (const p of laid) paint(p.x0, p.x1, p.y0, p.y1, 1);
  if (overlapCells) warnings.push('Some pieces overlap each other; the overlap is counted once.');
  if (k > 0) for (const p of laid) paint(p.x0 - k, p.x1 + k, p.y0 - k, p.y1 + k, 2);
  for (const b of bands) paint(b.x0, b.x1, b.y0, b.y1, 3);
  if (k > 0) {
    paint(0, L, 0, k, 4);
    paint(0, L, W - k, W, 4);
    paint(0, k, 0, W, 4);
    paint(L - k, L, 0, W, 4);
  }

  /* sums per class */
  const dx = new Float64Array(nx);
  const dy = new Float64Array(ny);
  for (let i = 0; i < nx; i += 1) dx[i] = xs[i + 1] - xs[i];
  for (let j = 0; j < ny; j += 1) dy[j] = ys[j + 1] - ys[j];
  const sums = [0, 0, 0, 0, 0];
  for (let j = 0; j < ny; j += 1) {
    const row = j * nx; const h = dy[j];
    for (let i = 0; i < nx; i += 1) sums[cls[row + i]] += dx[i] * h;
  }

  /* free regions */
  const label = new Int32Array(nx * ny).fill(-1);
  const order = new Int32Array(nx * ny);
  const stack = new Int32Array(nx * ny);
  const comps = [];
  let fill = 0;
  for (let c0 = 0; c0 < nx * ny; c0 += 1) {
    if (cls[c0] !== 0 || label[c0] !== -1) continue;
    const id = comps.length;
    const start = fill;
    let sp = 0;
    stack[sp++] = c0; label[c0] = id;
    let area = 0; let i0 = nx; let i1 = -1; let j0 = ny; let j1 = -1;
    while (sp) {
      const c = stack[--sp];
      order[fill++] = c;
      const j = (c / nx) | 0; const i = c - j * nx;
      area += dx[i] * dy[j];
      if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
      if (i > 0 && cls[c - 1] === 0 && label[c - 1] === -1) { label[c - 1] = id; stack[sp++] = c - 1; }
      if (i < nx - 1 && cls[c + 1] === 0 && label[c + 1] === -1) { label[c + 1] = id; stack[sp++] = c + 1; }
      if (j > 0 && cls[c - nx] === 0 && label[c - nx] === -1) { label[c - nx] = id; stack[sp++] = c - nx; }
      if (j < ny - 1 && cls[c + nx] === 0 && label[c + nx] === -1) { label[c + nx] = id; stack[sp++] = c + nx; }
    }
    comps.push({ id, start, end: fill, area, i0, i1, j0, j1 });
  }

  let offcutArea = 0;
  let wastageArea = 0;
  const offcuts = [];
  for (const comp of comps) {
    let isOffcut = false;
    let rect = null;
    if (unlaidCount === 0 && comp.area >= minArea - 1e-3) {
      rect = largestRect(comp, label, nx, xs, ys, dy);
      isOffcut = rect && Math.min(rect.length, rect.width) >= minSide - 1e-6;
    }
    if (!isOffcut) { wastageArea += comp.area; continue; }
    offcutArea += comp.area;
    offcuts.push({
      area: r3(comp.area),
      bbox: { x: r3(xs[comp.i0]), y: r3(ys[comp.j0]), length: r3(xs[comp.i1 + 1] - xs[comp.i0]), width: r3(ys[comp.j1 + 1] - ys[comp.j0]) },
      rect: { x: r3(rect.x), y: r3(rect.y), length: r3(rect.length), width: r3(rect.width) },
      outline: traceOutline(comp, order, label, nx, ny, xs, ys),
    });
  }
  // Biggest first: offcut -A is the one a person looks for first.
  offcuts.sort((a, b) => b.area - a.area || a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);

  /* pieces with no layout come out of the free area */
  let kerfArea = sums[2];
  let overflow = 0;
  if (unlaidCount) {
    const need = unlaidParts + unlaidKerf;
    wastageArea -= need;
    kerfArea += unlaidKerf;
    if (wastageArea < 0) { overflow = -wastageArea; wastageArea = 0; }
    warnings.push(`${unlaidCount} piece(s) have no layout; they are counted by area and no offcuts are claimed.`);
    if (overflow > 1) warnings.push(`The pieces need ${r3(overflow)} mm² more than the plate has.`);
  }

  /* cut length: perimeters less shared edges */
  let cutLength = 0;
  const byLeft = new Map();
  const byBottom = new Map();
  for (const p of laid) {
    cutLength += 2 * (p.l + p.w);
    const kl = keyOf(p.x0); const kb = keyOf(p.y0);
    if (!byLeft.has(kl)) byLeft.set(kl, []); byLeft.get(kl).push(p);
    if (!byBottom.has(kb)) byBottom.set(kb, []); byBottom.get(kb).push(p);
  }
  let shared = 0;
  for (const p of laid) {
    for (const q of byLeft.get(keyOf(p.x1 + k)) ?? []) {
      const o = Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0);
      if (q !== p && o > EPS) shared += o;
    }
    for (const q of byBottom.get(keyOf(p.y1 + k)) ?? []) {
      const o = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0);
      if (q !== p && o > EPS) shared += o;
    }
  }
  cutLength -= shared;

  return {
    plateArea: r3(L * W),
    partsArea: r3(sums[1] + unlaidParts),
    waste: {
      kerf: r3(kerfArea),
      sequenceGaps: r3(sums[3]),
      rim: r3(sums[4]),
      offcut: r3(offcutArea),
      wastage: r3(wastageArea),
    },
    offcuts,
    cutLength: r3(cutLength),
    pierces: laid.length,
    laid: laid.length,
    unlaid: unlaidCount,
    overflow: r3(overflow),
    warnings,
  };
}

function uniqSorted(vals) {
  const s = vals.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const out = [];
  let last = null;
  for (const v of s) {
    const kv = keyOf(v);
    if (kv !== last) { out.push(v); last = kv; }
  }
  return out;
}

/**
 * Largest inscribed axis-aligned rectangle of one region, by AREA in mm²
 * (ties: the squarer one). The histogram method over the compressed grid:
 * bars have variable widths, which the stack method handles unchanged.
 */
function largestRect(comp, label, nx, xs, ys, dy) {
  const { id, i0, i1, j0, j1 } = comp;
  const n = i1 - i0 + 1;
  const h = new Float64Array(n);
  let best = null;
  const st = [];
  for (let j = j0; j <= j1; j += 1) {
    const row = j * nx;
    for (let t = 0; t < n; t += 1) h[t] = label[row + i0 + t] === id ? h[t] + dy[j] : 0;
    st.length = 0;
    const yTop = ys[j + 1];
    for (let t = 0; t <= n; t += 1) {
      const hh = t < n ? h[t] : 0;
      const xAt = xs[i0 + t];
      let start = xAt;
      while (st.length && st[st.length - 1].h >= hh - EPS) {
        const top = st.pop();
        const len = xAt - top.start;
        const area = top.h * len;
        const short = Math.min(len, top.h);
        if (!best || area > best.area + 1e-6 || (Math.abs(area - best.area) <= 1e-6 && short > Math.min(best.length, best.width))) {
          best = { area, x: top.start, y: yTop - top.h, length: len, width: top.h };
        }
        start = top.start;
      }
      if (hh > EPS) st.push({ start, h: hh });
    }
  }
  return best;
}

/**
 * The outline of one region as closed rings of [x, y] (mm, first point not
 * repeated). Interior on the LEFT of every edge, so the outer ring runs
 * counter-clockwise and holes clockwise. At a pinch vertex (two cells meeting
 * only at a corner) the walk turns left, which keeps the region 4-connected.
 */
function traceOutline(comp, order, label, nx, ny, xs, ys) {
  const { id } = comp;
  const VX = nx + 1;
  const out = new Map();   // start vertex -> [{ to, dir, used }]
  const edges = [];
  const add = (from, to, dir) => {
    const e = { from, to, dir, used: false };
    edges.push(e);
    const list = out.get(from);
    if (list) list.push(e); else out.set(from, [e]);
  };
  const inC = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && label[j * nx + i] === id;
  for (let t = comp.start; t < comp.end; t += 1) {
    const c = order[t];
    const j = (c / nx) | 0; const i = c - j * nx;
    if (!inC(i, j - 1)) add(j * VX + i, j * VX + i + 1, 0);                   // E along the bottom
    if (!inC(i + 1, j)) add(j * VX + i + 1, (j + 1) * VX + i + 1, 1);         // N up the right
    if (!inC(i, j + 1)) add((j + 1) * VX + i + 1, (j + 1) * VX + i, 2);       // W along the top
    if (!inC(i - 1, j)) add((j + 1) * VX + i, j * VX + i, 3);                 // S down the left
  }
  const pt = (v) => [r3(xs[v % VX]), r3(ys[(v / VX) | 0])];
  const rings = [];
  for (const first of edges) {
    if (first.used) continue;
    const dirs = [];
    const verts = [];
    let e = first;
    for (;;) {
      e.used = true;
      verts.push(e.from); dirs.push(e.dir);
      const cand = out.get(e.to) ?? [];
      let next = null;
      for (const d of [(e.dir + 1) % 4, e.dir, (e.dir + 3) % 4]) {
        next = cand.find((x) => x.dir === d && (!x.used || x === first));
        if (next) break;
      }
      if (!next || next === first) break;
      e = next;
    }
    const ring = [];
    for (let t = 0; t < verts.length; t += 1) {
      const prev = dirs[(t + dirs.length - 1) % dirs.length];
      if (dirs[t] !== prev) ring.push(pt(verts[t]));
    }
    if (ring.length >= 3) rings.push(ring);
  }
  const signed = (r) => {
    let a = 0;
    for (let t = 0; t < r.length; t += 1) {
      const [x1, y1] = r[t]; const [x2, y2] = r[(t + 1) % r.length];
      a += x1 * y2 - x2 * y1;
    }
    return a / 2;
  };
  rings.sort((a, b) => signed(b) - signed(a));   // the outer (largest positive) first, holes after
  return rings;
}

/* ─────────────────────────────── nestToDxf ─────────────────────────────── */

/** The middle of the widest stretch of steel on a few lines across a part ([outline, …openings]). */
function labelSpot(rings) {
  let y0 = Infinity; let y1 = -Infinity;
  for (const [, y] of rings[0]) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
  let best = null;
  for (const fr of [0.5, 0.31, 0.69, 0.17, 0.83]) {
    const y = y0 + (y1 - y0) * fr + 0.0137;
    const xs = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y)) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) if (!best || xs[k + 1] - xs[k] > best.w + 1e-9) best = { w: xs[k + 1] - xs[k], x: (xs[k] + xs[k + 1]) / 2, y };
  }
  return best;
}

const LAYERS = [
  { name: 'PLATE', color: 7 },
  { name: 'PARTS', color: 3 },
  { name: 'LABELS', color: 2 },
  { name: 'OFFCUTS', color: 1 },
];

const num = (v) => {
  const s = (Math.round(Number(v) * 1000) / 1000).toFixed(3);
  return s.replace(/\.?0+$/, '') || '0';
};
// DXF R12 is 8-bit text; keep it plain ASCII so every reader agrees.
const txt = (s) => String(s ?? '').normalize('NFKD').replace(/[^\x20-\x7E]/g, '').trim();

/**
 * One nest as a DXF R12 ASCII drawing, in millimetres, origin at the plate's
 * bottom-left. Layers PLATE (outline), PARTS (each piece TRUE size — kerf
 * compensation is the cutting software's job), LABELS (cut plate code at each
 * piece centre), OFFCUTS (outlines); a title below the plate.
 *
 * @param {{ lot: { lotNo?, lot_no?, plateCode?, plate_code?, thickness?, thickness_mm?, grade?,
 *                  material?, length?, length_mm?, width?, width_mm? },
 *           pieces: Array<{ x, y, length, width, code?, cutPlateCode? }>,
 *           offcuts?: Array<{ offcutNo?, outline: Array<Array<[number, number]>> }> }} input
 * @returns {string}
 */
export function nestToDxf({ lot = {}, pieces = [], offcuts = [] } = {}) {
  const L = Number(lot.length ?? lot.length_mm);
  const W = Number(lot.width ?? lot.width_mm);
  if (!(L > 0) || !(W > 0)) throw new TypeError('nestToDxf: the lot needs a positive length and width');
  const lotNo = txt(lot.lotNo ?? lot.lot_no ?? '');
  const plateCode = txt(lot.plateCode ?? lot.plate_code ?? '');
  const t = lot.thickness ?? lot.thickness_mm;
  const grade = txt(lot.grade ?? '');

  const out = [];
  const g = (code, value) => { out.push(String(code), String(value)); };

  const titleH = Math.max(10, Math.min(120, W / 40));
  const titleY = -titleH * 2;

  /* HEADER */
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, 4);
  g(9, '$EXTMIN'); g(10, 0); g(20, num(titleY - titleH)); g(30, 0);
  g(9, '$EXTMAX'); g(10, num(L)); g(20, num(W)); g(30, 0);
  g(9, '$LIMMIN'); g(10, 0); g(20, 0);
  g(9, '$LIMMAX'); g(10, num(L)); g(20, num(W));
  g(0, 'ENDSEC');

  /* TABLES: line type + layers */
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 1);
  g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, 0);
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, LAYERS.length + 1);
  for (const ly of [{ name: '0', color: 7 }, ...LAYERS]) {
    g(0, 'LAYER'); g(2, ly.name); g(70, 0); g(62, ly.color); g(6, 'CONTINUOUS');
  }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  /* ENTITIES */
  g(0, 'SECTION'); g(2, 'ENTITIES');
  const poly = (layer, pts) => {
    g(0, 'POLYLINE'); g(8, layer); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, 1);
    for (const [x, y] of pts) { g(0, 'VERTEX'); g(8, layer); g(10, num(x)); g(20, num(y)); g(30, 0); }
    g(0, 'SEQEND'); g(8, layer);
  };
  const text = (layer, x, y, h, s, centred) => {
    g(0, 'TEXT'); g(8, layer); g(10, num(x)); g(20, num(y)); g(30, 0); g(40, num(h)); g(1, s);
    if (centred) { g(72, 1); g(11, num(x)); g(21, num(y)); g(31, 0); g(73, 2); }
  };

  poly('PLATE', [[0, 0], [L, 0], [L, W], [0, W]]);
  for (const p of pieces ?? []) {
    if (p?.x == null || p?.y == null) continue;
    const x = Number(p.x); const y = Number(p.y); const l = Number(p.length); const w = Number(p.width);
    if (![x, y, l, w].every(Number.isFinite) || !(l > 0) || !(w > 0)) continue;
    // A part with a drawing (partDrawingService) is drawn by its true outline, cut-outs and holes, already placed; else its rectangle.
    // CUT ORDER (2026-10-10): the pieces come in cut order (a row layout: sequence, row, position; a
    // free layout: along the plate, by x then y), and within a piece its CUT-OUTS AND HOLES ARE WRITTEN
    // BEFORE ITS OUTLINE — once the outline is cut the part is loose and nothing more can be cut in it.
    if (Array.isArray(p.outline) && p.outline.length) { for (const ring of [...p.outline.slice(1), p.outline[0]]) if (ring?.length >= 3) poly('PARTS', ring); }
    else poly('PARTS', [[x, y], [x + l, y], [x + l, y + w], [x, y + w]]);
    const label = txt(p.code ?? p.cutPlateCode ?? p.cut_plate_code ?? '');
    if (label) {
      // A drawn part is labelled IN ITS STEEL (the middle of its box may be a window, or outside
      // an angle altogether) so whatever reads the file back takes the label for the right part.
      const spot = Array.isArray(p.outline) && p.outline.length ? labelSpot(p.outline) : null;
      const room = spot ? Math.min(spot.w, l) : l;
      const h = Math.max(2, Math.min(50, Math.min(l, w) * 0.25, (room * 0.9) / (label.length * 0.9)));
      text('LABELS', spot ? spot.x : x + l / 2, spot ? spot.y : y + w / 2, h, label, true);
    }
  }
  for (const o of offcuts ?? []) {
    for (const ring of o?.outline ?? []) if (ring?.length >= 3) poly('OFFCUTS', ring);
    if (o?.offcutNo && o?.outline?.[0]?.length) {
      const r = o.rect ?? null;
      const [cxp, cyp] = r ? [r.x + r.length / 2, r.y + r.width / 2] : o.outline[0][0];
      const h = r ? Math.max(5, Math.min(80, Math.min(r.length, r.width) * 0.2)) : 20;
      text('OFFCUTS', cxp, cyp, h, txt(o.offcutNo), true);
    }
  }
  const title = [
    lotNo && `Nest ${lotNo}`,
    plateCode && `Plate ${plateCode}`,
    t != null && t !== '' && `${num(t)} mm`,
    grade,
    `${num(L)} x ${num(W)}`,
  ].filter(Boolean).join('  |  ');
  text('LABELS', 0, titleY, titleH, title, false);
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return `${out.join('\r\n')}\r\n`;
}
