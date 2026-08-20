/**
 * nest.mjs — lay the parts onto real plates, and prove they fit.
 *
 * WHY GEOMETRY AND NOT AREA. nestingIntegrityService checks two things: that a
 * part fits inside its plate's bounding box, and that the parts on a plate do
 * not exceed its AREA. Both are necessary and neither is sufficient — six parts
 * of 2995 x 500 have less area than a 2000 x 11000 plate and still cannot be
 * cut from it, because they will not lie side by side. Passing the server's
 * check while being unbuildable is exactly the outcome worth avoiding here, so
 * this places every piece at a coordinate and refuses what will not go.
 *
 * THE ALGORITHM is shelf packing (next-fit-decreasing on shelf height), which
 * is what a plate shop actually does: parts are cut in strips across the plate,
 * because a guillotine or a gantry torch runs in straight lines. A free-form
 * 2D bin packer would report a better utilisation than any cutter could
 * realise. Shelves are pessimistic in the right direction.
 *
 * ONE CONSTRAINT COMES FROM THE SCHEMA, not from the shop: a part row carries
 * ONE material link and that link carries ONE nest_no, so every piece of a row
 * must land on the same plate. Rows are placed atomically for that reason —
 * trialled on a copy, committed only if all their pieces go.
 */

/**
 * A plate being filled, as a set of free rectangles.
 *
 * WHY NOT SHELVES. The first version laid parts in strips across the plate,
 * which is easy to reason about and threw away every millimetre of height above
 * a part that was shorter than its strip. On this order that cost five plates:
 * each thickness ended with a remainder plate holding a handful of small cover
 * plates at 2-42% while earlier plates had usable space nobody could reach.
 *
 * A guillotine free-rectangle packer keeps the property that matters on the
 * floor — every cut still runs edge to edge, so a torch or a guillotine can
 * actually make it — while letting the offcut above a part be used by the next
 * one. Placement is best-short-side-fit and the split is along the shorter
 * leftover axis, which is the pairing that behaves best on mixed part sizes.
 */
const newPlate = (spec, no) => ({
  spec, no, rows: [], pieces: [],
  free: [{ x: 0, y: 0, l: spec.l, w: spec.w }],
});

const copy = (p) => ({ ...p, free: p.free.map((r) => ({ ...r })), rows: [...p.rows], pieces: [...p.pieces] });

/** Put one piece on a plate, mutating it. True if it went. */
function placePiece(plate, a, b) {
  let best = null;
  for (let i = 0; i < plate.free.length; i++) {
    const r = plate.free[i];
    // Both orientations: a plate has no grain for cutting, and refusing to turn
    // a part 90 degrees would reject work the shop does daily.
    for (const [pl, pw] of [[a, b], [b, a]]) {
      if (pl > r.l || pw > r.w) continue;
      const score = Math.min(r.l - pl, r.w - pw);
      if (!best || score < best.score) best = { i, r, pl, pw, score };
    }
  }
  if (!best) return false;

  const { i, r, pl, pw } = best;
  plate.free.splice(i, 1);
  plate.pieces.push({ x: r.x, y: r.y, l: pl, w: pw });
  // Split the remainder along whichever leftover axis is shorter — the long
  // strip stays whole and is the one big enough to be worth something.
  if (r.l - pl < r.w - pw) {
    if (r.l - pl > 0) plate.free.push({ x: r.x + pl, y: r.y, l: r.l - pl, w: pw });
    if (r.w - pw > 0) plate.free.push({ x: r.x, y: r.y + pw, l: r.l, w: r.w - pw });
  } else {
    if (r.l - pl > 0) plate.free.push({ x: r.x + pl, y: r.y, l: r.l - pl, w: r.w });
    if (r.w - pw > 0) plate.free.push({ x: r.x, y: r.y + pw, l: pl, w: r.w - pw });
  }
  return true;
}

/** All `qty` pieces of a row, or none — one row carries one nest_no. */
function placeRow(plate, row) {
  const trial = copy(plate);
  for (let i = 0; i < row.qty; i++) if (!placePiece(trial, row.l, row.w)) return null;
  trial.rows.push(row);
  return trial;
}

/**
 * Nest every row onto plates drawn from `rawMaterial`.
 *
 * Rows are sorted longest-side first: a decreasing order is what makes shelf
 * packing behave, because the tall strips get laid down before the short ones
 * fragment the plate.
 *
 * @returns {{plates:Array, unplaced:Array, byThickness:Object}}
 */
export function nestAll(rows, rawMaterial) {
  const specsByT = new Map();
  for (const rm of rawMaterial) {
    if (!specsByT.has(rm.t)) specsByT.set(rm.t, []);
    // Widest first: the big plate is the one that can take the awkward parts,
    // and opening it early keeps the narrow plates for the strip work.
    specsByT.get(rm.t).push({ ...rm, remaining: rm.qty });
  }
  for (const list of specsByT.values()) list.sort((x, y) => y.w * y.l - x.w * x.l);

  const open = new Map();   // thickness -> plates still being filled
  const plates = [];
  const unplaced = [];
  let seq = 0;

  const sorted = [...rows].sort((x, y) => {
    const d = Math.max(y.l, y.w) - Math.max(x.l, x.w);
    return d !== 0 ? d : (y.l * y.w * y.qty) - (x.l * x.w * x.qty);
  });

  for (const row of sorted) {
    const specs = specsByT.get(row.t);
    if (!specs) { unplaced.push({ row, why: `no ${row.t} mm plate is being bought` }); continue; }

    if (!open.has(row.t)) open.set(row.t, []);
    const pool = open.get(row.t);

    /**
     * BEST fit, not first fit.
     *
     * First-fit put the small cover plates onto whatever wide plate happened to
     * be open, which then had no width left for the next row that needed a deep
     * shelf — and 25 mm went from 16 plates to 20. Choosing the plate the row
     * leaves FULLEST keeps the part-and-plate pairings that suit each other
     * together, which is also how a nester works by hand.
     */
    let best = -1, bestPacked = null, bestScore = -1;
    for (let i = 0; i < pool.length; i++) {
      const packed = placeRow(pool[i], row);
      if (!packed) continue;
      const score = utilisation(packed);
      if (score > bestScore) { bestScore = score; best = i; bestPacked = packed; }
    }
    if (bestPacked) { pool[best] = bestPacked; row.nest = bestPacked.no; continue; }
    let done = false;

    // Nothing open took it — open a new plate, preferring a size still in the
    // purchased quantity, and among those the one the row actually fits on.
    const candidates = [...specs].sort((x, y) => {
      const stock = (y.remaining > 0) - (x.remaining > 0);
      return stock !== 0 ? stock : y.l * y.w - x.l * x.w;
    });
    for (const spec of candidates) {
      const fresh = newPlate(spec, `N${row.t}-${String(++seq).padStart(3, '0')}`);
      const packed = placeRow(fresh, row);
      if (!packed) { seq--; continue; }
      spec.remaining--;
      pool.push(packed);
      plates.push(packed);
      row.nest = packed.no;
      done = true;
      break;
    }
    if (!done) unplaced.push({ row, why: 'does not fit on any purchased plate size' });
  }

  // `plates` holds the objects as they were when opened; the pools hold the
  // filled copies. Re-read from the pools so utilisation reflects the finish.
  const finished = [];
  for (const pool of open.values()) finished.push(...pool);
  finished.sort((a, b) => a.no.localeCompare(b.no, undefined, { numeric: true }));

  const byThickness = {};
  for (const p of finished) {
    const t = p.spec.t;
    byThickness[t] ??= { used: 0, bought: 0, sizes: {} };
    byThickness[t].used++;
    const key = `${p.spec.w}x${p.spec.l}`;
    byThickness[t].sizes[key] = (byThickness[t].sizes[key] ?? 0) + 1;
  }
  for (const rm of rawMaterial) {
    byThickness[rm.t] ??= { used: 0, bought: 0, sizes: {} };
    byThickness[rm.t].bought += rm.qty;
  }

  return { plates: finished, unplaced, byThickness };
}

/** Fraction of a plate's area actually taken by parts. */
export const utilisation = (p) =>
  p.rows.reduce((s, r) => s + r.l * r.w * r.qty, 0) / (p.spec.l * p.spec.w);

/**
 * Re-check the finished nesting from scratch, the way the server will.
 *
 * Deliberately NOT reusing the packer's own bookkeeping: a packer that has a
 * bug will report success with the same bug. This reads only the final
 * assignment — row -> nest -> plate size — and re-derives whether it holds.
 */
export function verify(plates) {
  const problems = [];
  for (const p of plates) {
    for (const r of p.rows) {
      const fits = (r.l <= p.spec.l && r.w <= p.spec.w) || (r.l <= p.spec.w && r.w <= p.spec.l);
      if (!fits) {
        problems.push(`${r.path}/${r.code} is ${r.l}x${r.w} on plate ${p.no} (${p.spec.l}x${p.spec.w})`);
      }
    }
    const used = p.rows.reduce((s, r) => s + r.l * r.w * r.qty, 0);
    const area = p.spec.l * p.spec.w;
    if (used > area) {
      problems.push(`${p.no} holds ${(used / 1e6).toFixed(2)} m2 of part on ${(area / 1e6).toFixed(2)} m2 of plate`);
    }
  }
  return problems;
}
