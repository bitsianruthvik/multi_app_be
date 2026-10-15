/**
 * records.js — the company's own records, as the command reader matches names
 * against them: departments, labels, roles (with their KRAs), positions,
 * employees and shifts. One read of each, a handful of queries in parallel.
 *
 * People are limited to the login's scope: a department-scoped login is never
 * offered a person outside its departments as a candidate (the same rule as the
 * people list, services/accessScope.js). The structure is company-wide, as the
 * chart is.
 *
 * MATCHING A NAME (`findRecord`): exact name or code, then case-insensitive,
 * then word by word with typos allowed (text.js nameScore). Two records within a
 * hair of each other are both kept as candidates — the person picks.
 */
import { LIVE_ON, today } from '../positionService.js';
import { HOLDS_SEAT_SQL } from '../seatCount.js';
import { norm, nameScore } from './text.js';

const SURE = 0.9;      // at or above: taken as found
const FLOOR = 0.62;    // below: not a match at all
const TIE = 0.04;      // within this of the best: a candidate too

export async function loadRecords(db, companyId, { scope = { all: true }, on } = {}) {
  const asOf = on || today();
  const q = (sql, params = [companyId]) => db.query(sql, params).then(([rows]) => rows);
  const [departments, labels, roles, kras, positions, held, employees, shifts] = await Promise.all([
    q('SELECT id, code, name, department_type, parent_department_id FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL ORDER BY id'),
    q('SELECT name FROM hrms_department_labels WHERE company_id = ? AND deleted_at IS NULL ORDER BY sort_order, id'),
    q("SELECT id, role_code, title, status FROM hrms_roles WHERE company_id = ? AND deleted_at IS NULL AND status <> 'RETIRED' ORDER BY id"),
    q(`SELECT a.id, a.role_id, a.kra_definition_id, d.name
         FROM hrms_role_kra_assignments a
         JOIN hrms_kra_definitions d ON d.company_id = a.company_id AND d.id = a.kra_definition_id
        WHERE a.company_id = ? AND a.deleted_at IS NULL`),
    q(`SELECT p.id, p.position_code, COALESCE(p.position_title, r.title) AS title, p.role_id, p.department_id, p.default_shift_id, p.status
         FROM hrms_positions p LEFT JOIN hrms_roles r ON r.company_id = p.company_id AND r.id = p.role_id
        WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status <> 'CLOSED' AND ${LIVE_ON('p')}
        ORDER BY p.position_code, p.id`, [companyId, asOf, asOf]),
    q(`SELECT wa.position_id, wa.employee_id, wa.is_primary FROM hrms_work_assignments wa
        WHERE wa.company_id = ? AND ${HOLDS_SEAT_SQL('wa')}
          AND (wa.effective_from IS NULL OR wa.effective_from <= ?) AND (wa.effective_to IS NULL OR wa.effective_to >= ?)
        ORDER BY wa.is_primary DESC, wa.id`, [companyId, asOf, asOf]),
    q(`SELECT id, employee_code, full_name, employment_status FROM hrms_employees
        WHERE company_id = ? AND deleted_at IS NULL AND employment_status <> 'EXITED' ORDER BY id`),
    q('SELECT id, code, name FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY id'),
  ]);

  const occupantOf = new Map();
  const positionOfEmployee = new Map();
  for (const h of held) {
    if (!occupantOf.has(h.position_id)) occupantOf.set(h.position_id, h.employee_id);
    if (!positionOfEmployee.has(h.employee_id)) positionOfEmployee.set(h.employee_id, h.position_id);
  }
  const deptById = new Map(departments.map((d) => [d.id, d]));
  const P = positions.map((p) => ({
    id: p.id, code: p.position_code ?? null, name: p.title ?? `Position ${p.id}`,
    roleId: p.role_id, departmentId: p.department_id, shiftId: p.default_shift_id,
    occupantId: occupantOf.get(p.id) ?? null,
  }));
  const positionById = new Map(P.map((p) => [p.id, p]));
  const inScope = (employeeId) => {
    if (scope.all) return true;
    const pos = positionById.get(positionOfEmployee.get(employeeId));
    return Boolean(pos && scope.departmentIds?.has(Number(pos.departmentId)));
  };

  return {
    companyId,
    on: asOf,
    departments: departments.map((d) => ({ id: d.id, code: d.code ?? null, name: d.name, label: d.department_type, parentId: d.parent_department_id })),
    labels: labels.map((l) => l.name),
    roles: roles.map((r) => ({ id: r.id, code: r.role_code ?? null, name: r.title })),
    roleKras: kras.reduce((m, k) => m.set(k.role_id, [...(m.get(k.role_id) ?? []), { id: k.id, definitionId: k.kra_definition_id, name: k.name }]), new Map()),
    positions: P,
    positionById,
    employees: employees.filter((e) => inScope(e.id)).map((e) => ({
      id: e.id, code: e.employee_code ?? null, name: e.full_name, positionId: positionOfEmployee.get(e.id) ?? null,
    })),
    shifts: shifts.map((s) => ({ id: s.id, code: s.code ?? null, name: s.name })),
    deptById,
  };
}

/** The records of one kind of field. */
export function recordsOf(recs, kind) {
  switch (kind) {
    case 'department': return recs.departments;
    case 'role': return recs.roles;
    case 'position': return recs.positions;
    case 'employee': return recs.employees;
    case 'shift': return recs.shifts;
    case 'label': return recs.labels.map((name, i) => ({ id: i + 1, code: null, name }));
    default: return [];
  }
}

/** What a person sees for a record in a drop-down. */
export function labelOf(kind, r, recs = null) {
  if (!r) return '';
  if (kind === 'position') {
    const dept = recs?.deptById?.get(r.departmentId)?.name;
    return `${r.name}${r.code ? ` (${r.code})` : ''}${dept ? ` — ${dept}` : ''}${r.occupantId == null ? ' · vacant' : ''}`;
  }
  if (kind === 'employee') return `${r.name}${r.code ? ` (${r.code})` : ''}`;
  if (kind === 'department') return `${r.name}${r.label && r.label !== 'Department' ? ` (${r.label.toLowerCase()})` : ''}`;
  return r.name;
}

/**
 * Which record `text` names. -> { record, candidates, confidence } where
 * `record` is set only when one is clearly meant, and `candidates` (best first)
 * holds every close one. `filter` narrows the records first (e.g. vacant positions).
 */
export function findRecord(recs, kind, text, { filter = null } = {}) {
  const list = recordsOf(recs, kind).filter((r) => (filter ? filter(r) : true));
  const t = String(text ?? '').trim();
  if (!t || !list.length) return { record: null, candidates: [], confidence: 0 };
  const tn = norm(t);
  const scored = [];
  for (const r of list) {
    let s = 0;
    if (r.code && norm(r.code) === tn) s = 1;
    else if (norm(r.name) === tn) s = 1;
    else s = Math.max(nameScore(t, r.name), r.code ? nameScore(t, r.code) * 0.95 : 0);
    if (s >= FLOOR) scored.push({ r, s });
  }
  scored.sort((a, b) => b.s - a.s || String(a.r.name).length - String(b.r.name).length);
  if (!scored.length) return { record: null, candidates: [], confidence: 0 };
  const top = scored[0].s;
  const close = scored.filter((x) => top - x.s <= TIE);
  const candidates = scored.slice(0, 8).filter((x) => top - x.s <= 0.2).map((x) => x.r);
  if (close.length === 1 && top >= SURE) return { record: scored[0].r, candidates: [], confidence: top };
  if (close.length === 1 && top >= 0.75 && (scored.length === 1 || top - scored[1].s > 0.1)) {
    return { record: scored[0].r, candidates: candidates.slice(1), confidence: top };
  }
  return { record: null, candidates, confidence: top };
}

export default { loadRecords, findRecord, recordsOf, labelOf };
