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

/** A plate being filled, as a set of free rectangles. */
const newPlate = (spec) => ({
  spec,
  rows: [],
  pieces: [],
  free: [{ x: 0, y: 0, l: spec.length, w: spec.width }],
});

const clonePlate = (p) => ({
  ...p,
  free: p.free.map((r) => ({ ...r })),
  rows: [...p.rows],
  pieces: [...p.pieces],
});

const areaOf = (p) => p.spec.length * p.spec.width;
const usedArea = (p) => p.rows.reduce((s, r) => s + r.length * r.width * r.qty, 0);

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
function placeRow(plate, row) {
  const trial = clonePlate(plate);
  for (let i = 0; i < row.qty; i++) {
    if (!placePiece(trial, row.length, row.width)) return null;
  }
  trial.rows.push(row);
  return trial;
}

/** Does ONE piece of this row fit on an empty plate of this size? */
export const pieceFitsSpec = (row, spec) =>
  (row.length <= spec.length + TOL && row.width <= spec.width + TOL)
  || (row.length <= spec.width + TOL && row.width <= spec.length + TOL);

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
export function capacityOf(row, spec) {
  let plate = newPlate(spec);
  let n = 0;
  while (placePiece(plate, row.length, row.width)) n++;
  return n;
}

/** Do ALL of this row's pieces fit on one empty plate of this size? */
export const rowFitsSpec = (row, spec) =>
  pieceFitsSpec(row, spec) && (row.qty <= 1 || capacityOf(row, spec) >= row.qty);

/**
 * Fill one plate of `spec` with as many of `rows` as will go.
 *
 * Longest-side-first, which is what makes any greedy packer behave: the awkward
 * pieces are placed while the plate is still open, and the small ones fill in
 * around them rather than fragmenting it first.
 */
function fillOne(spec, rows) {
  let plate = newPlate(spec);
  const taken = new Set();
  const ordered = [...rows].sort((x, y) => {
    const d = Math.max(y.length, y.width) - Math.max(x.length, x.width);
    return d !== 0 ? d : (y.length * y.width * y.qty) - (x.length * x.width * x.qty);
  });
  for (const row of ordered) {
    const next = placeRow(plate, row);
    if (next) { plate = next; taken.add(row.key); }
  }
  return { plate, taken };
}

/**
 * Nest `rows` onto plates chosen from `specs`.
 *
 * @param {Array<{key,length,width,qty}>} rows   part rows, dimensions in mm
 * @param {Array<{id,code,length,width}>} specs  candidate plate sizes
 * @param {{maxPlates?:number}} [opts]
 * @returns {{plates:Array, unplaced:Array}}
 */
export function nest(rows, specs, opts = {}) {
  const maxPlates = opts.maxPlates ?? 5000;
  const plates = [];
  const unplaced = [];

  // A row that fits on no candidate size can never be placed, and saying so up
  // front is more useful than letting the loop discover it once per pass. This
  // is the honest answer to "the drawing needs a plate nobody sells".
  const biggestLong = Math.max(...specs.map((s) => Math.max(s.length, s.width)));
  const biggestShort = Math.max(...specs.map((s) => Math.min(s.length, s.width)));

  let remaining = [];
  for (const r of rows) {
    if (specs.some((s) => rowFitsSpec(r, s))) { remaining.push(r); continue; }
    // Two different failures, and telling them apart is the difference between
    // "buy a wider plate" and "split this row".
    if (!specs.some((s) => pieceFitsSpec(r, s))) {
      unplaced.push({
        row: r,
        reason: `${r.length} x ${r.width} mm does not fit on any available plate `
              + `(largest is ${biggestLong} x ${biggestShort} mm)`,
      });
    } else {
      const best = Math.max(...specs.filter((s) => pieceFitsSpec(r, s)).map((s) => capacityOf(r, s)));
      unplaced.push({
        row: r,
        reason: `${r.qty} pieces of ${r.length} x ${r.width} mm will not fit on one plate — `
              + `the largest available holds ${best}. A part row is cut from a single plate, `
              + 'so this row has to be split before it can be nested.',
      });
    }
  }

  while (remaining.length && plates.length < maxPlates) {
    let best = null;
    for (const spec of specs) {
      const { plate, taken } = fillOne(spec, remaining);
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
    remaining = remaining.filter((r) => !best.taken.has(r.key));
  }

  if (remaining.length) {
    for (const r of remaining) unplaced.push({ row: r, reason: `plate limit of ${maxPlates} reached` });
  }
  return { plates, unplaced };
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
      if (!rowFitsSpec(r, p.spec)) {
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
