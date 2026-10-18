/**
 * plannerV3Engine.js — STEP 5, the planner's ENGINE (pure: no reads, no writes). Contract: TM/CF_ERP_ORDER_FLOW_PLAN.md
 * "2026-10-18 — Step 5: the planner". The service (plannerV3Service.js) reads, this file decides WHEN.
 *
 * The user, 2026-10-18:
 *   - plan per PRODUCTION ORDER, at STEP level; "no step before its predecessors finish and its material is available";
 *   - days on screen, MINUTES in the engine; a step may span days;
 *   - capacity per machine type from each machine's shifts, minus planned downtime and open faults (the calendar reader
 *     shiftService.machinesCalendar already gives that per machine per day — the caller hands it in);
 *   - AUTO: committed dates, then money unlocked earliest, then manual priority; pinning allowed.
 *     MANUAL: an earliest start + a priority rank per production order; "higher rank takes what it can, lower stretches";
 *   - NO frozen window: every unstarted step moves; a started step keeps (planned − elapsed), ≤ 0 = it ends now;
 *   - real dates override planned (a done step keeps its real start and finish).
 *
 * THE CLOCK. Minutes from midnight of day 0 (the caller's first day, today). Day i is [i·1440, (i+1)·1440).
 *
 * A MACHINE is a serial lane. Its day i gives cap[i] working minutes (shifts − downtime − faults). The engine knows
 * minutes, not shift windows, so a day's working minutes are spread evenly over the day: work minute w of the lane sits
 * on the clock at day d + (w − cum[d]) / cap[d] of the day. Days show exactly; within a day the time is proportional.
 * A step occupies one contiguous run of work minutes on one machine — it may run over several days. The lane keeps its
 * booked runs; a step goes into the FIRST gap that fits from its earliest start (so a lower rank fills what a higher
 * rank left free — "lower stretches", never pushes a higher one out).
 *
 * ORDER OF PLANNING. Steps are planned in priority order (the caller's production-order order, then the step's order
 * inside it), a step only once every predecessor is planned (Kahn over the waits). Earliest start of a step =
 * max(now, the production order's earliest start, each predecessor's finish — or start, for a "started" wait — and
 * the day its material is there). Whichever term decided it is the step's BINDING reason; a later start than that
 * (a busy or stopped machine) is CAPACITY ("down" when a day in between had downtime or a fault on that machine).
 *
 * MATERIAL is first come, first served by PLANNED START: the caller's material(claimOrder) serves the steps in the order
 * given and answers each with { at: clock | null (waiting, no date), text }. Pass 1 claims in priority order; each next
 * pass claims in the previous pass's planned-start order, until the answer stops changing (≤ MAX_PASSES).
 */

export const DAY = 1440;
export const MAX_PASSES = 3;
const EPS = 1e-9;

/** A machine lane: the clock ↔ work-minute map of its calendar, and its booked runs. */
export class Lane {
  constructor({ id, code = null, typeKey, days, down = [] }, now) {
    this.id = id;
    this.code = code ?? String(id);
    this.typeKey = String(typeKey);
    this.cap = days.map((m) => Math.max(0, Number(m) || 0));
    this.n = this.cap.length;
    this.cum = new Array(this.n + 1);
    this.cum[0] = 0;
    for (let i = 0; i < this.n; i++) this.cum[i + 1] = this.cum[i] + this.cap[i];
    this.total = this.cum[this.n];
    this.down = new Set(down);           // day indexes with planned downtime or a fault on this machine
    // The past is not usable: everything before now is booked to nobody.
    this.busy = [];                      // sorted [{ a, b, po }] in work minutes, not overlapping
    const w0 = this.W(now);
    if (w0 > EPS) this.busy.push({ a: 0, b: w0, po: null });
  }

  /** Work minutes done on this lane before clock t. */
  W(t) {
    if (t <= 0) return 0;
    const d = Math.floor(t / DAY);
    if (d >= this.n) return this.total;
    return this.cum[d] + ((t - d * DAY) / DAY) * this.cap[d];
  }

  /** The clock of work minute w: as a START (the day it begins in) or as an END (the day it finishes in). */
  C(w, asEnd = false) {
    if (w > this.total + EPS) return Infinity;
    // smallest d with cum[d+1] > w (start) / >= w (end), cap[d] > 0
    let lo = 0;
    let hi = this.n - 1;
    let d = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const ok = asEnd ? this.cum[mid + 1] >= w - EPS : this.cum[mid + 1] > w + EPS;
      if (ok) { d = mid; hi = mid - 1; } else lo = mid + 1;
    }
    if (d < 0) return asEnd ? this.n * DAY : Infinity;
    while (d < this.n && this.cap[d] <= 0) d += 1;
    if (d >= this.n) return Infinity;
    return d * DAY + ((w - this.cum[d]) / this.cap[d]) * DAY;
  }

  /** First start ≥ from where len work minutes are free. null: not inside the horizon. */
  gap(from, len) {
    let s = Math.max(0, from);
    const list = this.busy;
    // the first run that ends after s
    let lo = 0;
    let hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].b <= s + EPS) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < list.length; i++) {
      const r = list[i];
      if (r.a >= s + len - EPS) break;
      if (r.b > s) s = r.b;
    }
    return s + len <= this.total + EPS ? s : null;
  }

  /** Whose run is at work minute w (or the first one after it): the production order a step waited behind. */
  ownerAt(w) {
    for (const r of this.busy) if (r.b > w + EPS) return r.po;
    return null;
  }

  book(a, len, po) {
    if (!(len > EPS)) return;
    const b = a + len;
    let i = 0;
    while (i < this.busy.length && this.busy[i].a < a) i += 1;
    const prev = this.busy[i - 1];
    if (prev && prev.po === po && Math.abs(prev.b - a) < EPS) {
      prev.b = b;
      const next = this.busy[i];
      if (next && next.po === po && Math.abs(next.a - b) < EPS) { prev.b = next.b; this.busy.splice(i, 1); }
      return;
    }
    const next = this.busy[i];
    if (next && next.po === po && Math.abs(next.a - b) < EPS) { next.a = a; return; }
    this.busy.splice(i, 0, { a, b, po });
  }

  /** Did any day between two clocks have downtime or a fault on this machine? */
  downBetween(t1, t2) {
    if (!this.down.size) return false;
    const d1 = Math.max(0, Math.floor(t1 / DAY));
    const d2 = Math.min(this.n - 1, Math.floor(t2 / DAY));
    for (let d = d1; d <= d2; d++) if (this.down.has(d)) return true;
    return false;
  }
}

/** A small binary heap by a compare function. */
class Heap {
  constructor(cmp) { this.a = []; this.cmp = cmp; }
  get size() { return this.a.length; }
  push(x) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (this.cmp(a[i], a[p]) >= 0) break; [a[i], a[p]] = [a[p], a[i]]; i = p; }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1; const r = l + 1; let m = i;
        if (l < a.length && this.cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}

/**
 * One pass: every step planned once, in priority order, given each step's material answer.
 *
 * input = {
 *   now,                         clock minute of now
 *   horizonDays,                 number of days the lanes cover (beyond = "not inside the horizon")
 *   machines: [{ id, code, typeKey, days: [minutes a day], down: [day index …] }],
 *   orders:   [{ id, earliestStart: clock | null }]            IN PRIORITY ORDER (index = rank)
 *   steps:    [{ id, poId, typeKey | null, machineId | null, contractor, minutes, state: pending|in_progress|done|on_hold,
 *                startedAt: clock | null, finishedAt: clock | null, order: number }]
 *                minutes = what is left (the caller works out planned − elapsed for a started step)
 *   waits:    [{ stepId, onStepId, required: 'started' | 'done' }]
 * }
 * material: Map(stepId -> { at: clock | null, text })
 */
export function schedulePass(input, material = new Map()) {
  const { now, orders, steps, waits } = input;
  const horizonEnd = (input.horizonDays ?? 0) * DAY;
  const lanes = input.machines.map((m) => new Lane(m, now));
  const lanesOfType = new Map();
  for (const l of lanes) { if (!lanesOfType.has(l.typeKey)) lanesOfType.set(l.typeKey, []); lanesOfType.get(l.typeKey).push(l); }
  const laneById = new Map(lanes.map((l) => [Number(l.id), l]));
  const rankOf = new Map(orders.map((o, i) => [Number(o.id), i]));
  const orderById = new Map(orders.map((o) => [Number(o.id), o]));
  const stepById = new Map(steps.map((s) => [Number(s.id), s]));

  const preds = new Map();      // stepId -> [{ on, required }]
  const succs = new Map();      // stepId -> [stepId]
  const indeg = new Map(steps.map((s) => [Number(s.id), 0]));
  for (const w of waits) {
    const a = Number(w.stepId);
    const b = Number(w.onStepId);
    if (!stepById.has(a) || !stepById.has(b) || a === b) continue;
    if (!preds.has(a)) preds.set(a, []);
    preds.get(a).push({ on: b, required: w.required === 'started' ? 'started' : 'done' });
    if (!succs.has(b)) succs.set(b, []);
    succs.get(b).push(a);
    indeg.set(a, indeg.get(a) + 1);
  }

  const out = new Map();        // stepId -> result
  const rankKey = (s) => rankOf.get(Number(s.poId)) ?? Number.MAX_SAFE_INTEGER;
  const cmp = (x, y) => {
    // started / done work first (it holds its machine already), then the production order's rank, then the step's order
    const sx = x.state === 'pending' || x.state === 'on_hold' ? 1 : 0;
    const sy = y.state === 'pending' || y.state === 'on_hold' ? 1 : 0;
    return sx - sy || rankKey(x) - rankKey(y) || (x.order ?? 0) - (y.order ?? 0) || x.id - y.id;
  };
  const heap = new Heap(cmp);
  for (const s of steps) if (indeg.get(Number(s.id)) === 0) heap.push(s);
  const order = [];

  const place = (s) => {
    const id = Number(s.id);
    const len = Math.max(0, Number(s.minutes) || 0);
    // REAL dates win: a done step is where it was.
    if (s.state === 'done') {
      const end = s.finishedAt ?? s.startedAt ?? now;
      return { start: Math.min(s.startedAt ?? end, end), end, machineId: s.machineId ?? null, real: true, binding: { kind: 'done' } };
    }
    // Earliest start, and what decided it.
    let earliest = now;
    let binding = { kind: 'now' };
    if (s.state === 'in_progress' || (s.state === 'on_hold' && s.startedAt != null)) {
      // Started: it carries on from now with what is left. (On hold since a start: the same — it is not moved back.)
      binding = { kind: 'started' };
    } else {
      const po = orderById.get(Number(s.poId));
      if (po?.earliestStart != null && po.earliestStart > earliest + EPS) { binding = { kind: 'start', at: po.earliestStart, waited: po.earliestStart - earliest }; earliest = po.earliestStart; }
      for (const p of preds.get(id) ?? []) {
        const r = out.get(p.on);
        if (!r || r.end == null) {
          return { start: null, end: null, machineId: null, unplanned: true, binding: { kind: 'after', on: p.on, text: r?.binding?.text ?? null } };
        }
        const t = p.required === 'started' ? r.start : r.end;
        if (t > earliest + EPS) { earliest = t; binding = { kind: 'predecessor', on: p.on }; }
      }
      const m = material.get(id);
      if (m) {
        if (m.at == null) return { start: null, end: null, machineId: null, unplanned: true, binding: { kind: 'material', text: m.text ?? null } };
        if (m.at > earliest + EPS) { binding = { kind: 'material', text: m.text ?? null, at: m.at, waited: m.at - earliest }; earliest = m.at; }
      }
    }
    // Started with nothing left: it ends now.
    if ((s.state === 'in_progress' || s.state === 'on_hold') && s.startedAt != null && len <= EPS) {
      return { start: s.startedAt, end: Math.max(now, s.startedAt), machineId: s.machineId ?? null, binding: { kind: 'started' } };
    }
    // A contractor's step, or one no machine type can do, takes calendar time with no limit.
    if (s.contractor || (s.typeKey == null && s.machineId == null)) {
      const start = s.startedAt != null && s.state !== 'pending' ? s.startedAt : earliest;
      const end = Math.max(earliest, start) + len;
      return { start, end, machineId: null, unlimited: true, binding };
    }
    const candidates = s.machineId != null ? [laneById.get(Number(s.machineId))].filter(Boolean) : lanesOfType.get(String(s.typeKey)) ?? [];
    if (!candidates.length || candidates.every((l) => l.total <= EPS)) {
      return { start: null, end: null, machineId: null, unplanned: true, binding: { kind: 'no_capacity', typeKey: s.typeKey, machineId: s.machineId ?? null } };
    }
    let best = null;
    for (const l of candidates) {
      const from = l.W(earliest);
      const a = len > EPS ? l.gap(from, len) : from;
      if (a == null) continue;
      const startT = Math.max(earliest, l.C(a));
      const endT = len > EPS ? l.C(a + len, true) : startT;
      if (!Number.isFinite(endT)) continue;
      if (!best || endT < best.end - EPS || (Math.abs(endT - best.end) <= EPS && startT < best.start)) best = { lane: l, a, from, start: startT, end: endT };
    }
    if (!best) {
      // Nothing left on any machine from then on (a fault until closed, no shifts ahead): no capacity, not "too far".
      const none = candidates.every((l) => l.total - l.W(earliest) <= EPS);
      return { start: null, end: null, machineId: null, unplanned: true, binding: none ? { kind: 'no_capacity', typeKey: s.typeKey, machineId: s.machineId ?? null } : { kind: 'horizon' } };
    }
    best.lane.book(best.a, len, Number(s.poId));
    const started = s.state !== 'pending' && s.startedAt != null;
    const start = started ? s.startedAt : best.start;
    let b = binding;
    if (!started && best.start > earliest + 1) {
      // It waited for the machine: behind whom, or because the machine was down.
      const behind = best.lane.ownerAt(best.from);
      b = best.lane.downBetween(earliest, best.start)
        ? { kind: 'down', machineId: best.lane.id, waited: best.start - earliest, was: binding }
        : { kind: 'capacity', typeKey: best.lane.typeKey, machineId: best.lane.id, behindPo: behind, waited: best.start - earliest, was: binding };
    }
    return { start, end: best.end, machineId: best.lane.id, binding: b, earliest };
  };

  while (heap.size) {
    const s = heap.pop();
    const id = Number(s.id);
    const r = place(s);
    out.set(id, r);
    order.push(id);
    for (const n of succs.get(id) ?? []) {
      indeg.set(n, indeg.get(n) - 1);
      if (indeg.get(n) === 0) heap.push(stepById.get(n));
    }
  }
  // A wait loop (should never happen — flows are acyclic): what is left is not planned.
  for (const s of steps) {
    if (!out.has(Number(s.id))) out.set(Number(s.id), { start: null, end: null, machineId: null, unplanned: true, binding: { kind: 'loop' } });
  }
  return { steps: out, lanes, horizonEnd };
}

/**
 * The whole plan: passes until material, claimed in planned-start order, stops changing.
 * materialOf(claimOrder: stepId[]) -> Map(stepId -> { at, text }) — the caller serves material first come, first served.
 */
export function planAll(input, materialOf = null) {
  const needIds = new Set(input.materialStepIds ?? []);
  const rankOf = new Map(input.orders.map((o, i) => [Number(o.id), i]));
  const poOf = new Map(input.steps.map((s) => [Number(s.id), Number(s.poId)]));
  let claim = input.steps.filter((s) => needIds.has(Number(s.id)))
    .sort((a, b) => (rankOf.get(Number(a.poId)) ?? 1e9) - (rankOf.get(Number(b.poId)) ?? 1e9) || (a.order ?? 0) - (b.order ?? 0) || a.id - b.id)
    .map((s) => Number(s.id));
  let material = materialOf && claim.length ? materialOf(claim) : new Map();
  let res = schedulePass(input, material);
  let passes = 1;
  while (materialOf && claim.length && passes < MAX_PASSES) {
    const next = [...claim].sort((a, b) => {
      const ra = res.steps.get(a); const rb = res.steps.get(b);
      const ta = ra?.earliest ?? ra?.start ?? Infinity; const tb = rb?.earliest ?? rb?.start ?? Infinity;
      return ta - tb || (rankOf.get(poOf.get(a)) ?? 0) - (rankOf.get(poOf.get(b)) ?? 0) || a - b;
    });
    if (next.every((id, i) => id === claim[i])) break;
    const m2 = materialOf(next);
    const same = [...m2].every(([id, v]) => material.get(id)?.at === v.at);
    claim = next;
    material = m2;
    if (same) break;
    res = schedulePass(input, material);
    passes += 1;
  }
  return { ...res, material, passes, claimOrder: claim };
}
