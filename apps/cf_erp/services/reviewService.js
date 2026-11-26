/**
 * THE DRAWING REVIEW OF A STRUCTURE (user, 2026-11-26: "we should be able to see the part by part comparison and all of those
 * screens we build in the image viewer"). drawing_bom's review page (src/review/build.mjs: part after part in red / amber /
 * green with the sheet snippet beside it, "Is every part there?", the doubts and how each was decided, the summary) is kept
 * with the standard drawing, beside its model and physics, by scripts/cf_kepl/review-attach.mjs.
 *
 * Stored as one bundle in cf_standard_drawing_files, kind 'review', version_id NULL, every row of a bundle sharing `mark`
 * (the bundle key): the page (file_name 'index.html', file_kind 'html'), its data ('data.json', 'json') and each image
 * ('img/<name>', 'jpg', the bytes base64 in file_text). The newest bundle wins; an attach retires the older one. The page
 * holds crops of the customer's sheets: it is served only to the owning company, with view permission, for a sandboxed
 * frame (the app hands it its data and images; it never reaches this origin). Nothing is computed here.
 *
 * warnings_json on the page row keeps { set, built, modelSha, summary }; when the standard's model has changed since (its
 * sha differs), the review is said to be out of date.
 */
import crypto from 'crypto';
import { notFound } from '../lib/errors.js';

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const shaCache = new Map();
async function modelSha(db, companyId, standardId) {
  const [[m]] = await db.query("SELECT id FROM cf_standard_drawing_files WHERE company_id = ? AND standard_id = ? AND kind = 'model' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", [companyId, standardId]);
  if (!m) return null;
  const id = Number(m.id);
  if (!shaCache.has(id)) {
    const [[t]] = await db.query('SELECT file_text FROM cf_standard_drawing_files WHERE company_id = ? AND id = ?', [companyId, id]);
    if (shaCache.size > 32) shaCache.delete(shaCache.keys().next().value);
    shaCache.set(id, crypto.createHash('sha1').update(String(t?.file_text ?? ''), 'utf8').digest('hex'));
  }
  return shaCache.get(id);
}
/** The newest bundle's page row (no text). */
async function pageRow(db, companyId, standardId) {
  if (!standardId) return null;
  const [[f]] = await db.query(
    `SELECT id, mark, warnings_json, created_at FROM cf_standard_drawing_files
      WHERE company_id = ? AND standard_id = ? AND kind = 'review' AND file_name = 'index.html' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
    [companyId, Number(standardId)],
  );
  return f ?? null;
}
async function lineStandardId(db, companyId, orderId, lineId) {
  const [[line]] = await db.query('SELECT standard_id FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(orderId), Number(lineId)]);
  if (!line) throw notFound('Order line');
  return line.standard_id ? Number(line.standard_id) : null;
}
async function info(db, companyId, standardId) {
  const f = await pageRow(db, companyId, standardId);
  if (!f) throw notFound('Drawing review');
  const meta = parse(f.warnings_json) ?? {};
  const now = await modelSha(db, companyId, standardId);
  return {
    fileId: Number(f.id), savedAt: f.created_at, set: meta.set ?? null, built: meta.built ?? null, summary: meta.summary ?? null,
    stale: !!(meta.modelSha && now && meta.modelSha !== now),
  };
}
/** One file of the newest bundle: 'index.html', 'data.json' or 'img/<name>'. → { kind, text } (an image's text is base64). */
async function file(db, companyId, standardId, name) {
  const f = await pageRow(db, companyId, standardId);
  if (!f) throw notFound('Drawing review');
  const n = String(name ?? '');
  if (!/^(index\.html|data\.json|img\/[A-Za-z0-9._-]{1,200})$/.test(n)) throw notFound('Review file');
  const [[r]] = await db.query(
    "SELECT file_kind, file_text FROM cf_standard_drawing_files WHERE company_id = ? AND standard_id = ? AND kind = 'review' AND mark = ? AND file_name = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
    [companyId, Number(standardId), f.mark, n],
  );
  if (!r) throw notFound('Review file');
  return { kind: r.file_kind, text: String(r.file_text ?? '') };
}

/** GET /orders/:orderId/lines/:lineId/review → { fileId, savedAt, set, built, summary, stale }, or 404 when none is kept. */
export async function lineReviewInfo(db, companyId, orderId, lineId) {
  return info(db, companyId, await lineStandardId(db, companyId, orderId, lineId));
}
/** GET /orders/:orderId/lines/:lineId/review/file?name= → one file of the review. */
export async function lineReviewFile(db, companyId, orderId, lineId, name) {
  return file(db, companyId, await lineStandardId(db, companyId, orderId, lineId), name);
}
/** GET /standard-drawings/:id/review → info; …/review/file?name= → one file. */
export async function standardReviewInfo(db, companyId, standardId) {
  return info(db, companyId, Number(standardId));
}
export async function standardReviewFile(db, companyId, standardId, name) {
  return file(db, companyId, Number(standardId), name);
}

/** Sends one review file: the page and data as text (for a sandboxed frame, never a page of this origin), an image as bytes. */
export function sendReviewFile(res, f) {
  res.setHeader('Cache-Control', 'private, max-age=600');
  if (f.kind === 'jpg' || f.kind === 'png') { res.setHeader('Content-Type', f.kind === 'png' ? 'image/png' : 'image/jpeg'); res.send(Buffer.from(f.text, 'base64')); return; }
  res.setHeader('Content-Type', f.kind === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
  res.send(f.text);
}
