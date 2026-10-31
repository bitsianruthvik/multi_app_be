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
 */
import { notFound } from '../lib/errors.js';

/** GET /orders/:orderId/lines/:lineId/model3d → the model, or 404 NO_MODEL when the line's standard has none. */
export async function lineModel3d(db, companyId, orderId, lineId) {
  const [[line]] = await db.query('SELECT id, standard_id FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(orderId), Number(lineId)]);
  if (!line) throw notFound('Order line');
  const [[f]] = line.standard_id ? await db.query(
    "SELECT id, file_name, file_text, created_at FROM cf_standard_drawing_files WHERE company_id = ? AND standard_id = ? AND kind = 'model' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
    [companyId, Number(line.standard_id)],
  ) : [[null]];
  if (!f) throw notFound('3D model');
  let model;
  try { model = JSON.parse(f.file_text); } catch { throw notFound('3D model'); }
  return { fileId: Number(f.id), fileName: f.file_name, savedAt: f.created_at, model };
}
