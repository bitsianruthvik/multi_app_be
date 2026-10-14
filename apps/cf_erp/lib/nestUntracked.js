/**
 * nestUntracked.js — CF_ERP. Cut pieces cut from UNTRACKED OFFCUTS (init.sql §61, 2026-10-14).
 *
 * The shop cuts packings and small plates from loose offcuts lying in the yard that are not in the
 * system. Such pieces are MARKED on the line (cf_nest_untracked: per cut piece, how many). A marked
 * piece is on no plate: no lot, no placement, no plate bought for it, no waste, no heat number.
 *
 * ONE RULE, EVERY READER. What a mark counts is never more than the line still needs after what is
 * nested: min(marked, needed − nested). So a later upload that nests a marked piece COVERS it — the
 * mark shrinks by itself on every reader at once (the upload also writes the smaller number, and
 * says so). The readers: the nesting screen (coverage, left over, drift), the packer's demand (our
 * nesting never places a marked piece), release and the buy list (a marked piece asks for no plate
 * and does not stop release), the process stage, and the order's costs (its steel at the plate rate).
 *
 * Reading is one query for any number of lines. A database without §61 (a backend ahead of its
 * schema) answers "nothing marked".
 */

/**
 * The marks of some lines: Map(lineId -> Map(cutPlateId -> { qty, ratePlateId })). Only live rows
 * with a quantity. One read.
 */
export async function untrackedOf(db, companyId, lineIds) {
  const ids = [...new Set((lineIds ?? []).map(Number).filter((x) => Number.isInteger(x) && x > 0))];
  const out = new Map(ids.map((id) => [id, new Map()]));
  if (!ids.length) return out;
  let rows = [];
  try {
    [rows] = await db.query(
      `SELECT order_line_id, cut_plate_id, quantity, rate_plate_item_id
         FROM cf_nest_untracked
        WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL AND quantity > 0`,
      [companyId, ids],
    );
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE' || e?.errno === 1146) return out;
    throw e;
  }
  for (const r of rows) {
    out.get(Number(r.order_line_id))?.set(Number(r.cut_plate_id), {
      qty: Number(r.quantity), ratePlateId: r.rate_plate_item_id == null ? null : Number(r.rate_plate_item_id),
    });
  }
  return out;
}

export const untrackedOfLine = async (db, companyId, lineId) =>
  (await untrackedOf(db, companyId, [lineId])).get(Number(lineId)) ?? new Map();

/**
 * What the marks COUNT: Map(cutPlateId -> pieces), only those above 0.
 *   stored    untrackedOf's Map for one line (cutPlateId -> { qty }), or a Map of plain numbers
 *   needOf    cutPlateId -> pieces the line needs (a Map, or a function)
 *   nestedOf  cutPlateId -> pieces already on plates that stay (a Map, or a function; none = 0)
 * min(marked, needed − nested): never more than what is still left over.
 */
export function effectiveUntracked(stored, needOf, nestedOf = null) {
  const out = new Map();
  if (!stored?.size) return out;
  const get = (src, id) => (src == null ? 0 : typeof src === 'function' ? src(id) : src.get(id)) ?? 0;
  for (const [id, s] of stored) {
    const marked = Number(typeof s === 'object' ? s?.qty : s) || 0;
    const room = Math.max(0, Number(get(needOf, id)) - Number(get(nestedOf, id)));
    const q = Math.min(marked, room);
    if (q > 0) out.set(Number(id), q);
  }
  return out;
}

/** The marks that count for MORE than they hold now — what an upload shrinks: [{ cutPlateId, was, now }]. */
export function shrunkUntracked(stored, effective) {
  const out = [];
  for (const [id, s] of stored ?? []) {
    const was = Number(typeof s === 'object' ? s?.qty : s) || 0;
    const now = effective.get(Number(id)) ?? 0;
    if (now < was) out.push({ cutPlateId: Number(id), was, now });
  }
  return out;
}

/** The words, once: "n pieces · x kg cut from untracked offcuts". */
export const UNTRACKED_WORDS = 'cut from untracked offcuts';
