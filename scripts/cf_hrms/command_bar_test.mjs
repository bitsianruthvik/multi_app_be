/**
 * command_bar_test.mjs — "Do it in words" (CF_HRMS_HIRING_SPEC.md §14).
 *
 *   [1] the reader on everyday requests a Karni HR person might type: single
 *       actions, two-to-four-step plans, steps that refer to earlier ones,
 *       typos, a name matching two people, quoted text, words it cannot read.
 *       Each case has the plan it should produce; the run reports the hit rate
 *       honestly — fully right / right after one correction / wrong — and lists
 *       every miss. The suite FAILS if fully-right drops below the floor set
 *       below (a regression guard, not a boast).
 *   [2] check: rights (a login without the right gets a problem on that step),
 *       department scope (outside is a problem, inside is not, roles are
 *       company-wide), a service refusal found by the trial run;
 *   [3] apply in a rolled-back transaction: a 4-step plan builds everything,
 *       codes issued by the generator, one audit group; a failure in step 3
 *       writes nothing (through the real transaction);
 *   [4] the reader does not load the model for plain cue words;
 *   [5] over HTTP: Employee 403, admin read/check, a plan with problems is 422.
 *
 *   node scripts/cf_hrms/command_bar_test.mjs [--verbose]
 *
 * No real person's name is in this file: employees are picked from the
 * database at run time and only referred to as {E1}, {E2}. Local only; every
 * write is rolled back or refused, and the end re-counts the tables.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import hrmsApp from '../../apps/cf_hrms/app.js';
import { PERM } from '../../apps/cf_hrms/lib/http.js';
import { loadRecords } from '../../apps/cf_hrms/services/commands/records.js';
import { readCommand } from '../../apps/cf_hrms/services/commands/reader.js';
import { checkPlan, applyPlan } from '../../apps/cf_hrms/services/commands/plan.js';
import { unload, modelStatus } from '../../apps/cf_hrms/services/semantic/embedder.js';

const VERBOSE = process.argv.includes('--verbose');
const FULLY_RIGHT_FLOOR = 0.8;
if (!['localhost', '127.0.0.1', '::1'].includes(String(process.env.DB_HOST ?? 'localhost'))) {
  console.error(`Refusing to run against DB_HOST=${process.env.DB_HOST}. This test is local only.`);
  process.exit(2);
}

let passed = 0;
const failed = [];
const ok = (cond, name, detail = '') => {
  if (cond) { passed += 1; if (VERBOSE) console.log(`  ok    ${name}`); } else { failed.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  return Boolean(cond);
};
const section = (t) => console.log(`\n${t}`);

const [[company]] = await pool.query("SELECT id FROM companies WHERE slug = 'karni' AND deleted_at IS NULL");
if (!company) { console.error('No company "karni".'); process.exit(2); }
const COMPANY = company.id;
const TAG = `Zz${Date.now().toString(36).slice(-5)}`;
const [[admin]] = await pool.query(
  `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [COMPANY]);
const OWNER = { companyId: COMPANY, userId: admin.id, can: () => true, scope: { all: true } };

const counts = async () => {
  const out = {};
  for (const t of ['hrms_departments', 'hrms_roles', 'hrms_positions', 'hrms_role_kra_assignments', 'hrms_kra_definitions', 'hrms_role_responsibility_assignments', 'hrms_work_assignments', 'hrms_position_reporting_relationships', 'hrms_employees']) {
    const [[r]] = await pool.query(`SELECT COUNT(*) n FROM ${t} WHERE company_id = ?`, [COMPANY]);
    out[t] = r.n;
  }
  return JSON.stringify(out);
};
const before = await counts();

/* ── the people and places the cases use, chosen at run time ───────────── */
const recs = await loadRecords(pool, COMPANY, {});
/**
 * A position found by its ROLE's title (and department), the n-th by code — never by a code written
 * here: codes are issued by the generator and Karni's were renumbered (recode-company.mjs, 2026-10-16).
 */
const byRole = (roleTitle, n = 1, departmentName = null) => {
  const role = recs.roles.find((r) => r.name === roleTitle);
  const dept = departmentName ? recs.departments.find((d) => d.name === departmentName) : null;
  const list = recs.positions
    .filter((p) => role && p.roleId === role.id && (!departmentName || (dept && p.departmentId === dept.id)))
    .sort((a, b) => String(a.code).localeCompare(String(b.code), 'en', { numeric: true }));
  if (!list[n - 1]) throw new Error(`No position #${n} of role "${roleTitle}"${departmentName ? ` in ${departmentName}` : ''} — the cases need local Karni's data.`);
  return list[n - 1];
};
const vacant = byRole('Helper 1', 1, 'Shared · IBC 1 + IBC 2 + IBC 3');   // was P211-1
/** The positions the cases name by code: placeholder -> position. */
const POS = {
  '{LAM1}': byRole('Operator - Production (Lamination · Raulimex)', 1),   // was P124-1
  '{LAM2}': byRole('Operator - Production (Lamination · Raulimex)', 2),   // was P124-2
  '{BFL1}': byRole('Operator - Production (BFL)', 1),                      // was P159-1
  '{BFL2}': byRole('Operator - Production (BFL)', 2),                      // was P159-2
  '{MAINT}': byRole('Manager - Maintenance', 1),                           // was P040
  '{PRODMGR}': byRole('Production Manager', 1),                            // was P020
  '{QCINCH}': byRole('Incharge - Quality (Systems & Complaints)', 1),            // was P208
  '{PLAN}': byRole('Deputy Manager - Planning', 1),                        // was P098
};
const placed = recs.employees.filter((e) => e.positionId && e.name.split(' ').length >= 2 && Math.max(...e.name.split(' ').map((w) => w.length)) >= 6);
const [E1, E2, E3] = placed;
const typo = (name) => {
  const ws = name.split(' ');
  const i = ws.reduce((b, w, k) => (w.length > ws[b].length ? k : b), 0);
  const w = ws[i];
  ws[i] = w.slice(0, 2) + w[3] + w[2] + w.slice(4);   // swap two letters
  return ws.join(' ');
};
/** Never print a real person's name or code: put the placeholders back. */
const hide = (s) => [[E1, "{E1}"], [E2, "{E2}"], [E3, "{E3}"]].reduce((t, [e, k]) => { let x = t.split(e.name).join(k).split(typo(e.name)).join(`${k}typo`); if (e.code) x = x.split(e.code).join(`${k}code`); return x; }, String(s));
const fill = (s) => s
  .replaceAll('{E1}', E1.name).replaceAll('{E2}', E2.name).replaceAll('{E3}', E3.name)
  .replaceAll('{E1typo}', typo(E1.name)).replaceAll('{E1code}', E1.code ?? E1.name)
  .replaceAll('{VAC}', vacant.code).replaceAll('{TAG}', TAG)
  .replace(/\{[A-Z0-9]+\}/g, (k) => POS[k]?.code ?? k);

/* ── [1] the reader ────────────────────────────────────────────────────── */
// Expectations per step: action, then fields — 'text' compares new text (any case),
// 'Name' compares the record's name, 'code:X' a position's code, 'step:sN' a
// reference to an earlier step, '?' "candidates offered, none picked", '-' absent.
const CASES = [
  ['add a department called Quality Assurance', [['add_department', { name: 'Quality Assurance', label: 'Department', under: '-' }]]],
  ['create a new section Ink Kitchen under Printing', [['add_department', { name: 'Ink Kitchen', label: 'Section', under: 'Printing' }]]],
  ['add the Tool Room section in Maintenance', [['add_department', { name: 'Tool Room', label: 'Section', under: 'Maintenance' }]]],
  ['add a machine Slitter 3 under Slitting', [['add_department', { name: 'Slitter 3', label: 'Machine', under: 'Slitting' }]]],
  ['add department "Customer Service" under Sales & Marketing', [['add_department', { name: 'Customer Service', label: 'Department', under: 'Sales & Marketing' }]]],
  ['we need a Safety department under Operations', [['add_department', { name: 'Safety', under: 'Operations' }]]],
  ['add a section named Dispatch Desk under Logistcs', [['add_department', { name: 'Dispatch Desk', label: 'Section', under: 'Logistics' }]]],
  ['add a role called Shift Supervisor', [['add_role', { title: 'Shift Supervisor' }]]],
  ['create a new role Safety Officer with purpose keep the plant safe', [['add_role', { title: 'Safety Officer', purpose: 'Keep the plant safe' }]]],
  ['add role "Export Coordinator"', [['add_role', { title: 'Export Coordinator' }]]],
  ['add a KRA Customer complaints to the Production Manager role', [['add_kra', { text: 'Customer complaints', role: 'Production Manager' }]]],
  ['add KRA "Energy saving" for Manager - Maintenance', [['add_kra', { text: 'Energy saving', role: 'Manager - Maintenance' }]]],
  ['give the Manager - PPC role a KRA Planning accuracy', [['add_kra', { text: 'Planning accuracy', role: 'Manager - PPC' }]]],
  ['add a KRA Cost control to the Purchse Manager role', [['add_kra', { text: 'Cost control', role: 'Manager - Purchase & Stores' }]]],
  ['add responsibility "Prepare the daily production report" to Production Manager', [['add_responsibility', { text: 'Prepare the daily production report', role: 'Production Manager', position: '-' }]]],
  ['add a responsibility check ink viscosity every hour to Operator - Production (Printing)', [['add_responsibility', { text: 'Check ink viscosity every hour', role: 'Operator - Production (Printing)' }]]],
  ['the Production Manager should also review the daily wastage report', [['add_responsibility', { text: 'Review the daily wastage report', role: 'Production Manager' }]]],
  ['make the Manager - HR responsible for joining formalities', [['add_responsibility', { text: 'Joining formalities', role: 'Manager - HR' }]]],
  ['only for position {LAM1} add the responsibility look after the rewinder', [['add_responsibility', { text: 'Look after the rewinder', position: 'code:{LAM1}', role: '-' }]]],
  ['add a duty to {BFL1}: inspect the rolls before dispatch', [['add_responsibility', { text: 'Inspect the rolls before dispatch', position: 'code:{BFL1}' }]]],
  ['add responsibility train new helpers under the KRA Manpower & team for Production Manager', [['add_responsibility', { text: 'Train new helpers', role: 'Production Manager', kra: 'Manpower & team' }]]],
  ['add a responsiblity to the Forklift Driver: check tyre pressure daily', [['add_responsibility', { text: 'Check tyre pressure daily', role: 'Forklift Driver' }]]],
  ['add KPI "On-time dispatch %" target 98% for Manager - PPC', [['add_kpi', { text: 'On-time dispatch %', target: '98%', role: 'Manager - PPC' }]]],
  ['add a KPI machine downtime hours with a target of 2 to Manager - Maintenance', [['add_kpi', { text: 'Machine downtime hours', target: '2', role: 'Manager - Maintenance' }]]],
  ['measure the Forklift Driver on fuel used per month', [['add_kpi', { text: 'Fuel used per month', role: 'Forklift Driver' }]]],
  ['add a KPI for {BFL1}: rolls produced per shift, target 40', [['add_kpi', { text: 'Rolls produced per shift', target: '40', position: 'code:{BFL1}' }]]],
  ['add a position Officer - Quality in Quality', [['add_position', { role: 'Officer - Quality', department: 'Quality', shift: '-' }]]],
  ['add another Helper position in Slitting on the night shift', [['add_position', { role: 'Helper', department: 'Slitting', shift: 'Night' }]]],
  ['open a vacancy for an Electrician in Maintenance reporting to {MAINT}', [['add_position', { role: 'Electrician', department: 'Maintenance', reportsTo: 'code:{MAINT}' }]]],
  ['add a new post of Security in Security, night shift', [['add_position', { role: 'Security', department: 'Security', shift: 'Night' }]]],
  ['move {BFL2} to the day shift', [['change_shift', { position: 'code:{BFL2}', shift: 'Day' }]]],
  ['change the shift of {LAM2} to Night', [['change_shift', { position: 'code:{LAM2}', shift: 'Night' }]]],
  ['put the Forklift Driver position on the general shift', [['change_shift', { position: 'Forklift Driver', shift: 'General' }]]],
  ['put {E1} in {VAC}', [['place_person', { employee: '{E1}', position: `code:${'{VAC}'}` }]]],
  ['move {E1} to position {VAC} from 1 December 2026', [['place_person', { employee: '{E1}', position: 'code:{VAC}', from: '2026-12-01' }]]],
  ['assign {E1code} to {VAC} with effect from 2026-12-01', [['place_person', { employee: '{E1}', position: 'code:{VAC}', from: '2026-12-01' }]]],
  ['put {E1typo} in {VAC}', [['place_person', { employee: '{E1}', position: 'code:{VAC}' }]]],
  ['place {E2} as Deputy Manager - Planning in PPC', [['place_person', { employee: '{E2}', position: 'code:{PLAN}' }]]],
  ['add a Quality Control section under Production and add a position Officer - Quality in it', [
    ['add_department', { name: 'Quality Control', label: 'Section', under: 'Production' }],
    ['add_position', { role: 'Officer - Quality', department: 'step:s1' }]]],
  ['create a new role called Line Leader, then add a position for Line Leader in Printing reporting to {PRODMGR}', [
    ['add_role', { title: 'Line Leader' }],
    ['add_position', { role: 'step:s1', department: 'Printing', reportsTo: 'code:{PRODMGR}' }]]],
  ['add a section Dispatch Desk under Logistics; add a role Dispatch Clerk; add a position Dispatch Clerk in Dispatch Desk; put {E1} in it', [
    ['add_department', { name: 'Dispatch Desk', label: 'Section', under: 'Logistics' }],
    ['add_role', { title: 'Dispatch Clerk' }],
    ['add_position', { role: 'step:s2', department: 'step:s1' }],
    ['place_person', { employee: '{E1}', position: 'step:s3' }]]],
  ['add a role Trainee Operator and add a KRA Learning the machine to it', [
    ['add_role', { title: 'Trainee Operator' }],
    ['add_kra', { text: 'Learning the machine', role: 'step:s1' }]]],
  ['add role "Energy Auditor", give it a KRA Power savings and add a KPI units saved per month to Energy Auditor', [
    ['add_role', { title: 'Energy Auditor' }],
    ['add_kra', { text: 'Power savings', role: 'step:s1' }],
    ['add_kpi', { text: 'Units saved per month', role: 'step:s1' }]]],
  ['add a section Ink Room under Printing and a position Operator - Production (Ink) there', [
    ['add_department', { name: 'Ink Room', label: 'Section', under: 'Printing' }],
    ['add_position', { role: 'Operator - Production (Ink)', department: 'step:s1' }]]],
  ['add a position Helper in Lamination on the night shift then move {E2} to it', [
    ['add_position', { role: 'Helper', department: 'Lamination', shift: 'Night' }],
    ['place_person', { employee: '{E2}', position: 'step:s1' }]]],
  // Written AFTER the reader was tuned on the cases above, and kept as they first scored ("fresh").
  ['Create a department named Training Centre under HR & Admin', [['add_department', { name: 'Training Centre', label: 'Department', under: 'HR & Admin' }]], 'fresh'],
  ['new section "Gravure Proofing" under Printing', [['add_department', { name: 'Gravure Proofing', label: 'Section', under: 'Printing' }]], 'fresh'],
  ['please add a role Junior Chemist', [['add_role', { title: 'Junior Chemist' }]], 'fresh'],
  ['Add KRA Statutory compliance to Manager - HR', [['add_kra', { text: 'Statutory compliance', role: 'Manager - HR' }]], 'fresh'],
  ['add a responsibility to Senior Manager - HR: approve the annual training calendar', [['add_responsibility', { text: 'Approve the annual training calendar', role: 'Senior Manager - HR' }]], 'fresh'],
  ['Store Supervisor - Films should check the film rolls for damage on arrival', [['add_responsibility', { text: 'Check the film rolls for damage on arrival', role: 'Store Supervisor - Films' }]], 'fresh'],
  ['add kpi Scrap sold per month to Store Supervisor - Scrap with target 10 tonnes', [['add_kpi', { text: 'Scrap sold per month', role: 'Store Supervisor - Scrap', target: '10 tonnes' }]], 'fresh'],
  ['add one more Electrician position in Maintenance', [['add_position', { role: 'Electrician', department: 'Maintenance' }]], 'fresh'],
  ['Open a new position for Executive - IT in MIS on general shift', [['add_position', { role: 'Executive - IT', department: 'MIS', shift: 'General' }]], 'fresh'],
  ['switch {QCINCH} to night shift', [['change_shift', { position: 'code:{QCINCH}', shift: 'Night' }]], 'fresh'],
  ['transfer {E2} into {VAC}', [['place_person', { employee: '{E2}', position: 'code:{VAC}' }]], 'fresh'],
  ['add a section Quality Lab under Quality, add a role Lab Chemist and add a position Lab Chemist in Quality Lab', [
    ['add_department', { name: 'Quality Lab', label: 'Section', under: 'Quality' }],
    ['add_role', { title: 'Lab Chemist' }],
    ['add_position', { role: 'step:s2', department: 'step:s1' }]], 'fresh'],
  ['add a KRA Housekeeping to the Housekeeping Staff role and a KPI cleanliness score to it', [
    ['add_kra', { text: 'Housekeeping', role: 'Housekeeping Staff' }],
    ['add_kpi', { text: 'Cleanliness score', role: 'Housekeeping Staff' }]], 'fresh'],
  ['make {E3} the Deputy Manager - Planning', [['place_person', { employee: '{E3}', position: 'code:{PLAN}' }]], 'fresh'],
  ['please sort out the canteen menu for next week', [[null, {}]]],
  ['add a KRA Customer complaints to the Production Manager role and asdf qwerty zxcv', [
    ['add_kra', { text: 'Customer complaints', role: 'Production Manager' }], [null, {}]]],
];

/** Compare one field; -> true / false. */
function fieldRight(kind, f, want) {
  want = fill(want);
  if (want === '-') return !f || (f.value == null && !f.ref && !f.fromText);
  if (want === '?') return Boolean(f && !f.ref && f.candidates?.length);
  if (!f) return false;
  if (want.startsWith('step:')) return f.ref?.kind === 'step' && f.ref.id === want.slice(5);
  if (want.startsWith('code:')) return f.ref?.kind === 'position' && recs.positionById.get(f.ref.id)?.code === want.slice(5);
  if (f.ref && f.ref.kind !== 'step') {
    const list = { department: recs.departments, role: recs.roles, position: recs.positions, employee: recs.employees, shift: recs.shifts }[f.ref.kind] ?? [];
    const r = list.find((x) => x.id === f.ref.id);
    if (r) return r.name.toLowerCase() === want.toLowerCase();
    return String(f.ref.label ?? '').toLowerCase() === want.toLowerCase();
  }
  return String(f.value ?? '').trim().toLowerCase() === want.trim().toLowerCase();
}

async function scoreCase(text, expect, recsFor = recs) {
  const r = await readCommand(fill(text), recsFor, { useModel: true });
  let wrong = 0;
  const misses = [];
  const steps = r.plan.steps;
  if (steps.length !== expect.length) {
    wrong += Math.abs(steps.length - expect.length) + 1;
    misses.push(`${steps.length} steps, expected ${expect.length}`);
  }
  expect.forEach(([action, fields], i) => {
    const s = steps[i];
    if (!s) return;
    if ((s.action ?? null) !== action) { wrong += 1; misses.push(`step ${i + 1}: ${s.action} instead of ${action}`); return; }
    for (const [name, want] of Object.entries(fields)) {
      if (!fieldRight(name, s.fields[name], want)) {
        wrong += 1;
        const f = s.fields[name];
        misses.push(`step ${i + 1} ${name}: got ${f?.ref ? `[${f.ref.label}]` : f?.value != null ? `"${f.value}"` : f?.candidates?.length ? `${f.candidates.length} candidates` : 'nothing'}, wanted ${fill(want)}`);
      }
    }
  });
  return { r, wrong, misses };
}

section('[1] The reader on everyday requests');
const tally = { right: 0, oneFix: 0, wrong: 0 };
const fresh = { right: 0, oneFix: 0, wrong: 0 };
const missesAll = [];
const times = [];
await unload();
for (const [text, expect, tag] of CASES) {
  const { r, wrong, misses } = await scoreCase(text, expect);
  if (tag === 'fresh') fresh[wrong === 0 ? 'right' : wrong === 1 ? 'oneFix' : 'wrong'] += 1;
  times.push(r.stats.ms);
  if (wrong === 0) tally.right += 1;
  else if (wrong === 1) { tally.oneFix += 1; missesAll.push(hide(`ONE FIX  ${text}: ${misses.join('; ')}`)); }
  else { tally.wrong += 1; missesAll.push(hide(`WRONG    ${text}: ${misses.join('; ')}`)); }
  if (VERBOSE) console.log(hide(`  ${wrong === 0 ? 'right' : wrong === 1 ? '1 fix' : 'WRONG'}  ${text}${misses.length ? `  — ${misses.join('; ')}` : ''}`) + `  (${r.stats.ms} ms${r.stats.modelUsed ? ', model' : ''})`);
}

// A name that matches two people: the same name given to a made-up second person (rolled back).
let twoPeople = false;
{
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      "INSERT INTO hrms_employees (company_id, employee_code, full_name, employment_status, date_of_joining) VALUES (?, ?, ?, 'ACTIVE', CURDATE())",
      [COMPANY, `${TAG}-DUP`, E3.name]);
    const recs2 = await loadRecords(conn, COMPANY, {});
    const twin = recs2.employees.find((e) => e.code === `${TAG}-DUP`);
    recs2.employees = recs2.employees.map((e) => e);   // the twin holds no position, so it is in scope for an owner
    const { wrong, misses } = await scoreCase(`put ${E3.name} in {VAC}`, [['place_person', { employee: '?', position: 'code:{VAC}' }]], recs2);
    const step = (await readCommand(fill(`put ${E3.name} in {VAC}`), recs2)).plan.steps[0];
    twoPeople = Boolean(twin) && step.fields.employee?.candidates?.length >= 2;
    if (wrong === 0) tally.right += 1; else if (wrong === 1) { tally.oneFix += 1; missesAll.push(`ONE FIX  two people: ${misses.join('; ')}`); } else { tally.wrong += 1; missesAll.push(`WRONG    two people: ${misses.join('; ')}`); }
  } finally {
    await conn.rollback();
    conn.release();
  }
}
ok(twoPeople, 'a name matching two people offers both and picks neither');

const total = tally.right + tally.oneFix + tally.wrong;
const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
console.log(`\n  READER HIT RATE on ${total} requests: fully right ${tally.right} (${Math.round(100 * tally.right / total)}%), right after one correction ${tally.oneFix}, wrong ${tally.wrong}. Average read ${avg} ms, slowest ${Math.max(...times)} ms.`);
console.log(`  of which the ${fresh.right + fresh.oneFix + fresh.wrong} FRESH requests: fully right ${fresh.right}, one correction ${fresh.oneFix}, wrong ${fresh.wrong}.`);
for (const m of missesAll) console.log(`    ${m}`);
ok(total >= 40, `at least 40 requests (${total})`);
ok(tally.right / total >= FULLY_RIGHT_FLOOR, `fully right at least ${FULLY_RIGHT_FLOOR * 100}%`, `${tally.right}/${total}`);
{
  const r = await readCommand('please sort out the canteen menu for next week', recs);
  ok(r.notUnderstood.length === 1 && r.plan.steps[0].action === null, 'a request it cannot read is "not understood", with the words kept');
  const q = await readCommand('add role "Head - Quality & Safety, Unit 2"', recs);
  ok(q.plan.steps.length === 1 && q.plan.steps[0].fields.title?.value === 'Head - Quality & Safety, Unit 2', 'quoted text is taken word for word, commas and "&" included');
}

/* ── [2] check: rights, scope, the trial ───────────────────────────────── */
section('[2] Check: rights, scope and the trial run');
{
  const plan = (await readCommand(`add a role ${TAG} Planner and add a position ${TAG} Planner in PPC`, recs)).plan.steps;
  const noRoles = { ...OWNER, can: (t) => t !== PERM.roles.edit };
  const c1 = await checkPlan(pool, noRoles, plan);
  ok(!c1.clean && c1.steps[0].problems.some((p) => /right to add roles/.test(p)) && !c1.steps[1].problems.some((p) => /right/.test(p)),
    'a login without the roles right: a problem on the role step only', JSON.stringify(c1.steps.map((s) => s.problems)));
  const c2 = await checkPlan(pool, OWNER, plan);
  ok(c2.clean, 'the owner: clean (trial run included)', JSON.stringify(c2.steps.map((s) => s.problems)));
  ok(c2.preview.roles.length === 1 && c2.preview.positions.length === 1 && c2.preview.positions[0].roleKey === 's1', 'the preview shows the new role and its new position');

  const production = recs.departments.find((d) => d.name === 'Production');
  const subtree = new Set([production.id]);
  let grew = true;
  while (grew) { grew = false; for (const d of recs.departments) if (d.parentId != null && subtree.has(d.parentId) && !subtree.has(d.id)) { subtree.add(d.id); grew = true; } }
  const scoped = { ...OWNER, can: () => true, scope: { all: false, departmentIds: subtree, rootIds: [production.id] } };
  const sRecs = await loadRecords(pool, COMPANY, { scope: scoped.scope });
  ok(sRecs.employees.length < recs.employees.length, `a department-scoped login is offered only its own people (${sRecs.employees.length} of ${recs.employees.length})`);
  const outside = (await readCommand('add a position Helper in Accounts', sRecs)).plan.steps;
  const c3 = await checkPlan(pool, scoped, outside, { tryRun: false });
  ok(c3.steps[0].problems.some((p) => /outside your department/.test(p)), 'scoped: a position in another department is a problem');
  const inside = (await readCommand('add a position Helper in Slitting', sRecs)).plan.steps;
  const c4 = await checkPlan(pool, scoped, inside, { tryRun: false });
  ok(c4.clean, 'scoped: inside its own departments is fine', JSON.stringify(c4.steps[0].problems));
  const c5 = await checkPlan(pool, scoped, (await readCommand(`add a role ${TAG} X`, sRecs)).plan.steps, { tryRun: false });
  ok(c5.steps[0].problems.some((p) => /whole company/.test(p)), 'scoped: a role is company-wide, so it is a problem');
  const c6 = await checkPlan(pool, scoped, (await readCommand(`add a section ${TAG} S under Accounts`, sRecs)).plan.steps, { tryRun: false });
  ok(c6.steps[0].problems.some((p) => /outside your department/.test(p)), 'scoped: a section under another department is a problem');

  // The trial run finds what only the service knows: the same KRA twice on a new role.
  const dup = (await readCommand(`add a role ${TAG} Twin; add a KRA Output to ${TAG} Twin; add a KRA Output to ${TAG} Twin`, recs)).plan.steps;
  const c7 = await checkPlan(pool, OWNER, dup);
  ok(!c7.clean && c7.steps[2].problems.some((p) => /already has the KRA/i.test(p)) && !c7.steps[0].problems.length,
    'the trial run puts a service refusal on the step that caused it', JSON.stringify(c7.steps.map((s) => s.problems)));
}

/* ── [3] apply ─────────────────────────────────────────────────────────── */
section('[3] Apply');
{
  const text = `add a section ${TAG} Desk under Logistics; add a role ${TAG} Clerk; add a position ${TAG} Clerk in ${TAG} Desk on the day shift; put {E1} in it`;
  const steps = (await readCommand(fill(text), recs)).plan.steps;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const checked = await checkPlan(pool, OWNER, steps, { conn });
    ok(checked.clean, '4-step plan: clean', JSON.stringify(checked.steps.map((s) => s.problems)));
    const res = await applyPlan(pool, OWNER, steps, { conn, text: fill(text) });
    const [dept, role, position, move] = res.created;
    ok(res.created.length === 4, 'all four steps done');
    ok(dept?.code && role?.code && position?.code, `codes issued by the generator: ${dept?.code}, ${role?.code}, ${position?.code}`);
    const [[d]] = await conn.query('SELECT name, department_type, parent_department_id FROM hrms_departments WHERE id = ?', [dept.id]);
    ok(d?.department_type === 'Section' && d.parent_department_id === recs.departments.find((x) => x.name === 'Logistics').id, 'the section is under Logistics');
    const [[p]] = await conn.query('SELECT role_id, department_id, default_shift_id, status FROM hrms_positions WHERE id = ?', [position.id]);
    ok(p?.role_id === role.id && p.department_id === dept.id && p.default_shift_id === recs.shifts.find((s) => s.name === 'Day').id && p.status === 'ACTIVE',
      'the position is of the new role, in the new section, on the day shift');
    const [[wa]] = await conn.query(
      "SELECT COUNT(*) n FROM hrms_work_assignments WHERE company_id = ? AND employee_id = ? AND position_id = ? AND deleted_at IS NULL AND status <> 'ENDED'",
      [COMPANY, E1.id, position.id]);
    ok(Number(wa.n) === 1 && move?.kind === 'move', 'and the person is in it');
    const [audit] = await conn.query('SELECT entity_type FROM hrms_audit_log WHERE company_id = ? AND request_id = ?', [COMPANY, res.requestId]);
    ok(audit.some((a) => a.entity_type === 'hrms_command') && audit.length >= 3, `one audit group: ${audit.length} rows under one request id, including the command`);
  } finally {
    await conn.rollback();
    conn.release();
  }

  // A failure in step 3 writes nothing — through the real transaction (no outer one here).
  const bad = (await readCommand(`add a role ${TAG} Fail; add a KRA Output to ${TAG} Fail; add a KRA Output to ${TAG} Fail; add a position ${TAG} Fail in PPC`, recs)).plan.steps;
  let err = null;
  try { await applyPlan(pool, OWNER, bad); } catch (e) { err = e; }
  ok(err?.status === 422 && err.code === 'STEP_FAILED' && err.detail?.step === 3, 'step 3 fails: 422, and it says which step', `${err?.status} ${err?.code} ${err?.message}`);
  const [[left]] = await pool.query('SELECT COUNT(*) n FROM hrms_roles WHERE company_id = ? AND title LIKE ?', [COMPANY, `${TAG}%`]);
  ok(Number(left.n) === 0, 'and nothing was written — not even the role of step 1');

  const unclear = (await readCommand('add a position Helper in', recs)).plan.steps;
  let e2 = null;
  try { await applyPlan(pool, OWNER, unclear); } catch (e) { e2 = e; }
  ok(e2?.status === 422 && e2.code === 'PLAN_NOT_CLEAR', 'a plan with problems is refused before anything runs');
}

/* ── [4] the model is not loaded for nothing ───────────────────────────── */
section('[4] The model only when needed');
{
  await unload();
  const r = await readCommand('add a role called Shift Supervisor and add a position for it in Printing', recs);
  ok(!r.stats.modelUsed && !modelStatus().loaded, 'plain cue words: the model is not loaded');
  const m = await readCommand('Printing could do with someone who keeps an eye on ink stock', recs);
  ok(m.stats.modelUsed || m.notice, 'words with no cue: the model is asked (or the notice says why not)');
}

/* ── [5] HTTP ──────────────────────────────────────────────────────────── */
section('[5] Over HTTP');
{
  const server = express();
  server.use(express.json());
  server.use(cookieParser());
  server.use('/api', appContext);
  hrmsApp.register(server);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  const base = `http://127.0.0.1:${listener.address().port}/api/karni/cf_hrms`;
  const tokenFor = async (where) => {
    const [[u]] = await pool.query(
      `SELECT u.id, u.email, u.company_id, co.slug, r.name AS role FROM users u JOIN companies co ON co.id = u.company_id
         LEFT JOIN roles r ON r.id = u.role_id WHERE u.deleted_at IS NULL AND ${where} ORDER BY u.id LIMIT 1`);
    return u ? signToken({ id: u.id, email: u.email, role: u.role, company: u.slug, companyId: u.company_id, company_id: u.company_id, uiPermissions: [] }) : null;
  };
  const call = async (token, method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, json };
  };
  try {
    const hasApp = "EXISTS (SELECT 1 FROM app_user_access x JOIN apps a ON a.id = x.app_id WHERE x.user_id = u.id AND x.deleted_at IS NULL AND a.slug = 'cf_hrms')";
    const adminT = await tokenFor(`u.company_id = ${COMPANY} AND LOWER(r.name) = 'admin' AND ${hasApp}`);
    const empT = await tokenFor(`u.company_id = ${COMPANY} AND r.name = 'Employee' AND ${hasApp}`);
    const read = await call(adminT, 'POST', '/commands/read', { text: 'add a position Helper in Slitting on the night shift' });
    ok(read.status === 200 && read.json?.plan?.steps?.[0]?.action === 'add_position', 'admin: read', `${read.status}`);
    const check = await call(adminT, 'POST', '/commands/check', { steps: read.json?.plan?.steps });
    ok(check.status === 200 && check.json?.clean === true && check.json.preview.positions.length === 1, 'admin: check, with a preview', JSON.stringify(check.json)?.slice(0, 200));
    const actions = await call(adminT, 'GET', '/commands/actions');
    ok(actions.status === 200 && actions.json.actions.length === 8, 'the catalogue has the eight actions');
    const bad = await call(adminT, 'POST', '/commands/apply', { steps: [{ id: 's1', action: 'add_position', fields: {} }] });
    ok(bad.status === 422, 'apply of a plan with problems: 422');
    if (empT) {
      const got = await Promise.all([['POST', '/commands/read', { text: 'x' }], ['POST', '/commands/check', { steps: [] }], ['POST', '/commands/apply', { steps: [] }], ['GET', '/commands/actions']]
        .map(([m, p, b]) => call(empT, m, p, b)));
      ok(got.every((g) => g.status === 403), 'an Employee login: 403 on all four', got.map((g) => g.status).join(','));
    }
  } finally {
    await new Promise((r) => listener.close(r));
  }
}

section('[end] Nothing left behind');
ok(await counts() === before, 'the tables are as found');
await unload();
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
