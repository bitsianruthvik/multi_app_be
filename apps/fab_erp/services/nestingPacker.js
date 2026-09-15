/**
 * nestingPacker.js — lay parts onto plates, and choose which plates to use.
 *
 * PURE GEOMETRY. Nothing here touches the database or knows what an order is.
 * That is deliberate: nesting is the one part of this system where being wrong
 * is expensive and hard to see, so it has to be testable on its own, with made-
 * up numbers, without a tenant. `nestingSuggestService` supplies the parts and
 * the candidate plate sizes and writes nothing until a person accepts.
 *
 * ── WHY GUILLOTINE AND NOT FREE-FORM ──────────────────────────────────────
 * A free-form 2D packer reports a better utilisation than any cutter can
 * realise, because a plate is cut by a torch or a guillotine running in
 * straight lines edge to edge. Every placement here leaves the remainder as
 * rectangles, so the result is one a shop can actually cut. It is pessimistic
 * in the right direction: the nesting software on the floor may beat it, and it
 * will never promise something the floor cannot deliver.
 *
 * ── A ROW MAY SPAN PLATES ─────────────────────────────────────────────────
 * It used to be atomic — every piece of a row on one plate or the row did not
 * go — because a part carried one material link and a link carried one nest_no.
 * That was the schema talking, not the shop: nobody minds if ninety stiffeners
 * come off one plate and fifty-four off another. A part now carries one material
 * row per plate it is cut from, so the geometry is free of it.
 *
 * The consequence to hold on to: one pooled part is MANY plate-rows sharing one
 * key. Anything counting pieces must key on the row object, never on its name.
 *
 * ── HOW A PLATE SIZE IS CHOSEN ────────────────────────────────────────────
 * This is variable-sized bin packing: the sizes are not given, they are picked
 * from a catalogue. Exact optimisation is NP-hard and not worth it against
 * mill tolerances, so the loop is: for the parts still unplaced, try EVERY
 * candidate size, pack each greedily, and commit whichever leaves the least
 * waste. That naturally reaches for a big plate while the big parts remain and
 * a small one to mop up the rest — which is what a nester does by hand.
 */

/** Millimetres of slack before a part counts as not fitting. */
const TOL = 1;

/**
 * CUTTING GAP — 2 mm for this shop, BETWEEN PARTS ONLY.
 *
 * The torch needs room to run a clean cut between two parts. It needs nothing
 * at the plate's rim: a mill edge is already a finished edge, so a part may sit
 * hard against it. One number for every thickness — the shop's own blanket
 * rule, not a simplification made here.
 *
 * MODELLED BY INFLATING THE PART AND THE SHEET BY THE SAME AMOUNT. Each part
 * reserves (l + g) x (w + g), and the usable sheet is (L + g) x (W + g). The
 * two cancel at the rim and survive in the middle, which is exactly the rule:
 *
 *   one part           l + g <= L + g     ->  l <= L              no edge margin
 *   two side by side   2(w + g) <= W + g  ->  2w + g <= W         one gap between
 *   n across           n(w + g) <= W + g  ->  nw + (n-1)g <= W    n-1 gaps
 *
 * `areaOf` still measures the REAL plate, because that is what gets bought.
 *
 * IT WAS BRIEFLY MODELLED AS 50 mm AT THE RIM AS WELL, and both halves of that
 * were wrong. Charging it at the rim shrank the usable sheet by 2g and the
 * 28 mm Web Plate — 12000 long on a 12050 sheet — stopped fitting at all, which
 * made twenty-four of the heaviest parts unmakeable by arithmetic rather than by
 * anything the shop would recognise. And 50 mm rather than 2 mm reported 19%
 * waste against a true 4.7%, which is the difference between a system worth
 * trusting and one worth ignoring.
 *
 * The primitives below still default to 0 so that a caller measuring pure
 * geometry — the integrity audit, a capacity question — is not silently charged
 * a gap it did not ask for.
 */
export const DEFAULT_CUT_GAP_MM = 2;

const DEFAULT_MARGIN = 0;

/**
 * @typedef {Object} PartRow — what a caller wants cut.
 * @property {string} key      Stable identity, shared by every plate-row this pooled part ends up
 *   as. Never the caller's own id under a different name — see "A ROW MAY SPAN PLATES" above.
 * @property {number} length   mm, before kerf.
 * @property {number} width    mm.
 * @property {number} qty      Pieces wanted.
 * @property {'along_length'|'along_width'|'any'} [grain] 'any' (default, when omitted) keeps the
 *   free rotation this packer has always done; a stated grain forbids turning the piece 90°.
 */

/**
 * @typedef {Object} PlateSpec — a candidate sheet.
 * @property {number} id            Negative for an offcut (see `plateSourceService.offcutSpecs`),
 *   so it can never collide with a catalogue item id.
 * @property {number} length        mm.
 * @property {number} width         mm.
 * @property {number} [available]   Physical pieces of this exact spec — 1 for an offcut. Omit for
 *   a catalogue size, which can be bought again.
 * @property {boolean} [preferred]  Material already paid for; tried before anything to be bought.
 */

/**
 * @typedef {Object} NestOptions
 * @property {number} [kerfMm]      Cutting gap, mm (default `DEFAULT_CUT_GAP_MM`). `margin` is
 *   accepted as a synonym for callers written before this option existed. The packer never reads
 *   the database for this — kerf is resolved by the CALLER (`kerfService.kerfFor`) and handed in,
 *   because a pure geometry engine must not depend on a connection.
 * @property {number} [bedLengthMm] The cutting machine's bed, mm. A candidate plate that fits the
 *   bed in NEITHER orientation is dropped before packing starts. Leave either dimension unset for
 *   "no limit known" — behaves exactly as if bed size did not exist.
 * @property {number} [bedWidthMm]
 * @property {number} [restarts]
 * @property {number} [seed]
 * @property {number} [deadline]    A `Date.now()` timestamp; new restarts stop being started at or
 *   after this, but the first pack always completes.
 */

export const newPlate = (spec, margin = DEFAULT_MARGIN) => ({
  spec,
  margin,
  rows: [],
  pieces: [],
  free: [{ x: 0, y: 0, l: spec.length + margin, w: spec.width + margin }],
});

const clonePlate = (p) => ({
  ...p,
  free: p.free.map((r) => ({ ...r })),
  rows: [...p.rows],
  pieces: [...p.pieces],
});

export const areaOf = (p) => p.spec.length * p.spec.width;
export const usedArea = (p) => p.rows.reduce((s, r) => s + r.length * r.width * r.qty, 0);

/** Fraction of a plate actually taken by parts. */
export const utilisation = (p) => usedArea(p) / areaOf(p);

/**
 * Put one piece on a plate, mutating it. True if it went.
 *
 * Best-short-side-fit: of every free rectangle the piece fits in, take the one
 * that leaves the smallest sliver on its tighter axis. Slivers are what
 * eventually make a plate unusable, so producing the fewest of them is the
 * whole game. Both orientations are tried because a plate has no grain for
 * cutting — refusing to turn a part 90 degrees would reject work a shop does
 * daily.
 */
/**
 * PLACEMENT HEURISTICS — which free rectangle to take, and how to split what
 * is left. One rule is a guess; a restart that only wobbles the ROW ORDER keeps
 * re-running the same guess. Letting a restart also swap the rule is how the
 * search reaches layouts the default rule structurally cannot produce.
 *
 *   score  bssf  best short-side fit (default): fewest slivers
 *          blsf  best long-side fit: keeps the long strip open
 *          baf   best area fit: tightest rectangle first
 *   split  sas   shorter-axis split (default): the long strip survives whole
 *          las   longer-axis split: the tall column survives whole
 */
const SCORE_RULES = {
  bssf: (r, pl, pw) => Math.min(r.l - pl, r.w - pw),
  blsf: (r, pl, pw) => Math.max(r.l - pl, r.w - pw),
  baf: (r, pl, pw) => r.l * r.w - pl * pw,
};
const DEFAULT_HEUR = Object.freeze({ score: 'bssf', split: 'sas' });

/** A random heuristic pair, biased towards the default that measured best alone. */
export function pickHeuristic(rng) {
  const scores = ['bssf', 'bssf', 'blsf', 'baf'];
  const splits = ['sas', 'sas', 'las'];
  return {
    score: scores[Math.floor(rng() * scores.length)],
    split: splits[Math.floor(rng() * splits.length)],
  };
}

function placePiece(plate, a, b, rng = null, allowRotate = true, heur = null) {
  const scoreOfFit = SCORE_RULES[heur?.score] ?? SCORE_RULES.bssf;
  const splitLonger = heur?.split === 'las';
  /**
   * EVERY feasible placement, not just the best one — because orientation is
   * decided here, and it was never being searched.
   *
   * Both turns of the piece are tried against every free rectangle, so a sheet
   * CAN carry some parts one way and some the other. It just never did: the
   * score is deterministic, so the first piece's choice fixed the pattern and
   * every later piece repeated it. On the KEPL 12 mm group, 0 of 36 plates
   * mixed orientations. The restarts did not help, because they wobble the row
   * ORDER and leave orientation alone.
   *
   * With `rng`, the pick comes from the best few placements rather than the
   * single best — which is what finally lets a run try turning a part.
   *
   * `allowRotate=false` (a stated `grain`) drops the swapped turn entirely, so
   * a part that must not be turned is never placed sideways even when doing so
   * would score better.
   */
  const turns = allowRotate ? [[a, b, false], [b, a, true]] : [[a, b, false]];
  const cands = [];
  for (let i = 0; i < plate.free.length; i++) {
    const r = plate.free[i];
    for (const [pl, pw, rotated] of turns) {
      if (pl > r.l + TOL || pw > r.w + TOL) continue;
      cands.push({
        i, r, pl, pw, rotated, score: scoreOfFit(r, pl, pw),
      });
    }
  }
  if (!cands.length) return false;
  cands.sort((x, y) => x.score - y.score);

  const best = rng ? cands[Math.floor(rng() * Math.min(3, cands.length))] : cands[0];
  const {
    i, r, pl, pw, rotated,
  } = best;
  plate.free.splice(i, 1);
  plate.pieces.push({
    x: r.x, y: r.y, l: pl, w: pw, rotated,
  });
  // Split the remainder along whichever leftover axis is SHORTER, so the long
  // strip survives whole. Splitting the other way dices the plate into offcuts
  // too small to be worth anything — as the DEFAULT. Under the `las` heuristic
  // the choice is inverted, which is exactly the layout family bssf/sas can
  // never reach (a tall column kept whole beside a row of short parts).
  const shorterFirst = (r.l - pl < r.w - pw);
  if (shorterFirst !== splitLonger) {
    if (r.l - pl > 0) plate.free.push({ x: r.x + pl, y: r.y, l: r.l - pl, w: pw });
    if (r.w - pw > 0) plate.free.push({ x: r.x, y: r.y + pw, l: r.l, w: r.w - pw });
  } else {
    if (r.l - pl > 0) plate.free.push({ x: r.x + pl, y: r.y, l: r.l - pl, w: r.w });
    if (r.w - pw > 0) plate.free.push({ x: r.x, y: r.y + pw, l: pl, w: r.w - pw });
  }
  plate.free = mergeFree(plate.free);
  return true;
}

/** 'any' (the default) is free rotation; anything else forbids the swapped turn. */
const canRotate = (grain) => (grain ?? 'any') === 'any';

/**
 * Merge two free rectangles into one, ONLY along a shared FULL edge — the
 * guillotine constraint. A partial-edge join would produce an L-shape and
 * pretend it is liftable in one piece, which no torch can actually cut.
 */
const MERGE_TOL = 1e-6;
const near = (a, b) => Math.abs(a - b) < MERGE_TOL;

function mergedRect(a, b) {
  if (near(a.y, b.y) && near(a.w, b.w)) {
    if (near(a.x + a.l, b.x)) return { x: a.x, y: a.y, l: a.l + b.l, w: a.w };
    if (near(b.x + b.l, a.x)) return { x: b.x, y: a.y, l: a.l + b.l, w: a.w };
  }
  if (near(a.x, b.x) && near(a.l, b.l)) {
    if (near(a.y + a.w, b.y)) return { x: a.x, y: a.y, l: a.l, w: a.w + b.w };
    if (near(b.y + b.w, a.y)) return { x: a.x, y: b.y, l: a.l, w: a.w + b.w };
  }
  return null;
}

/**
 * Fold adjacent free rectangles into one, or the free list grows on every
 * placement and a later, bigger part sees only slivers where a whole strip
 * was actually available.
 *
 * Runs to a fixed point: one merge can expose another (three same-height
 * strips in a row need two passes to become one). A pass-count bound looked
 * safe here but wasn't — each merge shrinks the list AND advances the pass
 * counter, so a chain of N rectangles collapsing to one stopped halfway.
 * Loop on "did this pass find a merge" instead; it can only run as many
 * times as the list has entries to lose, so it still terminates.
 */
function mergeFree(free) {
  let list = free;
  for (;;) {
    let combined = null;
    let ai = -1;
    let bi = -1;
    outer:
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const m = mergedRect(list[i], list[j]);
        if (m) { combined = m; ai = i; bi = j; break outer; }
      }
    }
    if (!combined) break;
    list = list.filter((_, k) => k !== ai && k !== bi);
    list.push(combined);
  }
  return list;
}

/**
 * Put as many of this row's pieces on the plate as will go.
 *
 * A ROW USED TO BE ALL-OR-NOTHING, and that was never a rule of the shop. Nobody
 * minds if ninety stiffeners come off one plate and fifty-four off another —
 * they go on the same pile either way. It was a rule of the data model: one part
 * row pointed at one plate, so the packer was made to honour something the
 * database happened to require.
 *
 * Measured on the KEPL order, removing it is worth almost nothing on its own —
 * 0.28 t across 690, which is inside the noise of a randomised search. It is
 * removed because POOLING needs it. Once identical parts are one demand line,
 * the biggest line on that order is 828 pieces, about fifteen plates' worth, and
 * all-or-nothing makes it unplaceable.
 *
 * @returns {{plate, placed:number}} `placed` is 0 when none would fit.
 */
export function placeSome(plate, row, wanted, rng = null, heur = null) {
  const trial = clonePlate(plate);
  const m = plate.margin ?? 0;
  const allowRotate = canRotate(row.grain);
  let placed = 0;
  while (placed < wanted) {
    // Inflated by the margin: what is reserved is the part plus its clearance.
    if (!placePiece(trial, row.length + m, row.width + m, rng, allowRotate, heur)) break;
    placed++;
  }
  if (!placed) return { plate, placed: 0 };
  // The row recorded on the plate carries the count that landed HERE, so a plate
  // still knows exactly what is cut from it.
  trial.rows.push({ ...row, qty: placed });
  return { plate: trial, placed };
}

/** All `qty` pieces of a row, or none. Used where a row must move whole. */
export function placeRow(plate, row, rng = null) {
  const { plate: next, placed } = placeSome(plate, row, row.qty, rng);
  return placed === row.qty ? next : null;
}

/** Does ONE piece of this row fit on an empty plate of this size? */
export const pieceFitsSpec = (row, spec, margin = DEFAULT_MARGIN) => {
  // Both inflated by the gap, so it cancels for a lone part: no edge margin.
  const l = row.length + margin; const w = row.width + margin;
  const L = spec.length + margin; const W = spec.width + margin;
  if (!canRotate(row.grain)) return l <= L + TOL && w <= W + TOL;
  return (l <= L + TOL && w <= W + TOL) || (l <= W + TOL && w <= L + TOL);
};

/**
 * How many pieces of this row an empty plate of `spec` holds.
 *
 * A ROW IS ATOMIC — one link, one nest_no, so all of its pieces land on one
 * plate or none do. Asking only whether ONE piece fits is therefore not the
 * question, and getting that wrong is not a near miss: a row of 7,212 shear
 * studs passed a one-piece check, could never actually be placed, and the
 * packer spun on it making no progress until a plate limit stopped it. The
 * count is what lets the caller say something useful instead.
 */
export function capacityOf(row, spec, margin = DEFAULT_MARGIN) {
  const plate = newPlate(spec, margin);
  const allowRotate = canRotate(row.grain);
  let n = 0;
  while (placePiece(plate, row.length + margin, row.width + margin, null, allowRotate)) n++;
  return n;
}

/** Do ALL of this row's pieces fit on one empty plate of this size? */
export const rowFitsSpec = (row, spec, margin = DEFAULT_MARGIN) =>
  pieceFitsSpec(row, spec, margin) && (row.qty <= 1 || capacityOf(row, spec, margin) >= row.qty);

/**
 * Fill one plate of `spec` with as many of `rows` as will go.
 *
 * Longest-side-first, which is what makes any greedy packer behave: the awkward
 * pieces are placed while the plate is still open, and the small ones fill in
 * around them rather than fragmenting it first.
 */
export function fillOne(spec, rows, rng = null, margin = DEFAULT_MARGIN, jitterPlacement = false, heur = null) {
  let plate = newPlate(spec, margin);
  const taken = new Map();
  const pool = [...rows].sort((x, y) => {
    const d = Math.max(y.length, y.width) - Math.max(x.length, x.width);
    return d !== 0 ? d : (y.length * y.width * y.qty) - (x.length * x.width * x.qty);
  });

  /**
   * WITH `rng`, TAKE A RANDOM ONE OF THE TOP FEW instead of always the biggest.
   *
   * Greedy is order-sensitive, and "biggest first" is only a good guess, not a
   * rule — sometimes the second-biggest first leaves a better remainder. This is
   * the standard GRASP trick: keep the greedy instinct, but let the choice
   * wobble among the near-equal candidates so repeated runs explore genuinely
   * different arrangements rather than recomputing one answer.
   *
   * `rng` null reproduces the deterministic packer exactly, which is what makes
   * restart 0 a guaranteed floor — more compute can never return a worse answer.
   */
  const TOP_K = 3;
  while (pool.length) {
    const i = rng ? Math.floor(rng() * Math.min(TOP_K, pool.length)) : 0;
    const [row] = pool.splice(i, 1);
    /**
     * PART of a row is a real answer now, not a failure — so `taken` counts
     * pieces rather than naming rows: the caller has to know this plate absorbed
     * 90 of the 144 wanted, so the other 54 can look for another plate.
     *
     * KEYED BY THE ROW OBJECT, NOT BY `row.key`, and that distinction cost 2,692
     * pieces. Once a row can be split, one pooled part exists as many plate-rows
     * all carrying the SAME key — 756 stiffeners are fourteen plate-rows of 56.
     * Ruin & recreate frees those back into one pool, and a map keyed by name
     * then reports one count for all fourteen: each of them subtracts 56 from
     * its own 56, every one reaches zero, and they leave the pool as finished
     * work that was never done. Silently, because nothing was left unplaced to
     * complain about. An object reference is unique per entry by construction.
     */
    const { plate: next, placed } = placeSome(plate, row, row.qty, jitterPlacement ? rng : null, heur);
    if (placed) { plate = next; taken.set(row, (taken.get(row) ?? 0) + placed); }
  }
  return { plate, taken };
}

/**
 * ── THE STRIP FILLER: two-stage guillotine with stacked columns ────────────
 *
 * The free-rectangle filler above places one piece at a time and lets the
 * shape of the leftover decide the next. That is a good general-purpose
 * instinct and a poor one for plate steel, where an order is a few DISTINCT
 * rectangles in large quantities — 828 stiffeners, 64 flange plates. A shop
 * nester lays those as STRIPS: a band across the sheet the height of one
 * part, filled end to end, with shorter parts stacked two or three high in
 * their own columns. Every cut is then a straight line edge to edge — first
 * the bands, then the columns, then the stacks — which is the three-stage
 * guillotine pattern a torch or a shear actually runs.
 *
 * HOW A STRIP IS FILLED: exactly, not greedily. Along the strip's length the
 * question "which columns, how many of each" is a one-dimensional knapsack
 * (maximise part area within L), and with a handful of part types it is cheap
 * to solve to optimality by dynamic programming — a few million cell updates
 * per strip. It is the mixing decision that matters most (four 2995 mm parts
 * plus one 1260 mm part fills 12000 mm to within 20 mm) and the one a greedy
 * "longest first" gets wrong on a tail.
 *
 * A STRIP THAT WORKS IS REPEATED. Once a band is solved it is laid again as
 * many times as the quantities and the sheet allow before anything is
 * re-solved, which is both what a nester does and what keeps this fast: a
 * sheet of fifteen identical bands costs one knapsack, not fifteen.
 *
 * BOTH SHEET ORIENTATIONS are tried — bands along the length and bands along
 * the width — and the fuller one is kept.
 *
 * WHAT IT RETURNS is the same plate shape as `fillOne`, including a `free`
 * list of the leftovers (the tail of each band and the unused band above the
 * last strip) so `consolidate`, `placeRow` and the remnant service can treat
 * the result like any other plate.
 */
export function fillOneStrips(spec, rows, rng = null, margin = DEFAULT_MARGIN, cache = null) {
  const g = margin;
  const areaOfRow = (r) => r.length * r.width;

  /*
   * THE KNAPSACK IS SOLVED ONCE FOR THE LONGEST SHEET IN PLAY and read back
   * for any shorter one: after every item has been considered, dp[len] is
   * optimal for EVERY capacity up to the length it was built for, so the
   * candidate sizes 12000, 12050 and 12100 share one table. `cache.maxL` is
   * that length, set by the caller that knows the whole candidate list.
   */
  const solveStrip = (L, h, rem) => {
    const Lint = Math.floor(L + TOL);
    const cacheKey = cache ? `${h}|${rem.join(',')}` : null;
    let table = cacheKey ? cache.get(cacheKey) : undefined;
    if (table && table.Lsolve < Lint) table = undefined;
    if (table === undefined) {
      table = buildStripTable(Math.max(Lint, Math.floor((cache?.maxL ?? 0) + TOL)), h, rem);
      if (cacheKey) {
        if (cache.size > 400) cache.clear();
        cache.set(cacheKey, table);
      }
    }
    if (!table) return null;
    return readStrip(table, Lint, h);
  };

  const buildStripTable = (Lint, h, rem) => {
    /*
     * Column types for this band: for each row still wanted, the orientation
     * that fills the band's height best (most stacked height used); a row
     * whose stated grain forbids turning gets only the one orientation.
     */
    const items = [];
    rows.forEach((r, i) => {
      if (rem[i] <= 0) return;
      const l = r.length + g; const w = r.width + g;
      const opts = [];
      if (w <= h + TOL && l <= Lint + TOL) opts.push({ a: l, b: w, rot: false });
      if (canRotate(r.grain) && l <= h + TOL && w <= Lint + TOL) opts.push({ a: w, b: l, rot: true });
      if (!opts.length) return;
      let best = null;
      for (const o of opts) {
        const k = Math.floor((h + TOL) / o.b);
        if (k < 1) continue;
        const fill = k * o.b;
        if (!best || fill > best.fill + TOL || (Math.abs(fill - best.fill) <= TOL && o.a < best.a)) best = { ...o, k, fill };
      }
      if (!best) return;
      const { a, b, rot, k } = best;
      const segLen = Math.ceil(a - 1e-9);
      const maxSegs = Math.floor(Lint / segLen);
      if (maxSegs < 1) return;
      const nFull = Math.min(Math.floor(rem[i] / k), maxSegs);
      const partial = rem[i] - nFull * k;
      // Binary splitting so a bounded count is a handful of 0/1 items.
      let left = nFull;
      for (let c = 1; left > 0; c *= 2) {
        const take = Math.min(c, left);
        items.push({ row: i, a, b, rot, segs: take, perSeg: k, len: segLen * take, value: take * k * areaOfRow(r) });
        left -= take;
      }
      if (partial > 0 && nFull < maxSegs) {
        items.push({ row: i, a, b, rot, segs: 1, perSeg: partial, len: segLen, value: partial * areaOfRow(r) });
      }
    });
    if (!items.length) return null;

    const dp = new Float64Array(Lint + 1);
    const choose = new Uint8Array(items.length * (Lint + 1));
    for (let t = 0; t < items.length; t += 1) {
      const it = items[t];
      const base = t * (Lint + 1);
      for (let len = Lint; len >= it.len; len -= 1) {
        const cand = dp[len - it.len] + it.value;
        if (cand > dp[len] + 1e-9) { dp[len] = cand; choose[base + len] = 1; }
      }
    }
    return { Lsolve: Lint, items, dp, choose };
  };

  const readStrip = (table, Lint, h) => {
    const { Lsolve, items, dp, choose } = table;
    // Reconstruct, grouped by row so a row's pieces sit side by side.
    let len = Lint;
    const picked = new Map();
    for (let t = items.length - 1; t >= 0; t -= 1) {
      if (!choose[t * (Lsolve + 1) + len]) continue;
      const it = items[t];
      const hit = picked.get(it.row) ?? { row: it.row, a: it.a, b: it.b, rot: it.rot, stacks: [] };
      for (let s = 0; s < it.segs; s += 1) hit.stacks.push(it.perSeg);
      picked.set(it.row, hit);
      len -= it.len;
    }
    if (!picked.size) return null;
    const used = new Array(rows.length).fill(0);
    let usedLen = 0;
    for (const p of picked.values()) {
      for (const k of p.stacks) used[p.row] += k;
      usedLen += p.stacks.length * Math.ceil(p.a - 1e-9);
    }
    return { h, value: dp[Lint], groups: [...picked.values()], used, usedLen };
  };

  const layOut = (L, W) => {
    const rem = rows.map((r) => r.qty);
    const pieces = []; const placedRows = []; const free = [];
    let y = 0;
    for (;;) {
      const Wr = W - y;
      const hs = new Set();
      let bigRowH = null; let bigRowArea = -1;
      rows.forEach((r, i) => {
        if (rem[i] <= 0) return;
        const l = r.length + g; const w = r.width + g;
        const fits = [];
        if (w <= Wr + TOL && l <= L + TOL) fits.push(w);
        if (canRotate(r.grain) && l <= Wr + TOL && w <= L + TOL) fits.push(l);
        if (!fits.length) return;
        for (const h of fits) hs.add(h);
        const a = areaOfRow(r) * rem[i];
        if (a > bigRowArea) { bigRowArea = a; bigRowH = Math.min(...fits); }
      });
      if (!hs.size) break;
      const tallest = [...hs].sort((a, b) => b - a);
      const tryH = new Set(tallest.slice(0, rng ? 3 : 2));
      if (bigRowH != null) tryH.add(bigRowH);

      let strip = null;
      const cands = [];
      for (const h of tryH) {
        const s = solveStrip(L, h, rem);
        if (s) cands.push(s);
      }
      if (!cands.length) break;
      // Fullest band wins; a seeded run may take the runner-up instead.
      cands.sort((a, b) => b.value - a.value);
      strip = rng ? cands[Math.floor(rng() * Math.min(2, cands.length))] : cands[0];

      // Repeat the band while quantities and height allow.
      let times = Math.floor((Wr + TOL) / strip.h);
      rows.forEach((_, i) => { if (strip.used[i] > 0) times = Math.min(times, Math.floor(rem[i] / strip.used[i])); });
      times = Math.max(1, times);
      for (let t = 0; t < times; t += 1) {
        let x = 0;
        for (const grp of strip.groups) {
          const r = rows[grp.row];
          const segLen = Math.ceil(grp.a - 1e-9);
          let count = 0;
          for (const k of grp.stacks) {
            for (let j = 0; j < k; j += 1) {
              pieces.push({ x, y: y + j * grp.b, l: grp.a, w: grp.b, rotated: grp.rot });
              count += 1;
            }
            x += segLen;
          }
          placedRows.push({ ...r, qty: count });
          rem[grp.row] -= count;
        }
        if (L - strip.usedLen > 0) free.push({ x: strip.usedLen, y, l: L - strip.usedLen, w: strip.h });
        y += strip.h;
      }
    }
    if (W - y > 0) free.push({ x: 0, y, l: L, w: W - y });
    return { pieces, placedRows, free, rem };
  };

  const L0 = spec.length + g; const W0 = spec.width + g;
  const along = layOut(L0, W0);
  const across = layOut(W0, L0);
  const areaPlaced = (o) => o.placedRows.reduce((s, r) => s + r.qty * areaOfRow(r), 0);
  const pick = areaPlaced(across) > areaPlaced(along) + TOL ? across : along;
  const transposed = pick === across;
  const swap = (q) => ({ x: q.y, y: q.x, l: q.w, w: q.l });

  const plate = newPlate(spec, margin);
  plate.pieces = transposed
    ? pick.pieces.map((p) => ({ ...swap(p), rotated: !p.rotated }))
    : pick.pieces;
  plate.rows = pick.placedRows;
  plate.free = mergeFree(transposed ? pick.free.map(swap) : pick.free);

  const taken = new Map();
  rows.forEach((r, i) => { const n = r.qty - pick.rem[i]; if (n > 0) taken.set(r, n); });
  return { plate, taken };
}

/**
 * Fill one plate the best way available: both fillers, keep the fuller.
 *
 * Neither filler dominates. Strips win on the big homogeneous groups and on
 * the tail (an exact knapsack along the band), free rectangles win when the
 * parts are all different sizes and a band would leave a ragged top edge.
 * Running both costs a few milliseconds per plate and can never lose to
 * either alone.
 *
 * @param {{jitterPlacement?:boolean, heur?:object, filler?:'freerect'|'strip'|'best', stripCache?:Map}} o
 */
export function fillPlate(spec, rows, rng = null, margin = DEFAULT_MARGIN, o = {}) {
  const filler = o.filler ?? 'best';
  if (filler === 'strip') return fillOneStrips(spec, rows, rng, margin, o.stripCache ?? null);
  const a = fillOne(spec, rows, rng, margin, o.jitterPlacement === true, o.heur ?? null);
  if (filler === 'freerect') return a;
  const b = fillOneStrips(spec, rows, rng, margin, o.stripCache ?? null);
  return usedArea(b.plate) > usedArea(a.plate) + TOL ? b : a;
}

/** Seeded, so a run is reproducible and a good answer can be got back. */
export function mulberry32(a) {
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * What a nesting costs: plate area BOUGHT. Fewer plates breaks a tie.
 *
 * A drop (`spec.available` set) is already paid for, so it scores 0 — counting
 * its area again would bias the search away from using material that is
 * sitting on the shelf, exactly backwards from the objective.
 */
const scoreOf = (res) => res.plates.reduce((a, p) => a + (p.spec.available != null ? 0 : areaOf(p)), 0);

/**
 * Second pass: empty the worst plates into the others, and drop them.
 *
 * THE GREEDY TAIL, which is what this exists for. The main loop commits a plate
 * and never reopens it, so rows left over at the end of a group cannot join a
 * plate that is already closed — they open one of their own. On the KEPL order
 * that produced N-019: three 2995x178 stiffeners alone on a 24 m2 sheet, 7%
 * used, while dozens of identical stiffeners sat on earlier plates.
 *
 * It is NOT a plate-size problem. The smallest 12 mm plate that can hold a
 * 2995 mm part is 2000x12000; the next size down is 2300x2500 and too short.
 * The packer chose correctly and still wasted 22 m2, because the only real
 * answer was to put those three on a plate that was already open.
 *
 * WORST FIRST, and all-or-nothing. A donor is emptied only if EVERY one of its
 * rows finds a home, because half-emptying a plate still buys the plate. Rows
 * keep their atomicity — a row moves whole or not at all.
 *
 * Targets are tried in order of most free area, which is where a row is most
 * likely to fit. Each successful move is kept on a trial copy so a donor that
 * turns out to be immovable leaves nothing behind.
 */
export function consolidate(plates) {
  // Worst first: the emptiest plate is the one most worth eliminating.
  const donors = [...plates].sort((a, b) => utilisation(a) - utilisation(b));
  let live = [...plates];

  for (const donor of donors) {
    if (live.length <= 1) break;
    if (!live.includes(donor)) continue;

    const targets = live
      .filter((p) => p !== donor)
      .sort((a, b) => (areaOf(b) - usedArea(b)) - (areaOf(a) - usedArea(a)));

    // Trial copies, so a failed redistribution changes nothing.
    const trial = new Map(targets.map((t) => [t, t]));
    let allMoved = true;
    for (const row of donor.rows) {
      let moved = false;
      for (const t of targets) {
        const next = placeRow(trial.get(t), row);
        if (next) { trial.set(t, next); moved = true; break; }
      }
      if (!moved) { allMoved = false; break; }
    }
    if (!allMoved) continue;

    live = live
      .filter((p) => p !== donor)
      .map((p) => trial.get(p) ?? p);
  }
  return live;
}

/**
 * Nest `rows` onto plates chosen from `specs`.
 *
 * @param {PartRow[]} rows
 * @param {PlateSpec[]} specs
 * @param {NestOptions} [opts]
 * @returns {{plates:Array, unplaced:Array<{row:PartRow, reason:string}>}}
 */
function nestOnce(rows, specs, opts = {}, rng = null) {
  const maxPlates = opts.maxPlates ?? 5000;
  const margin = opts.kerfMm ?? opts.margin ?? DEFAULT_CUT_GAP_MM;
  const plates = [];
  const unplaced = [];

  /*
   * BED SIZE. A candidate too big for the cutting machine in EVERY orientation
   * is not offered at all — same treatment as a plate size nobody stocks. Only
   * excludes when BOTH dimensions are known; either missing means "no limit
   * known", which behaves exactly as before a bed size was ever entered.
   */
  const { bedLengthMm, bedWidthMm } = opts;
  if (bedLengthMm != null && bedWidthMm != null) {
    specs = specs.filter((s) => (s.length <= bedLengthMm && s.width <= bedWidthMm)
      || (s.length <= bedWidthMm && s.width <= bedLengthMm));
  }
  /**
   * How many of each spec are left to open.
   *
   * A catalogue size is unlimited — you can buy another. An offcut is ONE
   * piece of steel, and a packer that did not know the difference would
   * cheerfully lay six nests onto the same drop and report a beautiful
   * utilisation for material that exists once.
   */
  const stockOf = new Map(specs.map((s) => [s.id, s.available ?? Infinity]));

  // A row that fits on no candidate size can never be placed, and saying so up
  // front is more useful than letting the loop discover it once per pass. This
  // is the honest answer to "the drawing needs a plate nobody sells".
  const biggestLong = Math.max(...specs.map((s) => Math.max(s.length, s.width)));
  const biggestShort = Math.max(...specs.map((s) => Math.min(s.length, s.width)));

  /**
   * ONE PIECE IS THE TEST NOW, not the whole row.
   *
   * A row of 828 stiffeners is fifteen plates' worth and perfectly ordinary; it
   * used to be rejected up front with "this row has to be split before it can be
   * nested", which was the packer apologising for a schema rule. The only
   * genuine impossibility left is a PIECE bigger than any plate sold — and that
   * is a real answer: the drawing needs steel nobody stocks.
   */
  let remaining = [];
  for (const r of rows) {
    if (specs.some((s) => pieceFitsSpec(r, s, margin))) { remaining.push(r); continue; }
    unplaced.push({
      row: r,
      reason: `${r.length} x ${r.width} mm does not fit on any available plate `
            + `(largest is ${biggestLong} x ${biggestShort} mm)`,
    });
  }

  while (remaining.length && plates.length < maxPlates) {
    /**
     * MATERIAL ALREADY PAID FOR IS TRIED FIRST, AND IN ITS OWN CONTEST.
     *
     * The objective is not the tidiest plate, it is the least steel BOUGHT — and
     * an offcut has already been bought. Judging a drop against a fresh plate on
     * utilisation alone loses that: a 12 m sheet cut cleverly will out-score a
     * drop almost every time, and the drop rusts in the yard while the shop buys
     * its area again.
     *
     * So preferred specs run as a separate round. Within that round the tightest
     * fit still wins, which is what stops a big drop being burnt on one small
     * part while a smaller drop would have done.
     */
    const rounds = [specs.filter((s) => s.preferred), specs.filter((s) => !s.preferred)];
    let best = null;
    /*
     * ONE HEURISTIC PAIR PER PLATE on a seeded run, so a restart explores a
     * different placement FAMILY and not just a different row order. The
     * deterministic run (rng null) keeps the default pair, which is what makes
     * restart 0 the floor every other restart is measured against.
     *
     * The strip cache lives for this one plate: every candidate spec sees the
     * same remaining parts, and many share a length, so a band solved for one
     * spec is reused by the next.
     */
    const stripCache = new Map();
    stripCache.maxL = Math.max(...specs.map((s) => Math.max(s.length, s.width))) + margin;
    const filler = opts.filler ?? 'best';
    const fillOpts = {
      jitterPlacement: opts.jitterPlacement === true,
      heur: rng && opts.jitterPlacement === true ? pickHeuristic(rng) : null,
      filler: filler === 'best' ? 'freerect' : filler,
      stripCache,
    };
    const keyOf = (plate) => [Math.round(utilisation(plate) * 1000), Math.round(usedArea(plate))];
    const better = (k, b) => !b || k[0] > b.key[0] || (k[0] === b.key[0] && k[1] > b.key[1]);
    for (const round of rounds) {
      const cands = [];
      for (const spec of round) {
        if ((stockOf.get(spec.id) ?? 0) <= 0) continue;
        const { plate, taken } = fillPlate(spec, remaining, rng, margin, fillOpts);
        if (!taken.size) continue;
        cands.push({ spec, plate, taken, key: keyOf(plate) });
      }
      /*
       * STRIPS ON THE SHORTLIST ONLY. The strip filler is an exact solve per
       * band and costs several times a free-rectangle fill; run on every
       * candidate size it dominated the whole search. Run on the four sizes
       * the cheap filler already rates highest it finds the same improvements
       * — a size the free-rectangle fill rates poorly is rarely the one a band
       * layout rescues — at a fraction of the cost.
       */
      if (filler === 'best' && cands.length) {
        cands.sort((a, b) => (b.key[0] - a.key[0]) || (b.key[1] - a.key[1]));
        for (const c of cands.slice(0, 4)) {
          const alt = fillOneStrips(c.spec, remaining, rng, margin, stripCache);
          if (usedArea(alt.plate) > usedArea(c.plate) + TOL) { c.plate = alt.plate; c.taken = alt.taken; c.key = keyOf(alt.plate); }
        }
      }
      for (const c of cands) {
        // Utilisation decides, but two plates within a hair of each other are not
        // meaningfully different and the tie should go to the one that absorbs
        // more work — that is one fewer plate overall.
        if (better(c.key, best)) best = c;
      }
      // A preferred plate that took anything ends the contest — nothing a fresh
      // plate could score is worth buying steel to achieve.
      if (best) break;
    }
    // Every remaining row fits SOME spec (checked above), so a pass that places
    // nothing means the packer is not making progress — stop rather than spin.
    if (!best) {
      for (const r of remaining) unplaced.push({ row: r, reason: 'the packer could not place this row' });
      // Emptied, not just broken out of: leaving these in `remaining` reported
      // every one of them a SECOND time below under a plate-limit reason that
      // had nothing to do with it.
      remaining = [];
      break;
    }
    plates.push(best.plate);
    stockOf.set(best.plate.spec.id, (stockOf.get(best.plate.spec.id) ?? Infinity) - 1);
    /**
     * A row leaves the pool only when every piece of it has landed.
     *
     * The plate that was just committed may have absorbed 90 of 144; the other
     * 54 are still work to do and go back into the contest for the next plate.
     */
    remaining = remaining.flatMap((r) => {
      const done = best.taken.get(r) ?? 0;
      if (!done) return [r];
      const left = r.qty - done;
      return left > 0 ? [{ ...r, qty: left }] : [];
    });
  }

  if (remaining.length) {
    for (const r of remaining) unplaced.push({ row: r, reason: `plate limit of ${maxPlates} reached` });
  }
  // The greedy loop never reopens a plate, so its leftovers each opened one.
  // This is where those get absorbed back.
  return { plates: consolidate(plates), unplaced };
}

/**
 * THE DETERMINISTIC FLOOR, taken twice. The fuller plate is not always the
 * better order — a strip that packs 60 stiffeners can leave a tail the
 * free-rectangle fill would not have — so restart 0 is run with each filler
 * and the better TOTAL is the floor every seeded restart must beat.
 */
function floorSolution(rows, specs, opts) {
  const a = nestOnce(rows, specs, { ...opts, filler: 'freerect' }, null);
  if ((opts.filler ?? 'best') === 'freerect') return a;
  const b = nestOnce(rows, specs, opts, null);
  if (b.unplaced.length > a.unplaced.length) return a;
  if (a.unplaced.length > b.unplaced.length) return b;
  const sa = scoreOf(a); const sb = scoreOf(b);
  return sb < sa || (sb === sa && b.plates.length < a.plates.length) ? b : a;
}

/**
 * Nest, trying it many ways and keeping the best.
 *
 * ONE GREEDY RUN IS ONE GUESS. The order parts are placed in decides the
 * answer, and "biggest first" is a good instinct rather than a rule. Running it
 * again with the choice wobbled among the near-equal candidates explores a
 * genuinely different arrangement, and the best of many is reliably better than
 * the first.
 *
 * This is the cheapest way to convert compute into steel. There is no new
 * theory, it cannot return a worse answer than the deterministic packer (run 0
 * IS the deterministic packer, and only an improvement replaces it), and every
 * restart is independent — so it parallelises across cores whenever that is
 * worth wiring up.
 *
 * SCORED ON PLATE AREA BOUGHT, not on mean utilisation. Utilisation is a
 * per-plate ratio and can be improved by using more plates; area bought is the
 * money.
 *
 * `restarts` is a budget, not a target: pass what the clock allows.
 *
 * `opts.deadline` stops the restarts early. The FIRST pack always runs whatever
 * the clock says — an expired budget must still return a layout, not null.
 */
export function nest(rows, specs, opts = {}) {
  const restarts = Math.max(1, opts.restarts ?? 1);
  const seed = opts.seed ?? 1;
  const deadline = opts.deadline ?? Infinity;

  let best = floorSolution(rows, specs, opts);
  let bestScore = scoreOf(best);

  for (let i = 1; i < restarts; i += 1) {
    if (Date.now() >= deadline) break;
    const res = nestOnce(rows, specs, opts, mulberry32(seed + i * 0x9E3779B1));
    // A run that strands a row is not an improvement whatever it scores.
    if (res.unplaced.length > best.unplaced.length) continue;
    const score = scoreOf(res);
    if (score < bestScore
      || (score === bestScore && res.plates.length < best.plates.length)) {
      best = res; bestScore = score;
    }
  }
  return best;
}

/**
 * Tear up the worst plates and rebuild only those parts.
 *
 * WHY THIS BEATS RESTARTING. A restart throws the whole layout away, so a
 * thousand of them only ever reach a thousand complete guesses — and 90% of
 * each guess was already fine. This keeps the good plates and spends every
 * second on the part that is actually wrong. Measured on KEPL it matched a
 * thousand restarts in a sixth of the time, then beat them.
 *
 * The tear-up is biased towards the EMPTIEST plates, because a full plate
 * rebuilt comes back as the same plate. Kept only when the area falls, so it
 * can never end worse than the solution it started from.
 *
 * WHAT IT IS NOT: a way to discover the mixed sheet. Putting a web and forty
 * stiffeners on one plate is where the efficiency lives, and this never has to
 * rediscover that — it inherits it from the greedy start and protects it. Two
 * strategies that build mixing from scratch (smallest-plate-first, and merging
 * pairs upward) were both ~60 t WORSE than plain greedy for exactly that reason.
 */
export function ruinRecreate(rows, specs, opts = {}, deadline, seed = 7) {
  const rng = mulberry32(seed);
  /**
   * THE OPENING SOLUTION IS INSIDE THE BUDGET TOO.
   *
   * It used to run eight restarts unconditionally before the clock was ever
   * consulted, which is fine for one call and ruinous for sixteen: Deep spent
   * its whole allowance on opening solutions and then overran it. Measured
   * through the UI against the live backend, a 1,090-part Deep run took eleven
   * to thirteen minutes against a stated five. A budget that only governs the
   * repair loop is not a budget.
   */
  let best = nest(rows, specs, { ...opts, restarts: 8, seed, deadline });
  let bestScore = scoreOf(best);

  while (Date.now() < deadline) {
    const keep = [];
    const freed = [];
    for (const p of best.plates) {
      const emptiness = 1 - usedArea(p) / areaOf(p);
      if (rng() < 0.15 + emptiness) freed.push(...p.rows); else keep.push(p);
    }
    if (!freed.length) continue;

    /*
     * A DROP KEPT BY ANOTHER PLATE IS NOT A CANDIDATE HERE. `shrinkPlates`
     * already refuses to touch an offcut for the same reason (§13 "An offcut
     * is a stock piece, not a plate"): it is ONE physical piece, and offering
     * it to the repair loop while a KEPT plate still stands on it would let
     * two plates in the same result believe they both have it.
     */
    const keptOffcutIds = new Set(
      keep.filter((p) => p.spec.available != null).map((p) => p.spec.id),
    );
    const availableSpecs = keptOffcutIds.size
      ? specs.filter((s) => !(s.available != null && keptOffcutIds.has(s.id)))
      : specs;

    const redone = nest(freed, availableSpecs, {
      ...opts, restarts: 4, seed: Math.floor(rng() * 1e9), deadline,
    });
    if (redone.unplaced.length) continue;

    const score = keep.reduce((a, p) => a + areaOf(p), 0)
      + redone.plates.reduce((a, p) => a + areaOf(p), 0);
    if (score < bestScore) {
      best = { plates: [...keep, ...redone.plates], unplaced: best.unplaced };
      bestScore = score;
    }
  }
  return best;
}

/**
 * Several independent ruin & recreate runs, budget split, best kept.
 *
 * One long run improves ONE arrangement and can settle into a shape it cannot
 * dig out of; several shorter runs each open somewhere different, so a bad
 * start costs a slice of the budget rather than all of it.
 *
 * The split is the catch. Every start pays for its own initial solution before
 * any repair happens, so past some count each start is doing nothing but that
 * and multi-start collapses into plain restarts — the weaker search. Four is
 * what measured best; this is not a dial to turn up indefinitely.
 */
export function multiStartNest(rows, specs, opts = {}, totalMs, starts = 4) {
  const slice = Math.max(1, totalMs / Math.max(1, starts));
  /**
   * The whole call's deadline, not just each slice's.
   *
   * A start whose opening solution overruns its slice used to steal the time
   * from nobody — every later start still got its own full slice, so sixteen
   * starts could take several times the stated budget. Now a start that would
   * begin after the overall deadline simply does not begin, and the last one
   * gets what is left rather than a fresh slice.
   *
   * `i === 0` runs regardless: an allowance too small for even one start still
   * has to return a nesting.
   */
  const overall = Date.now() + totalMs;
  let best = null;
  let bestScore = Infinity;
  for (let i = 0; i < starts; i += 1) {
    if (i > 0 && Date.now() >= overall) break;
    const until = Math.min(Date.now() + slice, overall);
    const r = ruinRecreate(rows, specs, opts, until, 1000 + i * 7919);
    const score = scoreOf(r);
    if (score < bestScore) { best = r; bestScore = score; }
  }
  return best;
}

/**
 * HOW HARD TO LOOK — the three settings a person actually chooses between.
 *
 * Measured on the KEPL order (1,090 parts) at the shop's real 2 mm cutting gap.
 * Steel is ~Rs 85,000 a tonne, so the third column is what the choice is worth:
 *
 *   quick      ~5 s    697.15 t      —            still editing the BOQ
 *   standard   ~60 s   691.03 t   6.12 t saved    the real nesting run
 *   deep      ~300 s   690.57 t   6.58 t saved    before a large purchase
 *
 * Standard is the default because it captures 93% of the available saving in a
 * fifth of the time. Deep buys the last 0.46 t — about Rs 39,000, worth having
 * on a big job and not worth waiting for on a small one.
 *
 * There is very little beyond deep. Everything good converges near 690.6 t and
 * the zero-clearance floor is 689.87 t, so under a tonne of headroom remains in
 * this approach. More is a constraint question, not a compute question.
 */
export const EFFORT_LEVELS = {
  quick: { label: 'Quick', restarts: 4, budgetMs: 0 },
  standard: { label: 'Standard', restarts: 8, budgetMs: 60_000 },
  /**
   * SIXTEEN STARTS WITH ORIENTATION SEARCH — measured, and both halves earned it.
   *
   *   x4  no-orient   690.59 t      x4  + orient   690.24 t
   *   x8  no-orient   690.59 t      x8  + orient   690.36 t
   *                                 x16 + orient   690.00 t   <- best
   *                                 x32 + orient   690.28 t
   *
   * The two orientation-off rows land on exactly the same tonnage and the same
   * 126 plates, so more starts alone buy nothing at all; every gain past four
   * comes from letting a part turn. Orientation looked worthless at one and
   * four starts and only showed up once the search was wide enough to use it.
   *
   * Sixteen is the turning point. At thirty-two the budget is split so thin
   * that each start does little beyond its opening solution, and multi-start
   * degenerates into plain restarts — which measured worse.
   *
   * Runs long: the budget is per start, so 300s of allowance takes ~430s wall.
   */
  deep: {
    label: 'Deep', restarts: 8, budgetMs: 300_000, starts: 16, jitterPlacement: true,
  },
};

/**
 * Nest at a named effort. `budgetMs` is the whole call's allowance; the caller
 * divides it across groups so that "standard" means a minute for the ORDER, not
 * a minute per thickness.
 */
export function nestAtEffort(rows, specs, opts = {}, effort = 'standard', budgetMs = null) {
  const level = EFFORT_LEVELS[effort] ?? EFFORT_LEVELS.standard;
  const ms = budgetMs ?? level.budgetMs;
  if (!ms) return nest(rows, specs, { ...opts, restarts: level.restarts });
  const withJitter = { ...opts, jitterPlacement: level.jitterPlacement === true };
  if (level.starts) return multiStartNest(rows, specs, withJitter, ms, level.starts);
  return ruinRecreate(rows, specs, withJitter, Date.now() + ms);
}

/**
 * Re-derive whether a finished nesting holds, reading ONLY the final assignment.
 *
 * Deliberately not reusing the packer's own bookkeeping: a packer with a bug
 * reports success with the same bug. This takes row -> plate size and asks the
 * two questions that are impossibilities rather than opinions — does every part
 * fit inside its plate in some orientation, and is any plate asked for more
 * area than it has.
 *
 * EACH PLATE'S FULL ROW SET IS REPACKED TOGETHER, not one row at a time. §13
 * "A part row is ATOMIC to one plate, so 'does it fit' is not a question about
 * one piece" — the same logic applies one level up, to everything a plate
 * actually carries: checking row A alone against an EMPTY plate says nothing
 * about whether row B, already sharing that sheet, leaves room for it.
 */
export function verify(plates) {
  const problems = [];
  for (const p of plates) {
    const m = p.margin ?? 0;
    const wanted = p.rows.reduce((s, r) => s + r.qty, 0);
    if (Array.isArray(p.pieces) && p.pieces.length && wanted > 0) {
      /*
       * THE LAYOUT ITSELF, WHEN THERE IS ONE. A plate that carries its pieces
       * is checked exactly — every piece inside the sheet, no two overlapping,
       * and the pieces the size and number the rows say. This is the check
       * that matters: it is deterministic, it cannot refuse a layout the
       * search found by luck, and it cannot pass one that does not fit.
       */
      problems.push(...verifyLayout(p, m));
    } else if (p.rows.length) {
      /*
       * NO LAYOUT ON RECORD (a hand-edited plan, an older saved nest) — re-pack
       * the plate's full row set from empty with the same fillers the search
       * uses. This can still refuse a layout that was found by a lucky seed,
       * which is exactly why layouts are carried whenever they exist.
       */
      const one = fillPlate(p.spec, p.rows, null, m, { filler: 'best' });
      const placed = [...one.taken.values()].reduce((s, n) => s + n, 0);
      let ok = placed === wanted;
      if (!ok) {
        const trial = nest(p.rows, [p.spec], { margin: m, restarts: 8, jitterPlacement: true });
        ok = !trial.unplaced.length && trial.plates.length === 1;
      }
      if (!ok) {
        for (const r of p.rows) {
          problems.push(`${r.key} is ${r.length}x${r.width} on a ${p.spec.length}x${p.spec.width} plate`);
        }
      }
    }
    if (usedArea(p) > areaOf(p) + TOL) {
      problems.push(`a ${p.spec.length}x${p.spec.width} plate holds `
        + `${(usedArea(p) / 1e6).toFixed(2)} m2 of part on ${(areaOf(p) / 1e6).toFixed(2)} m2 of plate`);
    }
  }
  return problems;
}

/**
 * Check a plate's recorded pieces against its sheet and its rows.
 *
 * Pieces are INFLATED rectangles (part + gap), as the fillers record them, on
 * a sheet inflated by the same gap — so touching the rim is fine and two
 * pieces may touch each other only through the gap. A piece may carry a `key`
 * (the accept path sends them that way); otherwise pieces are matched to rows
 * in the order they were laid, which is how every filler here emits them.
 */
export function verifyLayout(p, m = p.margin ?? 0) {
  const problems = [];
  const L = p.spec.length + m; const W = p.spec.width + m;
  const label = `${p.spec.length}x${p.spec.width} plate`;
  const pieces = p.pieces;

  for (const q of pieces) {
    if (q.x < -TOL || q.y < -TOL || q.x + q.l > L + TOL || q.y + q.w > W + TOL) {
      problems.push(`a ${(q.l - m)}x${(q.w - m)} piece at ${Math.round(q.x)},${Math.round(q.y)} runs off the ${label}`);
    }
  }
  for (let i = 0; i < pieces.length; i += 1) {
    const a = pieces[i];
    for (let j = i + 1; j < pieces.length; j += 1) {
      const b = pieces[j];
      if (a.x < b.x + b.l - TOL && b.x < a.x + a.l - TOL && a.y < b.y + b.w - TOL && b.y < a.y + a.w - TOL) {
        problems.push(`two pieces overlap at ${Math.round(Math.max(a.x, b.x))},${Math.round(Math.max(a.y, b.y))} on the ${label}`);
        if (problems.length > 12) return problems;
      }
    }
  }

  // The pieces must be the rows: same count and same size per row.
  const sameSize = (q, r) => {
    const l = r.length + m; const w = r.width + m;
    return (Math.abs(q.l - l) <= TOL && Math.abs(q.w - w) <= TOL)
      || (Math.abs(q.l - w) <= TOL && Math.abs(q.w - l) <= TOL);
  };
  const keyed = pieces.every((q) => q.key != null);
  if (keyed) {
    const byKey = new Map();
    for (const q of pieces) byKey.set(String(q.key), [...(byKey.get(String(q.key)) ?? []), q]);
    const wantByKey = new Map();
    for (const r of p.rows) wantByKey.set(String(r.key), (wantByKey.get(String(r.key)) ?? 0) + r.qty);
    for (const [k, n] of wantByKey) {
      const have = byKey.get(k) ?? [];
      if (have.length !== n) problems.push(`${k}: ${n} wanted on the ${label} but the layout shows ${have.length}`);
      const row = p.rows.find((r) => String(r.key) === k);
      if (row && have.some((q) => !sameSize(q, row))) problems.push(`${k}: a piece in the layout is not ${row.length}x${row.width}`);
    }
    for (const k of byKey.keys()) if (!wantByKey.has(k)) problems.push(`${k}: in the layout but not on the ${label}'s rows`);
  } else {
    let cursor = 0;
    for (const r of p.rows) {
      for (let i = 0; i < r.qty; i += 1) {
        const q = pieces[cursor]; cursor += 1;
        if (!q) { problems.push(`${r.key}: the layout is short of pieces on the ${label}`); break; }
        if (!sameSize(q, r)) { problems.push(`${r.key}: piece ${cursor} is not ${r.length}x${r.width}`); break; }
      }
    }
    if (cursor < pieces.length) problems.push(`the ${label} shows ${pieces.length - cursor} more pieces than its rows`);
  }
  return problems;
}

/**
 * WHAT SHEET SIZE WOULD HAVE HELPED — the waste that is the CATALOGUE's, not
 * the packer's.
 *
 * On the KEPL order the single biggest loss is 16 t of 28 mm: forty webs, each
 * 12000 x 2995, and the only sheet wide enough is 3100. A 105 mm strip off
 * every plate, and no arrangement can touch it. That is a purchasing answer —
 * ask the mill for 3000 wide — and the only way anyone finds out is if the
 * packer says so.
 *
 * Per plate, the bounding box of what landed (rounded up to `step`) is the
 * sheet it actually needed. Plates that needed the same box off the same spec
 * are grouped, and a group is reported when the difference is worth having.
 *
 * @returns {Array<{specId, specLength, specWidth, plates, length, width, savingMm2, savingPct}>}
 */
export function sizeAdvice(plates, margin = DEFAULT_CUT_GAP_MM, { step = 50, minPct = 2 } = {}) {
  const groups = new Map();
  for (const p of plates) {
    if (p.spec.available != null || !p.pieces?.length) continue;
    let maxX = 0; let maxY = 0;
    for (const q of p.pieces) { maxX = Math.max(maxX, q.x + q.l); maxY = Math.max(maxY, q.y + q.w); }
    // Deflate the far edge (the last piece's gap is not steel) and round up.
    const need = (v) => Math.ceil(Math.max(0, v - margin) / step) * step;
    const l = Math.min(p.spec.length, need(maxX));
    const w = Math.min(p.spec.width, need(maxY));
    const key = `${p.spec.id}|${l}|${w}`;
    const hit = groups.get(key) ?? {
      specId: p.spec.id, specLength: p.spec.length, specWidth: p.spec.width, plates: 0, length: l, width: w,
    };
    hit.plates += 1;
    groups.set(key, hit);
  }
  /*
   * ONE ANSWER PER WIDTH. A mill sells plate by width and cuts to length, so
   * "16 sheets need 11650 x 3000 and 24 need 12000 x 3000" is one purchasing
   * question — 3000 wide — asked twice. Sheets off the same spec that want
   * the same width are merged, at the longer length.
   */
  const byWidth = new Map();
  for (const gp of groups.values()) {
    const key = `${gp.specId}|${gp.width}`;
    const hit = byWidth.get(key);
    if (!hit) byWidth.set(key, { ...gp });
    else { hit.plates += gp.plates; hit.length = Math.max(hit.length, gp.length); }
  }
  const out = [];
  for (const gp of byWidth.values()) {
    const per = gp.specLength * gp.specWidth - gp.length * gp.width;
    const pct = 100 * per / (gp.specLength * gp.specWidth);
    if (pct < minPct) continue;
    out.push({ ...gp, savingMm2: per * gp.plates, savingPct: Math.round(pct * 10) / 10 });
  }
  return out.sort((a, b) => b.savingMm2 - a.savingMm2);
}

/**
 * SHRINK EACH PLATE TO THE SMALLEST SHEET THAT STILL HOLDS WHAT IS ON IT.
 *
 * ── THE GAP THIS FILLS ───────────────────────────────────────────────────────
 *
 * The greedy loop CHOOSES a sheet size and then fills it. Whatever it happens
 * to choose first is what gets bought, and it never revisits that choice — so a
 * sheet picked because it was the best home for a big web plate keeps its full
 * size even after the web turns out to be all it received.
 *
 * `consolidate` does not catch this. It moves rows OFF near-empty plates to
 * delete them entirely, which is a different move: it reduces the plate COUNT.
 * This reduces the plate SIZE, on plates that are staying.
 *
 * ── WHY IT CANNOT MAKE THINGS WORSE ──────────────────────────────────────────
 *
 * A swap only happens when every row currently on the plate is re-placed on the
 * smaller sheet, and only onto a sheet of strictly smaller area. Nothing is
 * stranded and nothing grows, so area bought falls or stays put.
 *
 * ── OFFCUTS ARE NOT SHRINK TARGETS ───────────────────────────────────────────
 *
 * A drop is ONE physical piece of steel, and two plates shrinking onto the same
 * drop would both believe they had it. Counting that correctly means tracking
 * availability across the whole solution, which is worth doing and is not this
 * function. Catalogue sizes can be bought again, so they have no such problem.
 */
export function shrinkPlates(plates, specs, margin = DEFAULT_CUT_GAP_MM) {
  const buyable = specs.filter((s) => s.available == null);
  if (!buyable.length) return plates;

  return plates.map((p) => {
    // An offcut already costs nothing; shrinking it saves nothing.
    if (p.spec.available != null) return p;

    const here = areaOf(p);
    const smaller = buyable
      .filter((s) => s.length * s.width < here)
      .sort((a, b) => (a.length * a.width) - (b.length * b.width));

    const wanted = p.rows.reduce((s, r) => s + r.qty, 0);
    for (const s of smaller) {
      // Both fillers, from empty — a strip layout often fits a sheet the
      // one-row-at-a-time re-placement cannot.
      const trial = fillPlate(s, p.rows, null, margin, { filler: 'best' });
      const placed = [...trial.taken.values()].reduce((a, n) => a + n, 0);
      // Smallest first, so the first that fits is the best that fits.
      if (placed === wanted) return trial.plate;
    }
    return p;
  });
}

/**
 * `nest`, but it lets the server breathe.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * `nest` is a tight synchronous loop, and Node runs one thing at a time. At a
 * few dozen restarts that is nobody's problem. At the levels this is now asked
 * for — 200, 500, 2000 — a single nesting request holds the event loop for tens
 * of seconds to minutes, and EVERY other request on the server waits behind it.
 * Not the nesting screen: every screen, for everyone. Measured in production
 * with /health, which touches nothing, timing out at sixty seconds.
 *
 * The work is unchanged and so is the answer — same seed, same restarts, same
 * layout. All this does is hand control back between restarts so the runtime can
 * serve whatever else has arrived before carrying on.
 *
 * `setImmediate` rather than a timer: it runs after pending I/O callbacks, which
 * is exactly "let the queued requests through, then continue".
 */
const breathe = () => new Promise((resolve) => { setImmediate(resolve); });

/** How many restarts to run between breaths. Small enough to stay responsive. */
const BREATHE_EVERY = 4;

export async function nestAsync(rows, specs, opts = {}) {
  const restarts = Math.max(1, opts.restarts ?? 1);
  const seed = opts.seed ?? 1;
  const deadline = opts.deadline ?? Infinity;

  let best = floorSolution(rows, specs, opts);
  let bestScore = scoreOf(best);

  for (let i = 1; i < restarts; i += 1) {
    if (Date.now() >= deadline) break;
    if (i % BREATHE_EVERY === 0) await breathe();

    const res = nestOnce(rows, specs, opts, mulberry32(seed + i * 0x9E3779B1));
    // A run that strands a row is not an improvement whatever it scores.
    if (res.unplaced.length > best.unplaced.length) continue;
    const score = scoreOf(res);
    if (score < bestScore
      || (score === bestScore && res.plates.length < best.plates.length)) {
      best = res; bestScore = score;
    }
  }
  return best;
}

/**
 * `ruinRecreate`, breathing. Same search, same seed, same answer; control is
 * handed back to the event loop every few repairs so the server keeps
 * answering while a deep run spends its minutes. `onProgress(fraction)` is
 * called on the same cadence so a run row can say how far along it is.
 *
 * THE REPAIR REPACKS WITH THE SAME FILLERS AS THE OPENING SOLUTION and runs
 * `consolidate` over the joined result, so a freed row can land on a kept
 * plate's leftover rather than only on the plates it was freed with.
 */
export async function ruinRecreateAsync(rows, specs, opts = {}, deadline, seed = 7, onProgress = null) {
  const rng = mulberry32(seed);
  const startedAt = Date.now();
  let best = await nestAsync(rows, specs, { ...opts, restarts: 8, seed, deadline });
  let bestScore = scoreOf(best);
  let iter = 0;

  while (Date.now() < deadline) {
    iter += 1;
    if (iter % BREATHE_EVERY === 0) {
      await breathe();
      if (onProgress) onProgress(Math.min(1, (Date.now() - startedAt) / Math.max(1, deadline - startedAt)));
    }
    const keep = [];
    const freed = [];
    for (const p of best.plates) {
      const emptiness = 1 - usedArea(p) / areaOf(p);
      if (rng() < 0.15 + emptiness) freed.push(...p.rows); else keep.push(p);
    }
    if (!freed.length) continue;

    const keptOffcutIds = new Set(keep.filter((p) => p.spec.available != null).map((p) => p.spec.id));
    const availableSpecs = keptOffcutIds.size
      ? specs.filter((s) => !(s.available != null && keptOffcutIds.has(s.id)))
      : specs;

    const redone = nestOnce(freed, availableSpecs, opts, mulberry32(Math.floor(rng() * 1e9)));
    if (redone.unplaced.length) continue;

    const joined = consolidate([...keep, ...redone.plates]);
    const score = joined.reduce((a, p) => a + (p.spec.available != null ? 0 : areaOf(p)), 0);
    if (score < bestScore || (score === bestScore && joined.length < best.plates.length)) {
      best = { plates: joined, unplaced: best.unplaced };
      bestScore = score;
    }
  }
  return best;
}

/** `multiStartNest`, breathing — see that function for why four starts. */
export async function multiStartNestAsync(rows, specs, opts = {}, totalMs, starts = 4, onProgress = null) {
  const slice = Math.max(1, totalMs / Math.max(1, starts));
  const overall = Date.now() + totalMs;
  let best = null;
  let bestScore = Infinity;
  for (let i = 0; i < starts; i += 1) {
    if (i > 0 && Date.now() >= overall) break;
    const until = Math.min(Date.now() + slice, overall);
    const r = await ruinRecreateAsync(rows, specs, opts, until, 1000 + i * 7919,
      onProgress ? (f) => onProgress((i + f) / starts) : null);
    const score = scoreOf(r);
    if (score < bestScore || (score === bestScore && r.plates.length < best.plates.length)) { best = r; bestScore = score; }
  }
  return best;
}

/**
 * The async twin of `nestAtEffort`: what the blank plan actually runs.
 *
 * `quick` is the restart loop alone (about a second on KEPL). `standard` and
 * `deep` spend their budget on repair — which is where the tonnes are — and
 * both keep the server answerable while they do.
 */
export async function nestAtEffortAsync(rows, specs, opts = {}, effort = 'standard', budgetMs = null, onProgress = null) {
  const level = EFFORT_LEVELS[effort] ?? EFFORT_LEVELS.standard;
  const ms = budgetMs ?? level.budgetMs;
  const withJitter = { ...opts, jitterPlacement: true };
  if (!ms) return nestAsync(rows, specs, { ...withJitter, restarts: level.restarts });
  if (level.starts) return multiStartNestAsync(rows, specs, withJitter, ms, level.starts, onProgress);
  return ruinRecreateAsync(rows, specs, withJitter, Date.now() + ms, opts.seed ?? 7, onProgress);
}
