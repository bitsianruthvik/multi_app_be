/**
 * _labels.js — the department label in the Excel files (one label per
 * department; the per-group columns of spec §15.3 were removed on 2026-10-16).
 *
 *   departments   the "Label" column, a drop-down of the company's labels
 *                 (departments.js; a file with the header "Kind" still reads).
 *   positions,    one INFO column "Label": the label their department carries
 *   employees     (the employee's: their main position's department).
 *
 * A department's OWN label only — never a parent's.
 */
import { readLists } from '../../labelGroupService.js';

/** The labels, and every live department's label row: Map(departmentId -> label | null). Two reads. */
export async function labelState(db, companyId) {
  const [model, [rows]] = await Promise.all([
    readLists(db, companyId),
    db.query('SELECT id, department_type FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
  ]);
  const byName = new Map(model.labels.map((l) => [l.name.toLowerCase(), l]));
  const ofDepartment = new Map(rows.map((r) => [r.id, byName.get(String(r.department_type ?? '').toLowerCase()) ?? null]));
  return { model, ofDepartment };
}

const INFO_KEY = 'departmentLabel';

/** The info column "Label" (positions, employees). Ignored on upload. */
export function labelInfoColumn(model) {
  return { key: INFO_KEY, header: 'Org unit kind', aliases: ['Label'], kind: 'info', width: 16, meaning: 'The kind of its org unit (Department, Section, Machine …).', example: model.labels[0]?.name ?? '' };
}

/** The info column's cell for a department. */
export function labelInfoCell(ofDepartment, departmentId) {
  return { [INFO_KEY]: departmentId == null ? null : (ofDepartment.get(Number(departmentId))?.name ?? null) };
}

export default { labelState, labelInfoColumn, labelInfoCell };
