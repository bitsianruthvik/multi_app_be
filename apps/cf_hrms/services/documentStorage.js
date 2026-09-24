/**
 * documentStorage.js — files as BYTES IN THE ROW.
 *
 * The backend runs on Render's free plan, which has no persistent disk: anything
 * written to a local path is gone on the next deploy or spin-down. So an employee
 * photo and an employee document live in a LONGBLOB, DEFLATE-compressed, exactly
 * as fab_item_drawings does (models/init.sql §5a/§5c say so in as many words).
 *
 * THE LIMIT IS THE POINT. TiDB caps a single row near 6 MB and a transaction that
 * exceeds it fails at COMMIT — after the upload has been accepted, with an error
 * nobody can act on. So the ceiling is enforced HERE, before the INSERT, against
 * the COMPRESSED length (that is the number that has to fit), and the refusal
 * names both sizes and the limit so the person knows whether trimming will help.
 *
 * STORAGE IS DELIBERATELY INDIRECT. `storage = 'db'` today; when object storage
 * arrives, new rows carry `storage = 's3'` and a `uri`, `content` stays NULL, and
 * `unpack` picks the branch. Nothing migrates and both kinds read through one
 * endpoint.
 *
 * TRANSPORT IS BASE64 JSON, not multipart. The frontend's only sanctioned HTTP
 * path (@core/api/client) JSON-encodes every body and has no multipart mode, so a
 * multer route here would be a route the frontend cannot call without going around
 * its own client. Express is configured for a 50 MB JSON body (index.js), which is
 * far more headroom than these limits need.
 */

import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { HrmsError } from '../lib/errors.js';

const deflate = promisify(zlib.deflate);
const inflate = promisify(zlib.inflate);

/**
 * Compressed ceilings, both well under TiDB's ~6 MB row limit.
 *
 * A document is the generous one — a scanned Aadhaar or a joining letter is a
 * PDF or a photograph of a page. A profile photo has no business being larger
 * than this; the browser shows it at 72 px.
 */
export const MAX_DOCUMENT_STORED_BYTES = 3 * 1024 * 1024;
export const MAX_PHOTO_STORED_BYTES = 1 * 1024 * 1024;

/**
 * A raw ceiling checked BEFORE decoding, so a 200 MB base64 string is refused on
 * its length rather than after being turned into a Buffer. Compression can still
 * bring a file under the stored limit, which is why this is much larger than the
 * limits above rather than equal to them.
 */
const MAX_RAW_BYTES = 24 * 1024 * 1024;

/**
 * What a person actually attaches to an employee file. Deliberately a list and
 * not "anything": a .exe in an HR record is never intentional, and an unbounded
 * set of types is an unbounded set of things the browser will be asked to render.
 */
const DOCUMENT_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
]);

const PHOTO_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * Turns the JSON an upload arrives as into a Buffer plus the metadata the row
 * needs. Accepts either a bare base64 string or a `data:` URL, because a browser
 * FileReader hands back the latter and stripping it in every caller is how one
 * caller eventually forgets.
 */
export function decodeUpload(input, { field = 'file' } = {}) {
  const fileName = String(input?.fileName ?? '').trim().slice(0, 255);
  const raw = input?.dataBase64 ?? input?.data ?? input?.content;

  if (!raw || typeof raw !== 'string') {
    throw new HrmsError(422, 'NO_FILE', `No ${field} was received.`);
  }
  if (!fileName) {
    throw new HrmsError(422, 'NO_FILE_NAME', 'The file needs a name.');
  }

  const comma = raw.indexOf(',');
  const isDataUrl = raw.startsWith('data:');
  const base64 = isDataUrl && comma > -1 ? raw.slice(comma + 1) : raw;
  const inlineMime = isDataUrl ? /^data:([^;,]+)/.exec(raw)?.[1] : null;

  // 4 base64 characters carry 3 bytes; checking the string length avoids
  // allocating the Buffer at all for something absurd.
  if (base64.length / 4 * 3 > MAX_RAW_BYTES) {
    throw new HrmsError(413, 'FILE_TOO_LARGE', `That file is over the ${mb(MAX_RAW_BYTES)} upload limit.`);
  }

  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) {
    throw new HrmsError(422, 'NO_FILE', 'That file is empty.');
  }

  const mimeType = String(input?.mimeType || inlineMime || '').trim().slice(0, 100)
    || 'application/octet-stream';

  return { buffer, fileName, mimeType, sizeBytes: buffer.length };
}

/**
 * Compresses and checks the ceiling. Returns exactly the columns every blob
 * table in this app carries, so a caller spreads it into its INSERT and cannot
 * forget to set `storage` or `compression`.
 */
export async function packForStorage(buffer, limitBytes, what = 'file') {
  const content = await deflate(buffer, { level: zlib.constants.Z_BEST_COMPRESSION });
  if (content.length > limitBytes) {
    // Both numbers, always. "Too big" on its own leaves someone guessing
    // whether dropping a page or re-scanning at a lower DPI would help.
    throw new HrmsError(
      413,
      'FILE_TOO_LARGE',
      `That ${what} is ${mb(buffer.length)} and still ${mb(content.length)} compressed, over the `
      + `${mb(limitBytes)} limit for storing in the database. Reduce its resolution or split it — `
      + 'the limit lifts when external file storage is connected.',
    );
  }
  return { storage: 'db', compression: 'deflate', content, sizeBytes: buffer.length };
}

/** The bytes back, whichever world they are in. */
export async function unpack(row, what = 'file') {
  if (!row) throw new HrmsError(404, 'NOT_FOUND', `That ${what} does not exist.`);
  if (row.storage === 's3') {
    // The column exists so switching needs no migration. Saying so beats
    // handing back an empty file.
    throw new HrmsError(501, 'NOT_CONNECTED', `This ${what} lives in external storage, which is not connected yet.`);
  }
  if (!row.content) throw new HrmsError(404, 'NO_CONTENT', `That ${what} has no stored content.`);
  return row.compression === 'deflate' ? inflate(row.content) : row.content;
}

export function assertDocumentMime(mimeType) {
  if (!DOCUMENT_MIME.has(mimeType)) {
    throw new HrmsError(
      422,
      'BAD_FILE_TYPE',
      `${mimeType || 'That file type'} is not accepted. Attach a PDF, an image, a Word or Excel file, or plain text.`,
    );
  }
}

export function assertPhotoMime(mimeType) {
  if (!PHOTO_MIME.has(mimeType)) {
    throw new HrmsError(422, 'BAD_FILE_TYPE', 'A photo must be a JPEG, PNG or WebP image.');
  }
}

/** What the browser needs to rebuild the file: bytes as base64 plus its type. */
export function toTransport(buffer, { fileName, mimeType }) {
  return {
    fileName,
    mimeType,
    sizeBytes: buffer.length,
    dataBase64: buffer.toString('base64'),
  };
}
