/**
 * setup-karni-exec-leave.mjs — Karni's executive leave policy, KPPL/HR/POL/004, as data
 * (TM/CF_HRMS_HIRING_SPEC.md §23.2; source: Leave_Policy_Corporate_V1.docx, effective 1 Oct 2026).
 *
 *   node setup-karni-exec-leave.mjs                          DRY RUN on local — prints what it would do
 *   node setup-karni-exec-leave.mjs --apply
 *   node setup-karni-exec-leave.mjs --apply --target=prod
 *   [--company=karni]
 *
 * WHAT IT DOES, THROUGH THE SERVICES (so every change writes its audit row):
 *   1. leave types CL, SL, EL, ML and LOP: created when missing (by code), renamed / re-flagged
 *      paid or unpaid when they differ;
 *   2. the policy "Leave policy — Executives", code KPPL/HR/POL/004 (found BY CODE): created
 *      when missing, else its fields and rules are brought to the ones below — only when they differ;
 *   3. assigned by ROLE to every NON-worker role of the company. A worker role is one whose title
 *      matches WORKER_TITLE (operators, helpers, drivers, security, electricians …): those get no
 *      policy until their own. A role that already has ANOTHER policy is NOT touched — it is
 *      reported, for a person to decide.
 * Idempotent: a second run changes nothing. The dry run is the same transaction, rolled back, so
 * it prints the rules with the sentences the server would write.
 * Needs apply-leave-rules-schema.mjs first.
 */
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import {
  listLeaveTypes, createLeaveType, updateLeaveType, getPolicy, createPolicy, updatePolicy, putAssignment, readRule,
} from '../services/leavePolicyService.js';
import { RULE_DEFAULTS, loadAssignmentIndex } from '../services/leavePolicyRead.js';

const args = process.argv.slice(2);
const arg = (n) => { const hit = args.find((a) => a.startsWith(`--${n}=`)); return hit ? hit.slice(hit.indexOf('=') + 1) : null; };
const APPLY = args.includes('--apply');
const REQUEST_ID = 'setup-karni-exec-leave';

/** Roles that are workers, not executives: they get no policy from this script. */
export const WORKER_TITLE = /operator|helper|worker|driver|loader|cleaner|peon|guard|security|fitter|electrician|technician|attendant|boy/i;
/** Also workers, by the user (2026-10-16), though their titles do not say so. Matched on the start of the title. */
export const WORKER_ROLES = ['Asst Op 1 & Asst Op 2 & Asst Op 3', 'Housekeeping Staff', 'Welder/Fabricator', 'Cow Maintenance'];
const isWorker = (title) => WORKER_TITLE.test(title ?? '') || WORKER_ROLES.some((w) => String(title ?? '').toLowerCase().startsWith(w.toLowerCase()));

export const POLICY = {
  code: 'KPPL/HR/POL/004',
  name: 'Leave policy — Executives',
  description: 'Executives, Unit 2 (Bibinagar). From the policy document KPPL/HR/POL/004, version 1.0, effective 1 October 2026.',
  yearStartsMonth: 1,
  effectiveFrom: '2026-10-01',
  status: 'ACTIVE',
};

export const TYPES = [
  { code: 'CL', name: 'Casual leave', isPaid: true },
  { code: 'SL', name: 'Sick leave', isPaid: true },
  { code: 'EL', name: 'Earned leave', isPaid: true },
  { code: 'ML', name: 'Maternity leave', isPaid: true },
  { code: 'LOP', name: 'Leave without pay', isPaid: false },
];

/** The rules, by leave type code. `notWith` names codes; they become ids. */
export const RULES = [
  {
    type: 'CL', basis: 'PER_YEAR', accrual: 'MONTHLY', days: 6,
    waitDaysAfterJoining: 90, allowedInProbation: false, halfDayAllowed: true, minNoticeDays: 1, maxDaysAtOnce: 2,
    carryForward: 'NONE', encashable: false, notWith: ['SL', 'EL'],
    notes: 'In an emergency, tell the reporting manager by phone before the working day starts, and regularise it within 2 working days of returning.',
  },
  {
    type: 'SL', basis: 'PER_YEAR', accrual: 'HALF_YEARLY', days: 6,
    prorateOnJoining: true, joiningCutoffDay: 15, allowedInProbation: true, halfDayAllowed: true, proofAfterDays: 2,
    carryForward: 'NONE', encashable: false,
    notes: 'Tell the reporting manager and HR before the working day starts. Regularise it within 2 working days of returning, or it becomes leave without pay. HR may ask for a medical certificate for repeated sick leave.',
  },
  {
    type: 'EL', basis: 'PER_YEAR', accrual: 'MONTHLY', creditInArrears: true, days: 15, minPresentDaysForCredit: 20,
    waitDaysAfterJoining: 90, allowedInProbation: false, halfDayAllowed: true,
    noticeTiers: [{ upToDays: 3, days: 7 }, { upToDays: 7, days: 30 }, { upToDays: null, days: 45 }],
    carryForward: 'NONE', encashable: true,
    notes: 'Credited only for a month with 20 or more present days. Paid out only at exit, when the notice period has been served. Taken without the notice, it is leave without pay unless the reporting manager approves it.',
  },
  {
    type: 'ML', basis: 'PER_EVENT', days: 182, appliesTo: 'WOMEN', maxTimesInService: 2, countDaysOffBetween: true, proofAfterDays: 0,
    notes: 'Only for a woman who has worked at least 80 days in the 12 months before the expected delivery date. Tell HR in writing, with the documents asked for.',
  },
  {
    type: 'LOP', basis: 'UNLIMITED_UNPAID', halfDayAllowed: true,
    notes: 'Taken when no leave of the right type is left. Leave taken without approval is also counted as leave without pay.',
  },
];

const COMPARE = [...Object.keys(RULE_DEFAULTS), 'leaveTypeId', 'sortOrder'];
const sameRule = (a, b) => COMPARE.every((k) => JSON.stringify(a?.[k] ?? null) === JSON.stringify(b?.[k] ?? null));

/** What a run would do, and (with apply, in the caller's transaction) does it. Returns the report. */
export async function setupExecLeave(conn, companyId, { userId = null } = {}) {
  const c = { companyId, userId };
  const report = { types: [], policy: null, policyAction: null, assigned: [], alreadyAssigned: [], workers: [], elsewhere: [], unassigned: [] };

  // ── 1. leave types ──
  const { types } = await listLeaveTypes(conn, companyId);
  const byCode = new Map(types.map((t) => [String(t.code).toUpperCase(), t]));
  for (const want of TYPES) {
    const have = byCode.get(want.code);
    if (!have) {
      const { type } = await createLeaveType(conn, c, { code: want.code, name: want.name, isPaid: want.isPaid, status: 'ACTIVE' }, REQUEST_ID);
      byCode.set(want.code, type);
      report.types.push(`${want.code} ${want.name}: created`);
    } else if (have.name !== want.name || have.isPaid !== want.isPaid || have.status !== 'ACTIVE') {
      const { type } = await updateLeaveType(conn, c, have.id, { name: want.name, isPaid: want.isPaid, status: 'ACTIVE' }, REQUEST_ID);
      byCode.set(want.code, type);
      report.types.push(`${want.code} ${want.name}: updated (was ${have.name}, ${have.isPaid ? 'paid' : 'unpaid'}, ${have.status})`);
    } else report.types.push(`${want.code} ${want.name}: already there`);
    // Another leave type with the same name (e.g. LWP "Leave without pay") is left alone, but said.
    for (const t of types) {
      if (String(t.code).toUpperCase() !== want.code && String(t.name).toLowerCase() === want.name.toLowerCase()) {
        report.types.push(`  note: ${t.code} is also named "${t.name}" — left as it is; it is not in this policy`);
      }
    }
  }
  const idOf = (code) => byCode.get(code).id;
  const typeNames = new Map([...byCode.values()].map((t) => [t.id, t.name]));

  // ── 2. the policy, by code ──
  const ruleInputs = RULES.map(({ type, notWith = [], ...rest }, i) => ({
    ...rest, leaveTypeId: idOf(type), sortOrder: i + 1, notWithLeaveTypeIds: notWith.map(idOf),
  }));
  const problems = [];
  const wanted = ruleInputs.map((r) => ({ ...readRule(r, typeNames.get(r.leaveTypeId), problems, { leaveTypeId: r.leaveTypeId, typeNames }), leaveTypeId: r.leaveTypeId, sortOrder: r.sortOrder }));
  if (problems.length) throw new Error(`the rules are not valid: ${problems.join(' ')}`);

  const [[found]] = await conn.query('SELECT id FROM hrms_leave_policies WHERE company_id = ? AND deleted_at IS NULL AND LOWER(code) = LOWER(?)', [companyId, POLICY.code]);
  let policy;
  if (!found) {
    // Made as a draft with no rules, then given its rules and made active in one update.
    ({ policy } = await createPolicy(conn, c, { name: POLICY.name, code: POLICY.code, description: POLICY.description, yearStartsMonth: POLICY.yearStartsMonth, effectiveFrom: POLICY.effectiveFrom, status: 'DRAFT' }, REQUEST_ID));
    ({ policy } = await updatePolicy(conn, c, policy.id, { ...POLICY, rules: ruleInputs }, REQUEST_ID));
    report.policyAction = 'created';
  } else {
    ({ policy } = await getPolicy(conn, companyId, found.id));
    const fieldsSame = policy.name === POLICY.name && (policy.description ?? null) === POLICY.description && policy.yearStartsMonth === POLICY.yearStartsMonth
      && policy.effectiveFrom === POLICY.effectiveFrom && policy.status === POLICY.status;
    const rulesSame = policy.rules.length === wanted.length && wanted.every((w, i) => sameRule(w, policy.rules[i]));
    if (fieldsSame && rulesSame) report.policyAction = 'already as wanted';
    else {
      ({ policy } = await updatePolicy(conn, c, policy.id, { ...POLICY, rules: ruleInputs }, REQUEST_ID));
      report.policyAction = `updated (${[fieldsSame ? null : 'fields', rulesSame ? null : 'rules'].filter(Boolean).join(' and ')})`;
    }
  }
  report.policy = policy;

  // ── 3. by role: every non-worker role without a policy of its own ──
  const [roles] = await conn.query('SELECT id, title FROM hrms_roles WHERE company_id = ? AND deleted_at IS NULL ORDER BY title, id', [companyId]);
  const index = await loadAssignmentIndex(conn, companyId, { labels: false });
  for (const r of roles) {
    const own = index.byRole.get(r.id) ?? null;
    if (isWorker(r.title)) {
      // A worker role that carries THIS policy (assigned before it was named a worker) loses it.
      if (own && own.id === policy.id) { await putAssignment(conn, c, { scope: 'ROLE', roleId: r.id, policyId: null }, REQUEST_ID); report.unassigned.push(r); }
      report.workers.push(r);
      continue;
    }
    if (own && own.id === policy.id) { report.alreadyAssigned.push(r); continue; }
    if (own) { report.elsewhere.push({ ...r, policy: own.name }); continue; }
    await putAssignment(conn, c, { scope: 'ROLE', roleId: r.id, policyId: policy.id }, REQUEST_ID);
    report.assigned.push(r);
  }
  return report;
}

async function main() {
  const slug = arg('company') ?? 'karni';
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    const [[company]] = await conn.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
    if (!company) throw new Error(`no company "${slug}"`);
    // The actor of the audit rows: the company's first admin login of cf_hrms.
    const [[actor]] = await conn.query(
      `SELECT u.id FROM users u
         JOIN app_user_access aua ON aua.user_id = u.id AND aua.deleted_at IS NULL
         JOIN apps a ON a.id = aua.app_id AND a.slug = 'cf_hrms' AND a.company_id = u.company_id AND a.deleted_at IS NULL
         JOIN roles r ON r.id = aua.role_id
        WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [company.id]);
    console.log(`  company: ${company.name} (${company.id})${APPLY ? '' : '   DRY RUN — the same transaction, rolled back'}\n`);

    await conn.beginTransaction();
    let report;
    try {
      report = await setupExecLeave(conn, company.id, { userId: actor?.id ?? null });
      if (APPLY) await conn.commit(); else await conn.rollback();
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    }

    const p = report.policy;
    console.log('  LEAVE TYPES');
    for (const line of report.types) console.log(`    ${line}`);
    console.log(`\n  POLICY  ${p.name} · ${p.code} · ${p.status} · leave year from month ${p.yearStartsMonth} · takes effect ${p.effectiveFrom} — ${report.policyAction}`);
    for (const r of p.rules) console.log(`    ${r.leaveTypeCode.padEnd(4)}${r.leaveTypeName}: ${r.summary}${r.notes ? `\n          note: ${r.notes}` : ''}`);
    const list = (title, rows, extra = () => '') => {
      console.log(`\n  ${title} — ${rows.length}`);
      for (const r of rows) console.log(`    ${r.title}${extra(r)}`);
    };
    list(APPLY ? 'ASSIGNED NOW' : 'WOULD BE ASSIGNED', report.assigned);
    list('ALREADY ASSIGNED THIS POLICY', report.alreadyAssigned);
    list(APPLY ? 'TAKEN OFF NOW (worker roles that had this policy)' : 'WOULD BE TAKEN OFF (worker roles that have this policy)', report.unassigned);
    list('SKIPPED — WORKER ROLES', report.workers);
    list('SKIPPED — ALREADY HAVE ANOTHER POLICY (not touched; decide by hand)', report.elsewhere, (r) => `  (${r.policy})`);
    console.log(APPLY ? '\n  APPLIED.\n' : '\n  nothing written. Run again with --apply.\n');
  } finally {
    await conn.end();
  }
}

if (process.argv[1] && /setup-karni-exec-leave\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
}
