/**
 * reportingResolver.js — THE one implementation of "who does this person answer
 * to for this work". (Plan §2 rule 9, §7; spec v1.1 architecture §13, taxonomy §17.)
 *
 * The org chart, the employee profile and JD generation all read this file.
 * Nobody re-derives "the manager" anywhere else, and nothing in this app ever
 * returns a single `manager_id`. Reporting is a SET, and flattening it is the
 * exact mistake the v1.1 addenda were written to prevent.
 *
 * ── THE MODEL IN ONE PARAGRAPH ────────────────────────────────────────────
 * Reporting is orthogonal to Role. A second manager never justifies a second
 * Role, Position or Work Assignment; it is another ROW. A dotted line is a
 * relationship TYPE. When a manager's authority covers only part of the work —
 * "statutory compliance", one machine, one project — that is a SCOPE on the
 * row, not a carve-out of the job. `isPrimary` means primary *for that layer*
 * and never invalidates a dotted, functional or project manager beside it. A
 * new Work Assignment is created only when the WORK is materially distinct.
 *
 * ── TWO LAYERS ────────────────────────────────────────────────────────────
 *   FORMAL  (origin 'POSITION')   hrms_position_reporting_relationships.
 *           The organisation's design, position to position. It survives
 *           vacancies and people changes. Inherited by every assignment that
 *           names that position. Its manager is a SEAT, so the person is
 *           resolved at read time and may be several people, or nobody.
 *   ACTUAL  (origin 'ASSIGNMENT') hrms_assignment_reporting_relationships.
 *           What is true for the person doing this work. It ADDS to, NARROWS
 *           or REPLACES the inherited default.
 *
 * ── RESOLUTION ────────────────────────────────────────────────────────────
 * Inherit every formal row of the assignment's position that is live on the
 * date. Then apply the assignment's own rows. An assignment row REPLACES an
 * inherited one when it has the same relationship type AND the same scope key
 * — same kind of authority over the same part of the work. Anything else is an
 * addition and both stay. Nothing is ever silently dropped: a replaced formal
 * row comes back in `superseded` saying which row replaced it, because "the
 * chart says X but this person actually reports to Y" is information, not noise.
 *
 * ── OUTPUT SHAPE (stable; the org chart depends on it) ────────────────────
 * {
 *   asOf: '2026-09-24',                       // the date everything was resolved for
 *   assignment: {                             // the work whose reporting this is
 *     id, employeeId, employeeCode, employeeName,
 *     roleId, roleTitle, positionId, positionCode, positionTitle,
 *     assignmentTitle, allocationPercent, isPrimary, status,
 *     effectiveFrom, effectiveTo
 *   },
 *   relationships: [ Relationship ],          // THE RESOLVED SET — never one manager
 *   superseded:    [ Relationship ],          // formal rows an assignment row replaced
 *   summary: {
 *     total, byOrigin: { POSITION, ASSIGNMENT }, byType: { PRIMARY_MANAGER: 1, … },
 *     primaryCount, scopedCount, unresolvedFormalCount, hasAnyManager
 *   }
 * }
 *
 * Relationship = {
 *   key: 'ASSIGNMENT:12',                     // stable within one response
 *   id: 12,                                   // row id in its own table
 *   origin: 'POSITION' | 'ASSIGNMENT',        // WHICH LAYER THIS CAME FROM
 *   layer:  'FORMAL'   | 'ACTUAL',            // the same fact in the spec's words
 *   inherited: true|false,                    // true iff origin === 'POSITION'
 *   relationshipType: { id, code, name, isFormal, allowMultiple, sortOrder },
 *   isPrimary: bool,                          // primary FOR THIS LAYER only
 *   scope: { type, label, workContextId, workContextName, notes, key },
 *   manager: {                                // null only for a vacant formal seat
 *     employeeId, employeeCode, name,
 *     workAssignmentId, workAssignmentTitle,  // WHICH HAT the manager wears
 *     roleId, roleTitle, positionId, positionCode
 *   } | null,
 *   managerCandidates: [ manager ],           // formal rows: everyone in that seat now
 *   managerPosition: { id, code, title, roleTitle } | null,   // formal rows only
 *   vacant: bool,                             // a formal seat nobody currently fills
 *   effectiveFrom, effectiveTo,
 *   endsOn: 'YYYY-MM-DD' | null,              // same as effectiveTo, named for the UI
 *   supersededById: number | null,            // set on rows in `superseded`
 *   note: string | null                       // one plain sentence when there is something to say
 * }
 *
 * `manager` is NEVER a bare id, and there is deliberately no `managerId` field
 * anywhere in this response. A caller that wants "the boss" must choose which
 * of the returned rows it means, in front of the user, and say so.
 */
import { notFound } from '../lib/errors.js';
import { dateText, today, LIVE_ON } from './positionService.js';

/* ── row loaders ────────────────────────────────────────────────────────── */

const ASSIGNMENT_HEAD = `
  SELECT wa.*, e.employee_code, e.full_name, r.title AS role_title,
         p.position_code, COALESCE(p.position_title, pr.title) AS position_title
    FROM hrms_work_assignments wa
    JOIN hrms_employees e ON e.company_id = wa.company_id AND e.id = wa.employee_id
    LEFT JOIN hrms_roles r ON r.company_id = wa.company_id AND r.id = wa.role_id
    LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id
    LEFT JOIN hrms_roles pr ON pr.company_id = wa.company_id AND pr.id = p.role_id
   WHERE wa.company_id = ? AND wa.id = ? AND wa.deleted_at IS NULL`;

const ACTUAL_ROWS = `
  SELECT ar.*, ar.scope_key,
         t.code AS type_code, t.name AS type_name, t.is_formal, t.allow_multiple, t.sort_order,
         e.employee_code AS manager_code, e.full_name AS manager_name,
         ma.assignment_title AS manager_assignment_title, ma.role_id AS manager_role_id,
         ma.position_id AS manager_position_id,
         mr.title AS manager_role_title, mp.position_code AS manager_position_code,
         sc.name AS scope_context_name
    FROM hrms_assignment_reporting_relationships ar
    JOIN hrms_reporting_relationship_types t ON t.company_id = ar.company_id AND t.id = ar.relationship_type_id
    JOIN hrms_employees e ON e.company_id = ar.company_id AND e.id = ar.manager_employee_id
    LEFT JOIN hrms_work_assignments ma ON ma.company_id = ar.company_id AND ma.id = ar.manager_work_assignment_id
    LEFT JOIN hrms_roles mr ON mr.company_id = ar.company_id AND mr.id = ma.role_id
    LEFT JOIN hrms_positions mp ON mp.company_id = ar.company_id AND mp.id = ma.position_id
    LEFT JOIN hrms_work_contexts sc ON sc.company_id = ar.company_id AND sc.id = ar.scope_work_context_id
   WHERE ar.company_id = ? AND ar.work_assignment_id = ? AND ar.deleted_at IS NULL`;

const FORMAL_ROWS = `
  SELECT rr.*, rr.scope_key,
         t.code AS type_code, t.name AS type_name, t.is_formal, t.allow_multiple, t.sort_order,
         tp.position_code AS to_code, COALESCE(tp.position_title, tr.title) AS to_title,
         tr.title AS to_role_title,
         sc.name AS scope_context_name
    FROM hrms_position_reporting_relationships rr
    JOIN hrms_reporting_relationship_types t ON t.company_id = rr.company_id AND t.id = rr.relationship_type_id
    JOIN hrms_positions tp ON tp.company_id = rr.company_id AND tp.id = rr.to_position_id
    LEFT JOIN hrms_roles tr ON tr.company_id = rr.company_id AND tr.id = tp.role_id
    LEFT JOIN hrms_work_contexts sc ON sc.company_id = rr.company_id AND sc.id = rr.scope_work_context_id
   WHERE rr.company_id = ? AND rr.from_position_id = ? AND rr.deleted_at IS NULL`;

const typeOf = (r) => ({
  id: r.relationship_type_id,
  code: r.type_code,
  name: r.type_name,
  isFormal: Boolean(r.is_formal),
  allowMultiple: Boolean(r.allow_multiple),
  sortOrder: r.sort_order == null ? 0 : Number(r.sort_order),
});

const scopeOf = (r) => ({
  type: r.scope_type,
  label: r.scope_label ?? null,
  workContextId: r.scope_work_context_id ?? null,
  workContextName: r.scope_context_name ?? null,
  notes: r.scope_notes ?? r.notes ?? null,
  // The DB's generated scope_key: 'TYPE:label:contextId'. It is what makes an
  // edge's identity include its scope, so one manager can hold two differently
  // scoped relationships of the same type (v1.1 §13.2).
  key: r.scope_key ?? `${r.scope_type}::0`,
});

/** A scope stated in words, for a UI that should never render "RESPONSIBILITY". */
export function scopeSentence(scope) {
  if (!scope || scope.type === 'GENERAL') return 'All of this work';
  const what = scope.label || scope.workContextName;
  const kind = {
    FUNCTION: 'Function', RESPONSIBILITY: 'Responsibility',
    WORK_CONTEXT: 'Work context', PROJECT: 'Project', OTHER: 'Scope',
  }[scope.type] ?? 'Scope';
  return what ? `${kind}: ${what}` : kind;
}

/**
 * Who is sitting in a position right now. A formal reporting row names a SEAT,
 * so the person is resolved at read time — that is the entire reason formal
 * reporting survives a resignation. Several people may share a seat
 * (sanctioned_headcount > 1) and the honest answer is then all of them.
 */
async function occupantsOf(db, companyId, positionIds, on) {
  if (!positionIds.length) return new Map();
  const [rows] = await db.query(
    `SELECT wa.position_id, wa.id AS assignment_id, wa.assignment_title, wa.employee_id,
            e.employee_code, e.full_name, wa.role_id, r.title AS role_title,
            p.position_code, wa.is_primary
       FROM hrms_work_assignments wa
       JOIN hrms_employees e ON e.company_id = wa.company_id AND e.id = wa.employee_id
       LEFT JOIN hrms_roles r ON r.company_id = wa.company_id AND r.id = wa.role_id
       LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id
      WHERE wa.company_id = ? AND wa.deleted_at IS NULL AND wa.status = 'ACTIVE'
        AND wa.position_id IN (${positionIds.map(() => '?').join(',')})
        AND (wa.effective_from IS NULL OR wa.effective_from <= ?)
        AND (wa.effective_to IS NULL OR wa.effective_to >= ?)
      ORDER BY wa.is_primary DESC, e.full_name`,
    [companyId, ...positionIds, on, on],
  );
  const byPosition = new Map();
  for (const r of rows) {
    const list = byPosition.get(r.position_id) ?? [];
    list.push({
      employeeId: r.employee_id,
      employeeCode: r.employee_code,
      name: r.full_name,
      workAssignmentId: r.assignment_id,
      workAssignmentTitle: r.assignment_title ?? r.role_title ?? null,
      roleId: r.role_id,
      roleTitle: r.role_title,
      positionId: r.position_id,
      positionCode: r.position_code,
    });
    byPosition.set(r.position_id, list);
  }
  return byPosition;
}

/* ── shaping ────────────────────────────────────────────────────────────── */

function shapeActual(r) {
  const scope = scopeOf(r);
  return {
    key: `ASSIGNMENT:${r.id}`,
    id: r.id,
    origin: 'ASSIGNMENT',
    layer: 'ACTUAL',
    inherited: false,
    relationshipType: typeOf(r),
    isPrimary: Boolean(r.is_primary),
    scope,
    scopeSentence: scopeSentence(scope),
    manager: {
      employeeId: r.manager_employee_id,
      employeeCode: r.manager_code,
      name: r.manager_name,
      workAssignmentId: r.manager_work_assignment_id ?? null,
      workAssignmentTitle: r.manager_assignment_title ?? null,
      roleId: r.manager_role_id ?? null,
      roleTitle: r.manager_role_title ?? null,
      positionId: r.manager_position_id ?? null,
      positionCode: r.manager_position_code ?? null,
    },
    managerCandidates: [],
    managerPosition: null,
    vacant: false,
    effectiveFrom: dateText(r.effective_from),
    effectiveTo: dateText(r.effective_to),
    endsOn: dateText(r.effective_to),
    supersededById: null,
    note: r.manager_work_assignment_id
      ? null
      : 'The manager is named as a person, not as one of their assignments — so which hat they wear here is not recorded.',
  };
}

function shapeFormal(r, occupants) {
  const people = occupants.get(r.to_position_id) ?? [];
  const scope = scopeOf(r);
  return {
    key: `POSITION:${r.id}`,
    id: r.id,
    origin: 'POSITION',
    layer: 'FORMAL',
    inherited: true,
    relationshipType: typeOf(r),
    isPrimary: Boolean(r.is_primary),
    scope,
    scopeSentence: scopeSentence(scope),
    manager: people[0] ?? null,
    managerCandidates: people,
    managerPosition: {
      id: r.to_position_id,
      code: r.to_code ?? null,
      title: r.to_title ?? null,
      roleTitle: r.to_role_title ?? null,
    },
    vacant: people.length === 0,
    effectiveFrom: dateText(r.effective_from),
    effectiveTo: dateText(r.effective_to),
    endsOn: dateText(r.effective_to),
    supersededById: null,
    note: people.length === 0
      ? 'Inherited from the position. That seat is vacant, so no person holds this line right now.'
      : people.length > 1
        ? `Inherited from the position. ${people.length} people currently hold that seat.`
        : 'Inherited from the position.',
  };
}

const sortRows = (rows) => rows.sort((a, b) =>
  Number(b.isPrimary) - Number(a.isPrimary)
  || a.relationshipType.sortOrder - b.relationshipType.sortOrder
  || String(a.relationshipType.code).localeCompare(String(b.relationshipType.code))
  || a.id - b.id);

function summarise(rows) {
  const byType = {};
  let primaryCount = 0;
  let scopedCount = 0;
  let unresolvedFormalCount = 0;
  for (const r of rows) {
    byType[r.relationshipType.code] = (byType[r.relationshipType.code] ?? 0) + 1;
    if (r.isPrimary) primaryCount += 1;
    if (r.scope.type !== 'GENERAL') scopedCount += 1;
    if (r.vacant) unresolvedFormalCount += 1;
  }
  return {
    total: rows.length,
    byOrigin: {
      POSITION: rows.filter((r) => r.origin === 'POSITION').length,
      ASSIGNMENT: rows.filter((r) => r.origin === 'ASSIGNMENT').length,
    },
    byType,
    primaryCount,
    scopedCount,
    unresolvedFormalCount,
    hasAnyManager: rows.some((r) => r.manager != null),
  };
}

/* ── the two public reads ───────────────────────────────────────────────── */

/**
 * Every ACTUAL relationship on one work assignment, with its scope.
 * This is `GET /assignments/:id/reporting-relationships` (spec v1.1 §13.5).
 * It returns the whole set and nothing resembling a single manager.
 */
export async function assignmentRelationships(db, companyId, assignmentId, { on, includeEnded = false } = {}) {
  const asOf = dateText(on) || today();
  const [[head]] = await db.query(ASSIGNMENT_HEAD, [companyId, assignmentId]);
  if (!head) throw notFound('Work assignment');

  const params = [companyId, assignmentId];
  let sql = ACTUAL_ROWS;
  if (!includeEnded) { sql += ` AND ${LIVE_ON('ar')}`; params.push(asOf, asOf); }
  sql += ' ORDER BY ar.is_primary DESC, t.sort_order, ar.id';
  const [rows] = await db.query(sql, params);
  const relationships = sortRows(rows.map(shapeActual));

  return {
    asOf,
    includeEnded,
    assignment: shapeAssignmentHead(head),
    relationships,
    summary: summarise(relationships),
  };
}

export function shapeAssignmentHead(a) {
  return {
    id: a.id,
    employeeId: a.employee_id,
    employeeCode: a.employee_code,
    employeeName: a.full_name,
    roleId: a.role_id,
    roleTitle: a.role_title ?? null,
    positionId: a.position_id ?? null,
    positionCode: a.position_code ?? null,
    positionTitle: a.position_title ?? null,
    assignmentTitle: a.assignment_title ?? null,
    allocationPercent: a.allocation_percent == null ? null : Number(a.allocation_percent),
    isPrimary: Boolean(a.is_primary),
    status: a.status,
    effectiveFrom: dateText(a.effective_from),
    effectiveTo: dateText(a.effective_to),
  };
}

/**
 * The RESOLVED set: the position's formal defaults combined with the
 * assignment's additions and narrowings, every row tagged with the layer it
 * came from. This is what the org chart, the employee profile and the JD read.
 *
 * An assignment row replaces an inherited row when `relationshipTypeId` and
 * `scope.key` match — same authority, same part of the work. Everything else
 * is an addition and both survive, because a dotted manager standing beside a
 * primary is the normal case, not a conflict.
 */
export async function resolveReporting(db, companyId, assignmentId, { on } = {}) {
  const asOf = dateText(on) || today();
  const [[head]] = await db.query(ASSIGNMENT_HEAD, [companyId, assignmentId]);
  if (!head) throw notFound('Work assignment');

  const [actualRows] = await db.query(
    `${ACTUAL_ROWS} AND ${LIVE_ON('ar')} ORDER BY ar.is_primary DESC, t.sort_order, ar.id`,
    [companyId, assignmentId, asOf, asOf],
  );
  const actual = actualRows.map(shapeActual);

  let formal = [];
  if (head.position_id) {
    const [formalRows] = await db.query(
      `${FORMAL_ROWS} AND ${LIVE_ON('rr')} ORDER BY rr.is_primary DESC, t.sort_order, rr.id`,
      [companyId, head.position_id, asOf, asOf],
    );
    const occupants = await occupantsOf(db, companyId, [...new Set(formalRows.map((r) => r.to_position_id))], asOf);
    formal = formalRows.map((r) => shapeFormal(r, occupants));
  }

  // Replacement is keyed on type + scope. Same kind of authority over the same
  // part of the work = the assignment row is the truth; anything else is an
  // addition and both stay. Nothing is dropped — replaced rows are returned.
  const replacedBy = new Map();
  for (const a of actual) replacedBy.set(`${a.relationshipType.id}|${a.scope.key}`, a.id);

  const superseded = [];
  const inherited = [];
  for (const f of formal) {
    const replacer = replacedBy.get(`${f.relationshipType.id}|${f.scope.key}`);
    if (replacer) {
      superseded.push({
        ...f,
        supersededById: replacer,
        note: `Replaced for this person by an assignment-level ${f.relationshipType.name}${f.scope.type === 'GENERAL' ? '' : ` for ${scopeSentence(f.scope).toLowerCase()}`}. The formal design still says this.`,
      });
    } else {
      inherited.push(f);
    }
  }

  const relationships = sortRows([...actual, ...inherited]);
  return {
    asOf,
    assignment: shapeAssignmentHead(head),
    relationships,
    superseded,
    summary: summarise(relationships),
  };
}

/**
 * The formal design of one position, with each seat's current occupants
 * resolved. The org chart reads this for its edges; the position screen reads
 * it for its "Formal reporting" tab. Same shapes as above so a caller that can
 * render one can render the other.
 */
export async function resolvePositionReporting(db, companyId, positionId, { on } = {}) {
  const asOf = dateText(on) || today();
  const [[p]] = await db.query(
    `SELECT p.id, p.position_code, COALESCE(p.position_title, r.title) AS title, r.title AS role_title
       FROM hrms_positions p LEFT JOIN hrms_roles r ON r.company_id = p.company_id AND r.id = p.role_id
      WHERE p.company_id = ? AND p.id = ? AND p.deleted_at IS NULL`,
    [companyId, positionId],
  );
  if (!p) throw notFound('Position');

  const [rows] = await db.query(
    `${FORMAL_ROWS} AND ${LIVE_ON('rr')} ORDER BY rr.is_primary DESC, t.sort_order, rr.id`,
    [companyId, positionId, asOf, asOf],
  );
  const occupants = await occupantsOf(db, companyId, [...new Set(rows.map((r) => r.to_position_id))], asOf);
  const relationships = sortRows(rows.map((r) => shapeFormal(r, occupants)));
  return {
    asOf,
    position: { id: p.id, code: p.position_code, title: p.title, roleTitle: p.role_title },
    relationships,
    summary: summarise(relationships),
  };
}
