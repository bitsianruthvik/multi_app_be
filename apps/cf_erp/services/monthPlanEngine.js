/**
 * monthPlanEngine.js — THE MONTH PLAN'S OPTIMISER (pure; no database). User, 2026-11-13:
 *
 *   "The AI should run an optimization plan to get out the max output in the entire month (it should consider the
 *    execution plan's shipping units) … explore the cutting edge math algos to see how to get the most optimal plan."
 *
 * THE PROBLEM. Shipping units (each a tonnage and a sequence of work per machine type) compete for the day-by-day
 * capacity of the machines in the plan. A unit counts — at its FULL tonnage — on the day its last work finishes
 * (decided with the user: finished shipping units, so the plan pushes units to completion). Maximise the tonnes
 * finished by the month's last day, while no order finishes more than `toleranceDays` later than it would if the
 * orders were simply worked in the planner's priority order (decided: the planner ranks, the optimiser respects).
 * It is a resource-constrained scheduling problem with a weighted-number-of-on-time-jobs objective — NP-hard.
 *
 * WHAT WAS WEIGHED (the state of the art for this family):
 *   CP-SAT (constraint programming + SAT + LP, OR-Tools)  the strongest general solver; needs a Python / C++ service.
 *   Time-indexed MILP (HiGHS)                              good bounds, but one variable per unit × machine × day.
 *   Schedule generation + metaheuristic search             what the RCPSP literature's best heuristics are built on:
 *     a fast decoder (serial schedule generation) turns an ORDER of the units into a schedule; search moves in the space
 *     of orders (iterated greedy / large-neighbourhood search: destroy a few positions, re-insert each at its best place).
 * Built here: the third, in plain JavaScript (it runs inside the backend, in seconds, repeatably — a seeded generator),
 * with a relaxation BOUND so the screen can say how far from the best possible the plan may be. The interface
 * (optimise(input) → result) is solver-agnostic: a CP-SAT service can replace the search without touching anything else.
 *
 * THE MODEL (a fluid, day-bucket one — a month plan is not a minute-by-minute roster; the daily roster is):
 *   days        0 … D-1 from the plan's first day; `monthEndDay` = the index of the month's last day.
 *   pools       machine type → minutes available on each day (the sum over the machines IN the plan). A key in
 *               `unlimited` (contractors, work with no machine type) has a daily rate instead of a pool.
 *   unit        { key, orderId, tonnes, earliest (day index: material / earliest start), steps: [{ fn, minutes }] }
 *               steps in the order the work is done. Step j+1 may run alongside step j but never ahead of it: by the
 *               end of a day its share done ≤ step j's (pieces flow from cutting to fit-up as they are cut).
 *   decoder     units are taken in the given order; each takes, day by day from its earliest day, what its steps may
 *               draw from what is left in the pools. Its finish = the day its last step reaches 100 %.
 *   objective   lexicographic: (1) no order beyond its tolerance, (2) tonnes finished in the month, (3) finished
 *               earlier is better (tonne-days), so the weeks are front-loaded and slack is kept at the end.
 */

const EPS = 1e-6;
const DECODE_BUDGET = 9000;

/** A small seeded generator (mulberry32) — the same input gives the same plan. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * THE DECODER: an order of unit indexes → a schedule. Returns { finish[], start[], waits[] (per unit: Map fn → days it
 * wanted minutes the pool did not have), load: Map fn → Float64Array(D) }. `keepAlloc` also returns alloc[u] =
 * [{ step, day, minutes }] (only asked for the final plan — the search does not need it).
 */
/** The input in the decoder's own form (typed arrays, machine types by index) — made once per input. */
const compiled = new WeakMap();
function compile(input) {
  let c = compiled.get(input);
  if (c) return c;
  const fns = Object.keys(input.pools);
  const idx = new Map(fns.map((fn, i) => [fn, i]));
  const base = fns.map((fn) => Float64Array.from(input.pools[fn]));
  const unlimited = input.unlimited ?? {};
  const units = input.units.map((u) => ({
    earliest: Math.max(0, u.earliest ?? 0),
    fi: Int32Array.from(u.steps.map((s) => (unlimited[s.fn] != null ? -1 : idx.has(s.fn) ? idx.get(s.fn) : -2))),
    rate: Float64Array.from(u.steps.map((s) => (unlimited[s.fn] != null ? unlimited[s.fn] : 0))),
    minutes: Float64Array.from(u.steps.map((s) => s.minutes)),
  }));
  c = { fns, base, units };
  compiled.set(input, c);
  return c;
}

/** The search's decoder: finishes only (no bookkeeping), on the compiled input. */
function decodeFast(input, order) {
  const C = compile(input);
  const D = input.days;
  const left = C.base.map((a) => Float64Array.from(a));
  const finish = new Array(input.units.length).fill(D);
  for (const u of order) {
    const unit = C.units[u];
    const S = unit.minutes.length;
    if (!S) { finish[u] = unit.earliest; continue; }
    const done = new Float64Array(S);
    let first = 0;                                 // the first step not yet complete
    for (let d = unit.earliest; d < D; d += 1) {
      let prevShare = 1;
      for (let j = first; j < S; j += 1) {
        const m = unit.minutes[j];
        const want = prevShare * m - done[j];
        if (want > EPS) {
          const f = unit.fi[j];
          let got;
          if (f === -1) got = Math.min(want, unit.rate[j]);
          else if (f < 0) got = 0;
          else { const pool = left[f]; got = Math.min(want, pool[d]); if (got > 0) pool[d] -= got; }
          if (got > EPS) done[j] += got;
        }
        prevShare = m > EPS ? done[j] / m : 1;
        if (j === first && prevShare >= 1 - 1e-9) first += 1;
        if (prevShare <= EPS) break;               // nothing further down can move today
      }
      if (first >= S) { finish[u] = d; break; }
    }
  }
  return finish;
}

export function decode(input, order, { keepAlloc = false } = {}) {
  const D = input.days;
  const left = new Map();
  for (const [fn, arr] of Object.entries(input.pools)) left.set(fn, Float64Array.from(arr));
  const unlimited = input.unlimited ?? {};
  const n = input.units.length;
  const finish = new Array(n).fill(D);         // D = not finished inside the horizon
  const start = new Array(n).fill(-1);
  const waits = keepAlloc ? new Array(n).fill(null) : null;
  const alloc = keepAlloc ? new Array(n).fill(null) : null;
  for (const u of order) {
    const unit = input.units[u];
    const steps = unit.steps;
    const S = steps.length;
    if (!S) { finish[u] = Math.max(0, unit.earliest ?? 0); start[u] = finish[u]; continue; }
    const done = new Float64Array(S);
    const w = keepAlloc ? new Map() : null;
    const a = keepAlloc ? [] : null;
    let d = Math.max(0, unit.earliest ?? 0);
    let finished = false;
    for (; d < D && !finished; d += 1) {
      let prevShare = 1;
      for (let j = 0; j < S; j += 1) {
        const st = steps[j];
        const want = prevShare * st.minutes - done[j];
        if (want > EPS) {
          let got;
          if (unlimited[st.fn] != null) got = Math.min(want, unlimited[st.fn]);
          else {
            const pool = left.get(st.fn);
            const have = pool ? pool[d] : 0;
            got = Math.min(want, have);
            if (pool && got > 0) pool[d] -= got;
            if (w && got < want - EPS) w.set(st.fn, (w.get(st.fn) ?? 0) + 1);
          }
          if (got > EPS) {
            done[j] += got;
            if (start[u] < 0) start[u] = d;
            if (a) a.push({ step: j, day: d, minutes: got });
          }
        }
        prevShare = st.minutes > EPS ? done[j] / st.minutes : 1;
      }
      if (done[S - 1] >= steps[S - 1].minutes - EPS) { finished = true; finish[u] = d; }
    }
    if (keepAlloc) { waits[u] = w; alloc[u] = a; }
  }
  return { finish, start, waits, alloc, left };
}

/** The order of things when the planner's priority alone decides: order rank, then the unit's own place. */
export function priorityOrder(input) {
  return input.units.map((_, i) => i).sort((x, y) => (input.units[x].rank - input.units[y].rank) || (input.units[x].seq - input.units[y].seq) || (x - y));
}

function orderFinishes(input, finish) {
  const out = new Map();
  input.units.forEach((u, i) => { const f = finish[i]; if (!out.has(u.orderId) || out.get(u.orderId) < f) out.set(u.orderId, f); });
  return out;
}

/** The score of a schedule (higher is better) and its parts. */
function score(input, finish, base) {
  const M = input.monthEndDay;
  const tol = input.toleranceDays ?? 0;
  let tonnes = 0; let tonneDays = 0;
  input.units.forEach((u, i) => {
    if (finish[i] <= M) tonnes += u.tonnes;
    tonneDays += u.tonnes * Math.min(finish[i], input.days);
  });
  let over = 0;
  if (base) {
    for (const [oid, f] of orderFinishes(input, finish)) {
      const b = base.get(oid) ?? f;
      // An order the priority plan finished inside the horizon may not slip beyond its tolerance.
      if (b < input.days && f > b + tol) over += f - (b + tol);
    }
  }
  return { tonnes, tonneDays, over, value: (over > 0 ? -1e12 - over * 1e6 : 0) + tonnes * 1e6 - tonneDays };
}

/**
 * A BOUND on the tonnes any plan could finish in the month: for each machine type on its own, fill the month's capacity
 * with the units that need the least of it per tonne (a fractional knapsack — more than any real plan can do); a unit
 * whose material comes after the month, or that needs a type with no capacity at all, cannot count. The least bound wins.
 */
export function upperBound(input) {
  const M = input.monthEndDay;
  const can = input.units.filter((u) => (u.earliest ?? 0) <= M && u.steps.every((s) => input.unlimited?.[s.fn] != null || input.pools[s.fn]));
  const all = can.reduce((t, u) => t + u.tonnes, 0);
  let bound = all; let by = null;
  for (const [fn, arr] of Object.entries(input.pools)) {
    let cap = 0;
    for (let d = 0; d <= M && d < arr.length; d += 1) cap += arr[d];
    const need = can.map((u) => ({ t: u.tonnes, m: u.steps.reduce((s, x) => s + (x.fn === fn ? x.minutes : 0), 0) }));
    let tonnes = need.filter((x) => x.m <= EPS).reduce((t, x) => t + x.t, 0);
    for (const x of need.filter((y) => y.m > EPS).sort((p, q) => (p.m / Math.max(p.t, EPS)) - (q.m / Math.max(q.t, EPS)))) {
      if (cap <= EPS) break;
      const f = Math.min(1, cap / x.m);
      tonnes += x.t * f; cap -= x.m * f;
    }
    if (tonnes < bound - EPS) { bound = tonnes; by = fn; }
  }
  return { tonnes: bound, by };
}

/**
 * optimise(input, { budgetMs, seed }) → the plan.
 * input: { days, monthEndDay, toleranceDays, pools: { fn: [minutes per day] }, unlimited: { fn: minutes a day per unit },
 *          units: [{ key, orderId, rank, seq, tonnes, earliest, steps: [{ fn, minutes }] }] }
 * Iterated greedy over the order of the units: start from the priority order; take a few units out, put each back at the
 * best of a sample of places; keep what is better (and, now and then, what is a little worse — to leave a local best).
 */
export function optimise(input, { iterations: wanted = 400, budgetMs = 20000, seed = 20261113, startOrder = null, decodeBudget = DECODE_BUDGET, minIterations = 30 } = {}) {
  // A fixed number of search rounds (not a time budget) so the same input always gives the same plan; budgetMs only
  // stops a run-away on a very large month.
  let maxIterations = wanted;
  const t0 = Date.now();
  const n = input.units.length;
  const basePerm = priorityOrder(input);
  const baseFin = decodeFast(input, basePerm);
  const baseFinish = orderFinishes(input, baseFin);
  const baseScore = score(input, baseFin, null);
  let best = basePerm.slice();
  let bestScore = score(input, baseFin, baseFinish);
  // A warm start (the order of a plan already found — a what-if, a re-plan): taken when it is better than plain priority.
  if (startOrder && startOrder.length === n) {
    const idx = new Map(input.units.map((u, i) => [u.key, i]));
    const perm = startOrder.map((k) => idx.get(k)).filter((i) => i != null);
    if (perm.length === n) {
      const sc = score(input, decodeFast(input, perm), baseFinish);
      if (sc.value > bestScore.value) { best = perm; bestScore = sc; }
    }
  }
  let cur = best.slice(); let curScore = bestScore;
  const rand = rng(seed);
  let iterations = 0;
  if (n > 2) {
    const k = Math.max(1, Math.min(4, Math.round(n / 12)));
    const sample = Math.min(n, 10);
    // A large month: the rounds are cut so the whole search stays near DECODE_BUDGET schedule builds (seconds, not minutes).
    maxIterations = Math.max(minIterations, Math.min(wanted, Math.round(decodeBudget / ((k * sample + 1) * Math.max(1, n / 300)))));
    while (Date.now() - t0 < budgetMs && iterations < maxIterations) {
      iterations += 1;
      const perm = cur.slice();
      const taken = [];
      for (let i = 0; i < k && perm.length > 1; i += 1) taken.push(perm.splice(Math.floor(rand() * perm.length), 1)[0]);
      for (const u of taken) {
        let bp = 0; let bv = -Infinity;
        const tried = new Set();
        for (let s = 0; s < sample; s += 1) {
          const pos = Math.floor(rand() * (perm.length + 1));
          if (tried.has(pos)) continue;
          tried.add(pos);
          perm.splice(pos, 0, u);
          const v = score(input, decodeFast(input, perm), baseFinish).value;
          perm.splice(pos, 1);
          if (v > bv) { bv = v; bp = pos; }
        }
        perm.splice(bp, 0, u);
      }
      const sc = score(input, decodeFast(input, perm), baseFinish);
      const temp = Math.max(1e-9, (1 - iterations / maxIterations)) * 0.002 * Math.max(1, Math.abs(curScore.value));
      if (sc.value > curScore.value || rand() < Math.exp((sc.value - curScore.value) / temp)) { cur = perm; curScore = sc; }
      if (sc.value > bestScore.value + EPS) { best = perm.slice(); bestScore = sc; }
    }
  }
  const final = decode(input, best, { keepAlloc: true });
  const bound = upperBound(input);
  return shape(input, best, final, bestScore, { baseTonnes: baseScore.tonnes, baseFinish, bound, iterations, ms: Date.now() - t0 });
}

/** The schedule in the words the service stores: per unit, per order, the load, the month's tonnes, why units miss. */
function shape(input, perm, sched, sc, meta) {
  const M = input.monthEndDay;
  const D = input.days;
  const load = {};
  for (const fn of Object.keys(input.pools)) load[fn] = new Array(D).fill(0);
  const units = input.units.map((u, i) => {
    const fin = sched.finish[i];
    const inMonth = fin <= M;
    for (const a of sched.alloc[i] ?? []) {
      const fn = u.steps[a.step].fn;
      if (load[fn]) load[fn][a.day] += a.minutes;
    }
    // Why it is not in the month: its material, or the machine type it waited for most, or simply more work than days.
    let reason = null;
    if (!inMonth) {
      const w = [...(sched.waits[i] ?? new Map())].sort((x, y) => y[1] - x[1])[0];
      if ((u.earliest ?? 0) > M) reason = { kind: 'material', fn: null };
      else if (w && w[1] > 0) reason = { kind: (u.earliest ?? 0) > 0 && (u.earliest ?? 0) > M - 7 ? 'material' : 'capacity', fn: w[0], days: w[1] };
      else reason = { kind: fin >= D ? 'horizon' : 'work', fn: null };
    }
    return {
      key: u.key, orderId: u.orderId, tonnes: u.tonnes, start: sched.start[i] < 0 ? null : sched.start[i], finish: fin >= D ? null : fin, inMonth, reason,
      place: perm.indexOf(i),
      days: summariseAlloc(u, sched.alloc[i] ?? []),
    };
  });
  const orders = [...orderFinishes(input, sched.finish)].map(([orderId, f]) => {
    const mine = units.filter((u) => u.orderId === orderId);
    const b = meta.baseFinish.get(orderId);
    return {
      orderId, finish: f >= D ? null : f, priorityFinish: b == null || b >= D ? null : b,
      tonnes: mine.reduce((t, u) => t + u.tonnes, 0), tonnesInMonth: mine.filter((u) => u.inMonth).reduce((t, u) => t + u.tonnes, 0),
      units: mine.length, unitsInMonth: mine.filter((u) => u.inMonth).length,
    };
  });
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return {
    tonnes: r3(sc.tonnes), priorityTonnes: r3(meta.baseTonnes), boundTonnes: r3(Math.max(meta.bound.tonnes, sc.tonnes)), boundBy: meta.bound.by,
    gapPct: meta.bound.tonnes > EPS ? Math.max(0, Math.round((1 - sc.tonnes / Math.max(meta.bound.tonnes, sc.tonnes)) * 1000) / 10) : 0,
    feasible: sc.over <= 0, iterations: meta.iterations, ms: meta.ms,
    order: perm.map((i) => input.units[i].key),
    units, orders,
    load: Object.fromEntries(Object.entries(load).map(([fn, arr]) => [fn, arr.map((x) => Math.round(x))])),
  };
}

/** A unit's work per step: [{ step, fn, from, to, minutes, byDay: { day: minutes } }]. */
function summariseAlloc(unit, alloc) {
  const by = new Map();
  for (const a of alloc) {
    if (!by.has(a.step)) by.set(a.step, { step: a.step, fn: unit.steps[a.step].fn, from: a.day, to: a.day, minutes: 0, byDay: {} });
    const e = by.get(a.step);
    e.to = Math.max(e.to, a.day); e.from = Math.min(e.from, a.day);
    e.minutes += a.minutes; e.byDay[a.day] = Math.round((e.byDay[a.day] ?? 0) + a.minutes);
  }
  return [...by.values()].map((e) => ({ ...e, minutes: Math.round(e.minutes) }));
}

/**
 * WHAT IF more machines joined: each option = { key, label, add: { fn: [minutes per day] } } is laid over the pools and
 * optimised (a shorter budget each). Returns the options with their tonnes and gain, the best first.
 */
export function whatIf(input, options, { iterations = 120, seed = 7, basePlan = null, decodeBudget = DECODE_BUDGET, minIterations = 30 } = {}) {
  const plan = basePlan ?? optimise(input, { iterations, seed });
  const base = plan.tonnes;
  const out = [];
  for (const o of options) {
    const pools = { ...input.pools };
    for (const [fn, arr] of Object.entries(o.add)) {
      const have = pools[fn] ?? new Array(input.days).fill(0);
      pools[fn] = have.map((x, d) => x + (arr[d] ?? 0));
    }
    const r = optimise({ ...input, pools }, { iterations, seed, startOrder: plan.order, decodeBudget, minIterations });
    out.push({ ...o, add: undefined, tonnes: r.tonnes, gain: Math.round((r.tonnes - base) * 1000) / 1000 });
  }
  return out.sort((a, b) => b.gain - a.gain);
}
