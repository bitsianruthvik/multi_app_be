/**
 * nestPairs.js — CF_ERP. PAIRING IRREGULAR SHAPES (2026-11-11; nest benchmark TM/nest_bench/pairs: SO260018 r104, 32 mm
 * 62 → 54 plates, the order −12 to −15 t).
 *
 * Two (or three) irregular parts of a steel — a gusset whose outline fills less than `irregularFill` of its box — often
 * fit far tighter together than apart: the partner turned a quarter turn or two and slid into the first one's notch.
 * Such a CLUSTER is handed to the packers as ONE composite piece (an outline holding its members, a kerf and a hair
 * between them), and every placed composite is EXPLODED back to its real parts afterwards with the exact transform —
 * nothing downstream ever sees a composite.
 *
 * A pairs job (`input.packer === 'pairs'`) is the steel's shape job run with the clusters in place of their members;
 * nestingService runs it beside the steel's seeds and the pool keeps whichever is cheaper (packerPool.pickBest), so a
 * cluster that does not pay simply loses. With no cluster worth having it is an ordinary extra seed.
 *
 * THE SEARCH, MADE FAST (the bench version took 53 min on Thane 32 mm):
 *   - a pair is tried only when its box could gain `minGain` at all: (area A + area B) < (1 − minGain)(box A + box B);
 *   - the most promising pairs first, and a time budget: what is found by then is used;
 *   - the slide is a profile scan: per band of the partner's height, the first part's right edge (widened by a kerf) and
 *     the partner's left edge, each built in ONE pass over the edges; a coarse 20 mm band first, then 5 mm round the
 *     best, then an exact push (binary search on the true boundary distance);
 *   - third members only on the best pairs.
 * The clusters found are handed back (`pairs.clusters`) so nestingService can keep them by the parts' outlines and hand
 * them to the next run of the same pieces (no search at all).
 */
import { placeRings } from './shapePacker.js';
import { runPackJob } from './packJob.js';
import { offsetPolygon, booleanRegions, orientRing, cleanRing, transformRing } from '../lib/polyGeom.js';
import { bbox, boxOfRings, area, shift, setDist, pointIn, ringDist, dropSpikes, outlineOf } from './nestRingMath.js';

export const NO_PAIRS = 'no pairs worth making';
const PAIRS_NFP_MAX = 50_000;
const CLEAR_EXTRA = 0.05;            // members kept a kerf + this apart
const COARSE = 20; const FINE = 5;   // band heights, mm

const turned = (ring, rot) => placeRings({ outline: ring, cutouts: [], holes: [] }, { x: 0, y: 0, rotationDeg: rot }).outline;
const memberRing = (parts, m) => shift(parts.get(m.key).turns[m.rot], m.x, m.y);

/** min (lo) and max (hi) x of the rings' boundary in each band [y0 + jH, y0 + (j+1)H], j = 0..n-1 — one pass over the edges. */
function profile(rings, y0, H, n) {
  const lo = new Float64Array(n).fill(Infinity); const hi = new Float64Array(n).fill(-Infinity);
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [x1, y1] = r[j]; const [x2, y2] = r[i];
      const ymin = Math.min(y1, y2); const ymax = Math.max(y1, y2);
      let ja = Math.floor((ymin - y0) / H - 1e-9); let jb = Math.floor((ymax - y0) / H + 1e-9);
      if (jb < 0 || ja > n - 1) continue;
      ja = Math.max(0, ja); jb = Math.min(n - 1, jb);
      for (let b = ja; b <= jb; b++) {
        let xa; let xb;
        if (Math.abs(y2 - y1) < 1e-12) { xa = x1; xb = x2; } else {
          const ya = Math.max(y0 + b * H, ymin); const yb = Math.min(y0 + (b + 1) * H, ymax);
          if (ya > yb + 1e-9) continue;
          xa = x1 + ((ya - y1) / (y2 - y1)) * (x2 - x1); xb = x1 + ((yb - y1) / (y2 - y1)) * (x2 - x1);
        }
        const mn = Math.min(xa, xb); const mx = Math.max(xa, xb);
        if (mn < lo[b]) lo[b] = mn; if (mx > hi[b]) hi[b] = mx;
      }
    }
  }
  return { lo, hi };
}

/** The partner (ring P, box at the origin) against the fixed rings A, coming from +x: for each band offset m the
 *  least dx keeping a kerf (conservative). → [{ m, dx, y, boxArea }] */
function scan(A, bA, P, pw, ph, kerf, H, mFrom, mTo) {
  const nP = Math.ceil(ph / H - 1e-9); const nA = Math.ceil((bA.y1 - bA.y0) / H - 1e-9);
  const pLo = profile([P], 0, H, nP).lo;
  const ext = nA + 2 * nP + 2; const y0 = bA.y0 - nP * H;
  const hiA = profile(A, y0, H, ext).hi;
  const r = Math.max(1, Math.ceil(kerf / H - 1e-9));
  const hiW = new Float64Array(ext).fill(-Infinity);
  for (let j = 0; j < ext; j++) { let m = -Infinity; for (let d = -r; d <= r; d++) { const v = hiA[j + d]; if (v !== undefined && v > m) m = v; } hiW[j] = m === -Infinity ? m : m + kerf; }
  const out = [];
  for (let m = Math.max(mFrom, -nP + 1); m <= Math.min(mTo, nA - 1); m++) {
    let dx = -Infinity;
    for (let j = 0; j < nP; j++) { const a = hiW[m + j + nP]; if (a === -Infinity || pLo[j] === Infinity) continue; const need = a - pLo[j]; if (need > dx) dx = need; }
    if (dx === -Infinity) continue;
    const y = bA.y0 + m * H;
    const bx0 = Math.min(bA.x0, dx); const bx1 = Math.max(bA.x1, dx + pw); const by0 = Math.min(bA.y0, y); const by1 = Math.max(bA.y1, y + ph);
    out.push({ m, dx, y, boxArea: (bx1 - bx0) * (by1 - by0), w: bx1 - bx0, h: by1 - by0 });
  }
  return out;
}

/** Push the partner as close as the true boundary distance allows (≥ kerf + CLEAR_EXTRA), trying y ±1, ±2 mm. */
function refine(A, P, c, kerf) {
  const need = kerf + CLEAR_EXTRA;
  const ok = (dx, dy) => setDist(A, [shift(P, dx, dy)], need + 1) >= need;
  let best = null;
  for (const ddy of [0, -2, 2, -1, 1]) {
    const dy = c.y + ddy;
    let hi = c.dx + (ddy ? 2 * FINE + kerf : 0);
    let tries = 0; while (!ok(hi, dy) && tries < 6) { hi += 2 * FINE; tries++; }
    if (!ok(hi, dy)) continue;
    let lo = hi - 3 * FINE - 2 * kerf;
    if (ok(lo, dy)) {
      let step = FINE; while (ok(lo - step, dy) && step < 1e5) { lo -= step; step *= 2; }
      hi = lo; lo = hi - step;
      if (ok(lo, dy)) continue;
    }
    for (let it = 0; it < 16 && hi - lo > 0.02; it++) { const mid = (lo + hi) / 2; if (ok(mid, dy)) hi = mid; else lo = mid; }
    const dx = Math.ceil(hi * 100) / 100;
    if (!ok(dx, dy)) continue;
    const b = boxOfRings([...A, shift(P, dx, dy)]);
    const ba = (b.x1 - b.x0) * (b.y1 - b.y0);
    if (!best || ba < best.boxArea) best = { dx, dy, boxArea: ba };
  }
  return best;
}

/** The cluster's members turned by phi (as a whole) and set back to the origin. */
function turnCluster(parts, members, phi) {
  if (!phi) return members.map((m) => ({ ...m }));
  const rings = members.map((m) => transformRing(memberRing(parts, m), { rotationDeg: phi }));
  const b = boxOfRings(rings);
  return members.map((m, i) => { const rb = bbox(rings[i]); return { key: m.key, rot: (m.rot + phi) % 360, x: rb.x0 - b.x0, y: rb.y0 - b.y0 }; });
}

/** Best cluster of `members` plus one more part (partKey). → { members, boxArea } or null */
function bestAdd(parts, members, partKey, kerf, fit, refineN = 2) {
  const P = parts.get(partKey);
  const cands = [];
  for (const phi of [0, 90, 180, 270]) {
    const mem = turnCluster(parts, members, phi);
    const A = mem.map((m) => memberRing(parts, m)); const bA = boxOfRings(A);
    for (const rot of [0, 90, 180, 270]) {
      const Pr = P.turns[rot]; const pb = bbox(Pr); const pw = pb.x1; const ph = pb.y1;
      const coarse = scan(A, bA, Pr, pw, ph, kerf, COARSE, -Infinity, Infinity).filter((c) => fits(c.w, c.h, fit)).sort((a, b) => a.boxArea - b.boxArea).slice(0, 3);
      for (const c of coarse) {
        // fine: 5 mm bands round the coarse offset
        const yC = c.y; const m0 = Math.floor((yC - bA.y0) / FINE);
        const fine = scan(A, bA, Pr, pw, ph, kerf, FINE, m0 - 4, m0 + 4).filter((f) => fits(f.w, f.h, fit)).sort((a, b) => a.boxArea - b.boxArea)[0] ?? c;
        cands.push({ phi, rot, mem, A, c: fine });
      }
    }
  }
  cands.sort((a, b) => a.c.boxArea - b.c.boxArea);
  let best = null; const seen = new Set(); let n = 0;
  for (const k of cands) {
    if (n >= refineN) break;
    const sig = `${Math.round(k.c.boxArea / 2e4)}`; if (seen.has(sig)) continue; seen.add(sig); n += 1;
    const r = refine(k.A, P.turns[k.rot], k.c, kerf);
    if (!r) continue;
    const rb = boxOfRings([...k.A, shift(P.turns[k.rot], r.dx, r.dy)]);
    if (!fits(rb.x1 - rb.x0, rb.y1 - rb.y0, fit)) continue;
    if (!best || r.boxArea < best.boxArea) best = { members: [...k.mem, { key: partKey, rot: k.rot, x: r.dx, y: r.dy }], boxArea: r.boxArea };
  }
  if (!best) return null;
  const b = boxOfRings(best.members.map((m) => memberRing(parts, m)));
  best.members = best.members.map((m) => ({ ...m, x: m.x - b.x0, y: m.y - b.y0 }));
  return best;
}
const fits = (w, h, fit) => Math.min(w, h) <= fit.short && Math.max(w, h) <= fit.long;

/** One outline holding every member: closing by G, united again with the members themselves. */
export function clusterOutline(memberRings, G = 20) {
  const polys = memberRings.map((r) => ({ outline: orientRing(cleanRing(r), true), holes: [] }));
  const grown = polys.flatMap((p) => offsetPolygon(p, G));
  const uni = booleanRegions(grown, [], 'union');
  if (uni.length !== 1) return null;
  const shrunk = offsetPolygon({ outline: uni[0].outline, holes: [] }, -G);
  const all = booleanRegions([...shrunk.map((s) => ({ outline: s.outline, holes: [] })), ...polys], [], 'union');
  if (all.length !== 1) return null;
  const outline = all[0].outline.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
  for (const r of memberRings) for (const p of r) if (!pointIn(p, outline) && ringDist([p, p, p], outline) > 0.002) return null;
  return outline;
}

/**
 * The clusters of one steel's pieces. → { clusters: [{ key, members: [{ key, rot, x, y }], qty, outline }], complete, ms, tried }
 * members: in the cluster's frame, member ring = placeRings(its outline, { x, y, rotationDeg: rot }).
 */
export function findClusters(pieces, { kerf, fit, minGain = 0.08, irregularFill = 0.97, triples = true, budgetMs = 20_000, maxTriplePairs = 8 } = {}) {
  const t0 = Date.now(); const end = t0 + budgetMs;
  const parts = new Map();
  for (const p of pieces) {
    if (!p.rings || !(Number(p.qty) > 0)) continue;
    const own = outlineOf(p); const clean = dropSpikes(own);
    // turned as the part itself is placed (its own outline sets the box); the spikes go only out of the area
    const turns = {}; for (const r of [0, 90, 180, 270]) turns[r] = turned(own, r);
    const b = bbox(turns[0]); const box = (b.x1 - b.x0) * (b.y1 - b.y0); const a = area(clean);
    parts.set(String(p.key), { key: String(p.key), qty: Number(p.qty), clean, turns, box, area: a, fill: a / box });
  }
  const irr = [...parts.values()].filter((p) => p.fill < irregularFill).sort((a, b) => b.box - a.box);
  const todo = [];
  for (let i = 0; i < irr.length; i++) for (let j = i; j < irr.length; j++) {
    const A = irr[i]; const B = irr[j];
    if (A.key === B.key && A.qty < 2) continue;
    const upper = 1 - (A.area + B.area) / (A.box + B.box);     // the most box this pair could save
    if (upper < minGain) continue;
    todo.push({ A, B, upper: upper * (A.box + B.box) });
  }
  todo.sort((a, b) => b.upper - a.upper);
  const pairs = []; let tried = 0; let complete = true;
  for (const { A, B } of todo) {
    if (Date.now() > end) { complete = false; break; }
    tried += 1;
    const best = bestAdd(parts, [{ key: A.key, rot: 0, x: 0, y: 0 }], B.key, kerf, fit);
    if (!best) continue;
    const apart = A.box + B.box;
    pairs.push({ members: best.members, boxArea: best.boxArea, apartBoxArea: apart, gain: 1 - best.boxArea / apart });
  }
  const good = pairs.filter((p) => p.gain >= minGain).sort((a, b) => (b.apartBoxArea - b.boxArea) - (a.apartBoxArea - a.boxArea));
  if (triples) {
    for (const p of good.slice(0, maxTriplePairs)) {
      let bestT = null;
      for (const C of irr) {
        if (Date.now() > end) { complete = false; break; }
        const areas = p.members.reduce((a, m) => a + parts.get(m.key).area, 0) + C.area;
        if (1 - areas / (p.boxArea + C.box) < minGain) continue;
        const tb = bestAdd(parts, p.members, C.key, kerf, fit, 1);
        if (!tb) continue;
        const apartAll = p.apartBoxArea + C.box;
        if (1 - tb.boxArea / (p.boxArea + C.box) >= minGain && (!bestT || apartAll - tb.boxArea > bestT.apartBoxArea - bestT.boxArea)) bestT = { members: tb.members, boxArea: tb.boxArea, apartBoxArea: apartAll };
      }
      if (bestT) p.triple = bestT;
    }
  }
  const left = new Map([...parts.values()].map((p) => [p.key, p.qty]));
  const chosen = [];
  const take = (c) => {
    const need = new Map(); for (const m of c.members) need.set(m.key, (need.get(m.key) ?? 0) + 1);
    let n = Infinity; for (const [k, v] of need) n = Math.min(n, Math.floor(left.get(k) / v));
    if (!(n > 0)) return;
    for (const [k, v] of need) left.set(k, left.get(k) - n * v);
    chosen.push({ ...c, qty: n });
  };
  for (const p of good) { if (p.triple) take(p.triple); take(p); }
  const clusters = [];
  for (const c of chosen) {
    const rings = c.members.map((m) => memberRing(parts, m));
    let outline = null;
    for (const G of [20, 10, 40, 80]) { outline = clusterOutline(rings, G); if (outline) break; }
    if (!outline) { for (const m of c.members) left.set(m.key, left.get(m.key) + c.qty); continue; }
    // the cluster's frame: its outline's box at the origin
    const ob = bbox(outline);
    const members = c.members.map((m) => ({ key: m.key, rot: m.rot, x: m.x - ob.x0, y: m.y - ob.y0 }));
    let dmin = Infinity; for (let i = 0; i < rings.length; i++) for (let j = i + 1; j < rings.length; j++) dmin = Math.min(dmin, setDist([rings[i]], [rings[j]], kerf + 10));
    if (dmin < kerf + 0.01) { for (const m of c.members) left.set(m.key, left.get(m.key) + c.qty); continue; }
    clusters.push({ key: `pair${clusters.length + 1}`, members, qty: c.qty, outline: shift(outline, -ob.x0, -ob.y0), gain: +(1 - c.boxArea / c.apartBoxArea).toFixed(4) });
  }
  return { clusters, complete, tried, irregular: irr.length, ms: Date.now() - t0 };
}

/* ───────────────────────────── the job ───────────────────────────── */

const ringsObj = (p) => (p.rings && !Array.isArray(p.rings) ? p.rings : { outline: outlineOf(p), cutouts: [], holes: [] });

/**
 * Explode the placed composites of a layout back to their parts. nests: [{ sheetKey, placements: [{ key, x, y, rotationDeg }] }]
 * → { nests, failures } (failures = members whose own placement does not land where the composite put them).
 */
export function explodeNests(nests, clusterBy, ringsOf) {
  let failures = 0;
  const out = (nests ?? []).map((n) => {
    const placements = [];
    for (const q of n.placements ?? []) {
      const c = clusterBy.get(String(q.key));
      if (!c) { placements.push(q); continue; }
      const own = c.members.map((m) => placeRings({ outline: ringsOf.get(m.key).outline, cutouts: [], holes: [] }, { x: m.x, y: m.y, rotationDeg: m.rot }).outline);
      const put = placeRings({ outline: c.outline, cutouts: own, holes: [] }, { x: Number(q.x), y: Number(q.y), rotationDeg: q.rotationDeg ?? 0, mirrored: false });
      c.members.forEach((m, i) => {
        const ring = put.cutouts[i]; const b = bbox(ring);
        const rot = (((q.rotationDeg ?? 0) + m.rot) % 360 + 360) % 360;
        const rings = placeRings(ringsOf.get(m.key), { x: b.x0, y: b.y0, rotationDeg: rot });
        const chk = rings.outline;
        let dev = 0; for (let k = 0; k < chk.length; k++) dev = Math.max(dev, Math.abs(chk[k][0] - ring[k][0]), Math.abs(chk[k][1] - ring[k][1]));
        if (!(dev <= 0.01)) failures += 1;
        const rb = bbox(rings.outline);
        placements.push({ key: m.key, x: b.x0, y: b.y0, rotationDeg: rot, mirrored: false, rings, bbox: { x0: rb.x0, y0: rb.y0, x1: rb.x1, y1: rb.y1 }, fromCluster: c.key });
      });
    }
    return { ...n, placements, metrics: null };
  });
  return { nests: out, failures };
}

/**
 * A pairs job: a shape job's input plus `pairs: { clusters?: (from an earlier run), searchMs, minGain, triples }`.
 * → the shape job's answer on the real parts, with `pairs: { clusters, used, found, complete, searchMs, explodeFailures }`.
 */
export function runPairJob(input, hooks = {}) {
  const t0 = Date.now();
  const P = input.pairs ?? {};
  const S = input.shape;
  const kerf = Number(S.kerf) || 0; const margin = Number(S.margin) || 0;
  const plain = { ...input, packer: 'shape' }; delete plain.pairs;
  // Without clusters it is an ordinary shape job: its hooks as they are (checkpoints included).
  const rot = S.rotations;
  const quarter = Array.isArray(rot) && [0, 90, 180, 270].every((r) => rot.includes(r));
  const bought = (S.sheets ?? []).filter((s) => !s.preferred);
  if (!quarter || !bought.length || input.fillSheets?.length) return { ...runPackJob(plain, hooks), pairs: { used: 0, why: 'not paired' } };
  const longest = Math.max(...bought.map((s) => Math.max(s.length, s.width))); const widest = Math.max(...bought.map((s) => Math.min(s.length, s.width)));
  const fit = { long: longest - 2 * margin - 2 * kerf, short: widest - 2 * margin - 2 * kerf };
  let found = P.clusters ? { clusters: P.clusters, complete: true, cached: true, ms: 0 } : null;
  if (!found) {
    const share = input.budgetMs != null ? Math.max(1000, Math.floor(Number(input.budgetMs) * 0.3)) : 20_000;
    found = findClusters(S.pieces ?? [], { kerf, fit, minGain: P.minGain ?? 0.08, triples: P.triples !== false, budgetMs: Math.min(P.searchMs ?? 60_000, share) });
  }
  const clusters = (found.clusters ?? []).filter((c) => c.qty > 0);
  const tell = { clusters: found.clusters, found: clusters.length, complete: found.complete !== false, cached: !!found.cached, searchMs: found.ms ?? Date.now() - t0 };
  // No cluster worth having: the job would be the steel's own first seed again (same seed, same pieces) — it is not
  // run (memory and a worker's time); the pool's ranking simply has nothing from it. Its search is still remembered.
  if (!clusters.length) throw new Error(tell.complete ? NO_PAIRS : `${NO_PAIRS} (search cut short)`);
  // the pieces with the clusters in place of their members
  const take = new Map(); for (const c of clusters) for (const m of c.members) take.set(m.key, (take.get(m.key) ?? 0) + c.qty);
  const byKey = new Map((S.pieces ?? []).map((p) => [String(p.key), p]));
  for (const [k, n] of take) if (!byKey.has(k) || (Number(byKey.get(k).qty) || 0) < n) return { ...runPackJob(plain, hooks), pairs: { ...tell, used: 0, why: 'stale clusters' } };
  const less = (p) => ({ ...p, qty: (Number(p.qty) || 0) - (take.get(String(p.key)) ?? 0) });
  const comp = clusters.map((c) => { const b = bbox(c.outline); return { key: c.key, qty: c.qty, length: b.x1 - b.x0, width: b.y1 - b.y0, rings: { outline: c.outline, cutouts: [], holes: [] } }; });
  const elapsed = Date.now() - t0;
  const job = {
    ...plain,
    ...(input.budgetMs != null ? { budgetMs: Math.max(500, Number(input.budgetMs) - elapsed) } : {}),
    rect: { ...input.rect, pieces: [...(input.rect.pieces ?? []).map(less).filter((p) => p.qty > 0), ...comp.map((c) => ({ key: c.key, length: c.length, width: c.width, qty: c.qty, grain: 'any' }))] },
    // a smaller no-fit-polygon cache than a seed's (composites have long outlines; memory, measured on SO260018)
    shape: { ...S, nfpMax: S.nfpMax ?? PAIRS_NFP_MAX, pieces: [...(S.pieces ?? []).map(less).filter((p) => p.qty > 0), ...comp.map((c) => ({ ...c, grain: 'any', allowMirror: false }))] },
  };
  const clusterBy = new Map(clusters.map((c) => [c.key, c]));
  const ringsOf = new Map([...byKey].map(([k, p]) => [k, ringsObj(p)]));
  for (const c of comp) ringsOf.set(c.key, c.rings);
  /*
   * CHECKPOINTS ON THE REAL PARTS (2026-11-11, nest_resume_test): the run's best-so-far figure takes this job's progress,
   * so its layouts must be checkpointed too — or the figure a run is picked up with is one no checkpoint holds. A
   * checkpoint is exploded like the answer (composites back to their parts); one that cannot be (rows standing,
   * pieces left off, a part that does not land) is not passed on.
   */
  const ckHook = typeof hooks.onCheckpoint === 'function' ? (c) => {
    if (!c?.start || (Number(c.unplaced) || 0) > 0 || c.fill) return;
    const ex = explodeNests(c.start, clusterBy, ringsOf);
    if (ex.failures) return;
    hooks.onCheckpoint({ ...c, start: ex.nests.map((n) => ({ sheetKey: n.sheetKey, placements: n.placements.map((q) => ({ key: q.key, x: q.x, y: q.y, rotationDeg: q.rotationDeg ?? 0, mirrored: !!q.mirrored })) })) });
  } : undefined;
  const res = runPackJob(job, { shouldStop: hooks.shouldStop, onProgress: hooks.onProgress, ...(ckHook ? { onCheckpoint: ckHook } : {}) });
  // a row layout becomes a free one (a composite has no row form downstream)
  const win = res.chosen === 'shape' ? res.shape : res.rect;
  const asFree = (win?.nests ?? []).map((n) => (n.placements ? n : { sheetKey: n.sheetKey, sheetLength: n.sheetLength, sheetWidth: n.sheetWidth,
    placements: (n.pieces ?? []).map((q) => { const r = q.rotated ? 90 : 0; const rings = placeRings(ringsOf.get(String(q.key)), { x: Number(q.x), y: Number(q.y), rotationDeg: r }); const b = bbox(rings.outline); return { key: String(q.key), x: Number(q.x), y: Number(q.y), rotationDeg: r, mirrored: false, rings, bbox: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 } }; }) }));
  const ex = explodeNests(asFree, clusterBy, ringsOf);
  if (ex.failures) throw new Error(`pairs: ${ex.failures} parts could not be put back from their clusters`);
  const unplaced = new Map();
  for (const u of win?.unplaced ?? []) {
    const c = clusterBy.get(String(u.key));
    if (!c) { unplaced.set(String(u.key), { ...u, key: String(u.key), qty: (unplaced.get(String(u.key))?.qty ?? 0) + (Number(u.qty) || 0) }); continue; }
    for (const m of c.members) unplaced.set(m.key, { key: m.key, qty: (unplaced.get(m.key)?.qty ?? 0) + (Number(u.qty) || 0), reason: u.reason ?? 'The packer could not place it.' });
  }
  const un = [...unplaced.values()];
  const used = asFree.reduce((a, n) => a + n.placements.filter((q) => clusterBy.has(String(q.key))).length, 0);
  // the answer without the placed outlines: the plan places each part again from x, y and its turn, and a layout's rings
  // are most of what crosses from the worker (main-thread memory, measured on SO260018)
  ex.nests = ex.nests.map((n) => ({ ...n, placements: n.placements.map(({ rings, ...q }) => q) }));
  const shape = { nests: ex.nests, unplaced: un, source: 'pairs', deterministic: win?.deterministic !== false, totals: { sheets: ex.nests.length, areaBought: Number(res.areaBought) || 0 } };
  // the row layout (composite keys) only as the figures the plan reports; its placements would only cost memory
  const rect = res.rect ? { nests: (res.rect.nests ?? []).map((n) => ({ sheetKey: n.sheetKey })), unplaced: [], areaBought: res.rect.areaBought, deterministic: res.rect.deterministic } : null;
  return { ...res, rect, chosen: 'shape', shape, nests: ex.nests, unplaced: un, rowsBecause: null, pairs: { ...tell, used, explodeFailures: 0 } };
}
