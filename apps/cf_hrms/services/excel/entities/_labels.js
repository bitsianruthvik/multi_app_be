/**
 * _labels.js — the label groups in the Excel files (TM/CF_HRMS_HIRING_SPEC.md §15.3).
 *
 *   departments   one column per group other than Kind (a drop-down of that
 *                 group's labels; a required group is starred). Kind's column
 *                 is headed with its own name (departments.js); a file with
 *                 the older header "Label" still reads.
 *   positions,    one INFO column per group: the label their department carries
 *   employees     (the employee's: their main position's department).
 *
 * A department's OWN labels only — never a parent's.
 */
import { readLists, DEPARTMENT_LABELS_SQL, parseLabelList } from '../../labelGroupService.js';

/** The groups, and every live department's label in each: Map(departmentId -> Map(groupId -> name)). Two reads. */
export async function labelState(db, companyId) {
  const [model, [rows]] = await Promise.all([
    readLists(db, companyId),
    db.query(`SELECT d.id, ${DEPARTMENT_LABELS_SQL('d')} AS label_list FROM hrms_departments d WHERE d.company_id = ? AND d.deleted_at IS NULL`, [companyId]),
  ]);
  const ofDepartment = new Map(rows.map((r) => [r.id, new Map(parseLabelList(r.label_list).map((l) => [l.groupId, l.name]))]));
  return { model, ofDepartment };
}

export const groupKey = (g) => `group_${g.id}`;

/** A group's column header: its name, unless that is already a header of the file. */
export function headerOf(g, taken) {
  return taken.has(g.name.trim().toLowerCase()) ? `${g.name} label` : g.name;
}

/** The groups other than Kind, in order. */
export const otherGroups = (model) => model.groups.filter((g) => Number(g.is_kind) !== 1);

/** The Lists sheet: one list per group, entries carry the label id. */
export function groupLists(model) {
  const out = {};
  for (const g of otherGroups(model)) {
    out[groupKey(g)] = { label: `${g.name} labels`, entries: model.labelsOf(g.id).map((l) => ({ text: l.name, key: l.name, id: l.id })) };
  }
  return out;
}

/** One column per group. `info` -> read-only context; otherwise a drop-down. */
export function groupColumns(model, fixedHeaders, { info = false, kind = false } = {}) {
  const taken = new Set(fixedHeaders.map((h) => h.toLowerCase()));
  const groups = kind ? model.groups : otherGroups(model);
  return groups.map((g) => {
    const header = headerOf(g, taken);
    taken.add(header.toLowerCase());
    const required = Number(g.is_required) === 1;
    return info
      ? { key: groupKey(g), header, kind: 'info', width: 16, meaning: `The ${g.name} label of its department.`, example: model.labelsOf(g.id)[0]?.name ?? '' }
      : {
        key: groupKey(g), header, kind: 'list', list: groupKey(g), required, width: 18,
        meaning: `The department’s ${g.name} label${required ? '' : ' (may be left blank)'}.`, example: model.labelsOf(g.id)[0]?.name ?? '',
      };
  });
}

/** The cells of a department's group columns. */
export function groupCells(model, ofDepartment, departmentId, { kind = false } = {}) {
  const mine = ofDepartment.get(Number(departmentId)) ?? new Map();
  const groups = kind ? model.groups : otherGroups(model);
  return Object.fromEntries(groups.map((g) => [groupKey(g), departmentId == null ? null : (mine.get(g.id) ?? null)]));
}

export default { labelState, groupKey, headerOf, otherGroups, groupLists, groupColumns, groupCells };
