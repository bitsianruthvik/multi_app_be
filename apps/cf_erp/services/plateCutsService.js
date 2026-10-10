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
 * PART DRAWINGS (drawingService, init.sql §51). Where the parts a cut plate is cut for have DXF
 * drawings, a piece's own cut is the drawing's — outline plus cut-outs, not the rectangle's
 * perimeter — its piercings are 1 + cut-outs, and a shared cut only saves the share of the side
 * the outline really runs along (a gusset's sloping edge shares nothing with its neighbour).
 * Averaged over the pieces of the cut plate, parts without a drawing counted as rectangles.
 *
 * FREE LAYOUTS (init.sql §55; made exact 2026-10-10). A plate laid out by TRUE SHAPE — our
 * shapePacker's (`source_kind 'shape'`), a customer's own layout, any plate with a part at a free
 * angle, flipped, or carrying the outline the customer's file drew — has no rows of boxes to read
 * shared edges off. There a piece's cut is the TRUE PERIMETER of its outline plus its cut-outs
 * (drilled holes are drilled, as everywhere), and a shared cut is measured on the outlines
 * themselves (`sharedCutsOnPlate`): two straight edges that face each other no further apart than
 * one kerf are ONE cut — the same rule shapePacker.layoutMetrics.sharedCutMm states for our own
 * layouts (exactly a kerf apart), extended down to touching because that is how a customer's
 * program draws a common cut. Each of the two pieces is credited half of it, as on a row layout.
 * A PLATE OF RECTANGLES IN ROWS IS MEASURED EXACTLY AS IT ALWAYS WAS (the box rule below).
 *
 * Written straight onto the cut plates: nesting runs on a FROZEN line, whose records keep what
 * they hold (valueService.materialize works nothing out there). A cut plate on no nest goes back
 * to its own perimeter. A value that would not change is not written. Two reads and at most two
 * writes, whatever the size of the line.
 */
import { insertRows } from '../lib/db.js';
import { cutPlaces } from '../lib/cutPlaces.js';
import { drawingFactsOfLine } from './partDrawingService.js';
import { rotationOfRow, isQuarterTurn, isPlainPlacement, shapeOfCutPlate, placeShape, ringsObject } from './nestShapes.js';

const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const TOL = 0.5;

/**
 * Pure: the cut length of every piece on one plate. pieces: [{ key, x, y, length, width }] with
 * length along x and width along y as placed (null x/y = no layout). Optional per piece:
 * base (its own cut, else its perimeter), coverX / coverY (share of its sides along x / along y
 * that are really cut straight, else 1). Returns Map key -> mm.
 */
export function cutLengthsOnPlate(pieces, kerf = 0) {
  const k = Math.max(0, Number(kerf) || 0);
  const out = new Map();
  const laid = [];
  for (const p of pieces) {
    const l = Number(p.length);
    const w = Number(p.width);
    out.set(p.key, p.base != null ? Number(p.base) : 2 * (l + w));
    // A piece lying at a free angle (§55) has no edge along x or y to share with a neighbour.
    if (p.free) continue;
    if (p.x != null && p.y != null && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) {
      laid.push({ key: p.key, x0: Number(p.x), y0: Number(p.y), x1: Number(p.x) + l, y1: Number(p.y) + w, cx: p.coverX ?? 1, cy: p.coverY ?? 1 });
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
      // A shared edge saves only what both outlines really run along: the sides along y for pieces side by side, along x when stacked.
      if (touching(b.x0 - a.x1) || touching(a.x0 - b.x1)) shared += overlap(a.y0, a.y1, b.y0, b.y1) * Math.min(a.cy, b.cy);   // side by side
      if (touching(b.y0 - a.y1) || touching(a.y0 - b.y1)) shared += overlap(a.x0, a.x1, b.x0, b.x1) * Math.min(a.cx, b.cx);   // one above the other
      if (shared > 0) {
        out.set(a.key, out.get(a.key) - shared / 2);
        out.set(b.key, out.get(b.key) - shared / 2);
      }
    }
  }
  return out;
}

const ringLen = (ring) => { let d = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) d += Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]); return d; };
/** Torch-cut length of placed rings: the outline and every cut-out (a drilled hole is not cut). */
export const cutLengthOfRings = (o) => ringLen(o.outline) + (o.cutouts ?? []).reduce((a, r) => a + ringLen(r), 0);
/** Rings as the screen carries them (holes may be circles there) → { outline, cutouts } corner lists, or null. */
const cutRings = (rings) => {
  if (!rings) return null;
  const o = Array.isArray(rings) ? ringsObject(rings) : rings;
  return o?.outline?.length >= 3 ? { outline: o.outline, cutouts: (o.cutouts ?? []).filter((r) => Array.isArray(r) && r.length >= 3) } : null;
};

/**
 * Pure: the cut SHARED between parts of one free layout, on their true outlines.
 *   pieces  [{ key, rings: { outline, cutouts } }] — rings ALREADY PLACED, plate mm
 * Two straight edges (10 mm or 3 kerfs at least, so the facets of a curve never count) of two
 * different parts that run anti-parallel, face each other, and lie no further apart than one kerf
 * (+0.5 mm) are one cut over the length they overlap. → Map key → mm shared (each side gets HALF
 * of every shared length), plus `.total` = the whole length saved.
 */
export function sharedCutsOnPlate(pieces, kerf = 0) {
  const k = Math.max(0, Number(kerf) || 0);
  const minLen = Math.max(10, 3 * k);
  const out = new Map(pieces.map((q) => [q.key, 0]));
  const items = [];
  for (const q of pieces) {
    const o = cutRings(q.rings);
    if (!o) continue;
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const [x, y] of o.outline) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const edges = [];
    for (const ring of [o.outline, ...o.cutouts]) {
      for (let i = 0, n = ring.length; i < n; i += 1) {
        const a = ring[i]; const b = ring[(i + 1) % n];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len >= minLen) edges.push({ ax: a[0], ay: a[1], ux: (b[0] - a[0]) / len, uy: (b[1] - a[1]) / len, len });
      }
    }
    items.push({ key: q.key, x0, y0, x1, y1, edges });
  }
  items.sort((a, b) => a.x0 - b.x0);
  let total = 0;
  for (let i = 0; i < items.length; i += 1) {
    const A = items[i];
    for (let j = i + 1; j < items.length; j += 1) {
      const B = items[j];
      if (B.x0 > A.x1 + k + TOL) break;
      if (B.y0 > A.y1 + k + TOL || A.y0 > B.y1 + k + TOL) continue;
      let shared = 0;
      for (const e of A.edges) {
        for (const f of B.edges) {
          if (e.ux * f.ux + e.uy * f.uy > -(1 - 1e-6)) continue;                       // not anti-parallel
          // f's start, in e's frame: along e (t) and to the side of e (off). Material lies to the
          // LEFT of a counter-clockwise outline, so a neighbour is on the right: off <= 0.
          const off = e.ux * (f.ay - e.ay) - e.uy * (f.ax - e.ax);
          if (Math.abs(off) > k + TOL) continue;
          const t0 = e.ux * (f.ax - e.ax) + e.uy * (f.ay - e.ay);
          const lo = Math.max(0, t0 - f.len); const hi = Math.min(e.len, t0);
          if (hi - lo > 1e-6) shared += hi - lo;
        }
      }
      if (shared > 0) { out.set(A.key, out.get(A.key) + shared / 2); out.set(B.key, out.get(B.key) + shared / 2); total += shared; }
    }
  }
  out.total = total;
  return out;
}

/**
 * Pure: the cut length and piercings of some laid-out plates — what writePlateCuts stores per cut
 * plate, and what a comparison of two nestings quotes for a whole one (saved or proposed).
 *
 *   lots    [{ kerf, free?, pieces: [{ key, cutPlateId, x, y, length, width, rotationDeg?, rings? }] }]
 *           length / width = the box as placed; rotationDeg absent = lying square.
 *           `free: true` = a free layout (see the header): measured on `rings` — each piece's
 *           outline as placed, { outline, cutouts } in plate mm; a piece without rings is its box.
 *   facts   drawingFactsOfLine (Map cutPlateId → { cutLengthMm, piercings, alongLength, alongWidth })
 *   sizeOf  Map cutPlateId → { length, width } — the cut plate's own size
 *
 * → { cutLengthMm, sharedMm, piercings, pieces, byCutPlate: Map id → { sum, count } }
 */
export function cutsOfLots(lots, facts = new Map(), sizeOf = new Map()) {
  const acc = cutsAccumulator(facts, sizeOf);
  for (const lot of lots) acc.add(lot);
  return acc.result();
}

/** cutsOfLots with the event loop let through between plates — a hundred plates of outlines is not one stretch. */
export async function cutsOfLotsAsync(lots, facts = new Map(), sizeOf = new Map()) {
  const acc = cutsAccumulator(facts, sizeOf);
  let last = Date.now();
  for (const lot of lots) {
    acc.add(lot);
    if (Date.now() - last >= 25) { await new Promise((resolve) => { setImmediate(resolve); }); last = Date.now(); }
  }
  return acc.result();
}

function cutsAccumulator(facts, sizeOf) {
  const sum = new Map();
  const count = new Map();
  let shared = 0; let total = 0; let piercings = 0; let pieces = 0;
  const add = (id, base, len, pierce) => {
    shared += base - len; total += len; piercings += pierce; pieces += 1;
    sum.set(id, (sum.get(id) ?? 0) + len);
    count.set(id, (count.get(id) ?? 0) + 1);
  };
  const addLot = (lot) => {
    if (lot.free && lot.pieces.every((r) => r.x != null && r.y != null)) {
      // A FREE LAYOUT: true perimeters, shared cuts measured on the outlines.
      const list = lot.pieces.map((r) => {
        const id = Number(r.cutPlateId);
        const f = facts.get(id);
        const own = cutRings(r.rings);
        const box = { outline: [[Number(r.x), Number(r.y)], [Number(r.x) + Number(r.length), Number(r.y)], [Number(r.x) + Number(r.length), Number(r.y) + Number(r.width)], [Number(r.x), Number(r.y) + Number(r.width)]], cutouts: [] };
        const size = sizeOf.get(id) ?? {};
        // Its own cut: the drawing's (outline + cut-outs, as partGeometry measured it); else the
        // outline it is placed with; else its own rectangle (never the box round it turned).
        const base = f ? Number(f.cutLengthMm) : own ? cutLengthOfRings(own) : (size.length > 0 && size.width > 0 ? 2 * (Number(size.length) + Number(size.width)) : 2 * (Number(r.length) + Number(r.width)));
        return { key: r.key, id, base, rings: own ?? box, pierce: f?.piercings ?? (own ? 1 + own.cutouts.length : 1) };
      });
      const sharedBy = sharedCutsOnPlate(list, lot.kerf);
      for (const q of list) add(q.id, q.base, Math.max(0, q.base - (sharedBy.get(q.key) ?? 0)), q.pierce);
      return;
    }
    const list = lot.pieces.map((r) => {
      const id = Number(r.cutPlateId);
      const f = facts.get(id);
      const own = sizeOf.get(id) ?? {};
      const free = r.rotationDeg != null && !isQuarterTurn(r.rotationDeg);
      const piece = { key: r.key, cutPlateId: id, x: r.x, y: r.y, length: r.length, width: r.width, free };
      if (f) {
        // Laid along its length (x = the cut plate's LENGTH) or turned.
        const L = Number(own.length);
        const along = !(L > 0) || Math.abs(Number(r.length) - L) <= 1;
        Object.assign(piece, { base: f.cutLengthMm, coverX: along ? f.alongLength : f.alongWidth, coverY: along ? f.alongWidth : f.alongLength });
      } else if (free && own.length > 0 && own.width > 0) {
        piece.base = 2 * (Number(own.length) + Number(own.width));       // its own rectangle, not the box round it turned
      }
      return piece;
    });
    const lengths = cutLengthsOnPlate(list, lot.kerf);
    for (const p of list) add(p.cutPlateId, p.base ?? 2 * (Number(p.length) + Number(p.width)), lengths.get(p.key), facts.get(p.cutPlateId)?.piercings ?? 1);
  };
  return {
    add: addLot,
    result: () => ({ cutLengthMm: r3(total), sharedMm: r3(shared), piercings: r3(piercings), pieces, byCutPlate: new Map([...sum].map(([id, v]) => [id, { sum: v, count: count.get(id) }])) }),
  };
}

/**
 * Puts CUT_LENGTH and PIERCINGS on a line's cut plates from its live nests.
 * cutPlates: [{ id, steel: { length, width } }] — every cut plate of the line.
 * Returns { written, nested, shared } (shared = mm of cut saved by common lines, the whole line).
 */
export async function writePlateCuts(db, c, orderLineId, cutPlates, { facts: known = null } = {}) {
  const companyId = c.companyId;
  const ids = [...new Set((cutPlates ?? []).map((cp) => Number(cp.id)))];
  if (!ids.length) return { written: 0, nested: 0, shared: 0 };
  const [specs] = await db.query("SELECT id, UPPER(code) AS code, default_uom FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND code IN ('CUT_LENGTH', 'PIERCINGS')", [companyId]);
  const spec = new Map(specs.map((s) => [s.code, s]));
  if (!spec.has('CUT_LENGTH')) return { written: 0, nested: 0, shared: 0 };

  const [rows] = await db.query(
    `SELECT p.*, l.kerf_mm, l.source_kind AS lot_source_kind, l.layout_origin AS lot_layout_origin, (l.waste_json LIKE '%"layout":"free"%') AS lot_free
       FROM cf_plate_lots l
       JOIN cf_nest_placements p ON p.company_id = l.company_id AND p.plate_lot_id = l.id AND p.deleted_at IS NULL
      WHERE l.company_id = ? AND l.order_line_id = ? AND l.deleted_at IS NULL AND l.kind = 'plate'`,
    [companyId, orderLineId],
  );
  // A caller that has just read the line's drawings hands them in (`facts`): reading them again is
  // some fifteen round trips, and TiDB is ~49 ms each.
  const facts = known ?? await drawingFactsOfLine(db, companyId, orderLineId);
  const sizeOf = new Map(cutPlates.map((cp) => [Number(cp.id), cp.steel ?? {}]));
  const byLot = new Map();
  const cpById = new Map(cutPlates.map((cp) => [Number(cp.id), cp]));
  const shapes = new Map();
  const shapeOf = (id) => { if (!shapes.has(id)) shapes.set(id, cpById.has(id) ? shapeOfCutPlate(cpById.get(id), facts) : null); return shapes.get(id); };
  const fileRings = (r) => { if (r.rings_json == null) return null; try { return typeof r.rings_json === 'string' ? JSON.parse(r.rings_json) : r.rings_json; } catch { return null; } };
  for (const r of rows) {
    if (!byLot.has(r.plate_lot_id)) byLot.set(r.plate_lot_id, { kerf: Number(r.kerf_mm) || 0, pieces: [], free: r.lot_source_kind === 'shape' || r.lot_layout_origin === 'customer' || Number(r.lot_free) === 1 });
    // rotationDeg only where the row says its turn (§55); an older row lies square or a quarter turned.
    const lot = byLot.get(r.plate_lot_id);
    lot.pieces.push({ key: r.id, cutPlateId: Number(r.cut_plate_id), x: r.x_mm, y: r.y_mm, length: r.length_mm, width: r.width_mm, rotationDeg: r.rotation_deg != null ? rotationOfRow(r) : null, mirrored: !!Number(r.mirrored ?? 0), fileRings: fileRings(r) });
    // A part at a free angle, flipped, or carrying the customer's own outline makes its plate a free layout.
    if (r.x_mm != null && (r.rings_json != null || (r.rotation_deg != null && !isPlainPlacement(rotationOfRow(r), !!Number(r.mirrored ?? 0))))) lot.free = true;
  }
  // Only a free layout needs outlines: each piece's shape (its drawing, else the customer's own
  // outline, else its rectangle) put where the row says.
  for (const lot of byLot.values()) {
    if (!lot.free) continue;
    for (const q of lot.pieces) {
      if (q.x == null || q.y == null) continue;
      const shape = shapeOf(q.cutPlateId);
      if (shape?.drawn || !q.fileRings) q.rings = shape ? placeShape(shape.rings, { x: Number(q.x), y: Number(q.y), rotationDeg: q.rotationDeg ?? 0, mirrored: q.mirrored }) : null;
      else q.rings = q.fileRings;
    }
  }
  const all = await cutsOfLotsAsync([...byLot.values()], facts, sizeOf);
  const sum = new Map([...all.byCutPlate].map(([id, v]) => [id, v.sum]));
  const count = new Map([...all.byCutPlate].map(([id, v]) => [id, v.count]));
  const shared = all.sharedMm;

  const want = [];
  for (const cp of cutPlates) {
    const id = Number(cp.id);
    const f = facts.get(id);
    if (count.has(id)) {
      want.push({ id, code: 'CUT_LENGTH', value: r3(sum.get(id) / count.get(id)), source: 'calculated' });
      if (spec.has('PIERCINGS')) want.push({ id, code: 'PIERCINGS', value: f ? f.piercings : 1, source: 'entered' });
    } else if (f) {
      want.push({ id, code: 'CUT_LENGTH', value: r3(f.cutLengthMm), source: 'calculated' });
      if (spec.has('PIERCINGS')) want.push({ id, code: 'PIERCINGS', value: f.piercings, source: 'entered' });
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

/** The line's cut plates read from the database (their LENGTH and WIDTH), then writePlateCuts. For drawing uploads and backfills. */
export async function refreshPlateCuts(db, c, orderLineId) {
  const companyId = c.companyId;
  const places = await cutPlaces(db, companyId);
  const nodes = [...(places.plate?.blanksIds ?? [])];
  if (!nodes.length) return { written: 0, nested: 0, shared: 0 };
  const [rows] = await db.query(
    `SELECT m.id, UPPER(s.code) AS code, v.value_number FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary' AND i.deleted_at IS NULL AND i.owner_order_line_id = ?
       LEFT JOIN cf_spec_values v ON v.company_id = m.company_id AND v.subject_type = 'master' AND v.subject_id = m.id AND v.deleted_at IS NULL
       LEFT JOIN cf_specifications s ON s.id = v.specification_id AND s.code IN ('LENGTH', 'WIDTH')
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.classification_id IN (?)`,
    [orderLineId, companyId, nodes],
  );
  const cps = new Map();
  for (const r of rows) {
    if (!cps.has(r.id)) cps.set(r.id, { id: r.id, steel: {} });
    if (r.code === 'LENGTH') cps.get(r.id).steel.length = Number(r.value_number);
    if (r.code === 'WIDTH') cps.get(r.id).steel.width = Number(r.value_number);
  }
  return writePlateCuts(db, c, orderLineId, [...cps.values()]);
}
