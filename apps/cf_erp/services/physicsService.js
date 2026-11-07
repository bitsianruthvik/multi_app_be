/**
 * THE PHYSICS VIEW OF A STRUCTURE (user, 2026-11-07: "where is the physics view? … build it into the app").
 *
 * The physics screen runs on the structure's ONE model (TM/drawing_bom/src/physics: the frame pulled apart, joints, buckling,
 * moving loads, stages) and writes a self-contained page (physics_view.html: the model as the solver sees it, coloured by
 * stress, with its findings). It is kept ONCE with the standard drawing, beside the model, in cf_standard_drawing_files
 * (kind 'physics', file_kind 'html', version_id NULL; the newest wins), by scripts/cf_kepl/physics-attach.mjs. The app shows
 * it in a sandboxed frame (no access to the app's login). Nothing is computed here.
 *
 * warnings_json keeps what it was computed from: { set, generated, modelSha, summary }. When the standard's model has changed
 * since (its sha differs), the view is said to be out of date — it describes another model.
 */
import crypto from 'crypto';
import { notFound } from '../lib/errors.js';

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const shaCache = new Map();   // model file id → sha1 of its text (a model is a few MB; read once)

async function modelSha(db, companyId, standardId) {
  const [[m]] = await db.query("SELECT id FROM cf_standard_drawing_files WHERE company_id = ? AND standard_id = ? AND kind = 'model' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", [companyId, standardId]);
  if (!m) return null;
  const id = Number(m.id);
  if (!shaCache.has(id)) {
    const [[t]] = await db.query('SELECT file_text FROM cf_standard_drawing_files WHERE id = ?', [id]);
    if (shaCache.size > 32) shaCache.delete(shaCache.keys().next().value);
    shaCache.set(id, crypto.createHash('sha1').update(String(t?.file_text ?? ''), 'utf8').digest('hex'));
  }
  return shaCache.get(id);
}

async function physicsRow(db, companyId, standardId, withText) {
  if (!standardId) return null;
  const [[f]] = await db.query(
    `SELECT id, file_name, warnings_json, created_at${withText ? ', file_text' : ''} FROM cf_standard_drawing_files
      WHERE company_id = ? AND standard_id = ? AND kind = 'physics' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
    [companyId, Number(standardId)],
  );
  return f ?? null;
}

async function infoOf(db, companyId, standardId, f) {
  const meta = parse(f.warnings_json) ?? {};
  const now = await modelSha(db, companyId, Number(standardId));
  return {
    fileId: Number(f.id), savedAt: f.created_at, set: meta.set ?? null, generated: meta.generated ?? null,
    summary: meta.summary ?? null,
    // Computed from another model than the one the line shows now: still viewable, said so.
    stale: !!(meta.modelSha && now && meta.modelSha !== now),
  };
}

async function lineStandardId(db, companyId, orderId, lineId) {
  const [[line]] = await db.query('SELECT standard_id FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(orderId), Number(lineId)]);
  if (!line) throw notFound('Order line');
  return line.standard_id ? Number(line.standard_id) : null;
}

/** GET /orders/:orderId/lines/:lineId/physics → { fileId, savedAt, set, generated, summary, stale }, or 404 when none was run. */
export async function linePhysicsInfo(db, companyId, orderId, lineId) {
  const sid = await lineStandardId(db, companyId, orderId, lineId);
  const f = await physicsRow(db, companyId, sid, false);
  if (!f) throw notFound('Physics view');
  return infoOf(db, companyId, sid, f);
}

/** GET /orders/:orderId/lines/:lineId/physics/page → the page (text/html). */
export async function linePhysicsPage(db, companyId, orderId, lineId) {
  const sid = await lineStandardId(db, companyId, orderId, lineId);
  const f = await physicsRow(db, companyId, sid, true);
  if (!f) throw notFound('Physics view');
  return String(f.file_text ?? '');
}

/** GET /standard-drawings/:id/physics → info; …/physics/page → the page. */
export async function standardPhysicsInfo(db, companyId, standardId) {
  const f = await physicsRow(db, companyId, standardId, false);
  if (!f) throw notFound('Physics view');
  return infoOf(db, companyId, standardId, f);
}
export async function standardPhysicsPage(db, companyId, standardId) {
  const f = await physicsRow(db, companyId, standardId, true);
  if (!f) throw notFound('Physics view');
  return String(f.file_text ?? '');
}
