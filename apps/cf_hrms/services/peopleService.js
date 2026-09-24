/**
 * peopleService.js — employees, their statutory identifiers, their documents and
 * the events that happened to them.
 *
 * ONE EMPLOYEE ROW PER PERSON, whatever they do (plan §2 rules 1 and 2). There is
 * no `manager_id` and no `position_id` on an employee and nothing here invents
 * one: an employee's *jobs* are their work assignments, and their managers hang
 * off those. `assignmentsFor()` below is a READ of that — it renders the jobs,
 * it never writes one. Assignment writing belongs to assignmentService.js.
 *
 * AN EMPLOYEE IS NOT A USER. `user_id` is a nullable link for the handful of
 * people who log in. A missing login is the normal case for most of a workforce,
 * never a data gap, so nothing here warns about it, counts it as incomplete, or
 * requires it.
 *
 * WHY SO MUCH LIVES HERE. TiDB runs with `tidb_enable_check_constraint = 0`, so
 * every rule the schema *documents* is a rule this file has to *enforce*:
 *   - employee_code unique per company, case-insensitively, with a sentence a
 *     person can act on rather than a duplicate-key error;
 *   - contractor_id set exactly when employment_type = CONTRACT;
 *   - EXITED needs an exit_date, and cannot be set while the person still holds
 *     work assignments — the refusal names them;
 *   - a linked login must belong to the same company (the FK cannot check it,
 *     because `users` has no (company_id, id) key to point at).
 *
 * AND THERE ARE NO TRIGGERS. hrms_employment_events and hrms_audit_log rows are
 * written BY THE SERVICE THAT MAKES THE CHANGE, inside the same transaction. A
 * write that goes around this file is a write nobody records.
 */

import { invalid, notFound, conflict, assertNoProblems } from '../lib/errors.js';
import {
  decodeUpload, packForStorage, unpack, toTransport,
  assertDocumentMime, assertPhotoMime,
  MAX_DOCUMENT_STORED_BYTES, MAX_PHOTO_STORED_BYTES,
} from './documentStorage.js';

// ── small shared helpers ────────────────────────────────────────────────────

const EMPLOYMENT_TYPES = ['EMPLOYEE', 'CONTRACT', 'TRAINEE', 'CONSULTANT', 'OTHER'];
const EMPLOYMENT_STATUSES = ['ACTIVE', 'NOTICE', 'INACTIVE', 'EXITED'];
const EVENT_TYPES = ['JOIN', 'TRANSFER', 'ASSIGNMENT_CHANGE', 'DEPARTMENT_CHANGE', 'CONTRACTOR_CHANGE', 'EXIT', 'OTHER'];
const VERIFICATION_STATUSES = ['UNVERIFIED', 'VERIFIED', 'REJECTED'];

/** An assignment in any of these states is still a job the person holds. */
const OPEN_ASSIGNMENT_STATUSES = ['PLANNED', 'ACTIVE', 'SUSPENDED'];

const today = () => new Date().toISOString().slice(0, 10);
const trim = (v, max) => (v === undefined || v === null ? null : (String(v).trim().slice(0, max) || null));
const dateOrNull = (v) => (v ? String(v).slice(0, 10) : null);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));
const asJson = (v) => (v === undefined || v === null || v === '' ? null : JSON.stringify(v));

/** mysql2 hands JSON back parsed; a string means an older row or a driver quirk. */
function readJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}

// ── PII ─────────────────────────────────────────────────────────────────────

/**
 * The only shape an identifier takes without cf_hrms_people_pii.
 *
 * Reveals the last four characters and nothing else, because the last four are
 * what someone uses to confirm they are looking at the right record and are, on
 * their own, not the number. Anything four characters or shorter is masked
 * WHOLE — revealing "the last four" of a four-character value reveals all of it.
 *
 * Digits are regrouped in fours FROM THE RIGHT ("XXXX XXXX 1234") so an Aadhaar
 * still reads as an Aadhaar and the four real digits never get split across a
 * gap; anything alphanumeric (a PAN) keeps its own shape.
 */
export function maskIdentifier(value) {
  const raw = String(value ?? '').replace(/\s+/g, '');
  if (!raw) return '';
  const visible = raw.length > 4 ? 4 : 0;
  const masked = 'X'.repeat(raw.length - visible) + raw.slice(raw.length - visible);
  if (/^\d+$/.test(raw) && raw.length >= 8) {
    // From the right: a 10-digit ESI reads "XX XXXX 6789", not "XXXX XX67 89".
    const groups = [];
    for (let end = masked.length; end > 0; end -= 4) groups.unshift(masked.slice(Math.max(0, end - 4), end));
    return groups.join(' ');
  }
  return masked;
}

/**
 * Records that somebody read real identifier values.
 *
 * The action is `READ`, and it is the only thing in cf_hrms that logs one. A log
 * that records every page view buries the single event it exists to preserve;
 * a log that records a disclosure of somebody's Aadhaar number as `GENERATE`
 * misleads whoever reads it later. `after_json.event = 'PII_READ'` stays as the
 * filter key.
 *
 * THE VALUES ARE NEVER IN THE ROW. Only which identifiers were shown, of which
 * type, for which employee. An audit log that stores the secret it is auditing
 * is a second copy of the secret.
 */
async function auditPiiRead(conn, { companyId, userId }, employee, identifiers, requestId) {
  await conn.query(
    `INSERT INTO hrms_audit_log
       (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, request_id, created_by)
     VALUES (?, ?, 'hrms_employee_identifiers', ?, 'READ', NULL, ?, ?, ?)`,
    [
      companyId, userId, employee.id,
      JSON.stringify({
        event: 'PII_READ',
        employeeId: employee.id,
        employeeCode: employee.employee_code,
        identifierIds: identifiers.map((i) => i.id),
        identifierTypes: [...new Set(identifiers.map((i) => i.identifier_type))],
        count: identifiers.length,
      }),
      requestId ?? null,
      userId,
    ],
  );
}

/** Every other audited change in this file. `before`/`after` never carry a blob or a PII value. */
async function audit(conn, { companyId, userId }, entityType, entityId, action, before, after, requestId) {
  await conn.query(
    `INSERT INTO hrms_audit_log
       (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, request_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, userId, entityType, entityId, action, asJson(before), asJson(after), requestId ?? null, userId],
  );
}

/**
 * An employment event. Written deliberately, by the service that made the change
 * — that is what separates this table from the audit log: the audit log says a
 * row changed, this says something happened to a person, in their words, for
 * their file.
 */
async function writeEvent(conn, { companyId, userId }, employeeId, eventType, eventDate, summary, details = null, workAssignmentId = null) {
  const [res] = await conn.query(
    `INSERT INTO hrms_employment_events
       (company_id, employee_id, event_type, event_date, work_assignment_id, summary, details_json, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, employeeId, eventType, eventDate, workAssignmentId, String(summary).slice(0, 300), asJson(details), userId],
  );
  return res.insertId;
}

// ── employees ───────────────────────────────────────────────────────────────

const EMPLOYEE_COLUMNS = `
  e.id, e.employee_code AS employeeCode, e.full_name AS fullName,
  e.date_of_birth AS dateOfBirth, e.gender, e.phone, e.email,
  e.address_json AS addressJson, e.emergency_contact_json AS emergencyContactJson,
  e.date_of_joining AS dateOfJoining, e.employment_type AS employmentType,
  e.contractor_id AS contractorId, e.employment_status AS employmentStatus,
  e.exit_date AS exitDate, e.user_id AS userId,
  e.photo_file_name AS photoFileName, e.photo_mime_type AS photoMimeType,
  e.photo_size_bytes AS photoSizeBytes,
  e.created_at AS createdAt, e.updated_at AS updatedAt`;

/**
 * Never `SELECT *` on this table: photo_content is a LONGBLOB and a list of
 * forty employees would otherwise be tens of megabytes of JSON nobody asked for.
 * `hasPhoto` is the only thing a caller needs before deciding to fetch one.
 */
const PHOTO_FLAG = '(e.photo_content IS NOT NULL OR e.photo_uri IS NOT NULL) AS hasPhoto';

function shapeEmployee(row) {
  if (!row) return null;
  return {
    ...row,
    hasPhoto: !!row.hasPhoto,
    addressJson: readJson(row.addressJson),
    emergencyContactJson: readJson(row.emergencyContactJson),
  };
}

/**
 * The assignments an employee holds, as the People screens need to read them.
 *
 * READ ONLY. This is the one place the "one person, many jobs" idea becomes
 * visible — Ram Babu is Admin Manager 60%, HR Executive 25%, Transport
 * Coordinator 15%: one employee row, three assignments — so it resolves the role
 * title, the department, the location and the work contexts for each, and hands
 * back enough for the employee screen to render them legibly and link out to the
 * assignment screen that owns editing them.
 *
 * `asOf` decides what "active" means. Everything in this model is a question
 * about a date, and defaulting to today silently is how a historical answer ends
 * up wrong.
 */
export async function assignmentsForEmployees(exec, companyId, employeeIds, asOf = today()) {
  if (!employeeIds.length) return new Map();
  const marks = employeeIds.map(() => '?').join(',');

  const [rows] = await exec.query(
    `SELECT a.id, a.employee_id AS employeeId, a.role_id AS roleId, r.title AS roleTitle,
            r.role_code AS roleCode, a.position_id AS positionId,
            p.position_code AS positionCode, p.position_title AS positionTitle,
            a.department_id AS departmentId, d.name AS departmentName,
            a.location_id AS locationId, l.name AS locationName,
            a.assignment_title AS assignmentTitle, a.allocation_percent AS allocationPercent,
            a.is_primary AS isPrimary, a.default_shift_id AS shiftId,
            s.code AS shiftCode, s.name AS shiftName,
            a.status, a.effective_from AS effectiveFrom, a.effective_to AS effectiveTo, a.reason
       FROM hrms_work_assignments a
       LEFT JOIN hrms_roles       r ON r.id = a.role_id          AND r.company_id = a.company_id AND r.deleted_at IS NULL
       LEFT JOIN hrms_positions   p ON p.id = a.position_id      AND p.company_id = a.company_id AND p.deleted_at IS NULL
       LEFT JOIN hrms_departments d ON d.id = a.department_id    AND d.company_id = a.company_id AND d.deleted_at IS NULL
       LEFT JOIN hrms_locations   l ON l.id = a.location_id      AND l.company_id = a.company_id AND l.deleted_at IS NULL
       LEFT JOIN hrms_shifts      s ON s.id = a.default_shift_id AND s.company_id = a.company_id AND s.deleted_at IS NULL
      WHERE a.company_id = ? AND a.deleted_at IS NULL AND a.employee_id IN (${marks})
      ORDER BY a.is_primary DESC, a.allocation_percent DESC, a.effective_from ASC, a.id ASC`,
    [companyId, ...employeeIds],
  );

  const ids = rows.map((r) => r.id);
  const contexts = new Map();
  if (ids.length) {
    const [ctxRows] = await exec.query(
      `SELECT ac.work_assignment_id AS assignmentId, ac.work_context_id AS contextId,
              ac.is_primary AS isPrimary, c.name AS contextName, c.context_type AS contextType
         FROM hrms_work_assignment_contexts ac
         JOIN hrms_work_contexts c ON c.id = ac.work_context_id AND c.company_id = ac.company_id AND c.deleted_at IS NULL
        WHERE ac.company_id = ? AND ac.deleted_at IS NULL
          AND ac.work_assignment_id IN (${ids.map(() => '?').join(',')})
        ORDER BY ac.is_primary DESC, c.name ASC`,
      [companyId, ...ids],
    );
    for (const c of ctxRows) {
      if (!contexts.has(c.assignmentId)) contexts.set(c.assignmentId, []);
      contexts.get(c.assignmentId).push({
        id: c.contextId, name: c.contextName, type: c.contextType, isPrimary: !!c.isPrimary,
      });
    }
  }

  const byEmployee = new Map();
  for (const r of rows) {
    const live = r.status === 'ACTIVE'
      && (!r.effectiveFrom || r.effectiveFrom <= asOf)
      && (!r.effectiveTo || r.effectiveTo >= asOf);
    const shaped = {
      ...r,
      isPrimary: !!r.isPrimary,
      allocationPercent: r.allocationPercent === null ? null : Number(r.allocationPercent),
      // "open" = a job they still hold, whether it has started yet or is paused.
      // That is the set that must be dealt with before somebody can be EXITED.
      isOpen: OPEN_ASSIGNMENT_STATUSES.includes(r.status) && (!r.effectiveTo || r.effectiveTo >= asOf),
      isActive: live,
      contexts: contexts.get(r.id) ?? [],
    };
    if (!byEmployee.has(r.employeeId)) byEmployee.set(r.employeeId, []);
    byEmployee.get(r.employeeId).push(shaped);
  }
  return byEmployee;
}

/** Document counts that matter operationally — an expired licence is not a filing problem. */
async function documentHealth(exec, companyId, employeeIds, asOf = today()) {
  if (!employeeIds.length) return new Map();
  const [rows] = await exec.query(
    `SELECT employee_id AS employeeId,
            COUNT(*) AS total,
            SUM(expiry_date IS NOT NULL AND expiry_date <  ?) AS expired,
            SUM(expiry_date IS NOT NULL AND expiry_date >= ? AND expiry_date <= DATE_ADD(?, INTERVAL 30 DAY)) AS expiring
       FROM hrms_employee_documents
      WHERE company_id = ? AND deleted_at IS NULL
        AND employee_id IN (${employeeIds.map(() => '?').join(',')})
      GROUP BY employee_id`,
    [asOf, asOf, asOf, companyId, ...employeeIds],
  );
  return new Map(rows.map((r) => [r.employeeId, {
    documentCount: Number(r.total) || 0,
    expiredDocumentCount: Number(r.expired) || 0,
    expiringDocumentCount: Number(r.expiring) || 0,
  }]));
}

/**
 * The employees list.
 *
 * Department and location are DERIVED from the person's primary active
 * assignment, not stored on the employee — because they are a property of the
 * work, and a person doing three jobs in two departments has no single one. The
 * row says which assignment it read them from, and a person with no assignment
 * shows none, which is a real and visible gap rather than a blank that looks
 * like missing data.
 */
export async function listEmployees(exec, companyId, query = {}) {
  const asOf = dateOrNull(query.asOf) || today();
  const where = ['e.company_id = ?', 'e.deleted_at IS NULL'];
  const args = [companyId];

  const csv = (v) => String(v ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

  const statuses = csv(query.status).filter((s) => EMPLOYMENT_STATUSES.includes(s));
  if (statuses.length) {
    where.push(`e.employment_status IN (${statuses.map(() => '?').join(',')})`);
    args.push(...statuses);
  }
  const types = csv(query.employmentType).filter((t) => EMPLOYMENT_TYPES.includes(t));
  if (types.length) {
    where.push(`e.employment_type IN (${types.map(() => '?').join(',')})`);
    args.push(...types);
  }
  if (query.contractorId) {
    where.push('e.contractor_id = ?');
    args.push(Number(query.contractorId));
  }
  const search = trim(query.search, 120);
  if (search) {
    where.push('(e.full_name LIKE ? OR e.employee_code LIKE ? OR e.phone LIKE ? OR e.email LIKE ?)');
    const like = `%${search}%`;
    args.push(like, like, like, like);
  }

  const limit = Math.min(Math.max(Number(query.limit) || 500, 1), 2000);

  const [rows] = await exec.query(
    `SELECT ${EMPLOYEE_COLUMNS}, ${PHOTO_FLAG},
            c.name AS contractorName, c.code AS contractorCode,
            u.email AS userEmail
       FROM hrms_employees e
       LEFT JOIN hrms_contractors c ON c.id = e.contractor_id AND c.company_id = e.company_id AND c.deleted_at IS NULL
       LEFT JOIN users u ON u.id = e.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.full_name ASC, e.id ASC
      LIMIT ?`,
    [...args, limit],
  );

  const ids = rows.map((r) => r.id);
  const [assignments, docs] = await Promise.all([
    assignmentsForEmployees(exec, companyId, ids, asOf),
    documentHealth(exec, companyId, ids, asOf),
  ]);

  const items = rows.map((row) => {
    const mine = assignments.get(row.id) ?? [];
    const active = mine.filter((a) => a.isActive);
    // Primary first, then the biggest slice of time — the assignment list is
    // already sorted that way, so the first active row IS the primary one.
    const primary = active[0] ?? null;
    return {
      ...shapeEmployee(row),
      activeAssignmentCount: active.length,
      openAssignmentCount: mine.filter((a) => a.isOpen).length,
      assignmentCount: mine.length,
      totalAllocationPercent: active.reduce((sum, a) => sum + (a.allocationPercent ?? 0), 0),
      primaryAssignmentId: primary?.id ?? null,
      primaryRoleTitle: primary?.roleTitle ?? null,
      departmentId: primary?.departmentId ?? null,
      departmentName: primary?.departmentName ?? null,
      locationId: primary?.locationId ?? null,
      locationName: primary?.locationName ?? null,
      documentCount: docs.get(row.id)?.documentCount ?? 0,
      expiredDocumentCount: docs.get(row.id)?.expiredDocumentCount ?? 0,
      expiringDocumentCount: docs.get(row.id)?.expiringDocumentCount ?? 0,
    };
  });

  return { asOf, total: items.length, items };
}

/** One employee, with the counts their detail screen tabs need. */
export async function getEmployee(exec, companyId, id, asOf = today()) {
  const [[row]] = await exec.query(
    `SELECT ${EMPLOYEE_COLUMNS}, ${PHOTO_FLAG},
            c.name AS contractorName, c.code AS contractorCode,
            u.name AS userName, u.email AS userEmail
       FROM hrms_employees e
       LEFT JOIN hrms_contractors c ON c.id = e.contractor_id AND c.company_id = e.company_id AND c.deleted_at IS NULL
       LEFT JOIN users u ON u.id = e.user_id
      WHERE e.id = ? AND e.company_id = ? AND e.deleted_at IS NULL
      LIMIT 1`,
    [id, companyId],
  );
  if (!row) throw notFound('That employee');

  const assignments = (await assignmentsForEmployees(exec, companyId, [row.id], asOf)).get(row.id) ?? [];
  const health = (await documentHealth(exec, companyId, [row.id], asOf)).get(row.id);

  const [[counts]] = await exec.query(
    `SELECT
       (SELECT COUNT(*) FROM hrms_employee_identifiers WHERE company_id = ? AND employee_id = ? AND deleted_at IS NULL) AS identifierCount,
       (SELECT COUNT(*) FROM hrms_employment_events    WHERE company_id = ? AND employee_id = ? AND deleted_at IS NULL) AS eventCount`,
    [companyId, row.id, companyId, row.id],
  );

  const active = assignments.filter((a) => a.isActive);
  return {
    asOf,
    employee: shapeEmployee(row),
    assignments,
    counts: {
      assignments: assignments.length,
      activeAssignments: active.length,
      openAssignments: assignments.filter((a) => a.isOpen).length,
      identifiers: Number(counts.identifierCount) || 0,
      documents: health?.documentCount ?? 0,
      expiredDocuments: health?.expiredDocumentCount ?? 0,
      expiringDocuments: health?.expiringDocumentCount ?? 0,
      events: Number(counts.eventCount) || 0,
    },
    totalAllocationPercent: active.reduce((s, a) => s + (a.allocationPercent ?? 0), 0),
  };
}

/** Assignments only — the Work tab, without re-reading the whole record. */
export async function assignmentsFor(exec, companyId, employeeId, asOf = today()) {
  const [[exists]] = await exec.query(
    'SELECT id FROM hrms_employees WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1',
    [employeeId, companyId],
  );
  if (!exists) throw notFound('That employee');
  const items = (await assignmentsForEmployees(exec, companyId, [Number(employeeId)], asOf)).get(Number(employeeId)) ?? [];
  const active = items.filter((a) => a.isActive);
  return {
    asOf,
    items,
    activeCount: active.length,
    totalAllocationPercent: active.reduce((s, a) => s + (a.allocationPercent ?? 0), 0),
  };
}

/**
 * employee_code is unique per company and CASE-INSENSITIVELY so (the schema's
 * `code_active` virtual column lowercases it). The unique index would catch a
 * clash, but as a 1062 naming an index — so the check happens first and the
 * refusal names the person already holding the code, which is the only thing
 * that lets someone fix it without going to look.
 */
async function assertCodeFree(conn, companyId, code, exceptId = null) {
  const [[clash]] = await conn.query(
    `SELECT id, full_name AS fullName, employee_code AS employeeCode
       FROM hrms_employees
      WHERE company_id = ? AND deleted_at IS NULL AND LOWER(employee_code) = LOWER(?)
        AND (? IS NULL OR id <> ?)
      LIMIT 1`,
    [companyId, code, exceptId, exceptId],
  );
  if (clash) {
    throw conflict(
      'DUPLICATE_CODE',
      `Employee code ${clash.employeeCode} already belongs to ${clash.fullName}. Codes are unique per company and are not case-sensitive.`,
      { detail: { employeeId: clash.id } },
    );
  }
}

/** The linked login must be in this company. No FK can check it — `users` has no (company_id, id) key. */
async function assertUserInCompany(conn, companyId, userId) {
  if (!userId) return;
  const [[u]] = await conn.query(
    'SELECT id, company_id AS companyId FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1',
    [userId],
  );
  if (!u) throw invalid('BAD_USER', 'That login does not exist.');
  if (Number(u.companyId) !== Number(companyId)) {
    throw invalid('BAD_USER', 'That login belongs to another company and cannot be linked to this employee.');
  }
}

/** Contractor set exactly when the employment type is CONTRACT, and nowhere else. */
function checkContractor(problems, employmentType, contractorId) {
  if (employmentType === 'CONTRACT' && !contractorId) {
    problems.push('Contract labour needs a contractor — that is who employs them.');
  }
  if (employmentType !== 'CONTRACT' && contractorId) {
    problems.push('A contractor can only be set on contract labour. Change the employment type to Contract, or clear the contractor.');
  }
}

function checkStatus(problems, status, exitDate, joiningDate) {
  if (status === 'EXITED' && !exitDate) {
    problems.push('An exited employee needs an exit date — it is what every later report reads.');
  }
  if (status !== 'EXITED' && exitDate) {
    problems.push('An exit date only belongs on an exited employee. Clear it, or set the status to Exited.');
  }
  if (exitDate && joiningDate && exitDate < joiningDate) {
    problems.push('The exit date is before the joining date.');
  }
}

/**
 * The open assignments standing in the way of an exit, as a sentence.
 *
 * "Cannot exit, has assignments" is useless — the person reading it has to go
 * and find out which. This names them, so the next click is the right one.
 */
async function assertNoOpenAssignments(conn, companyId, employeeId, fullName) {
  const open = (await assignmentsForEmployees(conn, companyId, [Number(employeeId)]))
    .get(Number(employeeId))?.filter((a) => a.isOpen) ?? [];
  if (!open.length) return;
  const named = open.map((a) => {
    const pct = a.allocationPercent === null ? '' : ` ${a.allocationPercent}%`;
    return `${a.roleTitle ?? a.assignmentTitle ?? `assignment #${a.id}`}${pct}`;
  });
  throw conflict(
    'ASSIGNMENTS_OPEN',
    `${fullName} still holds ${open.length} work assignment${open.length === 1 ? '' : 's'}: ${named.join(', ')}. `
    + 'End them on the work assignment screen before marking this person exited — an exited employee with a live job is a roster that still expects them.',
    { problems: named, detail: { assignmentIds: open.map((a) => a.id) } },
  );
}

export async function createEmployee(conn, c, body = {}, requestId = null) {
  const problems = [];
  const employeeCode = trim(body.employeeCode, 50);
  const fullName = trim(body.fullName, 200);
  const dateOfJoining = dateOrNull(body.dateOfJoining);
  const employmentType = String(body.employmentType ?? 'EMPLOYEE').toUpperCase();
  const employmentStatus = String(body.employmentStatus ?? 'ACTIVE').toUpperCase();
  const contractorId = body.contractorId ? Number(body.contractorId) : null;
  const exitDate = dateOrNull(body.exitDate);
  const userId = body.userId ? Number(body.userId) : null;

  if (!employeeCode) problems.push('An employee code is required.');
  if (!fullName) problems.push('A name is required.');
  if (!dateOfJoining) problems.push('A date of joining is required.');
  else if (!isDate(dateOfJoining)) problems.push('The date of joining must be a date (YYYY-MM-DD).');
  if (!EMPLOYMENT_TYPES.includes(employmentType)) problems.push(`Employment type must be one of ${EMPLOYMENT_TYPES.join(', ')}.`);
  if (!EMPLOYMENT_STATUSES.includes(employmentStatus)) problems.push(`Employment status must be one of ${EMPLOYMENT_STATUSES.join(', ')}.`);
  checkContractor(problems, employmentType, contractorId);
  checkStatus(problems, employmentStatus, exitDate, dateOfJoining);
  assertNoProblems(problems, 'This employee cannot be saved yet.');

  await assertCodeFree(conn, c.companyId, employeeCode);
  await assertUserInCompany(conn, c.companyId, userId);

  const [res] = await conn.query(
    `INSERT INTO hrms_employees
       (company_id, employee_code, full_name, date_of_birth, gender, phone, email,
        address_json, emergency_contact_json, date_of_joining, employment_type,
        contractor_id, employment_status, exit_date, user_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      c.companyId, employeeCode, fullName, dateOrNull(body.dateOfBirth), trim(body.gender, 40),
      trim(body.phone, 40), trim(body.email, 200),
      asJson(body.addressJson ?? body.address), asJson(body.emergencyContactJson ?? body.emergencyContact),
      dateOfJoining, employmentType, contractorId, employmentStatus, exitDate, userId, c.userId,
    ],
  );
  const id = res.insertId;

  // Every employee's file starts with the day they joined. Without this the
  // History tab of a brand-new record is empty, which reads as "nothing is
  // recorded here" rather than "nothing has happened yet".
  await writeEvent(conn, c, id, 'JOIN', dateOfJoining, `${fullName} joined as ${employmentType.toLowerCase()}.`, {
    employeeCode, employmentType, contractorId,
  });
  if (employmentStatus === 'EXITED') {
    await writeEvent(conn, c, id, 'EXIT', exitDate, `${fullName} exited.`, { exitDate });
  }
  await audit(conn, c, 'hrms_employees', id, 'CREATE', null, { employeeCode, fullName, employmentType, employmentStatus }, requestId);

  return getEmployee(conn, c.companyId, id);
}

export async function updateEmployee(conn, c, id, body = {}, requestId = null) {
  const [[before]] = await conn.query(
    `SELECT id, employee_code AS employeeCode, full_name AS fullName, date_of_birth AS dateOfBirth,
            gender, phone, email, address_json AS addressJson, emergency_contact_json AS emergencyContactJson,
            date_of_joining AS dateOfJoining, employment_type AS employmentType, contractor_id AS contractorId,
            employment_status AS employmentStatus, exit_date AS exitDate, user_id AS userId
       FROM hrms_employees WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [id, c.companyId],
  );
  if (!before) throw notFound('That employee');

  // Only what was sent changes. A screen that edits the Overview tab must not
  // silently clear an exit date it never showed.
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const next = {
    employeeCode: has('employeeCode') ? trim(body.employeeCode, 50) : before.employeeCode,
    fullName: has('fullName') ? trim(body.fullName, 200) : before.fullName,
    dateOfBirth: has('dateOfBirth') ? dateOrNull(body.dateOfBirth) : before.dateOfBirth,
    gender: has('gender') ? trim(body.gender, 40) : before.gender,
    phone: has('phone') ? trim(body.phone, 40) : before.phone,
    email: has('email') ? trim(body.email, 200) : before.email,
    addressJson: has('addressJson') || has('address')
      ? (body.addressJson ?? body.address ?? null) : readJson(before.addressJson),
    emergencyContactJson: has('emergencyContactJson') || has('emergencyContact')
      ? (body.emergencyContactJson ?? body.emergencyContact ?? null) : readJson(before.emergencyContactJson),
    dateOfJoining: has('dateOfJoining') ? dateOrNull(body.dateOfJoining) : before.dateOfJoining,
    employmentType: has('employmentType') ? String(body.employmentType ?? '').toUpperCase() : before.employmentType,
    contractorId: has('contractorId') ? (body.contractorId ? Number(body.contractorId) : null) : before.contractorId,
    employmentStatus: has('employmentStatus') ? String(body.employmentStatus ?? '').toUpperCase() : before.employmentStatus,
    exitDate: has('exitDate') ? dateOrNull(body.exitDate) : before.exitDate,
    userId: has('userId') ? (body.userId ? Number(body.userId) : null) : before.userId,
  };

  const problems = [];
  if (!next.employeeCode) problems.push('An employee code is required.');
  if (!next.fullName) problems.push('A name is required.');
  if (!next.dateOfJoining) problems.push('A date of joining is required.');
  if (!EMPLOYMENT_TYPES.includes(next.employmentType)) problems.push(`Employment type must be one of ${EMPLOYMENT_TYPES.join(', ')}.`);
  if (!EMPLOYMENT_STATUSES.includes(next.employmentStatus)) problems.push(`Employment status must be one of ${EMPLOYMENT_STATUSES.join(', ')}.`);
  checkContractor(problems, next.employmentType, next.contractorId);
  checkStatus(problems, next.employmentStatus, next.exitDate, next.dateOfJoining);
  assertNoProblems(problems, 'This employee cannot be saved yet.');

  if (next.employeeCode.toLowerCase() !== String(before.employeeCode).toLowerCase()) {
    await assertCodeFree(conn, c.companyId, next.employeeCode, id);
  }
  if (Number(next.userId) !== Number(before.userId)) {
    await assertUserInCompany(conn, c.companyId, next.userId);
  }

  const exiting = next.employmentStatus === 'EXITED' && before.employmentStatus !== 'EXITED';
  if (exiting) {
    // The rule that stops an org quietly carrying ghosts on its roster.
    await assertNoOpenAssignments(conn, c.companyId, id, next.fullName);
  }

  await conn.query(
    `UPDATE hrms_employees
        SET employee_code = ?, full_name = ?, date_of_birth = ?, gender = ?, phone = ?, email = ?,
            address_json = ?, emergency_contact_json = ?, date_of_joining = ?, employment_type = ?,
            contractor_id = ?, employment_status = ?, exit_date = ?, user_id = ?
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
    [
      next.employeeCode, next.fullName, next.dateOfBirth, next.gender, next.phone, next.email,
      asJson(next.addressJson), asJson(next.emergencyContactJson), next.dateOfJoining,
      next.employmentType, next.contractorId, next.employmentStatus, next.exitDate, next.userId,
      id, c.companyId,
    ],
  );

  // Events, written here because nothing else will. Each one is the sentence a
  // person would write in the file, not a diff.
  if (exiting) {
    await writeEvent(conn, c, id, 'EXIT', next.exitDate, `${next.fullName} exited.`, {
      exitDate: next.exitDate, previousStatus: before.employmentStatus,
    });
  } else if (next.employmentStatus !== before.employmentStatus) {
    await writeEvent(conn, c, id, 'OTHER', today(),
      `Employment status changed from ${before.employmentStatus} to ${next.employmentStatus}.`,
      { from: before.employmentStatus, to: next.employmentStatus });
  }
  if (Number(next.contractorId ?? 0) !== Number(before.contractorId ?? 0)
      || next.employmentType !== before.employmentType) {
    await writeEvent(conn, c, id, 'CONTRACTOR_CHANGE', today(),
      next.employmentType === 'CONTRACT'
        ? 'Contract employer changed.'
        : `Employment type changed from ${before.employmentType} to ${next.employmentType}.`,
      {
        employmentType: { from: before.employmentType, to: next.employmentType },
        contractorId: { from: before.contractorId, to: next.contractorId },
      });
  }

  await audit(conn, c, 'hrms_employees', id, 'UPDATE',
    { ...before, addressJson: undefined, emergencyContactJson: undefined },
    { ...next, addressJson: undefined, emergencyContactJson: undefined },
    requestId);

  return getEmployee(conn, c.companyId, id);
}

/**
 * Soft delete — for a record created in error, not for somebody who left. A
 * person who left is EXITED: they still own their attendance history, their
 * generated profile and their assignments' end dates, and deleting them takes
 * all of it out of every report that has to balance.
 */
export async function deleteEmployee(conn, c, id, requestId = null) {
  const [[row]] = await conn.query(
    'SELECT id, full_name AS fullName, employee_code AS employeeCode FROM hrms_employees WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1',
    [id, c.companyId],
  );
  if (!row) throw notFound('That employee');

  await assertNoOpenAssignments(conn, c.companyId, id, row.fullName);

  await conn.query('UPDATE hrms_employees SET deleted_at = NOW() WHERE id = ? AND company_id = ?', [id, c.companyId]);
  await audit(conn, c, 'hrms_employees', id, 'DELETE', row, null, requestId);
  return { id: Number(id), deleted: true };
}

// ── photo ───────────────────────────────────────────────────────────────────

export async function setPhoto(conn, c, employeeId, body = {}, requestId = null) {
  const [[emp]] = await conn.query(
    'SELECT id FROM hrms_employees WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1',
    [employeeId, c.companyId],
  );
  if (!emp) throw notFound('That employee');

  const file = decodeUpload(body, { field: 'photo' });
  assertPhotoMime(file.mimeType);
  const packed = await packForStorage(file.buffer, MAX_PHOTO_STORED_BYTES, 'photo');

  await conn.query(
    `UPDATE hrms_employees
        SET photo_file_name = ?, photo_mime_type = ?, photo_size_bytes = ?,
            photo_storage = ?, photo_compression = ?, photo_content = ?, photo_uri = NULL
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
    [file.fileName, file.mimeType, packed.sizeBytes, packed.storage, packed.compression, packed.content, employeeId, c.companyId],
  );
  await audit(conn, c, 'hrms_employees', Number(employeeId), 'UPDATE', null,
    { photo: { fileName: file.fileName, sizeBytes: packed.sizeBytes } }, requestId);

  return { ok: true, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: packed.sizeBytes };
}

export async function readPhoto(exec, companyId, employeeId) {
  const [[row]] = await exec.query(
    `SELECT photo_file_name AS fileName, photo_mime_type AS mimeType, photo_storage AS storage,
            photo_compression AS compression, photo_content AS content, photo_uri AS uri
       FROM hrms_employees WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [employeeId, companyId],
  );
  if (!row) throw notFound('That employee');
  if (!row.content && !row.uri) return { hasPhoto: false };
  const buffer = await unpack(row, 'photo');
  return { hasPhoto: true, ...toTransport(buffer, { fileName: row.fileName, mimeType: row.mimeType }) };
}

export async function deletePhoto(conn, c, employeeId, requestId = null) {
  const [res] = await conn.query(
    `UPDATE hrms_employees
        SET photo_file_name = NULL, photo_mime_type = NULL, photo_size_bytes = NULL,
            photo_storage = NULL, photo_compression = NULL, photo_content = NULL, photo_uri = NULL
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
    [employeeId, c.companyId],
  );
  if (!res.affectedRows) throw notFound('That employee');
  await audit(conn, c, 'hrms_employees', Number(employeeId), 'UPDATE', { photo: 'present' }, { photo: null }, requestId);
  return { ok: true };
}

// ── identifiers (PII) ───────────────────────────────────────────────────────

/**
 * Statutory identifiers, MASKED BY DEFAULT.
 *
 * `identifier_value` is absent from resourceDef.json, so the generic query API
 * cannot return it at all — this function is the only read path in the product,
 * and it masks unless BOTH conditions hold: the caller asked to see the values
 * (`reveal`) and the caller holds cf_hrms_people_pii (`canSeePii`).
 *
 * Reveal is explicit rather than automatic on purpose. If a PII holder got
 * unmasked numbers simply for opening an employee, every page view would be a
 * disclosure, the audit log would fill with reads nobody made deliberately, and
 * the one signal it exists to carry — somebody looked at this person's Aadhaar —
 * would be buried. Asking is cheap; an audit trail nobody trusts is not.
 *
 * A reveal WITHOUT the permission is not an error. It returns the same masked
 * rows the default does, with `masked: true`, because the permission is the only
 * thing that lifts masking and failing loudly would just tell a caller which
 * screens to stop opening.
 */
export async function listIdentifiers(exec, c, employeeId, { reveal = false, canSeePii = false, requestId = null } = {}) {
  const [[emp]] = await exec.query(
    'SELECT id, employee_code, full_name FROM hrms_employees WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1',
    [employeeId, c.companyId],
  );
  if (!emp) throw notFound('That employee');

  const [rows] = await exec.query(
    `SELECT id, identifier_type AS identifierType, identifier_value, is_verified AS isVerified,
            valid_from AS validFrom, valid_to AS validTo, created_at AS createdAt
       FROM hrms_employee_identifiers
      WHERE company_id = ? AND employee_id = ? AND deleted_at IS NULL
      ORDER BY identifier_type ASC, valid_from DESC, id DESC`,
    [c.companyId, employeeId],
  );

  const unmasked = reveal && canSeePii;
  if (unmasked && rows.length) {
    await auditPiiRead(
      exec,
      c,
      { id: emp.id, employee_code: emp.employee_code },
      rows.map((r) => ({ id: r.id, identifier_type: r.identifierType })),
      requestId,
    );
  }

  return {
    employeeId: Number(employeeId),
    masked: !unmasked,
    canSeePii: !!canSeePii,
    items: rows.map((r) => ({
      id: r.id,
      identifierType: r.identifierType,
      // The ONLY place identifier_value leaves the database, and it leaves
      // masked unless both gates opened above.
      value: unmasked ? r.identifier_value : maskIdentifier(r.identifier_value),
      isVerified: !!r.isVerified,
      validFrom: r.validFrom,
      validTo: r.validTo,
      createdAt: r.createdAt,
    })),
  };
}

export async function createIdentifier(conn, c, employeeId, body = {}, requestId = null) {
  const [[emp]] = await conn.query(
    'SELECT id FROM hrms_employees WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1',
    [employeeId, c.companyId],
  );
  if (!emp) throw notFound('That employee');

  const identifierType = trim(body.identifierType, 50)?.toUpperCase();
  const value = trim(body.value ?? body.identifierValue, 200);
  const problems = [];
  if (!identifierType) problems.push('Choose what kind of identifier this is (Aadhaar, PAN, UAN, ESI…).');
  if (!value) problems.push('The identifier number is required.');
  assertNoProblems(problems, 'This identifier cannot be saved yet.');

  const [res] = await conn.query(
    `INSERT INTO hrms_employee_identifiers
       (company_id, employee_id, identifier_type, identifier_value, is_verified, valid_from, valid_to, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, employeeId, identifierType, value, body.isVerified ? 1 : 0,
      dateOrNull(body.validFrom), dateOrNull(body.validTo), c.userId],
  );
  // The audit row names the TYPE and never the number. The value is the thing
  // being protected; writing it into the log would be a second copy of it.
  await audit(conn, c, 'hrms_employee_identifiers', res.insertId, 'CREATE', null,
    { employeeId: Number(employeeId), identifierType, masked: maskIdentifier(value) }, requestId);

  return { id: res.insertId, identifierType, value: maskIdentifier(value) };
}

export async function updateIdentifier(conn, c, id, body = {}, requestId = null) {
  const [[row]] = await conn.query(
    `SELECT id, employee_id AS employeeId, identifier_type AS identifierType, identifier_value AS identifierValue,
            is_verified AS isVerified, valid_from AS validFrom, valid_to AS validTo
       FROM hrms_employee_identifiers WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [id, c.companyId],
  );
  if (!row) throw notFound('That identifier');

  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const identifierType = has('identifierType') ? trim(body.identifierType, 50)?.toUpperCase() : row.identifierType;
  const value = has('value') || has('identifierValue')
    ? trim(body.value ?? body.identifierValue, 200) : row.identifierValue;
  const problems = [];
  if (!identifierType) problems.push('Choose what kind of identifier this is.');
  if (!value) problems.push('The identifier number is required.');
  assertNoProblems(problems, 'This identifier cannot be saved yet.');

  await conn.query(
    `UPDATE hrms_employee_identifiers
        SET identifier_type = ?, identifier_value = ?, is_verified = ?, valid_from = ?, valid_to = ?
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
    [
      identifierType, value,
      has('isVerified') ? (body.isVerified ? 1 : 0) : row.isVerified,
      has('validFrom') ? dateOrNull(body.validFrom) : row.validFrom,
      has('validTo') ? dateOrNull(body.validTo) : row.validTo,
      id, c.companyId,
    ],
  );
  await audit(conn, c, 'hrms_employee_identifiers', Number(id), 'UPDATE',
    { identifierType: row.identifierType, masked: maskIdentifier(row.identifierValue) },
    { identifierType, masked: maskIdentifier(value) }, requestId);

  return { id: Number(id), identifierType, value: maskIdentifier(value) };
}

export async function deleteIdentifier(conn, c, id, requestId = null) {
  const [[row]] = await conn.query(
    `SELECT id, identifier_type AS identifierType, identifier_value AS identifierValue
       FROM hrms_employee_identifiers WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [id, c.companyId],
  );
  if (!row) throw notFound('That identifier');
  await conn.query('UPDATE hrms_employee_identifiers SET deleted_at = NOW() WHERE id = ? AND company_id = ?', [id, c.companyId]);
  await audit(conn, c, 'hrms_employee_identifiers', Number(id), 'DELETE',
    { identifierType: row.identifierType, masked: maskIdentifier(row.identifierValue) }, null, requestId);
  return { id: Number(id), deleted: true };
}

// ── documents ───────────────────────────────────────────────────────────────

const DOCUMENT_COLUMNS = `
  d.id, d.employee_id AS employeeId, d.document_type AS documentType, d.title,
  d.file_name AS fileName, d.mime_type AS mimeType, d.size_bytes AS sizeBytes, d.storage,
  d.issue_date AS issueDate, d.expiry_date AS expiryDate,
  d.verification_status AS verificationStatus, d.verified_by_employee_id AS verifiedByEmployeeId,
  d.verified_at AS verifiedAt, d.notes, d.created_at AS createdAt`;

/** Never selects `content`: a list of a dozen PDFs would be tens of megabytes of JSON. */
export async function listDocuments(exec, companyId, employeeId, asOf = today()) {
  const [[emp]] = await exec.query(
    'SELECT id FROM hrms_employees WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1',
    [employeeId, companyId],
  );
  if (!emp) throw notFound('That employee');

  const [rows] = await exec.query(
    `SELECT ${DOCUMENT_COLUMNS}, v.full_name AS verifiedByName
       FROM hrms_employee_documents d
       LEFT JOIN hrms_employees v ON v.id = d.verified_by_employee_id AND v.company_id = d.company_id AND v.deleted_at IS NULL
      WHERE d.company_id = ? AND d.employee_id = ? AND d.deleted_at IS NULL
      ORDER BY d.expiry_date IS NULL, d.expiry_date ASC, d.document_type ASC, d.id DESC`,
    [companyId, employeeId],
  );

  return {
    asOf,
    items: rows.map((r) => ({
      ...r,
      // Computed here so the screen and any later report agree on what "expiring"
      // means instead of each picking its own window.
      daysToExpiry: r.expiryDate
        ? Math.round((Date.parse(`${r.expiryDate}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86400000)
        : null,
    })),
  };
}

export async function addDocument(conn, c, employeeId, body = {}, requestId = null) {
  const [[emp]] = await conn.query(
    'SELECT id FROM hrms_employees WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1',
    [employeeId, c.companyId],
  );
  if (!emp) throw notFound('That employee');

  const documentType = trim(body.documentType, 100);
  if (!documentType) throw invalid('INVALID', 'This document needs a type — that is what makes it findable later.');

  const file = decodeUpload(body);
  assertDocumentMime(file.mimeType);
  const packed = await packForStorage(file.buffer, MAX_DOCUMENT_STORED_BYTES, 'document');

  const [res] = await conn.query(
    `INSERT INTO hrms_employee_documents
       (company_id, employee_id, document_type, title, file_name, mime_type, size_bytes,
        storage, compression, content, issue_date, expiry_date, verification_status, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      c.companyId, employeeId, documentType, trim(body.title, 250), file.fileName, file.mimeType,
      packed.sizeBytes, packed.storage, packed.compression, packed.content,
      dateOrNull(body.issueDate), dateOrNull(body.expiryDate),
      VERIFICATION_STATUSES.includes(String(body.verificationStatus ?? '').toUpperCase())
        ? String(body.verificationStatus).toUpperCase() : 'UNVERIFIED',
      trim(body.notes, 2000), c.userId,
    ],
  );
  await audit(conn, c, 'hrms_employee_documents', res.insertId, 'CREATE', null,
    { employeeId: Number(employeeId), documentType, fileName: file.fileName, sizeBytes: packed.sizeBytes }, requestId);

  return { id: res.insertId, documentType, fileName: file.fileName, sizeBytes: packed.sizeBytes };
}

/** Metadata and verification only. Replacing the bytes means a new document row — a file's history matters. */
export async function updateDocument(conn, c, id, body = {}, requestId = null) {
  const [[row]] = await conn.query(
    `SELECT id, employee_id AS employeeId, document_type AS documentType, title,
            issue_date AS issueDate, expiry_date AS expiryDate,
            verification_status AS verificationStatus, verified_by_employee_id AS verifiedByEmployeeId, notes
       FROM hrms_employee_documents WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [id, c.companyId],
  );
  if (!row) throw notFound('That document');

  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const documentType = has('documentType') ? trim(body.documentType, 100) : row.documentType;
  if (!documentType) throw invalid('INVALID', 'This document needs a type.');

  const verificationStatus = has('verificationStatus')
    ? String(body.verificationStatus ?? '').toUpperCase() : row.verificationStatus;
  if (!VERIFICATION_STATUSES.includes(verificationStatus)) {
    throw invalid('INVALID', `Verification status must be one of ${VERIFICATION_STATUSES.join(', ')}.`);
  }

  // The verifier is an EMPLOYEE, not a login: the person who checked the
  // original is an HR person in the org chart and may have no account at all.
  const verifiedByEmployeeId = has('verifiedByEmployeeId')
    ? (body.verifiedByEmployeeId ? Number(body.verifiedByEmployeeId) : null) : row.verifiedByEmployeeId;
  if (verifiedByEmployeeId) {
    const [[v]] = await conn.query(
      'SELECT id FROM hrms_employees WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1',
      [verifiedByEmployeeId, c.companyId],
    );
    if (!v) throw invalid('BAD_REFERENCE', 'That verifier is not an employee in this company.');
  }

  const verified = verificationStatus !== 'UNVERIFIED';
  await conn.query(
    `UPDATE hrms_employee_documents
        SET document_type = ?, title = ?, issue_date = ?, expiry_date = ?,
            verification_status = ?, verified_by_employee_id = ?,
            verified_at = ${verified ? 'COALESCE(verified_at, NOW())' : 'NULL'}, notes = ?
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
    [
      documentType,
      has('title') ? trim(body.title, 250) : row.title,
      has('issueDate') ? dateOrNull(body.issueDate) : row.issueDate,
      has('expiryDate') ? dateOrNull(body.expiryDate) : row.expiryDate,
      verificationStatus, verifiedByEmployeeId,
      has('notes') ? trim(body.notes, 2000) : row.notes,
      id, c.companyId,
    ],
  );
  await audit(conn, c, 'hrms_employee_documents', Number(id), 'UPDATE', row,
    { documentType, verificationStatus, verifiedByEmployeeId }, requestId);

  return { id: Number(id) };
}

export async function deleteDocument(conn, c, id, requestId = null) {
  const [[row]] = await conn.query(
    `SELECT id, document_type AS documentType, file_name AS fileName
       FROM hrms_employee_documents WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [id, c.companyId],
  );
  if (!row) throw notFound('That document');
  await conn.query('UPDATE hrms_employee_documents SET deleted_at = NOW() WHERE id = ? AND company_id = ?', [id, c.companyId]);
  await audit(conn, c, 'hrms_employee_documents', Number(id), 'DELETE', row, null, requestId);
  return { id: Number(id), deleted: true };
}

export async function readDocumentFile(exec, companyId, id) {
  const [[row]] = await exec.query(
    `SELECT file_name AS fileName, mime_type AS mimeType, storage, compression, content, uri
       FROM hrms_employee_documents WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [id, companyId],
  );
  if (!row) throw notFound('That document');
  const buffer = await unpack(row, 'document');
  return toTransport(buffer, { fileName: row.fileName, mimeType: row.mimeType });
}

// ── employment events ───────────────────────────────────────────────────────

export async function listEvents(exec, companyId, employeeId) {
  const [[emp]] = await exec.query(
    'SELECT id FROM hrms_employees WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1',
    [employeeId, companyId],
  );
  if (!emp) throw notFound('That employee');

  const [rows] = await exec.query(
    `SELECT ev.id, ev.event_type AS eventType, ev.event_date AS eventDate,
            ev.work_assignment_id AS workAssignmentId, ev.summary, ev.details_json AS detailsJson,
            ev.created_at AS createdAt, r.title AS assignmentRoleTitle
       FROM hrms_employment_events ev
       LEFT JOIN hrms_work_assignments a ON a.id = ev.work_assignment_id AND a.company_id = ev.company_id AND a.deleted_at IS NULL
       LEFT JOIN hrms_roles r ON r.id = a.role_id AND r.company_id = a.company_id AND r.deleted_at IS NULL
      WHERE ev.company_id = ? AND ev.employee_id = ? AND ev.deleted_at IS NULL
      ORDER BY ev.event_date DESC, ev.id DESC`,
    [companyId, employeeId],
  );
  return { items: rows.map((r) => ({ ...r, detailsJson: readJson(r.detailsJson) })) };
}

/**
 * A hand-written event, for what a service cannot know: a transfer agreed in a
 * meeting, a disciplinary note, a change made before this system existed.
 * Everything a service DOES know it writes itself — see createEmployee and
 * updateEmployee above.
 */
export async function createEvent(conn, c, employeeId, body = {}, requestId = null) {
  const [[emp]] = await conn.query(
    'SELECT id FROM hrms_employees WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1',
    [employeeId, c.companyId],
  );
  if (!emp) throw notFound('That employee');

  const eventType = String(body.eventType ?? '').toUpperCase();
  const eventDate = dateOrNull(body.eventDate) || today();
  const summary = trim(body.summary, 300);
  const problems = [];
  if (!EVENT_TYPES.includes(eventType)) problems.push(`Event type must be one of ${EVENT_TYPES.join(', ')}.`);
  if (!summary) problems.push('A one-line summary is required — it is what the file reads as.');
  if (!isDate(eventDate)) problems.push('The event date must be a date (YYYY-MM-DD).');
  assertNoProblems(problems, 'This event cannot be saved yet.');

  const workAssignmentId = body.workAssignmentId ? Number(body.workAssignmentId) : null;
  if (workAssignmentId) {
    const [[a]] = await conn.query(
      'SELECT id FROM hrms_work_assignments WHERE id = ? AND company_id = ? AND employee_id = ? AND deleted_at IS NULL LIMIT 1',
      [workAssignmentId, c.companyId, employeeId],
    );
    if (!a) throw invalid('BAD_REFERENCE', 'That work assignment does not belong to this employee.');
  }

  const id = await writeEvent(conn, c, employeeId, eventType, eventDate, summary,
    body.detailsJson ?? body.details ?? null, workAssignmentId);
  await audit(conn, c, 'hrms_employment_events', id, 'CREATE', null, { employeeId: Number(employeeId), eventType, summary }, requestId);
  return { id, eventType, eventDate, summary };
}

// ── pickers ─────────────────────────────────────────────────────────────────

/**
 * What the People screens need to fill their own dropdowns, in one request:
 * the contractors a contract worker can be employed by, and the identifier and
 * document types this company already uses.
 *
 * The types are derived from existing rows rather than an ENUM on purpose —
 * statutory identifiers differ by country and change by statute (see
 * models/init.sql §5b), so the picker offers what is in use and accepts a new
 * one typed in. The suggested list below is what an Indian payroll starts from.
 */
export async function pickers(exec, companyId) {
  const [contractors] = await exec.query(
    `SELECT id, code, name FROM hrms_contractors
      WHERE company_id = ? AND deleted_at IS NULL AND status = 'ACTIVE'
      ORDER BY name ASC`,
    [companyId],
  );
  const [idTypes] = await exec.query(
    `SELECT DISTINCT identifier_type AS type FROM hrms_employee_identifiers
      WHERE company_id = ? AND deleted_at IS NULL ORDER BY identifier_type ASC`,
    [companyId],
  );
  const [docTypes] = await exec.query(
    `SELECT DISTINCT document_type AS type FROM hrms_employee_documents
      WHERE company_id = ? AND deleted_at IS NULL ORDER BY document_type ASC`,
    [companyId],
  );

  const merge = (used, suggested) => [...new Set([...used.map((r) => r.type), ...suggested])].sort();

  return {
    contractors,
    identifierTypes: merge(idTypes, ['AADHAAR', 'PAN', 'UAN', 'ESI', 'PF', 'PASSPORT', 'DRIVING_LICENCE', 'VOTER_ID']),
    documentTypes: merge(docTypes, [
      'AADHAAR', 'PAN', 'APPOINTMENT_LETTER', 'OFFER_LETTER', 'CONTRACT', 'EDUCATION_CERTIFICATE',
      'EXPERIENCE_CERTIFICATE', 'MEDICAL_CERTIFICATE', 'SAFETY_LICENCE', 'DRIVING_LICENCE',
      'BANK_DETAILS', 'PHOTO_ID', 'RESIGNATION', 'RELIEVING_LETTER', 'OTHER',
    ]),
    employmentTypes: EMPLOYMENT_TYPES,
    employmentStatuses: EMPLOYMENT_STATUSES,
    eventTypes: EVENT_TYPES,
    verificationStatuses: VERIFICATION_STATUSES,
    limits: {
      documentStoredBytes: MAX_DOCUMENT_STORED_BYTES,
      photoStoredBytes: MAX_PHOTO_STORED_BYTES,
    },
  };
}
