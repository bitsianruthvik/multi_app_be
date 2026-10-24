/**
 * services/complianceChecks — CHECKS, COMPLIANCE TO-DOS WITH A PROPOSED FIX, THE BONUS RUN
 * (TM/CF_HRMS_HIRING_SPEC.md §36.2, §36.3, C2; models/init.sql §39).
 *
 *   checks.js    the checks themselves, pure (minimum wage, the 50% rule, statutory, overtime rate and hours,
 *                leave minimum, usual shares) — what "wages" means is written at its top
 *   context.js   the law in force for a state and day, a person's place, a month's pay (take-home / cost)
 *   wire.js      where they run: structure editor, salary save, leave / attendance policy save, the run's
 *                compliance panel and lock, the statutory top-up
 *   breaches.js  findBreaches            remedies.js  proposeFixes / applyOption
 *   todos.js     the to-dos (sync after a publish, nightly, "Check now"; choose → approve → applied)
 *   bonus.js     the statutory bonus run and its register
 *
 * ── THE API FOR C4 / C5 (notifications, watcher, reviewer) ─────────────────────────────────────
 *
 * findBreaches(db, companyId, { on = today, lawVersionIds? }) → Promise<[BREACH]>
 *   What in one company does not comply with the law in force on `on` (salaries in force that day,
 *   active leave and attendance policies). With lawVersionIds, only breaches against those law
 *   versions (e.g. the one just published). Reads only. A BREACH:
 *   { key,                    'MIN_WAGE:<lawRuleId>' — check + law version (the to-do's key)
 *     companyId, on,
 *     check,                  MIN_WAGE | MIN_WAGE_BASIC | MIN_WAGE_UNKNOWN | WAGES_50 | PF_LEFT_OUT | STATUTORY_MISSING | LEAVE_MIN | OT_RATE
 *     title, message,         words: "12 people paid below the minimum wage — Telangana minimum wages … (version 2, from 2026-06-01)."
 *     severity,               'HARD' | 'WARN' | 'INFO' (an unverified rule never gives HARD: hardIfVerified + unverifiedNote say so)
 *     hardIfVerified, unverifiedNote,
 *     rule: { id, domain, jurisdiction, ruleKey, title, sourceUrl, effectiveFrom, version, verified } | null,
 *     effectiveFrom, deadline,               the law's effective date (deadline = it)
 *     people: [{ employeeId, code, name, salaryId, structureId, structureName, annualCtc, pfMode, place: { state, zone, skill, … },
 *                message, numbers, monthlyMinimum }],
 *     structures: [{ id, code, name, people }],
 *     policies:   [{ kind: 'LEAVE' | 'ATTENDANCE', id, name, message }],
 *     remedies:   ['RESPLIT' | 'RAISE_CTC' | 'ADD_STATUTORY'] }   (the fixes that proposeFixes can work out)
 *
 * proposeFixes(breach, db = pool) → Promise<{ breachKey, check, deadline, options: [OPTION] }>
 *   OPTION: { key, label, description, feasible, infeasible: [{ employeeId, name, note }],
 *             totals: { people, feasible, losers, extraCostMonthly, extraCostAnnual, takeHomeChangeMonthly },
 *             perStructure: [{ structureId, name, newStructure, people, losers, before: {takeHome, cost, pfEe, pfEr, esiEe, esiEr}, after: {…} }],
 *             perPerson: [{ employeeId, code, name, structureId, feasible, before, after, change, losesTakeHome, effectiveFrom, note, detail, newCtc? }],
 *             structures?: [new structure versions], components?: [to activate / create] }
 *
 * So a notification can say "N people affected, a fix is ready":
 *   const [b] = await findBreaches(db, companyId, { lawVersionIds: [version.id] });
 *   const fixes = b ? await proposeFixes(b, db) : null;   // b.people.length, fixes.options.some((o) => o.feasible)
 * The to-do itself is made by this module's own onPublish listener (todos.listenForLaw); its screen is
 * /:company/cf_hrms/payroll-compliance/:todoId (the list: /payroll-compliance). registerProposals() below
 * adds a proposal to C4's notification impact (services/compliance/impact.js registerImpactExtension):
 *   { kind: 'C2_FIX', title, check, severity, people, structures, fixReady, options: [{ key, label, feasible, extraCostMonthly }], link: 'payroll-compliance' }
 *
 * Also: syncTodos, listTodos, readTodo, chooseOption, approveTodo, dismissTodo, remindPass (todos.js);
 * runCompliance / assertRunLockable / acknowledgeRun / salaryGate (wire.js); the bonus (bonus.js).
 */
import { findBreaches } from './breaches.js';
import { proposeFixes } from './remedies.js';
import { CHECKS } from './constants.js';

export { findBreaches } from './breaches.js';
export { proposeFixes, applyOption } from './remedies.js';
export { syncTodos, listTodos, readTodo, chooseOption, approveTodo, dismissTodo, remindPass, listenForLaw, nightlyPass, startChecks, settled } from './todos.js';
export { runCompliance, assertRunLockable, acknowledgeRun, salaryGate, structurePreviewChecks, leavePolicyGate, attendancePolicyGate, topUpsForRun, topUpItem, ensureTopUpComponent } from './wire.js';
export * as checks from './checks.js';

/**
 * C4's notification impact gets C2's proposals: for a published change { domain, jurisdiction, ruleKey,
 * effectiveFrom }, the breaches of that rule in the company and whether a fix is ready.
 */
export async function proposalsForChange(db, companyId, change) {
  const domain = String(change?.domain ?? '').toUpperCase();
  const breaches = (await findBreaches(db, companyId, { on: change?.effectiveFrom ?? undefined }))
    .filter((b) => b.rule && b.rule.domain === domain && (!change?.jurisdiction || b.rule.jurisdiction === change.jurisdiction));
  const out = [];
  for (const b of breaches) {
    const fixes = b.remedies.length ? await proposeFixes(b, db) : { options: [] };
    out.push({
      kind: 'C2_FIX', title: `${b.people.length || b.policies.length} affected — ${CHECKS[b.check] ?? b.check}${fixes.options.some((o) => o.feasible) ? ': a fix is ready' : ''}`,
      check: b.check, severity: b.severity, people: b.people.length, structures: b.structures.length, policies: b.policies.length,
      fixReady: fixes.options.some((o) => o.feasible), options: fixes.options.map((o) => ({ key: o.key, label: o.label, feasible: o.feasible, extraCostMonthly: o.totals.extraCostMonthly })),
      link: 'payroll-compliance', message: b.message,
    });
  }
  return out;
}

let registered = false;
/** Registers proposalsForChange with C4's impact hook (once). */
export async function registerProposals() {
  if (registered) return;
  registered = true;
  const { registerImpactExtension } = await import('../compliance/impact.js');
  registerImpactExtension(proposalsForChange);
}

export default { findBreaches, proposeFixes, proposalsForChange, registerProposals };
