/**
 * drawingService.js — the drawings for an item, and for everything above it.
 *
 * A drawing is attached to ONE item. The person at the machine needs more than
 * that: cutting a web plate, they want the plate's own drawing AND the segment's
 * AND the girder's, because the assembly context is what says which way round it
 * goes and where the stiffeners land. So `drawingsForItem` walks UP the tree and
 * returns the ancestors' drawings alongside the item's own, labelled with which
 * level each came from.
 *
 * That inheritance is the whole feature. Without it somebody has to attach the
 * general arrangement to all two hundred parts, and then re-attach it when the
 * drawing is revised.
 *
 * STORAGE IS DELIBERATELY INDIRECT. Today the compressed bytes sit in the row
 * (`storage = 'db'`), because the backend has no persistent disk and a drawing
 * that disappears on the next deploy is worse than one that was never uploaded.
 * When S3 is connected, new rows get `storage = 's3'` and a `uri`, `content`
 * stays null, and `readDrawing` picks the branch — no migration, and both kinds
 * download through the same endpoint.
 */

import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { pool } from '../../../db.js';

const deflate = promisify(zlib.deflate);
const inflate = promisify(zlib.inflate);

/**
 * The ceiling, well under TiDB's ~6 MB per-row transaction limit.
 *
 * Checked against the COMPRESSED size, because that is what actually has to fit
 * in the row — and a PDF full of vector linework compresses hard, so a 12 MB
 * drawing often lands comfortably inside. Rejecting on the raw size would turn
 * away files that would have stored fine.
 */
export const MAX_STORED_BYTES = 4 * 1024 * 1024;

const ALLOWED_MIME = new Set(['application/pdf']);

/** Ancestors of an item, nearest first. Bounded — a BOM is levels, not a graph. */
async function ancestorsOf(exec, companyId, itemId) {
  const chain = [];
  let cursor = itemId;
  for (let depth = 0; depth < 12; depth++) {
    const [[row]] = await exec.query(
      `SELECT parent_item_id AS parentId FROM fab_items
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [cursor, companyId],
    );
    if (!row?.parentId) break;
    chain.push(Number(row.parentId));
    cursor = row.parentId;
  }
  return chain;
}

/**
 * Every drawing this item should show: its own, then each ancestor's.
 *
 * Never returns the bytes — a list of a dozen PDFs would be tens of megabytes
 * of JSON. `readDrawing` fetches one when somebody opens it.
 *
 * @returns {Promise<Array<{id, fileName, sizeBytes, revision, itemId, itemName,
 *   itemCode, levelKind, inherited, depth}>>}
 */
export async function drawingsForItem(companyId, itemId, conn = null) {
  const exec = conn ?? pool;
  const chain = await ancestorsOf(exec, companyId, itemId);
  const ids = [Number(itemId), ...chain];

  const [rows] = await exec.query(
    `SELECT d.id, d.item_id AS itemId, d.file_name AS fileName, d.size_bytes AS sizeBytes,
            d.revision, d.notes, d.created_at AS createdAt, d.storage,
            i.name AS itemName, i.code AS itemCode, i.level_kind AS levelKind
       FROM fab_item_drawings d
       JOIN fab_items i ON i.id = d.item_id
      WHERE d.company_id = ? AND d.deleted_at IS NULL
        AND d.item_id IN (${ids.map(() => '?').join(',')})
      ORDER BY d.created_at DESC`,
    [companyId, ...ids],
  );

  // Nearest level first: the part's own drawing is what they reach for, the
  // girder's is context. Sorting by depth rather than date keeps that order
  // stable however the drawings were uploaded.
  const depthOf = new Map(ids.map((id, i) => [Number(id), i]));
  return rows
    .map((r) => ({
      ...r,
      depth: depthOf.get(Number(r.itemId)) ?? 99,
      inherited: Number(r.itemId) !== Number(itemId),
    }))
    .sort((a, b) => a.depth - b.depth || String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Attach a drawing to an item. `buffer` is the file exactly as uploaded. */
export async function addDrawing(companyId, itemId, file, meta = {}, userId = null) {
  if (!file?.buffer?.length) {
    const e = new Error('No file received.');
    e.status = 400;
    throw e;
  }
  if (!ALLOWED_MIME.has(file.mimetype)) {
    const e = new Error(`Only PDF drawings are accepted (got ${file.mimetype || 'unknown'}).`);
    e.status = 400;
    throw e;
  }

  const [[item]] = await pool.query(
    'SELECT id FROM fab_items WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1',
    [itemId, companyId],
  );
  if (!item) { const e = new Error('That item does not exist.'); e.status = 404; throw e; }

  const packed = await deflate(file.buffer, { level: zlib.constants.Z_BEST_COMPRESSION });
  if (packed.length > MAX_STORED_BYTES) {
    // Say both numbers. "Too big" without the actual figures leaves someone
    // guessing whether trimming a page will help.
    const e = new Error(
      `That drawing is ${(file.buffer.length / 1024 / 1024).toFixed(1)} MB and still `
      + `${(packed.length / 1024 / 1024).toFixed(1)} MB compressed, over the `
      + `${(MAX_STORED_BYTES / 1024 / 1024).toFixed(0)} MB limit for storing in the database. `
      + 'Split it or reduce its resolution for now — the limit lifts when file storage is connected.',
    );
    e.status = 413;
    throw e;
  }

  const [res] = await pool.query(
    `INSERT INTO fab_item_drawings
       (company_id, item_id, file_name, mime_type, size_bytes, storage, compression,
        content, revision, notes, uploaded_by)
     VALUES (?, ?, ?, ?, ?, 'db', 'deflate', ?, ?, ?, ?)`,
    [
      companyId, itemId, file.originalname?.slice(0, 255) || 'drawing.pdf',
      file.mimetype, file.buffer.length, packed,
      meta.revision?.slice(0, 40) || null, meta.notes?.slice(0, 500) || null, userId,
    ],
  );
  return {
    id: res.insertId,
    fileName: file.originalname,
    sizeBytes: file.buffer.length,
    storedBytes: packed.length,
  };
}

/** One drawing's bytes, decompressed, ready to stream. */
export async function readDrawing(companyId, drawingId) {
  const [[row]] = await pool.query(
    `SELECT file_name AS fileName, mime_type AS mimeType, storage, compression, content, uri
       FROM fab_item_drawings
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [drawingId, companyId],
  );
  if (!row) { const e = new Error('That drawing does not exist.'); e.status = 404; throw e; }

  if (row.storage === 's3') {
    // Not built yet — the column exists so that switching does not need a
    // migration. Saying so beats returning an empty file.
    const e = new Error('This drawing lives in external storage, which is not connected yet.');
    e.status = 501;
    throw e;
  }
  const buf = row.compression === 'deflate' ? await inflate(row.content) : row.content;
  return { buffer: buf, fileName: row.fileName, mimeType: row.mimeType };
}

export async function deleteDrawing(companyId, drawingId) {
  const [res] = await pool.query(
    `UPDATE fab_item_drawings SET deleted_at = NOW()
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
    [drawingId, companyId],
  );
  if (!res.affectedRows) { const e = new Error('That drawing does not exist.'); e.status = 404; throw e; }
  return { id: Number(drawingId) };
}

/**
 * Drawings visible from a TASK — the thing the shop floor actually asks for.
 *
 * A task points at an item; the operator wants that item's drawings and every
 * ancestor's. This is the same walk as `drawingsForItem`, reached by task id so
 * the queue does not have to know about items.
 */
export async function drawingsForTask(companyId, taskId, conn = null) {
  const exec = conn ?? pool;
  const [[task]] = await exec.query(
    `SELECT item_id AS itemId FROM fab_project_tasks
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [taskId, companyId],
  );
  if (!task?.itemId) return [];
  return drawingsForItem(companyId, task.itemId, exec);
}
