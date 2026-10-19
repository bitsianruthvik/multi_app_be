/**
 * team_scope_test.mjs — what an employee login may change (2026-10-11).
 * Contract: TM/CF_HRMS_HIRING_SPEC.md §7. Written to break the rule, not to
 * show it working.
 *
 * THE FIXTURE (built in a transaction, rolled back; every name carries a tag):
 *
 *        top                    <- my manager's manager
 *         |
 *        boss                   <- my manager
 *       /    \________________
 *   [ me (Day) | mate (Night) ]  peer (another department)
 *      |             |             |
 *   report1       report2        peerReport
 *      |
 *     sub                        helper = report1's occupant, who has nobody below
 *
 *   "me" is an in-charge. `mate` is the other chair of my card. report2 reports
 *   to the MATE's chair — and is still my team, because a team reports to the card.
 *
 *   1. the rule itself, position by position, for the in-charge;
 *   2. the in-charge CAN: read and change a report's responsibilities and KPIs
 *      (at any depth, under either chair of the card) and its shift — through
 *      the same services as HR, audited with their own user;
 *   3. the in-charge CANNOT: their own position, the card-mate, the manager, the
 *      manager's manager, a peer, a peer's report, another company's position;
 *      KRAs; anything but the shift on the shift route;
 *   4. nobody-below, no-position, left-the-company, not-an-employee: 403 on all;
 *   5. ids: a position that does not exist is 404; another company's reads the same;
 *   6. over HTTP with a real Employee login: the HR routes are still 403, and
 *      the team routes are reachable but answer by the rule.
 *
 *   node scripts/cf_hrms/team_scope_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND: one rolled-back transaction, then read-only HTTP
 * (every write it sends must be refused, and the end proves nothing changed).
 * No password is read or printed; tokens are minted here.
 *
 * Local only — it refuses a non-local DB_HOST.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import hrmsApp from '../../apps/cf_hrms/app.js';
import * as POS from '../../apps/cf_hrms/services/positionService.js';
import * as ASG from '../../apps/cf_hrms/services/assignmentService.js';
import * as ORG from '../../apps/cf_hrms/services/organisationService.js';
import * as TEAM from '../../apps/cf_hrms/services/teamScopeService.js';
import * as EXIT from '../../apps/cf_hrms/services/exitService.js';
import { positionJobContent, seatAddLine } from '../../apps/cf_hrms/services/jobContentService.js';
import { myOrgChart, loadMySlice } from '../../apps/cf_hrms/services/selfOrgChartService.js';
import { buildOrgChart } from '../../apps/cf_hrms/services/orgChartService.js';

const slug = (process.argv.find((a) => a.startsWith('--company=')) || '--company=karni').split('=')[1];
const VERBOSE = process.argv.includes('--verbose');
if (!['localhost', '127.0.0.1', '::1'].includes(String(process.env.DB_HOST ?? 'localhost'))) {
  console.error(`Refusing to run against DB_HOST=${process.env.DB_HOST}. This test is local only.`);
  process.exit(2);
}

let passed = 0;
const failed = [];
const skipped = [];
const ok = (cond, name, detail = '') => {
  if (cond) { passed += 1; if (VERBOSE) console.log(`  ok    ${name}`); } else { failed.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  return Boolean(cond);
};
const skip = (name, reason) => { skipped.push(`${name}: ${reason}`); };
const section = (title) => console.log(`\n${title}`);
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const refused = (e, status, code) => Boolean(e) && e.status === status && e.code === code;
const why = (e) => (e ? `${e.status ?? '?'} ${e.code ?? ''} ${e.message ?? ''}` : 'nothing was thrown');

const [[company]] = await pool.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
if (!company) { console.error(`No company "${slug}".`); process.exit(2); }
const COMPANY = company.id;
const TAG = `ZZTS${Date.now().toString(36).toUpperCase().slice(-5)}`;
const on = POS.today();
const [[adminUser]] = await pool.query(
  `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [COMPANY]);
const hr = { companyId: COMPANY, userId: adminUser?.id ?? null };
const [[other]] = await pool.query('SELECT id, name FROM companies WHERE id <> ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
const OTHER = other.id;

const hrmsTables = (await pool.query(
  /* company tables only (global ones, e.g. hrms_tax_rules, have no company_id) */ "SELECT TABLE_NAME AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'hrms\\_%' AND COLUMN_NAME IN ('company_id', 'deleted_at') GROUP BY TABLE_NAME HAVING COUNT(*) = 2 ORDER BY TABLE_NAME"))[0].map((r) => r.t);
const snapshot = async () => {
  const out = {};
  for (const t of hrmsTables) {
    const [[r]] = await pool.query(`SELECT COUNT(*) AS total, SUM(deleted_at IS NULL) AS live FROM ${t} WHERE company_id IN (?, ?)`, [COMPANY, OTHER]);
    out[t] = `${r.total}/${r.live ?? 0}`;
  }
  out.users = Number((await pool.query('SELECT COUNT(*) AS n FROM users WHERE company_id IN (?, ?)', [COMPANY, OTHER]))[0][0].n);
  return out;
};
const baseline = await snapshot();
console.log(`team_scope_test — ${company.name} (${COMPANY}), run tag ${TAG}, as of ${on}; the other company is ${other.name} (${OTHER})`);

/* ══ the fixture and the service-level checks, in one rolled-back transaction ══ */
const db = await pool.getConnection();
try {
  await db.beginTransaction();

  const [shifts] = await db.query("SELECT id, code FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL AND status = 'ACTIVE' ORDER BY id", [COMPANY]);
  const [[primary]] = await db.query("SELECT id FROM hrms_reporting_relationship_types WHERE company_id = ? AND code = 'PRIMARY_MANAGER' AND deleted_at IS NULL", [COMPANY]);
  if (shifts.length < 2 || !primary) throw new Error('this company needs two active shifts and a PRIMARY_MANAGER relationship type');
  const [dayShift, nightShift] = shifts;

  const role = async (name) => (await db.query("INSERT INTO hrms_roles (company_id, role_code, title, role_purpose, status, created_by) VALUES (?, ?, ?, 'For a test.', 'ACTIVE', ?)", [COMPANY, `${TAG}${name}`, `${TAG} ${name}`, hr.userId]))[0].insertId;
  const dept = async (name) => (await ORG.createDepartment(db, hr, { code: `${TAG}${name}`, name: `${TAG} ${name}` })).id;
  const roles = { top: await role('Top'), boss: await role('Boss'), incharge: await role('Incharge'), crew: await role('Crew'), peer: await role('Peer') };
  const depts = { a: await dept('A'), b: await dept('B') };
  let seq = 0;
  const position = async (roleId, departmentId, shiftId, managerId = null) => {
    seq += 1;
    const p = (await POS.createPosition(db, hr, { roleId, departmentId, positionCode: `${TAG}-${seq}`, status: 'ACTIVE', defaultShiftId: shiftId })).position;
    if (managerId) await POS.addPositionReporting(db, hr, p.id, { toPositionId: managerId, relationshipTypeId: primary.id, isPrimary: true, effectiveFrom: on });
    return p;
  };
  const top = await position(roles.top, depts.a, dayShift.id);
  const boss = await position(roles.boss, depts.a, dayShift.id, top.id);
  const me = await position(roles.incharge, depts.a, dayShift.id, boss.id);
  const mate = await position(roles.incharge, depts.a, nightShift.id, boss.id);       // same role, department, manager: MY CARD
  const peer = await position(roles.peer, depts.b, dayShift.id, boss.id);
  const report1 = await position(roles.crew, depts.a, dayShift.id, me.id);
  const report2 = await position(roles.crew, depts.a, nightShift.id, mate.id);        // under the mate's chair
  const sub = await position(roles.crew, depts.b, dayShift.id, report1.id);           // two levels down
  const peerReport = await position(roles.crew, depts.b, dayShift.id, peer.id);
  const loose = await position(roles.peer, depts.b, dayShift.id);                     // a top of its own: outside every slice here

  let people = 0;
  /** A fixture user (role of a real Employee login), an employee linked to it, seated in `p`. Returns the service context of that login. */
  const [[employeeRole]] = await db.query("SELECT id FROM roles WHERE company_id = ? AND name = 'Employee' AND deleted_at IS NULL LIMIT 1", [COMPANY]);
  const person = async (label, p) => {
    people += 1;
    const [u] = await db.query('INSERT INTO users (name, email, password, role_id, company_id) VALUES (?, ?, ?, ?, ?)',
      [`${TAG} ${label}`, `${TAG.toLowerCase()}-${people}@example.test`, 'not-a-usable-hash', employeeRole?.id ?? null, COMPANY]);
    const [e] = await db.query('INSERT INTO hrms_employees (company_id, employee_code, full_name, date_of_joining, user_id, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [COMPANY, `${TAG}E${people}`, `${TAG} ${label}`, '2020-01-01', u.insertId, hr.userId]);
    let assignmentId = null;
    if (p) assignmentId = (await ASG.createAssignment(db, hr, { employeeId: e.insertId, roleId: p.roleId, positionId: p.id, effectiveFrom: on })).assignment.id;
    return { companyId: COMPANY, userId: u.insertId, employeeId: e.insertId, assignmentId };
  };
  const I = await person('In-charge', me);
  const MATE = await person('Card-mate', mate);
  const BOSS = await person('Boss', boss);
  const HELPER = await person('Helper', report1);          // has `sub` below — used as a second manager
  const LEAF = await person('Leaf', sub);                   // nobody below
  const NOBODY = await person('Unseated', null);            // an employee in no position
  const STRANGER = { companyId: COMPANY, userId: hr.userId };  // a login that is not an employee at all

  const every = { top, boss, me, mate, peer, report1, report2, sub, peerReport, loose };
  const nameOf = (id) => Object.entries(every).find(([, p]) => p.id === id)?.[0] ?? id;

  /* ── 1. the rule, position by position ─────────────────────────────────── */
  section('[1] The rule, position by position');
  const slice = await loadMySlice(db, I, {});
  const editable = Object.values(every).filter((p) => slice.canChange(p.id)).map((p) => nameOf(p.id)).sort();
  ok(JSON.stringify(editable) === JSON.stringify(['report1', 'report2', 'sub']), 'the in-charge may change exactly: report1, report2 (under the card-mate’s chair) and sub (two levels down)', editable.join(', '));
  ok(slice.relationOf(me.id) === 'SELF' && slice.relationOf(mate.id) === 'SAME_CARD' && slice.relationOf(boss.id) === 'MANAGER' && slice.relationOf(top.id) === 'MANAGER'
    && slice.relationOf(peer.id) === null && slice.relationOf(peerReport.id) === null && slice.relationOf(loose.id) === null,
  'own position SELF, the card-mate SAME_CARD, the manager line MANAGER, a peer and a peer’s report not in the slice at all');
  const chart = await myOrgChart(db, I, {});
  const flags = Object.fromEntries(chart.nodes.map((n) => [nameOf(n.id), n.canEdit]));
  ok(chart.nodes.every((n) => typeof n.canEdit === 'boolean') && JSON.stringify(Object.entries(flags).filter(([, v]) => v).map(([k]) => k).sort()) === JSON.stringify(['report1', 'report2', 'sub'])
    && flags.me === false && flags.mate === false && flags.boss === false && flags.top === false && !('peer' in flags),
  'GET /user/me/orgchart: every node has canEdit, true for those three and false for self, card-mate and both managers', JSON.stringify(flags));
  ok(chart.nodes.every((n) => n.canEdit === (n.relation === 'REPORT')) && chart.nodes.every((n) => n.canEdit === slice.canChange(n.id)), 'canEdit on the chart IS the function the writes are checked with — same answer for every node');
  const fromMate = await loadMySlice(db, MATE, {});
  ok(Object.values(every).filter((p) => fromMate.canChange(p.id)).map((p) => nameOf(p.id)).sort().join(',') === 'report1,report2,sub' && fromMate.relationOf(me.id) === 'SAME_CARD',
    'the card-mate has the same team: a team reports to the card');
  const fromBoss = await loadMySlice(db, BOSS, {});
  ok(Object.values(every).filter((p) => fromBoss.canChange(p.id)).map((p) => nameOf(p.id)).sort().join(',') === 'mate,me,peer,peerReport,report1,report2,sub' && !fromBoss.canChange(boss.id) && !fromBoss.canChange(top.id),
    'the manager may change everything below them — and still not themselves or the position above');
  const realChart = await buildOrgChart(db, COMPANY, {});
  ok(realChart.nodes.filter((n) => !Object.values(every).some((p) => p.id === n.id)).every((n) => !slice.canChange(n.id)), `none of the company’s other ${realChart.nodes.length - 10} positions is in the in-charge’s team`);

  /* ── 2. what the in-charge can do ──────────────────────────────────────── */
  section('[2] The in-charge CAN change a report’s responsibilities, KPIs and shift');
  const asHr = await positionJobContent(db, COMPANY, report1.id, {});
  const asMe = await TEAM.teamJobContent(db, I, report1.id, {});
  ok(JSON.stringify(asMe) === JSON.stringify(asHr), 'GET /user/me/team/positions/:id/job-content is exactly GET /positions/:id/job-content');
  const auditBefore = Number((await db.query('SELECT COALESCE(MAX(id), 0) AS n FROM hrms_audit_log WHERE company_id = ?', [COMPANY]))[0][0].n);
  const added = await TEAM.teamAddLine(db, I, report1.id, { kind: 'RESPONSIBILITY', text: `${TAG} keep the line clean` });
  ok(JSON.stringify(added).includes(`${TAG} keep the line clean`) && JSON.stringify(await positionJobContent(db, COMPANY, report1.id, {})) === JSON.stringify(added),
    'add a responsibility to a direct report: taken, and the answer is the position’s job content after it');
  const [audits] = await db.query('SELECT actor_user_id, entity_type, action FROM hrms_audit_log WHERE company_id = ? AND id > ? ORDER BY id', [COMPANY, auditBefore]);
  ok(audits.length > 0 && audits.every((a) => a.actor_user_id === I.userId), `it is audited (${audits.length} row${audits.length === 1 ? '' : 's'}) with the EMPLOYEE’s user as the actor`, JSON.stringify(audits));
  // The HR route's own function, called by HR on a second position, leaves the same kind of rows.
  const auditMid = Number((await db.query('SELECT COALESCE(MAX(id), 0) AS n FROM hrms_audit_log WHERE company_id = ?', [COMPANY]))[0][0].n);
  await seatAddLine(db, hr, peerReport.id, { kind: 'RESPONSIBILITY', text: `${TAG} keep the line clean` });
  const [hrAudits] = await db.query('SELECT entity_type, action FROM hrms_audit_log WHERE company_id = ? AND id > ? ORDER BY id', [COMPANY, auditMid]);
  ok(JSON.stringify(hrAudits) === JSON.stringify(audits.map(({ entity_type, action }) => ({ entity_type, action }))), 'the same audit rows the HR route writes for the same edit — it is the same service call');
  ok(JSON.stringify(await TEAM.teamAddLine(db, I, report2.id, { kind: 'KPI', text: `${TAG} rejects per shift` })).includes(`${TAG} rejects per shift`), 'add a KPI to a report under the CARD-MATE’s chair: taken');
  ok(JSON.stringify(await TEAM.teamAddLine(db, I, sub.id, { kind: 'RESPONSIBILITY', text: `${TAG} two levels down` })).includes(`${TAG} two levels down`), 'add to a position two levels down: taken');
  const dupe = await caught(() => TEAM.teamAddLine(db, I, report1.id, { kind: 'RESPONSIBILITY', text: `${TAG} keep the line clean` }));
  ok(refused(dupe, 409, 'ALREADY_THERE'), 'the service’s own refusals come through unchanged (the same line twice: 409 ALREADY_THERE)', why(dupe));
  for (const [name, fn] of [['add', TEAM.teamAddLine], ['change', TEAM.teamChangeLine], ['switch off', TEAM.teamSwitchOffLine], ['undo', TEAM.teamUndoLine]]) {
    const kra = await caught(() => fn(db, I, report1.id, { kind: 'KRA', text: 'x', definitionId: 1 }));
    ok(refused(kra, 422, 'KRA_FIXED_AT_ROLE'), `${name} a KRA on a report: 422 KRA_FIXED_AT_ROLE, as for HR`, why(kra));
  }
  for (const [name, fn] of [['change', TEAM.teamChangeLine], ['switch off', TEAM.teamSwitchOffLine], ['undo', TEAM.teamUndoLine]]) {
    const e = await caught(() => fn(db, I, report1.id, {}));
    ok(Boolean(e) && e.status === 422, `${name} with an empty body on a report gets past the gate and is refused by the service’s own validation (422)`, why(e));
  }

  const teamShifts = await TEAM.teamShifts(db, I);
  ok(teamShifts.shifts.length === shifts.length && teamShifts.shifts.every((s) => JSON.stringify(Object.keys(s)) === JSON.stringify(['id', 'code', 'name', 'summary']) && s.summary.length > 0),
    'GET /user/me/team/shifts: the active shifts as { id, code, name, summary }');
  const leafAssignment = LEAF.assignmentId;
  const moved = await TEAM.teamChangeShift(db, I, sub.id, { shiftId: nightShift.id, positionCode: 'HACKED', roleId: roles.top, status: 'CLOSED', positionTitle: 'Hacked' });
  const [[subRow]] = await db.query('SELECT position_code, role_id, status, position_title, default_shift_id FROM hrms_positions WHERE id = ?', [sub.id]);
  ok(moved.position.shift.id === nightShift.id && subRow.default_shift_id === nightShift.id && subRow.position_code === sub.positionCode && subRow.role_id === roles.crew && subRow.status === 'ACTIVE' && subRow.position_title === null,
    'PUT …/shift moves the position to the shift — and ONLY the shift: a code, role, status and title sent with it are ignored', JSON.stringify(subRow));
  const [[leafAsg]] = await db.query('SELECT default_shift_id FROM hrms_work_assignments WHERE id = ?', [leafAssignment]);
  const [[shiftAudit]] = await db.query("SELECT actor_user_id, after_json FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_positions' AND entity_id = ? ORDER BY id DESC LIMIT 1", [COMPANY, sub.id]);
  ok(leafAsg.default_shift_id === nightShift.id && moved.occupantsMovedToShift === 1 && shiftAudit?.actor_user_id === I.userId, 'the person in it moves with it, as on the HR route; the change is audited with the employee’s user');
  ok(refused(await caught(() => TEAM.teamChangeShift(db, I, sub.id, {})), 422, 'INVALID') && refused(await caught(() => TEAM.teamChangeShift(db, I, sub.id, { shiftId: 999999999 })), 404, 'NOT_FOUND')
    && refused(await caught(() => TEAM.teamChangeShift(db, I, sub.id, { shiftId: null })), 422, 'INVALID'), 'no shift, or a shift that does not exist: refused (a position cannot be left without one from here)');

  /* ── 3. what the in-charge cannot do ───────────────────────────────────── */
  section('[3] The in-charge CANNOT touch anything else');
  const WRITES = [
    ['read job content', (c, id) => TEAM.teamJobContent(db, c, id, {})],
    ['add', (c, id) => TEAM.teamAddLine(db, c, id, { kind: 'RESPONSIBILITY', text: `${TAG} should never be written` })],
    ['change', (c, id) => TEAM.teamChangeLine(db, c, id, { kind: 'RESPONSIBILITY', definitionId: 1, text: 'x' })],
    ['switch off', (c, id) => TEAM.teamSwitchOffLine(db, c, id, { kind: 'RESPONSIBILITY', definitionId: 1 })],
    ['undo', (c, id) => TEAM.teamUndoLine(db, c, id, { kind: 'RESPONSIBILITY', definitionId: 1 })],
    ['change shift', (c, id) => TEAM.teamChangeShift(db, c, id, { shiftId: nightShift.id })],
  ];
  const allRefused = async (c, id, status, code) => {
    const wrong = [];
    for (const [name, fn] of WRITES) { const e = await caught(() => fn(c, id)); if (!refused(e, status, code)) wrong.push(`${name}: ${why(e)}`); }
    return wrong;
  };
  const overridesBefore = Number((await db.query('SELECT COUNT(*) AS n FROM hrms_position_content_overrides WHERE company_id = ?', [COMPANY]))[0][0].n);
  const shiftsBefore = JSON.stringify((await db.query('SELECT id, default_shift_id FROM hrms_positions WHERE company_id = ? ORDER BY id', [COMPANY]))[0]);
  for (const [label, p] of [['their OWN position', me], ['their card-mate (the other shift’s in-charge)', mate], ['their manager', boss], ['their manager’s manager', top],
    ['a peer in another department', peer], ['a peer’s report', peerReport], ['a position outside every line', loose]]) {
    const wrong = await allRefused(I, p.id, 403, 'NOT_YOUR_TEAM');
    ok(wrong.length === 0, `${label}: all six routes 403 NOT_YOUR_TEAM`, wrong.join(' | '));
  }
  const realOther = realChart.nodes.find((n) => !Object.values(every).some((p) => p.id === n.id));
  if (realOther) ok((await allRefused(I, realOther.id, 403, 'NOT_YOUR_TEAM')).length === 0, 'a real position elsewhere in the company: 403 on all six');
  const own = await caught(() => TEAM.teamAddLine(db, I, me.id, { kind: 'KPI', text: 'x' }));
  const above = await caught(() => TEAM.teamChangeShift(db, I, boss.id, { shiftId: nightShift.id }));
  ok(/your own position/.test(own.message) && /above yours/.test(above.message) && !/undefined/.test(own.message + above.message), 'the refusal is a plain sentence that says why', `${own.message} / ${above.message}`);
  // The gate comes first: a refused call with a KRA or a broken body says NOT_YOUR_TEAM, not what the service would have said.
  ok(refused(await caught(() => TEAM.teamAddLine(db, I, boss.id, { kind: 'KRA' })), 403, 'NOT_YOUR_TEAM') && refused(await caught(() => TEAM.teamChangeShift(db, I, mate.id, {})), 403, 'NOT_YOUR_TEAM'),
    'the scope is checked BEFORE the body: a bad body on a position that is not theirs still answers NOT_YOUR_TEAM');
  // Whatever the client sends about who it is, is not read.
  const spoof = { kind: 'RESPONSIBILITY', text: `${TAG} spoofed`, employeeId: BOSS.employeeId, userId: BOSS.userId, positionId: report1.id, managerPositionId: boss.id, companyId: OTHER };
  ok(refused(await caught(() => TEAM.teamAddLine(db, I, peer.id, spoof)), 403, 'NOT_YOUR_TEAM')
    && refused(await caught(() => TEAM.teamAddLine(db, { ...I, employeeId: BOSS.employeeId }, peer.id, spoof)), 403, 'NOT_YOUR_TEAM'),
  'ids in the body (another employee, another user, another position, another company) change nothing: who the caller is comes from the session alone');
  ok(Number((await db.query('SELECT COUNT(*) AS n FROM hrms_position_content_overrides WHERE company_id = ?', [COMPANY]))[0][0].n) === overridesBefore
    && JSON.stringify((await db.query('SELECT id, default_shift_id FROM hrms_positions WHERE company_id = ? ORDER BY id', [COMPANY]))[0]) === shiftsBefore
    && Number((await db.query('SELECT COUNT(*) AS n FROM hrms_responsibility_definitions WHERE company_id = ? AND (name LIKE ? OR description LIKE ?)', [COMPANY, `%should never be written%`, `%should never be written%`]))[0][0].n) === 0,
  'and not one of those refused calls wrote anything: no override, no shift, no definition');

  /* ── 4. people with no team ────────────────────────────────────────────── */
  section('[4] Nobody below, no position, left the company, not an employee');
  for (const [label, c2] of [['a person with nobody below them', LEAF], ['an employee in no position', NOBODY], ['a login that is not an employee', STRANGER]]) {
    const wrong = [];
    for (const p of [report1, me, boss, sub]) wrong.push(...await allRefused(c2, p.id, 403, 'NOT_YOUR_TEAM'));
    const chart2 = await myOrgChart(db, c2, {});
    ok(wrong.length === 0 && chart2.nodes.every((n) => n.canEdit === false), `${label}: 403 on every route for every position, and no node of their chart has canEdit`, wrong.slice(0, 3).join(' | '));
  }
  ok(refused(await caught(() => TEAM.teamShifts(db, NOBODY)), 403, 'NOT_YOUR_TEAM') && refused(await caught(() => TEAM.teamShifts(db, STRANGER)), 403, 'NOT_YOUR_TEAM')
    && (await TEAM.teamShifts(db, LEAF)).shifts.length > 0, 'the shift list is refused to somebody with no place on the chart');
  ok((await allRefused(HELPER, sub.id, 403, 'NOT_YOUR_TEAM')).length === 6 && JSON.stringify(await TEAM.teamJobContent(db, HELPER, sub.id, {})).length > 2
    && (await allRefused(HELPER, report2.id, 403, 'NOT_YOUR_TEAM')).length === 0 && (await allRefused(HELPER, me.id, 403, 'NOT_YOUR_TEAM')).length === 0,
  'a report who has one position below them can change THAT one — not their colleague under the same in-charge, and not the in-charge');

  // The in-charge leaves. The notice does not take the team away; closing does.
  await db.query('UPDATE hrms_employees SET date_of_joining = ? WHERE id = ?', ['2020-01-01', I.employeeId]);
  await EXIT.startExit(db, hr, I.employeeId, { exitType: 'RESIGNED', reasonCode: 'PAY', noticeDate: on, lastWorkingDay: on });
  ok((await loadMySlice(db, I, {})).canChange(report1.id) === true, 'on notice the in-charge still has their team');
  await EXIT.closeExit(db, hr, I.employeeId, {});
  const gone = [];
  for (const p of [report1, report2, sub, me]) gone.push(...await allRefused(I, p.id, 403, 'NOT_YOUR_TEAM'));
  ok(gone.length === 0 && (await myOrgChart(db, I, {})).nodes.length === 0, 'once they have LEFT: 403 on every route, for the positions that were their team too', gone.slice(0, 3).join(' | '));
  // A stale assignment row must not bring the team back.
  await db.query("UPDATE hrms_work_assignments SET status = 'ACTIVE', effective_to = NULL WHERE id = ?", [I.assignmentId]);
  ok((await allRefused(I, report1.id, 403, 'NOT_YOUR_TEAM')).length === 0 && (await loadMySlice(db, I, {})).canChange(report1.id) === false,
    'even with their assignment row wrongly left open, somebody who has left changes nothing');
  ok((await loadMySlice(db, MATE, {})).canChange(report1.id) === true, 'the card-mate still has the team');

  /* ── 5. ids ────────────────────────────────────────────────────────────── */
  section('[5] Ids that do not exist, and another company’s');
  ok((await allRefused(MATE, 999999999, 404, 'NOT_FOUND')).length === 0, 'a position that does not exist: 404 on all six');
  const [[foreign]] = await db.query('SELECT id FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [OTHER]);
  let foreignId = foreign?.id;
  if (!foreignId) {
    const [r] = await db.query("INSERT INTO hrms_roles (company_id, role_code, title, status) VALUES (?, ?, ?, 'ACTIVE')", [OTHER, `${TAG}O`, `${TAG} Other`]);
    foreignId = (await db.query("INSERT INTO hrms_positions (company_id, role_id, position_code, status) VALUES (?, ?, ?, 'ACTIVE')", [OTHER, r.insertId, `${TAG}-O`]))[0].insertId;
  }
  const foreignWrong = await allRefused(MATE, foreignId, 404, 'NOT_FOUND');
  const missing = await caught(() => TEAM.teamAddLine(db, MATE, 999999999, { kind: 'KPI', text: 'x' }));
  const theirs = await caught(() => TEAM.teamAddLine(db, MATE, foreignId, { kind: 'KPI', text: 'x' }));
  ok(foreignWrong.length === 0 && theirs.message === missing.message && theirs.code === missing.code, 'another company’s position answers EXACTLY like one that does not exist (404, the same words): nothing leaks', foreignWrong.join(' | '));
  ok((await allRefused(NOBODY, 999999999, 403, 'NOT_YOUR_TEAM')).length === 0 && (await allRefused(NOBODY, foreignId, 403, 'NOT_YOUR_TEAM')).length === 0,
    'for somebody with no team, every id — real, missing or foreign — answers the same 403: they learn nothing at all');
  const deleted = await position(roles.crew, depts.a, dayShift.id, mate.id);
  await db.query('UPDATE hrms_positions SET deleted_at = NOW() WHERE id = ?', [deleted.id]);
  ok((await allRefused(MATE, deleted.id, 404, 'NOT_FOUND')).length === 0, 'a deleted position that was in the team: 404');
} catch (e) {
  ok(false, 'the fixture and service checks ran to the end', e.stack ?? e.message);
} finally {
  try { await db.rollback(); } catch { /* nothing to undo */ }
  db.release();
  console.log('\n[rolled back]');
}

/* ══ 6. through the real middleware, with a real Employee login ═══════════ */
section('[6] Over HTTP, with a real Employee login');
{
  const server = express();
  server.use(express.json({ limit: '50mb' }));
  server.use(cookieParser());
  server.use('/api', appContext);
  hrmsApp.register(server);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  const base = `http://127.0.0.1:${listener.address().port}/api`;
  const call = async (who, method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  try {
    // Real employee logins, with their own position and (for one of them) somebody below.
    const [logins] = await pool.query(
      `SELECT u.id, u.email, u.company_id, r.name AS role, e.id AS employee_id
         FROM users u JOIN roles r ON r.id = u.role_id JOIN hrms_employees e ON e.user_id = u.id AND e.deleted_at IS NULL
        WHERE u.company_id = ? AND u.deleted_at IS NULL AND r.name = 'Employee'
          AND EXISTS (SELECT 1 FROM app_user_access x JOIN apps a ON a.id = x.app_id WHERE x.user_id = u.id AND x.deleted_at IS NULL AND a.slug = 'cf_hrms')
        ORDER BY u.id`, [COMPANY]);
    const withToken = (u) => ({ ...u, token: signToken({ id: u.id, email: u.email, role: u.role, company: slug, companyId: u.company_id, company_id: u.company_id, uiPermissions: [] }) });
    const api = `/${slug}/cf_hrms`;
    let manager = null;
    let leaf = null;
    for (const u of logins) {
      const slice = await loadMySlice(pool, { companyId: COMPANY, userId: u.id }, {});
      if (!slice.linked) continue;
      const below = slice.graph.nodes.filter((n) => slice.canChange(n.id));
      if (below.length && !manager) manager = { ...withToken(u), slice, below };
      if (!below.length && !leaf) leaf = { ...withToken(u), slice };
      if (manager && leaf) break;
    }
    if (!manager) skip('a real employee login with a team', 'no Employee-role login of this company has anybody below them');
    else {
      const chart = await call(manager, 'GET', `${api}/user/me/orgchart`);
      const editable = chart.json.nodes.filter((n) => n.canEdit).map((n) => n.id).sort((a, b) => a - b);
      ok(chart.status === 200 && JSON.stringify(editable) === JSON.stringify(manager.below.map((n) => n.id).sort((a, b) => a - b)) && chart.json.nodes.filter((n) => n.relation !== 'REPORT').every((n) => n.canEdit === false),
        `a real in-charge: their chart marks ${editable.length} position(s) below them canEdit, and nothing else`);
      const target = manager.below[0].id;
      const mineId = manager.slice.mine[0];
      const managerNode = chart.json.nodes.find((n) => n.relation === 'MANAGER');
      const read = await call(manager, 'GET', `${api}/user/me/team/positions/${target}/job-content`);
      const shifts = await call(manager, 'GET', `${api}/user/me/team/shifts`);
      ok(read.status === 200 && shifts.status === 200 && shifts.json.shifts.every((s) => typeof s.summary === 'string'), 'they can read a report’s job content and the shift list');
      const refusals = [];
      for (const [label, id] of [['own position', mineId], ['manager', managerNode?.id], ['missing', 999999999]].filter(([, id]) => id != null)) {
        const want = label === 'missing' ? 404 : 403;
        for (const [method, url, body] of [['GET', 'job-content'], ['POST', 'job-content/add', { kind: 'RESPONSIBILITY', text: `${TAG} must not be written` }],
          ['POST', 'job-content/switch-off', { kind: 'RESPONSIBILITY', definitionId: 1 }], ['PUT', 'shift', { shiftId: shifts.json.shifts[0].id }]]) {
          const r = await call(manager, method, `${api}/user/me/team/positions/${id}/${url}`, body);
          if (r.status !== want || (want === 403 && r.json.code !== 'NOT_YOUR_TEAM')) refusals.push(`${label} ${method} ${url}: ${r.status} ${r.json?.code}`);
        }
      }
      ok(refusals.length === 0, 'their own position and their manager: 403 NOT_YOUR_TEAM on read, add, switch-off and shift; a missing position: 404', refusals.join(' | '));
      const kra = await call(manager, 'POST', `${api}/user/me/team/positions/${target}/job-content/add`, { kind: 'KRA', text: 'x' });
      ok(kra.status === 422 && kra.json.code === 'KRA_FIXED_AT_ROLE', 'a KRA on a report over HTTP: 422 KRA_FIXED_AT_ROLE (and nothing written)', `${kra.status} ${kra.json?.code}`);
      const HR_ONLY = [
        ['GET', `/positions/${target}/job-content`], ['POST', `/positions/${target}/job-content/add`, { kind: 'RESPONSIBILITY', text: 'x' }], ['PUT', `/positions/${target}`, { defaultShiftId: 1 }],
        ['GET', '/positions'], ['GET', '/orgchart'], ['POST', `/positions/${target}/close`, {}], ['DELETE', `/positions/${target}`], ['POST', `/positions/${target}/add-sibling`, {}],
        ['POST', `/positions/${target}/hiring`, {}], ['GET', '/people/employees'], ['POST', `/people/employees/${manager.employee_id}/exit`, { exitType: 'RESIGNED', reasonCode: 'PAY' }],
        ['GET', '/organisation/shifts'], ['PUT', '/organisation/shifts/1', { name: 'x' }], ['GET', '/hirings'], ['GET', '/roles'], ['POST', '/assignments', {}],
      ];
      const open = [];
      for (const [method, url, body] of HR_ONLY) { const r = await call(manager, method, `${api}${url}`, body); if (r.status !== 403) open.push(`${method} ${url} ${r.status}`); }
      ok(open.length === 0, `the HR routes are still closed to them: 403 on all ${HR_ONLY.length}, the HR twin of every team route included`, open.join(' | '));
    }
    if (!leaf) skip('a real employee login with nobody below', 'every Employee-role login has a team');
    else {
      const someone = manager?.below[0].id ?? leaf.slice.mine[0];
      const wrong = [];
      for (const [method, url, body] of [['GET', `/user/me/team/positions/${someone}/job-content`], ['POST', `/user/me/team/positions/${someone}/job-content/add`, { kind: 'KPI', text: 'x' }],
        ['PUT', `/user/me/team/positions/${someone}/shift`, { shiftId: 1 }], ['GET', `/user/me/team/positions/${leaf.slice.mine[0]}/job-content`]]) {
        const r = await call(leaf, method, `${api}${url}`, body);
        if (r.status !== 403 || r.json.code !== 'NOT_YOUR_TEAM') wrong.push(`${method} ${url} ${r.status} ${r.json?.code}`);
      }
      const chart = await call(leaf, 'GET', `${api}/user/me/orgchart`);
      ok(wrong.length === 0 && chart.json.nodes.every((n) => n.canEdit === false), 'a real employee with nobody below: 403 NOT_YOUR_TEAM everywhere, no canEdit on their chart', wrong.join(' | '));
    }
    ok((await call(null, 'GET', `${api}/user/me/team/shifts`)).status === 401 && (await call(null, 'PUT', `${api}/user/me/team/positions/1/shift`, { shiftId: 1 })).status === 401, 'no token at all: 401');
    const [[outsider]] = await pool.query(
      `SELECT u.id, u.email, u.company_id, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.company_id <> ? AND u.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM app_user_access x JOIN apps a ON a.id = x.app_id WHERE x.user_id = u.id AND x.deleted_at IS NULL AND a.slug = 'cf_hrms') ORDER BY u.id LIMIT 1`, [COMPANY]);
    if (outsider && manager) {
      const o = { token: signToken({ id: outsider.id, email: outsider.email, role: outsider.role, company: 'x', companyId: outsider.company_id, company_id: outsider.company_id, uiPermissions: [] }) };
      const r = await call(o, 'POST', `${api}/user/me/team/positions/${manager.below[0].id}/job-content/add`, { kind: 'KPI', text: 'x' });
      ok(r.status === 403, 'a login of another company on this company’s URL: 403', `${r.status}`);
    }
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
}

section('[end] The tenant is as it was found');
{
  const after = await snapshot();
  const moved = Object.keys(baseline).filter((k) => after[k] !== baseline[k]);
  ok(moved.length === 0, `every hrms_ table of both companies and the users table hold what they started with (${hrmsTables.length} tables)`, moved.map((k) => `${k} ${baseline[k]} -> ${after[k]}`).join('; '));
  const [[left]] = await pool.query('SELECT (SELECT COUNT(*) FROM hrms_responsibility_definitions WHERE company_id = ? AND (name LIKE ? OR description LIKE ?)) AS defs, (SELECT COUNT(*) FROM users WHERE email LIKE ?) AS users',
    [COMPANY, `%${TAG}%`, `%${TAG}%`, `${TAG.toLowerCase()}-%`]);
  ok(Number(left.defs) === 0 && Number(left.users) === 0, 'nothing carrying this run’s tag is left: no definition, no user');
}

console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped`);
if (skipped.length) for (const s of skipped) console.log(`  skipped — ${s}`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
