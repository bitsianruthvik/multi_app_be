/**
 * personLaw.js — where the law finds a person (spec §36.1 "state follows the person").
 *
 * A person's state = the state of their MAIN position's location on the day (the primary live work
 * assignment: its own location, else its position's), read from hrms_location_law; a location with
 * no state there (or a person with no seat) falls back to the company's payroll state
 * (hrms_pay_settings.state_code). The location also gives the minimum-wage zone; the assignment's
 * role gives the skill category and scheduled employment (hrms_role_law).
 *
 * A salary row's own state_code (set by HR on the salary) still wins over all of this in payroll —
 * it is an explicit choice for that salary.
 *
 *   lawPlacesOf(db, companyId, employeeIds, on)  Map(employeeId → { state, stateFrom: 'LOCATION'|'COMPANY',
 *                                                 locationId, locationName, zone, roleId, roleTitle, skill, employment })
 *   statesOf(db, companyId, employeeIds, on)     Map(employeeId → state | null) — null when it is the company's
 *   companyStates(db, companyId)                 the company state + every state its locations are in
 */
const dateText = (v) => (v == null ? null : (v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  : String(v).slice(0, 10)));

async function companyState(db, companyId) {
  const [[r]] = await db.query('SELECT state_code FROM hrms_pay_settings WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  return r?.state_code ?? 'TG';
}

export async function lawPlacesOf(db, companyId, employeeIds, on) {
  const out = new Map();
  const ids = [...new Set(employeeIds.map(Number).filter(Boolean))];
  const fallback = await companyState(db, companyId);
  for (const id of ids) out.set(id, { state: fallback, stateFrom: 'COMPANY', locationId: null, locationName: null, zone: null, roleId: null, roleTitle: null, skill: null, employment: null });
  if (!ids.length) return out;
  const day = dateText(on);
  const [rows] = await db.query(
    `SELECT wa.employee_id, wa.role_id, COALESCE(wa.location_id, p.location_id) AS location_id, l.name AS location_name,
            ll.state_code, ll.min_wage_zone, r.title AS role_title, rl.skill_category, rl.scheduled_employment
       FROM hrms_work_assignments wa
       LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id
       LEFT JOIN hrms_locations l ON l.company_id = wa.company_id AND l.id = COALESCE(wa.location_id, p.location_id)
       LEFT JOIN hrms_location_law ll ON ll.company_id = wa.company_id AND ll.location_id = l.id AND ll.deleted_at IS NULL
       LEFT JOIN hrms_roles r ON r.company_id = wa.company_id AND r.id = wa.role_id
       LEFT JOIN hrms_role_law rl ON rl.company_id = wa.company_id AND rl.role_id = wa.role_id AND rl.deleted_at IS NULL
      WHERE wa.company_id = ? AND wa.deleted_at IS NULL AND wa.status <> 'ENDED' AND wa.employee_id IN (${ids.map(() => '?').join(',')})
        AND (wa.effective_from IS NULL OR wa.effective_from <= ?) AND (wa.effective_to IS NULL OR wa.effective_to >= ?)
      ORDER BY wa.is_primary DESC, wa.effective_from DESC, wa.id`,
    [companyId, ...ids, day, day]);
  const done = new Set();
  for (const r of rows) {
    if (done.has(r.employee_id)) continue;
    done.add(r.employee_id);
    out.set(r.employee_id, {
      state: r.state_code ?? fallback, stateFrom: r.state_code ? 'LOCATION' : 'COMPANY',
      locationId: r.location_id ?? null, locationName: r.location_name ?? null, zone: r.min_wage_zone ?? null,
      roleId: r.role_id ?? null, roleTitle: r.role_title ?? null, skill: r.skill_category ?? null, employment: r.scheduled_employment ?? null,
    });
  }
  return out;
}

/** Map(employeeId → state from their location), null where it falls back to the company's state. */
export async function statesOf(db, companyId, employeeIds, on) {
  const places = await lawPlacesOf(db, companyId, employeeIds, on);
  return new Map([...places].map(([id, p]) => [id, p.stateFrom === 'LOCATION' ? p.state : null]));
}

export async function companyStates(db, companyId) {
  const base = await companyState(db, companyId);
  const [rows] = await db.query('SELECT DISTINCT state_code FROM hrms_location_law WHERE company_id = ? AND deleted_at IS NULL AND state_code IS NOT NULL', [companyId]);
  return [...new Set([base, ...rows.map((r) => r.state_code)])];
}

export default { lawPlacesOf, statesOf, companyStates };
