/**
 * aiCutPlan.js — CF_ERP. How a nested plate is CUT, the way the shop cuts (2026-10-18, learned from
 * its ProNest job files: TM/nest_learning/LEARNINGS.md). The screen's word for this is "AI".
 *
 *   planCuts({ plate, pieces, rules, options })  → the cut plan of ONE plate, as data
 *   checkCutPlan(plan)                           → { ok, problems } — the hard rules, checked on a plan
 *   aiRulesOf(settings)                          → the rules a plan is made with, from the cut settings
 *
 * PURE GEOMETRY: no database. The layout is an input (whichever packer laid it, or the customer's file);
 * nothing here moves a part. We do NOT write CNC code: leads, pierce points, kerf side and cut order are
 * DATA, which the DXF writer (aiNestDxf.js) can draw on a layer of their own.
 *
 * WHAT A PLAN SAYS
 *   partInPart   a small part nested inside the opening (cut-out) of a big one: { inner, host, opening }.
 *                ALWAYS cut before the opening (user, 2026-10-18) — once the opening is cut the inner
 *                part's steel drops with the slug.
 *   groups       shared-line (common-line) blocks: parts whose facing straight edges are EQUAL and exactly
 *                one kerf apart. The first part of a block is cut as a full outline; every further part
 *                adds one open stroke for its edges not yet cut (the shop: one pierce per part).
 *   steps        the cut order, one entry per pierce: { n, kind: 'mark' | 'hole' | 'outline' | 'stroke',
 *                part, unit, path, closed, direction, kerfSide, pierce, leadIn, leadOut, text? }.
 *                Outlines run clockwise with the kerf OUTSIDE, holes counter-clockwise with the kerf
 *                INSIDE (left compensation on both). Marking (the part CODE, single-stroke text) has no leads.
 *   spacing      what the layout's spacing is next to the shop's (edge margin, part gap, gap between
 *                blocks) — findings, not refusals: the layout is the packer's, judged by its own rules.
 *
 * LEADS (the shop's settings, the same at every thickness)
 *   outline      start at a part CORNER (the one nearest the plate start, x = 0, top first); lead-in
 *                straight `leadInMm` (6) in line with the first edge — so the pierce is in the scrap, 6 mm
 *                off the part; lead-out straight `leadOutMm` (2) in line with the last edge; no overcut.
 *                A corner whose straight lead would pierce another part tries 90° and 135°, then the next
 *                corner, then an arc on the longest side.
 *   hole         arc lead-in of radius `holeLeadRadiusMm` (6), 90°, from inside the hole (shrunk to fit a
 *                small hole); lead-out straight `holeLeadOutMm` (2) into the hole.
 *   stroke       common-line: `sharedLeadInMm` (6.35) in, `sharedLeadOutMm` (1.27) out — in line, else at
 *                90° / 135° away from the part.
 *
 * CUT ORDER — OUR RULES FIRST, the shop's habits where they do not conflict
 *   hard   1. per part: marking, then holes, then the outline (once the outline is cut the part is loose);
 *          2. a part in an opening is cut before that opening (and so before its host);
 *          3. a ROW layout (sequences, our nestingPacker): sequence 1 whole, then 2, … — and inside a
 *             sequence row by row, along the row. A shared-line block never spans two rows here;
 *          4. a block is cut in one go.
 *   shop   a FREE layout (no sequences): block by block from the plate's start end (x = 0) to the far
 *          end; inside a block strip by strip (top to bottom).
 *   the one habit allowed against the order: "fill a gap with a small part" — a SMALL part (under
 *          200 mm both ways) standing alone may be cut straight after the block whose gap it sits in, even
 *          when that steps back along the plate, but never out of its sequence, never after its host's
 *          opening, never into the middle of a block (`smallBackStep: false` turns it off).
 */
import { cleanRing, orientRing, pointInRing, bboxOfRing, ringsObject, toPolygon, polygonsDistance } from '../lib/polyGeom.js';
import { SHOP_DEFAULTS } from './shopRules.js';

export const SMALL_PART_MM = 200;
const TOL = 1e-6;
const EDGE_TOL_MM = 0.5;          // two facing edges are "equal" within this
const BACK_STEP_MM = 50;          // a step back along the plate further than this is a back-step
const r3 = (v) => Math.round(Number(v) * 1000) / 1000;
const pt3 = (p) => [r3(p[0]), r3(p[1])];

/* ───────────────────────────── small geometry ───────────────────────────── */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const len = (a) => Math.hypot(a[0], a[1]);
const unit = (a) => { const l = len(a); return l > 0 ? [a[0] / l, a[1] / l] : [0, 0]; };
const left = (a) => [-a[1], a[0]];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const rot = (a, deg) => { const c = Math.cos((deg * Math.PI) / 180); const s = Math.sin((deg * Math.PI) / 180); return [a[0] * c - a[1] * s, a[0] * s + a[1] * c]; };
const boxOf = (pts) => { const b = bboxOfRing(pts); return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }; };
const boxGap = (a, b) => Math.max(a.x0 - b.x1, b.x0 - a.x1, a.y0 - b.y1, b.y0 - a.y1);
const inBox = (p, b, m = 0) => p[0] >= b.x0 - m && p[0] <= b.x1 + m && p[1] >= b.y0 - m && p[1] <= b.y1 + m;

function segsCross(p1, p2, q1, q2) {
  const d1 = cross(sub(p2, p1), sub(q1, p1)); const d2 = cross(sub(p2, p1), sub(q2, p1));
  const d3 = cross(sub(q2, q1), sub(p1, q1)); const d4 = cross(sub(q2, q1), sub(p2, q1));
  return ((d1 > TOL && d2 < -TOL) || (d1 < -TOL && d2 > TOL)) && ((d3 > TOL && d4 < -TOL) || (d3 < -TOL && d4 > TOL));
}
const ringEdges = (ring) => ring.map((p, i) => [p, ring[(i + 1) % ring.length]]);

/** The middle of the widest stretch of steel on a few lines across a part (where its CODE is marked). */
function labelSpot(outline, openings) {
  const b = boxOf(outline);
  let best = null;
  for (const fr of [0.5, 0.31, 0.69, 0.17, 0.83]) {
    const y = b.y0 + (b.y1 - b.y0) * fr + 0.0137;
    const xs = [];
    for (const ring of [outline, ...openings]) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y)) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) if (!best || xs[k + 1] - xs[k] > best.w + 1e-9) best = { w: xs[k + 1] - xs[k], x: (xs[k] + xs[k + 1]) / 2, y };
  }
  return best ?? { w: b.x1 - b.x0, x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
}

/** A 90° arc lead ending at S travelling along t, centre on the left of t (inside a hole, outside an outline). */
function arcLead(S, t, r) {
  const n = left(t);
  const C = add(S, mul(n, r));
  const P = sub(C, mul(t, r));
  const a0 = Math.atan2(P[1] - C[1], P[0] - C[0]);
  const path = [];
  for (let i = 0; i <= 9; i += 1) { const a = a0 + (i / 9) * (Math.PI / 2); path.push([C[0] + r * Math.cos(a), C[1] + r * Math.sin(a)]); }
  path[path.length - 1] = S.slice();
  return { type: 'arc', radiusMm: r, angleDeg: 90, centre: C, pierce: P, path };
}

/* ───────────────────────────── the rules ───────────────────────────── */

/** The rules a plan is made with: the shop's defaults, the cut settings' kerf, and what the setting says. */
export function aiRulesOf(settings = {}, shop = null) {
  const r = { ...SHOP_DEFAULTS, ...(shop ?? {}) };
  return {
    kerfMm: Number(settings.kerfMm ?? r.kerfMm ?? 3),
    edgeMarginMm: Number(settings.edgeMarginMm ?? r.edgeMarginMm),
    partGapMm: Number(settings.partGapMm ?? r.partGapMm),
    groupGapMm: Number(settings.groupGapMm ?? r.groupGapMm),
    leadInMm: Number(r.leadInMm), leadOutMm: Number(r.leadOutMm),
    holeLeadRadiusMm: Number(r.holeLeadRadiusMm), holeLeadOutMm: Number(r.holeLeadOutMm),
    sharedLeadInMm: Number(r.sharedLeadInMm), sharedLeadOutMm: Number(r.sharedLeadOutMm),
    pierceOffsetMm: Number(r.pierceOffsetMm), overcutMm: 0,
    shopSpacing: !!settings.shopSpacing,
  };
}

/* ───────────────────────────── the plan ───────────────────────────── */

function normalise(pieces) {
  return pieces.map((p, idx) => {
    const o = ringsObject(p.rings ?? p.placedRings ?? p.outline);
    let outline; let openings = [];
    if (o) {
      outline = orientRing(cleanRing(o.outline), false);                         // clockwise: kerf outside, left comp
      openings = [...(o.cutouts ?? []).map((r) => ({ ring: r, kind: 'cutout' })), ...(o.holes ?? []).map((r) => ({ ring: r, kind: 'hole' }))]
        .map((h) => ({ ...h, ring: orientRing(cleanRing(h.ring), true) }))      // counter-clockwise: kerf inside
        .filter((h) => h.ring.length >= 3);
    } else {
      const x = Number(p.x); const y = Number(p.y); const l = Number(p.length); const w = Number(p.width);
      outline = orientRing([[x, y], [x + l, y], [x + l, y + w], [x, y + w]], false);
    }
    const box = boxOf(outline);
    return {
      idx, key: p.key ?? idx, code: String(p.code ?? p.cutPlateCode ?? '').trim(), outline, openings, box,
      small: box.x1 - box.x0 < SMALL_PART_MM && box.y1 - box.y0 < SMALL_PART_MM,
      seqNo: p.seqNo == null ? null : Number(p.seqNo), rowNo: p.rowNo == null ? null : Number(p.rowNo), posNo: p.posNo == null ? null : Number(p.posNo),
      host: null, opening: null, inners: [],
    };
  });
}

/** Parts inside another part's opening. Every vertex of the inner outline inside the opening ring. */
function findPartInPart(parts) {
  const out = [];
  for (const h of parts) {
    if (!h.openings.length) continue;
    h.openings.forEach((op, oi) => {
      const ob = boxOf(op.ring);
      for (const p of parts) {
        if (p === h || p.host != null) continue;
        if (!(p.box.x0 >= ob.x0 - TOL && p.box.x1 <= ob.x1 + TOL && p.box.y0 >= ob.y0 - TOL && p.box.y1 <= ob.y1 + TOL)) continue;
        if (!p.outline.every((v) => pointInRing(v, op.ring))) continue;
        p.host = h.idx; p.opening = oi; h.inners.push(p.idx);
        out.push({ inner: p.idx, host: h.idx, opening: oi });
      }
    });
  }
  return out;
}

/** Facing straight edges of two parts, EQUAL and exactly one kerf apart: one cut serves both. */
function findSharedEdges(parts, k) {
  const tolK = Math.max(0.05, 0.02 * k);
  const shared = [];
  const order = parts.slice().sort((a, b) => a.box.x0 - b.box.x0);
  for (let i = 0; i < order.length; i += 1) {
    const P = order[i];
    for (let j = i + 1; j < order.length; j += 1) {
      const Q = order[j];
      if (Q.box.x0 > P.box.x1 + k + 1) break;
      if (boxGap(P.box, Q.box) > k + 1) continue;
      const eP = ringEdges(P.outline); const eQ = ringEdges(Q.outline);
      for (let a = 0; a < eP.length; a += 1) {
        const [a0, a1] = eP[a]; const ua = unit(sub(a1, a0)); const la = len(sub(a1, a0));
        if (la < 1) continue;
        for (let b = 0; b < eQ.length; b += 1) {
          const [b0, b1] = eQ[b]; const ub = unit(sub(b1, b0)); const lb = len(sub(b1, b0));
          if (Math.abs(la - lb) > EDGE_TOL_MM || dot(ua, ub) > -0.9999) continue;   // equal length, antiparallel
          // Q's edge lies on Q's side, outward from P: for a clockwise outline the outside is on the left.
          const n = left(ua);
          const d0 = dot(sub(b0, a0), n); const d1 = dot(sub(b1, a0), n);
          if (Math.abs(d0 - k) > tolK || Math.abs(d1 - k) > tolK) continue;
          // the ends face each other: b1 opposite a0, b0 opposite a1
          if (Math.abs(dot(sub(b1, a0), ua)) > EDGE_TOL_MM || Math.abs(dot(sub(b0, a1), ua)) > EDGE_TOL_MM) continue;
          shared.push({ a: P.idx, ea: a, b: Q.idx, eb: b, lengthMm: r3(Math.min(la, lb)) });
        }
      }
    }
  }
  return shared;
}

function components(n, links) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const [a, b] of links) { const ra = find(a); const rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); }
  return Array.from({ length: n }, (_, i) => find(i));
}

/**
 * The cut plan of one plate.
 * @param {{ plate: { length, width }, pieces: Array<{ key?, code?, rings?|placedRings?, x?, y?, length?, width?, seqNo?, rowNo?, posNo? }>,
 *           rules?: object, options?: { sequences?: 'auto'|boolean, smallBackStep?: boolean, marking?: boolean } }} input
 */
export function planCuts({ plate, pieces = [], rules: rulesIn = {}, options = {} } = {}) {
  const L = Number(plate?.length); const W = Number(plate?.width);
  if (!(L > 0 && W > 0)) throw new TypeError('planCuts: the plate needs a positive length and width');
  const rules = { ...aiRulesOf({}), ...rulesIn };
  const k = Number(rules.kerfMm) || 0;
  const parts = normalise(pieces);
  const notes = [];

  const partInPart = findPartInPart(parts);
  const sharedAll = findSharedEdges(parts, k);
  // Sequence mode: our row layout. Every piece says its sequence, and there is more than one sequence or row.
  const seqMode = options.sequences === true || (options.sequences !== false
    && parts.length > 0 && parts.every((p) => p.seqNo != null && p.rowNo != null)
    && (new Set(parts.map((p) => p.seqNo)).size > 1 || new Set(parts.map((p) => p.rowNo)).size > 1));
  // A block never spans two rows (or sequences) of a row layout: our row → part order is a rule.
  const shared = seqMode ? sharedAll.filter((s) => parts[s.a].seqNo === parts[s.b].seqNo && parts[s.a].rowNo === parts[s.b].rowNo) : sharedAll;
  // A part in an opening is not in a block with its host's neighbours (it is cut first, on its own terms).
  const linkable = shared.filter((s) => parts[s.a].host == null && parts[s.b].host == null);
  const comp = components(parts.length, linkable.map((s) => [s.a, s.b]));

  /* units: a block (2+ parts) or a single part */
  const byRoot = new Map();
  parts.forEach((p) => { const r = comp[p.idx]; if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(p.idx); });
  const units = [...byRoot.values()].map((members, id) => {
    const ps = members.map((i) => parts[i]);
    const box = { x0: Math.min(...ps.map((p) => p.box.x0)), y0: Math.min(...ps.map((p) => p.box.y0)), x1: Math.max(...ps.map((p) => p.box.x1)), y1: Math.max(...ps.map((p) => p.box.y1)) };
    // strip by strip: a row layout along the row; a free layout top to bottom, then along the plate
    const ordered = ps.slice().sort(seqMode
      ? (a, b) => (a.posNo ?? 0) - (b.posNo ?? 0) || a.box.x0 - b.box.x0 || a.box.y0 - b.box.y0
      : (a, b) => b.box.y1 - a.box.y1 || a.box.x0 - b.box.x0).map((p) => p.idx);
    const seqNo = seqMode ? Math.min(...ps.map((p) => p.seqNo)) : null;
    const rowNo = seqMode ? Math.min(...ps.map((p) => p.rowNo)) : null;
    return { id, members: ordered, box, seqNo, rowNo, block: ps.length > 1, small: ps.length === 1 && ps[0].small, host: ps.length === 1 ? ps[0].host : null, backStep: false, forcedByInner: false };
  });
  const unitOf = new Map();
  units.forEach((u) => u.members.forEach((m) => unitOf.set(m, u.id)));

  /* the order of the units */
  let order = units.slice().sort(seqMode
    ? (a, b) => a.seqNo - b.seqNo || a.rowNo - b.rowNo || a.box.x0 - b.box.x0 || a.box.y0 - b.box.y0
    : (a, b) => Math.round(a.box.x0) - Math.round(b.box.x0) || b.box.y1 - a.box.y1 || a.id - b.id).map((u) => u.id);

  // The shop's one habit against the order: a small loose part right after the block whose gap it fills.
  if (options.smallBackStep !== false) {
    const reach = Math.max(Number(rules.groupGapMm) || 0, Number(rules.partGapMm) || 0, k) * 2 + 1;
    for (const s of units.filter((u) => u.small && u.host == null && !parts[u.members[0]].inners.length)) {
      let best = null;
      for (const u of units) {
        if (u === s || u.small || u.host != null) continue;
        if (seqMode && u.seqNo !== s.seqNo) continue;            // never out of its sequence
        const d = boxGap(s.box, u.box);
        if (d <= reach && (!best || d < best.d)) best = { d, u };
      }
      if (!best) continue;
      const from = order.indexOf(s.id);
      order.splice(from, 1);
      order.splice(order.indexOf(best.u.id) + 1, 0, s.id);
      s.fillsGap = best.u.id;
    }
  }
  // HARD: a part in an opening before its host (so before the opening). Physical — it outranks the sequence order.
  for (let guard = 0; guard < units.length + 1; guard += 1) {
    let moved = false;
    for (const u of units) {
      for (const m of u.members) {
        for (const ii of parts[m].inners) {
          const iu = unitOf.get(ii);
          if (order.indexOf(iu) > order.indexOf(u.id)) {
            order.splice(order.indexOf(iu), 1);
            order.splice(order.indexOf(u.id), 0, iu);
            units[iu].forcedByInner = true;
            moved = true;
          }
        }
      }
    }
    if (!moved) break;
  }
  // Mark the back-steps that remain (free layouts: a unit that starts well behind the furthest point reached).
  let reached = -Infinity;
  for (const id of order) {
    const u = units[id];
    // A part moved before its host (rule 2) is cut where its host is: it neither steps back nor moves the head on.
    if (u.forcedByInner) continue;
    if (!seqMode && u.box.x0 < reached - BACK_STEP_MM) u.backStep = true;
    // A small part cut straight after the block whose gap it fills is cut WHERE THAT BLOCK IS: it does not move
    // the head on (2026-10-18, COMPARE.md 5 — a stiffener in the far corner of a long strip's gap made every
    // big part after the strip look like a step back along the plate).
    if (u.fillsGap != null) continue;
    reached = Math.max(reached, u.box.x0);
  }

  /* the steps */
  const steps = [];
  const cut = new Set();
  const sharedOf = new Map();
  for (const s of sharedAll) {
    if (!sharedOf.has(s.a)) sharedOf.set(s.a, []); if (!sharedOf.has(s.b)) sharedOf.set(s.b, []);
    sharedOf.get(s.a).push({ edge: s.ea, other: s.b }); sharedOf.get(s.b).push({ edge: s.eb, other: s.a });
  }
  const nearParts = (p, m) => parts.filter((q) => q !== p && boxGap(q.box, p.box) <= m);
  const inSteel = (pt, q) => pointInRing(pt, q.outline) && !q.openings.some((h) => pointInRing(pt, h.ring));
  const leadOk = (from, to, self) => {
    if (!(from[0] >= -TOL && from[0] <= L + TOL && from[1] >= -TOL && from[1] <= W + TOL)) return false;
    for (const q of nearParts(self, 20)) {
      if (inSteel(from, q)) return false;
      for (const [e0, e1] of ringEdges(q.outline)) if (segsCross(from, to, e0, e1)) return false;
    }
    return !inSteel(from, self) || self.openings.some((h) => pointInRing(from, h.ring));
  };
  const straightLead = (S, u, lengthMm, self, n) => {
    for (const ang of [0, -90, 90, -135, 135]) {
      const dir = ang ? rot(mul(u, -1), ang) : mul(u, -1);
      const P = add(S, mul(dir, lengthMm));
      // never back into the part: the lead must leave on the outside of the part (or the open side)
      if (n && dot(dir, n) < -1e-9 && ang) continue;
      if (leadOk(P, S, self)) return { type: 'line', lengthMm, angleDeg: ang, pierce: P, path: [P, S.slice()] };
    }
    return null;
  };
  let nStep = 0;
  const push = (st) => { nStep += 1; steps.push({ n: nStep, ...st }); };

  for (const uid of order) {
    const u = units[uid];
    for (const m of u.members) {
      const p = parts[m];
      // 1. MARKING: the part's code, single-stroke text, before anything is cut in it.
      if (options.marking !== false && p.code) {
        const spot = labelSpot(p.outline, p.openings.map((h) => h.ring));
        const w = p.box.x1 - p.box.x0; const h = p.box.y1 - p.box.y0;
        const height = Math.max(3, Math.min(100, Math.min(w, h) * 0.25, (Math.min(spot.w, w) * 0.85) / Math.max(1, p.code.length * 0.9)));
        push({ kind: 'mark', part: m, unit: uid, text: p.code, at: pt3([spot.x, spot.y]), heightMm: r3(height), path: null, closed: false, kerfSide: 'none', direction: null, pierce: null, leadIn: null, leadOut: null });
      }
      // 2. HOLES and CUT-OUTS, along the part; the parts nested in an opening are already cut (unit order).
      const holes = p.openings.map((h, oi) => ({ ...h, oi, box: boxOf(h.ring) })).sort((a, b) => a.box.x0 - b.box.x0 || a.box.y0 - b.box.y0);
      for (const h of holes) {
        const ring = h.ring;
        let li = 0; let best = -1;
        ringEdges(ring).forEach(([a, b], i) => { const l = len(sub(b, a)); if (l > best + 1e-9) { best = l; li = i; } });
        const [a, b] = [ring[li], ring[(li + 1) % ring.length]];
        const S = mul(add(a, b), 0.5);
        const t = unit(sub(b, a));
        let r = Number(rules.holeLeadRadiusMm) || 6;
        let lead = arcLead(S, t, r);
        while (r > 0.5 && !(pointInRing(lead.pierce, ring) && pointInRing(lead.centre, ring))) { r /= 2; lead = arcLead(S, t, r); }
        const path = [S, ...ring.slice(li + 1), ...ring.slice(0, li + 1), S].map(pt3);
        const out = Number(rules.holeLeadOutMm) || 0;
        push({
          kind: 'hole', part: m, unit: uid, opening: h.oi, openingKind: h.kind, path, closed: true, direction: 'ccw', kerfSide: 'inside',
          pierce: pt3(lead.pierce), leadIn: { type: 'arc', radiusMm: r3(r), angleDeg: 90, path: lead.path.map(pt3), shrunk: r < (Number(rules.holeLeadRadiusMm) || 6) },
          leadOut: { type: 'line', lengthMm: out, path: [pt3(S), pt3(add(S, mul(left(t), out)))] },
          inners: p.inners.filter((ii) => parts[ii].opening === h.oi),
        });
      }
      // 3. THE OUTLINE — or, in a block, the strokes for the edges no part cut yet.
      const done = new Set((sharedOf.get(m) ?? []).filter((s) => cut.has(s.other)).map((s) => s.edge));
      const ring = p.outline; const n = ring.length;
      if (!done.size) {
        // a corner: convex (clockwise ring → a right turn), nearest the plate start, the top one first
        const corners = [];
        for (let i = 0; i < n; i += 1) {
          const prev = ring[(i - 1 + n) % n]; const cur = ring[i]; const next = ring[(i + 1) % n];
          const d1 = unit(sub(cur, prev)); const d2 = unit(sub(next, cur));
          const turn = Math.acos(Math.max(-1, Math.min(1, dot(d1, d2)))) * (180 / Math.PI);
          if (cross(d1, d2) < 0 && turn >= 30) corners.push(i);
        }
        corners.sort((a, b) => ring[a][0] - ring[b][0] || ring[b][1] - ring[a][1]);
        let lead = null; let start = 0;
        for (const ci of corners) {
          const S = ring[ci]; const u0 = unit(sub(ring[(ci + 1) % n], S));
          lead = straightLead(S, u0, Number(rules.leadInMm) || 6, p, left(u0));
          if (lead) { start = ci; break; }
        }
        if (!lead) {
          let li = 0; let best = -1;
          ringEdges(ring).forEach(([a, b], i) => { const l = len(sub(b, a)); if (l > best + 1e-9) { best = l; li = i; } });
          const S = mul(add(ring[li], ring[(li + 1) % n]), 0.5); const t = unit(sub(ring[(li + 1) % n], ring[li]));
          const arc = arcLead(S, t, Number(rules.leadInMm) || 6);
          const path = [S, ...ring.slice(li + 1), ...ring.slice(0, li + 1), S].map(pt3);
          const ok = leadOk(arc.pierce, S, p);
          if (!ok) notes.push(`part ${p.code || p.key}: no clean place for the lead-in; it pierces next to another part`);
          push({ kind: 'outline', part: m, unit: uid, path, closed: true, direction: 'cw', kerfSide: 'outside', pierce: pt3(arc.pierce), pierceOk: ok, startAt: 'side',
            leadIn: { type: 'arc', radiusMm: Number(rules.leadInMm) || 6, angleDeg: 90, path: arc.path.map(pt3) },
            leadOut: { type: 'arc', radiusMm: Number(rules.leadOutMm) || 2, angleDeg: 90, path: [pt3(S), pt3(add(S, mul(left(t), Number(rules.leadOutMm) || 2)))] } });
        } else {
          const S = ring[start]; const wLast = unit(sub(S, ring[(start - 1 + n) % n]));
          const path = [...ring.slice(start), ...ring.slice(0, start), S].map(pt3);
          const out = Number(rules.leadOutMm) || 0;
          push({ kind: 'outline', part: m, unit: uid, path, closed: true, direction: 'cw', kerfSide: 'outside', pierce: pt3(lead.pierce), pierceOk: true, startAt: 'corner',
            leadIn: { type: 'line', lengthMm: lead.lengthMm, angleDeg: lead.angleDeg, path: lead.path.map(pt3) },
            leadOut: { type: 'line', lengthMm: out, angleDeg: 0, path: [pt3(S), pt3(add(S, mul(wLast, out)))] } });
        }
      } else {
        // the open chains of edges not cut yet, each one stroke (one pierce)
        const free = []; for (let i = 0; i < n; i += 1) if (!done.has(i)) free.push(i);
        if (!free.length) { push({ kind: 'freed', part: m, unit: uid, path: null, closed: false, kerfSide: 'none', direction: null, pierce: null, leadIn: null, leadOut: null }); cut.add(m); continue; }
        let s0 = free.find((i) => done.has((i - 1 + n) % n)) ?? free[0];
        const chains = []; const seen = new Set();
        for (let guard = 0; guard < n && seen.size < free.length; guard += 1) {
          if (seen.has(s0) || done.has(s0)) { s0 = free.find((i) => !seen.has(i) && done.has((i - 1 + n) % n)) ?? free.find((i) => !seen.has(i)); if (s0 == null) break; }
          const ch = [];
          for (let i = s0; !done.has(i) && !seen.has(i); i = (i + 1) % n) { ch.push(i); seen.add(i); }
          if (ch.length) chains.push(ch);
        }
        for (const ch of chains) {
          const pts = [ring[ch[0]], ...ch.map((i) => ring[(i + 1) % n])];
          const S = pts[0]; const u0 = unit(sub(pts[1], S));
          // Boxed in by cut lines (a grid of common cuts): pierce IN THE KERF CROSSING, half a kerf off the
          // corner each way — where the shop's common-line paths start (2.1 mm diagonal at a 3 mm kerf).
          const inKerf = () => {
            const P = add(S, add(mul(u0, -k / 2), mul(left(u0), k / 2)));
            const free = P[0] >= 0 && P[1] >= 0 && P[0] <= L && P[1] <= W && !nearParts(p, 20).some((q) => inSteel(P, q)) && !inSteel(P, p);
            return free ? { type: 'line', lengthMm: r3(len(sub(S, P))), angleDeg: 45, pierce: P, path: [P, S.slice()], inKerf: true } : null;
          };
          const lead = straightLead(S, u0, Number(rules.sharedLeadInMm) || 6.35, p, left(u0)) ?? inKerf()
            ?? { type: 'line', lengthMm: Number(rules.sharedLeadInMm) || 6.35, angleDeg: 0, pierce: sub(S, mul(u0, Number(rules.sharedLeadInMm) || 6.35)), path: [sub(S, mul(u0, Number(rules.sharedLeadInMm) || 6.35)), S], forced: true };
          const E = pts[pts.length - 1]; const wl = unit(sub(E, pts[pts.length - 2]));
          const out = Number(rules.sharedLeadOutMm) || 0;
          push({ kind: 'stroke', part: m, unit: uid, path: pts.map(pt3), closed: false, direction: 'cw', kerfSide: 'outside', pierce: pt3(lead.pierce), pierceOk: !lead.forced,
            leadIn: { type: 'line', lengthMm: lead.lengthMm, angleDeg: lead.angleDeg, path: lead.path.map(pt3) },
            leadOut: { type: 'line', lengthMm: out, angleDeg: 0, path: [pt3(E), pt3(add(E, mul(wl, out)))] },
            sharedWith: [...new Set((sharedOf.get(m) ?? []).filter((s) => cut.has(s.other)).map((s) => s.other))] });
        }
      }
      cut.add(m);
    }
  }

  /* spacing, next to the shop's */
  const findings = [];
  const edgeMin = parts.length ? Math.min(...parts.map((p) => Math.min(p.box.x0, p.box.y0, L - p.box.x1, W - p.box.y1))) : null;
  if (edgeMin != null && edgeMin < (Number(rules.edgeMarginMm) || 0) - 1e-3) findings.push({ kind: 'EDGE_MARGIN', mm: r3(edgeMin), want: rules.edgeMarginMm });
  const pairShared = new Set(sharedAll.map((s) => `${Math.min(s.a, s.b)}:${Math.max(s.a, s.b)}`));
  const reachMm = Math.max(Number(rules.partGapMm) || 0, Number(rules.groupGapMm) || 0);
  const polys = parts.map((p) => toPolygon({ outline: p.outline, cutouts: p.openings.map((h) => h.ring), holes: [] }));
  let minPart = Infinity; let minGroup = Infinity;
  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      const P = parts[i]; const Q = parts[j];
      if (boxGap(P.box, Q.box) >= reachMm) continue;
      if (pairShared.has(`${i}:${j}`)) continue;
      // diagonal neighbours of a common-cut grid: corner to corner across a crossing of two cut lines, not a gap
      const gx = Math.max(P.box.x0 - Q.box.x1, Q.box.x0 - P.box.x1); const gy = Math.max(P.box.y0 - Q.box.y1, Q.box.y0 - P.box.y1);
      if (Math.abs(gx - k) <= 0.05 && Math.abs(gy - k) <= 0.05) continue;
      if (!polys[i] || !polys[j]) continue;
      const d = polygonsDistance(polys[i], polys[j], reachMm + 1);
      // exactly one kerf apart along part of an edge: a common cut (one cut serves both), not a gap
      if (Math.abs(d - k) <= Math.max(0.05, 0.02 * k)) continue;
      const sameUnit = unitOf.get(i) === unitOf.get(j);
      const blocks = units[unitOf.get(i)].block || units[unitOf.get(j)].block;
      if (!sameUnit && blocks) minGroup = Math.min(minGroup, d); else minPart = Math.min(minPart, d);
      if (d < (Number(rules.partGapMm) || 0) - 1e-3) findings.push({ kind: 'PART_GAP', a: i, b: j, mm: r3(d), want: rules.partGapMm });
      else if (!sameUnit && blocks && d < (Number(rules.groupGapMm) || 0) - 1e-3) findings.push({ kind: 'GROUP_GAP', a: i, b: j, mm: r3(d), want: rules.groupGapMm });
    }
  }

  const groups = units.filter((u) => u.block).map((u) => ({
    unit: u.id, members: u.members,
    sharedEdges: sharedAll.filter((s) => unitOf.get(s.a) === u.id && unitOf.get(s.b) === u.id).map((s) => ({ a: s.a, b: s.b, lengthMm: s.lengthMm })),
  }));
  groups.forEach((g) => { g.sharedLengthMm = r3(g.sharedEdges.reduce((a, e) => a + e.lengthMm, 0)); });

  const plan = {
    plate: { length: L, width: W },
    rules,
    mode: seqMode ? 'sequences' : 'free',
    parts: parts.map((p) => ({ idx: p.idx, key: p.key, code: p.code, outline: p.outline.map(pt3), box: { x0: r3(p.box.x0), y0: r3(p.box.y0), x1: r3(p.box.x1), y1: r3(p.box.y1) }, small: p.small, seqNo: p.seqNo, rowNo: p.rowNo, host: p.host, opening: p.opening, unit: unitOf.get(p.idx) })),
    units: order.map((id) => ({ id, members: units[id].members, block: units[id].block, small: units[id].small, seqNo: units[id].seqNo, rowNo: units[id].rowNo, x0: r3(units[id].box.x0), backStep: units[id].backStep, forcedByInner: units[id].forcedByInner })),
    partInPart, groups, steps,
    counts: { parts: parts.length, pierces: steps.filter((s) => s.pierce).length, marks: steps.filter((s) => s.kind === 'mark').length, holes: steps.filter((s) => s.kind === 'hole').length, outlines: steps.filter((s) => s.kind === 'outline').length, strokes: steps.filter((s) => s.kind === 'stroke').length, blocks: groups.length, inBlocks: groups.reduce((a, g) => a + g.members.length, 0), partInPart: partInPart.length, backSteps: units.filter((u) => u.backStep).length },
    spacing: { edgeMinMm: edgeMin == null ? null : r3(edgeMin), partGapMinMm: Number.isFinite(minPart) ? r3(minPart) : null, groupGapMinMm: Number.isFinite(minGroup) ? r3(minGroup) : null, findings },
    notes,
  };
  plan.check = checkCutPlan(plan);
  return plan;
}

/**
 * The hard rules, on a plan: per part marking → holes → outline; a part in an opening before that
 * opening; a block in one go; sequences in order (a row layout) — a part moved for rule 2 excepted;
 * on a free layout only a small loose part (or one moved for rule 2) steps back; every part cut once;
 * no pierce on another part's steel. → { ok, problems: [{ kind, … }] }
 */
export function checkCutPlan(plan) {
  const problems = [];
  const at = new Map();
  plan.steps.forEach((s, i) => { if (!at.has(s.part)) at.set(s.part, []); at.get(s.part).push({ ...s, i }); });
  for (const p of plan.parts) {
    const ss = at.get(p.idx) ?? [];
    const rank = { mark: 0, hole: 1, outline: 2, stroke: 2, freed: 2 };
    for (let j = 1; j < ss.length; j += 1) if (rank[ss[j].kind] < rank[ss[j - 1].kind]) problems.push({ kind: 'PART_ORDER', part: p.idx, detail: `${ss[j].kind} after ${ss[j - 1].kind}` });
    const cutSteps = ss.filter((s) => s.kind === 'outline' || s.kind === 'stroke' || s.kind === 'freed');
    if (!cutSteps.length) problems.push({ kind: 'NOT_CUT', part: p.idx });
    if (ss.filter((s) => s.kind === 'outline').length > 1) problems.push({ kind: 'CUT_TWICE', part: p.idx });
  }
  for (const pp of plan.partInPart) {
    const inner = at.get(pp.inner) ?? [];
    const openingStep = (at.get(pp.host) ?? []).find((s) => s.kind === 'hole' && s.opening === pp.opening);
    const hostFirst = Math.min(...(at.get(pp.host) ?? []).filter((s) => s.kind !== 'mark').map((s) => s.i));
    const innerLast = Math.max(...inner.map((s) => s.i));
    if (!openingStep || innerLast > openingStep.i || innerLast > hostFirst) problems.push({ kind: 'INNER_AFTER_OPENING', inner: pp.inner, host: pp.host });
  }
  // a block (unit) in one go
  const unitRuns = [];
  plan.steps.forEach((s) => { if (!unitRuns.length || unitRuns[unitRuns.length - 1] !== s.unit) unitRuns.push(s.unit); });
  const seenU = new Set();
  for (const u of unitRuns) { if (seenU.has(u)) problems.push({ kind: 'BLOCK_SPLIT', unit: u }); seenU.add(u); }
  // sequences / back-steps
  const units = new Map(plan.units.map((u) => [u.id, u]));
  if (plan.mode === 'sequences') {
    let last = -Infinity;
    for (const u of plan.units) {
      if (u.seqNo < last && !u.forcedByInner) problems.push({ kind: 'SEQUENCE_ORDER', unit: u.id, seqNo: u.seqNo, after: last });
      if (!u.forcedByInner) last = Math.max(last, u.seqNo);
    }
  } else {
    for (const u of plan.units) if (u.backStep && !u.small && !u.forcedByInner) problems.push({ kind: 'BACKSTEP_NOT_SMALL', unit: u.id });
  }
  for (const s of plan.steps) if (s.pierce && s.pierceOk === false) problems.push({ kind: 'PIERCE_ON_PART', step: s.n, part: s.part });
  void units;
  return { ok: problems.length === 0, problems };
}
