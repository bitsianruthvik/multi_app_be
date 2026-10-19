/**
 * files.js — a tax file's bytes (a proof, Form 16 / 130 Part A or Part B), the way hiring documents
 * keep theirs (services/documentStorage.js: bytes in the database, DEFLATE-compressed, the type read
 * from the bytes, not from the name) — split into pieces of at most 2 MB, because a proof may be
 * 10 MB and a TiDB row holds about 6 MB.
 *
 *   readUpload(body, { max })   { buffer, fileName, mimeType } — PDF, JPG or PNG only, at most 10 MB
 *   storeFile(db, c, meta, buffer)   → file id (hrms_tax_files + hrms_tax_file_chunks)
 *   fileBytes(db, companyId, id)     → { row, buffer }
 */
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { bad, text, stamp } from './common.js';
import { HrmsError } from '../../lib/errors.js';

const deflate = promisify(zlib.deflate);
const inflate = promisify(zlib.inflate);
export const MAX_PROOF_BYTES = 10 * 1024 * 1024;
const CHUNK = 2 * 1024 * 1024;

/** The type from the first bytes (as hiringService's signed copies): PDF, JPG, PNG — or null. */
export function sniff(buffer) {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

/** { fileName, contentBase64 | dataBase64 } → { buffer, fileName, mimeType }. Refused in words. */
export function readUpload(body = {}, { max = MAX_PROOF_BYTES, allow = ['application/pdf', 'image/jpeg', 'image/png'], what = 'A proof' } = {}) {
  const fileName = text(body.fileName, 255);
  const raw = body.contentBase64 ?? body.dataBase64;
  const problems = [];
  if (!fileName) problems.push('The file needs a name.');
  if (!raw || typeof raw !== 'string') problems.push('No file was received.');
  if (problems.length) throw bad('That file cannot be saved.', problems);
  const base64 = raw.startsWith('data:') && raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  const mb = (x) => `${(x / 1024 / 1024).toFixed(1)} MB`;
  if (base64.length / 4 * 3 > max + 4) throw bad(`That file is over the ${mb(max)} limit.`);
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw bad('That file is empty.');
  if (buffer.length > max) throw bad(`That file is ${mb(buffer.length)}, over the ${mb(max)} limit.`);
  const mimeType = sniff(buffer) ?? (buffer.subarray(0, 2).toString('latin1') === 'PK' ? 'application/zip' : null);
  if (!mimeType || !allow.includes(mimeType)) throw bad(`${what} is ${allow.map((a) => ({ 'application/pdf': 'a PDF', 'image/jpeg': 'a JPG', 'image/png': 'a PNG', 'application/zip': 'a ZIP' }[a])).join(', ').replace(/, ([^,]*)$/, ' or $1')}. Scan or photograph it and upload that.`);
  return { buffer, fileName, mimeType };
}

export async function storeFile(db, c, { purpose, year, employeeId = null, lineId = null, fileName, mimeType, matchedBy = null, panFound = null }, buffer) {
  const packed = await deflate(buffer, { level: zlib.constants.Z_BEST_COMPRESSION });
  const pieces = [];
  for (let i = 0; i < packed.length; i += CHUNK) pieces.push(packed.subarray(i, i + CHUNK));
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const [ins] = await db.query(
    `INSERT INTO hrms_tax_files (company_id, purpose, tax_year, employee_id, line_id, file_name, mime_type, size_bytes, storage, compression, chunk_count, sha256, matched_by, pan_found, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'db', 'deflate', ?, ?, ?, ?, ?)`,
    [c.companyId, purpose, year, employeeId, lineId, fileName, mimeType, buffer.length, pieces.length, sha, matchedBy, panFound, c.userId]);
  for (let i = 0; i < pieces.length; i += 1) {
    await db.query('INSERT INTO hrms_tax_file_chunks (company_id, file_id, seq, content) VALUES (?, ?, ?, ?)', [c.companyId, ins.insertId, i, pieces[i]]);
  }
  return ins.insertId;
}

export async function fileRow(db, companyId, id) {
  const [[r]] = await db.query('SELECT * FROM hrms_tax_files WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!r) throw new HrmsError(404, 'NOT_FOUND', 'That file not found.');
  return r;
}

export async function fileBytes(db, companyId, id) {
  const row = await fileRow(db, companyId, id);
  const [chunks] = await db.query('SELECT content FROM hrms_tax_file_chunks WHERE company_id = ? AND file_id = ? ORDER BY seq', [companyId, id]);
  if (chunks.length !== Number(row.chunk_count)) throw new HrmsError(500, 'BROKEN_FILE', 'That file is incomplete in the database.');
  const packed = Buffer.concat(chunks.map((ch) => ch.content));
  return { row, buffer: row.compression === 'deflate' ? await inflate(packed) : packed };
}

export const shapeFile = (r) => ({ id: r.id, fileName: r.file_name, mimeType: r.mime_type, sizeBytes: Number(r.size_bytes), uploadedAt: stamp(r.created_at) });

/** What a route returns for a download. */
export const transport = ({ row, buffer }) => ({ fileName: row.file_name, mimeType: row.mime_type, contentBase64: buffer.toString('base64') });
