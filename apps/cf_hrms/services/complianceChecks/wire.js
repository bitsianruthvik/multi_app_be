/**
 * wire.js — where the checks run (TM/CF_HRMS_HIRING_SPEC.md §36.2):
 *   - the structure editor's live preview         structurePreviewChecks   (payrollService.previewStructure)
 *   - a structure save (optional acknowledgement)  structureSaveAcks        (payrollService.create/updateStructure)
 *   - a salary save: HARD refuses in plain words; a WARN needs a reason, kept with the approver
 *                                                  salaryGate + recordAcks   (payrollService.create/updateSalary)
 *   - a leave policy save (HARD refuses an ACTIVE policy)          leavePolicyGate  (leavePolicyService)
 *   - an attendance policy save (overtime below 2× refuses)        attendancePolicyGate (attendance/policy.js)
 *   - before a run is locked: the compliance panel lists every breach per person; HARD blocks the
 *     lock, a WARN needs an acknowledgement with a reason            runCompliance, assertRunLockable, acknowledgeRun
 *   - the run's statutory top-up past a to-do's deadline            topUpsForRun, topUpItem (runService.calculateRun)
 *
 * WARN acknowledgements carry over: a run asks only for what was not already accepted for the same
 * person, check and law version — on the salary the run paid on, or (for structure checks: the 50%
 * rule, usual shares) on the structure.
 */
import { HrmsError } from '../../lib/errors.js';
import { audit } from '../peopleService.js';
import { monthBounds } from '../payroll/proration.js';
import * as K from './checks.js';
import { STRUCTURE_CHECKS, TOPUP_COMPONENT } from './constants.js';
import { lawCache, companyState, placesOf, personResults, today, dateText } from './context.js';

const json = (v, d = null) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const money = (x) => Math.round((Number(x) || 0) * 100) / 100;
const keyOf = (r) => `${r.check}|${r.rule?.id ?? ''}`;
const reasonOf = (v) => { const s = v == null ? '' : String(v).trim(); return s.length >= 3 ? s.slice(0, 500) : null; };

/* ── acknowledgements ────────────────────────────────────────────────── */

/** Writes one acknowledgement per WARN result. */
export async function recordAcks(db, c, context, entityId, results, reason, { employeeId = null } = {}) {
  const warns = results.filter((r) => r.severity === 'WARN');
  for (const r of warns) {
    await db.query(
      'INSERT INTO hrms_compliance_acks (company_id, context, entity_id, employee_id, check_key, rule_id, message, reason, approved_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [c.companyId, context, entityId, r.employeeId ?? employeeId, r.check, r.rule?.id ?? null, String(r.message ?? '').slice(0, 600), reason, c.userId ?? null]);
  }
  if (warns.length) await audit(db, c, 'hrms_compliance_acks', entityId, 'APPROVE', null, { context, employeeId, reason, checks: warns.map(keyOf) }, null);
  return warns.length;
}

/** Map(key → ack) of acknowledgements in some contexts: [{ context, ids }]. Key: `${employeeId}|${check}|${ruleId}`. */
async function acksFor(db, companyId, where) {
  const out = new Map();
  for (const { context, ids } of where) {
    const list = [...new Set((ids ?? []).filter((x) => x != null).map(Number))];
    if (!list.length) continue;
    const [rows] = await db.query(
      `SELECT a.*, u.name AS approver_name FROM hrms_compliance_acks a LEFT JOIN users u ON u.id = a.approved_by
        WHERE a.company_id = ? AND a.context = ? AND a.deleted_at IS NULL AND a.entity_id IN (?)`, [companyId, context, list]);
    for (const a of rows) {
      const ack = { context, entityId: a.entity_id, reason: a.reason, by: a.approver_name ?? null, byId: a.approved_by, at: a.created_at };
      out.set(`${context}:${a.entity_id}|${a.employee_id ?? ''}|${a.check_key}|${a.rule_id ?? ''}`, ack);
    }
  }
  return out;
}
const findAck = (acks, candidates, employeeId, r) => {
  for (const [context, id] of candidates) {
    const hit = acks.get(`${context}:${id}|${employeeId ?? ''}|${r.check}|${r.rule?.id ?? ''}`) ?? acks.get(`${context}:${id}||${r.check}|${r.rule?.id ?? ''}`);
    if (hit) return hit;
  }
  return null;
};

/* ── the structure editor ────────────────────────────────────────────── */

/**
 * The live check of a structure for a sample CTC. place: { state?, zone?, skill?, employment?, roleId? } —
 * a role gives its skill and scheduled employment; the zone defaults to the company's only zone (if one).
 */
export async function structurePreviewChecks(db, c, { lines, components, place = {}, on = today(), pfMode = 'CEILING' }) {
  const p = { ...place };
  if (p.roleId) {
    const [[rl]] = await db.query('SELECT skill_category, scheduled_employment FROM hrms_role_law WHERE company_id = ? AND role_id = ? AND deleted_at IS NULL', [c.companyId, Number(p.roleId)]);
    p.skill = p.skill ?? rl?.skill_category ?? null;
    p.employment = p.employment ?? rl?.scheduled_employment ?? null;
  }
  p.state = String(p.state || await companyState(db, c.companyId)).toUpperCase();
  if (!p.zone) {
    const [zones] = await db.query('SELECT DISTINCT min_wage_zone FROM hrms_location_law WHERE company_id = ? AND deleted_at IS NULL AND min_wage_zone IS NOT NULL AND (state_code = ? OR state_code IS NULL)', [c.companyId, p.state]);
    if (zones.length === 1) p.zone = zones[0].min_wage_zone;
  }
  const results = await personResults(lawCache(db), { lines, place: p, on, pfMode, components });
  return { place: p, results, summary: K.summarise(results) };
}

/** A structure save may accept its WARNs with a reason: salaries on it are then not asked again for them. */
export async function structureSaveAcks(db, c, structureId, results, reason) {
  const r = reasonOf(reason);
  if (!r) return 0;
  return recordAcks(db, c, 'STRUCTURE', structureId, results.filter((x) => STRUCTURE_CHECKS.has(x.check)), r);
}

/* ── salary save ─────────────────────────────────────────────────────── */

/**
 * The checks of a salary about to be saved. Throws 422 COMPLIANCE_HARD (plain words) or 409 COMPLIANCE_WARN
 * (a reason is needed: body.complianceReason). Returns { results, toAck, reason } — the caller saves the
 * salary, then recordAcks(db, c, 'SALARY', salaryId, toAck, reason, { employeeId }).
 * opts.warn: 'require' (default) | 'record' (an import, a fix from a to-do: recorded with opts.reason).
 */
export async function salaryGate(db, c, { employeeId, salary, breakdown, components, body = {}, warn = 'require', reason = null }) {
  if (!breakdown?.ok) return { results: [], toAck: [], reason: null };
  const on = salary.effectiveFrom ?? today();
  const places = await placesOf(db, c.companyId, [employeeId], on, new Map(salary.stateCode ? [[Number(employeeId), salary.stateCode]] : []));
  const place = places.get(Number(employeeId));
  // The law of the salary's first day, and of today when that is later (a salary dated back is paid now, under
  // today's law too): both, each check against each law version once.
  const cache = lawCache(db);
  const results = [];
  const seenKeys = new Set();
  for (const day of [...new Set([on, on < today() ? today() : on])]) {
    for (const r of await personResults(cache, { lines: breakdown.lines, place, on: day, pfMode: salary.pfMode ?? 'CEILING', components })) {
      if (seenKeys.has(keyOf(r))) continue;
      seenKeys.add(keyOf(r));
      results.push(r);
    }
  }
  results.sort(K.bySeverity);
  const hard = results.filter((r) => r.severity === 'HARD');
  if (hard.length) {
    throw new HrmsError(422, 'COMPLIANCE_HARD', `This salary breaks the law, so it cannot be saved: ${hard[0].message}`, { problems: hard.map((r) => r.message), detail: { checks: results, place } });
  }
  let warns = results.filter((r) => r.severity === 'WARN');
  // Structure checks already accepted on the structure are not asked again.
  if (warns.length && salary.structureId) {
    const acks = await acksFor(db, c.companyId, [{ context: 'STRUCTURE', ids: [salary.structureId] }]);
    warns = warns.filter((r) => !(STRUCTURE_CHECKS.has(r.check) && findAck(acks, [['STRUCTURE', salary.structureId]], null, r)));
  }
  const why = reasonOf(reason ?? body.complianceReason);
  if (warns.length && !why) {
    if (warn === 'require') {
      throw new HrmsError(409, 'COMPLIANCE_WARN', `This salary can be saved with a reason: ${warns[0].message}`, { problems: warns.map((r) => r.message), detail: { checks: results, needReason: true, place } });
    }
  }
  return { results, toAck: warns, reason: why ?? (warns.length ? 'Recorded without a reason (import)' : null), place };
}

/* ── leave and attendance policies ──────────────────────────────────── */

/** The checks of a saved leave policy (read back in the same transaction). Throws when ACTIVE and HARD. */
export async function leavePolicyGate(db, c, policyId) {
  const [[p]] = await db.query('SELECT id, name, status FROM hrms_leave_policies WHERE company_id = ? AND id = ?', [c.companyId, policyId]);
  if (!p) return [];
  const [rules] = await db.query(
    `SELECT r.basis, r.accrual, r.days, r.days_worked_per_leave_day, t.code, t.name FROM hrms_leave_policy_rules r
       JOIN hrms_leave_types t ON t.company_id = r.company_id AND t.id = r.leave_type_id
      WHERE r.company_id = ? AND r.policy_id = ? AND r.deleted_at IS NULL`, [c.companyId, policyId]);
  const law = await lawCache(db).law(await companyState(db, c.companyId), today());
  const results = K.checkLeavePolicy({
    policyName: p.name, rule: law.leave,
    policyRules: rules.map((r) => ({ type: { code: r.code, name: r.name }, basis: r.basis, accrual: r.accrual, days: r.days == null ? null : Number(r.days), daysWorkedPerLeaveDay: r.days_worked_per_leave_day == null ? null : Number(r.days_worked_per_leave_day) })),
  });
  const hard = results.filter((r) => r.severity === 'HARD');
  if (hard.length && p.status === 'ACTIVE') {
    throw new HrmsError(422, 'COMPLIANCE_HARD', `This leave policy is below the legal minimum, so it cannot be active: ${hard[0].message}`, { problems: hard.map((r) => r.message), detail: { checks: results } });
  }
  return results;
}

/** Overtime in an attendance policy below the legal multiplier: an ACTIVE policy is refused. */
export async function attendancePolicyGate(db, c, policyId) {
  const [[p]] = await db.query('SELECT id, name, status, rules_json FROM hrms_attendance_policies WHERE company_id = ? AND id = ?', [c.companyId, policyId]);
  if (!p) return [];
  const ot = json(p.rules_json, {})?.overtime;
  if (!ot) return [];
  const law = await lawCache(db).law(await companyState(db, c.companyId), today());
  const results = K.checkOvertimeRate({ multiplier: ot.rateMultiplier, rule: law.otRate, policyName: p.name });
  const hard = results.filter((r) => r.severity === 'HARD');
  if (hard.length && p.status === 'ACTIVE') {
    throw new HrmsError(422, 'COMPLIANCE_HARD', `This attendance policy pays overtime below the legal rate: ${hard[0].message}`, { problems: hard.map((r) => r.message), detail: { checks: results } });
  }
  return results;
}

/* ── the run: compliance panel, lock, acknowledgements ──────────────── */

const quarterOf = (month) => {
  const [y, m] = month.split('-').map(Number);
  const q0 = Math.floor((m - 1) / 3) * 3 + 1;
  return { from: `${y}-${String(q0).padStart(2, '0')}-01`, label: `Q${Math.floor((m - 1) / 3) + 1} ${y}` };
};

/**
 * Every breach of a run, per person: minimum wage on the days paid, the 50% rule, statutory, usual shares,
 * overtime rate and hours. A WARN shows its acknowledgement when there is one.
 * @returns { runId, month, status, people: [{ employee, salaryId, structureId, results }], counts, canLock }
 */
export async function runCompliance(db, c, runId) {
  const [[run]] = await db.query('SELECT id, period_month, status FROM hrms_pay_runs WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, runId]);
  if (!run) throw new HrmsError(404, 'NOT_FOUND', 'That payroll run was not found.');
  const b = monthBounds(run.period_month);
  const [people] = await db.query(
    `SELECT p.id, p.employee_id, p.salary_id, p.structure_id, p.payable_days, p.days_in_month, p.calc_json, e.employee_code, e.full_name, s.pf_mode, s.state_code
       FROM hrms_pay_run_people p JOIN hrms_employees e ON e.company_id = p.company_id AND e.id = p.employee_id
       LEFT JOIN hrms_pay_salaries s ON s.company_id = p.company_id AND s.id = p.salary_id
      WHERE p.company_id = ? AND p.run_id = ? AND p.deleted_at IS NULL AND p.included = 1 ORDER BY e.full_name, e.id`, [c.companyId, runId]);
  const out = { runId: run.id, month: run.period_month, status: run.status, people: [], counts: { hard: 0, warn: 0, warnOpen: 0, info: 0, people: 0 }, canLock: true };
  if (!people.length) return out;
  const ids = people.map((p) => p.employee_id);
  const [lines] = await db.query(
    `SELECT l.run_person_id, l.amount, l.source, k.code, k.name, k.kind, k.statutory_key, k.frequency FROM hrms_pay_run_lines l
       JOIN hrms_pay_components k ON k.company_id = l.company_id AND k.id = l.component_id
      WHERE l.company_id = ? AND l.run_id = ? AND l.deleted_at IS NULL`, [c.companyId, runId]);
  const byPerson = new Map();
  for (const l of lines) { if (!byPerson.has(l.run_person_id)) byPerson.set(l.run_person_id, []); byPerson.get(l.run_person_id).push(l); }
  const { loadComponents, loadStructures, shapeSalary, SALARY_COLUMNS, overrideMap } = await import('../payroll/common.js');
  const { breakdown } = await import('../payroll/structure.js');
  const comps = await loadComponents(db, c.companyId);
  const structs = await loadStructures(db, c.companyId);
  const [salRows] = await db.query(`SELECT ${SALARY_COLUMNS} FROM hrms_pay_salaries WHERE company_id = ? AND id IN (?)`, [c.companyId, people.map((p) => p.salary_id ?? 0)]);
  const salaryOf = new Map(salRows.map((r) => [r.id, shapeSalary(r)]));
  const places = await placesOf(db, c.companyId, ids, b.to, new Map(people.filter((p) => p.state_code).map((p) => [p.employee_id, p.state_code])));
  const cache = lawCache(db);

  // Overtime: the quarter's minutes, the month's days, the policies that counted it.
  const q = quarterOf(run.period_month);
  const [otRows] = await db.query(
    `SELECT employee_id, attendance_date, overtime_minutes, worked_minutes, policy_id FROM hrms_attendance_records
      WHERE company_id = ? AND deleted_at IS NULL AND employee_id IN (?) AND attendance_date BETWEEN ? AND ? AND (overtime_minutes > 0 OR attendance_date >= ?)`,
    [c.companyId, ids, q.from, b.to, b.from]);
  const [pols] = await db.query('SELECT id, name, rules_json FROM hrms_attendance_policies WHERE company_id = ?', [c.companyId]);
  const polOf = new Map(pols.map((p) => [p.id, { name: p.name, ot: json(p.rules_json, {})?.overtime ?? null }]));

  const acks = await acksFor(db, c.companyId, [
    { context: 'RUN', ids: [runId] },
    { context: 'SALARY', ids: people.flatMap((p) => json(p.calc_json, {})?.salaryIds ?? [p.salary_id]) },
    { context: 'STRUCTURE', ids: people.map((p) => p.structure_id) },
  ]);
  for (const p of people) {
    const place = places.get(p.employee_id);
    const mine = (byPerson.get(p.id) ?? []).filter((l) => l.source !== 'ARREARS');
    const runLines = mine.map((l) => ({ code: l.code, name: l.name, kind: l.kind, statutoryKey: l.statutory_key, amount: Number(l.amount), frequency: 'MONTHLY' }));
    const factor = Number(p.days_in_month) > 0 ? Number(p.payable_days) / Number(p.days_in_month) : 1;
    // The 50% rule and usual shares are about the salary's structure (a full month, as at the salary save), not the
    // month's prorated and one-time lines.
    let structLines = [];
    const sal = salaryOf.get(p.salary_id);
    const st = sal ? structs.get(sal.structureId) : null;
    if (st) {
      const S = await cache.statutory(place.state, b.from);
      const bd = breakdown(st.lines, comps.byId, sal.annualCtc, overrideMap(sal), { pfMode: sal.pfMode, vars: { PF_CEILING: S.PF?.wageCeiling ?? null, ESI_CEILING: S.ESI?.wageCeiling ?? null } });
      if (bd.ok) structLines = bd.lines;
    }
    let results = await personResults(cache, { lines: runLines, place, on: b.to, pfMode: p.pf_mode ?? 'CEILING', components: comps, factor, structureChecks: false });
    const law = await cache.law(place.state, b.to);
    results.push(...K.checkFiftyPercent({ lines: structLines, rule: law.wages }), ...K.checkAllowanceShares({ lines: structLines }));
    if (mine.some((l) => l.code === TOPUP_COMPONENT.code)) {
      results.push(K.decide({ check: 'MIN_WAGE', severity: 'INFO', rule: null, message: `Kept at the legal minimum by a statutory top-up of ₹${money(mine.filter((l) => l.code === TOPUP_COMPONENT.code).reduce((s, l) => s + Number(l.amount), 0)).toLocaleString('en-IN')} (the minimum-wage to-do is past its deadline).` }));
    }
    const ot = otRows.filter((r) => r.employee_id === p.employee_id);
    if (ot.some((r) => Number(r.overtime_minutes) > 0)) {
      const days = ot.filter((r) => dateText(r.attendance_date) >= b.from).map((r) => ({ date: dateText(r.attendance_date), overtimeMinutes: Number(r.overtime_minutes), workedMinutes: Number(r.worked_minutes) }));
      results.push(...K.checkOvertimeHours({ days, quarterMinutes: ot.reduce((s, r) => s + Number(r.overtime_minutes), 0), quarterLabel: q.label, rateRule: law.otRate, capRule: law.otCap }));
      const used = new Set(ot.filter((r) => Number(r.overtime_minutes) > 0 && dateText(r.attendance_date) >= b.from).map((r) => r.policy_id).filter(Boolean));
      for (const pid of used) { const pol = polOf.get(pid); if (pol?.ot) results.push(...K.checkOvertimeRate({ multiplier: pol.ot.rateMultiplier, rule: law.otRate, policyName: pol.name })); }
    }
    results = results.sort(K.bySeverity);
    const cands = [['RUN', runId], ...(json(p.calc_json, {})?.salaryIds ?? [p.salary_id]).map((id) => ['SALARY', id]), ['STRUCTURE', p.structure_id]];
    for (const r of results) {
      if (r.severity !== 'WARN') continue;
      r.acknowledged = findAck(acks, cands.filter(([ctx]) => ctx !== 'STRUCTURE' || STRUCTURE_CHECKS.has(r.check)), p.employee_id, r);
    }
    const shown = results;
    if (!shown.length) continue;
    out.counts.people += 1;
    out.counts.hard += shown.filter((r) => r.severity === 'HARD').length;
    out.counts.warn += shown.filter((r) => r.severity === 'WARN').length;
    out.counts.warnOpen += shown.filter((r) => r.severity === 'WARN' && !r.acknowledged).length;
    out.counts.info += shown.filter((r) => r.severity === 'INFO').length;
    out.people.push({ employee: { id: p.employee_id, code: p.employee_code, name: p.full_name }, salaryId: p.salary_id, structureId: p.structure_id, place: { state: place.state, zone: place.zone, skill: place.skill }, results: shown });
  }
  out.canLock = out.counts.hard === 0 && out.counts.warnOpen === 0;
  return out;
}

/** Refuses the lock: 409 COMPLIANCE_HARD (blocks) or COMPLIANCE_WARN (acknowledge first). */
export async function assertRunLockable(db, c, runId, { reason = null } = {}) {
  const panel = await runCompliance(db, c, runId);
  if (panel.counts.hard) {
    const list = panel.people.flatMap((p) => p.results.filter((r) => r.severity === 'HARD').map((r) => `${p.employee.code} ${p.employee.name}: ${r.message}`));
    throw new HrmsError(409, 'COMPLIANCE_HARD', `${panel.counts.hard} breach${panel.counts.hard === 1 ? '' : 'es'} of the law in this run block the lock: ${list[0]}`, { problems: list.slice(0, 50), detail: { counts: panel.counts } });
  }
  if (panel.counts.warnOpen) {
    if (reasonOf(reason)) { await acknowledgeRun(db, c, runId, { reason }); return panel; }
    const list = panel.people.flatMap((p) => p.results.filter((r) => r.severity === 'WARN' && !r.acknowledged).map((r) => `${p.employee.code} ${p.employee.name}: ${r.message}`));
    throw new HrmsError(409, 'COMPLIANCE_WARN', `${panel.counts.warnOpen} warning${panel.counts.warnOpen === 1 ? '' : 's'} in the compliance panel need an acknowledgement with a reason before the lock.`, { problems: list.slice(0, 50), detail: { counts: panel.counts } });
  }
  return panel;
}

/** Acknowledges the run's open WARNs (all, or those listed: [{ employeeId, check, ruleId }]) with one reason. */
export async function acknowledgeRun(db, c, runId, { reason, items = null } = {}) {
  const why = reasonOf(reason);
  if (!why) throw new HrmsError(422, 'INVALID', 'Say why these warnings are accepted (the reason is kept with the run).', { problems: ['A reason of at least 3 characters.'] });
  const panel = await runCompliance(db, c, runId);
  const want = items ? new Set(items.map((i) => `${i.employeeId}|${i.check}|${i.ruleId ?? ''}`)) : null;
  let n = 0;
  for (const p of panel.people) {
    const open = p.results.filter((r) => r.severity === 'WARN' && !r.acknowledged && (!want || want.has(`${p.employee.id}|${r.check}|${r.rule?.id ?? ''}`)));
    n += await recordAcks(db, c, 'RUN', runId, open, why, { employeeId: p.employee.id });
  }
  return { acknowledged: n, panel: await runCompliance(db, c, runId) };
}

/* ── the statutory top-up ────────────────────────────────────────────── */

/**
 * Map(employeeId → { todoId, monthlyMinimum, ruleId }) for the run's month: open HARD minimum-wage to-dos
 * whose deadline is on or before the month's last day. Read by calculateRun.
 */
export async function topUpsForRun(db, companyId, month) {
  const b = monthBounds(month);
  const [todos] = await db.query(
    "SELECT id, rule_id, affected_json FROM hrms_compliance_todos WHERE company_id = ? AND deleted_at IS NULL AND status IN ('OPEN','CHOSEN') AND check_key = 'MIN_WAGE' AND severity = 'HARD' AND deadline <= ?",
    [companyId, b.to]);
  const out = new Map();
  for (const t of todos) {
    for (const p of json(t.affected_json, {})?.people ?? []) {
      const need = Number(p.monthlyMinimum ?? p.detail?.monthlyMinimum) || 0;
      if (need > 0 && !out.has(Number(p.employeeId))) out.set(Number(p.employeeId), { todoId: t.id, monthlyMinimum: need, ruleId: t.rule_id });
    }
  }
  return out;
}

/** The top-up one-time item for a person's month (or null): the shortfall of wages to the minimum for the days paid. */
export function topUpItem({ lines, days, topUp }) {
  if (!topUp || !days?.daysInMonth) return null;
  const factor = Number(days.payableDays) / Number(days.daysInMonth);
  const need = money(topUp.monthlyMinimum * factor);
  const w = K.wagesOf((lines ?? []).filter((l) => l.source !== 'ARREARS'));
  // Basic + DA (+ retaining) to the minimum, not relying on the s.2(y) add-back: the top-up itself changes it.
  const short = Math.ceil(need - w.wages - 0.005);
  if (short < 1) return null;
  return { code: TOPUP_COMPONENT.code, amount: short, source: 'ONE_TIME', basis: `statutory top-up to the minimum wage: ₹${need.toLocaleString('en-IN')} for ${days.payableDays} of ${days.daysInMonth} days, basic + DA ₹${w.wages.toLocaleString('en-IN')} (compliance to-do #${topUp.todoId})` };
}

/** The STAT_TOPUP component of a company (made when missing). Returns its id. */
export async function ensureTopUpComponent(db, companyId, userId = null) {
  const [[k]] = await db.query('SELECT id, status FROM hrms_pay_components WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [companyId, TOPUP_COMPONENT.code]);
  if (k) return k.id;
  const t = TOPUP_COMPONENT;
  const [ins] = await db.query(
    `INSERT INTO hrms_pay_components (company_id, code, name, kind, taxable, exemption_rule, in_pf_wage, in_esi_wage, in_gratuity_wage, frequency, prorate_on_lop,
       statutory_key, sort_order, status, is_ready_made, description, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1, ?, ?)`,
    [companyId, t.code, t.name, t.kind, t.taxable, t.exemptionRule, t.inPfWage, t.inEsiWage, t.inGratuityWage, t.frequency, t.prorateOnLop, t.statutoryKey, t.sortOrder, t.description, userId]);
  return ins.insertId;
}

export default { recordAcks, structurePreviewChecks, structureSaveAcks, salaryGate, leavePolicyGate, attendancePolicyGate, runCompliance, assertRunLockable, acknowledgeRun, topUpsForRun, topUpItem, ensureTopUpComponent };
