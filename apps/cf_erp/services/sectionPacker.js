/**
 * sectionPacker.js — 1-D cutting stock for section cut pieces (CF_ERP_CUT_FROM_PLAN.md §4.2).
 * PURE: no database, no tenant, no order. Numbers in, bars out.
 *
 *   packBars({
 *     pieces:   [{ id, lengthMm, qty, code? }],           the cut lengths of ONE bar profile
 *     stock:    [{ itemId, lengthMm, value?, code? }],    every catalog stock length of that profile
 *     offcuts:  [{ offcutId, lengthMm }],                 reusable bar offcuts of that profile (free)
 *     settings: { sawKerfMm, endTrimMm, minOffcutMm },
 *     label?:   'ISMB 600'                                 only for the words of a refusal
 *   }) -> {
 *     bars: [{ source: 'catalog'|'offcut', itemId|offcutId, lengthMm,
 *              cuts: [{ id, xMm, lengthMm }], wasteMm, keptOffcutMm }],
 *     cost, wasteMm, keptOffcutMm, barsBought, barsFromOffcuts, method, exact
 *   }
 *
 * THE ARITHMETIC, ONCE. A bar of length L loses `trim` at EACH end (mill ends
 * are not square), and every saw cut between two pieces costs one `kerf`. So n
 * pieces fit when  Σ length + (n − 1)·kerf ≤ L − 2·trim.  Written another way —
 * the way the search uses it — each piece occupies (length + kerf) of a bar
 * whose capacity is (L − 2·trim + kerf). Piece i starts at
 * x = trim + Σ(previous lengths) + (i − 1)·kerf.
 * What is left after the last piece is cut off with one more kerf; that piece
 * runs to the physical end of the bar, L − trim − Σ length − n·kerf long, and is
 * KEPT as a reusable offcut when it is at least `minOffcut`. Everything else of
 * the bar — trims, kerfs, a leftover too short to keep — is waste:
 * waste = L − Σ length − kept.
 *
 * WHAT "BEST" MEANS: the lowest COST (bars bought × their value; an offcut costs
 * nothing, which is what makes reusing one first the right answer, not a rule
 * bolted on), then the least waste, then the fewest bars. A stock length with no
 * price is valued at its length, so a cost is "millimetres of bar bought".
 *
 * HOW: up to EXACT_MAX_PIECES pieces in a profile the search is EXHAUSTIVE over
 * bar assignments (branch and bound, seeded with the best heuristic so it only
 * has to prove or beat it), exact in COST. It has a step budget (NODE_LIMIT,
 * ~0.2 s): with many stock lengths a proof can take longer than that, and then
 * the cheapest plan found so far is kept and `exact` is false — said, not
 * hidden (`method`). Above that size, and as that seed: First-Fit-Decreasing
 * and Best-Fit-Decreasing over every stock length (offcuts packed first, two
 * ways), and a mixed pass that, bar by bar, takes the stock length whose fill
 * costs least per millimetre used; each result then has every bar shrunk to the
 * cheapest stock length that still holds its cuts. The best of all is kept.
 *
 * DETERMINISTIC: no randomness, every list sorted totally (length, then id)
 * before it is walked, ties kept by "first found wins". Same input, same bars.
 */

export const EXACT_MAX_PIECES = 18;
/** The exhaustive search stops here and keeps the best it has (said in `method`). */
export const NODE_LIMIT = 500000;   // ~0.2 s a profile at worst

const EPS = 1e-6;
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const mm = (n) => `${Number(r3(n)).toLocaleString('en-US')} mm`;
const cmpId = (a, b) => {
  const na = Number(a); const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(a).localeCompare(String(b));
};

function refuse(code, message, problems = [message]) {
  const e = new Error(message);
  e.code = code;
  e.problems = problems;
  return e;
}

/**
 * The bar-level numbers for one bar holding `lens` (in cut order).
 * Exported for the sheet import and the tests: ONE place says what kerf and
 * trim do.
 */
export function barLayout(lengthMm, lens, settings) {
  const L = Number(lengthMm);
  const k = Number(settings.sawKerfMm) || 0;
  const t = Number(settings.endTrimMm) || 0;
  const minKeep = Number(settings.minOffcutMm) || 0;
  const xs = [];
  let x = t;
  let sum = 0;
  for (const len of lens) { xs.push(r3(x)); x += Number(len) + k; sum += Number(len); }
  const n = lens.length;
  const needed = sum + Math.max(0, n - 1) * k;      // span from the first cut's start to the last cut's end
  const fits = needed <= L - 2 * t + EPS;
  const leftover = L - t - sum - n * k;              // after the separating cut, to the bar's physical end
  const kept = fits && leftover >= minKeep - EPS && leftover > EPS ? r3(leftover) : 0;
  return {
    fits, xs, partsMm: r3(sum), spanMm: r3(needed), usableMm: r3(L - 2 * t),
    overByMm: fits ? 0 : r3(needed - (L - 2 * t)),
    keptOffcutMm: kept, wasteMm: fits ? r3(L - sum - kept) : 0,
  };
}

/** The packer. Throws (code TOO_LONG / NO_STOCK / INVALID, with `problems`) when it cannot answer. */
export function packBars(input = {}) {
  const settings = {
    sawKerfMm: Number(input.settings?.sawKerfMm ?? 3) || 0,
    endTrimMm: Number(input.settings?.endTrimMm ?? 10) || 0,
    minOffcutMm: Number(input.settings?.minOffcutMm ?? 500) || 0,
  };
  const k = settings.sawKerfMm;
  const t = settings.endTrimMm;
  const label = input.label ? String(input.label) : 'stock';
  const exactMax = input.exactMaxPieces ?? EXACT_MAX_PIECES;
  const nodeLimit = input.nodeLimit ?? NODE_LIMIT;

  // ---- read the input, every problem at once -------------------------------
  const problems = [];
  const units = [];
  for (const p of input.pieces ?? []) {
    const len = Number(p.lengthMm);
    const qty = Number(p.qty ?? 1);
    if (!(len > 0)) { problems.push(`${p.code ?? `Piece ${p.id}`} has no length.`); continue; }
    if (!Number.isInteger(qty) || qty < 0) { problems.push(`${p.code ?? `Piece ${p.id}`}: ${p.qty} is not a whole number of pieces.`); continue; }
    for (let i = 0; i < qty; i++) units.push({ id: p.id, code: p.code ?? null, len, s: len + k });
  }
  const stock = (input.stock ?? [])
    .filter((s) => Number(s.lengthMm) > 0)
    .map((s) => ({ kind: 'catalog', ref: s.itemId, L: Number(s.lengthMm), value: s.value != null && Number(s.value) > 0 ? Number(s.value) : Number(s.lengthMm), cap: Number(s.lengthMm) - 2 * t + k }))
    .sort((a, b) => b.L - a.L || cmpId(a.ref, b.ref));
  const offs = (input.offcuts ?? [])
    .filter((o) => Number(o.lengthMm) > 0)
    .map((o) => ({ kind: 'offcut', ref: o.offcutId, L: Number(o.lengthMm), value: 0, cap: Number(o.lengthMm) - 2 * t + k }))
    .filter((o) => o.cap > k + EPS)
    .sort((a, b) => b.L - a.L || cmpId(a.ref, b.ref));
  if (problems.length) throw refuse('INVALID', problems[0], problems);
  const empty = { bars: [], cost: 0, wasteMm: 0, keptOffcutMm: 0, barsBought: 0, barsFromOffcuts: 0, method: 'nothing to cut', exact: true };
  if (!units.length) return empty;
  if (!stock.length) throw refuse('NO_STOCK', `There is no ${label} stock bar in the catalog to cut these pieces from.`);

  // A piece longer than every catalog bar can give is refused, by name.
  const longest = stock[0];
  const tooLong = [];
  const seen = new Set();
  for (const u of units) {
    if (u.s <= longest.cap + EPS || seen.has(u.id)) continue;
    seen.add(u.id);
    tooLong.push(`${u.code ?? `Piece ${u.id}`} ${mm(u.len)} is longer than any ${label} bar — ${mm(longest.L)} is the longest${t > 0 ? `, ${mm(longest.L - 2 * t)} after the ${mm(t)} trim at each end` : ''}.`);
  }
  if (tooLong.length) throw refuse('TOO_LONG', tooLong.join(' '), tooLong);

  units.sort((a, b) => b.len - a.len || cmpId(a.id, b.id));
  const n = units.length;

  // ---- scoring ---------------------------------------------------------------
  const scoreOf = (bars) => {
    let cost = 0; let waste = 0;
    for (const b of bars) {
      cost += b.value;
      const lay = barLayout(b.L, b.units.map((i) => units[i].len), settings);
      waste += lay.wasteMm;
    }
    return { cost: r3(cost), waste: r3(waste), count: bars.length };
  };
  const better = (a, b) => (b == null)
    || a.cost < b.cost - EPS
    || (Math.abs(a.cost - b.cost) <= EPS && (a.waste < b.waste - EPS
      || (Math.abs(a.waste - b.waste) <= EPS && a.count < b.count)));

  let best = null;        // { bars, score, method }
  const offer = (bars, method) => {
    const score = scoreOf(bars);
    if (!best || better(score, best.score)) best = { bars: bars.map((b) => ({ ...b, units: b.units.slice() })), score, method };
  };

  const newBar = (type) => ({ kind: type.kind, ref: type.ref, L: type.L, value: type.value, cap: type.cap, used: 0, units: [] });
  const room = (b) => b.cap - b.used;

  /** Every catalog bar shrunk to the cheapest stock length that still holds its cuts (ties: less waste). */
  const shrink = (bars) => bars.map((b) => {
    if (b.kind !== 'catalog') return b;
    let pick = null;
    for (const s of stock) {
      if (s.cap + EPS < b.used) continue;
      const cand = { ...b, ref: s.ref, L: s.L, value: s.value, cap: s.cap };
      if (!pick || s.value < pick.value - EPS || (Math.abs(s.value - pick.value) <= EPS && s.L < pick.L)) pick = cand;
    }
    return pick ?? b;
  });

  /** Greedy fill of one bar from what is left (largest first). Returns unit indexes. */
  const fillOne = (left, cap) => {
    const taken = [];
    let used = 0;
    for (const i of left) if (used + units[i].s <= cap + EPS) { taken.push(i); used += units[i].s; }
    return { taken, used };
  };

  // ---- heuristics --------------------------------------------------------------
  /** FFD / BFD with new bars of one stock type; offcuts prefilled or used on demand. */
  const fitDecreasing = (type, bestFit, offcutMode) => {
    const bars = [];
    const freeOffs = offs.slice();
    const left = [];
    if (offcutMode === 'prefill') {
      let rest = units.map((_, i) => i);
      for (const o of freeOffs) {
        const f = fillOne(rest, o.cap);
        if (!f.taken.length) continue;
        const b = newBar(o); b.units = f.taken; b.used = f.used; bars.push(b);
        const took = new Set(f.taken);
        rest = rest.filter((i) => !took.has(i));
      }
      left.push(...rest);
      freeOffs.length = 0;
    } else left.push(...units.map((_, i) => i));
    for (const i of left) {
      const s = units[i].s;
      let at = -1;
      for (let j = 0; j < bars.length; j++) {
        if (room(bars[j]) + EPS < s) continue;
        if (!bestFit) { at = j; break; }
        if (at < 0 || room(bars[j]) < room(bars[at]) - EPS) at = j;
      }
      if (at < 0) {
        // On demand: the smallest free offcut that takes it (best fit), else a new bar.
        let o = -1;
        for (let j = 0; j < freeOffs.length; j++) if (freeOffs[j].cap + EPS >= s && (o < 0 || freeOffs[j].cap < freeOffs[o].cap)) o = j;
        if (o >= 0) { bars.push(newBar(freeOffs[o])); freeOffs.splice(o, 1); } else {
          if (type.cap + EPS < s) return null;      // this stock length cannot take the piece at all
          bars.push(newBar(type));
        }
        at = bars.length - 1;
      }
      bars[at].units.push(i); bars[at].used += s;
    }
    return bars;
  };

  /**
   * The fullest one bar of capacity `cap` can be from what is left: a bounded
   * subset sum over the distinct lengths, in whole millimetres (sizes rounded
   * UP, the capacity DOWN, so a fill it finds always fits). `first` forces the
   * longest piece left onto the bar, so long pieces are not left to last.
   * Falls back to the greedy fill when the table would be too big.
   */
  const bestFill = (left, cap, first) => {
    if (!left.length) return { taken: [], used: 0 };
    const lens = [];                                  // distinct sizes, each with its unit indexes
    const at = new Map();
    for (const i of left) {
      const sz = Math.ceil(units[i].s - EPS);
      if (!at.has(sz)) { at.set(sz, lens.length); lens.push({ sz, idx: [] }); }
      lens[at.get(sz)].idx.push(i);
    }
    let C = Math.floor(cap + EPS);
    const forced = [];
    if (first) {
      const head = lens[at.get(Math.ceil(units[left[0]].s - EPS))];
      if (head.sz > C) return { taken: [], used: 0 };
      forced.push(head.idx[0]);
      C -= head.sz;
      head.skip = 1;
    }
    if (C <= 0 || C * lens.length > 4e6) {
      const f = fillOne(left.filter((i) => !forced.includes(i)), C);
      return { taken: [...forced, ...f.taken], used: forced.reduce((a, i) => a + units[i].s, 0) + f.used };
    }
    const reach = new Uint8Array(C + 1); const cnt = new Uint16Array(C + 1); const from = new Int32Array(C + 1).fill(-1);
    reach[0] = 1;
    let bestX = 0;
    for (let d = 0; d < lens.length; d++) {
      const { sz } = lens[d];
      const avail = lens[d].idx.length - (lens[d].skip ?? 0);
      if (avail <= 0 || sz > C) continue;
      cnt.fill(0);
      for (let x = sz; x <= C; x++) {
        if (reach[x] || !reach[x - sz] || cnt[x - sz] >= avail) continue;
        reach[x] = 1; cnt[x] = cnt[x - sz] + 1; from[x] = d;
        if (x > bestX) bestX = x;
      }
    }
    const taken = [...forced];
    const usedOf = new Array(lens.length).fill(0);
    for (let x = bestX; x > 0;) {
      const d = from[x];
      const L = lens[d];
      taken.push(L.idx[(L.skip ?? 0) + usedOf[d]]);
      usedOf[d] += 1;
      x -= L.sz;
    }
    return { taken, used: taken.reduce((a, i) => a + units[i].s, 0) };
  };

  /** Bar by bar: whichever bar's fill costs least per millimetre of pieces on it. */
  const mixed = (fill) => {
    let left = units.map((_, i) => i);
    const freeOffs = offs.slice();
    const bars = [];
    while (left.length) {
      let pick = null;
      const consider = (type, offIndex) => {
        const f = fill(left, type.cap);
        if (!f.taken.length) return;
        const parts = f.taken.reduce((a, i) => a + units[i].len, 0);
        const per = type.value / parts;
        const waste = type.L - parts;
        if (!pick || per < pick.per - EPS || (Math.abs(per - pick.per) <= EPS && waste < pick.waste - EPS)) pick = { type, offIndex, f, per, waste };
      };
      freeOffs.forEach((o, j) => consider(o, j));
      for (const s of stock) consider(s, -1);
      if (!pick) return null;
      const b = newBar(pick.type); b.units = pick.f.taken; b.used = pick.f.used; bars.push(b);
      if (pick.offIndex >= 0) freeOffs.splice(pick.offIndex, 1);
      const took = new Set(pick.f.taken);
      left = left.filter((i) => !took.has(i));
    }
    return bars;
  };

  for (const type of stock) {
    for (const bestFit of [false, true]) {
      for (const mode of ['prefill', 'demand']) {
        const bars = fitDecreasing(type, bestFit, mode);
        if (bars) offer(shrink(bars), `${bestFit ? 'best' : 'first'}-fit decreasing`);
      }
    }
  }
  for (const [fill, name] of [
    [fillOne, 'mixed lengths'],
    [(left, cap) => bestFill(left, cap, false), 'mixed lengths, fullest bar'],
    [(left, cap) => bestFill(left, cap, true), 'mixed lengths, longest piece first'],
  ]) {
    const mix = mixed(fill);
    if (mix) offer(shrink(mix), name);
  }

  // ---- exact, for a small profile -------------------------------------------------
  let exact = false;
  let method = best.method;
  if (n <= exactMax) {
    // Over GROUPS rather than typed bars: a catalog group is not told its stock
    // length while it fills — its cost is always the cheapest length that holds
    // what is on it so far (never less as it grows), and it becomes that bar at
    // the end. That takes the stock-length branching out of the tree entirely.
    // Each free offcut is a group of its own from the start, costing nothing.
    const sufS = new Array(n + 1).fill(0);
    for (let i = n - 1; i >= 0; i--) sufS[i] = sufS[i + 1] + units[i].s;
    const minPerCap = Math.min(...stock.map((s) => s.value / s.cap));
    const maxCap = longest.cap;
    const byCap = stock.slice().sort((a, b) => a.value - b.value || a.L - b.L || cmpId(a.ref, b.ref));
    const typeFor = (used) => byCap.find((s) => s.cap + EPS >= used) ?? null;
    const groups = offs.map((o) => ({ ...newBar(o) }));
    const barOf = new Array(n).fill(-1);
    let cost = 0;
    let nodes = 0;
    let cut = false;
    const gRoom = (g) => (g.kind === 'catalog' ? maxCap : g.cap) - g.used;
    // cover[x]: the least a set of new bars can cost that gives x mm of capacity
    // (whole bars — a far tighter bound than a price per millimetre).
    const top = Math.ceil(sufS[0]) + 1;
    const cover = new Float64Array(top + 1);
    for (let x = 1; x <= top; x++) {
      let b = Infinity;
      for (const s of stock) { const v = s.value + cover[Math.max(0, x - Math.floor(s.cap + EPS))]; if (v < b) b = v; }
      cover[x] = b;
    }
    void minPerCap;
    const bound = (i) => {
      let free = 0;
      for (const g of groups) free += gRoom(g);
      const need = sufS[i] - free;
      return cost + (need > EPS ? cover[Math.min(top, Math.ceil(need - EPS))] : 0);
    };
    const leaf = () => offer(groups.filter((g) => g.units.length).map((g) => {
      if (g.kind !== 'catalog') return g;
      const s = typeFor(g.used);
      return { ...g, ref: s.ref, L: s.L, value: s.value, cap: s.cap };
    }), 'exact');
    const walk = (i) => {
      if (cut) return;
      if (++nodes > nodeLimit) { cut = true; return; }
      if (i === n) { leaf(); return; }
      // Only a strictly CHEAPER plan can still win on cost; equally cheap ones
      // are not chased (the heuristics already offered the least-waste ones).
      if (bound(i) >= best.score.cost - EPS) return;
      const u = units[i];
      // Identical pieces go into groups in order (a group never before its twin's).
      const from = i > 0 && units[i - 1].len === u.len && units[i - 1].id === u.id ? barOf[i - 1] : 0;
      const tried = new Set();
      for (let j = Math.max(0, from); j < groups.length; j++) {
        const g = groups[j];
        if (gRoom(g) + EPS < u.s) continue;
        const key = `${g.kind}|${g.kind === 'catalog' ? '' : g.L}|${r3(g.used)}`;
        if (tried.has(key)) continue;                 // an equal group was just tried
        tried.add(key);
        const was = g.kind === 'catalog' ? typeFor(g.used).value : 0;
        g.units.push(i); g.used += u.s; barOf[i] = j;
        const now = g.kind === 'catalog' ? typeFor(g.used).value : 0;
        cost += now - was;
        walk(i + 1);
        cost -= now - was;
        g.units.pop(); g.used -= u.s;
        if (cut) return;
      }
      // A new catalog group.
      const s = typeFor(u.s);
      groups.push({ kind: 'catalog', ref: null, L: null, value: 0, cap: maxCap, used: u.s, units: [i] });
      barOf[i] = groups.length - 1;
      cost += s.value;
      walk(i + 1);
      cost -= s.value;
      groups.pop();
    };
    walk(0);
    exact = !cut;
    method = cut ? `${best.method === 'exact' ? 'exact search' : best.method} (exact search stopped at ${nodeLimit.toLocaleString('en-US')} steps)` : 'exact';
  }

  // ---- shape the answer ------------------------------------------------------------
  const out = best.bars.map((b) => {
    const idx = b.units.slice().sort((x, y) => units[y].len - units[x].len || cmpId(units[x].id, units[y].id));
    const lay = barLayout(b.L, idx.map((i) => units[i].len), settings);
    return {
      source: b.kind,
      ...(b.kind === 'catalog' ? { itemId: b.ref } : { offcutId: b.ref }),
      lengthMm: r3(b.L),
      cuts: idx.map((i, j) => ({ id: units[i].id, xMm: lay.xs[j], lengthMm: r3(units[i].len) })),
      wasteMm: lay.wasteMm,
      keptOffcutMm: lay.keptOffcutMm,
      _value: b.value,
    };
  }).sort((a, b) => (a.source === b.source ? 0 : a.source === 'offcut' ? -1 : 1)
    || (a.source === 'offcut' ? cmpId(a.offcutId, b.offcutId) : 0)
    || b.lengthMm - a.lengthMm
    || (b.lengthMm - b.wasteMm - b.keptOffcutMm) - (a.lengthMm - a.wasteMm - a.keptOffcutMm)
    || cmpId(a.cuts[0]?.id, b.cuts[0]?.id));
  const bought = out.filter((b) => b.source === 'catalog');
  const result = {
    bars: out.map(({ _value, ...b }) => b),
    cost: r3(bought.reduce((a, b) => a + b._value, 0)),
    wasteMm: r3(out.reduce((a, b) => a + b.wasteMm, 0)),
    keptOffcutMm: r3(out.reduce((a, b) => a + b.keptOffcutMm, 0)),
    barsBought: bought.length,
    barsFromOffcuts: out.length - bought.length,
    method,
    exact,
  };
  return result;
}
