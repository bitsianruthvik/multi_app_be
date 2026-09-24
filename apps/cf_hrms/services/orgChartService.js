/**
 * orgChartService.js — the org chart READ MODEL. (Plan §7; spec
 * `CF_HRMS_ORG_CHART_SPEC.md` §1, §2, §9.)
 *
 * ── WHAT THE CHART IS ─────────────────────────────────────────────────────
 * Nodes are POSITIONS. Edges are `hrms_position_reporting_relationships` live
 * on the view date — ALL of them, typed and scoped. Occupants are the work
 * assignments filling each seat. Work contexts are CHIPS on a node and never
 * nodes of their own: a machine is not a manager (plan §2 rule 3), and the
 * import already re-pointed every machine-parented position at its nearest
 * human ancestor (spec §6), so nothing is skipped at render time.
 *
 * ── THE SERVER NEVER PICKS "THE" MANAGER ──────────────────────────────────
 * Every live edge travels in the payload with its type and its scope. The
 * client chooses `PRIMARY_MANAGER` to lay out a tree and draws the rest as
 * secondary links. Flattening reporting to one manager here would be the exact
 * mistake plan §2 rule 9 exists to prevent, and `reportingResolver.js` stays
 * the only implementation of "who does this person answer to".
 *
 * ── TWO DERIVED NUMBERS THAT ARE EASY TO GET WRONG ────────────────────────
 * `shiftPattern` is NOT stored. It is `DN` when the position has live
 * `hrms_manpower_requirements` for both a day and a night shift; otherwise the
 * `default_shift_id`'s code; `G` when there is none. That is how the import
 * recorded day/night working (plan §9.1) — a DN position keeps
 * `sanctioned_headcount` meaning ONE SEAT and carries a requirement row per
 * shift instead.
 *
 * `vacancies` therefore follows the same fork: a DN position's sanctioned
 * strength is `Σ(requiredCount)` across its live requirement rows, everything
 * else is `sanctioned_headcount`. Reading `sanctioned_headcount` for a DN
 * position silently HALVES the vacancies — across Karni it is the difference
 * between the true 156 and a wrong 101.
 *
 * ── ONE PAYLOAD, A HANDFUL OF QUERIES ─────────────────────────────────────
 * Karni is 114 positions, max depth 8. The whole graph travels in one response
 * with no pagination, and it is assembled from a fixed number of company-wide
 * queries (positions, edges, occupants, contexts, requirements, content counts,
 * open points, attendance) joined in memory. Nothing in here runs per node.
 */
import { notFound, invalid } from '../lib/errors.js';
import { dateText, today, LIVE_ON, requirePosition, listPositionOverrides } from './positionService.js';
import { effectiveSeats, shiftPattern as seatShiftPattern } from './seatCount.js';
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
const POSITIONS_SQL = `
  SELECT p.id, p.position_code, p.position_title, p.role_id, p.department_id, p.location_id,
         p.sanctioned_headcount, p.default_shift_id, p.status, p.effective_from, p.effective_to,
         r.title AS role_title, r.role_code,
         d.name AS department_name, l.name AS location_name,
         s.code AS shift_code, s.name AS shift_name
    FROM hrms_positions p
    LEFT JOIN hrms_roles       r ON r.company_id = p.company_id AND r.id = p.role_id
    LEFT JOIN hrms_departments d ON d.company_id = p.company_id AND d.id = p.department_id
    LEFT JOIN hrms_locations   l ON l.company_id = p.company_id AND l.id = p.location_id
    LEFT JOIN hrms_shifts      s ON s.company_id = p.company_id AND s.id = p.default_shift_id
   WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status <> 'CLOSED'
     AND ${LIVE_ON('p')}
   ORDER BY p.position_code, p.id`;

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

/** Who is actually in the seats. An employee with three assignments appears in three boxes — correct. */
const OCCUPANTS_SQL = `
  SELECT wa.id AS assignment_id, wa.position_id, wa.employee_id, wa.assignment_title,
         wa.allocation_percent, wa.is_primary, wa.role_id, wa.default_shift_id,
         wa.effective_from, wa.effective_to,
         e.employee_code, e.full_name, e.employment_status,
         s.code AS shift_code, s.name AS shift_name,
         r.title AS role_title
    FROM hrms_work_assignments wa
    JOIN hrms_employees e ON e.company_id = wa.company_id AND e.id = wa.employee_id
    LEFT JOIN hrms_shifts s ON s.company_id = wa.company_id AND s.id = wa.default_shift_id
    LEFT JOIN hrms_roles  r ON r.company_id = wa.company_id AND r.id = wa.role_id
   WHERE wa.company_id = ? AND wa.deleted_at IS NULL AND wa.status = 'ACTIVE'
     AND wa.position_id IS NOT NULL AND ${LIVE_ON('wa')}
   ORDER BY wa.is_primary DESC, e.full_name`;

/** The chips. One Helper covering four machines is ONE position with four rows here. */
const CONTEXTS_SQL = `
  SELECT c.position_id, c.is_primary, c.effective_from, c.effective_to,
         wc.id AS context_id, wc.code AS context_code, wc.name AS context_name, wc.context_type
    FROM hrms_position_work_contexts c
    JOIN hrms_work_contexts wc ON wc.company_id = c.company_id AND wc.id = c.work_context_id
   WHERE c.company_id = ? AND c.deleted_at IS NULL AND ${LIVE_ON('c')}
   ORDER BY c.is_primary DESC, wc.name`;

/** Day/night working, as the import recorded it (plan §9.1). The source of `shiftPattern` and of a DN position's strength. */
const REQUIREMENTS_SQL = `
  SELECT m.position_id, m.shift_id, m.required_count, m.work_context_id,
         s.code AS shift_code, s.name AS shift_name
    FROM hrms_manpower_requirements m
    LEFT JOIN hrms_shifts s ON s.company_id = m.company_id AND s.id = m.shift_id
   WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.position_id IS NOT NULL
     AND ${LIVE_ON('m')}
   ORDER BY s.code, m.id`;

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
 * machine they cover. So when the parent does not separate them, the primary
 * work context is appended after it, and a position code is the last resort.
 * A title used once is never decorated.
 */
function buildDisplayTitles(positions, primaryParentTitleById, primaryContextNameById) {
  const byTitle = new Map();
  for (const p of positions) {
    const list = byTitle.get(p.title) ?? [];
    list.push(p);
    byTitle.set(p.title, list);
  }

  const display = new Map();
  for (const [title, group] of byTitle) {
    if (group.length < 2) {
      for (const p of group) display.set(p.id, title);
      continue;
    }
    // Try qualifiers in order of how much they say, keeping the spec's form first.
    const candidates = [
      (p) => primaryParentTitleById.get(p.id) ?? null,
      (p) => primaryContextNameById.get(p.id) ?? null,
      (p) => {
        const parent = primaryParentTitleById.get(p.id);
        const context = primaryContextNameById.get(p.id);
        return parent && context ? `${parent} · ${context}` : parent ?? context ?? null;
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
    for (const p of group) display.set(p.id, `${title} (${make(p)})`);
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
    [positionRows], [edgeRows], [occupantRows], [contextRows],
    [requirementRows], [contentRows], [overrideRows], [openPointRows],
  ] = await Promise.all([
    db.query(POSITIONS_SQL, [companyId, asOf, asOf]),
    db.query(EDGES_SQL, [companyId, asOf, asOf]),
    db.query(OCCUPANTS_SQL, [companyId, asOf, asOf]),
    db.query(CONTEXTS_SQL, [companyId, asOf, asOf]),
    db.query(REQUIREMENTS_SQL, [companyId, asOf, asOf]),
    db.query(CONTENT_COUNTS_SQL, [companyId, asOf, asOf, companyId, asOf, asOf, companyId, asOf, asOf, companyId, asOf, asOf]),
    db.query(OVERRIDE_COUNTS_SQL, [companyId, asOf, asOf]),
    db.query(OPEN_POINT_COUNTS_SQL, [companyId]),
  ]);

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
  const contextsByPosition = group(contextRows, 'position_id');
  const requirementsByPosition = group(requirementRows, 'position_id');

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
  const primaryContextName = new Map();
  for (const [positionId, rows] of contextsByPosition) {
    const primary = rows.find((r) => r.is_primary) ?? rows[0];
    if (primary) primaryContextName.set(positionId, primary.context_name);
  }

  /* ── assemble the nodes ────────────────────────────────────────────────── */
  const allNodes = positionRows.map((p) => {
    const requirements = (requirementsByPosition.get(p.id) ?? []).map((r) => ({
      shiftId: r.shift_id ?? null,
      shiftCode: r.shift_code ?? null,
      shiftName: r.shift_name ?? null,
      workContextId: r.work_context_id ?? null,
      requiredCount: num(r.required_count),
    }));
    // Both derived, never stored, and both come from services/seatCount.js —
    // the ONE implementation. This arithmetic used to be written out here, again
    // in positionService and a third time in routes/overview.js, and the copies
    // drifted: the chart said 156 vacant while the Positions screen said 101.
    const shiftPattern = seatShiftPattern(p.shift_code, requirements);
    const sanctionedHeadcount = num(p.sanctioned_headcount);
    const effectiveSanctioned = effectiveSeats(sanctionedHeadcount, requirements);

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

    const contexts = (contextsByPosition.get(p.id) ?? []).map((c) => ({
      id: c.context_id,
      code: c.context_code ?? null,
      name: c.context_name,
      contextType: c.context_type,
      isPrimary: Boolean(c.is_primary),
    }));

    return {
      id: p.id,
      positionCode: p.position_code ?? null,
      title: baseTitleOf.get(p.id),
      displayTitle: baseTitleOf.get(p.id),          // replaced below once duplicates are known
      roleId: p.role_id,
      roleCode: p.role_code ?? null,
      roleTitle: p.role_title ?? null,
      departmentId: p.department_id ?? null,
      departmentName: p.department_name ?? null,
      locationId: p.location_id ?? null,
      locationName: p.location_name ?? null,
      status: p.status,
      sanctionedHeadcount,
      // What the box actually has to fill on this date — `sanctionedHeadcount`
      // for a single-shift seat, Σ(requiredCount) for a DN one.
      effectiveSanctioned,
      shiftPattern,
      defaultShift: p.default_shift_id
        ? { id: p.default_shift_id, code: p.shift_code ?? null, name: p.shift_name ?? null }
        : null,
      contexts,
      occupants,
      requirements,
      vacancies: Math.max(0, effectiveSanctioned - occupants.length),
      overFilled: occupants.length > effectiveSanctioned,
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
  let sanctioned = 0;
  let filled = 0;
  let vacant = 0;
  let present = 0;
  let absent = 0;
  const byShiftPattern = { G: 0, D: 0, N: 0, DN: 0 };
  for (const n of nodes) {
    sanctioned += n.effectiveSanctioned;
    filled += n.occupants.length;
    vacant += n.vacancies;
    byShiftPattern[n.shiftPattern] = (byShiftPattern[n.shiftPattern] ?? 0) + 1;
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
    counts: {
      positions: nodes.length,
      sanctioned,
      filled,
      vacant,
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
 * the one implementation — so a vacant manager seat, several people in one seat
 * and a scoped dotted line all arrive already explained.
 */
export async function getPositionCard(db, companyId, positionId, { on } = {}) {
  const asOf = dateText(on) || today();
  const position = await requirePosition(db, companyId, positionId);

  const [
    [[head]], [contextRows], [occupantRows], [requirementRows], [openPointRows], [parentRows], [reportRows],
  ] = await Promise.all([
    db.query(
      `SELECT p.id, p.position_code, p.position_title, p.role_id, p.sanctioned_headcount, p.status,
              p.effective_from, p.effective_to,
              r.title AS role_title, r.role_code, r.role_purpose, r.role_summary, r.status AS role_status,
              d.id AS department_id, d.name AS department_name,
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
    db.query(`${CONTEXTS_SQL.replace('WHERE c.company_id = ?', 'WHERE c.company_id = ? AND c.position_id = ?')}`, [companyId, positionId, asOf, asOf]),
    db.query(`${OCCUPANTS_SQL.replace('WHERE wa.company_id = ?', 'WHERE wa.company_id = ? AND wa.position_id = ?')}`, [companyId, positionId, asOf, asOf]),
    db.query(`${REQUIREMENTS_SQL.replace('WHERE m.company_id = ?', 'WHERE m.company_id = ? AND m.position_id = ?')}`, [companyId, positionId, asOf, asOf]),
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
      `SELECT rr.from_position_id AS id, fp.position_code, COALESCE(fp.position_title, fr.title) AS title,
              t.code AS type_code, t.name AS type_name,
              (SELECT COUNT(*) FROM hrms_work_assignments wa
                WHERE wa.company_id = rr.company_id AND wa.position_id = fp.id AND wa.deleted_at IS NULL
                  AND wa.status = 'ACTIVE' AND ${LIVE_ON('wa')}) AS occupied
         FROM hrms_position_reporting_relationships rr
         JOIN hrms_positions fp ON fp.company_id = rr.company_id AND fp.id = rr.from_position_id
         LEFT JOIN hrms_roles fr ON fr.company_id = rr.company_id AND fr.id = fp.role_id
         JOIN hrms_reporting_relationship_types t ON t.company_id = rr.company_id AND t.id = rr.relationship_type_id
        WHERE rr.company_id = ? AND rr.to_position_id = ? AND rr.deleted_at IS NULL AND ${LIVE_ON('rr')}
          AND fp.deleted_at IS NULL AND fp.status <> 'CLOSED'
        ORDER BY fp.position_code, fp.id`,
      // The occupancy sub-select's dates come first — it is earlier in the text.
      [asOf, asOf, companyId, positionId, asOf, asOf],
    ),
  ]);

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

  const requirements = requirementRows.map((r) => ({
    shiftId: r.shift_id ?? null,
    shiftCode: r.shift_code ?? null,
    shiftName: r.shift_name ?? null,
    requiredCount: num(r.required_count),
  }));
  // seatCount.js is the one definition — see the note at the other call site.
  const shiftPattern = seatShiftPattern(head.shift_code, requirements);
  const sanctionedHeadcount = num(head.sanctioned_headcount);
  const effectiveSanctioned = shiftPattern === 'DN'
    ? requirements.reduce((t, r) => t + r.requiredCount, 0)
    : sanctionedHeadcount;

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
    locationId: head.location_id ?? null,
    locationName: head.location_name ?? null,
    sanctionedHeadcount,
    effectiveSanctioned,
    shiftPattern,
    vacancies: Math.max(0, effectiveSanctioned - occupants.length),
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
      defaultShift: head.shift_id ? { id: head.shift_id, code: head.shift_code, name: head.shift_name } : null,
      departmentId: head.department_id ?? null,
      departmentName: head.department_name ?? null,
      locationId: head.location_id ?? null,
      locationName: head.location_name ?? null,
      effectiveFrom: dateText(head.effective_from),
      effectiveTo: dateText(head.effective_to),
      vacancies: Math.max(0, effectiveSanctioned - occupants.length),
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
    contexts: contextRows.map((c) => ({
      id: c.context_id,
      code: c.context_code ?? null,
      name: c.context_name,
      contextType: c.context_type,
      isPrimary: Boolean(c.is_primary),
    })),
    occupants,
    requirements,
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
    })),
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
      contexts: contextRows.length,
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

  const byPosition = new Map();
  for (const r of perKind.flat()) {
    const entry = byPosition.get(r.position_id) ?? {
      positionId: r.position_id,
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
