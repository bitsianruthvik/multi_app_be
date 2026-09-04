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
 * ── WHY A ROW IS ATOMIC ───────────────────────────────────────────────────
 * A part row carries ONE material link and a link carries ONE nest_no, so every
 * piece of a row lands on the same plate or the row does not go. That is a
 * constraint from the schema, not from the shop, and it is enforced here rather
 * than discovered later by a save that half-succeeds.
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
 * CUTTING GAP — 50 mm for this shop, BETWEEN PARTS ONLY.
 *
 * The torch needs room to run a clean cut between two parts. It needs nothing
 * at the plate's rim: a mill edge is already a finished edge, so a part may sit
 * hard against it.
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
 * GETTING THIS WRONG IS EXPENSIVE, and it was wrong first time round. Charging
 * the gap at the rim as well shrank the usable sheet by 2g, and the 28 mm Web
 * Plate — 12000 long on a 12050 plate — stopped fitting at all. Twenty-four of
 * the heaviest parts on the order became unmakeable by arithmetic rather than
 * by anything the shop would recognise.
 *
 * It is still charged to the PART, which is why it hurts small ones hardest: a
 * 2995 x 178 stiffener reserves 3045 x 228 wherever it has neighbours.
 *
 * ONE NUMBER FOR EVERY THICKNESS — the shop's own blanket rule, not a
 * simplification made here.
 */
const DEFAULT_MARGIN = 0;

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
function placePiece(plate, a, b) {
  let best = null;
  for (let i = 0; i < plate.free.length; i++) {
    const r = plate.free[i];
    for (const [pl, pw] of [[a, b], [b, a]]) {
      if (pl > r.l + TOL || pw > r.w + TOL) continue;
      const score = Math.min(r.l - pl, r.w - pw);
      if (!best || score < best.score) best = { i, r, pl, pw, score };
    }
  }
  if (!best) return false;

  const { i, r, pl, pw } = best;
  plate.free.splice(i, 1);
  plate.pieces.push({ x: r.x, y: r.y, l: pl, w: pw });
  // Split the remainder along whichever leftover axis is SHORTER, so the long
  // strip survives whole. Splitting the other way dices the plate into offcuts
  // too small to be worth anything.
  if (r.l - pl < r.w - pw) {
    if (r.l - pl > 0) plate.free.push({ x: r.x + pl, y: r.y, l: r.l - pl, w: pw });
    if (r.w - pw > 0) plate.free.push({ x: r.x, y: r.y + pw, l: r.l, w: r.w - pw });
  } else {
    if (r.l - pl > 0) plate.free.push({ x: r.x + pl, y: r.y, l: r.l - pl, w: r.w });
    if (r.w - pw > 0) plate.free.push({ x: r.x, y: r.y + pw, l: pl, w: r.w - pw });
  }
  return true;
}

/** All `qty` pieces of a row, or none. Returns a new plate, or null. */
export function placeRow(plate, row) {
  const trial = clonePlate(plate);
  const m = plate.margin ?? 0;
  for (let i = 0; i < row.qty; i++) {
    // Inflated by the margin: what is reserved is the part plus its clearance.
    if (!placePiece(trial, row.length + m, row.width + m)) return null;
  }
  trial.rows.push(row);
  return trial;
}

/** Does ONE piece of this row fit on an empty plate of this size? */
export const pieceFitsSpec = (row, spec, margin = DEFAULT_MARGIN) => {
  // Both inflated by the gap, so it cancels for a lone part: no edge margin.
  const l = row.length + margin; const w = row.width + margin;
  const L = spec.length + margin; const W = spec.width + margin;
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
  let n = 0;
  while (placePiece(plate, row.length + margin, row.width + margin)) n++;
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
export function fillOne(spec, rows, rng = null, margin = DEFAULT_MARGIN) {
  let plate = newPlate(spec, margin);
  const taken = new Set();
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
    const next = placeRow(plate, row);
    if (next) { plate = next; taken.add(row.key); }
  }
  return { plate, taken };
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

/** What a nesting costs: plate area bought. Fewer plates breaks a tie. */
const scoreOf = (res) => res.plates.reduce((a, p) => a + areaOf(p), 0);

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
 * @param {Array<{key,length,width,qty}>} rows   part rows, dimensions in mm
 * @param {Array<{id,code,length,width,available?,preferred?}>} specs  candidate plates.
 *   `available` limits how many of that size exist — omit for a catalogue size,
 *   which can be bought again; set 1 for an OFFCUT, which is one physical piece.
 *   `preferred` marks material already paid for, which is chosen ahead of
 *   anything that would have to be bought.
 * @param {{maxPlates?:number}} [opts]
 * @returns {{plates:Array, unplaced:Array}}
 */
function nestOnce(rows, specs, opts = {}, rng = null) {
  const maxPlates = opts.maxPlates ?? 5000;
  const margin = opts.margin ?? DEFAULT_MARGIN;
  const plates = [];
  const unplaced = [];
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

  let remaining = [];
  for (const r of rows) {
    if (specs.some((s) => rowFitsSpec(r, s, margin))) { remaining.push(r); continue; }
    // Two different failures, and telling them apart is the difference between
    // "buy a wider plate" and "split this row".
    if (!specs.some((s) => pieceFitsSpec(r, s, margin))) {
      unplaced.push({
        row: r,
        reason: `${r.length} x ${r.width} mm does not fit on any available plate `
              + `(largest is ${biggestLong} x ${biggestShort} mm)`,
      });
    } else {
      const best = Math.max(...specs.filter((s) => pieceFitsSpec(r, s, margin)).map((s) => capacityOf(r, s, margin)));
      unplaced.push({
        row: r,
        reason: `${r.qty} pieces of ${r.length} x ${r.width} mm will not fit on one plate — `
              + `the largest available holds ${best}. A part row is cut from a single plate, `
              + 'so this row has to be split before it can be nested.',
      });
    }
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
    for (const round of rounds) {
      for (const spec of round) {
        if ((stockOf.get(spec.id) ?? 0) <= 0) continue;
        const { plate, taken } = fillOne(spec, remaining, rng, margin);
        if (!taken.size) continue;
        const util = utilisation(plate);
        // Utilisation decides, but two plates within a hair of each other are not
        // meaningfully different and the tie should go to the one that absorbs
        // more work — that is one fewer plate overall.
        const key = [Math.round(util * 1000), Math.round(usedArea(plate))];
        if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && key[1] > best.key[1])) {
          best = { plate, taken, key };
        }
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
    remaining = remaining.filter((r) => !best.taken.has(r.key));
  }

  if (remaining.length) {
    for (const r of remaining) unplaced.push({ row: r, reason: `plate limit of ${maxPlates} reached` });
  }
  // The greedy loop never reopens a plate, so its leftovers each opened one.
  // This is where those get absorbed back.
  return { plates: consolidate(plates), unplaced };
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
 */
export function nest(rows, specs, opts = {}) {
  const restarts = Math.max(1, opts.restarts ?? 1);
  const seed = opts.seed ?? 1;

  let best = nestOnce(rows, specs, opts, null);
  let bestScore = scoreOf(best);

  for (let i = 1; i < restarts; i += 1) {
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
 * Re-derive whether a finished nesting holds, reading ONLY the final assignment.
 *
 * Deliberately not reusing the packer's own bookkeeping: a packer with a bug
 * reports success with the same bug. This takes row -> plate size and asks the
 * two questions that are impossibilities rather than opinions — does every part
 * fit inside its plate in some orientation, and is any plate asked for more
 * area than it has.
 */
export function verify(plates) {
  const problems = [];
  for (const p of plates) {
    for (const r of p.rows) {
      if (!rowFitsSpec(r, p.spec, p.margin ?? 0)) {
        problems.push(`${r.key} is ${r.length}x${r.width} on a ${p.spec.length}x${p.spec.width} plate`);
      }
    }
    if (usedArea(p) > areaOf(p) + TOL) {
      problems.push(`a ${p.spec.length}x${p.spec.width} plate holds `
        + `${(usedArea(p) / 1e6).toFixed(2)} m2 of part on ${(areaOf(p) / 1e6).toFixed(2)} m2 of plate`);
    }
  }
  return problems;
}
