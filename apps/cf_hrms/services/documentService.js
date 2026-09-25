/**
 * documentService.js — a generated document is EVIDENCE. (Plan §2 rule 7, §17.2.)
 *
 * ── THE ONE RULE THIS FILE EXISTS FOR ─────────────────────────────────────
 * THE SNAPSHOT IS WRITTEN BEFORE THE FILE IS RENDERED, IN THE SAME
 * TRANSACTION. A row whose bytes exist but whose source does not is a document
 * nobody can reproduce or explain, and "what did this role say in March" has to
 * be answerable in December — after the role changed, after the position was
 * re-scoped, after the person moved on. So the order is:
 *
 *   1. resolve everything (contentResolver, reportingResolver, the readers)
 *   2. INSERT the row with `snapshot_json`   ← the document now exists
 *   3. render DOCX and PDF **from that snapshot object**
 *   4. UPDATE the blob columns
 *   5. write the hrms_audit_log GENERATE row
 *
 * All five inside one `withTransaction`. If the render throws, nothing is left
 * behind; if the commit fails, nothing is left behind. There is no state in
 * which bytes are stored without the JSON that produced them.
 *
 * ── AND THE COROLLARY, WHICH IS THE HARDER HALF ───────────────────────────
 * A HISTORICAL DOCUMENT RENDERS FROM ITS SNAPSHOT AND NEVER RE-READS THE MODEL.
 * Every renderer in render/ takes the snapshot object and nothing else — no db
 * handle is passed, which is the cheapest possible way to make re-reading the
 * model impossible rather than merely discouraged. Re-downloading a JD from
 * March must produce March's JD even though the role has been rewritten twice
 * since. Generating a new one on the same target is how you get today's.
 *
 * ── WHY THE PREVIEW SHARES THE BUILDER ───────────────────────────────────
 * `GET /documents/preview` returns exactly what `POST /documents/generate`
 * would have frozen, built by the same function with nothing persisted. A
 * preview produced by a second code path is a preview that eventually disagrees
 * with the document, and the person who spots it will be the one holding the
 * printed copy.
 *
 * ── AND WHY THE EMPTY SECTIONS ARE IN THE SNAPSHOT AS SENTENCES ──────────
 * Plan §17.5. Karni has 63 roles, every one with no purpose, 0 KRAs, 0 KPIs,
 * 0 qualifications and 420 responsibility assignments. A JD generated today is
 * a title, a list of duties and little else. Omitting the empty headings would
 * imply the role has no requirements — a different and false claim. So each
 * section carries its own `state` and, when empty, the exact sentence the
 * document printed, stored in the snapshot so a reprint in a year still says
 * what this one said.
 *
 * ── STORAGE ───────────────────────────────────────────────────────────────
 * documentStorage.js, unchanged: deflate → LONGBLOB, `storage='db'`, the size
 * checked BEFORE the insert against the COMPRESSED length. Nothing about blobs
 * is re-invented here.
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import {
  packForStorage, unpack, toTransport, MAX_DOCUMENT_STORED_BYTES,
} from './documentStorage.js';
import { resolveContent } from './contentResolver.js';
import { dateText, today, blank, getPosition, listPositionContexts } from './positionService.js';
import { resolvePositionReporting, resolveReporting } from './reportingResolver.js';
import { assignmentsForEmployees } from './peopleService.js';
import { renderRoleJdDocx, renderRoleJdPdf } from './render/roleJd.js';
import { renderProfileDocx, renderProfilePdf } from './render/responsibilityProfile.js';

export const DOCUMENT_TYPES = ['ROLE_JD', 'EMPLOYEE_RESPONSIBILITY_PROFILE'];
export const FORMATS = ['docx', 'pdf'];

/**
 * Stamped on every row. Bump it when a renderer's OUTPUT changes, so a future
 * "why does this one look different" has an answer in the data rather than in
 * git. `snapshotVersion` is separate and bumps when the SHAPE changes.
 */
export const TEMPLATE_VERSION = 'cf_hrms/jd@1.0.0';
export const SNAPSHOT_VERSION = 1;

const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

const RENDERERS = {
  ROLE_JD: { docx: renderRoleJdDocx, pdf: renderRoleJdPdf },
  EMPLOYEE_RESPONSIBILITY_PROFILE: { docx: renderProfileDocx, pdf: renderProfilePdf },
};

/**
 * What an empty section SAYS. (Plan §17.5.)
 *
 * Every one of these is "nothing has been written yet", never "there are none".
 * The distinction is the whole point: a JD with no qualifications section reads
 * as a job needing no qualifications, which is a claim nobody at Karni has made.
 */
const EMPTY_NOTE = {
  purpose: 'No role purpose has been written for this role yet.',
  summary: 'No role summary has been written yet.',
  kras: 'No key result areas have been defined for this role yet, so the responsibilities below are listed ungrouped rather than under outcome areas.',
  responsibilities: 'No responsibilities have been assigned to this role yet.',
  kpis: 'No KPIs have been defined for this role yet, so performance against this role cannot yet be measured from this document.',
  skills: 'No skill requirements have been recorded for this role yet.',
  qualifications: 'No qualifications have been recorded for this role yet. That is not a statement that none are required.',
  experience: 'No experience requirement has been recorded for this role yet.',
  authorities: 'No authorities have been recorded for this role yet — what this role may approve, stop, issue or decide is not yet written down.',
  relationships: 'No expected working relationships have been recorded for this role yet.',
  conditions: 'No working conditions have been recorded for this role yet.',
  suppressed: null,          // an empty exceptions list is genuinely nothing to report
  exceptions: null,
  reporting: 'No manager is recorded for this work — neither a formal line on the position nor an actual one on the assignment.',
  contexts: 'No machine, line, area or project is linked to this work yet.',
  assignments: 'This person holds no open work assignment, so there is nothing to describe.',
};

/**
 * The sentence printed once, near the top, so the empty headings below are read
 * as a gap in the record and not as a finished statement about the job.
 */
const HONESTY_NOTE = 'Sections marked "not recorded yet" are shown deliberately. '
  + 'They mean nothing has been written for them in the system — not that the role has no such requirement.';

/* ══════════════════════════════════════════════════════════════════════════
 * Small shared helpers
 * ══════════════════════════════════════════════════════════════════════════ */

const isoStamp = () => new Date().toISOString();

/** A file name a browser, Windows and a mail client all accept. */
function slug(text, max = 40) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'document';
}

/** "25 September 2026" — what a document prints, computed once and frozen. */
export function longDate(iso) {
  if (!iso) return null;
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * One section descriptor. `state` is what the renderer branches on; `note` is
 * the words it prints when there is nothing. Both live in the snapshot.
 */
function section(key, heading, count, { note, subtitle = null } = {}) {
  const empty = !count;
  return {
    key,
    heading,
    subtitle,
    count: Number(count) || 0,
    state: empty ? 'EMPTY' : 'PRESENT',
    note: empty ? (note !== undefined ? note : EMPTY_NOTE[key] ?? null) : null,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Input
 * ══════════════════════════════════════════════════════════════════════════ */

export function readGenerateBody(body = {}) {
  const problems = [];
  const type = String(body.type ?? '').trim().toUpperCase();
  if (!DOCUMENT_TYPES.includes(type)) {
    problems.push(`type must be one of ${DOCUMENT_TYPES.join(', ')}.`);
  }
  const int = (v, label) => {
    if (blank(v)) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) { problems.push(`${label} must be a positive whole number.`); return null; }
    return n;
  };
  const roleId = int(body.roleId, 'roleId');
  const positionId = int(body.positionId, 'positionId');
  const employeeId = int(body.employeeId, 'employeeId');
  const on = blank(body.on) ? today() : dateText(body.on);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(on))) problems.push('on must be a date as YYYY-MM-DD.');

  if (type === 'ROLE_JD' && !roleId && !positionId) {
    problems.push('A role JD needs a roleId, or a positionId for the position-specific version.');
  }
  if (type === 'EMPLOYEE_RESPONSIBILITY_PROFILE' && !employeeId) {
    problems.push('A responsibility profile needs an employeeId — it is a document about a person.');
  }
  if (type === 'EMPLOYEE_RESPONSIBILITY_PROFILE' && (roleId || positionId)) {
    problems.push('A responsibility profile covers every assignment the person holds, so it takes no roleId or positionId.');
  }
  assertNoProblems(problems);
  return { type, roleId, positionId, employeeId, on };
}

/* ══════════════════════════════════════════════════════════════════════════
 * The snapshot builders — everything the render will use, and nothing else
 * ══════════════════════════════════════════════════════════════════════════ */

async function documentHeader(db, companyId, userId) {
  const [[company], [user]] = await Promise.all([
    db.query('SELECT id, name FROM companies WHERE id = ?', [companyId]).then(([r]) => r),
    userId
      ? db.query('SELECT id, name, email FROM users WHERE id = ?', [userId]).then(([r]) => r)
      : Promise.resolve([null]),
  ]);
  return {
    company: { id: companyId, name: company?.name ?? null },
    generatedBy: user ? { userId: user.id, name: user.name ?? null, email: user.email ?? null } : { userId: null, name: null, email: null },
  };
}

/**
 * ROLE JD. (Plan §17.3.)
 *
 * The role's own words, then the resolved KRA tree with responsibilities and
 * KPIs under it, then the requirement sections, then — when a position was
 * named — that seat's context: department, location, formal reporting, work
 * contexts, default shift and its overlays.
 *
 * EXPECTED RELATIONSHIPS ARE NOT REPORTING. The role's relationship
 * expectations say who this role coordinates with; the position's formal
 * reporting says who the seat answers to. Two different sections, both labelled,
 * because collapsing them is how a JD ends up inventing a manager.
 */
export async function buildRoleJd(db, { companyId, userId }, { roleId, positionId, on }) {
  const content = await resolveContent(db, companyId, { roleId, positionId, on });
  const role = content.role;
  const header = await documentHeader(db, companyId, userId);

  let positionContext = null;
  if (positionId) {
    const [{ position }, contexts, reporting] = await Promise.all([
      getPosition(db, companyId, positionId, { on }),
      listPositionContexts(db, companyId, positionId),
      resolvePositionReporting(db, companyId, positionId, { on }),
    ]);
    positionContext = {
      position,
      workContexts: contexts.items ?? [],
      formalReporting: {
        relationships: reporting.relationships,
        summary: reporting.summary,
      },
      overrides: content.overlay.position,
    };
  }

  const kpiCount = content.counts.kpis;
  const sections = [
    section('purpose', 'Purpose of the role', role.rolePurpose ? 1 : 0),
    section('summary', 'Summary', role.roleSummary ? 1 : 0),
    section('kras', 'Key result areas', content.counts.kras),
    section('responsibilities', 'Responsibilities', content.counts.responsibilities),
    section('kpis', 'Key performance indicators', kpiCount),
    section('skills', 'Skills', content.counts.skills),
    section('qualifications', 'Qualifications', content.counts.qualifications),
    section('experience', 'Experience', content.counts.experience),
    section('authorities', 'Authorities', content.counts.authorities),
    section('relationships', 'Expected working relationships', content.counts.relationships, {
      subtitle: 'Who this role coordinates with. This is not the reporting line.',
    }),
    section('conditions', 'Working conditions', content.counts.conditions),
    section('suppressed', 'Not part of this position', content.suppressed.length, {
      subtitle: 'The role carries these; this position does not.',
    }),
  ];

  const titleSuffix = positionContext
    ? ` (${positionContext.position.positionCode ?? `position ${positionId}`})`
    : '';
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    templateVersion: TEMPLATE_VERSION,
    documentType: 'ROLE_JD',
    asOf: content.asOf,
    asOfText: longDate(content.asOf),
    generatedAt: isoStamp(),
    ...header,

    title: `Job description — ${role.title ?? `Role ${roleId}`}${titleSuffix}`,
    subtitle: [role.roleCode, positionContext ? 'position-specific' : 'role-level', `as at ${longDate(content.asOf)}`]
      .filter(Boolean).join(' · '),
    fileBaseName: `JD-${slug(role.roleCode || roleId, 20)}-${slug(role.title, 40)}-${content.asOf}`,
    honestyNote: HONESTY_NOTE,

    role,
    positionContext,
    content,
    sections,

    summary: {
      // From the resolver, not from the input: a JD asked for by position alone
      // still has to record which role it resolved through.
      roleId: content.target.roleId,
      roleCode: role.roleCode ?? null,
      roleTitle: role.title ?? null,
      positionId: positionId ?? null,
      positionCode: positionContext?.position?.positionCode ?? null,
      kras: content.counts.kras,
      responsibilities: content.counts.responsibilities,
      kpis: kpiCount,
      suppressed: content.suppressed.length,
      layers: content.layers,
      emptySections: sections.filter((s) => s.state === 'EMPTY').map((s) => s.key),
    },
  };
}

/**
 * EMPLOYEE RESPONSIBILITY PROFILE. (Plan §17.3.)
 *
 * The person, then every open work assignment: role, position, allocation,
 * contexts, ITS ACTUAL MANAGERS WITH THEIR SCOPES, and that assignment's
 * resolved content. This is the document that makes "Ram Babu does three jobs"
 * legible on one page, and the reporting set is never flattened to one manager —
 * reportingResolver returns a set and this carries the set (plan §2 rule 9).
 *
 * WHAT IS DELIBERATELY NOT IN IT: statutory identifiers, date of birth, address
 * and the photo. A snapshot is frozen forever and this document is meant to be
 * handed to a person; Aadhaar numbers do not belong in a JSON column that never
 * expires, and `hrms_employee_identifiers` has its own permission for exactly
 * that reason.
 */
export async function buildResponsibilityProfile(db, { companyId, userId }, { employeeId, on }) {
  const [[employee]] = await db.query(
    `SELECT e.id, e.employee_code, e.full_name, e.date_of_joining, e.employment_type,
            e.employment_status, e.exit_date, c.name AS contractor_name
       FROM hrms_employees e
       LEFT JOIN hrms_contractors c ON c.company_id = e.company_id AND c.id = e.contractor_id AND c.deleted_at IS NULL
      WHERE e.company_id = ? AND e.id = ? AND e.deleted_at IS NULL`,
    [companyId, employeeId],
  );
  if (!employee) throw notFound('That employee');

  const header = await documentHeader(db, companyId, userId);
  const all = (await assignmentsForEmployees(db, companyId, [Number(employeeId)], on)).get(Number(employeeId)) ?? [];

  // Open, not merely ACTIVE. A suspended or not-yet-started job is still a job
  // this person holds, and a profile that silently omits it is a profile that
  // understates what they are on the hook for. Ended ones are named in
  // `excludedAssignments` instead of vanishing.
  const open = all.filter((a) => a.isOpen);
  const excluded = all.filter((a) => !a.isOpen).map((a) => ({
    id: a.id,
    roleTitle: a.roleTitle,
    status: a.status,
    effectiveFrom: dateText(a.effectiveFrom),
    effectiveTo: dateText(a.effectiveTo),
    why: a.effectiveTo ? `Ended ${longDate(dateText(a.effectiveTo))}.` : `Status ${a.status}.`,
  }));

  // Sequential on purpose: each assignment is two resolver calls and a handful
  // of queries, and a person with three jobs is three of those — small enough
  // that a parallel fan-out over one connection buys nothing and risks
  // interleaving on a transaction connection.
  const assignments = [];
  for (const a of open) {
    const content = await resolveContent(db, companyId, { workAssignmentId: a.id, on });
    const reporting = await resolveReporting(db, companyId, a.id, { on });
    const sections = [
      section('responsibilities', 'Responsibilities', content.counts.responsibilities),
      section('kras', 'Key result areas', content.counts.kras),
      section('kpis', 'Key performance indicators', content.counts.kpis),
      section('authorities', 'Authorities', content.counts.authorities),
      section('reporting', 'Reports to', reporting.relationships.length),
      section('contexts', 'Machines, lines and areas', a.contexts.length),
      section('suppressed', 'Not part of this work', content.suppressed.length, {
        subtitle: 'The role carries these; this assignment does not.',
      }),
    ];
    assignments.push({
      assignment: {
        id: a.id,
        roleId: a.roleId,
        roleCode: a.roleCode ?? null,
        roleTitle: a.roleTitle ?? null,
        positionId: a.positionId ?? null,
        positionCode: a.positionCode ?? null,
        positionTitle: a.positionTitle ?? null,
        assignmentTitle: a.assignmentTitle ?? null,
        departmentName: a.departmentName ?? null,
        locationName: a.locationName ?? null,
        shiftCode: a.shiftCode ?? null,
        shiftName: a.shiftName ?? null,
        allocationPercent: a.allocationPercent,
        allocationText: a.allocationPercent == null ? 'Allocation not stated' : `${a.allocationPercent}% of their time`,
        isPrimary: a.isPrimary,
        status: a.status,
        effectiveFrom: dateText(a.effectiveFrom),
        effectiveTo: dateText(a.effectiveTo),
        effectiveFromText: longDate(dateText(a.effectiveFrom)),
        /**
         * An assignment this person holds but has not started yet. `isOpen`
         * includes it on purpose (peopleService: "a job they still hold, whether
         * it has started yet or is paused"), so the document has to SAY so —
         * a profile dated 1 September that lists work beginning on the 10th
         * without a word overstates what the person was doing that day.
         */
        startsLater: !!(dateText(a.effectiveFrom) && dateText(a.effectiveFrom) > on),
        contexts: a.contexts,
      },
      // The SET, with each manager's scope. Never one manager, never a bare id.
      reporting: {
        relationships: reporting.relationships,
        superseded: reporting.superseded,
        summary: reporting.summary,
      },
      content,
      sections,
    });
  }

  const totalAllocation = open
    .filter((a) => a.isActive)
    .reduce((n, a) => n + (a.allocationPercent ?? 0), 0);

  const sections = [
    section('assignments', 'Work assignments', assignments.length),
  ];

  return {
    snapshotVersion: SNAPSHOT_VERSION,
    templateVersion: TEMPLATE_VERSION,
    documentType: 'EMPLOYEE_RESPONSIBILITY_PROFILE',
    asOf: on,
    asOfText: longDate(on),
    generatedAt: isoStamp(),
    ...header,

    title: `Responsibility profile — ${employee.full_name}`,
    subtitle: [employee.employee_code, `${assignments.length} assignment${assignments.length === 1 ? '' : 's'}`, `as at ${longDate(on)}`]
      .filter(Boolean).join(' · '),
    fileBaseName: `Responsibilities-${slug(employee.employee_code || employeeId, 20)}-${slug(employee.full_name, 40)}-${on}`,
    honestyNote: HONESTY_NOTE,

    employee: {
      id: employee.id,
      employeeCode: employee.employee_code,
      fullName: employee.full_name,
      dateOfJoining: dateText(employee.date_of_joining),
      dateOfJoiningText: longDate(dateText(employee.date_of_joining)),
      employmentType: employee.employment_type,
      employmentStatus: employee.employment_status,
      exitDate: dateText(employee.exit_date),
      contractorName: employee.contractor_name ?? null,
    },
    assignments,
    excludedAssignments: excluded,
    sections,

    summary: {
      employeeId: employee.id,
      employeeCode: employee.employee_code,
      employeeName: employee.full_name,
      assignments: assignments.length,
      endedAssignments: excluded.length,
      totalAllocationPercent: Math.round(totalAllocation * 100) / 100,
      overAllocated: totalAllocation > 100,
      responsibilities: assignments.reduce((n, a) => n + a.content.counts.responsibilities, 0),
      kpis: assignments.reduce((n, a) => n + a.content.counts.kpis, 0),
      managers: assignments.reduce((n, a) => n + a.reporting.relationships.length, 0),
      suppressed: assignments.reduce((n, a) => n + a.content.suppressed.length, 0),
      emptySections: assignments.length ? [] : ['assignments'],
    },
  };
}

/** The one dispatcher. Both documents, one shape of call. */
export async function buildSnapshot(db, c, input) {
  const { type, roleId, positionId, employeeId, on } = input;
  if (type === 'ROLE_JD') return buildRoleJd(db, c, { roleId, positionId, on });
  return buildResponsibilityProfile(db, c, { employeeId, on });
}

/**
 * The preview. Resolves and returns exactly what `generate` would freeze, and
 * persists nothing — so someone can look before committing a document that is
 * then permanent evidence.
 */
export async function previewDocument(db, c, body = {}) {
  const input = readGenerateBody(body);
  const snapshot = await buildSnapshot(db, c, input);
  return { persisted: false, asOf: snapshot.asOf, documentType: snapshot.documentType, snapshot };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Render — from the snapshot, never from the model
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * @param snapshot the stored (or just-built) snapshot object — the ONLY input.
 *                 No db handle is in scope, by construction.
 */
export async function renderFromSnapshot(snapshot, format) {
  const renderers = RENDERERS[snapshot?.documentType];
  if (!renderers) throw invalid('BAD_SNAPSHOT', `This document's type (${snapshot?.documentType ?? 'unknown'}) has no renderer.`);
  const render = renderers[format];
  if (!render) throw invalid('BAD_FORMAT', `format must be one of ${FORMATS.join(', ')}.`);
  const buffer = await render(snapshot);
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw invalid('RENDER_FAILED', `The ${format.toUpperCase()} render produced no bytes.`);
  }
  return buffer;
}

/* ══════════════════════════════════════════════════════════════════════════
 * generate — the five steps, in order, in one transaction
 * ══════════════════════════════════════════════════════════════════════════ */

export async function generate(db, c, body = {}, requestId = null) {
  const { companyId, userId } = c;
  const input = readGenerateBody(body);

  // 1. RESOLVE.
  const snapshot = await buildSnapshot(db, c, input);

  // The target the `uq_hgdo_current` key is built on. A role-level JD and a
  // position-specific JD of the same role are DIFFERENT targets on purpose:
  // both are current, and both are true.
  const target = {
    roleId: input.type === 'ROLE_JD' ? (snapshot.summary.roleId ?? null) : null,
    positionId: input.type === 'ROLE_JD' ? (input.positionId ?? null) : null,
    employeeId: input.type === 'ROLE_JD' ? null : input.employeeId,
  };

  // 2a. Demote whatever was current for this target. The unique key allows one,
  // and a superseded document is kept, not deleted — that is the whole point.
  await db.query(
    `UPDATE hrms_generated_documents
        SET is_current = 0
      WHERE company_id = ? AND deleted_at IS NULL AND is_current = 1
        AND document_type = ?
        AND IFNULL(role_id, 0) = ? AND IFNULL(position_id, 0) = ? AND IFNULL(employee_id, 0) = ?`,
    [companyId, input.type, target.roleId ?? 0, target.positionId ?? 0, target.employeeId ?? 0],
  );

  // 2b. INSERT THE SNAPSHOT. Before any rendering. Plan §2 rule 7.
  const [ins] = await db.query(
    `INSERT INTO hrms_generated_documents
       (company_id, document_type, role_id, position_id, employee_id,
        snapshot_json, template_version, generated_by, is_current, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [companyId, input.type, target.roleId, target.positionId, target.employeeId,
      JSON.stringify(snapshot), TEMPLATE_VERSION, userId, userId],
  );
  const id = ins.insertId;

  // 3 + 4. RENDER FROM THE SNAPSHOT, then store the bytes.
  const files = {};
  for (const format of FORMATS) {
    const buffer = await renderFromSnapshot(snapshot, format);
    const packed = await packForStorage(buffer, MAX_DOCUMENT_STORED_BYTES, `${format.toUpperCase()} document`);
    const fileName = `${snapshot.fileBaseName}.${format}`;
    await db.query(
      `UPDATE hrms_generated_documents
          SET ${format}_file_name = ?, ${format}_mime_type = ?, ${format}_size_bytes = ?,
              ${format}_storage = ?, ${format}_compression = ?, ${format}_content = ?
        WHERE company_id = ? AND id = ?`,
      [fileName, MIME[format], packed.sizeBytes, packed.storage, packed.compression, packed.content, companyId, id],
    );
    files[format] = { fileName, mimeType: MIME[format], sizeBytes: packed.sizeBytes, storedBytes: packed.content.length };
  }

  // 5. The audit row, in the same transaction — TiDB has no triggers and an
  // audit row written afterwards is an audit row that can go missing.
  await db.query(
    `INSERT INTO hrms_audit_log
       (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, request_id, created_by)
     VALUES (?, ?, 'hrms_generated_documents', ?, 'GENERATE', NULL, ?, ?, ?)`,
    [companyId, userId, id, JSON.stringify({
      documentType: input.type,
      ...target,
      asOf: snapshot.asOf,
      templateVersion: TEMPLATE_VERSION,
      layers: snapshot.documentType === 'ROLE_JD' ? snapshot.content.layers : undefined,
      summary: snapshot.summary,
      files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.sizeBytes])),
    }), requestId ?? null, userId],
  );

  const [[row]] = await db.query(`${DOCUMENT_SELECT()} WHERE g.company_id = ? AND g.id = ?`, [companyId, id]);
  return { ok: true, id, document: shapeDocument(row), files, snapshot };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Reads
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * NEVER `SELECT *` on this table: four blob columns and a snapshot mean a list
 * of forty documents would be tens of megabytes of JSON nobody asked for. The
 * list pulls the title, the date and the summary OUT of the snapshot with
 * JSON_EXTRACT so a screen can show counts without carrying the content.
 */
const DOCUMENT_COLUMNS = `
         g.id, g.document_type, g.role_id, g.position_id, g.employee_id,
         g.template_version, g.generated_by, g.generated_at, g.is_current, g.created_at,
         g.docx_file_name, g.docx_mime_type, g.docx_size_bytes,
         (g.docx_content IS NOT NULL OR g.docx_uri IS NOT NULL) AS has_docx,
         g.pdf_file_name, g.pdf_mime_type, g.pdf_size_bytes,
         (g.pdf_content IS NOT NULL OR g.pdf_uri IS NOT NULL)   AS has_pdf,
         JSON_UNQUOTE(JSON_EXTRACT(g.snapshot_json, '$.title'))    AS snap_title,
         JSON_UNQUOTE(JSON_EXTRACT(g.snapshot_json, '$.subtitle')) AS snap_subtitle,
         JSON_UNQUOTE(JSON_EXTRACT(g.snapshot_json, '$.asOf'))     AS snap_as_of,
         JSON_EXTRACT(g.snapshot_json, '$.summary')                AS snap_summary,
         r.role_code, r.title AS role_title,
         p.position_code, COALESCE(p.position_title, pr.title) AS position_title,
         e.employee_code, e.full_name AS employee_name,
         u.name AS generated_by_name, u.email AS generated_by_email`;

const DOCUMENT_FROM = `
    FROM hrms_generated_documents g
    LEFT JOIN hrms_roles     r  ON r.company_id = g.company_id AND r.id = g.role_id
    LEFT JOIN hrms_positions p  ON p.company_id = g.company_id AND p.id = g.position_id
    LEFT JOIN hrms_roles     pr ON pr.company_id = p.company_id AND pr.id = p.role_id
    LEFT JOIN hrms_employees e  ON e.company_id = g.company_id AND e.id = g.employee_id
    LEFT JOIN users          u  ON u.id = g.generated_by`;

/** The list read. `extra` adds columns; only `getDocument` asks for the snapshot. */
const DOCUMENT_SELECT = (extra = '') => `SELECT ${DOCUMENT_COLUMNS}${extra}${DOCUMENT_FROM}`;

const readJson = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
};

export function shapeDocument(row) {
  if (!row) return null;
  const kind = row.employee_id ? 'EMPLOYEE' : (row.position_id ? 'POSITION' : 'ROLE');
  const label = kind === 'EMPLOYEE'
    ? [row.employee_code, row.employee_name].filter(Boolean).join(' · ')
    : kind === 'POSITION'
      ? [row.position_code, row.position_title ?? row.role_title].filter(Boolean).join(' · ')
      : [row.role_code, row.role_title].filter(Boolean).join(' · ');

  return {
    id: row.id,
    documentType: row.document_type,
    title: row.snap_title ?? null,
    subtitle: row.snap_subtitle ?? null,
    asOf: row.snap_as_of ?? null,
    templateVersion: row.template_version,

    /** What the document is ABOUT, resolved — a list row should need no joins of its own. */
    target: {
      kind,
      label,
      roleId: row.role_id, roleCode: row.role_code ?? null, roleTitle: row.role_title ?? null,
      positionId: row.position_id, positionCode: row.position_code ?? null, positionTitle: row.position_title ?? null,
      employeeId: row.employee_id, employeeCode: row.employee_code ?? null, employeeName: row.employee_name ?? null,
    },

    generatedAt: row.generated_at,
    generatedBy: {
      userId: row.generated_by,
      name: row.generated_by_name ?? null,
      email: row.generated_by_email ?? null,
    },
    /** The latest for this target. A superseded document is kept and still downloadable. */
    isCurrent: !!row.is_current,
    summary: readJson(row.snap_summary),
    formats: {
      docx: { available: !!row.has_docx, fileName: row.docx_file_name ?? null, mimeType: row.docx_mime_type ?? MIME.docx, sizeBytes: row.docx_size_bytes ?? null },
      pdf: { available: !!row.has_pdf, fileName: row.pdf_file_name ?? null, mimeType: row.pdf_mime_type ?? MIME.pdf, sizeBytes: row.pdf_size_bytes ?? null },
    },
  };
}

export async function listDocuments(db, companyId, query = {}) {
  const where = ['g.company_id = ?', 'g.deleted_at IS NULL'];
  const params = [companyId];

  if (!blank(query.type)) {
    const types = String(query.type).split(',').map((t) => t.trim().toUpperCase()).filter((t) => DOCUMENT_TYPES.includes(t));
    if (types.length) { where.push(`g.document_type IN (${types.map(() => '?').join(',')})`); params.push(...types); }
  }
  for (const [key, col] of [['roleId', 'g.role_id'], ['positionId', 'g.position_id'], ['employeeId', 'g.employee_id']]) {
    if (!blank(query[key])) { where.push(`${col} = ?`); params.push(Number(query[key])); }
  }
  if (query.currentOnly === '1' || query.currentOnly === true || query.currentOnly === 'true') {
    where.push('g.is_current = 1');
  }
  if (!blank(query.search)) {
    where.push(`(r.title LIKE ? OR r.role_code LIKE ? OR p.position_code LIKE ? OR e.full_name LIKE ? OR e.employee_code LIKE ?)`);
    const like = `%${String(query.search).trim()}%`;
    params.push(like, like, like, like, like);
  }

  const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
  const [rows] = await db.query(
    `${DOCUMENT_SELECT()} WHERE ${where.join(' AND ')} ORDER BY g.generated_at DESC, g.id DESC LIMIT ${limit}`,
    params,
  );
  const items = rows.map(shapeDocument);
  return {
    items,
    total: items.length,
    limit,
    totals: {
      current: items.filter((i) => i.isCurrent).length,
      roleJds: items.filter((i) => i.documentType === 'ROLE_JD').length,
      profiles: items.filter((i) => i.documentType === 'EMPLOYEE_RESPONSIBILITY_PROFILE').length,
    },
  };
}

/** One document WITH its snapshot — this is what the app previews from (§17.4). */
export async function getDocument(db, companyId, id) {
  const [[row]] = await db.query(
    `${DOCUMENT_SELECT(', g.snapshot_json AS snapshot_json')} WHERE g.company_id = ? AND g.id = ? AND g.deleted_at IS NULL`,
    [companyId, id],
  );
  if (!row) throw notFound('That document');
  const snapshot = readJson(row.snapshot_json);
  return {
    document: shapeDocument(row),
    /**
     * The FROZEN content. The preview renders from this and not from the model,
     * so opening a JD from March shows March's role even though the role has
     * been rewritten since.
     */
    snapshot,
    snapshotVersion: snapshot?.snapshotVersion ?? null,
  };
}

/**
 * The stored bytes.
 *
 * If the blob is missing — a format added after this row was written, or a
 * render that failed — it is re-rendered FROM THE STORED SNAPSHOT and flagged.
 * Never from the model: that is the whole rule, and re-reading today's role to
 * fill in an old document's missing PDF would break it invisibly.
 */
export async function readDocumentFile(db, companyId, id, format = 'docx') {
  const f = String(format).toLowerCase();
  if (!FORMATS.includes(f)) throw invalid('BAD_FORMAT', `format must be one of ${FORMATS.join(', ')}.`);

  const [[row]] = await db.query(
    `SELECT id, document_type,
            ${f}_file_name AS fileName, ${f}_mime_type AS mimeType,
            ${f}_storage AS storage, ${f}_compression AS compression,
            ${f}_content AS content, ${f}_uri AS uri,
            snapshot_json
       FROM hrms_generated_documents
      WHERE company_id = ? AND id = ? AND deleted_at IS NULL`,
    [companyId, id],
  );
  if (!row) throw notFound('That document');

  if (row.content || row.uri) {
    const buffer = await unpack(row, `${f.toUpperCase()} document`);
    return {
      ...toTransport(buffer, { fileName: row.fileName, mimeType: row.mimeType || MIME[f] }),
      renderedFromSnapshot: false,
    };
  }

  const snapshot = readJson(row.snapshot_json);
  if (!snapshot) throw notFound(`The ${f.toUpperCase()} of that document`);
  const buffer = await renderFromSnapshot(snapshot, f);
  return {
    ...toTransport(buffer, {
      fileName: row.fileName || `${snapshot.fileBaseName}.${f}`,
      mimeType: MIME[f],
    }),
    renderedFromSnapshot: true,
  };
}

export default {
  generate, previewDocument, listDocuments, getDocument, readDocumentFile,
  buildSnapshot, renderFromSnapshot, readGenerateBody,
  DOCUMENT_TYPES, FORMATS, TEMPLATE_VERSION,
};
