/**
 * nestingPacker.js — CF_ERP. Lay parts onto plates the way PFPL's CNC cuts them.
 *
 * ── THE BOUNDARY ────────────────────────────────────────────────────────────
 * PURE GEOMETRY. No database, no tenant, no order, nothing imported from
 * `services/` or `db.js`. Kerf arrives as a number (or a thickness plus the
 * published table). This is why the thing can be tested at all:
 * `scripts/cf_kepl/packer_test.mjs` runs it with made-up numbers and no
 * connection.
 *
 * ── THE SHAPE OF A PLAN: PLATE -> SEQUENCE -> ROW -> PART ───────────────────
 * This is NOT a free-form nest and NOT a general guillotine nest. PFPL's rules
 * (v1) describe a structured shelf layout, and the structure is not cosmetic:
 *
 *   ROW       one strip of parts laid side by side along the plate's length.
 *   SEQUENCE  a fixed number of rows. 2 rows if the parts are Small (under
 *             200 mm in BOTH dimensions), 3 rows if Big.
 *   ORDER     sequence 1 is cut in full, then sequence 2, then 3. That is the
 *             point of a sequence: it controls PIERCE ORDER. One continuous
 *             plan lets the head pierce anywhere and a part can shift mid-cut,
 *             so the order is a real output and the gap between sequences
 *             (5–8 mm) is a real clearance, not a kerf.
 *
 * Because the layout is this structured, the search space is small. There is
 * no maximal-rectangles filler here and no long ruin-and-recreate over free
 * rectangles: the decisions that are actually open are which parts share a
 * row, how tall each row is, which plate size to buy, and which parts share a
 * cut. Those are what the search spends its time on.
 *
 * ── KERF: AN ALLOWANCE PER SIDE, AND THE RIM IS CUT TOO ─────────────────────
 * Note 1 on PFPL's sheet: "3 mm on left and right boundaries mean the edge of
 * the RM plate also needs to be cut." The outer boundary IS cut and DOES
 * consume kerf. So kerf is not a gap that cancels at the rim — it is an
 * allowance charged on every side that gets cut:
 *
 *   rim                         k
 *   two parts, separate cuts    2k   (k for each part's own edge)
 *   two parts, COMMON BOUNDARY  k    (one cut serves both)
 *
 * Three 100 mm parts on 16 mm plate (k = 3):
 *   common     3 + 100 + 3 + 100 + 3 + 100 + 3 = 312
 *   separate   3 + 100 + 6 + 100 + 6 + 100 + 3 = 318
 * and one part on its own "nests as 103 x 103" — the pitch, part + k.
 *
 * WHICH ADJACENCIES SHARE A BOUNDARY IS A DECISION THE PACKER MAKES, and it is
 * where the gain lives now. Parts need not be identical to share a side, but
 * the shared side must be a real full edge, so:
 *   - two parts side by side in a row share their vertical cut when their
 *     footprint HEIGHTS are equal;
 *   - two stacked rows share their horizontal cut when both are flush (every
 *     part in each reaches its row height), because then one straight cut
 *     serves the tops of one row and the bottoms of the next.
 * The row builder therefore prefers rows of one height — which is both the
 * cheapest layout and the one a nester draws.
 *
 * ── WHAT SURVIVED THE REWRITE ───────────────────────────────────────────────
 * Quantity conservation (an Int32Array indexed by demand ROW, asserted before
 * any answer is returned), a deterministic floor that more effort can only
 * improve on, scoring on AREA BOUGHT rather than utilisation, an explicit sort
 * of the candidate plates, and yielding the event loop. Those were each a bug
 * somebody shipped and none of them is about free rectangles.
 */

/** Geometric tolerance, millimetres. Tight: a 12001 part must NOT fit 12000. */
const EPS = 1e-6;

/*
 * There is deliberately NO kerf table here. Kerf is a fact about the shop, not
 * about geometry, and it belongs to ONE owner: cf_cut_settings, resolved by
 * nestingService.resolveCutSettings and handed in as a number. A copy kept here
 * would be read by nothing and drift — which is exactly how the other app ended
 * up nesting at 2 mm while recording its offcuts at 4.
 */

/** Clearance between sequences, mm. PFPL quote 5–8; 6 is the working default. */
export const SEQUENCE_GAP = Object.freeze({ min: 5, max: 8, default: 6 });

/** Under this in BOTH dimensions a part is Small. Small -> 2 rows, Big -> 3. */
const SMALL_THRESHOLD_MM = 200;
const ROWS_PER_SEQUENCE = Object.freeze({ small: 2, big: 3 });

/**
 * A plate is ORDERED bigger than the layout strictly needs: mill edges are not
 * straight and a standard size procures faster. Applied by `sizeAdvice`.
 */
export const ORDER_MARGIN = Object.freeze({ lengthMm: 100, widthMm: 50, stepMm: 50 });

/**
 * How hard to look.
 *
 * `capMs` only TRUNCATES. The stopping rule is the iteration count, because a
 * wall-clock stopping rule makes the answer depend on how loaded the box was,
 * which is not a reproducible answer. `deterministic` in the result says which
 * of the two ended the search.
 *
 * The ladder is short on purpose. The old one assumed a free-rectangle search
 * space that this layout does not have: a shelf plan of a few dozen rows is
 * mostly decided by the row builder, and the only thing left worth minutes is
 * re-deciding which plate each part lands on.
 */
export const EFFORT = Object.freeze({
  quick: { label: 'Quick', restarts: 0, repairs: 0, capMs: 1_500 },
  standard: { label: 'Standard', restarts: 64, repairs: 60, seeds: 8, capMs: 300_000 },
  deep: { label: 'Deep', restarts: 64, repairs: 400, seeds: 8, capMs: 600_000 },
});

/**
 * RESTARTS ARE THE HALF THAT PAYS, AND THIS LADDER IS SET FROM MEASUREMENT.
 *
 * Measured on the real KEPL line (2,116 pieces, 6 steel groups, 652 t), with
 * repairs held at 60 and the search given room not to be truncated:
 *
 *   restarts   steel bought   plates
 *      3        651.863 t      107     <- what this used to be
 *      8        651.158 t      106     <- the knee: 705 kg for five more trials
 *     16        651.158 t      106        identical, not one gram
 *     32        651.124 t      105        a further 34 kg
 *     64        651.266 t      105     <- WORSE, and worth understanding
 *
 * Restarts EXPLORE — a different starting arrangement. Repairs EXPLOIT — tear
 * up the emptiest plates of the answer you have and rebuild them. This layout
 * is decided mostly by where the search starts, so exploring beats exploiting:
 * 3 restarts with deep repairs bought 338 kg, while 8 restarts with ordinary
 * repairs bought 705 kg in less time.
 *
 * WHY 64 CAME OUT WORSE THAN 32, which a superset of trials should not be able
 * to do: the DEADLINE truncated it. Restarts run before repairs, so enough of
 * them eat the budget the repairs needed and the run stops early. "More effort
 * is never worse" holds only while a run is NOT capped — `capped` in the result
 * says which happened, and capMs is raised here so the ladder is not silently
 * cut off. Turning restarts up without turning the budget up buys nothing and
 * can cost.
 *
 * capMs is per STEEL GROUP and is set so the biggest real order finishes:
 *   cap 20s -> 651.533 t, one group capped
 *   cap 45s -> 651.158 t, one group capped
 *   cap 60s -> 651.158 t, NONE capped   <- standard
 * A capped run quietly throws away the restarts it was told to make, and the
 * only sign is `deterministic: false` in the result. Budget it from the knee,
 * do not guess it.
 *
 * Trial i is seeded from (seed, i) alone, so a shallower run's restarts are a
 * PREFIX of a deeper one's and best-of-N stays monotone. That is what keeps
 * the guarantee true by construction rather than by hoping the RNG is kind.
 */
const RESTARTS = 8;

/** Benchmark/override hook: how many seeded restarts this run may use. */
const restartsFor = (level, opts) => {
  const n = Number(opts?.restarts);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : (level.restarts ?? RESTARTS);
};

/** Steps between breaths in `nestAsync`. Small enough to stay answerable. */
const BREATHE_EVERY = 64;

/** Hard stop on plates opened, so a pathological input cannot run forever. */
const DEFAULT_MAX_NESTS = 5000;

/**
 * Demand rows considered by one row-knapsack. Bounds the DP table — and the DP
 * is the hot spot of the whole packer, so this is a real dial and not a guard.
 * Anything left out of one row is picked up by the next.
 */
const MAX_ROW_ITEMS = 12;

/** Candidate row heights tried per row. Each one costs a knapsack. */
const HEIGHTS_TRIED = 3;

/* ────────────────────────────── randomness ─────────────────────────────── */

/** Seeded PRNG, so a run is reproducible and a good answer can be got back. */
export function mulberry32(a) {
  let s = a | 0;
  return function next() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The RNG for trial `i` depends ONLY on (seed, i) — never on the clock, never
 * on how many trials happened to run. That is what makes trial i of a deep run
 * identical to trial i of a standard run.
 */
export const rngFor = (seed, i) => mulberry32(
  (Math.imul(seed ^ 0x9E3779B9, 0x85EBCA6B) ^ Math.imul(i + 0x165667B1, 0xC2B2AE35)) | 0,
);

/* ─────────────────────────── input normalisation ───────────────────────── */

const GRAIN = { any: 'any', length: 'length', width: 'width', along_length: 'length', along_width: 'width' };

/**
 * `grain` fixes the part's orientation against the plate's length axis.
 *   'any'     free rotation (the default)
 *   'length'  the part's LENGTH runs along the plate's length — never turned
 *   'width'   the part's WIDTH runs along the plate's length — always turned
 */
const mayKeep = (row) => row.grain !== 'width';
const mayTurn = (row) => row.grain !== 'length';

/** The ways one part may sit in a row: `fl` along the row, `fh` across it. */
function orientationsOf(row) {
  const out = [];
  if (mayKeep(row)) out.push({ fl: row.length, fh: row.width, rotated: false });
  if (mayTurn(row)) out.push({ fl: row.width, fh: row.length, rotated: true });
  return out;
}

function normalisePieces(pieces, smallThreshold) {
  if (!Array.isArray(pieces)) throw new TypeError('nest: `pieces` must be an array');
  const out = [];
  pieces.forEach((p, n) => {
    if (!p || typeof p !== 'object') throw new TypeError(`nest: pieces[${n}] is not an object`);
    const length = Number(p.length);
    const width = Number(p.width);
    const qty = Math.trunc(Number(p.qty ?? 1));
    if (!(length > 0) || !(width > 0)) {
      throw new TypeError(`nest: pieces[${n}] (${p.key}) needs a positive length and width`);
    }
    if (!(qty >= 0)) throw new TypeError(`nest: pieces[${n}] (${p.key}) has a bad qty`);
    if (qty === 0) return;
    const grain = GRAIN[p.grain ?? 'any'];
    if (!grain) throw new TypeError(`nest: pieces[${n}] grain '${p.grain}' is not length|width|any`);
    out.push({
      idx: out.length,
      key: p.key ?? `row${n}`,
      length,
      width,
      qty,
      grain,
      area: length * width,
      // Small in BOTH dimensions, on the FINISHED size — the classification
      // decides how many rows a sequence holds, so it must not depend on which
      // way round the part happens to get laid.
      cls: (length < smallThreshold && width < smallThreshold) ? 'small' : 'big',
    });
  });
  return out;
}

/**
 * ONE PLATE COSTS THIS MUCH AREA. The objective is steel BOUGHT, and an offcut
 * already on the shelf has been bought — it costs nothing to use and everything
 * to leave rusting. `areaCost` lets a caller price a size directly.
 */
const costOf = (s) => (s.areaCost != null ? s.areaCost : (s.preferred ? 0 : s.length * s.width));

/**
 * SORT THE CANDIDATE PLATES EXPLICITLY.
 *
 * The greedy loop walks this list, and a database returns rows in whatever
 * order it likes — 130 plates got packed two different ways from the same seed
 * before somebody sorted. The order below is total: no two distinct plates
 * compare equal, because `key` breaks every remaining tie.
 */
function normaliseSheets(sheets) {
  if (!Array.isArray(sheets)) throw new TypeError('nest: `sheets` must be an array');
  const out = sheets.map((s, n) => {
    const length = Number(s.length);
    const width = Number(s.width);
    if (!(length > 0) || !(width > 0)) {
      throw new TypeError(`nest: sheets[${n}] (${s.key}) needs a positive length and width`);
    }
    const available = s.available == null ? null : Math.trunc(Number(s.available));
    if (available != null && !(available >= 0)) throw new TypeError(`nest: sheets[${n}] has a bad available`);
    return {
      key: s.key ?? `sheet${n}`,
      length,
      width,
      available,
      preferred: !!s.preferred,
      areaCost: s.areaCost == null ? null : Number(s.areaCost),
      area: length * width,
      _i: 0,
    };
  }).filter((s) => s.available == null || s.available > 0);

  out.sort((a, b) => (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0)
    || costOf(a) - costOf(b)
    || a.area - b.area
    || a.length - b.length
    || a.width - b.width
    || String(a.key).localeCompare(String(b.key)));
  out.forEach((s, i) => { s._i = i; });
  return out;
}

/* ─────────────────────────── the kerf arithmetic ───────────────────────── */
/*
 * Everything below works in REAL millimetres on the plate. There is no inflate-
 * and-cancel trick any more, because the rim is cut: the allowance is charged
 * explicitly at each boundary, which is the only way a shared cut can cost half
 * of an unshared one.
 *
 *   along a row      k + p1 + [k or 2k] + p2 + ... + pn + k   <= usable length
 *   across the plate k + h1 + [k or 2k or seqGap] + h2 + ...  <= usable width
 *
 * Reading the first line as a budget: each part reserves (p + k) and the row
 * reserves one more k for the far rim, so a knapsack capacity of (L - k) with
 * item lengths (p + k) is the ALL-SHARED case, and every unshared adjacency
 * adds one more k on top. The builder solves the knapsack optimistically and
 * then pays for the adjacencies it actually ended up with.
 */

const sharedInRow = (a, b, cfg) => cfg.commonBoundary && Math.abs(a.fh - b.fh) <= EPS;

/* ──────────────────────────── building one row ─────────────────────────── */

/**
 * Fill one row of height at most `hMax`, along a usable length of `capLen`.
 *
 * `strict` keeps the row to ONE footprint height, which makes every adjacency
 * in it a shared cut and makes the row flush so the next row can share its
 * horizontal cut too. `strict:false` lets shorter parts in, pays an extra k at
 * each change of height, and wastes the difference above them — sometimes worth
 * it on a tail, usually not. Both are tried and the better kept.
 *
 * The mix along the row is a bounded 1-D knapsack and is solved EXACTLY. That
 * is the decision greedy gets wrong: four 2995 parts plus one 1260 fills 12000
 * to within 20 mm, and "longest first" never finds it.
 */
function buildRow(capLen, hMax, rem, demand, cfg, strict, cache) {
  const k = cfg.kerf;
  const capInt = Math.floor(capLen + EPS);
  if (capInt < 1) return null;

  const pool = [];
  for (let i = 0; i < demand.length; i += 1) if (rem[i] > 0) pool.push(i);
  pool.sort((a, b) => (demand[b].area * rem[b]) - (demand[a].area * rem[a]) || a - b);

  // The height of a strict row is fixed by its tallest candidate; pick the
  // orientation that matches `hMax` exactly, or the tallest that fits.
  const chosen = [];
  for (const i of pool) {
    let best = null;
    for (const o of orientationsOf(demand[i])) {
      if (o.fh > hMax + EPS) continue;
      if (strict && Math.abs(o.fh - hMax) > EPS) continue;
      if (o.fl + k > capInt + EPS) continue;
      // Least wasted row height; a shorter footprint breaks the tie.
      if (!best || o.fh > best.fh + EPS || (Math.abs(o.fh - best.fh) <= EPS && o.fl < best.fl)) best = o;
    }
    if (best) chosen.push({ i, o: best });
    if (chosen.length >= MAX_ROW_ITEMS) break;
  }
  if (!chosen.length) return null;

  const key = cache
    ? `${capInt}|${Math.round(hMax * 1000)}|${strict ? 1 : 0}|${chosen.map((c) => `${c.i}:${rem[c.i]}`).join(',')}`
    : null;
  if (key) { const hit = cache.get(key); if (hit !== undefined) return hit ? cloneRow(hit) : null; }

  const types = [];
  for (const c of chosen) {
    const pitch = Math.ceil(c.o.fl + k - EPS);
    const maxN = Math.min(rem[c.i], Math.floor(capInt / pitch));
    if (maxN > 0) types.push({ i: c.i, o: c.o, pitch, maxN, value: demand[c.i].area });
  }
  if (!types.length) { if (key) cache.set(key, null); return null; }

  /*
   * THE KNAPSACK, AND WHY IT HAS THREE ARMS.
   *
   * This is the hot spot: a plate is twenty rows, a commit tries every
   * candidate plate, and a build commits a hundred plates. A strict row usually
   * admits ONE part size (that is what "strict" means — one footprint height),
   * and a closed form is several thousand times cheaper than a DP over twelve
   * thousand millimetres. Two sizes is one short loop. Only a mixed row pays
   * for the general case, and only mixed rows need it.
   *
   * All three arms return the SAME answer as the DP would. The mix is what
   * matters and greedy gets it wrong on a tail: four 2995 parts plus one 1260
   * fills 12000 to within 20 mm, and "longest first" never finds that.
   */
  const counts = new Map();
  if (types.length === 1) {
    const t = types[0];
    counts.set(t.i, { i: t.i, o: t.o, n: t.maxN });
  } else if (types.length === 2) {
    const [a, b] = types;
    let bestVal = -1; let bestA = 0; let bestB = 0;
    for (let na = a.maxN; na >= 0; na -= 1) {
      const nb = Math.min(b.maxN, Math.floor((capInt - na * a.pitch) / b.pitch));
      const val = na * a.value + nb * b.value;
      if (val > bestVal + EPS) { bestVal = val; bestA = na; bestB = nb; }
    }
    if (bestA > 0) counts.set(a.i, { i: a.i, o: a.o, n: bestA });
    if (bestB > 0) counts.set(b.i, { i: b.i, o: b.o, n: bestB });
  } else {
    // Bounded knapsack, binary-split so a count becomes a handful of 0/1 items.
    // The subsets of a binary split can never total more than the count, which
    // is one of the two places quantity could silently inflate.
    const items = [];
    for (const t of types) {
      let leftN = t.maxN;
      for (let b = 1; leftN > 0; b *= 2) {
        const take = Math.min(b, leftN);
        items.push({ i: t.i, o: t.o, n: take, len: t.pitch * take, value: take * t.value });
        leftN -= take;
      }
    }
    const dp = new Float64Array(capInt + 1);
    const took = new Uint8Array(items.length * (capInt + 1));
    for (let t = 0; t < items.length; t += 1) {
      const it = items[t];
      const base = t * (capInt + 1);
      for (let len = capInt; len >= it.len; len -= 1) {
        const cand = dp[len - it.len] + it.value;
        if (cand > dp[len] + EPS) { dp[len] = cand; took[base + len] = 1; }
      }
    }
    let at = capInt;
    for (let t = items.length - 1; t >= 0; t -= 1) {
      if (!took[t * (capInt + 1) + at]) continue;
      const it = items[t];
      const hit = counts.get(it.i);
      if (hit) hit.n += it.n; else counts.set(it.i, { i: it.i, o: it.o, n: it.n });
      at -= it.len;
    }
  }
  if (!counts.size) { if (key) cache.set(key, null); return null; }

  /*
   * NOW PAY FOR THE ADJACENCIES. Sorted by footprint height, equal heights end
   * up next to each other, so every boundary inside a height group is one cut
   * and only the changes of height cost two. A strict row has one group and
   * therefore no extra at all.
   */
  const laid = [];
  for (const c of counts.values()) for (let n = 0; n < c.n; n += 1) laid.push(c);
  laid.sort((a, b) => b.o.fh - a.o.fh || b.o.fl - a.o.fl || a.i - b.i);

  const parts = [];
  let cx = k;
  // Counts of ADJACENCIES only. The rim is cut too, but it is not a choice —
  // counting it as a shared cut made a run with sharing turned off report 53
  // shared cuts it had not made.
  let commonCuts = 0;
  let separateCuts = 0;
  for (let n = 0; n < laid.length; n += 1) {
    const c = laid[n];
    if (n > 0) {
      const share = sharedInRow(c.o, laid[n - 1].o, cfg);
      cx += share ? k : 2 * k;
      if (share) commonCuts += 1; else separateCuts += 1;
    }
    parts.push({ idx: c.i, dx: cx, fl: c.o.fl, fh: c.o.fh, rotated: c.o.rotated });
    cx += c.o.fl;
  }
  // Trim from the right until the far rim cut fits. Only an unshared-heavy
  // mixed row ever needs this, because the knapsack priced every boundary as
  // shared; dropping the last part can only shorten the row.
  while (parts.length && cx + k > capLen + k + EPS) {
    parts.pop();
    cx = k;
    commonCuts = 0; separateCuts = 0;
    for (let n = 0; n < parts.length; n += 1) {
      if (n > 0) {
        const share = sharedInRow(parts[n], parts[n - 1], cfg);
        cx += share ? k : 2 * k;
        if (share) commonCuts += 1; else separateCuts += 1;
      }
      parts[n].dx = cx;
      cx += parts[n].fl;
    }
  }
  if (!parts.length) { if (key) cache.set(key, null); return null; }

  let h = 0; let area = 0; let cls = 'small'; let uniform = true;
  for (const p of parts) {
    h = Math.max(h, p.fh);
    area += demand[p.idx].area;
    if (demand[p.idx].cls === 'big') cls = 'big';
  }
  for (const p of parts) if (Math.abs(p.fh - h) > EPS) { uniform = false; break; }

  const row = {
    parts, h, area, cls, uniform, usedLen: cx + k, commonCuts, separateCuts, strict,
  };
  if (key) { if (cache.size > 600) cache.clear(); cache.set(key, row); return cloneRow(row); }
  return row;
}

const cloneRow = (r) => ({ ...r, parts: r.parts.map((p) => ({ ...p })) });

/* ─────────────────────── packing one plate, row by row ─────────────────── */

const rowsPerSeq = (cls, cfg) => cfg.rowsPerSequence[cls] ?? ROWS_PER_SEQUENCE[cls];

/** Where the next row starts, and whether it opens a new sequence. */
function planRow(st, row, cfg) {
  if (!st.rows.length) return { newSeq: true, advance: 0 };
  const seq = st.seq;
  const newSeq = !seq || seq.cls !== row.cls || seq.count >= rowsPerSeq(seq.cls, cfg);
  if (newSeq) return { newSeq: true, advance: cfg.sequenceGap };
  const prev = st.rows[st.rows.length - 1];
  // One straight cut serves the tops of the row below and the bottoms of this
  // one only if both are flush; otherwise each pays for its own edge.
  const share = cfg.commonBoundary && prev.uniform && row.uniform;
  return { newSeq: false, advance: share ? cfg.kerf : 2 * cfg.kerf, shared: share };
}

/**
 * Pick the best row for the space left.
 *
 * SCORED ON AREA PLACED PER MILLIMETRE OF PLATE WIDTH CONSUMED, which is the
 * scarce resource in a shelf layout — a full row of short parts can be worth
 * more than a half-empty row of tall ones. `mode: 'tallest'` instead forces the
 * tallest remaining part's row, which is the classic shelf instinct and is
 * better when a few big parts would otherwise be deferred until no width
 * remains and they have to open a plate of their own. Both are run per plate
 * and the fuller plate wins.
 */
function bestRow(capLen, hMax, rem, demand, cfg, mode, rng) {
  const heights = new Set();
  let tallest = 0;
  let bulkH = null; let bulkArea = -1;
  for (let i = 0; i < demand.length; i += 1) {
    if (rem[i] <= 0) continue;
    let mine = null;
    for (const o of orientationsOf(demand[i])) {
      if (o.fh > hMax + EPS || o.fl + 2 * cfg.kerf > capLen + cfg.kerf + EPS) continue;
      heights.add(o.fh);
      if (o.fh > tallest) tallest = o.fh;
      if (mine == null || o.fh < mine) mine = o.fh;
    }
    if (mine == null) continue;
    const a = demand[i].area * rem[i];
    if (a > bulkArea) { bulkArea = a; bulkH = mine; }
  }
  if (!heights.size) return null;

  let list;
  if (mode === 'tallest') list = [tallest];
  else {
    const tall = [...heights].sort((a, b) => b - a).slice(0, rng ? HEIGHTS_TRIED + 1 : HEIGHTS_TRIED);
    // The tallest first, but also the height that most of the remaining steel
    // wants — a plate of 828 stiffeners is decided by that row, not by the one
    // awkward tall part sitting at the top of the list.
    if (bulkH != null && !tall.includes(bulkH)) tall.push(bulkH);
    list = tall;
  }

  const cands = [];
  for (const h of list) {
    const r = buildRow(capLen, h, rem, demand, cfg, true, cfg.cache);
    if (r) cands.push(r);
  }
  /*
   * ONE MIXED ROW, at the tallest height only. A loose row lets shorter parts
   * in, pays an extra kerf at each change of height and wastes the difference
   * above them — worth trying on a tail and rarely worth trying anywhere else,
   * and it is the arm that costs a full DP.
   */
  const loose = buildRow(capLen, list[0], rem, demand, cfg, false, cfg.cache);
  if (loose) cands.push(loose);
  if (!cands.length) return null;
  cands.sort((a, b) => (b.area / (b.h + cfg.kerf)) - (a.area / (a.h + cfg.kerf))
    || b.area - a.area || a.h - b.h || (a.strict ? 0 : 1) - (b.strict ? 0 : 1));
  return rng ? cands[Math.floor(rng() * Math.min(2, cands.length))] : cands[0];
}

const newState = (sheet, cfg, mode) => ({
  sheet,
  mode,
  rows: [],
  sequences: [],
  seq: null,
  cursorY: cfg.kerf, // the top rim is cut
  placed: [],
  placedArea: 0,
  commonCuts: 0,
  separateCuts: 0,
});

/**
 * Keep laying rows into `st` until nothing more fits. Mutates `st` and `rem`.
 *
 * A DEMAND ROW MAY SPAN PLATES. The inner loop places as many as will go and
 * leaves the rest for the next plate: nobody minds if ninety stiffeners come
 * off one plate and fifty-four off another, and pooling requires it — the
 * biggest row on a real order is a dozen plates' worth, so all-or-nothing
 * makes it unplaceable rather than awkward.
 */
function packInto(st, demand, rem, cfg, rng) {
  const k = cfg.kerf;
  const LL = st.sheet.length - 2 * cfg.margin;
  const WW = st.sheet.width - 2 * cfg.margin;
  const capLen = LL - k;
  if (capLen <= EPS) return st;

  for (;;) {
    const roomForRow = WW - st.cursorY - k;
    if (roomForRow <= EPS) break;
    const optimistic = st.rows.length ? k : 0;
    const pessimistic = st.rows.length ? Math.max(cfg.sequenceGap, 2 * k) : 0;

    let row = bestRow(capLen, roomForRow - optimistic, rem, demand, cfg, st.mode, rng);
    if (!row) break;
    let plan = planRow(st, row, cfg);
    if (st.cursorY + plan.advance + row.h + k > WW + EPS) {
      // The optimistic budget was wrong for this row; re-solve against the
      // worst advance it could possibly attract rather than guess again.
      row = bestRow(capLen, roomForRow - pessimistic, rem, demand, cfg, st.mode, rng);
      if (!row) break;
      plan = planRow(st, row, cfg);
      if (st.cursorY + plan.advance + row.h + k > WW + EPS) break;
    }

    if (plan.newSeq) {
      st.seq = { seq: st.sequences.length + 1, cls: row.cls, count: 0, rows: [] };
      st.sequences.push(st.seq);
    } else if (plan.shared) st.commonCuts += 1; else st.separateCuts += 1;

    st.cursorY += plan.advance;
    const y = cfg.margin + st.cursorY;
    st.seq.count += 1;
    const rec = {
      seq: st.seq.seq, row: st.seq.count, y, height: row.h, parts: [], uniform: row.uniform,
    };
    row.parts.forEach((p, n) => {
      const placed = {
        idx: p.idx,
        x: cfg.margin + p.dx,
        y,
        length: p.fl,
        width: p.fh,
        rotated: p.rotated,
        seq: st.seq.seq,
        row: st.seq.count,
        order: n + 1,
      };
      st.placed.push(placed);
      rec.parts.push(placed);
      rem[p.idx] -= 1;
    });
    st.placedArea += row.area;
    st.commonCuts += row.commonCuts;
    st.separateCuts += row.separateCuts;
    st.cursorY += row.h;
    st.rows.push(rec);
    st.seq.rows.push(rec);
  }
  return st;
}

/** Pack one plate from empty. `rem` is NOT touched — the caller commits. */
function packSheet(sheet, demand, rem, cfg, rng, mode = 'ratio') {
  const scratch = Int32Array.from(rem);
  const st = packInto(newState(sheet, cfg, mode), demand, scratch, cfg, rng);
  return st.placed.length ? st : null;
}

/** Both row strategies, the fuller kept. Used where the cost is affordable. */
function packSheetBoth(sheet, demand, rem, cfg, rng) {
  const a = packSheet(sheet, demand, rem, cfg, rng, 'ratio');
  const b = packSheet(sheet, demand, rem, cfg, rng, 'tallest');
  if (!a) return b;
  if (!b) return a;
  return b.placedArea > a.placedArea + EPS ? b : a;
}

const utilOf = (n) => n.placedArea / n.sheet.area;

function cloneState(st) {
  const rows = st.rows.map((r) => ({ ...r, parts: [] }));
  const byRow = new Map(rows.map((r) => [`${r.seq}|${r.row}`, r]));
  const placed = st.placed.map((p) => {
    const q = { ...p };
    byRow.get(`${q.seq}|${q.row}`).parts.push(q);
    return q;
  });
  const sequences = st.sequences.map((s) => ({ ...s, rows: rows.filter((r) => r.seq === s.seq) }));
  return {
    ...st,
    rows,
    placed,
    sequences,
    seq: sequences.length ? sequences[sequences.length - 1] : null,
  };
}

/**
 * HOW MANY OF THIS ROW AN EMPTY PLATE HOLDS, not whether one does.
 *
 * A row of 7,212 studs once passed a one-piece test, could never actually be
 * placed, and the packer spun on it making no progress. The count is what lets
 * the caller say something useful instead — and the one-piece form of it is
 * what decides "the drawing needs steel nobody sells".
 */
export function capacityOn(row, sheet, cfg) {
  const k = cfg.kerf;
  const LL = sheet.length - 2 * cfg.margin;
  const WW = sheet.width - 2 * cfg.margin;
  let best = 0;
  for (const o of orientationsOf(row)) {
    if (o.fl + 2 * k > LL + EPS || o.fh + 2 * k > WW + EPS) continue;
    const across = Math.floor((LL - k + EPS) / (o.fl + k));
    const rows = Math.floor((WW - k + EPS) / (o.fh + k));
    best = Math.max(best, across * rows);
  }
  return best;
}

/* ───────────────────────────── the greedy pass ─────────────────────────── */

/**
 * Open plates until the demand is gone.
 *
 * A generator, so the caller can breathe between candidate plates and so `nest`
 * and `nestAsync` share exactly one copy of this code. A synchronous pack of a
 * real order holds the event loop for tens of seconds — not just the nesting
 * screen, every screen, for everyone.
 *
 * `rem` is MUTATED down as parts land: an Int32Array indexed by demand ROW.
 * That indexing is deliberate. The same bookkeeping keyed by `row.key` made
 * fourteen plate-rows of 56 each subtract 56 from their own 56, and 2,692
 * pieces left the pool reported as finished work that was never done.
 */
function* buildOnce(ctx, rem, rng, stockOverride) {
  const { demand, sheets, cfg, maxNests } = ctx;
  const nests = [];
  const stock = new Map();
  for (const s of sheets) {
    stock.set(s._i, stockOverride ? (stockOverride.get(s._i) ?? 0) : (s.available == null ? Infinity : s.available));
  }
  const owned = sheets.filter((s) => costOf(s) <= 0);
  const buy = sheets.filter((s) => costOf(s) > 0);

  while (nests.length < maxNests) {
    let any = false;
    for (let i = 0; i < demand.length; i += 1) if (rem[i] > 0) { any = true; break; }
    if (!any) break;

    cfg.cache = new Map();
    let best = null;
    for (const round of [owned, buy]) {
      const cands = [];
      for (const s of round) {
        if ((stock.get(s._i) ?? 0) <= 0) continue;
        const r = packSheet(s, demand, rem, cfg, rng, 'ratio');
        if (r) cands.push(r);
        yield; // a candidate plate is the granule the server breathes on
      }
      if (!cands.length) continue;
      /*
       * COST PER MILLIMETRE² OF PART PLACED is the marginal price of this
       * plate. Greedily minimising it is exactly minimising area bought, and
       * unlike utilisation it survives an `areaCost` that is not the plate's
       * own area. Steel already owned costs nothing, so it is judged instead on
       * how little of it goes to waste — otherwise a 12 m plate cut cleverly
       * out-scores a drop every time and the drop rusts while the shop buys
       * its area again.
       */
      const free0 = round === owned;
      const rank = (a, b) => (free0
        ? (a.sheet.area - a.placedArea) - (b.sheet.area - b.placedArea)
        : (costOf(a.sheet) / a.placedArea) - (costOf(b.sheet) / b.placedArea))
        || b.placedArea - a.placedArea
        || a.sheet._i - b.sheet._i;
      cands.sort(rank);
      /*
       * THE SECOND ROW STRATEGY, ON THE SHORTLIST ONLY. "Tallest row first" is
       * the classic shelf instinct and beats the area-per-millimetre rule when
       * a few big parts would otherwise be deferred until no width is left and
       * they have to open a plate of their own. Run on every candidate size it
       * doubled the cost of the whole packer; run on the three sizes the cheap
       * rule already rates highest it finds the same improvements.
       */
      for (const c of cands.slice(0, 3)) {
        const alt = packSheet(c.sheet, demand, rem, cfg, rng, 'tallest');
        if (alt && alt.placedArea > c.placedArea + EPS) Object.assign(c, alt);
        yield;
      }
      cands.sort(rank);
      best = rng ? cands[Math.floor(rng() * Math.min(2, cands.length))] : cands[0];
      break; // anything already paid for ends the contest
    }
    /*
     * NOTHING WENT ANYWHERE. Every row left has been checked against the whole
     * catalogue up front, so a pass that places nothing means no plate has room
     * left, not that the packer needs another go. Stopping is the answer;
     * trying again is the bug where it span.
     */
    if (!best) break;

    nests.push(best);
    stock.set(best.sheet._i, (stock.get(best.sheet._i) ?? Infinity) - 1);
    for (const p of best.placed) rem[p.idx] -= 1;
  }
  return nests;
}

/* ─────────────────────────────── repair passes ─────────────────────────── */

/**
 * Empty the emptiest plates into the others and delete them.
 *
 * THE GREEDY TAIL is what this is for. The main loop commits a plate and never
 * reopens it, so the parts left at the end cannot join a plate that is already
 * closed — they open one of their own. Three stiffeners alone on a 24 m² sheet
 * at 7% used, while dozens of identical ones sat on earlier plates. It is not a
 * size problem; the only answer was a plate that was already open.
 *
 * Here that means CONTINUING a plate's shelf: a kept plate still has width
 * under its last row, and `packInto` picks up exactly where it stopped, opening
 * a new sequence if the class changes. All-or-nothing per donor, because
 * half-emptying a plate still buys the plate.
 */
function consolidate(nests, ctx) {
  if (nests.length < 2) return nests;
  const { demand, cfg } = ctx;
  const donors = nests.map((n, i) => ({ n, i }))
    .sort((a, b) => utilOf(a.n) - utilOf(b.n) || a.i - b.i)
    .map((d) => d.n);
  let live = [...nests];

  for (const donor of donors) {
    if (live.length <= 1) break;
    if (utilOf(donor) > 0.9) continue;
    if (!live.includes(donor)) continue;

    const need = new Int32Array(demand.length);
    for (const p of donor.placed) need[p.idx] += 1;
    let want = donor.placed.length;

    const targets = live.filter((p) => p !== donor)
      .sort((a, b) => (b.sheet.width - b.cursorY) - (a.sheet.width - a.cursorY))
      .slice(0, 25);
    const trial = new Map();
    for (const t of targets) {
      if (!want) break;
      const c = cloneState(t);
      const before = c.placed.length;
      cfg.cache = new Map();
      packInto(c, demand, need, cfg, null);
      const took = c.placed.length - before;
      if (took > 0) { trial.set(t, c); want -= took; }
    }
    if (want > 0) continue; // not all of it moved: the donor still gets bought
    live = live.filter((p) => p !== donor).map((p) => trial.get(p) ?? p);
  }
  return live;
}

/**
 * Swap each plate for the smallest catalogue size that still holds what is on it.
 *
 * The greedy loop CHOOSES a size and then fills it, and never revisits the
 * choice — so a plate picked as the home for one big web keeps its full size
 * after the web turns out to be all it received. `consolidate` reduces the
 * plate COUNT; this reduces the plate SIZE on plates that are staying. A swap
 * happens only onto a strictly cheaper size that takes everything, so area
 * bought can only fall.
 *
 * ONLY ONTO SIZES THAT CAN BE BOUGHT AGAIN. A drop is one physical piece and
 * two plates shrinking onto the same drop would both believe they had it.
 */
function shrink(nests, ctx) {
  const { cfg, demand } = ctx;
  const buyable = ctx.sheets.filter((s) => s.available == null && costOf(s) > 0);
  if (!buyable.length) return nests;

  return nests.map((n) => {
    const here = costOf(n.sheet);
    if (here <= 0 || utilOf(n) > 0.94) return n;
    const sub = new Int32Array(demand.length);
    for (const p of n.placed) sub[p.idx] += 1;
    const want = n.placed.length;
    const smaller = buyable.filter((s) => costOf(s) < here - EPS)
      .sort((a, b) => costOf(a) - costOf(b) || a.area - b.area || a._i - b._i);
    for (const s of smaller) {
      cfg.cache = new Map();
      const t = packSheetBoth(s, demand, sub, cfg, null);
      if (t && t.placed.length === want) return t;
    }
    return n;
  });
}

/* ──────────────────────────── scoring a solution ───────────────────────── */

const scoreOf = (nests) => nests.reduce((a, n) => a + costOf(n.sheet), 0);

function finalise(ctx, nests, stranded) {
  let strandedQty = 0;
  for (const s of stranded) strandedQty += s.qty;
  /*
   * CONSERVATION, ASSERTED BEFORE ANY ANSWER LEAVES. This failure mode was
   * silent: nothing was left unplaced to complain about, the pieces simply
   * ceased to exist and were reported as finished work. Counting them costs
   * microseconds and makes it loud.
   */
  const seen = new Int32Array(ctx.demand.length);
  for (const n of nests) for (const p of n.placed) seen[p.idx] += 1;
  for (const s of stranded) seen[s.idx] += s.qty;
  for (let i = 0; i < ctx.demand.length; i += 1) {
    if (seen[i] !== ctx.rem0[i]) {
      throw new Error(`nestingPacker: quantity lost on row ${ctx.demand[i].key} `
        + `(wanted ${ctx.rem0[i]}, accounted ${seen[i]})`);
    }
  }
  return {
    nests,
    stranded,
    strandedQty,
    score: scoreOf(nests),
    sheetArea: nests.reduce((a, n) => a + n.sheet.area, 0),
    placedArea: nests.reduce((a, n) => a + n.placedArea, 0),
  };
}

/** A solution beats another on parts stranded, then money, then plate count. */
function better(a, b) {
  if (!b) return true;
  if (a.strandedQty !== b.strandedQty) return a.strandedQty < b.strandedQty;
  if (Math.abs(a.score - b.score) > EPS) return a.score < b.score;
  if (a.nests.length !== b.nests.length) return a.nests.length < b.nests.length;
  return a.sheetArea < b.sheetArea - EPS;
}

/* ────────────────────────────────  search  ─────────────────────────────── */

function* buildSolution(ctx, rng) {
  const rem = Int32Array.from(ctx.rem0);
  const raw = yield* buildOnce(ctx, rem, rng, null);
  const stranded = [];
  for (let i = 0; i < rem.length; i += 1) {
    if (rem[i] > 0) stranded.push({ idx: i, qty: rem[i], reason: 'no plate had room left' });
  }
  return finalise(ctx, shrink(consolidate(raw, ctx), ctx), stranded);
}

/**
 * Tear up a few plates and rebuild only those parts.
 *
 * THIS IS NOT A SEARCH OVER LAYOUTS — the row builder already solves a plate
 * about as well as this structure allows. It is a search over the ASSIGNMENT:
 * which parts land on which plate, which is what area bought actually depends
 * on. A restart throws the whole answer away and 90% of it was already fine;
 * this keeps the good plates and spends the budget on the part that is wrong.
 *
 * Three operators. "Emptiest" fixes the greedy tail, "random" exists because
 * emptiest gets stuck re-solving the same tail, and "related" rebuilds plates
 * that share parts, which is the only move that can re-mix them. The tear-up
 * grows while nothing improves — standard adaptive LNS, and deterministic: it
 * depends on the trial index and the accept history, never on the clock.
 */
function* repair(ctx, cur, step) {
  const n = cur.nests.length;
  if (!n) return null;
  const rng = rngFor(ctx.seed, 0x4000 + step);
  const grow = Math.min(1, ctx.stall / 25);
  const k = Math.max(1, Math.min(n, Math.round(n * (0.12 + 0.45 * grow)) || 1));

  const freed = new Set();
  const op = Math.floor(rng() * 3);
  if (op === 0) {
    const order = cur.nests.map((_, i) => i).sort((a, b) => utilOf(cur.nests[a]) - utilOf(cur.nests[b]) || a - b);
    for (let i = 0; i < k; i += 1) freed.add(order[i]);
  } else if (op === 1) {
    const order = cur.nests.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let i = 0; i < k; i += 1) freed.add(order[i]);
  } else {
    const s = Math.floor(rng() * n);
    const setOf = (i) => new Set(cur.nests[i].placed.map((p) => p.idx));
    const base = setOf(s);
    const share = (i) => { let c = 0; for (const v of setOf(i)) if (base.has(v)) c += 1; return c; };
    const order = cur.nests.map((_, i) => i).filter((i) => i !== s).sort((a, b) => share(b) - share(a) || a - b);
    freed.add(s);
    for (let i = 0; i < k - 1 && i < order.length; i += 1) freed.add(order[i]);
  }

  const keep = cur.nests.filter((_, i) => !freed.has(i));
  const rem = new Int32Array(ctx.demand.length);
  for (const i of freed) for (const p of cur.nests[i].placed) rem[p.idx] += 1;

  /*
   * WHAT IS STILL AVAILABLE, counted across the plates we are KEEPING. A drop
   * held by a kept plate is not on offer to the rebuild: it is one physical
   * piece of steel and two plates in the same answer cannot both stand on it.
   * The same arithmetic covers any limited catalogue size.
   */
  const used = new Map();
  for (const nst of keep) used.set(nst.sheet._i, (used.get(nst.sheet._i) ?? 0) + 1);
  const stockOverride = new Map();
  for (const s of ctx.sheets) {
    stockOverride.set(s._i, s.available == null ? Infinity : s.available - (used.get(s._i) ?? 0));
  }

  const rebuilt = yield* buildOnce(ctx, rem, rng, stockOverride);
  for (let i = 0; i < rem.length; i += 1) if (rem[i] > 0) return null; // stranded: not an improvement

  return finalise(ctx, shrink(consolidate([...keep, ...rebuilt], ctx), ctx), cur.stranded);
}

function* search(ctx) {
  let best = yield* buildSolution(ctx, null); // trial 0: THE FLOOR. Always runs.
  let capped = false;
  const restarts = ctx.restarts;
  const total = (ctx.level.repairs || restarts) ? restarts + ctx.level.repairs : 0;

  for (let step = 1; step <= total; step += 1) {
    if (Date.now() >= ctx.deadline) { capped = true; break; }
    if (best.strandedQty === 0 && best.score <= ctx.lowerBound + EPS) break; // provably done
    const cand = step <= restarts
      ? yield* buildSolution(ctx, rngFor(ctx.seed, step))
      : yield* repair(ctx, best, step);
    if (cand && better(cand, best)) { best = cand; ctx.stall = 0; } else ctx.stall += 1;
  }
  return { best, capped };
}

/* ─────────────────────────────── size advice ───────────────────────────── */

/**
 * THE WASTE THAT BELONGS TO THE CATALOGUE, not to the layout.
 *
 * The single biggest loss on a real order was forty 12000 x 2995 webs and the
 * only plate wide enough being 3100: a 105 mm strip off every plate that no
 * arrangement can touch. That is a purchasing answer — ask the mill for 3000
 * wide — and nobody finds out unless the packer says so.
 *
 * `needLength`/`needWidth` are the exact requirement INCLUDING the rim cuts, so
 * three 850 mm parts read 3 + 850 + 3 + 850 + 3 + 850 + 3 = 2562. `orderLength`
 * /`orderWidth` add the ordering margin (+100 length, +50 width) and round up
 * to a standard step, because mill edges are not straight and a standard size
 * procures faster.
 *
 * ONE ANSWER PER WIDTH: a mill sells by width and cuts to length, so plates off
 * one size wanting the same width are one purchasing question, asked once.
 */
export function sizeAdvice(nests, cfg, opts = {}) {
  const step = opts.stepMm ?? ORDER_MARGIN.stepMm;
  const addL = opts.lengthMm ?? ORDER_MARGIN.lengthMm;
  const addW = opts.widthMm ?? ORDER_MARGIN.widthMm;
  const minPct = opts.minPct ?? 2;
  const groups = new Map();

  for (const n of nests) {
    if (costOf(n.sheet) <= 0 || !n.placed.length) continue;
    let maxX = 0;
    for (const p of n.placed) maxX = Math.max(maxX, p.x + p.length);
    // + the far rim cut, + whatever rim trim was asked for on both sides.
    const needLength = Math.min(n.sheet.length, maxX + cfg.kerf + cfg.margin);
    const needWidth = Math.min(n.sheet.width, cfg.margin + n.cursorY + cfg.kerf + cfg.margin);
    const bucket = Math.ceil((needWidth + addW) / step) * step;
    const key = `${n.sheet.key}|${bucket}`;
    const hit = groups.get(key);
    if (!hit) {
      groups.set(key, {
        sheetKey: n.sheet.key,
        sheetLength: n.sheet.length,
        sheetWidth: n.sheet.width,
        nests: 1,
        needLength,
        needWidth,
      });
    } else {
      hit.nests += 1;
      hit.needLength = Math.max(hit.needLength, needLength);
      hit.needWidth = Math.max(hit.needWidth, needWidth);
    }
  }

  const out = [];
  for (const g of groups.values()) {
    const orderLength = Math.min(g.sheetLength, Math.ceil((g.needLength + addL) / step) * step);
    const orderWidth = Math.min(g.sheetWidth, Math.ceil((g.needWidth + addW) / step) * step);
    const per = g.sheetLength * g.sheetWidth - orderLength * orderWidth;
    const pct = (100 * per) / (g.sheetLength * g.sheetWidth);
    if (pct < minPct) continue;
    out.push({
      ...g, orderLength, orderWidth, savingArea: per * g.nests, savingPct: Math.round(pct * 10) / 10,
    });
  }
  return out.sort((a, b) => b.savingArea - a.savingArea);
}

/* ──────────────────────────────── the entry ────────────────────────────── */

function* solve(input) {
  const t0 = Date.now();
  const {
    pieces = [], sheets = [], kerf, thickness, gap,
    sequenceGap = SEQUENCE_GAP.default, margin = 0,
    commonBoundary = true, smallThreshold = SMALL_THRESHOLD_MM,
    rowsPerSequence = ROWS_PER_SEQUENCE,
    effort = 'standard', seed = 1,
    budgetMs = null, maxNests = DEFAULT_MAX_NESTS,
  } = input ?? {};

  // Kerf is a NUMBER of mm and nothing else. Passing a thickness and having the
  // packer look the kerf up would make this file an owner of shop data and a
  // second place the bands live; resolve it from cf_cut_settings and hand it in.
  // `gap` is the old name for the same number and still works.
  const k = Number(kerf ?? gap ?? NaN);
  if (!(k >= 0)) {
    throw new TypeError(thickness != null
      ? 'nest: `thickness` alone no longer resolves a kerf — pass `kerf` (mm) from nestingService.resolveCutSettings'
      : 'nest: needs `kerf` (mm)');
  }
  const m = Number(margin);
  const sg = Number(sequenceGap);
  if (!(m >= 0)) throw new TypeError('nest: `margin` must be a number >= 0');
  if (!(sg >= 0)) throw new TypeError('nest: `sequenceGap` must be a number >= 0');

  const demand = normalisePieces(pieces, Number(smallThreshold));
  const sh = normaliseSheets(sheets);
  const level = EFFORT[effort] ?? EFFORT.standard;
  const cfg = {
    kerf: k,
    margin: m,
    sequenceGap: sg,
    commonBoundary: !!commonBoundary,
    rowsPerSequence: { ...ROWS_PER_SEQUENCE, ...rowsPerSequence },
    cache: null,
  };

  const blank = (extra) => ({
    nests: [],
    unplaced: [],
    areaBought: 0,
    wasteArea: 0,
    wastePct: 0,
    sizeAdvice: [],
    kerf: k,
    sequenceGap: sg,
    deterministic: true,
    elapsedMs: Date.now() - t0,
    ...extra,
  });
  if (!demand.length) return blank({});

  /*
   * WHAT NOBODY STOCKS, SAID UP FRONT. A part that cannot get one piece onto
   * any candidate is not a search problem, it is a purchasing answer: the
   * drawing needs steel nobody sells. Saying so once beats letting every pass
   * rediscover it — and a row that can never land keeping the loop busy forever
   * is exactly the bug this replaces.
   */
  const rem0 = new Int32Array(demand.length);
  const upfront = [];
  const biggestL = sh.length ? Math.max(...sh.map((s) => Math.max(s.length, s.width))) : 0;
  const biggestW = sh.length ? Math.max(...sh.map((s) => Math.min(s.length, s.width))) : 0;
  for (const row of demand) {
    if (sh.some((s) => capacityOn(row, s, cfg) > 0)) { rem0[row.idx] = row.qty; continue; }
    upfront.push({
      key: row.key,
      qty: row.qty,
      reason: sh.length
        ? `${row.length} x ${row.width} mm plus ${k} mm of kerf on every side does not fit any offered `
          + `plate (largest is ${biggestL} x ${biggestW} mm${m > 0 ? `, less a ${m} mm rim trim` : ''})`
        : 'no plates were offered',
    });
  }

  let placeable = 0;
  for (let i = 0; i < rem0.length; i += 1) placeable += rem0[i];
  if (!placeable) return blank({ unplaced: mergeUnplaced(upfront) });

  let pieceArea = 0;
  for (const row of demand) pieceArea += row.area * rem0[row.idx];
  let ownedArea = 0;
  for (const s of sh) if (costOf(s) <= 0) ownedArea += s.area * (s.available == null ? 1e9 : s.available);

  const ctx = {
    demand,
    sheets: sh,
    cfg,
    rem0,
    seed: Number(seed) | 0,
    level,
    restarts: restartsFor(level, input ?? {}),
    stall: 0,
    maxNests: Math.max(1, Math.trunc(Number(maxNests))),
    lowerBound: Math.max(0, pieceArea - ownedArea),
    deadline: t0 + (budgetMs == null ? level.capMs : Math.max(0, Number(budgetMs))),
  };

  const { best, capped } = yield* search(ctx);

  const shape = (p) => ({
    key: demand[p.idx].key,
    x: p.x,
    y: p.y,
    length: p.length, // footprint along the plate's length; `rotated` says it was turned
    width: p.width,
    rotated: p.rotated,
    sequence: p.seq,
    row: p.row,
    order: p.order,
  });

  const out = best.nests.map((n) => ({
    sheetKey: n.sheet.key,
    sheetLength: n.sheet.length,
    sheetWidth: n.sheet.width,
    preferred: n.sheet.preferred,
    kerf: k,
    /** Flat, in CUT ORDER: sequence, then row, then left to right. */
    pieces: n.placed.map(shape),
    /** The same parts as the plan is actually cut: pierce order is the point. */
    sequences: n.sequences.map((s) => ({
      sequence: s.seq,
      cls: s.cls,
      rowsPerSequence: rowsPerSeq(s.cls, cfg),
      rows: s.rows.map((r) => ({
        row: r.row, y: r.y, height: r.height, flush: r.uniform, parts: r.parts.map(shape),
      })),
    })),
    /** How many cuts were shared and how many were not — the common-boundary win. */
    commonCuts: n.commonCuts,
    separateCuts: n.separateCuts,
    usedArea: n.placedArea,
    sheetArea: n.sheet.area,
  }));

  const sheetArea = best.sheetArea;
  const wasteArea = sheetArea - best.placedArea;
  const unplaced = mergeUnplaced([
    ...upfront,
    ...best.stranded.map((s) => ({ key: demand[s.idx].key, qty: s.qty, reason: s.reason })),
  ]);

  return {
    nests: out,
    unplaced,
    /** Steel BOUGHT: a plate already owned contributes nothing. */
    areaBought: best.score,
    /** Physical waste on every plate used, owned ones included. */
    wasteArea,
    wastePct: sheetArea > 0 ? (100 * wasteArea) / sheetArea : 0,
    sizeAdvice: sizeAdvice(best.nests, cfg),
    kerf: k,
    sequenceGap: sg,
    commonCuts: out.reduce((a, n) => a + n.commonCuts, 0),
    separateCuts: out.reduce((a, n) => a + n.separateCuts, 0),
    /** False only when the clock, not the iteration count, ended the search. */
    deterministic: !capped,
    elapsedMs: Date.now() - t0,
  };
}

function mergeUnplaced(list) {
  const by = new Map();
  for (const u of list) {
    const key = JSON.stringify([String(u.key), u.reason]);
    const hit = by.get(key);
    if (hit) hit.qty += u.qty; else by.set(key, { ...u });
  }
  return [...by.values()];
}

/**
 * Lay `pieces` onto plates chosen from `sheets`, as Plate -> Sequence -> Row.
 *
 * @param {{
 *   pieces: Array<{key:*, length:number, width:number, qty:number, grain?:'length'|'width'|'any'}>,
 *   sheets: Array<{key:*, length:number, width:number, available?:number|null,
 *                  preferred?:boolean, areaCost?:number|null}>,
 *   kerf?: number, thickness?: number, gap?: number,
 *   sequenceGap?: number, margin?: number, commonBoundary?: boolean,
 *   smallThreshold?: number, rowsPerSequence?: {small:number, big:number},
 *   effort?: 'quick'|'standard'|'deep', seed?: number,
 *   budgetMs?: number|null, maxNests?: number,
 * }} input  Kerf comes as a number, or as a `thickness` resolved by `kerfFor`.
 * @returns {{nests:Array, unplaced:Array, areaBought:number, wasteArea:number,
 *            wastePct:number, sizeAdvice:Array, kerf:number, sequenceGap:number,
 *            commonCuts:number, separateCuts:number,
 *            deterministic:boolean, elapsedMs:number}}
 */
export function nest(input) {
  const it = solve(input);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

/** `setImmediate` rather than a timer: after pending I/O, i.e. "let the queue through". */
const breathe = () => new Promise((resolve) => { setImmediate(resolve); });

/**
 * The same search, letting the server breathe.
 *
 * Node runs one thing at a time, and a synchronous pack of a real order holds
 * the event loop — not just the nesting screen, every screen, for everyone.
 * `/health`, which touches nothing, timed out at sixty seconds.
 *
 * SAME SEED, SAME ANSWER as `nest`, guaranteed rather than intended: both drain
 * the identical generator and the only difference is where control goes between
 * steps. The budget is consulted by the OPENING trials too, not just the repair
 * loop, because a budget that only governs the second half is not a budget.
 */
export async function nestAsync(input) {
  const it = solve(input);
  let n = 0;
  let r = it.next();
  while (!r.done) {
    n += 1;
    if (n % BREATHE_EVERY === 0) await breathe();
    r = it.next();
  }
  return r.value;
}

/**
 * Internals. `nestingService` may want these to answer a question without
 * running a whole pack (can this part be cut from anything we stock?); the test
 * deliberately does NOT use them, because a checker that shares the packer's
 * code shares the packer's bugs.
 */
export const __internals = { EPS, RESTARTS, costOf, orientationsOf };
