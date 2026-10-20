/**
 * proofs.js — proofs of declarations: the person uploads files to a line (PDF / JPG / PNG, at most
 * 10 MB each; files.js stores them), HR verifies (an accepted amount, which may be lower than
 * declared) or rejects (with a reason). TM/CF_HRMS_HIRING_SPEC.md §25.4.
 *
 *   DECLARED ──upload──▶ SUBMITTED ──verify──▶ VERIFIED (accepted amount)
 *                            │      ──reject──▶ REJECTED (reason) ──upload again──▶ SUBMITTED
 */
import { audit, bad, refuse, text, money, n, json, today, assertNotOwn } from './common.js';
import { readUpload, storeFile, fileRow, fileBytes } from './files.js';
import { lineRow, shapeLine, canProve, KINDS, filesOfLines } from './declarations.js';

/** POST …/declarations/:lineId/proofs { fileName, contentBase64 } */
export async function uploadProof(db, c, lineId, body = {}, { by = 'SELF', employeeId = null, requestId = null } = {}) {
  const r = await lineRow(db, c.companyId, lineId, { employeeId });
  if (by !== 'HR') {
    const can = await canProve(db, c.companyId, r.employee_id, r.tax_year);
    if (!can.open) {
      throw refuse('WINDOW_CLOSED', can.window.state === 'NOT_YET'
        ? `Proofs for ${r.tax_year} are taken from ${can.window.from} to ${can.window.to}.`
        : `The proof window for ${r.tax_year} closed on ${can.window.to}. Ask HR.`);
    }
    if (r.status === 'VERIFIED') throw refuse('VERIFIED', 'HR has already verified this declaration.');
  }
  const { buffer, fileName, mimeType } = readUpload(body);
  const [[k]] = await db.query("SELECT COUNT(*) AS k FROM hrms_tax_files WHERE company_id = ? AND line_id = ? AND purpose = 'PROOF' AND deleted_at IS NULL", [c.companyId, lineId]);
  if (Number(k.k) >= 10) throw refuse('TOO_MANY', 'At most ten files on one declaration. Combine pages into one PDF.');
  const fileId = await storeFile(db, c, { purpose: 'PROOF', year: r.tax_year, employeeId: r.employee_id, lineId, fileName, mimeType }, buffer);
  const status = r.status === 'VERIFIED' ? 'VERIFIED' : 'SUBMITTED';
  await db.query('UPDATE hrms_tax_declaration_lines SET status = ?, submitted_at = NOW(), reject_reason = IF(? = \'SUBMITTED\', NULL, reject_reason) WHERE company_id = ? AND id = ?', [status, status, c.companyId, lineId]);
  await audit(db, c, 'hrms_tax_files', fileId, 'CREATE', null, { lineId, fileName, mimeType, sizeBytes: buffer.length, by, status }, requestId);
  const files = await filesOfLines(db, c.companyId, [lineId]);
  const [[after]] = await db.query('SELECT * FROM hrms_tax_declaration_lines WHERE id = ?', [lineId]);
  return { line: shapeLine(after, files.get(lineId)), fileId };
}

/** A proof file, with its line (to check whose it is). */
export async function proofFile(db, c, fileId, { employeeId = null } = {}) {
  const row = await fileRow(db, c.companyId, fileId);
  if (row.purpose !== 'PROOF' || (employeeId && row.employee_id !== employeeId)) throw bad('That is not a proof of yours.');
  return fileBytes(db, c.companyId, fileId);
}

export async function removeProof(db, c, fileId, { employeeId = null, by = 'SELF', requestId = null } = {}) {
  const row = await fileRow(db, c.companyId, fileId);
  if (row.purpose !== 'PROOF' || (employeeId && row.employee_id !== employeeId)) throw bad('That is not a proof of yours.');
  const line = await lineRow(db, c.companyId, row.line_id);
  if (by !== 'HR' && line.status === 'VERIFIED') throw refuse('VERIFIED', 'HR has verified this declaration; its proofs stay.');
  await db.query('UPDATE hrms_tax_files SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, fileId]);
  const [[k]] = await db.query("SELECT COUNT(*) AS k FROM hrms_tax_files WHERE company_id = ? AND line_id = ? AND purpose = 'PROOF' AND deleted_at IS NULL", [c.companyId, row.line_id]);
  if (!Number(k.k) && line.status === 'SUBMITTED') await db.query("UPDATE hrms_tax_declaration_lines SET status = 'DECLARED', submitted_at = NULL WHERE id = ?", [row.line_id]);
  await audit(db, c, 'hrms_tax_files', fileId, 'DELETE', { lineId: row.line_id, fileName: row.file_name }, { by }, requestId);
  return { ok: true };
}

/** GET /tax/:year/proofs?status=SUBMITTED&kind=&q= — HR's queue (oldest first). */
export async function proofQueue(db, c, year, query = {}) {
  const where = ['l.company_id = ?', 'l.tax_year = ?', 'l.deleted_at IS NULL'];
  const params = [c.companyId, year];
  const status = String(query.status ?? 'SUBMITTED').toUpperCase();
  if (status !== 'ALL') { where.push('l.status = ?'); params.push(status); }
  if (query.kind) { where.push('l.kind = ?'); params.push(String(query.kind).toUpperCase()); }
  if (query.employeeId) { where.push('l.employee_id = ?'); params.push(Number(query.employeeId)); }
  if (query.q) { where.push('(e.full_name LIKE ? OR e.employee_code LIKE ?)'); const like = `%${String(query.q).trim().slice(0, 100)}%`; params.push(like, like); }
  const [rows] = await db.query(
    `SELECT l.*, e.employee_code, e.full_name FROM hrms_tax_declaration_lines l JOIN hrms_employees e ON e.company_id = l.company_id AND e.id = l.employee_id
      WHERE ${where.join(' AND ')} ORDER BY COALESCE(l.submitted_at, l.created_at), l.id LIMIT 2000`, params);
  const files = await filesOfLines(db, c.companyId, rows.map((r) => r.id));
  const [counts] = await db.query('SELECT status, COUNT(*) AS k FROM hrms_tax_declaration_lines WHERE company_id = ? AND tax_year = ? AND deleted_at IS NULL GROUP BY status', [c.companyId, year]);
  return {
    year,
    lines: rows.map((r) => ({ ...shapeLine(r, files.get(r.id)), employee: { id: r.employee_id, code: r.employee_code, name: r.full_name }, proofHint: KINDS[r.kind]?.proof ?? null })),
    counts: Object.fromEntries(counts.map((x) => [x.status, Number(x.k)])),
  };
}

/** POST /tax/proof-lines/:id/verify { acceptedAmount? } — the declared amount when not given. */
export async function verifyLine(db, c, lineId, body = {}, requestId = null) {
  const r = await lineRow(db, c.companyId, lineId);
  await assertNotOwn(db, c, r.employee_id, 'tax proof');
  const declared = n(r.declared_amount);
  let accepted = declared;
  if (body.acceptedAmount !== undefined && body.acceptedAmount !== null && body.acceptedAmount !== '') {
    accepted = Number(String(body.acceptedAmount).replace(/[₹,\s]/g, ''));
    if (!Number.isFinite(accepted) || accepted < 0) throw bad('Accepted amount: an amount, zero or more.');
    if (accepted > declared) throw bad(`Accepted amount: at most what was declared (₹${declared.toLocaleString('en-IN')}).`);
  }
  if (r.status === 'DECLARED' && !body.withoutProof) throw refuse('NO_PROOF', 'No proof has been uploaded for this declaration yet.');
  await db.query("UPDATE hrms_tax_declaration_lines SET status = 'VERIFIED', accepted_amount = ?, reject_reason = NULL, reviewed_at = NOW(), reviewed_by = ? WHERE company_id = ? AND id = ?",
    [money(accepted), c.userId, c.companyId, lineId]);
  await audit(db, c, 'hrms_tax_declaration_lines', lineId, 'APPROVE', { status: r.status, declared }, { status: 'VERIFIED', accepted: money(accepted), note: text(body.note, 300) }, requestId);
  const [[after]] = await db.query('SELECT * FROM hrms_tax_declaration_lines WHERE id = ?', [lineId]);
  return { line: shapeLine(after) };
}

export async function rejectLine(db, c, lineId, body = {}, requestId = null) {
  const r = await lineRow(db, c.companyId, lineId);
  await assertNotOwn(db, c, r.employee_id, 'tax proof');
  const reason = text(body.reason, 500);
  if (!reason || reason.length < 3) throw bad('Say why the proof is rejected — the person sees it.');
  await db.query("UPDATE hrms_tax_declaration_lines SET status = 'REJECTED', accepted_amount = NULL, reject_reason = ?, reviewed_at = NOW(), reviewed_by = ? WHERE company_id = ? AND id = ?",
    [reason, c.userId, c.companyId, lineId]);
  await audit(db, c, 'hrms_tax_declaration_lines', lineId, 'UPDATE', { status: r.status }, { status: 'REJECTED', reason }, requestId);
  const [[after]] = await db.query('SELECT * FROM hrms_tax_declaration_lines WHERE id = ?', [lineId]);
  return { line: shapeLine(after) };
}

/** POST /tax/:year/proofs/bulk-accept { lineIds } — each SUBMITTED line verified at its declared amount. */
export async function bulkAccept(db, c, year, body = {}, requestId = null) {
  const ids = [...new Set((Array.isArray(body.lineIds) ? body.lineIds : []).map(Number).filter((x) => Number.isInteger(x) && x > 0))];
  if (!ids.length) throw bad('Choose the proofs to accept.');
  if (ids.length > 500) throw bad('At most 500 at a time.');
  const [rows] = await db.query(`SELECT id, status, employee_id FROM hrms_tax_declaration_lines WHERE company_id = ? AND tax_year = ? AND deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`, [c.companyId, year, ...ids]);
  const accepted = [];
  const skipped = [];
  for (const r of rows) {
    if (r.status !== 'SUBMITTED') { skipped.push({ id: r.id, why: `it is ${r.status.toLowerCase()}` }); continue; }
    try { await assertNotOwn(db, c, r.employee_id, 'tax proof'); } catch { skipped.push({ id: r.id, why: 'it is your own — another person in HR verifies it' }); continue; }
    await verifyLine(db, c, r.id, {}, requestId);
    accepted.push(r.id);
  }
  for (const id of ids) if (!rows.some((r) => r.id === id)) skipped.push({ id, why: 'not a declaration of this year' });
  return { accepted, skipped };
}

export { json, today };
