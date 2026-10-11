/**
 * orgChartService.js — the org chart READ MODEL. (Plan §7; spec
 * `CF_HRMS_ORG_CHART_SPEC.md` §1, §2, §9.)
 *
 * ── WHAT THE CHART IS ─────────────────────────────────────────────────────
 * Nodes are POSITIONS. Edges are `hrms_position_reporting_relationships` live
 * on the view date — ALL of them, typed and scoped. Occupants are the work
 * assignments filling each seat.
 *
 * ── EVERYTHING ELSE IS A DEPARTMENT (2026-10-10) ──────────────────────────
 * A machine, an area and a shared crew are departments in the ONE tree
 * (`hrms_departments`), and a seat has exactly one: `node.departmentId`. The
 * whole tree travels as `departments` — id, code, name, parentId, type (a
 * label, never logic), isShared, serves[], rank — so the client can draw
 * "department → process → machine" and one shared box pointing at each
 * department it serves. A machine is still never a manager (plan §2 rule 3):
 * the import re-pointed every machine-parented position at its nearest human
 * ancestor, so nothing is skipped at render time.
 *
 * Work contexts are RETIRED from this read model. `node.contexts` is always
 * an empty array, kept only so a client written before the change does not
 * crash; this file no longer reads hrms_position_work_contexts at all. (The
 * one remaining mention is a reporting edge's optional scope, which is the
 * reporting model's business, not the chart's.)
 *
 * ── THE SERVER NEVER PICKS "THE" MANAGER ──────────────────────────────────
 * Every live edge travels in the payload with its type and its scope. The
 * client chooses `PRIMARY_MANAGER` to lay out a tree and draws the rest as
 * secondary links. Flattening reporting to one manager here would be the exact
 * mistake plan §2 rule 9 exists to prevent, and `reportingResolver.js` stays
 * the only implementation of "who does this person answer to".
 *
 * ── ONE POSITION IS ONE CHAIR (2026-10-10) ────────────────────────────────
 * A position is for one person on one shift (services/seatCount.js). So a node
 * has 0 or 1 `occupants`, `vacancies` is 0 or 1, `sanctionedHeadcount` and
 * `effectiveSanctioned` are 1, `requirements` is always `[]`, and
 * `shiftPattern` is the position's own shift code — never `DN`: day and night
 * are two positions. `overFilled` is true only when the data is wrong (two
 * live assignments on one chair); both people still travel so the screen can
 * show the problem instead of hiding a person.
 *
 * The payload STAYS position-shaped — one node per position, edges position to
 * position. What the client draws is CARDS: `node.cardId` groups the chairs of
 * one role in one department under one manager card (services/positionCards.js
 * is the rule). Sibling chairs of a card carry the same `displayTitle`.
 *
 * ── ONE PAYLOAD, A HANDFUL OF QUERIES ─────────────────────────────────────
 * Karni is 220 positions, max depth 8. The whole graph travels in one response
 * with no pagination, and it is assembled from a fixed number of company-wide
 * queries (positions, edges, occupants, department serves, content counts,
 * overrides, open points, departments, attendance) joined in memory. Nothing in
 * here runs per node. The manpower-requirements read is gone: a chair is the
 * requirement.
 */
import { notFound, invalid } from '../lib/errors.js';
import { dateText, today, LIVE_ON, requirePosition, listPositionOverrides } from './positionService.js';
import {
  SEATS_PER_POSITION, HOLDS_SEAT_SQL, OCCUPANT_COUNT_SQL,
  shiftPattern as seatShiftPattern, vacancies as seatVacancies, overFilled as seatOverFilled,
} from './seatCount.js';
import { computeCards, loadCards } from './positionCards.js';
import { openHiringsByPosition, shapePositionHiring, COMING_OR_LIVE_SQL, splitComing } from './hiringRead.js';
import { NOTICE_JOIN_SQL, NOTICE_COLUMNS_SQL, noticeOf } from './exitRead.js';
import { resolvePositionReporting, scopeSentence } from './reportingResolver.js';
import { getRoleContent } from './roleContentService.js';

/* ══════════════════════════════════════════════════════════════════════════
 * Shift vocabulary
 * ══════════════════════════════════════════════════════════════════════════
 * The seeded shifts are G (General), D (Day) and N (Night). Day/night is read
 * off the CODE rather than the clock, because that is what the import wrote and
 * what the source chart meant by "DN".
 */

const num = (v) => (v == null ? 0 : Number(v));

/* ══════════════════════════════════════════════════════════════════════════
 * The collection reads — each one runs ONCE for the whole company
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * The boxes. CLOSED positions are excluded: a closed seat is not part of the
 * organisation's current design, and counting its headcount would invent
 * vacancies nobody is hiring for. DRAFT and FROZEN stay, tagged by `status`,
 * because a chart that hides a frozen seat hides a real hole.
 */
// The OPEN hiring of a position rides along on two unique keys (uq_hhir_open: at most one open hiring
// per position; uq_hhlt_current: at most one current offer letter per hiring), so the join adds no rows
// and the chart costs no extra read for it.
const POSITIONS_SQL = `
  SELECT p.id, p.position_code, p.position_title, p.role_id, p.department_id, p.location_id,
         p.sanctioned_headcount, p.default_shift_id, p.status, p.effective_from, p.effective_to,
         r.title AS role_title, r.role_code,
         d.name AS department_name, d.code AS department_code, d.parent_department_id AS department_parent_id, l.name AS location_name,
         s.code AS shift_code, s.name AS shift_name,
         hi.id AS hiring_id, hi.stage AS hiring_stage, hi.candidate_name AS hiring_candidate_name, hl.id AS hiring_offer_letter_id
    FROM hrms_positions p
    LEFT JOIN hrms_roles       r ON r.company_id = p.company_id AND r.id = p.role_id
    LEFT JOIN hrms_departments d ON d.company_id = p.company_id AND d.id = p.department_id
    LEFT JOIN hrms_locations   l ON l.company_id = p.company_id AND l.id = p.location_id
    LEFT JOIN hrms_shifts      s ON s.company_id = p.company_id AND s.id = p.default_shift_id
    LEFT JOIN hrms_hirings        hi ON hi.company_id = p.company_id AND hi.open_position = p.id
    LEFT JOIN hrms_hiring_letters hl ON hl.company_id = hi.company_id AND hl.hiring_id = hi.id
                                    AND hl.kind = 'OFFER' AND hl.is_current = 1 AND hl.deleted_at IS NULL
   WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status <> 'CLOSED'
     AND ${LIVE_ON('p')}
   ORDER BY p.position_code, p.id`;

/**
 * The department tree — the whole of it, because it IS the organisation's
 * structure and the chart draws it. `rank` is a pre-order walk, siblings by
 * code then id, so "Purchase · PPC · Production · Quality …" comes out in the
 * client's own order. Inactive departments still travel and still rank — a
 * position can sit in one.
 */
const DEPARTMENTS_SQL = `
  SELECT id, code, name, parent_department_id, department_type, is_shared
    FROM hrms_departments
   WHERE company_id = ? AND deleted_at IS NULL`;

/** Which departments each shared department serves. One row per line the chart draws from a shared box. */
const SERVES_SQL = `
  SELECT s.department_id, s.serves_department_id
    FROM hrms_department_serves s
   WHERE s.company_id = ? AND s.deleted_at IS NULL
   ORDER BY s.department_id, s.serves_department_id`;

/**
 * The contract the chart is built against (CF_HRMS_PLAN.md §9.4). `type` is the
 * company's own label and nothing may branch on its text; `isShared` and
 * `serves` are the facts. A serves row pointing at a department that is gone is
 * dropped rather than sent as a dangling id.
 */
export function shapeDepartments(departmentRows, serveRows, rank) {
  const live = new Set(departmentRows.map((r) => r.id));
  const servesBy = new Map();
  for (const r of serveRows) {
    if (!live.has(r.department_id) || !live.has(r.serves_department_id)) continue;
    const list = servesBy.get(r.department_id) ?? [];
    list.push(r.serves_department_id);
    servesBy.set(r.department_id, list);
  }
  return departmentRows
    .map((r) => ({
      id: r.id,
      code: r.code ?? null,
      name: r.name,
      parentId: r.parent_department_id != null && live.has(r.parent_department_id) ? r.parent_department_id : null,
      type: r.department_type ?? null,
      isShared: Boolean(r.is_shared),
      serves: servesBy.get(r.id) ?? [],
      rank: rank.get(r.id) ?? null,
    }))
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
}

function departmentRanks(rows) {
  const kids = new Map();
  const ids = new Set(rows.map((r) => r.id));
  const byCode = (a, b) => String(a.code ?? '').localeCompare(String(b.code ?? ''), undefined, { numeric: true }) || a.id - b.id;
  for (const r of rows) {
    const parentId = r.parent_department_id != null && ids.has(r.parent_department_id) ? r.parent_department_id : 0;
    if (!kids.has(parentId)) kids.set(parentId, []);
    kids.get(parentId).push(r);
  }
  const rank = new Map();
  const walk = (parentId, guard) => {
    if (guard > 64) return;
    for (const r of (kids.get(parentId) ?? []).sort(byCode)) {
      if (rank.has(r.id)) continue;
      rank.set(r.id, rank.size);
      walk(r.id, guard + 1);
    }
  };
  walk(0, 0);
  // A unit caught in a parent cycle never reaches the walk; rank it last rather than drop it.
  for (const r of [...rows].sort(byCode)) if (!rank.has(r.id)) rank.set(r.id, rank.size);
  return rank;
}

/** Every live reporting edge in the company, typed and scoped. Never filtered by type. */
const EDGES_SQL = `
  SELECT rr.id, rr.from_position_id, rr.to_position_id, rr.relationship_type_id, rr.is_primary,
         rr.scope_type, rr.scope_label, rr.scope_work_context_id, rr.notes,
         rr.effective_from, rr.effective_to,
         t.code AS type_code, t.name AS type_name, t.is_formal, t.sort_order,
         wc.name AS scope_context_name
    FROM hrms_position_reporting_relationships rr
    JOIN hrms_reporting_relationship_types t ON t.company_id = rr.company_id AND t.id = rr.relationship_type_id
    LEFT JOIN hrms_work_contexts wc ON wc.company_id = rr.company_id AND wc.id = rr.scope_work_context_id
   WHERE rr.company_id = ? AND rr.deleted_at IS NULL AND ${LIVE_ON('rr')}
   ORDER BY rr.is_primary DESC, t.sort_order, rr.id`;

/**
 * Who is in each chair: at most one person. "In the chair" is seatCount.js's
 * predicate (not ENDED, in date). An employee with three assignments appears in
 * three positions — correct.
 *
 * The read is widened from "in date" to "not over yet" so it also brings whoever is
 * DUE TO JOIN a position later (hiringRead.splitComing separates them): the `joining`
 * marker costs no extra query. One `?` for the date, after the company.
 */
const OCCUPANTS_SQL = `
  SELECT wa.id AS assignment_id, wa.position_id, wa.employee_id, wa.assignment_title,
         wa.allocation_percent, wa.is_primary, wa.role_id, wa.default_shift_id,
         wa.effective_from, wa.effective_to,
         e.employee_code, e.full_name, e.employment_status,
         s.code AS shift_code, s.name AS shift_name,
         r.title AS role_title,
         ${NOTICE_COLUMNS_SQL('x')}
    FROM hrms_work_assignments wa
    JOIN hrms_employees e ON e.company_id = wa.company_id AND e.id = wa.employee_id
    LEFT JOIN hrms_shifts s ON s.company_id = wa.company_id AND s.id = wa.default_shift_id
    LEFT JOIN hrms_roles  r ON r.company_id = wa.company_id AND r.id = wa.role_id
    ${NOTICE_JOIN_SQL('wa', 'x')}
   WHERE wa.company_id = ? AND ${HOLDS_SEAT_SQL('wa')} AND ${COMING_OR_LIVE_SQL('wa')}
   ORDER BY wa.is_primary DESC, e.full_name`;

/**
 * The badge on the box. Content lives on the ROLE, so the counts are per role
 * and every position of that role carries them. One UNION instead of four round
 * trips, and none of it per node.
 */
const CONTENT_COUNTS_SQL = `
    SELECT 'kras' AS kind, a.role_id, COUNT(*) AS n
      FROM hrms_role_kra_assignments a
     WHERE a.company_id = ? AND a.deleted_at IS NULL AND ${LIVE_ON('a')}
     GROUP BY a.role_id
  UNION ALL
    SELECT 'responsibilities', a.role_id, COUNT(*)
      FROM hrms_role_responsibility_assignments a
     WHERE a.company_id = ? AND a.deleted_at IS NULL AND ${LIVE_ON('a')}
     GROUP BY a.role_id
  UNION ALL
    SELECT 'kpis', a.role_id, COUNT(*)
      FROM hrms_role_kpi_assignments a
     WHERE a.company_id = ? AND a.deleted_at IS NULL AND ${LIVE_ON('a')}
     GROUP BY a.role_id
  UNION ALL
    SELECT 'qualifications', a.role_id, COUNT(*)
      FROM hrms_role_qualification_requirements a
     WHERE a.company_id = ? AND a.deleted_at IS NULL AND ${LIVE_ON('a')}
     GROUP BY a.role_id`;

/**
 * A position overlay changes what the box is really carrying, so the badge has
 * to see it: ADD is one more, SUPPRESS is one fewer, OVERRIDE replaces and
 * counts the same. This is a COUNT delta only — the three-layer resolution
 * itself belongs to contentResolver.js (plan §2 rule 6) and is not re-derived here.
 */
const OVERRIDE_COUNTS_SQL = `
  SELECT o.position_id, o.content_type, o.action, COUNT(*) AS n
    FROM hrms_position_content_overrides o
   WHERE o.company_id = ? AND o.deleted_at IS NULL AND ${LIVE_ON('o')}
   GROUP BY o.position_id, o.content_type, o.action`;

const OPEN_POINT_COUNTS_SQL = `
  SELECT op.entity_type, op.entity_id, COUNT(*) AS n
    FROM hrms_open_points op
   WHERE op.company_id = ? AND op.deleted_at IS NULL AND op.status = 'OPEN'
   GROUP BY op.entity_type, op.entity_id`;

/** Attendance is per PERSON per DATE. No record is the normal case, not an error. */
const ATTENDANCE_SQL = `
  SELECT ar.employee_id, ar.status, ar.shift_id, ar.work_assignment_id, s.code AS shift_code
    FROM hrms_attendance_records ar
    LEFT JOIN hrms_shifts s ON s.company_id = ar.company_id AND s.id = ar.shift_id
   WHERE ar.company_id = ? AND ar.deleted_at IS NULL AND ar.attendance_date = ?`;

/* ══════════════════════════════════════════════════════════════════════════
 * Duplicate titles
 * ══════════════════════════════════════════════════════════════════════════
 * Karni has 12 titles used by more than one position and one of them ("Helper 1")
 * is used by ten. Without a qualifier the chart reads as ten identical boxes.
 *
 * Spec §2 says: append the PARENT'S TITLE in brackets. That is the rule, and it
 * is the first thing tried — but on the real data it is not always enough: two
 * "Helper 1" positions both report to Printing Incharge and differ only by the
 * machine they cover. So when the parent does not separate them, the seat's
 * DEPARTMENT is tried — a machine is a department now, so this is the same
 * "Helper 1 (… · Pelican Machine)" it always was — and a position code is the
 * last resort. A title used once is never decorated.
 *
 * ONE CHAIR PER POSITION (2026-10-10): what is told apart is CARDS, not
 * positions. The seven chairs of one card are the same job under the same
 * manager, so they are one entry here (represented by the lowest id) and all
 * seven get the same display title — "Helper 1" is repeated only when another
 * CARD is also called "Helper 1". The code used as a last resort is the card's
 * base code (`P124` for `P124-1 … P124-7`).
 */
const baseCode = (code) => (code == null ? null : String(code).replace(/-\d+$/, ''));

function buildDisplayTitles(allPositions, primaryParentTitleById, primaryContextNameById) {
  // One entry per card and title. (Chairs of one card normally share a title;
  // if someone renamed one, it is told apart by its own name.)
  const units = new Map();
  for (const p of allPositions) {
    const key = `${p.cardId}|${p.title}`;
    const unit = units.get(key);
    if (!unit) units.set(key, { id: p.id, title: p.title, positionCode: p.positionCode, memberIds: [p.id] });
    else {
      unit.memberIds.push(p.id);
      if (p.id < unit.id) { unit.id = p.id; unit.positionCode = p.positionCode; }
    }
  }
  for (const unit of units.values()) if (unit.memberIds.length > 1) unit.positionCode = baseCode(unit.positionCode);
  const positions = [...units.values()];

  const byTitle = new Map();
  for (const p of positions) {
    const list = byTitle.get(p.title) ?? [];
    list.push(p);
    byTitle.set(p.title, list);
  }

  const display = new Map();
  const setAll = (unit, text) => { for (const id of unit.memberIds) display.set(id, text); };
  for (const [title, group] of byTitle) {
    if (group.length < 2) {
      for (const p of group) setAll(p, title);
      continue;
    }
    // Try qualifiers in order of how much they say, keeping the spec's form first.
    const candidates = [
      (p) => primaryParentTitleById.get(p.id) ?? null,
      (p) => primaryContextNameById.get(p.id) ?? null,
      // Parent, plus the department only for the seats whose parent is shared
      // with another seat of this title — "Helper 1 (Incharge - Production ·
      // Pelican Machine)" beside "Helper 1 (Store Supervisor - Films)". Adding the
      // department to every one of them would only make the unambiguous longer.
      (p) => {
        const parent = primaryParentTitleById.get(p.id);
        const context = primaryContextNameById.get(p.id);
        const parentShared = parent && group.filter((o) => primaryParentTitleById.get(o.id) === parent).length > 1;
        return parent && context && parentShared ? `${parent} · ${context}` : parent ?? context ?? null;
      },
      (p) => p.positionCode ?? `#${p.id}`,
    ];
    let chosen = null;
    for (const make of candidates) {
      const values = group.map((p) => make(p));
      if (values.some((v) => !v)) continue;
      if (new Set(values).size === group.length) { chosen = make; break; }
    }
    // Nothing separates them — still qualify with what we have plus the code, so
    // two boxes are at least distinguishable to a human reading the screen.
    const fallback = (p) => {
      const parent = primaryParentTitleById.get(p.id) ?? primaryContextNameById.get(p.id);
      return parent ? `${parent} · ${p.positionCode ?? `#${p.id}`}` : (p.positionCode ?? `#${p.id}`);
    };
    const make = chosen ?? fallback;
    for (const p of group) setAll(p, `${title} (${make(p)})`);
  }
  return display;
}

/* ══════════════════════════════════════════════════════════════════════════
 * The graph
 * ══════════════════════════════════════════════════════════════════════════ */

/** One live edge, in the shape the client draws. Scope travels on EVERY edge, not only dotted ones. */
function shapeEdge(r) {
  const scope = {
    type: r.scope_type,
    label: r.scope_label ?? null,
    workContextId: r.scope_work_context_id ?? null,
    workContextName: r.scope_context_name ?? null,
  };
  return {
    id: r.id,
    fromPositionId: r.from_position_id,
    toPositionId: r.to_position_id,
    typeCode: r.type_code,
    typeName: r.type_name,
    isFormal: Boolean(r.is_formal),
    isPrimary: Boolean(r.is_primary),
    scopeType: scope.type,
    scopeLabel: scope.label,
    scopeWorkContextId: scope.workContextId,
    scopeWorkContextName: scope.workContextName,
    scopeSentence: scopeSentence(scope),
    effectiveFrom: dateText(r.effective_from),
    effectiveTo: dateText(r.effective_to),
  };
}

/**
 * The whole chart for one date, optionally re-rooted at one position.
 *
 * `root` walks DOWN `PRIMARY_MANAGER` edges only — that is the tree the client
 * draws, so it is the tree "start from here" means. Secondary edges inside the
 * subtree still travel; an edge with one foot outside the subtree is left out
 * so the client never has to draw a link to a node it does not have, and the
 * number left out is reported rather than swallowed.
 */
export async function buildOrgChart(db, companyId, { on, root } = {}) {
  const asOf = dateText(on) || today();
  const startedAt = Date.now();

  const [
    [positionRows], [edgeRows], [occupantAndComingRows], [serveRows],
    [contentRows], [overrideRows], [openPointRows], [departmentRows],
  ] = await Promise.all([
    db.query(POSITIONS_SQL, [companyId, asOf, asOf]),
    db.query(EDGES_SQL, [companyId, asOf, asOf]),
    db.query(OCCUPANTS_SQL, [companyId, asOf]),
    db.query(SERVES_SQL, [companyId]),
    db.query(CONTENT_COUNTS_SQL, [companyId, asOf, asOf, companyId, asOf, asOf, companyId, asOf, asOf, companyId, asOf, asOf]),
    db.query(OVERRIDE_COUNTS_SQL, [companyId, asOf, asOf]),
    db.query(OPEN_POINT_COUNTS_SQL, [companyId]),
    db.query(DEPARTMENTS_SQL, [companyId]),
  ]);
  // In the chair on the date, and due to join it later.
  const { live: occupantRows, joining: joiningByPosition } = splitComing(occupantAndComingRows, asOf);
  const departmentRank = departmentRanks(departmentRows);
  const departments = shapeDepartments(departmentRows, serveRows, departmentRank);

  const employeeIds = [...new Set(occupantRows.map((o) => o.employee_id))];
  const attendanceRows = employeeIds.length
    ? (await db.query(ATTENDANCE_SQL, [companyId, asOf]))[0]
    : [];

  /* ── index every collection by position, once ──────────────────────────── */
  const group = (rows, key) => {
    const map = new Map();
    for (const r of rows) {
      const k = r[key];
      const list = map.get(k) ?? [];
      list.push(r);
      map.set(k, list);
    }
    return map;
  };

  const occupantsByPosition = group(occupantRows, 'position_id');

  const contentByRole = new Map();
  for (const r of contentRows) {
    const c = contentByRole.get(r.role_id) ?? { kras: 0, responsibilities: 0, kpis: 0, qualifications: 0 };
    c[r.kind] = num(r.n);
    contentByRole.set(r.role_id, c);
  }
  const overrideDelta = new Map();   // positionId -> { kras, responsibilities, kpis }
  const CONTENT_KEY = { KRA: 'kras', RESPONSIBILITY: 'responsibilities', KPI: 'kpis' };
  for (const r of overrideRows) {
    const key = CONTENT_KEY[r.content_type];
    if (!key) continue;
    const d = overrideDelta.get(r.position_id) ?? { kras: 0, responsibilities: 0, kpis: 0 };
    if (r.action === 'ADD') d[key] += num(r.n);
    else if (r.action === 'SUPPRESS') d[key] -= num(r.n);
    overrideDelta.set(r.position_id, d);
  }

  const openPointsByPosition = new Map();
  let organisationOpenPoints = 0;
  for (const r of openPointRows) {
    if (r.entity_type === 'POSITION' && r.entity_id != null) openPointsByPosition.set(r.entity_id, num(r.n));
    else if (r.entity_type === 'ORGANIZATION') organisationOpenPoints += num(r.n);
  }

  const attendanceByEmployee = new Map();
  for (const r of attendanceRows) {
    if (!attendanceByEmployee.has(r.employee_id)) attendanceByEmployee.set(r.employee_id, r);
  }

  /* ── the primary parent, used for the tree and for disambiguation ───────── */
  const primaryParentOf = new Map();
  for (const e of edgeRows) {
    if (e.type_code !== 'PRIMARY_MANAGER') continue;
    if (!primaryParentOf.has(e.from_position_id)) primaryParentOf.set(e.from_position_id, e.to_position_id);
  }

  const baseTitleOf = new Map(positionRows.map((p) => [p.id, p.position_title || p.role_title || `Position ${p.id}`]));
  const primaryParentTitle = new Map();
  for (const [child, parent] of primaryParentOf) {
    const t = baseTitleOf.get(parent);
    if (t) primaryParentTitle.set(child, t);
  }
  // The second qualifier for a repeated title: the seat's department. It used
  // to be the primary work context, and for a seat on a machine it is the same
  // words — the machine is the department.
  const primaryContextName = new Map();
  for (const p of positionRows) if (p.department_name) primaryContextName.set(p.id, p.department_name);

  /* ── the cards: which chairs are drawn together (positionCards.js) ──────── */
  const cardOf = computeCards(
    positionRows.map((p) => ({ id: p.id, roleId: p.role_id, departmentId: p.department_id })),
    primaryParentOf,
  );

  /* ── assemble the nodes ────────────────────────────────────────────────── */
  const allNodes = positionRows.map((p) => {
    // One chair, on its own shift. The numbers come from services/seatCount.js —
    // the ONE implementation; nothing here reads sanctioned_headcount.
    const shiftPattern = seatShiftPattern(p.shift_code);

    const occupants = (occupantsByPosition.get(p.id) ?? []).map((o) => {
      const attendance = attendanceByEmployee.get(o.employee_id) ?? null;
      return {
        employeeId: o.employee_id,
        employeeCode: o.employee_code,
        name: o.full_name,
        assignmentId: o.assignment_id,
        assignmentTitle: o.assignment_title ?? o.role_title ?? null,
        allocationPercent: o.allocation_percent == null ? null : Number(o.allocation_percent),
        isPrimary: Boolean(o.is_primary),
        employmentStatus: o.employment_status ?? null,
        // The assignment's own shift, falling back to the seat's default.
        shiftCode: o.shift_code ?? p.shift_code ?? null,
        attendanceStatus: attendance ? attendance.status : null,
        // On notice: { exitId, exitType, lastWorkingDay, daysLeft }, or null. Still in the position, still counted.
        notice: noticeOf(o, asOf),
      };
    });

    const content = contentByRole.get(p.role_id) ?? { kras: 0, responsibilities: 0, kpis: 0, qualifications: 0 };
    const delta = overrideDelta.get(p.id) ?? { kras: 0, responsibilities: 0, kpis: 0 };
    const openPoints = openPointsByPosition.get(p.id) ?? 0;
    const counts = {
      kras: Math.max(0, content.kras + delta.kras),
      responsibilities: Math.max(0, content.responsibilities + delta.responsibilities),
      kpis: Math.max(0, content.kpis + delta.kpis),
      qualifications: content.qualifications,
      openPoints,
    };

    return {
      id: p.id,
      // The card this chair is drawn in: the lowest position id among the chairs
      // of the same role and department under the same manager card.
      cardId: cardOf.get(p.id) ?? p.id,
      positionCode: p.position_code ?? null,
      title: baseTitleOf.get(p.id),
      displayTitle: baseTitleOf.get(p.id),          // replaced below once duplicates are known
      roleId: p.role_id,
      roleCode: p.role_code ?? null,
      roleTitle: p.role_title ?? null,
      departmentId: p.department_id ?? null,
      departmentName: p.department_name ?? null,
      // The seat's ONE department — a unit, a machine or a shared crew; look it
      // up in `departments` for its parent, label and what it serves. The four
      // flat fields below are kept for clients that still read them.
      departmentCode: p.department_code ?? null,
      departmentRank: p.department_id != null ? (departmentRank.get(p.department_id) ?? null) : null,
      // A ROOT unit (no parent) is leadership: the chart keeps its teams a plain tree.
      departmentIsRoot: p.department_id != null && p.department_name != null && p.department_parent_id == null,
      locationId: p.location_id ?? null,
      locationName: p.location_name ?? null,
      status: p.status,
      // Always 1, both of them: a position is one chair. Kept by name because
      // clients written before the change read them.
      sanctionedHeadcount: SEATS_PER_POSITION,
      effectiveSanctioned: SEATS_PER_POSITION,
      // The position's own shift code. Never 'DN' — day and night are two positions.
      shiftPattern,
      // The position's shift. null only where the company has no shifts at all.
      defaultShift: p.default_shift_id
        ? { id: p.default_shift_id, code: p.shift_code ?? null, name: p.shift_name ?? null }
        : null,
      // Retired: machines are departments. Always empty, kept so a client
      // written before the change still finds an array.
      contexts: [],
      // 0 or 1. Two is wrong data, flagged by overFilled and still shown.
      occupants,
      // Retired: a chair is the requirement. Always empty.
      requirements: [],
      vacancies: seatVacancies(occupants.length),
      overFilled: seatOverFilled(occupants.length),
      // The OPEN hiring on this position, or null. A position being hired for is still vacant.
      hiring: p.hiring_id
        ? shapePositionHiring({ id: p.hiring_id, stage: p.hiring_stage, candidate_name: p.hiring_candidate_name, has_offer_letter: p.hiring_offer_letter_id })
        : null,
      // Who is due to join it from a later date, or null. Vacant until then: no count moves.
      joining: joiningByPosition.get(p.id) ?? null,
      counts,
      hasContent: counts.kras + counts.responsibilities + counts.kpis + counts.qualifications + counts.openPoints > 0,
      effectiveFrom: dateText(p.effective_from),
      effectiveTo: dateText(p.effective_to),
    };
  });

  // Disambiguation is computed over the WHOLE company, not over the subtree, so
  // a box reads the same whether you are looking at the org or at one branch.
  const displayTitles = buildDisplayTitles(allNodes, primaryParentTitle, primaryContextName);
  for (const n of allNodes) n.displayTitle = displayTitles.get(n.id) ?? n.title;

  /* ── re-rooting ────────────────────────────────────────────────────────── */
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  let rootInfo = null;
  let keep = null;

  if (root != null) {
    const rootNode = byId.get(Number(root));
    if (!rootNode) throw notFound('Position');
    rootInfo = { positionId: rootNode.id, positionCode: rootNode.positionCode, title: rootNode.title, displayTitle: rootNode.displayTitle };

    const childrenOf = new Map();
    for (const [child, parent] of primaryParentOf) {
      if (!byId.has(child) || !byId.has(parent)) continue;
      const list = childrenOf.get(parent) ?? [];
      list.push(child);
      childrenOf.set(parent, list);
    }
    keep = new Set([rootNode.id]);
    const queue = [rootNode.id];
    // A depth guard, not an optimisation: addPositionReporting refuses cycles on
    // formal types, but a graph read must never hang on data written before it did.
    let guard = 0;
    while (queue.length && guard < 10000) {
      guard += 1;
      const id = queue.shift();
      for (const child of childrenOf.get(id) ?? []) {
        if (keep.has(child)) continue;
        keep.add(child);
        queue.push(child);
      }
    }
  }

  const nodes = keep ? allNodes.filter((n) => keep.has(n.id)) : allNodes;
  const visible = new Set(nodes.map((n) => n.id));
  let edgesOutsideSubtree = 0;
  const edges = [];
  for (const r of edgeRows) {
    const inside = visible.has(r.from_position_id) && visible.has(r.to_position_id);
    if (!inside) {
      if (keep && (visible.has(r.from_position_id) || visible.has(r.to_position_id))) edgesOutsideSubtree += 1;
      continue;
    }
    edges.push(shapeEdge(r));
  }

  /* ── totals, over exactly the nodes being returned ─────────────────────── */
  // filled + vacant = positions, always: an over-filled chair is ONE filled seat.
  let filled = 0;
  let vacant = 0;
  let present = 0;
  let absent = 0;
  const byShiftPattern = { G: 0, D: 0, N: 0 };
  const byShift = {};
  for (const n of nodes) {
    const isFilled = n.vacancies === 0;
    if (isFilled) filled += 1; else vacant += 1;
    byShiftPattern[n.shiftPattern] = (byShiftPattern[n.shiftPattern] ?? 0) + 1;
    const shiftName = n.defaultShift?.name ?? n.defaultShift?.code ?? 'No shift';
    const shift = byShift[shiftName] ?? (byShift[shiftName] = { positions: 0, filled: 0 });
    shift.positions += 1;
    if (isFilled) shift.filled += 1;
    for (const o of n.occupants) {
      if (o.attendanceStatus === 'PRESENT') present += 1;
      else if (o.attendanceStatus === 'ABSENT') absent += 1;
    }
  }

  const withPrimaryManager = new Set(edges.filter((e) => e.typeCode === 'PRIMARY_MANAGER').map((e) => e.fromPositionId));
  const roots = nodes.filter((n) => !withPrimaryManager.has(n.id)).map((n) => n.id);

  return {
    asOf,
    root: rootInfo,
    nodes,
    edges,
    // The WHOLE tree, also when the chart is re-rooted: a subtree's seats still
    // need their departments' ancestors to be drawn in place.
    departments,
    counts: {
      // One position is one seat, so these two are the same number.
      positions: nodes.length,
      sanctioned: nodes.length,
      filled,
      vacant,
      // Open hirings among these positions. Each is on a vacant one, so this is part of `vacant`.
      hiring: nodes.filter((n) => n.hiring).length,
      // Positions somebody is due to join on a later date. Also still counted vacant (or filled, by the person leaving).
      joining: nodes.filter((n) => n.joining).length,
      // People in these positions who are on notice. They are part of `filled`.
      onNotice: nodes.reduce((t, n) => t + n.occupants.filter((o) => o.notice).length, 0),
      // How many boxes the chart draws.
      cards: new Set(nodes.map((n) => n.cardId)).size,
      // By shift NAME: { General: { positions, filled }, Day: …, Night: … }.
      byShift,
      present,
      absent,
      edges: edges.length,
      roots: roots.length,
      openPoints: nodes.reduce((t, n) => t + n.counts.openPoints, 0) + (keep ? 0 : organisationOpenPoints),
      byShiftPattern,
    },
    // Everything a client would otherwise have to re-derive by scanning the graph.
    roots,
    edgesOutsideSubtree,
    generatedInMs: Date.now() - startedAt,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * The card
 * ══════════════════════════════════════════════════════════════════════════
 * Everything the modal shows that the graph deliberately leaves out. The
 * reporting block comes from `reportingResolver.resolvePositionReporting` —
 * the one implementation — so a vacant manager seat and a scoped dotted line
 * arrive already explained.
 *
 * ONE CHAIR (2026-10-10). The card is about ONE position: `shift` is its shift,
 * `occupants` holds at most one person. `cardId` and `siblings` say which other
 * positions are drawn in the same box (same role and department under the same
 * manager card), each with its shift and who is in it.
 *
 * `directReports`: by default the positions whose line points at THIS position.
 * With `scope: 'card'` it is the positions reporting to ANY position of this
 * card — the team reports to the card, and which chair a line happens to name
 * (the same-shift one, by the migration's rule) is not what a reader is asking.
 * Each row carries `toPositionId` so the client can still tell.
 */
export async function getPositionCard(db, companyId, positionId, { on, scope } = {}) {
  const asOf = dateText(on) || today();
  const [position, cards] = await Promise.all([
    requirePosition(db, companyId, positionId),
    loadCards(db, companyId, asOf),
  ]);
  // A closed position is in no card: it stands alone.
  const cardId = cards.cardOf.get(positionId) ?? positionId;
  const cardIds = cards.members.get(cardId) ?? [positionId];
  const siblingIds = cardIds.filter((x) => x !== positionId);
  const reportTargets = String(scope ?? '').toLowerCase() === 'card' ? cardIds : [positionId];
  const marks = (list) => list.map(() => '?').join(',');

  const [
    [[head]], [occupantAndComingRows], [openPointRows], [parentRows], [reportRows], [siblingRows], hiringByPosition,
  ] = await Promise.all([
    db.query(
      `SELECT p.id, p.position_code, p.position_title, p.role_id, p.sanctioned_headcount, p.status,
              p.effective_from, p.effective_to,
              r.title AS role_title, r.role_code, r.role_purpose, r.role_summary, r.status AS role_status,
              d.id AS department_id, d.name AS department_name, d.code AS department_code,
              d.department_type, d.is_shared AS department_is_shared,
              l.id AS location_id, l.name AS location_name,
              s.id AS shift_id, s.code AS shift_code, s.name AS shift_name
         FROM hrms_positions p
         LEFT JOIN hrms_roles       r ON r.company_id = p.company_id AND r.id = p.role_id
         LEFT JOIN hrms_departments d ON d.company_id = p.company_id AND d.id = p.department_id
         LEFT JOIN hrms_locations   l ON l.company_id = p.company_id AND l.id = p.location_id
         LEFT JOIN hrms_shifts      s ON s.company_id = p.company_id AND s.id = p.default_shift_id
        WHERE p.company_id = ? AND p.id = ?`,
      [companyId, positionId],
    ),
    db.query(`${OCCUPANTS_SQL.replace('WHERE wa.company_id = ?', 'WHERE wa.company_id = ? AND wa.position_id = ?')}`, [companyId, positionId, asOf]),
    db.query(
      `SELECT op.* FROM hrms_open_points op
        WHERE op.company_id = ? AND op.deleted_at IS NULL AND op.entity_type = 'POSITION' AND op.entity_id = ?
        ORDER BY FIELD(op.status,'OPEN','RESOLVED','DISMISSED'), op.id`,
      [companyId, positionId],
    ),
    db.query(
      `SELECT rr.to_position_id AS id, tp.position_code, COALESCE(tp.position_title, tr.title) AS title,
              t.code AS type_code, t.name AS type_name
         FROM hrms_position_reporting_relationships rr
         JOIN hrms_positions tp ON tp.company_id = rr.company_id AND tp.id = rr.to_position_id
         LEFT JOIN hrms_roles tr ON tr.company_id = rr.company_id AND tr.id = tp.role_id
         JOIN hrms_reporting_relationship_types t ON t.company_id = rr.company_id AND t.id = rr.relationship_type_id
        WHERE rr.company_id = ? AND rr.from_position_id = ? AND rr.deleted_at IS NULL AND ${LIVE_ON('rr')}`,
      [companyId, positionId, asOf, asOf],
    ),
    // Direct reports: the other half of the seat's shape, and the reason the card
    // can answer "who works for this position" without re-reading the graph.
    db.query(
      `SELECT rr.from_position_id AS id, rr.to_position_id, fp.position_code, COALESCE(fp.position_title, fr.title) AS title,
              t.code AS type_code, t.name AS type_name,
              ${OCCUPANT_COUNT_SQL('fp')} AS occupied
         FROM hrms_position_reporting_relationships rr
         JOIN hrms_positions fp ON fp.company_id = rr.company_id AND fp.id = rr.from_position_id
         LEFT JOIN hrms_roles fr ON fr.company_id = rr.company_id AND fr.id = fp.role_id
         JOIN hrms_reporting_relationship_types t ON t.company_id = rr.company_id AND t.id = rr.relationship_type_id
        WHERE rr.company_id = ? AND rr.to_position_id IN (${marks(reportTargets)}) AND rr.deleted_at IS NULL AND ${LIVE_ON('rr')}
          AND fp.deleted_at IS NULL AND fp.status <> 'CLOSED'
        ORDER BY fp.position_code, fp.id`,
      // The occupancy sub-select's dates come first — it is earlier in the text.
      [asOf, asOf, companyId, ...reportTargets, asOf, asOf],
    ),
    // The other chairs of this card, each with its shift and whoever is in it.
    siblingIds.length
      ? db.query(
        `SELECT p.id, p.position_code, s.id AS shift_id, s.code AS shift_code, s.name AS shift_name,
                wa.id AS assignment_id, wa.employee_id, wa.effective_from, e.full_name, e.employee_code,
                ${NOTICE_COLUMNS_SQL('x')}
           FROM hrms_positions p
           LEFT JOIN hrms_shifts s ON s.company_id = p.company_id AND s.id = p.default_shift_id
           LEFT JOIN hrms_work_assignments wa ON wa.company_id = p.company_id AND wa.position_id = p.id
                AND ${HOLDS_SEAT_SQL('wa')} AND ${COMING_OR_LIVE_SQL('wa')}
           LEFT JOIN hrms_employees e ON e.company_id = wa.company_id AND e.id = wa.employee_id
           ${NOTICE_JOIN_SQL('wa', 'x')}
          WHERE p.company_id = ? AND p.id IN (${marks(siblingIds)})
          ORDER BY p.position_code, p.id, wa.is_primary DESC, wa.id`,
        [asOf, companyId, ...siblingIds],
      )
      : [[]],
    // The open hirings of the company, for this position and the other chairs of its card: one read.
    openHiringsByPosition(db, companyId),
  ]);

  const { live: occupantRows, joining: joiningByPosition } = splitComing(occupantAndComingRows, asOf);
  // Each other chair once, with whoever is in it today and whoever is due to join it.
  const siblingPeople = splitComing(siblingRows.filter((r) => r.employee_id != null).map((r) => ({ ...r, position_id: r.id })), asOf);
  const siblings = [];
  for (const r of siblingRows) {
    if (siblings.some((x) => x.positionId === r.id)) continue;   // a chair has several rows when it has a joiner, or is wrongly double-filled
    const inIt = siblingPeople.live.find((x) => x.position_id === r.id) ?? null;
    siblings.push({
      positionId: r.id,
      positionCode: r.position_code ?? null,
      shift: r.shift_id ? { id: r.shift_id, code: r.shift_code ?? null, name: r.shift_name ?? null } : null,
      occupant: inIt ? { employeeId: inIt.employee_id, name: inIt.full_name, notice: noticeOf(inIt, asOf) } : null,
      hiring: hiringByPosition.get(r.id) ?? null,
      joining: siblingPeople.joining.get(r.id) ?? null,
    });
  }

  const employeeIds = [...new Set(occupantRows.map((o) => o.employee_id))];
  const attendance = new Map();
  if (employeeIds.length) {
    const [rows] = await db.query(
      `SELECT ar.employee_id, ar.status, ar.shift_id, s.code AS shift_code
         FROM hrms_attendance_records ar
         LEFT JOIN hrms_shifts s ON s.company_id = ar.company_id AND s.id = ar.shift_id
        WHERE ar.company_id = ? AND ar.deleted_at IS NULL AND ar.attendance_date = ?
          AND ar.employee_id IN (${employeeIds.map(() => '?').join(',')})`,
      [companyId, asOf, ...employeeIds],
    );
    for (const r of rows) if (!attendance.has(r.employee_id)) attendance.set(r.employee_id, r);
  }

  // The resolved formal set and the role's content, both through their one owner.
  const [reporting, roleContent, overrides] = await Promise.all([
    resolvePositionReporting(db, companyId, positionId, { on: asOf }),
    position.role_id ? getRoleContent(db, companyId, position.role_id, { on: asOf }) : null,
    listPositionOverrides(db, companyId, positionId),
  ]);

  // seatCount.js is the one definition — see the note at the other call site.
  const shiftPattern = seatShiftPattern(head.shift_code);
  const sanctionedHeadcount = SEATS_PER_POSITION;
  const effectiveSanctioned = SEATS_PER_POSITION;
  const shift = head.shift_id ? { id: head.shift_id, code: head.shift_code ?? null, name: head.shift_name ?? null } : null;

  const occupants = occupantRows.map((o) => {
    const a = attendance.get(o.employee_id) ?? null;
    return {
      employeeId: o.employee_id,
      employeeCode: o.employee_code,
      name: o.full_name,
      employmentStatus: o.employment_status ?? null,
      assignmentId: o.assignment_id,
      assignmentTitle: o.assignment_title ?? o.role_title ?? null,
      roleId: o.role_id,
      roleTitle: o.role_title ?? null,
      allocationPercent: o.allocation_percent == null ? null : Number(o.allocation_percent),
      isPrimary: Boolean(o.is_primary),
      shiftCode: o.shift_code ?? head.shift_code ?? null,
      effectiveFrom: dateText(o.effective_from),
      effectiveTo: dateText(o.effective_to),
      attendanceStatus: a ? a.status : null,
      attendanceShiftCode: a ? a.shift_code ?? null : null,
      notice: noticeOf(o, asOf),
    };
  });

  const flatten = (content) => {
    if (!content) return { kras: [], responsibilities: [], kpis: [], qualifications: [] };
    const kraName = (k) => k.definition?.name ?? null;
    const responsibilities = [
      ...content.kras.flatMap((k) => k.responsibilities.map((r) => ({ ...r, kraId: k.id, kraName: kraName(k) }))),
      ...content.additional.responsibilities.map((r) => ({ ...r, kraId: null, kraName: null })),
    ];
    const kpis = [
      ...content.kras.flatMap((k) => k.kpis.map((r) => ({ ...r, kraId: k.id, kraName: kraName(k) }))),
      ...content.additional.kpis.map((r) => ({ ...r, kraId: null, kraName: null })),
    ];
    return { kras: content.kras, responsibilities, kpis, qualifications: content.qualifications };
  };
  const content = flatten(roleContent);

  /**
   * One content row, said plainly. The modal renders sentences, so `text` is
   * the definition's statement — the full description where there is one,
   * because a responsibility's meaning lives in the sentence and not in the
   * short label above it.
   */
  const contentItem = (r) => ({
    id: r.id,
    definitionId: r.definitionId ?? null,
    code: r.definition?.code ?? null,
    name: r.definition?.name ?? null,
    text: r.definition?.description || r.definition?.name || '',
    kraId: r.kraId ?? null,
    kraText: r.kraName ?? null,
    layer: r.layer ?? 'ROLE',
    weightPercent: r.weightPercent ?? null,
    isMandatory: r.isMandatory ?? null,
    sequence: r.sequence ?? 0,
    effectiveFrom: r.effectiveFrom ?? null,
    effectiveTo: r.effectiveTo ?? null,
  });

  /**
   * Each resolved reporting row, carrying BOTH shapes: everything
   * `reportingResolver` produced (`relationshipType`, `scope`, `manager`,
   * `managerCandidates`, `vacant`, `note`) and flat aliases for the fields a
   * screen reads constantly. Nothing is dropped and nothing is flattened to a
   * single manager — the aliases are extra names for rows that all still travel.
   */
  const reportingRows = reporting.relationships.map((r) => ({
    ...r,
    typeCode: r.relationshipType.code,
    typeName: r.relationshipType.name,
    relationshipTypeId: r.relationshipType.id,
    isFormal: r.relationshipType.isFormal,
    scopeType: r.scope.type,
    scopeLabel: r.scope.label,
    scopeWorkContextId: r.scope.workContextId,
    managerPositionId: r.managerPosition?.id ?? null,
    managerPositionCode: r.managerPosition?.code ?? null,
    managerPositionTitle: r.managerPosition?.title ?? null,
  }));

  const title = head.position_title || head.role_title || `Position ${head.id}`;

  return {
    asOf,
    // ── flat aliases ──────────────────────────────────────────────────────
    // The card is one object about one seat, and the modal reads it field by
    // field. The structured blocks below are the same facts grouped; both are
    // returned so neither end has to reshape the other's idea of a card.
    positionId: head.id,
    positionCode: head.position_code ?? null,
    title,
    status: head.status,
    roleId: head.role_id ?? null,
    roleTitle: head.role_title ?? null,
    rolePurpose: head.role_purpose ?? null,
    roleSummary: head.role_summary ?? null,
    departmentId: head.department_id ?? null,
    departmentName: head.department_name ?? null,
    departmentCode: head.department_code ?? null,
    departmentType: head.department_type ?? null,
    departmentIsShared: Boolean(head.department_is_shared),
    locationId: head.location_id ?? null,
    locationName: head.location_name ?? null,
    // The box this position is drawn in, its own shift, and the other chairs of that box.
    cardId,
    shift,
    siblings,
    sanctionedHeadcount,
    effectiveSanctioned,
    shiftPattern,
    vacancies: seatVacancies(occupants.length),
    overFilled: seatOverFilled(occupants.length),
    // The OPEN hiring on this position, or null.
    hiring: hiringByPosition.get(head.id) ?? null,
    // Who is due to join it from a later date, or null.
    joining: joiningByPosition.get(head.id) ?? null,
    // "Hire a replacement": the person in it is on notice and nobody is lined up yet.
    canHireReplacement: occupants.some((o) => o.notice) && !hiringByPosition.get(head.id) && !joiningByPosition.get(head.id) && head.status !== 'CLOSED',
    kras: content.kras.map(contentItem),
    responsibilities: content.responsibilities.map(contentItem),
    kpis: content.kpis.map(contentItem),
    qualifications: content.qualifications.map(contentItem),
    // ── the same facts, grouped ───────────────────────────────────────────
    position: {
      id: head.id,
      positionCode: head.position_code ?? null,
      title: head.position_title || head.role_title || `Position ${head.id}`,
      status: head.status,
      sanctionedHeadcount,
      effectiveSanctioned,
      shiftPattern,
      cardId,
      defaultShift: shift,
      departmentId: head.department_id ?? null,
      departmentName: head.department_name ?? null,
      locationId: head.location_id ?? null,
      locationName: head.location_name ?? null,
      effectiveFrom: dateText(head.effective_from),
      effectiveTo: dateText(head.effective_to),
      vacancies: seatVacancies(occupants.length),
    },
    role: head.role_id
      ? {
        id: head.role_id,
        roleCode: head.role_code ?? null,
        title: head.role_title ?? null,
        purpose: head.role_purpose ?? null,
        summary: head.role_summary ?? null,
        status: head.role_status ?? null,
      }
      : null,
    // Retired with the chart's: the seat's department says where it works.
    contexts: [],
    occupants,
    // Retired: a chair is the requirement. Always empty.
    requirements: [],
    // THE RESOLVED SET, never one manager. Each row carries its type, its scope
    // sentence, its manager candidates and whether that seat is vacant.
    reporting: reportingRows,
    reportingAsOf: reporting.asOf,
    reportingSummary: reporting.summary,
    managerPositions: parentRows.map((r) => ({
      positionId: r.id, positionCode: r.position_code ?? null, title: r.title ?? null,
      typeCode: r.type_code, typeName: r.type_name,
    })),
    directReports: reportRows.map((r) => ({
      positionId: r.id, positionCode: r.position_code ?? null, title: r.title ?? null,
      typeCode: r.type_code, typeName: r.type_name, occupied: num(r.occupied),
      // Which chair of the card the line names (always this one unless scope=card).
      toPositionId: r.to_position_id,
    })),
    directReportsScope: String(scope ?? '').toLowerCase() === 'card' ? 'card' : 'position',
    content,
    // The position layer on top of the role's content. The three-way resolution
    // itself is contentResolver.js's job (plan §2 rule 6) — these are listed so
    // the card can say "this seat differs", not silently merged here.
    overrides: overrides.items ?? overrides,
    openPoints: openPointRows.map((r) => shapeOpenPoint(r, title)),
    counts: {
      kras: content.kras.length,
      responsibilities: content.responsibilities.length,
      kpis: content.kpis.length,
      qualifications: content.qualifications.length,
      occupants: occupants.length,
      contexts: 0,
      directReports: reportRows.length,
      openPoints: openPointRows.filter((o) => o.status === 'OPEN').length,
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Search
 * ══════════════════════════════════════════════════════════════════════════
 * Free text across the four content kinds, answering with POSITIONS — because
 * "who is responsible for the ink store" is a question about seats, not about
 * definitions. Multi-word AND: every word must appear somewhere in the row's
 * name or description, not necessarily in the same field.
 */
const SEARCH_KINDS = [
  { kind: 'RESPONSIBILITY', table: 'hrms_role_responsibility_assignments', def: 'hrms_responsibility_definitions', fk: 'responsibility_definition_id' },
  { kind: 'KRA', table: 'hrms_role_kra_assignments', def: 'hrms_kra_definitions', fk: 'kra_definition_id' },
  { kind: 'KPI', table: 'hrms_role_kpi_assignments', def: 'hrms_kpi_definitions', fk: 'kpi_definition_id' },
  { kind: 'QUALIFICATION', table: 'hrms_role_qualification_requirements', def: 'hrms_qualification_definitions', fk: 'qualification_definition_id' },
];

/** `%` and `_` are wildcards in LIKE, so a user typing them means them literally. */
const likeTerm = (word) => `%${String(word).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

export async function searchOrgChart(db, companyId, { q, on, limit = 200 } = {}) {
  const asOf = dateText(on) || today();
  const words = String(q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!words.length) throw invalid('INVALID', 'Type something to search for.');

  const cap = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  // Hits are positions, and seven chairs of one card all match the same role
  // line — so each hit says which card it is drawn in and the client can show
  // one box, not seven. Read beside the searches, not after them.
  const cardsPromise = loadCards(db, companyId, asOf);
  const perKind = await Promise.all(SEARCH_KINDS.map(async ({ kind, table, def, fk }) => {
    const wordSql = words.map(() => `CONCAT_WS(' ', d.name, d.description) LIKE ? ESCAPE '\\\\'`).join(' AND ');
    const [rows] = await db.query(
      `SELECT p.id AS position_id, p.position_code,
              COALESCE(p.position_title, r.title) AS title,
              d.id AS definition_id, d.name, d.description
         FROM ${table} a
         JOIN ${def} d ON d.company_id = a.company_id AND d.id = a.${fk} AND d.deleted_at IS NULL
         JOIN hrms_positions p ON p.company_id = a.company_id AND p.role_id = a.role_id
              AND p.deleted_at IS NULL AND p.status <> 'CLOSED' AND ${LIVE_ON('p')}
         LEFT JOIN hrms_roles r ON r.company_id = p.company_id AND r.id = p.role_id
        WHERE a.company_id = ? AND a.deleted_at IS NULL AND ${LIVE_ON('a')}
          AND ${wordSql}
        ORDER BY p.position_code, d.id
        LIMIT 5000`,
      [asOf, asOf, companyId, asOf, asOf, ...words.map(likeTerm)],
    );
    return rows.map((r) => ({ ...r, kind }));
  }));

  const { cardOf } = await cardsPromise;
  const byPosition = new Map();
  for (const r of perKind.flat()) {
    const entry = byPosition.get(r.position_id) ?? {
      positionId: r.position_id,
      cardId: cardOf.get(r.position_id) ?? r.position_id,
      positionCode: r.position_code ?? null,
      title: r.title,
      matches: [],
      matchCount: 0,
    };
    entry.matchCount += 1;
    // The card is one click away and carries the full lists, so a handful of
    // matching lines is enough to tell the user why this box came back.
    if (entry.matches.length < 6) {
      entry.matches.push({
        kind: r.kind,
        definitionId: r.definition_id,
        text: (r.name && String(r.name).trim()) || (r.description ? String(r.description).slice(0, 250) : ''),
      });
    }
    byPosition.set(r.position_id, entry);
  }

  const items = [...byPosition.values()].sort((a, b) => b.matchCount - a.matchCount
    || String(a.positionCode ?? '').localeCompare(String(b.positionCode ?? '')));

  // Spec §9 fixes this as a bare array of hits — the route returns it as it is.
  return items.slice(0, cap);
}

/* ══════════════════════════════════════════════════════════════════════════
 * Open points
 * ══════════════════════════════════════════════════════════════════════════
 * The questions the import could not answer, kept against the thing they are
 * about. Grouped by entity, because "what is unresolved about THIS position"
 * is the question the chart asks, and a flat list of 111 rows answers nobody.
 */
export const OPEN_POINT_STATUSES = ['OPEN', 'RESOLVED', 'DISMISSED'];
const ENTITY_LABEL = {
  ORGANIZATION: 'Organisation',
  ROLE: 'Role',
  POSITION: 'Position',
  WORK_ASSIGNMENT: 'Work assignment',
  WORK_CONTEXT: 'Work context',
};

/**
 * `question` / `answer` sit beside `description` / `resolution`: the columns are
 * named for the table, the aliases are named for what the screen is actually
 * showing a person — an unanswered question about their organisation.
 */
function shapeOpenPoint(r, entityLabel = null) {
  return {
    id: r.id,
    entityType: r.entity_type,
    entityId: r.entity_id ?? null,
    entityLabel,
    positionId: r.entity_type === 'POSITION' ? r.entity_id ?? null : null,
    description: r.description,
    question: r.description,
    status: r.status,
    resolution: r.resolution ?? null,
    answer: r.resolution ?? null,
    resolvedBy: r.resolved_by ?? null,
    resolvedAt: r.resolved_at ?? null,
    createdAt: r.created_at,
    raisedOn: dateText(r.created_at),
  };
}

/** One query per entity kind, only for the kinds actually present. */
async function labelEntities(db, companyId, rows) {
  const needed = new Map();   // entityType -> Set(ids)
  for (const r of rows) {
    if (r.entity_id == null || r.entity_type === 'ORGANIZATION') continue;
    const set = needed.get(r.entity_type) ?? new Set();
    set.add(r.entity_id);
    needed.set(r.entity_type, set);
  }
  const SOURCE = {
    ROLE: ['hrms_roles', 'role_code', 'title'],
    POSITION: ['hrms_positions', 'position_code', 'position_title'],
    WORK_CONTEXT: ['hrms_work_contexts', 'code', 'name'],
  };
  const labels = new Map();   // `${type}:${id}` -> { code, name }
  await Promise.all([...needed].map(async ([type, ids]) => {
    const list = [...ids];
    if (type === 'POSITION') {
      const [rows2] = await db.query(
        `SELECT p.id, p.position_code AS code, COALESCE(p.position_title, r.title) AS name
           FROM hrms_positions p LEFT JOIN hrms_roles r ON r.company_id = p.company_id AND r.id = p.role_id
          WHERE p.company_id = ? AND p.id IN (${list.map(() => '?').join(',')})`,
        [companyId, ...list],
      );
      for (const x of rows2) labels.set(`POSITION:${x.id}`, { code: x.code ?? null, name: x.name ?? null });
      return;
    }
    if (type === 'WORK_ASSIGNMENT') {
      const [rows2] = await db.query(
        `SELECT wa.id, e.employee_code AS code, CONCAT(e.full_name, COALESCE(CONCAT(' — ', r.title), '')) AS name
           FROM hrms_work_assignments wa
           JOIN hrms_employees e ON e.company_id = wa.company_id AND e.id = wa.employee_id
           LEFT JOIN hrms_roles r ON r.company_id = wa.company_id AND r.id = wa.role_id
          WHERE wa.company_id = ? AND wa.id IN (${list.map(() => '?').join(',')})`,
        [companyId, ...list],
      );
      for (const x of rows2) labels.set(`WORK_ASSIGNMENT:${x.id}`, { code: x.code ?? null, name: x.name ?? null });
      return;
    }
    const source = SOURCE[type];
    if (!source) return;
    const [table, codeCol, nameCol] = source;
    const [rows2] = await db.query(
      `SELECT id, ${codeCol} AS code, ${nameCol} AS name FROM ${table}
        WHERE company_id = ? AND id IN (${list.map(() => '?').join(',')})`,
      [companyId, ...list],
    );
    for (const x of rows2) labels.set(`${type}:${x.id}`, { code: x.code ?? null, name: x.name ?? null });
  }));
  return labels;
}

export async function listOpenPoints(db, companyId, query = {}) {
  const where = ['op.company_id = ?', 'op.deleted_at IS NULL'];
  const params = [companyId];

  const status = String(query.status ?? 'OPEN').trim().toUpperCase();
  if (status && status !== 'ALL') {
    const wanted = status.split(',').map((s) => s.trim()).filter((s) => OPEN_POINT_STATUSES.includes(s));
    if (!wanted.length) throw invalid('INVALID', `status must be one of ${OPEN_POINT_STATUSES.join(', ')} or ALL.`);
    where.push(`op.status IN (${wanted.map(() => '?').join(',')})`);
    params.push(...wanted);
  }
  if (query.entityType) {
    const t = String(query.entityType).trim().toUpperCase();
    if (!ENTITY_LABEL[t]) throw invalid('INVALID', `entityType must be one of ${Object.keys(ENTITY_LABEL).join(', ')}.`);
    where.push('op.entity_type = ?');
    params.push(t);
  }
  if (query.entityId) { where.push('op.entity_id = ?'); params.push(Number(query.entityId)); }

  const [rows] = await db.query(
    `SELECT op.* FROM hrms_open_points op WHERE ${where.join(' AND ')}
      ORDER BY FIELD(op.entity_type,'ORGANIZATION','POSITION','ROLE','WORK_ASSIGNMENT','WORK_CONTEXT'), op.entity_id, op.id`,
    params,
  );
  const labels = await labelEntities(db, companyId, rows);

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.entity_type}:${r.entity_id ?? 0}`;
    const label = labels.get(`${r.entity_type}:${r.entity_id}`) ?? null;
    // An organisation-wide point belongs to nothing in particular, and saying so
    // is better than showing an empty heading.
    const entityName = r.entity_type === 'ORGANIZATION' ? 'Whole organisation' : (label?.name ?? null);
    const entityLabel = [label?.code, entityName].filter(Boolean).join(' — ')
      || `${ENTITY_LABEL[r.entity_type] ?? r.entity_type} ${r.entity_id ?? ''}`.trim();
    const group = groups.get(key) ?? {
      key,
      entityType: r.entity_type,
      entityId: r.entity_id ?? null,
      positionId: r.entity_type === 'POSITION' ? r.entity_id ?? null : null,
      entityKind: ENTITY_LABEL[r.entity_type] ?? r.entity_type,
      entityCode: label?.code ?? null,
      entityName,
      entityLabel,
      points: [],
      counts: { open: 0, resolved: 0, dismissed: 0, total: 0 },
    };
    group.points.push(shapeOpenPoint(r, entityLabel));
    group.counts[r.status.toLowerCase()] += 1;
    group.counts.total += 1;
    groups.set(key, group);
  }

  // Grouped by entity, as a bare array: the screen renders one section per
  // entity and nothing above it needs a second envelope.
  return [...groups.values()];
}

/**
 * Resolve, dismiss or reopen one point. A resolution is a SENTENCE, not a
 * checkbox: "what was decided" is the whole value of having recorded the
 * question, so resolving without one is refused.
 */
export async function updateOpenPoint(db, { companyId, userId }, id, body = {}) {
  const [[row]] = await db.query(
    'SELECT * FROM hrms_open_points WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE',
    [companyId, id],
  );
  if (!row) throw notFound('Open point');

  const status = String(body.status ?? '').trim().toUpperCase();
  if (!OPEN_POINT_STATUSES.includes(status)) {
    throw invalid('INVALID', `status must be one of ${OPEN_POINT_STATUSES.join(', ')}.`);
  }
  // `answer` is what the screen calls it; `resolution` is what the column is
  // called. Both are accepted so neither end has to translate.
  const given = body.resolution ?? body.answer;
  const resolution = given == null || String(given).trim() === ''
    ? null
    : String(given).trim().slice(0, 4000);
  if (status === 'RESOLVED' && !resolution) {
    throw invalid('INVALID', 'Say what was decided — a resolved point with no answer is a point that will be asked again.');
  }

  const reopening = status === 'OPEN';
  await db.query(
    `UPDATE hrms_open_points
        SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ?
      WHERE company_id = ? AND id = ?`,
    [
      status,
      reopening ? null : resolution ?? row.resolution,
      reopening ? null : userId,
      reopening ? null : new Date(),
      companyId,
      id,
    ],
  );

  await db.query(
    `INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_by)
     VALUES (?, ?, 'hrms_open_points', ?, 'UPDATE', ?, ?, ?)`,
    [
      companyId, userId, id,
      JSON.stringify({ status: row.status, resolution: row.resolution ?? null }),
      JSON.stringify({ status, resolution: reopening ? null : resolution ?? row.resolution }),
      userId,
    ],
  );

  const [[after]] = await db.query('SELECT * FROM hrms_open_points WHERE company_id = ? AND id = ?', [companyId, id]);
  return shapeOpenPoint(after);
}
