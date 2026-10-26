/**
 * hiringService.js — filling a vacant position. (TM/CF_HRMS_HIRING_SPEC.md §2.)
 *
 *   JD  ->  OFFER  ->  APPOINTMENT  ->  DONE
 *                \->  CLOSED (DECLINED | LAPSED | CANCELLED), from any stage before DONE
 *
 *   JD           the position's job description is confirmed and a copy frozen
 *   OFFER        candidate and terms are entered; the offer letter is generated
 *                (and may be generated again until the offer is accepted)
 *   APPOINTMENT  the offer was accepted; the joining date is confirmed
 *   DONE         the person is an employee, in the position
 *
 * ── THE CANDIDATE IS A DRAFT UNTIL DONE ───────────────────────────────────
 * Their details live on the hiring row and nowhere else. No employee row, no
 * employee code, no headcount, no attendance. A hiring that is closed never
 * used an employee code. The LETTER REFERENCE is different: it is issued with
 * the first offer letter and kept even if the hiring is then closed, because a
 * number that went out on a letter must not go out again on somebody else's.
 *
 * ── APPOINTING IS ONE TRANSACTION ─────────────────────────────────────────
 * `appoint` re-checks, under a lock, that the position is still free; issues
 * the employee code; creates the employee through peopleService (the same
 * validation, JOIN event and audit row as any other employee); assigns them to
 * the position on its shift through assignmentService; renders and stores the
 * appointment letter; and sets the hiring DONE. Every write is on the caller's
 * connection. If any of them fails the route's transaction rolls back, and the
 * employee code goes back with it — the generator's counter is a row in the
 * same transaction.
 *
 * ── `missing` AND `can` COME FROM ONE FUNCTION ────────────────────────────
 * `readiness()` decides what each action still needs and whether the server
 * will accept it. The hiring a screen reads carries its answer, and every
 * action calls it again before doing anything — so a button the screen offers
 * is a request this file accepts, and a refusal reads the same in both places.
 *
 * ── A JOINING DATE IN THE FUTURE ──────────────────────────────────────────
 * The assignment is created ACTIVE from the joining date, which is what every
 * other assignment with a future start is in this app: dates decide whether it
 * is live, not the status. So by the one-chair rule (seatCount.js: filled = an
 * assignment that is not ENDED and is in date) the position stays VACANT in
 * every count until the joining date and is filled from that morning. In
 * between it is nobody else's to take: a second person (POSITION_FILLED) and a
 * second hiring (POSITION_FILLED, naming the joiner and the date) are both
 * refused, because their dates would overlap the appointed person's.
 *
 * ── FILES ─────────────────────────────────────────────────────────────────
 * Letters and templates are bytes in the row through documentStorage.js. The
 * frozen job description is a ROLE_JD row of hrms_generated_documents for this
 * position, made by documentService.generate — it stays downloadable from the
 * hiring after a later JD for the position supersedes it as "current".
 */
import { HrmsError, invalid, notFound, conflict, assertNoProblems } from '../lib/errors.js';
import { dateText, today, requirePosition, LIVE_ON } from './positionService.js';
import { loadReportingModel } from './reportingResolver.js';
import { createEmployee, createEvent, audit, addDocument, deleteDocument } from './peopleService.js';
import { createAssignment } from './assignmentService.js';
import {
  generate as generateDocument, readDocumentFile, previewDocument, renderFromSnapshot, getDocument,
} from './documentService.js';
import { packForStorage, unpack, MAX_DOCUMENT_STORED_BYTES } from './documentStorage.js';
import { issueHiringRef } from './codeService.js';
import { HOLDS_SEAT_SQL } from './seatCount.js';
import {
  OPEN_STAGES, statusLineOf, CLOSE_REASON_GROUPS, LEGACY_CLOSE_REASONS, closeReasonCode, closeReasonLabel, closeReasonOf, closeReasonsFor,
} from './hiringRead.js';
import { NOTICE_JOIN_SQL, NOTICE_COLUMNS_SQL, noticeOf, shortDay } from './exitRead.js';
import { SHIFT_SUMMARY_COLUMNS_SQL, summaryFromRow } from './shiftRead.js';
import {
  LETTER_KINDS, PLACEHOLDERS, DOCX_MIME,
  letterValues, letterDate, renderLetter, inspectTemplate, builtInTemplate, builtInFileName,
} from './letterRenderer.js';

export const HIRING_STAGES = ['JD', 'OFFER', 'APPOINTMENT', 'DONE', 'CLOSED'];
/** The fourteen reasons of spec §3.4 (hiringRead.js holds them, with when each applies). */
export const CLOSE_REASONS = CLOSE_REASON_GROUPS.flatMap((g) => g.reasons.map((r) => r.code));

const SETTINGS_DEFAULTS = { probation_months: 3, notice_days_probation: 15, notice_days_confirmed: 30, offer_valid_days: 7 };

/* ══════════════════════════════════════════════════════════════════════════
 * Small helpers
 * ══════════════════════════════════════════════════════════════════════════ */

const has = (o, k) => Object.prototype.hasOwnProperty.call(o ?? {}, k);
const clean = (v) => (v === null || v === undefined ? null : (String(v).trim() || null));
const stamp = (v) => (v instanceof Date ? v.toISOString() : v ?? null);
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? '')) && !Number.isNaN(Date.parse(`${s}T00:00:00`));
const fileSafe = (s) => String(s ?? '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return dateText(d);
}

const wrongStage = (message) => conflict('WRONG_STAGE', message);

/* ══════════════════════════════════════════════════════════════════════════
 * Settings — what a letter prints that is the company's
 * ══════════════════════════════════════════════════════════════════════════ */

const shapeSettings = (row, companyName) => ({
  companyLegalName: row?.company_legal_name ?? companyName ?? null,
  signatoryName: row?.signatory_name ?? null,
  signatoryDesignation: row?.signatory_designation ?? null,
  placeOfPosting: row?.place_of_posting ?? null,
  jurisdiction: row?.jurisdiction ?? null,
  probationMonths: Number(row?.probation_months ?? SETTINGS_DEFAULTS.probation_months),
  noticeDaysProbation: Number(row?.notice_days_probation ?? SETTINGS_DEFAULTS.notice_days_probation),
  noticeDaysConfirmed: Number(row?.notice_days_confirmed ?? SETTINGS_DEFAULTS.notice_days_confirmed),
  offerValidDays: Number(row?.offer_valid_days ?? SETTINGS_DEFAULTS.offer_valid_days),
});

/** One read: the settings row, and the company's name for a company that has not saved any. */
async function loadSettings(db, companyId) {
  const [[row]] = await db.query(
    `SELECT c.name AS company_name, s.*
       FROM companies c
       LEFT JOIN hrms_hiring_settings s ON s.company_id = c.id
      WHERE c.id = ?`,
    [companyId],
  );
  return shapeSettings(row?.id ? row : null, row?.company_name ?? null);
}

export async function getSettings(db, companyId) {
  return { settings: await loadSettings(db, companyId) };
}

const SETTINGS_TEXT = [
  ['companyLegalName', 'company_legal_name', 'Company name', 200],
  ['signatoryName', 'signatory_name', 'Signatory name', 200],
  ['signatoryDesignation', 'signatory_designation', 'Signatory designation', 200],
  ['placeOfPosting', 'place_of_posting', 'Place of posting', 300],
  ['jurisdiction', 'jurisdiction', 'Jurisdiction', 200],
];
const SETTINGS_NUMBERS = [
  ['probationMonths', 'probation_months', 'Probation', 0, 36, 'months'],
  ['noticeDaysProbation', 'notice_days_probation', 'Notice during probation', 0, 365, 'days'],
  ['noticeDaysConfirmed', 'notice_days_confirmed', 'Notice after confirmation', 0, 365, 'days'],
  ['offerValidDays', 'offer_valid_days', 'Offer validity', 1, 365, 'days'],
];

function readText(body, key, label, max, problems) {
  const v = clean(body[key]);
  if (v && v.length > max) problems.push(`${label} is up to ${max} characters.`);
  return v ? v.slice(0, max) : null;
}

function readCount(body, key, label, min, max, unit, problems) {
  const n = Number(body[key]);
  if (body[key] === null || body[key] === '' || !Number.isInteger(n) || n < min || n > max) {
    problems.push(`${label} is a whole number of ${unit} from ${min} to ${max}.`);
    return null;
  }
  return n;
}

/** Only what was sent changes. The row is created the first time somebody saves. */
export async function updateSettings(conn, c, body = {}, requestId = null) {
  const problems = [];
  const set = {};
  for (const [key, col, label, max] of SETTINGS_TEXT) if (has(body, key)) set[col] = readText(body, key, label, max, problems);
  for (const [key, col, label, min, max, unit] of SETTINGS_NUMBERS) if (has(body, key)) set[col] = readCount(body, key, label, min, max, unit, problems);
  assertNoProblems(problems, 'The hiring settings cannot be saved yet.');

  const [[row]] = await conn.query('SELECT id FROM hrms_hiring_settings WHERE company_id = ? FOR UPDATE', [c.companyId]);
  const cols = Object.keys(set);
  if (!row) {
    const all = { company_id: c.companyId, created_by: c.userId, ...set };
    const keys = Object.keys(all);
    await conn.query(`INSERT INTO hrms_hiring_settings (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((k) => all[k]));
  } else if (cols.length) {
    await conn.query(`UPDATE hrms_hiring_settings SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE company_id = ?`,
      [...cols.map((k) => set[k]), c.companyId]);
  }
  await audit(conn, c, 'hrms_hiring_settings', c.companyId, row ? 'UPDATE' : 'CREATE', null, { fields: cols }, requestId);
  return getSettings(conn, c.companyId);
}

/* ══════════════════════════════════════════════════════════════════════════
 * Letter templates
 * ══════════════════════════════════════════════════════════════════════════ */

function readKind(value) {
  const kind = String(value ?? '').trim().toUpperCase();
  if (!LETTER_KINDS.includes(kind)) throw invalid('INVALID', 'A letter template is for the offer letter or the appointment letter.');
  return kind;
}

const TEMPLATE_COLUMNS = 'id, kind, file_name, size_bytes, uploaded_at';

async function currentTemplates(db, companyId) {
  const [rows] = await db.query(
    `SELECT ${TEMPLATE_COLUMNS} FROM hrms_letter_templates
      WHERE company_id = ? AND is_current = 1 AND deleted_at IS NULL`,
    [companyId],
  );
  return new Map(rows.map((r) => [r.kind, r]));
}

async function shapeTemplate(kind, row) {
  if (row) return { kind, fileName: row.file_name, sizeBytes: Number(row.size_bytes) || 0, uploadedAt: stamp(row.uploaded_at), builtIn: false };
  return { kind, fileName: builtInFileName(kind), sizeBytes: (await builtInTemplate(kind)).length, uploadedAt: null, builtIn: true };
}

/** Both kinds, always: the company's own template, or the built-in one it falls back to. */
export async function listTemplates(db, companyId) {
  const mine = await currentTemplates(db, companyId);
  return { templates: await Promise.all(LETTER_KINDS.map((kind) => shapeTemplate(kind, mine.get(kind)))) };
}

/** The bytes a letter of this kind is rendered from. */
async function templateFor(db, companyId, kind) {
  const [[row]] = await db.query(
    `SELECT id, file_name, storage, compression, content FROM hrms_letter_templates
      WHERE company_id = ? AND kind = ? AND is_current = 1 AND deleted_at IS NULL`,
    [companyId, kind],
  );
  if (!row) return { id: null, builtIn: true, fileName: builtInFileName(kind), buffer: await builtInTemplate(kind) };
  return { id: row.id, builtIn: false, fileName: row.file_name, buffer: await unpack(row, 'letter template') };
}

export async function readTemplateFile(db, companyId, kindParam) {
  const t = await templateFor(db, companyId, readKind(kindParam));
  return { fileName: t.fileName, mimeType: DOCX_MIME, contentBase64: t.buffer.toString('base64') };
}

/**
 * Uploads a company's own template. body: { fileName, contentBase64 }.
 * The file must open as a Word document; which placeholders it uses comes back
 * with it, the unknown ones named so a typo is seen at upload and not on a letter.
 */
export async function putTemplate(conn, c, kindParam, body = {}, requestId = null) {
  const kind = readKind(kindParam);
  const fileName = clean(body.fileName)?.slice(0, 255) ?? null;
  const raw = body.contentBase64 ?? body.dataBase64;
  const problems = [];
  if (!fileName) problems.push('The file needs a name.');
  else if (!/\.docx$/i.test(fileName)) problems.push('A template is a Word document (.docx).');
  if (!raw || typeof raw !== 'string') problems.push('No file was received.');
  assertNoProblems(problems, 'That template cannot be saved.');

  const base64 = raw.startsWith('data:') && raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  // A letter is a few hundred kB. Refused on its length, before it is decoded.
  if (base64.length / 4 * 3 > 12 * 1024 * 1024) throw new HrmsError(413, 'FILE_TOO_LARGE', 'That file is over the 12 MB upload limit for a letter template.');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw invalid('NO_FILE', 'That file is empty.');

  const { placeholders, unknown } = await inspectTemplate(buffer);
  const packed = await packForStorage(buffer, MAX_DOCUMENT_STORED_BYTES, 'letter template');

  await conn.query(
    'UPDATE hrms_letter_templates SET is_current = 0 WHERE company_id = ? AND kind = ? AND is_current = 1 AND deleted_at IS NULL',
    [c.companyId, kind],
  );
  const [ins] = await conn.query(
    `INSERT INTO hrms_letter_templates (company_id, kind, file_name, size_bytes, storage, compression, content, uploaded_by, is_current, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [c.companyId, kind, fileName, packed.sizeBytes, packed.storage, packed.compression, packed.content, c.userId, c.userId],
  );
  await audit(conn, c, 'hrms_letter_templates', ins.insertId, 'CREATE', null, { kind, fileName, sizeBytes: packed.sizeBytes, placeholders, unknown }, requestId);

  const [[row]] = await conn.query(`SELECT ${TEMPLATE_COLUMNS} FROM hrms_letter_templates WHERE company_id = ? AND id = ?`, [c.companyId, ins.insertId]);
  return { template: await shapeTemplate(kind, row), placeholders, unknown };
}

export function listPlaceholders() {
  return { placeholders: PLACEHOLDERS.map(({ key, label, example }) => ({ key, label, example })) };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Reading a hiring
 * ══════════════════════════════════════════════════════════════════════════ */

const HIRING_SELECT = `
  SELECT h.*,
         p.position_code, p.position_title, p.role_id, p.department_id AS position_department_id,
         p.location_id AS position_location_id, p.default_shift_id, p.status AS position_status,
         r.title AS role_title, d.name AS position_department_name,
         s.code AS shift_code, s.name AS shift_name, ${SHIFT_SUMMARY_COLUMNS_SQL('s')},
         e.employee_code, e.full_name AS employee_name,
         ol.id AS has_offer_letter,
         gd.generated_at AS jd_generated_at
    FROM hrms_hirings h
    JOIN hrms_positions p ON p.company_id = h.company_id AND p.id = h.position_id
    LEFT JOIN hrms_roles       r ON r.company_id = p.company_id AND r.id = p.role_id
    LEFT JOIN hrms_departments d ON d.company_id = p.company_id AND d.id = p.department_id
    LEFT JOIN hrms_shifts      s ON s.company_id = p.company_id AND s.id = p.default_shift_id
    LEFT JOIN hrms_employees   e ON e.company_id = h.company_id AND e.id = h.employee_id
    LEFT JOIN hrms_hiring_letters ol
           ON ol.company_id = h.company_id AND ol.hiring_id = h.id
          AND ol.kind = 'OFFER' AND ol.is_current = 1 AND ol.deleted_at IS NULL
    LEFT JOIN hrms_generated_documents gd ON gd.company_id = h.company_id AND gd.id = h.jd_document_id`;

function shapeSummary(h, asOf) {
  return {
    id: h.id,
    stage: h.stage,
    // The code as it is today: a hiring closed under one of the first release's three codes reads as its new one.
    closeReason: closeReasonCode(h.close_reason),
    closeReasonLabel: closeReasonLabel(h.close_reason),
    refNo: h.ref_no ?? null,
    positionId: h.position_id,
    positionCode: h.position_code ?? null,
    roleId: h.role_id,
    roleTitle: h.role_title ?? h.position_title ?? '',
    // The position's department. What the LETTER prints is terms.departmentName.
    departmentId: h.position_department_id ?? null,
    departmentName: h.position_department_name ?? null,
    shift: h.default_shift_id ? { id: h.default_shift_id, code: h.shift_code ?? null, name: h.shift_name ?? null, summary: summaryFromRow(h, 'shift_') } : null,
    candidateName: h.candidate_name ?? null,
    offerAccepted: Boolean(h.offer_accepted_on),
    offerAcceptedOn: dateText(h.offer_accepted_on),
    proposedJoiningDate: dateText(h.proposed_joining_date),
    createdAt: stamp(h.created_at),
    updatedAt: stamp(h.updated_at),
    employee: h.employee_id ? { id: h.employee_id, employeeCode: h.employee_code ?? null, fullName: h.employee_name ?? null } : null,
    statusLine: statusLineOf(h, asOf),
  };
}

const shapeLetter = (l) => ({
  id: l.id,
  kind: l.kind,
  version: l.version,
  isCurrent: Boolean(l.is_current),
  fileName: l.file_name,
  sizeBytes: Number(l.size_bytes) || 0,
  generatedAt: stamp(l.generated_at),
  generatedByName: l.generated_by_name ?? null,
});

/**
 * WHAT EACH ACTION STILL NEEDS, AND WHETHER THE SERVER WILL TAKE IT.
 * The one decision: `getHiring` returns it and every action below asks it.
 *
 * `missing` is in plain words, ready to print after "Still needed:".
 */
export function readiness(h) {
  const offerLetter = [];
  if (!clean(h.candidate_name)) offerLetter.push('the candidate’s name');
  if (!clean(h.designation)) offerLetter.push('the designation');
  if (!h.proposed_joining_date) offerLetter.push('the proposed date of joining');
  if (h.annual_ctc === null || h.annual_ctc === undefined) offerLetter.push('the annual CTC');
  if (!h.offer_valid_until) offerLetter.push('the date the offer is valid until');

  const appoint = [];
  if (h.stage === 'JD') appoint.push('the job description to be confirmed');
  if (h.stage === 'JD' || h.stage === 'OFFER') appoint.push('the offer to be accepted');
  if (!clean(h.candidate_name)) appoint.push('the candidate’s name');

  const open = OPEN_STAGES.includes(h.stage);
  return {
    missing: { offerLetter, appoint },
    can: {
      edit: h.stage === 'OFFER' || h.stage === 'APPOINTMENT',
      confirmJd: h.stage === 'JD',
      generateOffer: h.stage === 'OFFER' && offerLetter.length === 0,
      acceptOffer: h.stage === 'OFFER' && Boolean(h.has_offer_letter),
      appoint: h.stage === 'APPOINTMENT' && appoint.length === 0,
      close: open,
      // Signed copies (spec §5.3): the candidate's signed offer once an offer letter exists — at any later
      // stage, closed included; the signed appointment letter once the person is appointed.
      uploadSignedOffer: Boolean(h.has_offer_letter),
      uploadSignedAppointment: h.stage === 'DONE',
    },
  };
}

function shapeHiring(h, letters, asOf) {
  return {
    ...shapeSummary(h, asOf),
    candidate: {
      salutation: h.candidate_salutation ?? null,
      name: h.candidate_name ?? null,
      phone: h.candidate_phone ?? null,
      email: h.candidate_email ?? null,
      address: h.candidate_address ?? null,
      gender: h.candidate_gender ?? null,
      dateOfBirth: dateText(h.candidate_date_of_birth),
    },
    terms: {
      designation: h.designation ?? null,
      departmentName: h.department_name ?? null,
      reportingToTitle: h.reporting_to_title ?? null,
      reportingToName: h.reporting_to_name ?? null,
      placeOfPosting: h.place_of_posting ?? null,
      proposedJoiningDate: dateText(h.proposed_joining_date),
      offerDate: dateText(h.offer_date),
      offerValidUntil: dateText(h.offer_valid_until),
      annualCtc: h.annual_ctc === null || h.annual_ctc === undefined ? null : Number(h.annual_ctc),
      probationMonths: Number(h.probation_months),
      noticeDaysProbation: Number(h.notice_days_probation),
      noticeDaysConfirmed: Number(h.notice_days_confirmed),
      signatoryName: h.signatory_name ?? null,
      signatoryDesignation: h.signatory_designation ?? null,
    },
    offerAcceptedOn: dateText(h.offer_accepted_on),
    joiningDate: dateText(h.joining_date),
    appointmentDate: dateText(h.appointment_date),
    closeNote: h.close_note ?? null,
    assignmentId: h.assignment_id ?? null,
    jd: h.jd_document_id ? { documentId: h.jd_document_id, generatedAt: stamp(h.jd_generated_at) } : null,
    letters: letters.map(shapeLetter),
    // Filled by getHiring: the signed copy of each letter, or null.
    signed: { offer: null, appointment: null },
    ...readiness(h),
  };
}

async function loadRow(db, companyId, id, { lock = false } = {}) {
  // The lock is on the hiring row alone: taken first, by id, then the wide read.
  if (lock) await db.query('SELECT id FROM hrms_hirings WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [companyId, id]);
  const [[h]] = await db.query(`${HIRING_SELECT} WHERE h.company_id = ? AND h.id = ? AND h.deleted_at IS NULL`, [companyId, id]);
  if (!h) throw notFound('That hiring');
  return h;
}

async function loadLetters(db, companyId, hiringId) {
  const [rows] = await db.query(
    `SELECT l.id, l.kind, l.version, l.is_current, l.file_name, l.size_bytes, l.generated_at, u.name AS generated_by_name
       FROM hrms_hiring_letters l
       LEFT JOIN users u ON u.id = l.generated_by
      WHERE l.company_id = ? AND l.hiring_id = ? AND l.deleted_at IS NULL AND l.kind IN (?)
      ORDER BY l.generated_at DESC, l.id DESC`,
    [companyId, hiringId, LETTER_KINDS],
  );
  return rows;
}

export async function getHiring(db, companyId, id) {
  const h = await loadRow(db, companyId, id);
  const hiring = shapeHiring(h, await loadLetters(db, companyId, id), today());
  hiring.signed = await loadSigned(db, companyId, id);
  // While it is open: the person on notice in the position, whom this hiring replaces. The
  // joining date must be after their last working day, so the screen is told that day.
  const leaving = OPEN_STAGES.includes(h.stage) ? (await holdersFrom(db, companyId, h.position_id, today())).find((x) => x.exit_id != null) : null;
  hiring.replacing = leaving
    ? { employeeId: leaving.employee_id, name: leaving.full_name, ...noticeOf(leaving) }
    : null;
  return { hiring };
}

/** ?status=open|done|closed|all (all when absent) &positionId= */
export async function listHirings(db, companyId, query = {}, { departmentIds = null } = {}) {
  // A login scoped to a department sees the hirings on positions inside it (accessScope.js); none when its scope is empty.
  if (departmentIds && !departmentIds.length) return { hirings: [] };
  const where = ['h.company_id = ?', 'h.deleted_at IS NULL'];
  const params = [companyId];
  if (departmentIds) { where.push('p.department_id IN (?)'); params.push(departmentIds); }
  const status = String(query.status ?? 'all').trim().toLowerCase();
  if (!['open', 'done', 'closed', 'all'].includes(status)) throw invalid('INVALID', 'status is open, done, closed or all.');
  if (status === 'open') { where.push('h.stage IN (?)'); params.push(OPEN_STAGES); }
  if (status === 'done') where.push("h.stage = 'DONE'");
  if (status === 'closed') where.push("h.stage = 'CLOSED'");
  if (query.positionId !== undefined && query.positionId !== null && query.positionId !== '') {
    const positionId = Number(query.positionId);
    if (!Number.isInteger(positionId) || positionId <= 0) throw invalid('INVALID', 'positionId must be a positive whole number.');
    where.push('h.position_id = ?');
    params.push(positionId);
  }
  const [rows] = await db.query(`${HIRING_SELECT} WHERE ${where.join(' AND ')} ORDER BY h.updated_at DESC, h.id DESC`, params);
  const asOf = today();
  return { hirings: rows.map((h) => shapeSummary(h, asOf)) };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Starting
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Everybody who holds — or is due to hold — a position from a date on, earliest
 * first. "Holds" is seatCount's predicate (not deleted, not ENDED); the dates
 * are compared as a range, so a person appointed from next month is found today.
 *
 * Each row says whether that person is ON NOTICE (exit_id, exit_last_working_day
 * — exitRead.js): their position may be hired for, and they are not in the way
 * of somebody who joins after their last working day.
 */
async function holdersFrom(db, companyId, positionId, from) {
  const [rows] = await db.query(
    `SELECT wa.id, wa.employee_id, wa.effective_from, e.full_name, ${NOTICE_COLUMNS_SQL('x')}
       FROM hrms_work_assignments wa
       JOIN hrms_employees e ON e.company_id = wa.company_id AND e.id = wa.employee_id
       ${NOTICE_JOIN_SQL('wa', 'x')}
      WHERE wa.company_id = ? AND wa.position_id = ? AND ${HOLDS_SEAT_SQL('wa')}
        AND (wa.effective_to IS NULL OR wa.effective_to >= ?)
      ORDER BY wa.effective_from, wa.id`,
    [companyId, positionId, from],
  );
  return rows;
}

function positionFilled(position, occupant, on) {
  const what = `${position.position_title || position.role_title || 'This position'}${position.position_code ? ` (${position.position_code})` : ''}`;
  const from = dateText(occupant.effective_from);
  const sentence = from && from > on
    ? `${what} is taken: ${occupant.full_name} joins it on ${letterDate(from)}.`
    : `${what} is filled by ${occupant.full_name}.`;
  return conflict('POSITION_FILLED', `${sentence} A position is for one person.`, {
    detail: { positionId: position.id, occupant: { employeeId: occupant.employee_id, name: occupant.full_name, assignmentId: occupant.id, from } },
  });
}

/** The position with the facts a hiring prints by default: its role, department and who it reports to. */
async function positionFacts(db, companyId, positionId, on, { lock = false } = {}) {
  const position = await requirePosition(db, companyId, positionId, { lock });
  const [[facts]] = await db.query(
    `SELECT r.title AS role_title, d.name AS department_name
       FROM hrms_positions p
       LEFT JOIN hrms_roles       r ON r.company_id = p.company_id AND r.id = p.role_id
       LEFT JOIN hrms_departments d ON d.company_id = p.company_id AND d.id = p.department_id
      WHERE p.company_id = ? AND p.id = ?`,
    [companyId, positionId],
  );
  // The primary manager's position, and the person in it today.
  const [[manager]] = await db.query(
    `SELECT mp.id, COALESCE(mp.position_title, mr.title) AS title, e.full_name AS occupant_name
       FROM hrms_position_reporting_relationships rr
       JOIN hrms_reporting_relationship_types t ON t.company_id = rr.company_id AND t.id = rr.relationship_type_id
       JOIN hrms_positions mp ON mp.company_id = rr.company_id AND mp.id = rr.to_position_id AND mp.deleted_at IS NULL
       LEFT JOIN hrms_roles mr ON mr.company_id = mp.company_id AND mr.id = mp.role_id
       LEFT JOIN hrms_work_assignments wa
              ON wa.company_id = mp.company_id AND wa.position_id = mp.id AND ${HOLDS_SEAT_SQL('wa')} AND ${LIVE_ON('wa')}
       LEFT JOIN hrms_employees e ON e.company_id = wa.company_id AND e.id = wa.employee_id
      WHERE rr.company_id = ? AND rr.from_position_id = ? AND rr.deleted_at IS NULL
        AND t.code = 'PRIMARY_MANAGER' AND ${LIVE_ON('rr')}
      ORDER BY rr.is_primary DESC, rr.id, wa.is_primary DESC, wa.id LIMIT 1`,
    [on, on, companyId, positionId, on, on],
  );
  // Spec §40.3: no explicit line -> the manager its org unit gives it (the unit's head, or its Reports into).
  let resolved = manager ?? null;
  if (!resolved) {
    const model = await loadReportingModel(db, companyId, { on });
    const s = model.step(positionId);
    if (s && s.source !== 'EXPLICIT') {
      const m = model.positions.get(s.managerId);
      resolved = { id: s.managerId, title: m?.title ?? null, occupant_name: m?.occupantName ?? null, source: s.source };
    }
  }
  return { ...position, role_title: facts?.role_title ?? null, department_name: facts?.department_name ?? null, manager: resolved };
}

/**
 * POST /positions/:id/hiring — starts at JD.
 * 409 POSITION_CLOSED · 409 POSITION_FILLED · 409 HIRING_OPEN (`existing.id` / `detail.hiringId` is the open one).
 */
export async function startHiring(conn, c, positionId, requestId = null) {
  const on = today();
  const position = await positionFacts(conn, c.companyId, positionId, on, { lock: true });
  if (position.status === 'CLOSED') throw conflict('POSITION_CLOSED', 'That position is closed. Reopen it before hiring for it.');

  // Filled by somebody who is staying: refused. Filled by somebody ON NOTICE: this is
  // "Hire a replacement", and it is allowed — the position is about to be vacant.
  const staying = (await holdersFrom(conn, c.companyId, positionId, on)).find((x) => x.exit_id == null);
  if (staying) throw positionFilled(position, staying, on);

  const [[open]] = await conn.query(
    'SELECT id, stage FROM hrms_hirings WHERE company_id = ? AND position_id = ? AND deleted_at IS NULL AND stage IN (?) LIMIT 1',
    [c.companyId, positionId, OPEN_STAGES],
  );
  if (open) {
    throw conflict('HIRING_OPEN', 'A hiring is already open on this position. Continue that one.', {
      existing: { id: open.id, stage: open.stage }, detail: { hiringId: open.id, positionId: Number(positionId) },
    });
  }

  const settings = await loadSettings(conn, c.companyId);
  const row = {
    company_id: c.companyId,
    position_id: positionId,
    stage: 'JD',
    designation: position.position_title || position.role_title || null,
    department_name: position.department_name,
    reporting_to_title: position.manager?.title ?? null,
    reporting_to_name: position.manager?.occupant_name ?? null,
    place_of_posting: settings.placeOfPosting,
    offer_date: on,
    offer_valid_until: addDays(on, settings.offerValidDays),
    probation_months: settings.probationMonths,
    notice_days_probation: settings.noticeDaysProbation,
    notice_days_confirmed: settings.noticeDaysConfirmed,
    signatory_name: settings.signatoryName,
    signatory_designation: settings.signatoryDesignation,
    created_by: c.userId,
  };
  const keys = Object.keys(row);
  const [ins] = await conn.query(`INSERT INTO hrms_hirings (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((k) => row[k]));
  await audit(conn, c, 'hrms_hirings', ins.insertId, 'CREATE', null, { positionId: Number(positionId), positionCode: position.position_code ?? null, stage: 'JD' }, requestId);
  return getHiring(conn, c.companyId, ins.insertId);
}

/* ══════════════════════════════════════════════════════════════════════════
 * JD -> OFFER
 * ══════════════════════════════════════════════════════════════════════════ */

/** What a section of the job description is called when it is said to be empty. Keys are the JD builder's. */
const JD_SECTION_WORDS = {
  purpose: 'the role’s purpose',
  summary: 'a summary of the role',
  kras: 'key result areas',
  responsibilities: 'responsibilities',
  kpis: 'KPIs',
  skills: 'skills',
  qualifications: 'qualifications',
  experience: 'experience',
  authorities: 'authorities',
  relationships: 'working relationships',
  conditions: 'working conditions',
};

/**
 * Whether a job description can be confirmed, read off the JD builder's own
 * snapshot — so the preview, the readiness and the confirm step cannot disagree.
 *
 *   missing  every section nothing has been written for, in plain words. The
 *            JD still prints each of them, saying so.
 *   ready    false only when the role has NO purpose AND NO key result area:
 *            a job description of a title alone is not one. Anything more may
 *            be confirmed.
 */
export function jdReadiness(snapshot) {
  const empty = snapshot?.summary?.emptySections ?? [];
  return {
    ready: !(empty.includes('purpose') && empty.includes('kras')),
    missing: empty.filter((k) => JD_SECTION_WORDS[k]).map((k) => JD_SECTION_WORDS[k]),
  };
}

/** The position's job description as the system holds it NOW: the documents service's own preview, nothing stored. */
const liveJd = (db, c, h) => previewDocument(db, c, { type: 'ROLE_JD', positionId: h.position_id, on: today() });

/**
 * GET /hirings/:id/jd/preview -> { preview, readiness }
 *
 * `preview` is the object GET /documents/preview returns for this position's
 * ROLE_JD — { persisted, asOf, documentType, snapshot } — built by the same
 * function, so the screen draws it with the component it already has:
 *   - until the JD is confirmed, from the system as it is now (persisted: false);
 *   - afterwards, from the FROZEN copy (persisted: true, with its documentId):
 *     what was confirmed, even if the role has been rewritten since.
 */
export async function jdPreview(db, c, id) {
  const h = await loadRow(db, c.companyId, id);
  if (!h.jd_document_id) {
    const preview = await liveJd(db, c, h);
    return { preview, readiness: jdReadiness(preview.snapshot) };
  }
  const { document, snapshot } = await getDocument(db, c.companyId, h.jd_document_id);
  return {
    preview: { persisted: true, asOf: snapshot?.asOf ?? null, documentType: snapshot?.documentType ?? 'ROLE_JD', snapshot, documentId: document.id },
    readiness: jdReadiness(snapshot),
  };
}

/**
 * Freezes the position's job description and moves on to the offer.
 * 422 JD_NOT_READY only when the role has NO purpose AND NO key result area
 * (jdReadiness, above — the same answer the preview gave).
 */
export async function confirmJd(conn, c, id, requestId = null) {
  const h = await loadRow(conn, c.companyId, id, { lock: true });
  if (!readiness(h).can.confirmJd) {
    throw wrongStage(OPEN_STAGES.includes(h.stage) ? 'The job description of this hiring is already confirmed.' : 'This hiring is finished.');
  }

  if (!jdReadiness((await liveJd(conn, c, h)).snapshot).ready) {
    throw invalid('JD_NOT_READY', 'This role has no job description yet. Write its purpose or add a key result area, then confirm.', {
      problems: ['The role has no purpose written.', 'The role has no key result areas.'],
    });
  }

  // Position-level, so the position's own responsibilities and KPIs are in it.
  const doc = await generateDocument(conn, c, { type: 'ROLE_JD', positionId: h.position_id, on: today() }, requestId);
  await conn.query("UPDATE hrms_hirings SET stage = 'OFFER', jd_document_id = ? WHERE company_id = ? AND id = ?", [doc.id, c.companyId, id]);
  await audit(conn, c, 'hrms_hirings', id, 'UPDATE', { stage: 'JD' }, { stage: 'OFFER', jdDocumentId: doc.id }, requestId);
  return getHiring(conn, c.companyId, id);
}

const JD_MIME = { docx: DOCX_MIME, pdf: 'application/pdf' };

/**
 * GET /hirings/:id/jd/file?format=docx|pdf — in EVERY stage.
 * Before the JD is confirmed it is rendered from the system as it is now and
 * nothing is stored; afterwards it is the frozen copy.
 */
export async function readJdFile(db, c, id, formatParam = 'docx') {
  const format = String(formatParam ?? 'docx').trim().toLowerCase() || 'docx';
  if (!JD_MIME[format]) throw invalid('INVALID', 'format is docx or pdf.');
  const h = await loadRow(db, c.companyId, id);
  if (h.jd_document_id) {
    const file = await readDocumentFile(db, c.companyId, h.jd_document_id, format);
    return { fileName: file.fileName, mimeType: file.mimeType, contentBase64: file.dataBase64 };
  }
  const { snapshot } = await liveJd(db, c, h);
  const buffer = await renderFromSnapshot(snapshot, format);
  return { fileName: `${snapshot.fileBaseName}.${format}`, mimeType: JD_MIME[format], contentBase64: buffer.toString('base64') };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Editing the candidate and the terms
 * ══════════════════════════════════════════════════════════════════════════ */

// [body key, nested as, column, label, max length]
const TEXT_FIELDS = [
  ['candidateSalutation', ['candidate', 'salutation'], 'candidate_salutation', 'Salutation', 10],
  ['candidateName', ['candidate', 'name'], 'candidate_name', 'Candidate name', 200],
  ['candidatePhone', ['candidate', 'phone'], 'candidate_phone', 'Phone', 40],
  ['candidateEmail', ['candidate', 'email'], 'candidate_email', 'Email', 200],
  ['candidateAddress', ['candidate', 'address'], 'candidate_address', 'Address', 1000],
  ['candidateGender', ['candidate', 'gender'], 'candidate_gender', 'Gender', 40],
  ['designation', ['terms', 'designation'], 'designation', 'Designation', 200],
  ['departmentName', ['terms', 'departmentName'], 'department_name', 'Department', 200],
  ['reportingToTitle', ['terms', 'reportingToTitle'], 'reporting_to_title', 'Reporting to (title)', 200],
  ['reportingToName', ['terms', 'reportingToName'], 'reporting_to_name', 'Reporting to (name)', 200],
  ['placeOfPosting', ['terms', 'placeOfPosting'], 'place_of_posting', 'Place of posting', 300],
  ['signatoryName', ['terms', 'signatoryName'], 'signatory_name', 'Signatory name', 200],
  ['signatoryDesignation', ['terms', 'signatoryDesignation'], 'signatory_designation', 'Signatory designation', 200],
];
const DATE_FIELDS = [
  ['candidateDateOfBirth', ['candidate', 'dateOfBirth'], 'candidate_date_of_birth', 'Date of birth'],
  ['proposedJoiningDate', ['terms', 'proposedJoiningDate'], 'proposed_joining_date', 'Proposed date of joining'],
  ['offerDate', ['terms', 'offerDate'], 'offer_date', 'Offer date'],
  ['offerValidUntil', ['terms', 'offerValidUntil'], 'offer_valid_until', 'Offer valid until'],
];
const COUNT_FIELDS = [
  ['probationMonths', ['terms', 'probationMonths'], 'probation_months', 'Probation', 0, 36, 'months'],
  ['noticeDaysProbation', ['terms', 'noticeDaysProbation'], 'notice_days_probation', 'Notice during probation', 0, 365, 'days'],
  ['noticeDaysConfirmed', ['terms', 'noticeDaysConfirmed'], 'notice_days_confirmed', 'Notice after confirmation', 0, 365, 'days'],
];

/**
 * A field as the spec names it (flat camelCase of the column: `candidateName`)
 * or as the hiring is returned (`candidate.name`, `terms.designation`). A
 * screen that sends back the object it read works either way.
 */
function sent(body, key, [group, inner]) {
  if (has(body, key)) return { given: true, value: body[key] };
  if (body[group] && typeof body[group] === 'object' && has(body[group], inner)) return { given: true, value: body[group][inner] };
  return { given: false, value: undefined };
}

/**
 * PUT /hirings/:id — candidate and terms. Only what was sent changes.
 * Allowed in OFFER and APPOINTMENT; 422 INVALID with every problem at once.
 */
export async function updateHiring(conn, c, id, body = {}, requestId = null) {
  const h = await loadRow(conn, c.companyId, id, { lock: true });
  if (!readiness(h).can.edit) {
    if (h.stage === 'JD') throw wrongStage('Confirm the job description first. The candidate and the terms are entered after that.');
    throw wrongStage(h.stage === 'DONE'
      ? 'This hiring is finished. Its details can no longer be changed — change the employee instead.'
      : 'This hiring is closed. Its details can no longer be changed.');
  }

  const problems = [];
  const set = {};
  for (const [key, nested, col, label, max] of TEXT_FIELDS) {
    const f = sent(body, key, nested);
    if (!f.given) continue;
    // The address keeps its line breaks: it is stored as it prints.
    const v = col === 'candidate_address'
      ? (String(f.value ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n') || null)
      : clean(f.value);
    if (v && v.length > max) problems.push(`${label} is up to ${max} characters.`);
    set[col] = v ? v.slice(0, max) : null;
  }
  for (const [key, nested, col, label] of DATE_FIELDS) {
    const f = sent(body, key, nested);
    if (!f.given) continue;
    const v = clean(f.value)?.slice(0, 10) ?? null;
    if (v && !isDay(v)) { problems.push(`${label} needs a date as YYYY-MM-DD.`); continue; }
    set[col] = v;
  }
  for (const [key, nested, col, label, min, max, unit] of COUNT_FIELDS) {
    const f = sent(body, key, nested);
    if (!f.given) continue;
    const n = Number(f.value);
    if (f.value === null || f.value === '' || !Number.isInteger(n) || n < min || n > max) {
      problems.push(`${label} is a whole number of ${unit} from ${min} to ${max}.`);
      continue;
    }
    set[col] = n;
  }
  const ctc = sent(body, 'annualCtc', ['terms', 'annualCtc']);
  if (ctc.given) {
    if (ctc.value === null || ctc.value === '') set.annual_ctc = null;
    else {
      const n = Number(String(ctc.value).replace(/,/g, ''));
      if (!Number.isFinite(n) || n <= 0 || n >= 1e12) problems.push('Annual CTC is an amount in rupees, more than zero.');
      else set.annual_ctc = Math.round(n * 100) / 100;
    }
  }

  const next = { ...h, ...set };
  if (set.candidate_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(set.candidate_email)) problems.push('That email address does not look right.');
  if (has(set, 'candidate_name') && !set.candidate_name && h.has_offer_letter) problems.push('The candidate’s name cannot be cleared once an offer letter exists.');
  const born = dateText(next.candidate_date_of_birth);
  if (has(set, 'candidate_date_of_birth') && born && born >= today()) problems.push('The date of birth is in the future.');
  const offerDate = dateText(next.offer_date);
  const validUntil = dateText(next.offer_valid_until);
  if ((has(set, 'offer_date') || has(set, 'offer_valid_until')) && offerDate && validUntil && validUntil < offerDate) {
    problems.push('The offer cannot be valid until a date before the offer date.');
  }
  assertNoProblems(problems, 'These details cannot be saved yet.');

  const cols = Object.keys(set);
  if (cols.length) {
    await conn.query(`UPDATE hrms_hirings SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...cols.map((k) => set[k]), c.companyId, id]);
    // Which fields changed, never their values: a salary and an address do not belong in an audit row.
    await audit(conn, c, 'hrms_hirings', id, 'UPDATE', null, { fields: cols }, requestId);
  }
  return getHiring(conn, c.companyId, id);
}

/* ══════════════════════════════════════════════════════════════════════════
 * Letters
 * ══════════════════════════════════════════════════════════════════════════ */

/** The facts one letter prints, from the hiring as it stands. */
function letterFacts(h, settings, kind, { employeeCode = null } = {}) {
  return {
    refNo: h.ref_no,
    letterDate: kind === 'OFFER' ? dateText(h.offer_date) : dateText(h.appointment_date),
    salutation: h.candidate_salutation,
    candidateName: h.candidate_name,
    candidatePhone: h.candidate_phone,
    candidateAddress: h.candidate_address,
    designation: h.designation,
    department: h.department_name,
    reportingToTitle: h.reporting_to_title,
    reportingToName: h.reporting_to_name,
    placeOfPosting: h.place_of_posting,
    // An offer states the proposed date; an appointment the confirmed one.
    joiningDate: kind === 'OFFER' ? dateText(h.proposed_joining_date) : dateText(h.joining_date),
    offerValidUntil: dateText(h.offer_valid_until),
    annualCtc: h.annual_ctc,
    probationMonths: h.probation_months,
    noticeDaysProbation: h.notice_days_probation,
    noticeDaysConfirmed: h.notice_days_confirmed,
    companyName: settings.companyLegalName,
    signatoryName: h.signatory_name,
    signatoryDesignation: h.signatory_designation,
    jurisdiction: settings.jurisdiction,
    employeeCode,
  };
}

/**
 * Renders a letter and stores it as the next version of its kind.
 * @returns {{ letter: LetterMeta, unfilled: string[] }}
 */
async function writeLetter(conn, c, h, kind, facts, requestId) {
  const template = await templateFor(conn, c.companyId, kind);
  const values = letterValues(facts);
  const { buffer, unfilled } = await renderLetter(template.buffer, values);
  const packed = await packForStorage(buffer, MAX_DOCUMENT_STORED_BYTES, 'letter');

  const [[last]] = await conn.query(
    'SELECT COALESCE(MAX(version), 0) AS v FROM hrms_hiring_letters WHERE company_id = ? AND hiring_id = ? AND kind = ?',
    [c.companyId, h.id, kind],
  );
  const version = Number(last.v) + 1;
  const title = kind === 'OFFER' ? 'Offer_Letter' : 'Appointment_Letter';
  const fileName = `${title}_${fileSafe(h.candidate_name) || `hiring_${h.id}`}${version > 1 ? `_v${version}` : ''}.docx`;

  await conn.query(
    'UPDATE hrms_hiring_letters SET is_current = 0 WHERE company_id = ? AND hiring_id = ? AND kind = ? AND is_current = 1 AND deleted_at IS NULL',
    [c.companyId, h.id, kind],
  );
  const [ins] = await conn.query(
    `INSERT INTO hrms_hiring_letters
       (company_id, hiring_id, kind, version, is_current, file_name, mime_type, size_bytes, storage, compression, content,
        snapshot_json, generated_by, created_by)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, h.id, kind, version, fileName, DOCX_MIME, packed.sizeBytes, packed.storage, packed.compression, packed.content,
      JSON.stringify({ values, unfilled, template: { id: template.id, builtIn: template.builtIn, fileName: template.fileName } }),
      c.userId, c.userId],
  );
  await audit(conn, c, 'hrms_hiring_letters', ins.insertId, 'GENERATE', null,
    { hiringId: h.id, kind, version, fileName, sizeBytes: packed.sizeBytes, template: template.builtIn ? 'built-in' : template.id, unfilled }, requestId);

  const letter = (await loadLetters(conn, c.companyId, h.id)).find((l) => l.id === ins.insertId);
  return { letter: shapeLetter(letter), unfilled };
}

/**
 * POST /hirings/:id/offer-letter. Needs the name, designation, joining date,
 * CTC and valid-until; issues the letter reference on the first call; every
 * call makes a new version. Refused once the offer is accepted.
 */
export async function generateOfferLetter(conn, c, id, requestId = null) {
  let h = await loadRow(conn, c.companyId, id, { lock: true });
  const ready = readiness(h);
  if (h.stage !== 'OFFER') {
    if (h.stage === 'JD') throw wrongStage('Confirm the job description first.');
    throw wrongStage(h.stage === 'APPOINTMENT'
      ? 'The offer has been accepted, so its letter can no longer be generated again.'
      : 'This hiring is finished.');
  }
  if (!ready.can.generateOffer) {
    throw invalid('NOT_READY', 'The offer letter cannot be generated yet.', { problems: ready.missing.offerLetter.map((m) => `Still needed: ${m}.`) });
  }

  if (!h.ref_no) {
    const refNo = await issueHiringRef(conn, c.companyId, {
      letterDate: dateText(h.offer_date) ?? today(), departmentId: h.position_department_id, locationId: h.position_location_id, userId: c.userId,
    });
    await conn.query('UPDATE hrms_hirings SET ref_no = ? WHERE company_id = ? AND id = ?', [refNo, c.companyId, id]);
    h = { ...h, ref_no: refNo };
  }
  if (!h.offer_date) {
    await conn.query('UPDATE hrms_hirings SET offer_date = ? WHERE company_id = ? AND id = ?', [today(), c.companyId, id]);
    h = { ...h, offer_date: today() };
  }

  const settings = await loadSettings(conn, c.companyId);
  const out = await writeLetter(conn, c, h, 'OFFER', letterFacts(h, settings, 'OFFER'), requestId);
  return { ...(await getHiring(conn, c.companyId, id)), ...out };
}

/** POST /hirings/:id/accept-offer { acceptedOn? } — needs a current offer letter. Stage -> APPOINTMENT. */
export async function acceptOffer(conn, c, id, body = {}, requestId = null) {
  const h = await loadRow(conn, c.companyId, id, { lock: true });
  if (h.stage !== 'OFFER') {
    if (h.stage === 'JD') throw wrongStage('Confirm the job description first.');
    throw wrongStage(h.stage === 'APPOINTMENT' ? 'This offer is already recorded as accepted.' : 'This hiring is finished.');
  }
  if (!readiness(h).can.acceptOffer) {
    throw invalid('NO_OFFER_LETTER', 'Generate the offer letter first. An offer is accepted against a letter.');
  }
  const acceptedOn = clean(body.acceptedOn)?.slice(0, 10) ?? today();
  if (!isDay(acceptedOn)) throw invalid('INVALID', 'The acceptance date needs a date as YYYY-MM-DD.', { problems: ['The acceptance date needs a date as YYYY-MM-DD.'] });
  if (acceptedOn > today()) throw invalid('INVALID', 'An offer cannot be accepted on a future date.', { problems: ['An offer cannot be accepted on a future date.'] });

  await conn.query("UPDATE hrms_hirings SET stage = 'APPOINTMENT', offer_accepted_on = ? WHERE company_id = ? AND id = ?", [acceptedOn, c.companyId, id]);
  await audit(conn, c, 'hrms_hirings', id, 'UPDATE', { stage: 'OFFER' }, { stage: 'APPOINTMENT', offerAcceptedOn: acceptedOn }, requestId);
  return getHiring(conn, c.companyId, id);
}

/** The stored bytes of one letter of this hiring. Another company's id is simply not found. */
export async function readLetterFile(db, companyId, id, letterId) {
  const [[row]] = await db.query(
    `SELECT l.file_name, l.mime_type, l.storage, l.compression, l.content
       FROM hrms_hiring_letters l
       JOIN hrms_hirings h ON h.company_id = l.company_id AND h.id = l.hiring_id AND h.deleted_at IS NULL
      WHERE l.company_id = ? AND l.hiring_id = ? AND l.id = ? AND l.deleted_at IS NULL AND l.kind IN (?)`,
    [companyId, id, letterId, LETTER_KINDS],
  );
  if (!row) throw notFound('That letter');
  const buffer = await unpack(row, 'letter');
  return { fileName: row.file_name, mimeType: row.mime_type || DOCX_MIME, contentBase64: buffer.toString('base64') };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Signed copies (spec §5.3)
 * ══════════════════════════════════════════════════════════════════════════
 * The candidate's signed offer and the signed appointment letter: a PDF, a JPG
 * or a PNG, one current file per kind, replaceable, removable.
 *
 * THEY LIVE IN hrms_hiring_letters, UNDER THEIR OWN KINDS — OFFER_SIGNED and
 * APPOINTMENT_SIGNED — so no new table. Every read of the letters a hiring
 * GENERATES names its kinds (OFFER / APPOINTMENT): a signed copy is never in
 * `letters`, never a version of a letter, and never "the current offer letter"
 * that lets an offer be accepted. uq_hhlt_current still allows one current row
 * per (hiring, kind), which is the "one file per kind" rule for free.
 *
 * A file that is replaced or removed is soft-deleted, not kept as a version:
 * what matters is the signed copy on file, not the scans that preceded it.
 *
 * UPLOADING A SIGNED OFFER DOES NOT ACCEPT THE OFFER. That stays its own step.
 *
 * THE SIGNED APPOINTMENT LETTER IS ALSO FILED IN THE EMPLOYEE'S DOCUMENTS
 * (hrms_employee_documents, through peopleService.addDocument — type "Signed
 * appointment letter"), so it is on the employee's page. The hiring's row holds
 * that document's id in snapshot_json.employeeDocumentId; replacing the signed
 * copy removes that document and files the new one, removing it removes the
 * document. A copy somebody already deleted from the employee's page is simply
 * not there to remove.
 */

const SIGNED_KINDS = { offer: 'OFFER_SIGNED', appointment: 'APPOINTMENT_SIGNED' };
export const SIGNED_DOCUMENT_TYPE = 'Signed appointment letter';

function readSignedKind(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (!SIGNED_KINDS[key]) throw invalid('INVALID', 'A signed copy is of the offer letter or of the appointment letter.');
  return key;
}

/** PDF, JPG or PNG, told by the file's first bytes — not by its name or what the browser said. */
function signedMime(buffer) {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

const readSnapshot = (v) => { if (v == null) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return {}; } };

const shapeSigned = (l) => ({
  id: l.id,
  fileName: l.file_name,
  mimeType: l.mime_type,
  sizeBytes: Number(l.size_bytes) || 0,
  uploadedAt: stamp(l.generated_at),
  uploadedByName: l.generated_by_name ?? null,
  // Appointment only: the copy filed on the employee's page.
  employeeDocumentId: readSnapshot(l.snapshot_json).employeeDocumentId ?? null,
});

async function signedRows(db, companyId, hiringId, { lock = false } = {}) {
  const [rows] = await db.query(
    `SELECT l.id, l.kind, l.version, l.file_name, l.mime_type, l.size_bytes, l.generated_at, l.snapshot_json, u.name AS generated_by_name
       FROM hrms_hiring_letters l
       LEFT JOIN users u ON u.id = l.generated_by
      WHERE l.company_id = ? AND l.hiring_id = ? AND l.deleted_at IS NULL AND l.is_current = 1 AND l.kind IN (?)${lock ? ' FOR UPDATE' : ''}`,
    [companyId, hiringId, Object.values(SIGNED_KINDS)],
  );
  return rows;
}

/** `signed` on a hiring: { offer: SignedMeta | null, appointment: SignedMeta | null }. */
async function loadSigned(db, companyId, hiringId) {
  const rows = await signedRows(db, companyId, hiringId);
  const of = (kind) => { const r = rows.find((x) => x.kind === kind); return r ? shapeSigned(r) : null; };
  return { offer: of(SIGNED_KINDS.offer), appointment: of(SIGNED_KINDS.appointment) };
}

/** Takes a signed copy off the hiring, and its copy off the employee's page. */
async function retireSigned(conn, c, row, requestId) {
  await conn.query('UPDATE hrms_hiring_letters SET is_current = 0, deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, row.id]);
  const documentId = readSnapshot(row.snapshot_json).employeeDocumentId;
  if (documentId) {
    try { await deleteDocument(conn, c, documentId, requestId); } catch (e) { if (e?.code !== 'NOT_FOUND') throw e; }
  }
}

/**
 * PUT /hirings/:id/signed/:kind { fileName, contentBase64 } -> { hiring, signed }
 * 422 INVALID (not a PDF / JPG / PNG, or too large to store) · 409 WRONG_STAGE.
 */
export async function putSigned(conn, c, id, kindParam, body = {}, requestId = null) {
  const key = readSignedKind(kindParam);
  const kind = SIGNED_KINDS[key];
  const h = await loadRow(conn, c.companyId, id, { lock: true });
  const can = readiness(h).can;
  if (key === 'offer' && !can.uploadSignedOffer) throw wrongStage('There is no offer letter yet. Generate it first; the signed copy is of that letter.');
  if (key === 'appointment' && !can.uploadSignedAppointment) {
    throw wrongStage(h.stage === 'CLOSED' ? 'This hiring was closed without an appointment, so there is no appointment letter to have signed.'
      : 'The appointment letter has not been generated yet. Its signed copy comes after that.');
  }

  const fileName = clean(body.fileName)?.slice(0, 255) ?? null;
  const raw = body.contentBase64 ?? body.dataBase64;
  const problems = [];
  if (!fileName) problems.push('The file needs a name.');
  if (!raw || typeof raw !== 'string') problems.push('No file was received.');
  assertNoProblems(problems, 'That file cannot be saved.');
  const base64 = raw.startsWith('data:') && raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  const refuse = (sentence) => invalid('INVALID', sentence, { problems: [sentence] });
  if (base64.length / 4 * 3 > 24 * 1024 * 1024) throw refuse('That file is over the 24 MB upload limit.');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw refuse('That file is empty.');
  const mimeType = signedMime(buffer);
  if (!mimeType) throw refuse('A signed copy is a PDF, a JPG or a PNG. Scan or photograph the signed letter and upload that.');
  let packed;
  try {
    packed = await packForStorage(buffer, MAX_DOCUMENT_STORED_BYTES, 'signed copy');
  } catch (e) {
    // documentStorage's own sentence — both sizes and the limit — as this route's 422.
    if (e?.code === 'FILE_TOO_LARGE') throw refuse(e.message);
    throw e;
  }

  // One current file per kind: the one before it goes, with its copy on the employee's page.
  const before = (await signedRows(conn, c.companyId, id, { lock: true })).find((r) => r.kind === kind) ?? null;
  if (before) await retireSigned(conn, c, before, requestId);

  // The signed appointment letter is also filed under the employee's documents.
  let employeeDocumentId = null;
  if (key === 'appointment' && h.employee_id) {
    const filed = await addDocument(conn, c, h.employee_id, {
      documentType: SIGNED_DOCUMENT_TYPE,
      title: `${SIGNED_DOCUMENT_TYPE}${h.ref_no ? ` — ${h.ref_no}` : ''}`,
      fileName,
      mimeType,
      dataBase64: base64,
      issueDate: dateText(h.appointment_date),
      notes: 'Filed from the hiring. Replace or remove it there.',
    }, requestId);
    employeeDocumentId = filed.id;
  }

  const [[last]] = await conn.query(
    'SELECT COALESCE(MAX(version), 0) AS v FROM hrms_hiring_letters WHERE company_id = ? AND hiring_id = ? AND kind = ?', [c.companyId, id, kind]);
  const [ins] = await conn.query(
    `INSERT INTO hrms_hiring_letters
       (company_id, hiring_id, kind, version, is_current, file_name, mime_type, size_bytes, storage, compression, content,
        snapshot_json, generated_by, created_by)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, id, kind, Number(last.v) + 1, fileName, mimeType, packed.sizeBytes, packed.storage, packed.compression, packed.content,
      JSON.stringify({ signed: true, employeeDocumentId }), c.userId, c.userId],
  );
  await audit(conn, c, 'hrms_hiring_letters', ins.insertId, 'CREATE', before ? { replaced: before.id } : null,
    { hiringId: Number(id), kind, fileName, mimeType, sizeBytes: packed.sizeBytes, employeeDocumentId }, requestId);

  const answer = await getHiring(conn, c.companyId, id);
  return { ...answer, signed: answer.hiring.signed[key] };
}

/** GET /hirings/:id/signed/:kind/file -> { fileName, mimeType, contentBase64 } */
export async function readSignedFile(db, companyId, id, kindParam) {
  const kind = SIGNED_KINDS[readSignedKind(kindParam)];
  const [[row]] = await db.query(
    `SELECT l.file_name, l.mime_type, l.storage, l.compression, l.content
       FROM hrms_hiring_letters l
       JOIN hrms_hirings h ON h.company_id = l.company_id AND h.id = l.hiring_id AND h.deleted_at IS NULL
      WHERE l.company_id = ? AND l.hiring_id = ? AND l.kind = ? AND l.is_current = 1 AND l.deleted_at IS NULL`,
    [companyId, id, kind],
  );
  if (!row) throw notFound('That signed copy');
  const buffer = await unpack(row, 'signed copy');
  return { fileName: row.file_name, mimeType: row.mime_type, contentBase64: buffer.toString('base64') };
}

/** DELETE /hirings/:id/signed/:kind -> { hiring } — and the copy on the employee's page with it. */
export async function deleteSigned(conn, c, id, kindParam, requestId = null) {
  const key = readSignedKind(kindParam);
  await loadRow(conn, c.companyId, id, { lock: true });
  const row = (await signedRows(conn, c.companyId, id, { lock: true })).find((r) => r.kind === SIGNED_KINDS[key]) ?? null;
  if (!row) throw notFound('That signed copy');
  await retireSigned(conn, c, row, requestId);
  await audit(conn, c, 'hrms_hiring_letters', row.id, 'DELETE', { hiringId: Number(id), kind: row.kind, fileName: row.file_name }, null, requestId);
  return getHiring(conn, c.companyId, id);
}

/* ══════════════════════════════════════════════════════════════════════════
 * APPOINTMENT -> DONE — one transaction
 * ══════════════════════════════════════════════════════════════════════════ */

/** The address a letter prints, as the employee record keeps one. */
function addressJson(textValue) {
  const lines = String(textValue ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  return { line1: lines[0], line2: lines.slice(1).join(', ') || '' };
}

/**
 * POST /hirings/:id/appoint { joiningDate, appointmentDate? }.
 *
 * Every write below is on `conn`, inside the route's transaction. Nothing here
 * catches: a failure anywhere unwinds all of it, the employee code included.
 * 409 POSITION_FILLED when somebody took the position in the meantime.
 */
export async function appoint(conn, c, id, body = {}, requestId = null) {
  const h = await loadRow(conn, c.companyId, id, { lock: true });
  const ready = readiness(h);
  if (h.stage === 'DONE') throw wrongStage('This person has already been appointed.');
  if (h.stage === 'CLOSED') throw wrongStage('This hiring is closed.');
  if (h.stage !== 'APPOINTMENT') {
    throw conflict('OFFER_NOT_ACCEPTED', 'The offer has not been accepted yet. Record the acceptance before appointing.', {
      problems: ready.missing.appoint.map((m) => `Still needed: ${m}.`),
    });
  }
  if (!ready.can.appoint) {
    throw invalid('NOT_READY', 'This person cannot be appointed yet.', { problems: ready.missing.appoint.map((m) => `Still needed: ${m}.`) });
  }

  const problems = [];
  const joiningDate = clean(body.joiningDate)?.slice(0, 10) ?? null;
  const appointmentDate = clean(body.appointmentDate)?.slice(0, 10) ?? today();
  if (!joiningDate) problems.push('The date of joining is required.');
  else if (!isDay(joiningDate)) problems.push('The date of joining needs a date as YYYY-MM-DD.');
  if (!isDay(appointmentDate)) problems.push('The appointment date needs a date as YYYY-MM-DD.');
  assertNoProblems(problems, 'This person cannot be appointed yet.');

  // 1. The position, locked, and still free from the joining date on.
  const position = await positionFacts(conn, c.companyId, h.position_id, today(), { lock: true });
  if (position.status === 'CLOSED') throw conflict('POSITION_CLOSED', 'That position has been closed. Reopen it, or close this hiring.');
  // Anybody in it who is staying — including somebody whose notice was withdrawn since the hiring
  // started — still fills it. Somebody on notice does not, provided the candidate joins after they go.
  const holders = await holdersFrom(conn, c.companyId, h.position_id, joiningDate);
  const staying = holders.find((x) => x.exit_id == null);
  if (staying) throw positionFilled(position, staying, today());
  const leaving = holders.filter((x) => x.exit_id != null);
  const tooEarly = leaving.find((x) => joiningDate <= noticeOf(x).lastWorkingDay);
  if (tooEarly) {
    const sentence = `${tooEarly.full_name} is in this position until ${shortDay(noticeOf(tooEarly).lastWorkingDay)}, their last working day. The date of joining must be after it.`;
    throw invalid('NOT_READY', sentence, {
      problems: [sentence],
      detail: { positionId: h.position_id, replacing: { employeeId: tooEarly.employee_id, name: tooEarly.full_name, ...noticeOf(tooEarly) } },
    });
  }

  // 2. The employee — code issued inside, by the company's rule, from where they start work.
  const created = await createEmployee(conn, c, {
    fullName: h.candidate_name,
    salutation: h.candidate_salutation,
    phone: h.candidate_phone,
    email: h.candidate_email,
    gender: h.candidate_gender,
    dateOfBirth: dateText(h.candidate_date_of_birth),
    addressJson: addressJson(h.candidate_address),
    dateOfJoining: joiningDate,
    employmentType: 'EMPLOYEE',
    employmentStatus: 'ACTIVE',
  }, requestId, {
    codeContext: {
      departmentId: position.department_id, locationId: position.location_id, roleId: position.role_id, shiftId: position.default_shift_id,
    },
  });
  const employee = created.employee;

  // 3. In the position, on its shift, from the day they join.
  const { assignment } = await createAssignment(conn, c, {
    employeeId: employee.id,
    roleId: position.role_id,
    positionId: position.id,
    departmentId: position.department_id,
    locationId: position.location_id,
    defaultShiftId: position.default_shift_id,
    isPrimary: true,
    status: 'ACTIVE',
    effectiveFrom: joiningDate,
    reason: `Appointed through hiring${h.ref_no ? ` ${h.ref_no}` : ''}`,
  }, { hiringId: h.id, exceptAssignmentIds: leaving.map((x) => x.id) });
  await audit(conn, c, 'hrms_work_assignments', assignment.id, 'CREATE', null,
    { employeeId: employee.id, positionId: position.id, roleId: position.role_id, effectiveFrom: joiningDate, hiringId: h.id }, requestId);
  await createEvent(conn, c, employee.id, {
    eventType: 'ASSIGNMENT_CHANGE',
    eventDate: joiningDate,
    summary: `Appointed as ${h.designation || position.position_title || position.role_title || 'an employee'}${position.position_code ? ` (${position.position_code})` : ''}.`,
    details: { hiringId: h.id, refNo: h.ref_no ?? null, positionId: position.id },
    workAssignmentId: assignment.id,
  }, requestId);

  // 4. The hiring, DONE — before the letter, so the letter reads the confirmed dates.
  await conn.query(
    `UPDATE hrms_hirings
        SET stage = 'DONE', joining_date = ?, appointment_date = ?, employee_id = ?, assignment_id = ?
      WHERE company_id = ? AND id = ?`,
    [joiningDate, appointmentDate, employee.id, assignment.id, c.companyId, id],
  );

  // 5. The appointment letter, with the employee code.
  const settings = await loadSettings(conn, c.companyId);
  const done = { ...h, joining_date: joiningDate, appointment_date: appointmentDate };
  const out = await writeLetter(conn, c, done, 'APPOINTMENT', letterFacts(done, settings, 'APPOINTMENT', { employeeCode: employee.employeeCode }), requestId);

  await audit(conn, c, 'hrms_hirings', id, 'UPDATE', { stage: 'APPOINTMENT' },
    { stage: 'DONE', employeeId: employee.id, employeeCode: employee.employeeCode, assignmentId: assignment.id, joiningDate, appointmentDate }, requestId);

  return {
    ...(await getHiring(conn, c.companyId, id)),
    employee: { id: employee.id, employeeCode: employee.employeeCode, fullName: employee.fullName },
    assignmentId: assignment.id,
    ...out,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Closing
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * GET /hiring/close-reasons?hiringId= -> { groups: [{ label, reasons: [{ code, label, hint, noteRequired, next }] }] }
 * With a hiring: only the reasons that apply to it as it stands, most likely
 * first. Without: all fourteen.
 */
export async function listCloseReasons(db, companyId, hiringId = null) {
  if (hiringId === undefined || hiringId === null || hiringId === '') return { groups: closeReasonsFor(null) };
  const id = Number(hiringId);
  if (!Number.isInteger(id) || id <= 0) throw invalid('INVALID', 'hiringId must be a positive whole number.');
  return { groups: closeReasonsFor(await loadRow(db, companyId, id)) };
}

/**
 * POST /hirings/:id/close { reason: <code>, note? } — any stage before DONE.
 * 422 INVALID when the reason does not apply at this point of the hiring, or
 * its note is required and missing. The letter reference stays with the hiring.
 *
 * The first release's three codes (DECLINED, LAPSED, CANCELLED) are still taken
 * for one release, as they always were — no stage rule, no required note — and
 * stored as the code each has become.
 */
export async function closeHiring(conn, c, id, body = {}, requestId = null) {
  const h = await loadRow(conn, c.companyId, id, { lock: true });
  if (!readiness(h).can.close) {
    throw wrongStage(h.stage === 'DONE'
      ? 'This person has been appointed, so the hiring cannot be closed. If they are not joining, end their assignment and mark the employee exited.'
      : 'This hiring is already closed.');
  }
  const sent = String(body.reason ?? '').trim().toUpperCase();
  const legacy = Object.prototype.hasOwnProperty.call(LEGACY_CLOSE_REASONS, sent);
  const reason = closeReasonOf(sent);
  const note = clean(body.note);
  const problems = [];
  if (!reason) problems.push('Pick a reason for closing this hiring.');
  else if (!legacy) {
    if (!reason.applies(h)) problems.push(`“${reason.label}” does not apply to this hiring as it stands. Pick another reason.`);
    if (reason.noteRequired && !note) problems.push('Add a note saying what happened.');
  }
  if (note && note.length > 500) problems.push('The note is up to 500 characters.');
  assertNoProblems(problems, 'This hiring cannot be closed yet.');

  await conn.query("UPDATE hrms_hirings SET stage = 'CLOSED', close_reason = ?, close_note = ? WHERE company_id = ? AND id = ?",
    [reason.code, note, c.companyId, id]);
  await audit(conn, c, 'hrms_hirings', id, 'UPDATE', { stage: h.stage }, { stage: 'CLOSED', closeReason: reason.code }, requestId);
  return getHiring(conn, c.companyId, id);
}

export default {
  HIRING_STAGES, CLOSE_REASONS, readiness,
  getSettings, updateSettings, listTemplates, putTemplate, readTemplateFile, listPlaceholders,
  listHirings, getHiring, startHiring, confirmJd, readJdFile, jdPreview, jdReadiness, listCloseReasons, updateHiring,
  generateOfferLetter, acceptOffer, readLetterFile, appoint, closeHiring, putSigned, readSignedFile, deleteSigned,
};
