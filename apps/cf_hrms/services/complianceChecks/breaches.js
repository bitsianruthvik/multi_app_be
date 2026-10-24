/**
 * breaches.js — findBreaches(db, companyId, { on, lawVersionIds? }) (TM/CF_HRMS_HIRING_SPEC.md §36.3, C2).
 *
 * What in ONE company does not comply with the law in force on `on`: every person's salary in force
 * that day (worked out on its structure, at their place — state, zone, skill), the active leave
 * policies and the active attendance policies. Grouped into BREACHES, one per check × law version.
 * Reads only. Shape: see index.js.
 */
import { loadComponents, loadStructures, shapeSalary, SALARY_COLUMNS, overrideMap } from '../payroll/common.js';
import { breakdown } from '../payroll/structure.js';
import * as K from './checks.js';
import { CHECKS } from './constants.js';
import { lawCache, placesOf, personResults, today, companyState } from './context.js';

const json = (v, d = null) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };

/** Which shipped remedies fit a check. */
export const REMEDIES_OF = {
  MIN_WAGE: ['RESPLIT', 'RAISE_CTC'],
  MIN_WAGE_BASIC: ['RESPLIT'],
  WAGES_50: ['RESPLIT'],
  PF_LEFT_OUT: ['ADD_STATUTORY'],
  STATUTORY_MISSING: ['ADD_STATUTORY'],
};
/** Not to-dos: product guidance (usual shares) and the run-only checks. */
const NOT_A_TODO = new Set(['ALLOWANCE_SHARE', 'OT_HOURS', 'OT_RATE_BASE']);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function sentence(b) {
  const n = b.people.length;
  const who = plural(n, 'person', 'people');
  const law = b.rule ? `${b.rule.title ?? b.rule.domain} (version ${b.rule.version ?? '?'}, from ${b.rule.effectiveFrom ?? '?'})` : 'the setup';
  switch (b.check) {
    case 'MIN_WAGE': return `${who} paid below the minimum wage — ${law}.`;
    case 'MIN_WAGE_BASIC': return `${who} meet the minimum wage only through allowances counted as wages; basic + DA alone is below it — ${law}.`;
    case 'MIN_WAGE_UNKNOWN': return `The minimum wage cannot be checked for ${who}: ${[...new Set(b.people.map((p) => p.message.replace(/^The minimum wage cannot be checked: /, '')))].slice(0, 3).join(' ')}`;
    case 'WAGES_50': return `${plural(b.structures.length, 'structure')} (${who}) pay wages under 50% of remuneration — ${law}.`;
    case 'PF_LEFT_OUT': return `${who} not in PF with a PF wage within the ceiling — ${law}.`;
    case 'STATUTORY_MISSING': return `A statutory component is inactive or missing (${who} affected) — ${law}.`;
    case 'LEAVE_MIN': return `${plural(b.policies.length, 'leave policy', 'leave policies')} below the annual-leave minimum — ${law}.`;
    case 'OT_RATE': return `${plural(b.policies.length, 'attendance policy', 'attendance policies')} pay overtime below the legal rate — ${law}.`;
    default: return `${CHECKS[b.check] ?? b.check} — ${law}.`;
  }
}

export async function findBreaches(db, companyId, { on = today(), lawVersionIds = null } = {}) {
  const cache = lawCache(db);
  const [comps, structs] = await Promise.all([loadComponents(db, companyId), loadStructures(db, companyId)]);
  const [rows] = await db.query(
    `SELECT ${SALARY_COLUMNS.split(', ').map((c) => `s.${c}`).join(', ')}, e.employee_code, e.full_name
       FROM hrms_pay_salaries s JOIN hrms_employees e ON e.company_id = s.company_id AND e.id = s.employee_id AND e.deleted_at IS NULL
      WHERE s.company_id = ? AND s.deleted_at IS NULL AND s.effective_from <= ? AND (s.effective_to IS NULL OR s.effective_to >= ?)
        AND (s.effective_to IS NULL OR s.effective_to >= s.effective_from)
        AND (e.date_of_joining IS NULL OR e.date_of_joining <= ?) AND (e.exit_date IS NULL OR e.exit_date >= ?)
      ORDER BY e.full_name, e.id, s.effective_from DESC`, [companyId, on, on, on, on]);
  const seen = new Set();
  const salaries = [];
  for (const r of rows) {
    if (seen.has(r.employee_id)) continue;
    seen.add(r.employee_id);
    salaries.push({ salary: shapeSalary(r), code: r.employee_code, name: r.full_name });
  }
  const places = await placesOf(db, companyId, salaries.map((s) => s.salary.employeeId), on, new Map(salaries.filter((s) => s.salary.stateCode).map((s) => [s.salary.employeeId, s.salary.stateCode])));
  const groups = new Map();
  const add = (r, extra) => {
    if (NOT_A_TODO.has(r.check)) return;
    const key = `${r.check}:${r.rule?.id ?? (extra.place?.state ?? 'company')}`;
    if (!groups.has(key)) groups.set(key, { key, companyId, on, check: r.check, title: r.title, severity: r.severity, hardIfVerified: r.hardIfVerified, unverifiedNote: r.unverifiedNote, rule: r.rule, people: [], structures: new Map(), policies: [] });
    const g = groups.get(key);
    if (r.severity === 'HARD') g.severity = 'HARD';
    if (extra.person) g.people.push({ ...extra.person, message: r.message, numbers: r.numbers, monthlyMinimum: r.numbers?.monthlyMinimum ?? null });
    if (extra.structure) { const s = g.structures.get(extra.structure.id) ?? { ...extra.structure, people: 0 }; s.people += 1; g.structures.set(s.id, s); }
    if (extra.policy) g.policies.push({ ...extra.policy, message: r.message });
  };

  for (const { salary: s, code, name } of salaries) {
    const st = structs.get(s.structureId);
    if (!st) continue;
    const place = places.get(s.employeeId);
    const settings = await cache.statutory(place.state, on);
    const b = breakdown(st.lines, comps.byId, s.annualCtc, overrideMap(s), { pfMode: s.pfMode, vars: { PF_CEILING: settings.PF?.wageCeiling ?? null, ESI_CEILING: settings.ESI?.wageCeiling ?? null } });
    if (!b.ok) continue;
    const results = await personResults(cache, { lines: b.lines, place, on, pfMode: s.pfMode, components: comps });
    for (const r of results) {
      add(r, {
        place,
        person: { employeeId: s.employeeId, code, name, salaryId: s.id, structureId: s.structureId, structureName: st.name, annualCtc: s.annualCtc, pfMode: s.pfMode, place: { state: place.state, zone: place.zone, skill: place.skill, employment: place.employment, locationName: place.locationName, roleTitle: place.roleTitle } },
        structure: { id: st.id, code: st.code, name: st.name },
      });
    }
  }

  // Policies are the company's: the law of its payroll state.
  const state = await companyState(db, companyId);
  const law = await cache.law(state, on);
  const [lps] = await db.query("SELECT id, name FROM hrms_leave_policies WHERE company_id = ? AND deleted_at IS NULL AND status = 'ACTIVE'", [companyId]);
  for (const p of lps) {
    const [rules] = await db.query(
      `SELECT r.basis, r.accrual, r.days, r.days_worked_per_leave_day, t.code, t.name FROM hrms_leave_policy_rules r JOIN hrms_leave_types t ON t.company_id = r.company_id AND t.id = r.leave_type_id
        WHERE r.company_id = ? AND r.policy_id = ? AND r.deleted_at IS NULL`, [companyId, p.id]);
    const res = K.checkLeavePolicy({ policyName: p.name, rule: law.leave, policyRules: rules.map((r) => ({ type: { code: r.code, name: r.name }, basis: r.basis, accrual: r.accrual, days: r.days == null ? null : Number(r.days), daysWorkedPerLeaveDay: r.days_worked_per_leave_day == null ? null : Number(r.days_worked_per_leave_day) })) });
    for (const r of res) add(r, { place: { state }, policy: { kind: 'LEAVE', id: p.id, name: p.name } });
  }
  const [aps] = await db.query("SELECT id, name, rules_json FROM hrms_attendance_policies WHERE company_id = ? AND deleted_at IS NULL AND status = 'ACTIVE'", [companyId]);
  for (const p of aps) {
    const ot = json(p.rules_json, {})?.overtime;
    if (!ot) continue;
    for (const r of K.checkOvertimeRate({ multiplier: ot.rateMultiplier, rule: law.otRate, policyName: p.name })) add(r, { place: { state }, policy: { kind: 'ATTENDANCE', id: p.id, name: p.name } });
  }

  const want = lawVersionIds?.length ? new Set(lawVersionIds.map(String)) : null;
  const breaches = [...groups.values()]
    .filter((g) => !want || (g.rule?.id != null && want.has(String(g.rule.id))))
    .map((g) => {
      const out = { ...g, structures: [...g.structures.values()], effectiveFrom: g.rule?.effectiveFrom ?? null, deadline: g.rule?.effectiveFrom ?? null, remedies: REMEDIES_OF[g.check] ?? [] };
      out.message = sentence(out);
      return out;
    })
    .sort((a, b) => K.bySeverity(a, b) || b.people.length - a.people.length);
  return breaches;
}

export default { findBreaches, REMEDIES_OF };
