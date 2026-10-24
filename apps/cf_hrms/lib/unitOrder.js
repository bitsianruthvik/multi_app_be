/**
 * unitOrder.js — the ONE order of org units (TM/CF_HRMS_HIRING_SPEC.md §34 "Order").
 *
 * Siblings, and the units at the top level, order by their stored
 * `sort_order`, then by code (numbers inside a code compare as numbers:
 * D2 before D10), then id — NEVER by name. Drag and drop on the Org units page
 * sets `sort_order` (organisationService.reorderDepartments / updateDepartment).
 *
 *   compareUnits(a, b)     siblings' order, on rows as the database has them
 *   orderUnits(rows)       a flat list in tree order (pre-order: a unit, then
 *                          what is under it), for pickers that list every unit
 *   initialSortOrders(rows) what apply-org-unit-extras-schema.mjs writes: for each
 *                          group of siblings that has no order yet, 1..n by code
 *
 * Works on rows with `id`, `code`, `sort_order` and `parent_department_id`
 * (or the camelCase `sortOrder` / `parentId`).
 */

const sortOf = (r) => Number(r.sort_order ?? r.sortOrder ?? 0) || 0;
const parentOf = (r) => r.parent_department_id ?? r.parentId ?? null;

export function compareUnits(a, b) {
  return sortOf(a) - sortOf(b)
    || String(a.code ?? '').localeCompare(String(b.code ?? ''), undefined, { numeric: true, sensitivity: 'base' })
    || Number(a.id) - Number(b.id);
}

/** Code order only (sort_order ignored) — how the units stood before §34, and the order the schema script starts from. */
export function compareByCode(a, b) {
  return String(a.code ?? '').localeCompare(String(b.code ?? ''), undefined, { numeric: true, sensitivity: 'base' })
    || Number(a.id) - Number(b.id);
}

/**
 * Tree order. A unit whose parent is not in `rows` (gone, or outside the
 * list) is treated as top level; a loop that predates the cycle check cannot
 * hang the walk (a unit already placed is never placed again).
 */
export function orderUnits(rows) {
  const ids = new Set(rows.map((r) => r.id));
  const kids = new Map();
  for (const r of rows) {
    const p = parentOf(r);
    const key = p != null && ids.has(p) ? p : 0;
    if (!kids.has(key)) kids.set(key, []);
    kids.get(key).push(r);
  }
  for (const list of kids.values()) list.sort(compareUnits);
  const out = [];
  const seen = new Set();
  const walk = (r) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push(r);
    for (const k of kids.get(r.id) ?? []) walk(k);
  };
  for (const r of kids.get(0) ?? []) walk(r);
  for (const r of [...rows].sort(compareUnits)) if (!seen.has(r.id)) walk(r);
  return out;
}

/**
 * The first order of a company's units: [{ id, sortOrder }] to write.
 *   - a group of siblings where every unit has sort_order 0 (never ordered) -> 1..n by code;
 *   - a group that is ordered but holds a unit at 0 (made by an older backend) -> those go
 *     after the last, by code.
 * Ordered groups are left alone, so a second run writes nothing.
 */
export function initialSortOrders(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = parentOf(r) ?? 0;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const list of groups.values()) {
    const zero = list.filter((r) => sortOf(r) === 0).sort(compareByCode);
    if (!zero.length) continue;
    let next = list.reduce((m, r) => Math.max(m, sortOf(r)), 0);
    for (const r of zero) { next += 1; out.push({ id: r.id, sortOrder: next }); }
  }
  return out;
}

export default { compareUnits, compareByCode, orderUnits, initialSortOrders };
