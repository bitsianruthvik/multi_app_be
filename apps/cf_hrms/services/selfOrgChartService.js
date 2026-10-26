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
 *   - ONE CHAIR PER POSITION (2026-10-10): a team reports to the CARD. The day
 *     and the night in-charge are two positions of one card and each crew
 *     member's line names one of the two chairs, so "below me" starts from
 *     EVERY chair of my card — both in-charges see the whole crew. Those other
 *     chairs of my card travel too (relation `SAME_CARD`): without them the
 *     other shift's crew would arrive with lines pointing at a seat the payload
 *     does not carry. The chain UP still follows my own position's manager only;
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
 * role and location ids, position status, effective dates, edge ids.
 *
 * DEPARTMENTS DO TRAVEL, deliberately (2026-10-10). Machines and shared crews
 * are departments now and the chart cannot be drawn without the tree, so each
 * node carries its `departmentId` and the payload carries `departments` — but
 * only the departments of the slice's own seats, their ancestors, and, for a
 * shared department, the departments it serves (with THEIR ancestors, so every
 * parentId in the payload resolves). A department the employee's branch never
 * touches is not sent: its name, its place in the tree and the fact that it
 * exists stay out. Fields per department are copied by name, like everything
 * else here — id, code, name, parentId, type, isShared, serves, rank.
 * Contact details, identifiers and anything salary-adjacent are not in the
 * read model at all.
 */
import { dateText, today } from './positionService.js';
import { buildOrgChart } from './orgChartService.js';

const PRIMARY = 'PRIMARY_MANAGER';

const EMPLOYEE_ID_BY_USER = `
  SELECT e.id, e.employment_status
    FROM hrms_employees e
   WHERE e.company_id = ? AND e.user_id = ? AND e.deleted_at IS NULL
   LIMIT 1`;

/** One slice node. Names and shifts of the people in the seat, the seat's own words, nothing else. */
function sliceNode(n, myEmployeeId, relation, sameAs = new Map()) {
  return {
    id: n.id,
    // Which box this chair is drawn in. A position id of this company, nothing more.
    cardId: n.cardId ?? n.id,
    positionCode: n.positionCode ?? null,
    title: n.title,
    displayTitle: n.displayTitle,
    roleTitle: n.roleTitle ?? null,
    // Org structure, not personal data. The id points into `departments`.
    departmentId: n.departmentId ?? null,
    departmentName: n.departmentName ?? null,
    departmentCode: n.departmentCode ?? null,
    departmentRank: n.departmentRank ?? null,
    departmentIsRoot: Boolean(n.departmentIsRoot),
    locationName: n.locationName ?? null,
    // Seat design, needed to draw the card's rows (a vacant position is an empty
    // row). One chair: both counts are 1 and requirements is always empty.
    shiftPattern: n.shiftPattern,
    defaultShift: n.defaultShift ? { code: n.defaultShift.code ?? null, name: n.defaultShift.name ?? null } : null,
    sanctionedHeadcount: n.sanctionedHeadcount,
    effectiveSanctioned: n.effectiveSanctioned,
    requirements: (n.requirements ?? []).map((r) => ({
      shiftCode: r.shiftCode ?? null,
      shiftName: r.shiftName ?? null,
      requiredCount: r.requiredCount,
    })),
    // Retired: a machine is the seat's department now. Always empty; kept so a
    // client written before the change still finds an array.
    contexts: [],
    occupants: (n.occupants ?? []).map((o) => ({
      name: o.name,
      shiftCode: o.shiftCode ?? null,
      isMe: o.employeeId === myEmployeeId,
      // One person in two seats of this slice: both rows carry the same key so
      // the chart can join them. An ordinal within this response, never an id;
      // null for everyone who appears once.
      sameAs: sameAs.get(o.employeeId) ?? null,
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
    // §40: where the line comes from (EXPLICIT, or DERIVED from the org unit tree) and whether it leaves the tree.
    origin: e.origin ?? 'EXPLICIT',
    source: e.source ?? null,
    crossTree: Boolean(e.crossTree),
    crossTreeReason: e.crossTreeReason ?? null,
  };
}

/**
 * Pure: the departments an employee's slice may see. Exported for the test
 * script. Start from the departments the slice's seats sit in; add each one's
 * ancestors; for a shared department add what it serves, and those
 * departments' ancestors. Nothing else — and every `parentId` and every id in
 * `serves` that is returned is itself in the result.
 */
export function sliceDepartments(departments, seatDepartmentIds) {
  const byId = new Map((departments ?? []).map((d) => [d.id, d]));
  const keep = new Set();
  const addWithAncestors = (id) => {
    let cur = byId.get(id);
    let guard = 0;
    while (cur && !keep.has(cur.id) && guard < 100) {
      guard += 1;
      keep.add(cur.id);
      cur = cur.parentId != null ? byId.get(cur.parentId) : null;
    }
  };
  for (const id of seatDepartmentIds) if (id != null) addWithAncestors(id);
  for (const id of [...keep]) {
    const d = byId.get(id);
    if (d?.isShared) for (const served of d.serves ?? []) addWithAncestors(served);
  }
  return (departments ?? [])
    .filter((d) => keep.has(d.id))
    .map((d) => ({
      id: d.id,
      code: d.code ?? null,
      name: d.name,
      parentId: d.parentId != null && keep.has(d.parentId) ? d.parentId : null,
      type: d.type ?? null,
      labelId: d.labelId ?? null,
      isShared: Boolean(d.isShared),
      // Only a department that is itself in the slice BECAUSE it is shared lists
      // what it serves; all of those were added above, so none dangles.
      serves: d.isShared ? (d.serves ?? []).filter((id) => keep.has(id)) : [],
      rank: d.rank ?? null,
    }));
}

/**
 * Pure: which seats are in the slice, and why. Exported for the test script.
 * `edges` are the read model's edges; `mine` the seats the caller holds;
 * `cardMates` the other chairs of the caller's card(s) — the walk DOWN starts
 * from them as well, because a team reports to the card.
 */
export function computeSlice(edges, mine, cardMates = []) {
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
  const sameCard = new Set(cardMates.filter((id) => !self.has(id)));
  const managers = walk(mine, up);
  const reports = walk([...mine, ...sameCard], down);
  const dotted = new Set();
  for (const e of edges) {
    if (e.typeCode === PRIMARY) continue;
    if (self.has(e.fromPositionId)) dotted.add(e.toPositionId);
  }
  return { self, managers, reports, dotted, sameCard };
}

/**
 * WHO I AM IN THE CHART, AND WHAT IS AROUND ME — the one computation behind
 * both the employee's chart (myOrgChart, below) and what an employee login may
 * change (services/teamScopeService.js, spec §7). There is no second definition
 * of "below me": both read `relationOf` / `canChange` from here.
 *
 * The employee comes from the session's user id and from nothing else.
 *
 *   relationOf(positionId)  SELF | SAME_CARD | MANAGER | REPORT | DOTTED_MANAGER | null (not in my slice)
 *   canChange(positionId)   true only for REPORT: a position that reports, at any
 *                           depth, to a position of MY CARD. Never my own position,
 *                           never the other chairs of my card, never anybody above
 *                           me (a position that is both above and below me, in a
 *                           loop of bad data, counts as above), never anything else.
 *
 * Not linked to an employee, left the company, or in no position on the date:
 * `linked: false` with the reason, and canChange() is false for everything.
 */
export async function loadMySlice(db, ctx, { on } = {}) {
  const { companyId, userId } = ctx;
  const asOf = dateText(on) || today();
  const none = (reason) => ({ linked: false, reason, asOf, employee: null, relationOf: () => null, canChange: () => false });

  const [[employee]] = await db.query(EMPLOYEE_ID_BY_USER, [companyId, userId]);
  if (!employee) {
    return none('This login is not linked to an employee record, so there is no place in the '
      + 'organisation to show. An HR administrator can link it on the employee\'s record.');
  }

  // The whole read model, in memory only. Nothing from `graph` is returned as is.
  const graph = await buildOrgChart(db, companyId, { on: asOf });
  const mine = graph.nodes
    .filter((n) => (n.occupants ?? []).some((o) => o.employeeId === employee.id))
    .map((n) => n.id);
  if (!mine.length) return none('You are not in a seat on the organisation chart on this date.');

  const myCards = new Set(graph.nodes.filter((n) => mine.includes(n.id)).map((n) => n.cardId));
  const cardMates = graph.nodes.filter((n) => myCards.has(n.cardId) && !mine.includes(n.id)).map((n) => n.id);
  const { self, managers, reports, dotted, sameCard } = computeSlice(graph.edges, mine, cardMates);
  const relationOf = (id) => {
    if (self.has(id)) return 'SELF';
    if (sameCard.has(id)) return 'SAME_CARD';
    if (managers.has(id)) return 'MANAGER';
    if (reports.has(id)) return 'REPORT';
    if (dotted.has(id)) return 'DOTTED_MANAGER';
    return null;
  };
  // Somebody who has left changes nothing, whatever a stale assignment row says.
  const active = employee.employment_status !== 'EXITED';
  const canChange = (id) => active && relationOf(Number(id)) === 'REPORT';
  return { linked: true, reason: null, asOf, employee, graph, mine, self, managers, reports, dotted, sameCard, relationOf, canChange };
}

export async function myOrgChart(db, ctx, { on } = {}) {
  const { companyId, userId } = ctx;
  const asOf = dateText(on) || today();

  const empty = (reason) => ({
    asOf, linked: false, reason, nodes: [], edges: [], departments: [], mySeatIds: [],
    counts: { positions: 0, managers: 0, reports: 0, dotted: 0, sameCard: 0 },
  });

  const slice = await loadMySlice(db, ctx, { on: asOf });
  if (!slice.linked) return empty(slice.reason);
  const { employee, graph, mine, self, managers, reports, dotted, sameCard, relationOf } = slice;
  const keep = new Set([...self, ...sameCard, ...managers, ...reports, ...dotted]);

  const kept = graph.nodes.filter((n) => keep.has(n.id));
  const seatsOf = new Map();
  for (const n of kept) for (const o of n.occupants ?? []) seatsOf.set(o.employeeId, (seatsOf.get(o.employeeId) ?? 0) + 1);
  const sameAs = new Map();
  for (const [employeeId, seats] of seatsOf) if (seats > 1) sameAs.set(employeeId, `s${sameAs.size + 1}`);

  // `canEdit` (spec §7): true only for a position BELOW me — the one test, canChange(), that the
  // /user/me/team routes run again on every write. The screen mirrors it; the server decides.
  const nodes = kept.map((n) => ({ ...sliceNode(n, employee.id, relationOf(n.id), sameAs), canEdit: slice.canChange(n.id) }));
  const edges = graph.edges
    .filter((e) => keep.has(e.fromPositionId) && keep.has(e.toPositionId))
    .map(sliceEdge);

  return {
    asOf: graph.asOf,
    linked: true,
    reason: null,
    nodes,
    edges,
    departments: sliceDepartments(graph.departments, nodes.map((n) => n.departmentId)),
    mySeatIds: mine,
    counts: {
      positions: nodes.length,
      managers: nodes.filter((n) => n.relation === 'MANAGER').length,
      reports: nodes.filter((n) => n.relation === 'REPORT').length,
      dotted: nodes.filter((n) => n.relation === 'DOTTED_MANAGER').length,
      sameCard: nodes.filter((n) => n.relation === 'SAME_CARD').length,
    },
  };
}

export default { myOrgChart, loadMySlice, computeSlice, sliceDepartments };
