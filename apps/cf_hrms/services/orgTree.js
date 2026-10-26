/**
 * orgTree.js — THE one tree builder (TM/CF_HRMS_HIRING_SPEC.md §40.1).
 *
 * Org units → roles → positions, in one order, for BOTH the Org units list
 * (organisationService.listDepartments) and the org chart's data
 * (orgChartService.buildOrgChart). Before §40 each built its own tree: the list
 * with a pre-order walk of its own, the chart with a rank walk of its own. Two
 * walks over the same rows can disagree the day one of them changes; now there
 * is one.
 *
 * ORDER. Siblings (and the top level) by lib/unitOrder.js — stored sort_order,
 * then code (numbers as numbers), then id; never by name. Roles inside a unit by
 * role code then title; positions inside a role by position code then id.
 *
 * ROBUST. A unit whose parent is missing or soft-deleted is a top unit with
 * `orphaned` set (shown, so it can be fixed, rather than hidden). A loop in old
 * data cannot hang the walk: a unit already placed is never placed again, and
 * whatever only a loop reaches comes last, flat, with `inCycle` set.
 *
 *   buildOrgTree({ units, positions? })
 *     units:     rows with id, name, code, sort_order, parent_department_id (raw DB rows)
 *     positions: optional [{ id, departmentId, roleId, roleTitle, roleCode, code }]
 *   -> {
 *        units: [{ row, id, depth, childCount, path, orphaned, inCycle, rank }]   pre-order
 *        rank:  Map(unitId -> 0..n-1)                                              the pre-order index
 *        byId:  Map(unitId -> entry)
 *        roles: Map(unitId -> [{ roleId, roleTitle, roleCode, positionIds: [id] }]) (positions given)
 *        unplaced: [{ roleId, roleTitle, roleCode, positionIds }]                    positions in no unit
 *      }
 */
import { compareUnits } from '../lib/unitOrder.js';

const byText = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' });

export function buildOrgTree({ units = [], positions = null } = {}) {
  const ids = new Set(units.map((u) => u.id));
  const kids = new Map();
  for (const u of units) {
    const p = u.parent_department_id;
    const key = p != null && ids.has(p) ? p : 0;
    if (!kids.has(key)) kids.set(key, []);
    kids.get(key).push(u);
  }
  for (const list of kids.values()) list.sort(compareUnits);

  const out = [];
  const seen = new Set();
  const walk = (u, depth, path) => {
    if (seen.has(u.id)) return;
    seen.add(u.id);
    const children = kids.get(u.id) ?? [];
    const here = [...path, u.name];
    out.push({
      row: u,
      id: u.id,
      depth,
      childCount: children.length,
      path: here.join(' › '),
      orphaned: u.parent_department_id != null && !ids.has(u.parent_department_id),
      inCycle: false,
      rank: out.length,
    });
    for (const k of children) walk(k, depth + 1, here);
  };
  for (const u of kids.get(0) ?? []) walk(u, 0, []);
  for (const u of [...units].sort(compareUnits)) {
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    out.push({ row: u, id: u.id, depth: 0, childCount: 0, path: u.name, orphaned: true, inCycle: true, rank: out.length });
  }

  const rank = new Map(out.map((e) => [e.id, e.rank]));
  const byId = new Map(out.map((e) => [e.id, e]));

  let roles = null;
  let unplaced = null;
  if (Array.isArray(positions)) {
    roles = new Map();
    unplaced = [];
    const groups = new Map();
    for (const p of positions) {
      const unitKey = p.departmentId != null && ids.has(p.departmentId) ? p.departmentId : 0;
      const k = `${unitKey}|${p.roleId ?? 0}`;
      if (!groups.has(k)) groups.set(k, { unitKey, roleId: p.roleId ?? null, roleTitle: p.roleTitle ?? null, roleCode: p.roleCode ?? null, positions: [] });
      groups.get(k).positions.push(p);
    }
    for (const g of groups.values()) {
      g.positions.sort((a, b) => byText(a.code, b.code) || a.id - b.id);
      const entry = { roleId: g.roleId, roleTitle: g.roleTitle, roleCode: g.roleCode, positionIds: g.positions.map((p) => p.id) };
      if (g.unitKey === 0) unplaced.push(entry);
      else {
        if (!roles.has(g.unitKey)) roles.set(g.unitKey, []);
        roles.get(g.unitKey).push(entry);
      }
    }
    const roleOrder = (a, b) => byText(a.roleCode, b.roleCode) || byText(a.roleTitle, b.roleTitle) || (a.roleId ?? 0) - (b.roleId ?? 0);
    for (const list of roles.values()) list.sort(roleOrder);
    unplaced.sort(roleOrder);
  }

  return { units: out, rank, byId, roles, unplaced };
}

/** The pre-order position of every position: units in tree order, then roles, then positions. */
export function positionOrder(tree) {
  const order = new Map();
  if (!tree.roles) return order;
  for (const u of tree.units) for (const r of tree.roles.get(u.id) ?? []) for (const id of r.positionIds) order.set(id, order.size);
  for (const r of tree.unplaced ?? []) for (const id of r.positionIds) order.set(id, order.size);
  return order;
}

export default { buildOrgTree, positionOrder };
