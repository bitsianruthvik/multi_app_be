/**
 * THE 3D MODEL OF A LINE (user, 2026-10-31: "a 3D version in the tool to show the diagram in 3D").
 *
 * A model is a JSON file (`cf-erp-model3d/1`, below) kept with the line's STANDARD drawing in cf_standard_drawing_files
 * (kind 'model', file_kind 'json', version_id NULL — so it is neither one of a version's part files nor copied onto
 * lines). It is written by whoever read the drawings (e.g. TM/drawing_bom/src/truss/model3d.mjs); the viewer only draws
 * it, the way the takeoff tool draws its model.json.
 *
 *   { schema: 'cf-erp-model3d/1', units: 'mm', title, up: 'z', elements: [
 *       { id, mark, in: [ancestor marks], label,
 *         member: { a: [x,y,z], b: [x,y,z], up: [x,y,z], section: { type: 'I', h, bTop, bBot, tTop, tBot, tw }
 *                                                              | { type: 'box', h, w, bTop, bBot, tTop, tBot, tw }
 *                                                              | { type: 'pipe', d, t } } }
 *     | { id, mark, in, label, box: { c: [x,y,z], size: [sx,sy,sz] } } ] }
 * `mark` / `in` are the drawing marks of the line's rows, so the viewer can light up the level that is open.
 *
 * `cf-erp-model3d/2` (user, 2026-11-02: one JSON per structure, every level drawn from it on screen; docs/model_as_source.md)
 * adds `parts` (each part's outline, holes, cut-outs and thickness, once), `levels` (name and quantity), `bolts`, and elements
 * that name their part and where it sits: { id, mark, in, n: [copy of each level], part, o, u, v, w, rule? }, or
 * { studs: { a, di, ni, dj, nj, d, h, up } }. This service only hands the file over; the screens expand it
 * (multi_app_fe lib/modelDrawing.ts).
 */
import { invalid, notFound } from '../lib/errors.js';
import { applyLineEdits, withPlaced } from '../lib/lineModelEdits.js';
import { rowsOfLine } from './partDrawingService.js';

/** GET /orders/:orderId/lines/:lineId/model3d → the model, or 404 NO_MODEL when the line's standard has none. */
export async function lineModel3d(db, companyId, orderId, lineId) {
  const [[line]] = await db.query('SELECT l.*, o.code AS order_code FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.order_id = ? AND l.id = ? AND l.deleted_at IS NULL', [companyId, Number(orderId), Number(lineId)]);
  if (!line) throw notFound('Order line');
  const [[f]] = line.standard_id ? await db.query(
    "SELECT id, file_name, file_text, created_at FROM cf_standard_drawing_files WHERE company_id = ? AND standard_id = ? AND kind = 'model' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
    [companyId, Number(line.standard_id)],
  ) : [[null]];
  if (!f) throw notFound('3D model');
  let model;
  try { model = JSON.parse(f.file_text); } catch { throw notFound('3D model'); }
  // Each mark's code on this line, without the order's prefix ("STS(1,2,3)-MTA1-JL2A") — the 3D view's Codes labels (user, 2026-11-01).
  const codes = {};
  const rows = await rowsOfLine(db, companyId, line);
  for (const r of rows) {
    if (!r.markNorm || !r.code || codes[r.markNorm]) continue;
    const pre = `${line.order_code}-`;
    codes[r.markNorm] = r.code.startsWith(pre) ? r.code.slice(pre.length) : r.code;
  }
  // The line's own BOM edits on the standard's model (lib/lineModelEdits.js, user 2026-11-12): removed rows hidden, new
  // rows as boxes, part DXFs uploaded since the model was saved drawn in their place. The standard's file never changes.
  const parents = new Set(rows.map((r) => r.parentId).filter((x) => x != null).map(Number));
  const [dxfs] = await db.query(
    "SELECT id, mark, mark_norm, file_name, geometry_json, created_at FROM cf_part_drawings WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND file_kind = 'dxf' AND geometry_json IS NOT NULL ORDER BY created_at, id",
    [companyId, line.id],
  );
  // A part's first DXF on the line is the line's own drawing from its import (the outline it was built from), not a change.
  // Only a later DXF for the same mark is a replacement (user, 2026-11-14: 145 import drawings were counted as changes).
  const seen = new Set();
  const revised = dxfs.filter((d) => { const k = d.mark_norm ?? d.mark; if (seen.has(k)) return true; seen.add(k); return false; });
  const drawings = revised.map((d) => {
    let g = null;
    try { g = JSON.parse(d.geometry_json); } catch { g = null; }
    return { id: Number(d.id), mark: d.mark, markNorm: d.mark_norm, fileName: d.file_name, createdAt: d.created_at, geometry: g };
  });
  const done = applyLineEdits(model, {
    savedAt: f.created_at, edits: line.model_edits_json ?? null, drawings,
    rows: rows.map((r) => ({ ...r, hasChildren: parents.has(Number(r.id)) })),
  });
  return { fileId: Number(f.id), fileName: f.file_name, savedAt: f.created_at, model: done.model, codes, edits: done.edits };
}

/**
 * PUT /orders/:orderId/lines/:lineId/model3d/place { rowId, at: [x, y, z] | null } — where a new row's cuboid sits (its
 * left-front-bottom corner, model mm); null puts it back beside its parent. Stored on the line (model_edits_json), never on
 * the standard. Refused once the line is locked or released, or the order is closed.
 */
export async function placeAddedRow(db, c, orderId, lineId, input = {}) {
  const [[line]] = await db.query(
    `SELECT l.*, o.status AS order_status FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id
      WHERE l.company_id = ? AND l.order_id = ? AND l.id = ? AND l.deleted_at IS NULL FOR UPDATE`,
    [c.companyId, Number(orderId), Number(lineId)],
  );
  if (!line) throw notFound('Order line');
  if (['closed', 'cancelled', 'revised', 'lost'].includes(line.order_status)) throw invalid('ORDER_CLOSED', `The order is ${line.order_status} — its lines cannot change.`);
  if (line.locked_at || line.release_id) throw invalid('LOCKED', 'This line is locked, so its diagram can no longer change.');
  const rowId = Number(input.rowId);
  if (!Number.isInteger(rowId) || rowId <= 0) throw invalid('INVALID', 'Say which row to move.');
  const [[own]] = await db.query('SELECT master_id FROM cf_item_details WHERE company_id = ? AND master_id = ? AND owner_order_line_id = ? AND deleted_at IS NULL LIMIT 1', [c.companyId, rowId, line.id]);
  if (!own) throw notFound('Row');
  let at = null;
  if (input.at != null) {
    at = Array.isArray(input.at) ? input.at.map(Number) : [];
    if (at.length !== 3 || !at.every((v) => Number.isFinite(v) && Math.abs(v) < 1e7)) throw invalid('INVALID', 'X, Y and Z are numbers of millimetres.');
  }
  await db.query('UPDATE cf_sales_order_lines SET model_edits_json = ? WHERE company_id = ? AND id = ?',
    [JSON.stringify(withPlaced(line.model_edits_json ?? null, rowId, at)), c.companyId, line.id]);
  return { rowId, at };
}

/**
 * GET /standard-drawings/:id/model3d → the standard's own 3D model, for its Drawings tab (user, 2026-11-01: "in drawings
 * tab also same tool as SO"). A standard has no order, so no codes: the viewer labels by mark.
 */
export async function standardModel3d(db, companyId, standardId) {
  const [[f]] = await db.query(
    "SELECT id, file_name, file_text, created_at FROM cf_standard_drawing_files WHERE company_id = ? AND standard_id = ? AND kind = 'model' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
    [companyId, Number(standardId)],
  );
  if (!f) throw notFound('3D model');
  let model;
  try { model = JSON.parse(f.file_text); } catch { throw notFound('3D model'); }
  return { fileId: Number(f.id), fileName: f.file_name, savedAt: f.created_at, model, codes: {} };
}
