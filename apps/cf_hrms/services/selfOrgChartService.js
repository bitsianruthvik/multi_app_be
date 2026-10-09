/**
 * selfOrgChartService.js — "my slice of the org chart", for the signed-in
 * person and for nobody else. Served by `GET /user/me/orgchart` (routes/self.js).
 *
 * ── WHAT THE SLICE IS (the user's decision, 2026-10-09) ───────────────────
 *   - every seat ABOVE each seat I hold, following PRIMARY_MANAGER edges up to
 *     the top of the organisation;
 *   - the seats I hold;
 *   - every seat BELOW each seat I hold (all PRIMARY_MANAGER descendants — a
 *     manager of managers sees the whole branch);
 *   - the seats my own seats report to on a NON-primary line (dotted,
 *     functional, …) — the seat alone, never that manager's chain or branch.
 * Peers in other branches are not in it. Edges travel only when BOTH ends are
 * in the slice, so no edge can name a seat the payload does not carry.
 *
 * ── THE SECURITY BOUNDARY ─────────────────────────────────────────────────
 * Same as selfService: the employee comes from `req.user.id` →
 * `hrms_employees.user_id`. No function here takes an employee, assignment or
 * position id from a caller. The slice is computed from the full read model
 * (`buildOrgChart`, untouched) IN MEMORY, and only the slice is returned.
 *
 * ── A WHITELIST, NOT A BLACKLIST ──────────────────────────────────────────
 * Every field below is copied by name into a fresh object. Anything the read
 * model adds later does not leak here by default. Deliberately NOT sent:
 * employee ids and codes, assignment ids, allocation percentages, employment
 * status, attendance marks, content counts (KRAs/KPIs/…), open-point counts,
 * role/department/location ids (the department CODE, tree rank and is-root flag travel,
 * for the process grouping — spec §15), position status, effective dates, edge ids.
 * Contact details, identifiers and anything salary-adjacent are not in the
 * read model at all.
 */
import { dateText, today } from './positionService.js';
import { buildOrgChart } from './orgChartService.js';

const PRIMARY = 'PRIMARY_MANAGER';

const EMPLOYEE_ID_BY_USER = `
  SELECT e.id
    FROM hrms_employees e
   WHERE e.company_id = ? AND e.user_id = ? AND e.deleted_at IS NULL
   LIMIT 1`;

/** One slice node. Names and shifts of the people in the seat, the seat's own words, nothing else. */
function sliceNode(n, myEmployeeId, relation) {
  return {
    id: n.id,
    positionCode: n.positionCode ?? null,
    title: n.title,
    displayTitle: n.displayTitle,
    roleTitle: n.roleTitle ?? null,
    departmentName: n.departmentName ?? null,
    // Org structure, not personal data: the chart groups a team by work process
    // and needs the unit's code (= the code of the seat heading it) and its
    // place in the unit tree (spec §15).
    departmentCode: n.departmentCode ?? null,
    departmentRank: n.departmentRank ?? null,
    departmentIsRoot: Boolean(n.departmentIsRoot),
    locationName: n.locationName ?? null,
    // Seat design, needed to draw the box's rows (a vacancy is an empty row).
    shiftPattern: n.shiftPattern,
    defaultShift: n.defaultShift ? { code: n.defaultShift.code ?? null, name: n.defaultShift.name ?? null } : null,
    sanctionedHeadcount: n.sanctionedHeadcount,
    effectiveSanctioned: n.effectiveSanctioned,
    requirements: (n.requirements ?? []).map((r) => ({
      shiftCode: r.shiftCode ?? null,
      shiftName: r.shiftName ?? null,
      requiredCount: r.requiredCount,
    })),
    // Where the work happens — a machine or area name, never a person.
    contexts: (n.contexts ?? []).map((c) => ({
      name: c.name,
      contextType: c.contextType ?? null,
      isPrimary: Boolean(c.isPrimary),
    })),
    occupants: (n.occupants ?? []).map((o) => ({
      name: o.name,
      shiftCode: o.shiftCode ?? null,
      isMe: o.employeeId === myEmployeeId,
    })),
    relation,
  };
}

function sliceEdge(e) {
  return {
    fromPositionId: e.fromPositionId,
    toPositionId: e.toPositionId,
    typeCode: e.typeCode,
    typeName: e.typeName,
    isFormal: e.isFormal,
    isPrimary: e.isPrimary,
    scopeType: e.scopeType,
    scopeLabel: e.scopeLabel ?? null,
    scopeWorkContextName: e.scopeWorkContextName ?? null,
    scopeSentence: e.scopeSentence ?? null,
  };
}

/**
 * Pure: which seats are in the slice, and why. Exported for the test script.
 * `edges` are the read model's edges; `mine` the seats the caller holds.
 */
export function computeSlice(edges, mine) {
  const up = new Map();      // child -> [managers] (primary)
  const down = new Map();    // manager -> [children] (primary)
  for (const e of edges) {
    if (e.typeCode !== PRIMARY) continue;
    if (!up.has(e.fromPositionId)) up.set(e.fromPositionId, []);
    up.get(e.fromPositionId).push(e.toPositionId);
    if (!down.has(e.toPositionId)) down.set(e.toPositionId, []);
    down.get(e.toPositionId).push(e.fromPositionId);
  }
  const walk = (start, next) => {
    const seen = new Set();
    const queue = [...start];
    let guard = 0;
    while (queue.length && guard < 100000) {
      guard += 1;
      const id = queue.shift();
      for (const k of next.get(id) ?? []) {
        if (seen.has(k)) continue;
        seen.add(k);
        queue.push(k);
      }
    }
    return seen;
  };
  const self = new Set(mine);
  const managers = walk(mine, up);
  const reports = walk(mine, down);
  const dotted = new Set();
  for (const e of edges) {
    if (e.typeCode === PRIMARY) continue;
    if (self.has(e.fromPositionId)) dotted.add(e.toPositionId);
  }
  return { self, managers, reports, dotted };
}

export async function myOrgChart(db, ctx, { on } = {}) {
  const { companyId, userId } = ctx;
  const asOf = dateText(on) || today();

  const empty = (reason) => ({
    asOf, linked: false, reason, nodes: [], edges: [], mySeatIds: [],
    counts: { positions: 0, managers: 0, reports: 0, dotted: 0 },
  });

  const [[employee]] = await db.query(EMPLOYEE_ID_BY_USER, [companyId, userId]);
  if (!employee) {
    return empty('This login is not linked to an employee record, so there is no place in the '
      + 'organisation to show. An HR administrator can link it on the employee\'s record.');
  }

  // The whole read model, in memory only. Nothing from `graph` is returned as is.
  const graph = await buildOrgChart(db, companyId, { on: asOf });
  const mine = graph.nodes
    .filter((n) => (n.occupants ?? []).some((o) => o.employeeId === employee.id))
    .map((n) => n.id);
  if (!mine.length) {
    return empty('You are not in a seat on the organisation chart on this date.');
  }

  const { self, managers, reports, dotted } = computeSlice(graph.edges, mine);
  const relationOf = (id) => {
    if (self.has(id)) return 'SELF';
    if (managers.has(id)) return 'MANAGER';
    if (reports.has(id)) return 'REPORT';
    return 'DOTTED_MANAGER';
  };
  const keep = new Set([...self, ...managers, ...reports, ...dotted]);

  const nodes = graph.nodes
    .filter((n) => keep.has(n.id))
    .map((n) => sliceNode(n, employee.id, relationOf(n.id)));
  const edges = graph.edges
    .filter((e) => keep.has(e.fromPositionId) && keep.has(e.toPositionId))
    .map(sliceEdge);

  return {
    asOf: graph.asOf,
    linked: true,
    reason: null,
    nodes,
    edges,
    mySeatIds: mine,
    counts: {
      positions: nodes.length,
      managers: nodes.filter((n) => n.relation === 'MANAGER').length,
      reports: nodes.filter((n) => n.relation === 'REPORT').length,
      dotted: nodes.filter((n) => n.relation === 'DOTTED_MANAGER').length,
    },
  };
}

export default { myOrgChart, computeSlice };
