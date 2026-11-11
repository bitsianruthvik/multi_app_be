/**
 * nestCutStock.js — CF_ERP. THE LENGTH COMBINER (2026-11-11; nest benchmark TM/nest_bench/cutstock, "variant B").
 *
 * One more CANDIDATE layout for a steel, made a different way from the packers: the long, nearly rectangular parts are
 * laid in three-stage guillotine patterns chosen for the WHOLE steel at once (cutting stock by column generation), so
 * the lengths that share a plate add up to the plate (7300 + 4495 in a 12 m plate, 8540 + 1610 in a 10 m one); the
 * other parts are then packed by the engine's own shape job, into the free space of those plates first, then on new
 * plates. nestingService runs it after the packers (a phase of its own, nestExtras.js) and keeps it only when the
 * engine's own ranking (packerPool.pickBest: pieces left off, sizes over the limit, nestCost score) says it is better,
 * so it never makes a steel worse.
 *
 *   ITEMS      a part in two turns (0 / 90) when its outline fills ≥ rectThr of its box; a part with qty ≥ 2 also as a
 *              chain of itself and its 180°-turned twin slid a kerf apart (2..8 long). Everything else is the REST.
 *   PATTERNS   a plate is cut along its length into LANES; a lane across into BLOCKS end to end; a block along into
 *              SUB-STRIPS of item widths; a sub-strip holds columns of k stacked items end to end. A kerf between all
 *              parts, the packers' rim (`margin`) at the plate edge.
 *   MASTER     LP min Σ cost·x, Σ a·x ≥ demand (HiGHS); pricing is an exact DP on a `grid` mm grid (pieces rounded up,
 *              capacities down, so every pattern is feasible in true mm). Integer answer: a MIP on the generated columns
 *              with the company's limit on plate sizes (binaries), the size penalty, the sheets available and — custom
 *              sizes under the mill's lot — at least `moq` plates per custom size (no padding: no plate is bought unused).
 *   CUSTOM     (`custom` set): a free CG over every custom size on the step gives the sizes the LP likes; a few size sets
 *              are then solved with the lot rule and the best kept.
 *
 * TIME. Every HiGHS call has a time limit; every loop reads the job's own deadline; the whole job has `totalMs`, and the
 * pool also kills the worker at `hardDeadlineAt` (packerPool.runAll) — a sleep or a stuck solve ends in the engine's
 * answer, never in a longer plan.
 *
 * PURE apart from the solver: numbers in, a packJob-shaped answer out.
 */
import { placeRings } from './shapePacker.js';
import { layoutScore } from './nestCost.js';
import { runPackJob } from './packJob.js';
import { bbox, boxOfRings, area, shift, ringDist, dropSpikes, outlineOf } from './nestRingMath.js';

/* ───────────────────────────── the solver ───────────────────────────── */
let LOADER = null; let HI = null;
async function highs(fresh = false) {
  if (!LOADER) LOADER = (await import('highs')).default;
  if (!HI || fresh) HI = await LOADER();
  return HI;
}
/** One HiGHS solve with a time limit in seconds (every call has one). Retried on a fresh instance after a WASM abort. */
async function solve(text, timeS, opts = {}) {
  const o = { time_limit: Math.max(0.2, timeS), ...opts };
  for (let attempt = 0; attempt < 3; attempt++) {
    try { const h = await highs(attempt > 0); return h.solve(text, o); } catch (e) { if (attempt === 2) throw e; }
  }
  return null;
}
export const solverAvailable = async () => { try { await highs(); return true; } catch { return false; } };

class OutOfTime extends Error { constructor() { super('out of time'); this.outOfTime = true; } }

/* ───────────────────────────── items ───────────────────────────── */
const fillOf = (ring) => { const b = bbox(ring); return area(ring) / Math.max(1e-9, (b.x1 - b.x0) * (b.y1 - b.y0)); };
const MAX_CHAIN = 8;

/** A part's outline turned as the packers turn it (placeRings), its box at the origin. */
const turned = (outline, rot) => placeRings({ outline, cutouts: [], holes: [] }, { x: 0, y: 0, rotationDeg: rot }).outline;

/** Smallest slide (whole mm) of B along `axis` leaving A and B at least kerf + 0.02 apart, and staying clear. */
function pairOffset(A, B, axis, kerf, deadline) {
  const bA = bbox(A); const ext = axis === 'x' ? bA.x1 - bA.x0 : bA.y1 - bA.y0;
  const ok = (d) => { const Bs = axis === 'x' ? shift(B, d, 0) : shift(B, 0, d); return ringDist(A, Bs, kerf + 1) >= kerf + 0.02; };
  for (let d = 0; d <= ext + kerf + 1; d += 1) {
    if ((d & 63) === 0 && Date.now() > deadline) throw new OutOfTime();
    if (!ok(d)) continue;
    let stable = true; for (let e = 1; e <= 4 && stable; e++) if (!ok(d + e * 0.5)) stable = false;
    if (stable) return d;
  }
  return Math.ceil(ext + kerf + 1);
}

/**
 * Items of one steel. pieces: the shape job's pieces [{ key, qty, rings, length, width }].
 * → { items: [{ id, parts: { key: n }, l, w, rel: [{ key, rot, ox, oy }] }], itemKeys: Set, rest: [key] }
 */
export function buildItems(pieces, { rectThr = 0.97, pairThr = 0.9, minLong = 0, kerf, rotOk = () => true, maxLen = 13900, deadline = Infinity }) {
  const items = []; const itemKeys = new Set(); const rest = [];
  let id = 0;
  for (const p of pieces) {
    const key = String(p.key); const qty = Number(p.qty) || 0;
    if (qty <= 0) continue;
    const outline = outlineOf(p);
    const clean = dropSpikes(outline);
    const f = fillOf(clean);
    const b = bbox(outline); const L = b.x1 - b.x0; const W = b.y1 - b.y0;
    if (Math.max(L, W) < minLong) { rest.push(key); continue; }
    const singles = []; const pairs = [];
    const single = (rot, kind) => { const o = turned(outline, rot); const bb = bbox(o); return { parts: { [key]: 1 }, l: bb.x1, w: bb.y1, rel: [{ key, rot, ox: 0, oy: 0 }], kind }; };
    if (f >= rectThr) for (const rot of [0, 90]) if (rotOk(rot)) singles.push(single(rot, 'single'));
    if (qty >= 2 && f < 0.995 && clean.length <= 40) {
      for (const rot of [0, 90]) {
        if (!rotOk(rot) || !rotOk((rot + 180) % 360)) continue;
        const A0 = turned(outline, rot); const B0 = turned(outline, (rot + 180) % 360);
        for (const axis of ['x', 'y']) {
          for (const [P, Q, pr, qr] of [[A0, B0, rot, (rot + 180) % 360], [B0, A0, (rot + 180) % 360, rot]]) {
            const d1 = pairOffset(P, Q, axis, kerf, deadline); const d2 = pairOffset(Q, P, axis, kerf, deadline);
            const rel = []; let at = 0;
            for (let n = 0; n < Math.min(qty, MAX_CHAIN); n++) {
              const even = n % 2 === 0; const R = even ? P : Q;
              rel.push({ key, rot: even ? pr : qr, ring: axis === 'x' ? shift(R, at, 0) : shift(R, 0, at) });
              at += even ? d1 : d2;
              if (n === 0) continue;
              const bb = boxOfRings(rel.map((r) => r.ring));
              if (Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) > maxLen) break;
              const pf = ((n + 1) * area(clean)) / ((bb.x1 - bb.x0) * (bb.y1 - bb.y0));
              if (pf >= pairThr && pf > f + 0.02) {
                pairs.push({ parts: { [key]: n + 1 }, l: bb.x1 - bb.x0, w: bb.y1 - bb.y0, kind: `chain${n + 1}-${axis}`,
                  rel: rel.map((r) => { const rb = bbox(r.ring); return { key, rot: r.rot, ox: rb.x0 - bb.x0, oy: rb.y0 - bb.y0 }; }) });
              }
            }
          }
        }
      }
    }
    if (pairs.length && !singles.length) for (const rot of [0, 90]) if (rotOk(rot)) singles.push(single(rot, 'single-box'));
    if (singles.length) {
      const seen = new Set();
      for (const it of [...singles, ...pairs]) {
        const k = `${JSON.stringify(it.parts)}|${it.l.toFixed(1)}x${it.w.toFixed(1)}`;
        if (seen.has(k)) continue; seen.add(k);
        it.id = id++; items.push(it);
      }
      itemKeys.add(key);
    } else rest.push(key);
  }
  return { items, itemKeys, rest };
}

/* ───────────────────────────── patterns (three-stage) ───────────────────────────── */
const alignUp = (v, step) => Math.ceil(v / step - 1e-9) * step;

/**
 * ctx: kerf, margin, grid g; std [{ key, L, W, cost, available }]; custom { minL, maxL, minW, maxW, step, costOf(L, W),
 * moqOf(L, W), removed: Set 'LxW' } or null; customList (a restricted set of custom sizes) or null.
 */
export function makeContext({ kerf, margin, grid = 5, items, demand, std, custom = null, customList = null, laneCap = 80, maxSizes = null, sizePenalty = 0 }) {
  const parts = [...demand.keys()];
  const pIndex = new Map(parts.map((p, i) => [p, i]));
  const g = grid;
  const its = items.map((it) => ({ ...it, lg: Math.ceil((it.l + kerf) / g - 1e-9), pv: Object.entries(it.parts).map(([p, c]) => [pIndex.get(p), c]) }));
  const laneW = [...new Set(its.map((it) => Math.round(it.w * 100) / 100))].sort((a, b) => a - b);
  const customOn = !!custom;
  const maxL = Math.max(...std.map((z) => z.L), customOn ? custom.maxL : 0);
  const maxW = Math.max(...std.map((z) => z.W), customOn ? custom.maxW : 0);
  const cap = (D) => Math.floor((D - 2 * margin + kerf) / g + 1e-9);
  const Lmax = cap(maxL); const Wmax = cap(maxW);
  const lanes = laneW.map((wl) => {
    const cols = [];
    for (const it of its) {
      if (it.w > wl + 1e-6) continue;
      const kmax = Math.floor((wl + kerf) / (it.w + kerf) + 1e-9);
      for (const k of kmax > 1 ? [1, kmax] : [1]) cols.push({ it, k });
    }
    return { wl, wg: Math.ceil((wl + kerf) / g - 1e-9), cols };
  }).filter((ln) => ln.wg <= Wmax);
  const ctx = { kerf, margin, g, its, parts, pIndex, demand: parts.map((p) => demand.get(p)), lanes, Lmax, Wmax, cap, std, custom, customOn, customList, maxSizes, sizePenalty };
  ctx.bw = blockLaneWidths(ctx, laneCap);
  return ctx;
}

function chunksOf(ctx, lane, pi) {
  const out = [];
  for (const c of lane.cols) {
    let val = 0; let bound = Infinity;
    for (const [pi_, cnt] of c.it.pv) { val += pi[pi_] * cnt * c.k; bound = Math.min(bound, Math.floor(ctx.demand[pi_] / (cnt * c.k))); }
    if (!(val > 1e-9) || bound < 1) continue;
    for (let m = 1; bound > 0; m *= 2) { const q = Math.min(m, bound); bound -= q; out.push({ c, q, w: c.it.lg * q, v: val * q }); }
  }
  return out;
}
function laneDP(ctx, lane, pi, keep = false) {
  const ch = chunksOf(ctx, lane, pi);
  const N = ctx.Lmax + 1;
  const V = new Float64Array(N);
  const bits = keep ? ch.map(() => new Uint8Array(N)) : null;
  for (let j = 0; j < ch.length; j++) {
    const { w, v } = ch[j]; if (w >= N) continue;
    const b = bits?.[j];
    for (let c = N - 1; c >= w; c--) { const nv = V[c - w] + v; if (nv > V[c] + 1e-9) { V[c] = nv; if (b) b[c] = 1; } }
  }
  return { V, ch, bits };
}
function laneContent(ctx, lane, pi, cap) {
  const { ch, bits } = laneDP(ctx, lane, pi, true);
  const cols = []; let c = cap;
  for (let j = ch.length - 1; j >= 0; j--) if (bits[j][c]) { cols.push({ it: ch[j].c.it, k: ch[j].c.k, q: ch[j].q }); c -= ch[j].w; }
  const flat = [];
  for (const x of cols) for (let i = 0; i < x.q; i++) flat.push({ it: x.it, k: x.k });
  flat.sort((a, b) => b.it.l - a.it.l);
  return flat;
}
function blockLaneWidths(ctx, cap) {
  const subs = ctx.lanes;
  const set = new Set(subs.map((s) => s.wg));
  const dem = subs.map((s) => s.cols.reduce((a, c) => a + (c.k === 1 ? c.it.pv.reduce((b, [p, n]) => b + ctx.demand[p] * n, 0) * c.it.l * c.it.w : 0), 0));
  const order = subs.map((_, i) => i).sort((a, b) => dem[b] - dem[a]);
  const pairs = [];
  for (let a = 0; a < order.length; a++) for (let b = a; b < order.length; b++) {
    const c = subs[order[a]].wg + subs[order[b]].wg; if (c > ctx.Wmax || set.has(c)) continue;
    pairs.push({ c, r: Math.max(a, b) * 1000 + Math.min(a, b) });
  }
  pairs.sort((p, q) => p.r - q.r);
  for (const p of pairs) { if (set.size >= Math.max(cap, subs.length)) break; set.add(p.c); }
  return [...set].sort((a, b) => a - b);
}
function tables3(ctx, pi) {
  const subs = ctx.lanes; const N = ctx.Lmax + 1; const BW = ctx.bw; const cMax = BW[BW.length - 1] ?? 0;
  const subV = subs.map((ln) => laneDP(ctx, ln, pi).V);
  const B = BW.map(() => new Float64Array(N));
  const P = new Float64Array(cMax + 1);
  for (let l = 1; l < N; l++) {
    let changed = false;
    for (let s = 0; s < subs.length && !changed; s++) if (subV[s][l] !== subV[s][l - 1]) changed = true;
    if (!changed) { for (let b = 0; b < BW.length; b++) B[b][l] = B[b][l - 1]; continue; }
    for (let c = 1; c <= cMax; c++) {
      let best = P[c - 1];
      for (let s = 0; s < subs.length; s++) { const w = subs[s].wg; if (w > c) break; const v = subV[s][l]; if (v > 0) { const nv = P[c - w] + v; if (nv > best) best = nv; } }
      P[c] = best;
    }
    for (let b = 0; b < BW.length; b++) B[b][l] = P[BW[b]];
  }
  const L = []; const arg = [];
  for (let b = 0; b < BW.length; b++) {
    const Bb = B[b]; const Lb = new Float64Array(N); const Ab = new Int32Array(N); const kl = []; const kv = [];
    for (let len = 1; len < N; len++) {
      let best = Lb[len - 1]; let a = 0;
      for (let k = 0; k < kl.length; k++) { const l = kl[k]; if (l > len) break; const nv = kv[k] + Lb[len - l]; if (nv > best + 1e-9) { best = nv; a = l; } }
      if (Bb[len] > best + 1e-9) { best = Bb[len]; a = len; kl.push(len); kv.push(Bb[len]); }
      Lb[len] = best; Ab[len] = a;
    }
    L.push(Lb); arg.push(Ab);
  }
  return { subV, B, L, arg };
}
function plateDP3(ctx, vals) {
  const N = ctx.Wmax + 1; const BW = ctx.bw;
  const P = new Float64Array(N); const arg = new Int32Array(N).fill(-1);
  for (let c = 1; c < N; c++) {
    P[c] = P[c - 1]; arg[c] = -1;
    for (let j = 0; j < BW.length; j++) { const w = BW[j]; if (w > c) break; const nv = P[c - w] + vals[j]; if (nv > P[c] + 1e-9) { P[c] = nv; arg[c] = j; } }
  }
  return { P, arg };
}
function subsOfBlock(ctx, T, l, c) {
  const subs = ctx.lanes; const P = new Float64Array(c + 1); const A = new Int32Array(c + 1).fill(-1);
  for (let x = 1; x <= c; x++) {
    P[x] = P[x - 1]; A[x] = -1;
    for (let s = 0; s < subs.length; s++) { const w = subs[s].wg; if (w > x) break; const v = T.subV[s][l]; if (v > 0) { const nv = P[x - w] + v; if (nv > P[x] + 1e-9) { P[x] = nv; A[x] = s; } } }
  }
  const out = []; let x = c; while (x > 0) { const s = A[x]; if (s < 0) { x -= 1; continue; } out.push(s); x -= subs[s].wg; }
  return out;
}
/** A pattern as a column: pieces (item, box corner in sheet mm from the rim), counts, extent (far edges). */
function buildColumn3(ctx, T, laneIdx, pi, Lc) {
  const k = ctx.kerf; const m = ctx.margin; const subs = ctx.lanes;
  const a = new Array(ctx.parts.length).fill(0);
  const pieces = []; const shape = [];
  const memo = new Map();
  const content = (s, l) => { const key = s + ':' + l; if (!memo.has(key)) memo.set(key, laneContent(ctx, subs[s], pi, l)); return memo.get(key); };
  let y = m; let usedL = 0; let usedW = 0;
  const lanes = laneIdx.slice().sort((p, q) => ctx.bw[q] - ctx.bw[p]);
  for (const b of lanes) {
    const blocks = []; let len = Lc; const Ab = T.arg[b];
    while (len > 0) { const l = Ab[len]; if (!l) { len -= 1; continue; } blocks.push(l); len -= l; }
    let x = m; let laneW = 0; const sh = [];
    for (const l of blocks) {
      const ss = subsOfBlock(ctx, T, l, ctx.bw[b]).sort((p, q) => subs[q].wl - subs[p].wl);
      let yy = y; let blockLen = 0; const bsh = [];
      for (const s of ss) {
        const cols = content(s, l); if (!cols.length) continue;
        const tw = Math.max(...cols.map((c) => c.k * c.it.w + (c.k - 1) * k));
        let xx = x;
        for (const c of cols) {
          for (let q = 0; q < c.k; q++) pieces.push({ item: c.it.id, x: xx, y: yy + q * (c.it.w + k) });
          for (const [p, cnt] of c.it.pv) a[p] += cnt * c.k;
          xx += c.it.l + k;
        }
        blockLen = Math.max(blockLen, xx - k - x);
        bsh.push(cols.map((c) => `${c.it.id}:${c.k}`).join('.'));
        yy += tw + k;
      }
      if (!bsh.length) continue;
      laneW = Math.max(laneW, yy - k - y);
      sh.push(`${l}[${bsh.join('|')}]`);
      x += blockLen + k;
    }
    if (!sh.length) continue;
    usedL = Math.max(usedL, x - k);
    y += laneW + k; usedW = y - k;
    shape.push(`${ctx.bw[b]}{${sh.join(',')}}`);
  }
  return { pieces, shape: shape.join('/'), a, usedL, usedW };
}

const sizeFits = (ctx, col, L, W) => col.usedL + ctx.margin <= L + 1e-6 && col.usedW + ctx.margin <= W + 1e-6;
const customSizes = (C) => { const Ls = []; const Ws = []; for (let L = alignUp(C.minL, C.step); L <= C.maxL + 1e-6; L += C.step) Ls.push(L); for (let W = alignUp(C.minW, C.step); W <= C.maxW + 1e-6; W += C.step) Ws.push(W); return { Ls, Ws }; };
const customOk = (C, L, W) => !C.removed?.has(`${L}x${W}`);

/** The cheapest size a column fits on: the sheets offered, or (custom) its own smallest size on the step. */
export function cheapestSize(ctx, col) {
  let best = null;
  for (const z of ctx.std) if (sizeFits(ctx, col, z.L, z.W)) { if (!best || z.cost < best.cost) best = { key: z.key, L: z.L, W: z.W, custom: false, cost: z.cost }; }
  if (ctx.customOn && ctx.customList) {
    for (const z of ctx.customList) if (sizeFits(ctx, col, z.L, z.W)) { const c = ctx.custom.costOf(z.L, z.W); if (!best || c < best.cost - 1e-9) best = { L: z.L, W: z.W, custom: true, cost: c }; }
  } else if (ctx.customOn) {
    const C = ctx.custom;
    const L = Math.max(alignUp(C.minL, C.step), alignUp(col.usedL + ctx.margin, C.step)); const W = Math.max(alignUp(C.minW, C.step), alignUp(col.usedW + ctx.margin, C.step));
    if (L <= C.maxL + 1e-6 && W <= C.maxW + 1e-6 && customOk(C, L, W)) { const c = C.costOf(L, W); if (!best || c < best.cost - 1e-9) best = { L, W, custom: true, cost: c }; }
  }
  return best;
}

/** Pricing under duals pi: the best columns (negative reduced cost), and the Farley ratio max(value / cost). */
export function price(ctx, pi, { maxCols = 6 } = {}) {
  const T = tables3(ctx, pi);
  const cands = []; let ratio = 0;
  const tryLength = (L, widths) => {
    const Lc = Math.min(ctx.Lmax, ctx.cap(L));
    if (Lc < 1) return;
    const vals = T.L.map((V) => V[Lc]);
    const { P, arg } = plateDP3(ctx, vals);
    for (const { W, cost } of widths) {
      const Wc = Math.min(ctx.Wmax, ctx.cap(W));
      if (Wc < 1) continue;
      const v = P[Wc]; if (!(v > 0)) continue;
      ratio = Math.max(ratio, v / cost);
      cands.push({ rc: cost - v, Lc, Wc, arg });
    }
  };
  for (const L of [...new Set(ctx.std.map((z) => z.L))]) tryLength(L, ctx.std.filter((z) => z.L === L).map((z) => ({ W: z.W, cost: z.cost })));
  if (ctx.customOn && ctx.customList) {
    for (const L of [...new Set(ctx.customList.map((z) => z.L))]) tryLength(L, ctx.customList.filter((z) => z.L === L).map((z) => ({ W: z.W, cost: ctx.custom.costOf(z.L, z.W) })));
  } else if (ctx.customOn) {
    const C = ctx.custom; const { Ls, Ws } = customSizes(C);
    for (const L of Ls) tryLength(L, Ws.filter((W) => customOk(C, L, W)).map((W) => ({ W, cost: C.costOf(L, W) })));
  }
  cands.sort((a, b) => a.rc - b.rc);
  const cols = []; const seen = new Set();
  for (const c of cands) {
    if (c.rc > -1e-6 || cols.length >= maxCols) break;
    const lanes = []; { let x = c.Wc; while (x > 0) { const j = c.arg[x]; if (j < 0) { x -= 1; continue; } lanes.push(j); x -= ctx.bw[j]; } }
    const col = buildColumn3(ctx, T, lanes, pi, c.Lc);
    const key = col.a.join(',') + '|' + col.shape;
    if (seen.has(key)) continue; seen.add(key);
    const sz = cheapestSize(ctx, col);
    if (!sz) continue;
    cols.push({ ...col, key, size: sz, cost: sz.cost });
  }
  return { cols, minRc: cands.length ? cands[0].rc : 0, ratio };
}

function lpText(ctx, cols, { integer = false, moq = null, cap = null, avail = null } = {}) {
  const obj = []; const rows = ctx.parts.map(() => []);
  cols.forEach((c, j) => { obj.push(`${c.cost.toFixed(4)} x${j}`); c.a.forEach((n, p) => { if (n) rows[p].push(`${n} x${j}`); }); });
  const extra = []; const gen = cols.map((_, j) => `x${j}`); const bins = [];
  if (moq) {
    moq.sizes.forEach((s, i) => {
      const vars = s.cols.map((j) => `x${j}`);
      extra.push(` m${i}a: ${vars.join(' + ')} - ${s.min} y${i} >= 0`);
      extra.push(` m${i}b: ${vars.join(' + ')} - ${moq.M} y${i} <= 0`);
      if (ctx.sizePenalty > 0) obj.push(`${ctx.sizePenalty.toFixed(4)} y${i}`);
      bins.push(`y${i}`);
    });
  }
  if (cap) {
    const ys = moq ? moq.sizes.map((_, i) => `y${i}`) : [];
    cap.std.forEach((z, i) => { extra.push(` u${i}a: ${z.cols.map((j) => `x${j}`).join(' + ')} - ${cap.M} u${i} <= 0`); bins.push(`u${i}`); ys.push(`u${i}`); if (ctx.sizePenalty > 0) obj.push(`${ctx.sizePenalty.toFixed(4)} u${i}`); });
    if (cap.max && ys.length > cap.max) extra.push(` ncap: ${ys.join(' + ')} <= ${cap.max}`);
  }
  if (avail) avail.forEach((z, i) => { if (Number.isFinite(z.n)) extra.push(` av${i}: ${z.cols.map((j) => `x${j}`).join(' + ')} <= ${z.n}`); });
  const lines = ['Minimize', ` obj: ${obj.join(' + ')}`, 'Subject To'];
  rows.forEach((r, p) => { if (!r.length && ctx.demand[p] > 0) throw new Error(`part ${ctx.parts[p]} is in no column`); if (r.length) lines.push(` d${p}: ${r.join(' + ')} >= ${ctx.demand[p]}`); });
  lines.push(...extra);
  lines.push('Bounds'); for (const v of gen) lines.push(` ${v} >= 0`);
  if (integer) { lines.push('General', ' ' + gen.join(' ')); if (bins.length) lines.push('Binary', ' ' + bins.join(' ')); }
  lines.push('End');
  return lines.join('\n');
}

/** Column generation to LP optimality, the deadline or `timeMs`. pool = { cols, keys } shared across calls. */
export async function columnGeneration(ctx, { timeMs = 60000, deadline = Infinity, pool = null, rcTol = 0.5, stopBelow = null } = {}) {
  const t0 = Date.now(); const end = Math.min(deadline, t0 + timeMs);
  const P = pool ?? { cols: [], keys: new Set() };
  const cols = P.cols; const keys = P.keys;
  const addCol = (c) => { if (keys.has(c.key)) return false; keys.add(c.key); cols.push(c); return true; };
  const covered = new Array(ctx.parts.length).fill(false);
  for (const c of cols) c.a.forEach((n, p) => { if (n > 0) covered[p] = true; });
  for (let p = 0; p < ctx.parts.length; p++) {
    if (covered[p] || !(ctx.demand[p] > 0)) continue;
    if (Date.now() > deadline) throw new OutOfTime();
    const pi = ctx.parts.map((_, i) => (i === p ? 1e15 : 0));   // far above any plate's cost (mm²)
    let r = price({ ...ctx, customOn: false, customList: null }, pi, { maxCols: 1 });
    if (!r.cols.length && ctx.customOn) r = price(ctx, pi, { maxCols: 1 });
    if (!r.cols.length) throw new Error(`part ${ctx.parts[p]} fits no plate`);
    addCol(r.cols[0]);
  }
  let lp = null; let lb = 0; let iters = 0; let pi = null; let x = null; let pruned = false;
  for (;;) {
    iters += 1;
    const s = await solve(lpText(ctx, cols), Math.max(0.5, (end - Date.now()) / 1000));
    if (s?.Status !== 'Optimal') { if (lp != null) break; throw new Error(`LP ${s?.Status}`); }
    lp = s.ObjectiveValue;
    x = cols.map((_, j) => s.Columns[`x${j}`]?.Primal ?? 0);
    pi = new Array(ctx.parts.length).fill(0);
    for (const row of s.Rows) { if (row.Name[0] !== 'd') continue; pi[Number(row.Name.slice(1))] = Math.max(0, row.Dual); }
    const pr = price(ctx, pi);
    lb = Math.max(lb, lp / Math.max(1, pr.ratio));
    if (stopBelow != null && lb >= stopBelow) { pruned = true; break; }
    let added = 0; for (const c of pr.cols) if (addCol(c)) added++;
    if (!added || pr.minRc > -rcTol) { if (pr.minRc > -1e-6 || !added) lb = Math.max(lb, lp); break; }
    if (Date.now() > end) break;
  }
  return { cols, lp, lb, iters, pi, x, pruned, ms: Date.now() - t0 };
}

/** More columns for the integer master: pricing under randomly perturbed duals (seeded). */
function enrich(ctx, pool, pi, { rounds = 30, seed = 1, spread = 0.35, deadline = Infinity } = {}) {
  let st = (seed * 9973 + 17) % 2147483647 || 1; const rnd = () => ((st = (st * 16807) % 2147483647) / 2147483647);
  for (let r = 0; r < rounds && Date.now() < deadline; r++) {
    const q = pi.map((v) => v * (1 + spread * (2 * rnd() - 1)));
    for (const c of price(ctx, q, { maxCols: 4 }).cols) if (!pool.keys.has(c.key)) { pool.keys.add(c.key); pool.cols.push(c); }
  }
}

/** Residual diving: CG on what is left, fix what the LP uses whole, repeat. → { plates: [{ col, size }], obj } */
async function dive(ctx, pool, { timeMs = 30000, deadline = Infinity } = {}) {
  const t0 = Date.now(); const end = Math.min(deadline, t0 + timeMs);
  const res = ctx.demand.slice(); const plates = []; let steps = 0;
  while (res.some((d) => d > 0)) {
    steps += 1;
    if (Date.now() > end || steps > 500) throw new OutOfTime();
    const sub = { ...ctx, demand: res.slice() };
    const cg = await columnGeneration(sub, { timeMs: Math.max(1500, (end - Date.now()) / 4), deadline: end, pool });
    const useful = (j) => cg.cols[j].a.some((n, p) => n > 0 && res[p] > 0);
    let fixed = 0;
    cg.x.forEach((v, j) => { const n = Math.floor(v + 1e-6); if (n >= 1 && useful(j)) { for (let i = 0; i < n; i++) plates.push({ col: cg.cols[j], size: cg.cols[j].size }); cg.cols[j].a.forEach((a, p) => { res[p] = Math.max(0, res[p] - a * n); }); fixed += n; } });
    if (!fixed) {
      let bj = -1; let bv = -1; cg.x.forEach((v, j) => { if (v > bv && useful(j)) { bv = v; bj = j; } });
      if (bj < 0) throw new Error('dive: nothing covers the rest');
      plates.push({ col: cg.cols[bj], size: cg.cols[bj].size }); cg.cols[bj].a.forEach((a, p) => { res[p] = Math.max(0, res[p] - a); });
    }
  }
  return { plates, obj: plates.reduce((a, p) => a + p.size.cost, 0) };
}

const sizeKey = (z) => `${z.custom ? 'C' : 'S'}:${z.L}x${z.W}`;

/** The integer master on the generated columns, with the lot rule, the size limit, the size penalty and availability. */
async function integerMaster(ctx, cols, { timeMs = 15000, deadline = Infinity, gap = 0.001 } = {}) {
  const vars = [];
  const custom = new Map();
  for (const c of cols) if (c.size.custom) custom.set(`${c.size.L}x${c.size.W}`, { L: c.size.L, W: c.size.W });
  for (const c of cols) {
    vars.push({ c, size: c.size });
    // the same pattern cut from another size of the set (so a size can be shared, and the size limit kept)
    for (const z of ctx.std) {
      if (!c.size.custom && z.key === c.size.key) continue;
      if (!sizeFits(ctx, c, z.L, z.W) || z.cost > c.cost * 1.3) continue;
      vars.push({ c, size: { key: z.key, L: z.L, W: z.W, custom: false, cost: z.cost } });
    }
    if (ctx.customOn) for (const z of custom.values()) {
      if (c.size.custom && z.L === c.size.L && z.W === c.size.W) continue;
      if (!sizeFits(ctx, c, z.L, z.W)) continue;
      const cost = ctx.custom.costOf(z.L, z.W);
      if (cost > c.cost * 1.25) continue;
      vars.push({ c, size: { L: z.L, W: z.W, custom: true, cost } });
    }
  }
  const asCols = vars.map((v) => ({ cost: v.size.cost, a: v.c.a }));
  const M = Math.max(200, ctx.demand.reduce((a, d) => a + d, 0));
  let moq = null;
  if (ctx.customOn) {
    const by = new Map();
    vars.forEach((v, j) => { if (!v.size.custom) return; const k = `${v.size.L}x${v.size.W}`; if (!by.has(k)) by.set(k, { L: v.size.L, W: v.size.W, min: ctx.custom.moqOf(v.size.L, v.size.W), cols: [] }); by.get(k).cols.push(j); });
    moq = { sizes: [...by.values()], M };
  }
  const stdBy = new Map();
  vars.forEach((v, j) => { if (v.size.custom) return; if (!stdBy.has(v.size.key)) stdBy.set(v.size.key, { cols: [], n: ctx.std.find((z) => z.key === v.size.key)?.available ?? Infinity }); stdBy.get(v.size.key).cols.push(j); });
  const cap = ctx.maxSizes || ctx.sizePenalty > 0 ? { std: [...stdBy.values()], max: ctx.maxSizes, M } : null;
  const text = lpText(ctx, asCols, { integer: true, moq, cap, avail: [...stdBy.values()] });
  const t0 = Date.now();
  const left = Math.min(timeMs, deadline - Date.now());
  if (left < 300) throw new OutOfTime();
  const s = await solve(text, left / 1000, { mip_rel_gap: gap });
  if (!(s?.Status === 'Optimal' || s?.Status === 'Time limit reached') || !Number.isFinite(s.ObjectiveValue)) throw new Error(`IP ${s?.Status}`);
  const plates = [];
  for (const [name, v] of Object.entries(s.Columns)) {
    const n = Math.round(v.Primal ?? 0); if (n <= 0 || name[0] !== 'x') continue;
    const j = Number(name.slice(1)); for (let i = 0; i < n; i++) plates.push({ col: vars[j].c, size: vars[j].size });
  }
  return { plates, obj: s.ObjectiveValue, status: s.Status, ms: Date.now() - t0 };
}

/** Do these plates keep the lot (custom sizes ≥ their minimum), the size limit and availability? */
function feasible(ctx, plates) {
  const n = new Map();
  for (const p of plates) { const k = sizeKey(p.size); n.set(k, { z: p.size, n: (n.get(k)?.n ?? 0) + 1 }); }
  if (ctx.maxSizes && n.size > ctx.maxSizes) return false;
  for (const { z, n: c } of n.values()) {
    if (z.custom && c < ctx.custom.moqOf(z.L, z.W)) return false;
    if (!z.custom && c > (ctx.std.find((s) => s.key === z.key)?.available ?? Infinity)) return false;
  }
  return true;
}
const objWithSizes = (ctx, plates) => plates.reduce((a, p) => a + p.size.cost, 0) + ctx.sizePenalty * Math.max(0, new Set(plates.map((p) => sizeKey(p.size))).size - 1);

/* ───────────────────────────── one variant of one steel ───────────────────────────── */

/**
 * One integer answer for a set of items: CG, enrich, dive, MIP; custom: a free CG, then size sets.
 * → { plates: [{ col, size }], ctx, lb } or null
 */
async function integerAnswer(mk, P, deadline, stopBelow) {
  const allCols = [];
  const solveCtx = async (cx, cgMs, ipMs) => {
    const pool = { cols: [], keys: new Set() };
    const okSize = (z) => !z.custom || (cx.customList ?? []).some((s) => s.L === z.L && s.W === z.W);
    for (const c of allCols) if (okSize(c.size) && !pool.keys.has(c.key)) { pool.keys.add(c.key); pool.cols.push(c); }
    const cg = await columnGeneration(cx, { timeMs: cgMs, deadline, pool, rcTol: P.rcTol, stopBelow });
    if (cg.pruned) return { cg, ip: null };
    enrich(cx, pool, cg.pi, { rounds: P.enrich, seed: P.seed, deadline: Math.min(deadline, Date.now() + P.enrichMs) });
    let dv = null;
    try { dv = await dive(cx, pool, { timeMs: P.diveMs, deadline }); } catch (e) { if (!e.outOfTime) dv = null; }
    const rcOf = (c) => c.cost - c.a.reduce((s, n, p) => s + n * cg.pi[p], 0);
    const inDive = new Set((dv?.plates ?? []).map((p) => p.col.key));
    const ipCols = pool.cols.filter((c) => inDive.has(c.key) || rcOf(c) <= 0.25 * c.cost);
    for (let p = 0; p < cx.parts.length; p++) {
      if (!(cx.demand[p] > 0) || ipCols.some((c) => c.a[p] > 0)) continue;
      ipCols.push(...pool.cols.filter((c) => c.a[p] > 0).sort((u, v) => rcOf(u) / u.cost - rcOf(v) / v.cost).slice(0, 5));
    }
    let ip = null;
    try { ip = await integerMaster(cx, ipCols, { timeMs: ipMs, deadline }); ip.obj = objWithSizes(cx, ip.plates); } catch (e) { if (e.outOfTime && !dv) throw e; }
    if (dv && feasible(cx, dv.plates)) { const o = objWithSizes(cx, dv.plates); if (!ip || o < ip.obj - 1e-6) ip = { plates: dv.plates, obj: o, status: 'dive' }; }
    const seen = new Set(allCols.map((c) => c.key + '@' + sizeKey(c.size)));
    for (const c of pool.cols) { const k = c.key + '@' + sizeKey(c.size); if (!seen.has(k)) { seen.add(k); allCols.push(c); } }
    return { cg, ip };
  };
  const ctx0 = mk(null);
  if (!ctx0.customOn) {
    const { cg, ip } = await solveCtx(ctx0, P.cgMs, P.ipMs);
    return ip ? { plates: ip.plates, ctx: ctx0, lb: cg.lb } : (cg.pruned ? { pruned: true, lb: cg.lb } : null);
  }
  // custom: a free CG over every size on the step → the LP bound and the sizes it likes; then size sets with the lot rule
  const pool = { cols: [], keys: new Set() };
  const cg = await columnGeneration(ctx0, { timeMs: P.cgMs, deadline, pool, rcTol: P.rcTol, stopBelow });
  if (cg.pruned) return { pruned: true, lb: cg.lb };
  const use = new Map();
  cg.x.forEach((v, j) => { const c = cg.cols[j]; if (v > 1e-6 && c.size.custom) { const k = `${c.size.L}x${c.size.W}`; use.set(k, { L: c.size.L, W: c.size.W, x: (use.get(k)?.x ?? 0) + v }); } });
  const top = [...use.values()].sort((p, q) => q.x - p.x).slice(0, 3);
  const sets = [[]]; for (const s of top) sets.push([s]);
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) sets.push([top[i], top[j]]);
  if (top.length >= 2) { const m = { L: Math.max(top[0].L, top[1].L), W: Math.max(top[0].W, top[1].W) }; if (!top.some((s) => s.L === m.L && s.W === m.W)) sets.push([m]); }
  let best = null;
  for (const S of sets) {
    if (Date.now() > deadline - 1000) break;
    const cx = mk(S);
    let r = null;
    try { r = await solveCtx(cx, Math.min(P.cgMs, P.cgSetMs), P.ipSetMs); } catch (e) { if (e.outOfTime) break; r = null; }
    if (r?.ip && (!best || r.ip.obj < best.obj - 1e-6)) best = { plates: r.ip.plates, obj: r.ip.obj, ctx: cx };
  }
  return best ? { plates: best.plates, ctx: best.ctx, lb: cg.lb } : null;
}

/* ───────────────────────────── the job ───────────────────────────── */

export const CUTSTOCK_EFFORT = Object.freeze({
  quick: { totalMs: 120_000, cgMs: 40_000, ipMs: 10_000, cgSetMs: 10_000, ipSetMs: 5_000, diveMs: 10_000, enrich: 15, enrichMs: 5_000, restMs: 15_000 },
  standard: { totalMs: 300_000, cgMs: 90_000, ipMs: 15_000, cgSetMs: 20_000, ipSetMs: 8_000, diveMs: 30_000, enrich: 30, enrichMs: 15_000, restMs: 30_000 },
  deep: { totalMs: 900_000, cgMs: 300_000, ipMs: 120_000, cgSetMs: 30_000, ipSetMs: 15_000, diveMs: 30_000, enrich: 30, enrichMs: 30_000, restMs: 60_000 },
});
export const variantsFor = (custom) => (custom ? [{ rectThr: 0.97, minLong: 0 }, { rectThr: 0.97, minLong: 3000 }] : [{ rectThr: 0.97, minLong: 0 }, { rectThr: 0, minLong: 0 }, { rectThr: 0.97, minLong: 3000 }]);

const stranded = (o) => (o?.unplaced ?? []).reduce((a, u) => a + (Number(u.qty) || 0), 0);

/**
 * A cut-stock job: `input` is a shape job's input (rect, shape, seed) plus
 *   cutstock: { effort, totalMs?, custom?: { minLength, maxLength, minWidth, maxWidth, step, customPct, shortPct?, moqPieces?,
 *               moqTonnes?, density, thickness, removed: ['LxW'] }, engine?: { off, sizeOver, score }, grid?, variants? }
 * → a packJob-shaped answer ({ packer: 'shape', chosen: 'shape', shape: { nests }, nests, unplaced, score, sizeOver, areaBought })
 *   with `newSheets` (custom sizes it bought) and `cutstock` (what it did), or { none: why }.
 */
export async function runCutStockJob(input, hooks = {}) {
  const t0 = Date.now();
  const cs = input.cutstock ?? {};
  const E = { ...(CUTSTOCK_EFFORT[cs.effort] ?? CUTSTOCK_EFFORT.standard), ...(cs.params ?? {}) };
  const total = Math.max(1000, Math.min(Number(cs.totalMs ?? E.totalMs) || E.totalMs, input.budgetMs != null ? Number(input.budgetMs) : Infinity));
  const deadline = Math.min(t0 + total, input.deadlineAt ?? Infinity);
  const stopNow = () => { try { return typeof hooks.shouldStop === 'function' && !!hooks.shouldStop(); } catch { return false; } };
  const S = input.shape; const R = S.costRules ?? null;
  const kerf = Number(S.kerf) || 0; const margin = Number(S.margin) || 0; const gap = Math.max(Number(S.gap) || 0, kerf);
  const info = { variants: [], ms: 0 };
  const none = (why) => ({ none: why, cutstock: { ...info, ms: Date.now() - t0, why } });
  if (gap > kerf + 1e-9) return none('the shop gap between parts is more than a kerf');
  const rot = S.rotations;
  const rotOk = (r) => (Array.isArray(rot) ? rot.includes(r) : rot?.stepDeg > 0 ? r % rot.stepDeg === 0 : true);
  if (!rotOk(0)) return none('no plain turn allowed');
  const bought = (S.sheets ?? []).filter((s) => !s.preferred && !s.fixed);
  if (!bought.length) return none('no sheet to buy');
  const platePen = Number(R?.platePenalty) || 0;
  // The solver works in units of U mm² (a 12 m × 2.5 m plate is 3000): mm² costs (3e7) made its tolerances meaningless.
  const U = 1e4;
  const std = bought.map((s) => ({ key: String(s.key), L: Number(s.length), W: Number(s.width), cost: ((Number(s.areaCost ?? s.length * s.width) || 0) + (Number(s.penalty) || 0) + platePen) / U, available: Number(s.available) > 0 ? Number(s.available) : Infinity, areaCost: Number(s.areaCost ?? s.length * s.width), penalty: Number(s.penalty) || 0 }));
  const longest = Math.max(...std.map((z) => Math.max(z.L, z.W)));
  let custom = null;
  if (cs.custom) {
    const c = cs.custom;
    const pct = Number(c.customPct ?? 0.10); const shortPct = Number(c.shortPct ?? 0.03); const shortRatio = Number(c.shortRatio ?? 0.5);
    const dens = Number(c.density) > 0 ? Number(c.density) : 7850; const t = Number(c.thickness) || 0;
    const longAll = Math.max(longest, Number(c.maxLength) || 0);
    custom = {
      minL: Number(c.minLength), maxL: Number(c.maxLength), minW: Number(c.minWidth), maxW: Number(c.maxWidth), step: Number(c.step) || 50,
      removed: new Set(c.removed ?? []),
      costOf: (L, W) => (L * W * (1 + pct + (Math.max(L, W) < shortRatio * longAll - 1e-6 ? shortPct : 0)) + platePen) / U,
      areaParts: (L, W) => ({ areaCost: L * W, penalty: L * W * (pct + (Math.max(L, W) < shortRatio * longAll - 1e-6 ? shortPct : 0)) }),
      moqOf: (L, W) => {
        const byP = Number(c.moqPieces) > 0 ? Number(c.moqPieces) : Infinity;
        const byT = Number(c.moqTonnes) > 0 && t > 0 ? Math.ceil((Number(c.moqTonnes) * 1000) / ((L * W * t * dens) / 1e9) - 1e-9) : Infinity;
        const m = Math.min(byP, byT); return Number.isFinite(m) ? Math.max(1, m) : 1;
      },
    };
    if (!(custom.maxL > 0 && custom.maxW > 0 && custom.minL > 0 && custom.minW > 0)) custom = null;
  }
  const maxSizes = R?.maxSizes ?? null; const sizePenalty = (Number(R?.sizePenalty) || 0) / U;
  const pieces = (S.pieces ?? []).filter((p) => (Number(p.qty) || 0) > 0);
  const demandAll = new Map(pieces.map((p) => [String(p.key), Number(p.qty) || 0]));
  const engine = cs.engine ?? null;                   // the packers' answer to beat: { off, sizeOver, score }
  const maxLen = Math.max(...std.map((z) => z.L), custom?.maxL ?? 0) - 2 * margin;

  // every sheet the answer may name: the job's own, and the custom sizes it buys
  const sheetMap = new Map((S.sheets ?? []).map((s) => [String(s.key), s]));
  const customSheet = (L, W) => {
    const key = `cs${L}x${W}`;
    if (!sheetMap.has(key)) { const a = custom.areaParts(L, W); sheetMap.set(key, { key, length: L, width: W, available: 1000, preferred: false, areaCost: a.areaCost, penalty: a.penalty, custom: true }); }
    return sheetMap.get(key);
  };

  let best = null;
  const variants = cs.variants ?? variantsFor(!!custom);
  for (const V of variants) {
    if (stopNow() || Date.now() > deadline - 2000) break;
    const tv = Date.now();
    const rec = { ...V };
    info.variants.push(rec);
    try {
      const { items, itemKeys, rest } = buildItems(pieces, { rectThr: V.rectThr, pairThr: 0.9, minLong: V.minLong, kerf, rotOk, maxLen, deadline });
      rec.items = items.length; rec.rest = rest.length;
      if (!itemKeys.size) { rec.result = 'no lane parts'; continue; }
      const demand = new Map([...demandAll].filter(([k]) => itemKeys.has(k)));
      // THE BOUND: the lane parts' LP (Farley while iterating) is a lower bound on any answer of this variant (the rest
      // may land in the lanes' free space, so it adds nothing for sure). At or above the packers' score: no point going on.
      const beat = engine && engine.off === 0 && Number.isFinite(engine.score) ? engine.score : null;
      const stopBelow = beat != null ? beat / U : null;
      const mk = (S2) => makeContext({ kerf, margin, grid: Number(cs.grid) || 5, items, demand, std, custom, customList: S2, maxSizes, sizePenalty });
      const ans = await integerAnswer(mk, { ...E, seed: Number(input.seed) || 1, rcTol: 0.2 }, deadline, stopBelow);
      rec.laneLowerBound = ans?.lb != null ? Math.round(ans.lb * U) : null;
      if (!ans || ans.pruned) { rec.result = ans?.pruned ? 'bound: cannot beat the packers' : 'no integer answer'; continue; }
      const ctx = ans.ctx;
      // the plates, surplus copies not cut (from the last plates first)
      let plates = ans.plates.map((p) => {
        const z = p.size;
        const sheet = z.custom ? customSheet(z.L, z.W) : sheetMap.get(z.key);
        const placements = [];
        for (const pc of p.col.pieces) {
          const it = ctx.its[pc.item];
          for (const r of it.rel) placements.push({ key: r.key, rot: r.rot, x: pc.x + r.ox, y: pc.y + r.oy });
        }
        return { sheet, custom: !!z.custom, placements };
      });
      const have = new Map(); for (const p of plates) for (const q of p.placements) have.set(q.key, (have.get(q.key) ?? 0) + 1);
      for (const [k, n] of have) {
        let surplus = n - (demand.get(k) ?? 0);
        for (let i = plates.length - 1; i >= 0 && surplus > 0; i--) {
          const pl = plates[i];
          for (let j = pl.placements.length - 1; j >= 0 && surplus > 0; j--) if (pl.placements[j].key === k) { pl.placements.splice(j, 1); surplus--; }
        }
      }
      plates = plates.filter((p) => p.placements.length);
      // the real outlines on the plate (the packers' own placement rule)
      const ringsOf = new Map(pieces.map((p) => [String(p.key), p.rings ?? { outline: outlineOf(p), cutouts: [], holes: [] }]));
      const place = (q) => placeRings(ringsOf.get(q.key), { x: q.x, y: q.y, rotationDeg: q.rot });
      for (const p of plates) p.placed = p.placements.map((q) => ({ ...q, rings: place(q) }));
      // the rest: the engine's own shape job, the free space of these plates first, then new plates
      const used = () => new Set(plates.map((p) => p.sheet.key));
      if (rest.length) {
        if (Date.now() > deadline - 1000) throw new OutOfTime();
        const restSet = new Set(rest);
        const sizesNow = used();
        const customNow = [...sizesNow].map((k) => sheetMap.get(k)).filter((s) => s?.custom);
        const pool = maxSizes && sizesNow.size >= maxSizes ? [...sizesNow].map((k) => sheetMap.get(k)) : [...bought, ...customNow];
        const newSheets = pool.map((s) => ({ key: String(s.key), length: s.length, width: s.width, available: Math.max(1, Number(s.available) || 1000), preferred: false, areaCost: Number(s.areaCost ?? s.length * s.width), penalty: Number(s.penalty) || 0 }));
        const fillSheets = plates.map((p, i) => ({ key: `F${i}`, length: p.sheet.length, width: p.sheet.width, available: 1, preferred: true, areaCost: 0,
          fixed: p.placed.map((q, j) => ({ key: `f${i}_${j}`, placed: true, rings: q.rings })) }));
        const budget = Math.max(1000, Math.min(E.restMs, deadline - Date.now() - 500));
        const r = runPackJob({
          packer: 'shape', seed: input.seed, plateMix: false, budgetMs: budget, deadlineAt: Date.now() + budget,
          rect: { ...input.rect, pieces: (input.rect.pieces ?? []).filter((p) => restSet.has(String(p.key))), sheets: newSheets.map(({ penalty, ...s }) => s) },
          shape: { ...S, pieces: pieces.filter((p) => restSet.has(String(p.key))), sheets: newSheets },
          fillSheets, ...(input.shapesDecide ? { shapesDecide: true } : {}),
        }, { shouldStop: stopNow });
        if (stranded(r) > 0) { rec.result = `rest: ${stranded(r)} pieces left off`; continue; }
        for (const n of r.fill?.nests ?? []) {
          const i = Number(String(n.sheetKey).slice(1));
          for (const q of n.placements ?? []) plates[i].placed.push({ key: String(q.key), rot: q.rotationDeg ?? 0, mirrored: !!q.mirrored, x: q.x, y: q.y, rings: q.rings });
        }
        const win = r.chosen === 'shape' ? r.shape : r.rect;
        for (const n of win?.nests ?? []) {
          const sheet = sheetMap.get(String(n.sheetKey));
          const placed = n.placements
            ? n.placements.map((q) => ({ key: String(q.key), rot: q.rotationDeg ?? 0, mirrored: !!q.mirrored, x: q.x, y: q.y, rings: q.rings }))
            : (n.pieces ?? []).map((q) => { const rr = q.rotated ? 90 : 0; const g = { key: String(q.key), rot: rr, x: Number(q.x), y: Number(q.y) }; return { ...g, mirrored: false, rings: place(g) }; });
          plates.push({ sheet, custom: !!sheet?.custom, placed, fromRest: true });
        }
        rec.restPlates = (win?.nests ?? []).length;
      }
      // the lot: every custom size bought at least its minimum
      const per = new Map(); for (const p of plates) if (p.custom) per.set(p.sheet.key, (per.get(p.sheet.key) ?? 0) + 1);
      const short = [...per].filter(([k, n]) => { const s = sheetMap.get(k); return n < custom.moqOf(s.length, s.width); });
      if (short.length) { rec.result = `lot short: ${short.map(([k, n]) => `${k} ${n}`).join(', ')}`; continue; }
      // standard plates down to the cheapest offered size that holds their layout (keeping the size limit)
      const ext = (p) => { let x1 = 0; let y1 = 0; for (const q of p.placed) { const b = bbox(q.rings.outline ?? q.rings[0]); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); } return { x1, y1 }; };
      const sizesOf = () => new Set(plates.map((p) => p.sheet.key)).size;
      const byCost = std.slice().sort((a, b) => a.cost - b.cost);
      for (const p of plates) {
        if (p.custom) continue;
        const e = ext(p); const cur = std.find((z) => z.key === p.sheet.key);
        const before = sizesOf();
        for (const z of byCost) {
          if (z.cost >= cur.cost - 1e-6) break;
          if (e.x1 + margin > z.L + 1e-6 || e.y1 + margin > z.W + 1e-6) continue;
          const old = p.sheet; p.sheet = sheetMap.get(z.key);
          if (!maxSizes || sizesOf() <= Math.max(maxSizes, before)) break;
          p.sheet = old;
        }
      }
      // availability of each offered sheet
      const cnt = new Map(); for (const p of plates) cnt.set(p.sheet.key, (cnt.get(p.sheet.key) ?? 0) + 1);
      if ([...cnt].some(([k, n]) => n > (Number(sheetMap.get(k)?.available) || Infinity))) { rec.result = 'more plates than available'; continue; }
      // every piece exactly once
      const placedN = new Map(); for (const p of plates) for (const q of p.placed) placedN.set(q.key, (placedN.get(q.key) ?? 0) + 1);
      if ([...demandAll].some(([k, n]) => (placedN.get(k) ?? 0) !== n)) { rec.result = 'pieces do not add up'; continue; }
      const nests = plates.map((p) => ({ sheetKey: String(p.sheet.key), sheetLength: p.sheet.length, sheetWidth: p.sheet.width,
        placements: p.placed.map((q) => { const b = bbox(q.rings.outline ?? q.rings[0]); return { key: q.key, x: q.x, y: q.y, rotationDeg: q.rot ?? 0, mirrored: !!q.mirrored, rings: q.rings, bbox: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 } }; }) }));
      const ls = layoutScore(nests.map((n) => { let maxX = 0; let maxY = 0; for (const q of n.placements) { maxX = Math.max(maxX, q.bbox.x1); maxY = Math.max(maxY, q.bbox.y1); } return { sheetKey: n.sheetKey, extent: { maxX, maxY } }; }), sheetMap, R, { margin, gap });
      const areaBought = nests.reduce((a, n) => a + (Number(sheetMap.get(n.sheetKey)?.areaCost) || 0), 0);
      const cand = { nests, score: R ? ls.score : ls.cost, sizeOver: ls.sizeOver, areaBought, variant: V };
      rec.result = 'ok'; rec.score = Math.round(cand.score); rec.plates = nests.length; rec.sizeOver = ls.sizeOver;
      if (!best || cand.sizeOver < best.sizeOver || (cand.sizeOver === best.sizeOver && cand.score < best.score - 1e-6)) best = cand;
    } catch (e) {
      rec.result = e?.outOfTime ? 'out of time' : `failed: ${e?.message ?? e}`;
      if (e?.outOfTime) break;
    } finally { rec.ms = Date.now() - tv; }
  }
  info.ms = Date.now() - t0;
  if (!best) return none('no complete answer');
  const used = new Set(best.nests.map((n) => n.sheetKey));
  const newSheets = [...used].map((k) => sheetMap.get(k)).filter((s) => s?.custom).map((s) => ({ key: s.key, length: s.length, width: s.width, areaCost: s.areaCost, penalty: s.penalty }));
  const shape = { nests: best.nests, unplaced: [], source: 'cutstock', deterministic: Date.now() < deadline, totals: { sheets: best.nests.length, areaBought: best.areaBought } };
  return {
    packer: 'shape', chosen: 'shape', rect: null, shape, fill: null, shapeError: null,
    nests: best.nests, unplaced: [], areaBought: best.areaBought, score: best.score, sizeOver: best.sizeOver,
    deterministic: shape.deterministic, shapesDecide: !!input.shapesDecide, rowsBecause: null, coarse: 0, stopped: stopNow(),
    floorMs: 0, proven: false, elapsedMs: Date.now() - t0, sizeAdvice: [],
    newSheets, cutstock: { ...info, variant: best.variant },
  };
}
