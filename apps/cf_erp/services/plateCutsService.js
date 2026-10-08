/**
 * plateCutsService.js — a cut plate's CNC inputs from its nest (user, 2026-10-08: "even for CNC
 * cutting, whatever are required should come from nesting … if we manually upload a nesting, we
 * should try to build a nesting out of it and use that to calculate the time").
 *
 * CNC cutting reads item.CUT_LENGTH and item.PIERCINGS on the cut plate. Before nesting the cut
 * plate works them out alone: CUT_LENGTH = its perimeter, 2 × (LENGTH + WIDTH), PIERCINGS its
 * default (1). Once its line is nested — automatically, or by an uploaded sheet, which is laid
 * out by our packer when it is saved (nestingService.checkNest) — the nest says:
 *
 *   CUT_LENGTH  per piece, its perimeter less HALF of every edge it shares with a neighbour.
 *               Two pieces one kerf apart are separated by ONE cut (common-line cutting), so
 *               that edge is cut once for the two of them. A piece the layout has no place for
 *               (an upload our packer could not fit) keeps its perimeter. Per cut plate: the
 *               average over its pieces on every nest of the line.
 *   PIERCINGS   one per piece (each piece is a contour of its own; holes are drilled, not cut).
 *
 * Written straight onto the cut plates: nesting runs on a FROZEN line, whose records keep what
 * they hold (valueService.materialize works nothing out there). A cut plate on no nest goes back
 * to its own perimeter. A value that would not change is not written. Two reads and at most two
 * writes, whatever the size of the line.
 */
import { insertRows } from '../lib/db.js';

const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const TOL = 0.5;

/**
 * Pure: the cut length of every piece on one plate. pieces: [{ key, x, y, length, width }] with
 * length along x and width along y as placed (null x/y = no layout). Returns Map key -> mm.
 */
export function cutLengthsOnPlate(pieces, kerf = 0) {
  const k = Math.max(0, Number(kerf) || 0);
  const out = new Map();
  const laid = [];
  for (const p of pieces) {
    const l = Number(p.length);
    const w = Number(p.width);
    out.set(p.key, 2 * (l + w));
    if (p.x != null && p.y != null && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) {
      laid.push({ key: p.key, x0: Number(p.x), y0: Number(p.y), x1: Number(p.x) + l, y1: Number(p.y) + w });
    }
  }
  const touching = (gap) => gap >= -TOL && gap <= k + TOL;
  const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  // Sorted by x so a piece only meets neighbours that start before its right edge plus a kerf.
  laid.sort((a, b) => a.x0 - b.x0);
  for (let i = 0; i < laid.length; i++) {
    const a = laid[i];
    for (let j = i + 1; j < laid.length; j++) {
      const b = laid[j];
      if (b.x0 > a.x1 + k + TOL) break;
      let shared = 0;
      if (touching(b.x0 - a.x1) || touching(a.x0 - b.x1)) shared += overlap(a.y0, a.y1, b.y0, b.y1);   // side by side
      if (touching(b.y0 - a.y1) || touching(a.y0 - b.y1)) shared += overlap(a.x0, a.x1, b.x0, b.x1);   // one above the other
      if (shared > 0) {
        out.set(a.key, out.get(a.key) - shared / 2);
        out.set(b.key, out.get(b.key) - shared / 2);
      }
    }
  }
  return out;
}

/**
 * Puts CUT_LENGTH and PIERCINGS on a line's cut plates from its live nests.
 * cutPlates: [{ id, steel: { length, width } }] — every cut plate of the line.
 * Returns { written, nested, shared } (shared = mm of cut saved by common lines, the whole line).
 */
export async function writePlateCuts(db, c, orderLineId, cutPlates) {
  const companyId = c.companyId;
  const ids = [...new Set((cutPlates ?? []).map((cp) => Number(cp.id)))];
  if (!ids.length) return { written: 0, nested: 0, shared: 0 };
  const [specs] = await db.query("SELECT id, UPPER(code) AS code, default_uom FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND code IN ('CUT_LENGTH', 'PIERCINGS')", [companyId]);
  const spec = new Map(specs.map((s) => [s.code, s]));
  if (!spec.has('CUT_LENGTH')) return { written: 0, nested: 0, shared: 0 };

  const [rows] = await db.query(
    `SELECT p.id, p.plate_lot_id, p.cut_plate_id, p.x_mm, p.y_mm, p.length_mm, p.width_mm, l.kerf_mm
       FROM cf_plate_lots l
       JOIN cf_nest_placements p ON p.company_id = l.company_id AND p.plate_lot_id = l.id AND p.deleted_at IS NULL
      WHERE l.company_id = ? AND l.order_line_id = ? AND l.deleted_at IS NULL AND l.kind = 'plate'`,
    [companyId, orderLineId],
  );
  const byLot = new Map();
  for (const r of rows) {
    if (!byLot.has(r.plate_lot_id)) byLot.set(r.plate_lot_id, { kerf: Number(r.kerf_mm) || 0, pieces: [] });
    byLot.get(r.plate_lot_id).pieces.push({ key: r.id, cutPlateId: Number(r.cut_plate_id), x: r.x_mm, y: r.y_mm, length: r.length_mm, width: r.width_mm });
  }
  const sum = new Map();
  const count = new Map();
  let shared = 0;
  for (const lot of byLot.values()) {
    const lengths = cutLengthsOnPlate(lot.pieces, lot.kerf);
    for (const p of lot.pieces) {
      const len = lengths.get(p.key);
      shared += 2 * (Number(p.length) + Number(p.width)) - len;
      sum.set(p.cutPlateId, (sum.get(p.cutPlateId) ?? 0) + len);
      count.set(p.cutPlateId, (count.get(p.cutPlateId) ?? 0) + 1);
    }
  }

  const want = [];
  for (const cp of cutPlates) {
    const id = Number(cp.id);
    if (count.has(id)) {
      want.push({ id, code: 'CUT_LENGTH', value: r3(sum.get(id) / count.get(id)), source: 'calculated' });
      if (spec.has('PIERCINGS')) want.push({ id, code: 'PIERCINGS', value: 1, source: 'entered' });
    } else {
      const l = Number(cp.steel?.length);
      const w = Number(cp.steel?.width);
      if (l > 0 && w > 0) want.push({ id, code: 'CUT_LENGTH', value: r3(2 * (l + w)), source: 'calculated' });
    }
  }
  if (!want.length) return { written: 0, nested: count.size, shared: r3(shared) };
  const [have] = await db.query(
    `SELECT subject_id, specification_id, value_number, source FROM cf_spec_values
      WHERE company_id = ? AND subject_type = 'master' AND deleted_at IS NULL AND subject_id IN (?) AND specification_id IN (?)`,
    [companyId, ids, specs.map((s) => s.id)],
  );
  const now = new Map(have.map((h) => [`${h.subject_id}:${h.specification_id}`, h]));
  const writes = want.filter((w) => {
    const h = now.get(`${w.id}:${spec.get(w.code).id}`);
    if (w.code === 'PIERCINGS' && h && h.value_number != null && Math.abs(Number(h.value_number) - w.value) < 1e-6) return false;   // the default already says it
    return !h || h.value_number == null || Math.abs(Number(h.value_number) - w.value) > 1e-6 || h.source !== w.source;
  });
  if (writes.length) {
    await db.query(
      `UPDATE cf_spec_values SET deleted_at = NOW()
        WHERE company_id = ? AND subject_type = 'master' AND deleted_at IS NULL AND (subject_id, specification_id) IN (${writes.map(() => '(?, ?)').join(', ')})`,
      [companyId, ...writes.flatMap((w) => [w.id, spec.get(w.code).id])],
    );
    await insertRows(db, 'cf_spec_values', ['company_id', 'specification_id', 'subject_type', 'subject_id', 'value_number', 'uom', 'source', 'created_by'],
      writes.map((w) => [companyId, spec.get(w.code).id, 'master', w.id, w.value, spec.get(w.code).default_uom ?? null, w.source, c.userId ?? null]));
  }
  return { written: writes.length, nested: count.size, shared: r3(shared) };
}
