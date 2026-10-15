/**
 * job_history_test.mjs — dated history of job content, and the person layer.
 * Contract: TM/CF_HRMS_HIRING_SPEC.md §16. Written to break the rule, not to show it working.
 *
 *   1. ROLE: every edit kind (KPI target, rewording, KRA rename, removal, adding,
 *      moving a line under another KRA, a KRA removed) leaves the old version
 *      readable "as on" yesterday and the new one today; a line keeps its identity
 *      through a rewording; a change dated ahead is invisible until its day; a past
 *      day is refused, and allowed for the Owner with a reason; a change dated before
 *      one that has already happened is refused.
 *   2. POSITION: add, change a target, reword, switch off, undo — the same.
 *   3. PERSON: the same four verbs for one person; they show for that person only
 *      (not the position, not another holder of the role); they end when the person
 *      moves; a KRA is refused.
 *   4. History lists, newest first, with the line's identity kept across a rewording.
 *   5. The JD builder, the responsibility profile and search read the date they are asked for.
 *   6. Rights over HTTP: employees_edit; scope; a manager login for a person below
 *      them yes, for their own job and their manager's no; an Employee login 403 on others.
 *   7. The tenant is as it was found (fresh connection): positions / filled / vacant,
 *      employees, every job-content table.
 *
 *   node scripts/cf_hrms/job_history_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND: as in access_test, the whole run — services and an
 * in-process server — is ONE transaction on ONE connection, rolled back at the
 * end. Local only. No password is read or printed; tokens are minted here.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import mysql from 'mysql2/promise';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import hrmsApp from '../../apps/cf_hrms/app.js';
import { PERM } from '../../apps/cf_hrms/lib/http.js';
import { forgetAccess } from '../../apps/cf_hrms/lib/accessContext.js';
import { hrmsAppOf, ensureCatalog, setRoleTags } from '../../apps/cf_hrms/services/accessGrants.js';
import * as POS from '../../apps/cf_hrms/services/positionService.js';
import * as RC from '../../apps/cf_hrms/services/roleContentService.js';
import * as J from '../../apps/cf_hrms/services/jobContentService.js';
import * as H from '../../apps/cf_hrms/services/jobHistoryService.js';
import { moveEmployee } from '../../apps/cf_hrms/services/employeePositionsService.js';
import { buildRoleJd, buildResponsibilityProfile } from '../../apps/cf_hrms/services/documentService.js';
import { effectiveLinesForPositions } from '../../apps/cf_hrms/services/contentResolver.js';
import { buildOrgChart } from '../../apps/cf_hrms/services/orgChartService.js';
import { loadRecords } from '../../apps/cf_hrms/services/commands/records.js';
import { readCommand } from '../../apps/cf_hrms/services/commands/reader.js';
import { applyPlan } from '../../apps/cf_hrms/services/commands/plan.js';

const slug = (process.argv.find((a) => a.startsWith('--company=')) || '--company=karni').split('=')[1];
const VERBOSE = process.argv.includes('--verbose');
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
const section = (title) => console.log(`\n${title}`);
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const refused = (e, status, code) => Boolean(e) && e.status === status && e.code === code;
const why = (e) => (e ? `${e.status ?? '?'} ${e.code ?? ''} ${e.message ?? ''}` : 'nothing was thrown');

const shift = (iso, days) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const T = POS.today();
const Y = shift(T, -1);
const Y2 = shift(T, -2);
const AHEAD = shift(T, 10);
const D0 = shift(T, -200);   // when the fixture's job "started"
const D1 = shift(T, -30);    // when an Owner-dated change took effect

/* ── the world before, from a connection of its own ───────────────────────── */
const CONTENT_TABLES = ['hrms_role_kra_assignments', 'hrms_role_responsibility_assignments', 'hrms_role_kpi_assignments',
  'hrms_position_content_overrides', 'hrms_work_assignment_content_overrides', 'hrms_responsibility_definitions', 'hrms_kpi_definitions', 'hrms_kra_definitions'];
async function tenant(companySlug) {
  const conn = await mysql.createConnection({ host: process.env.DB_HOST ?? 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306 });
  try {
    const [[co]] = await conn.query('SELECT id FROM companies WHERE slug = ?', [companySlug]);
    const out = {};
    for (const t of CONTENT_TABLES) {
      const [[r]] = await conn.query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(deleted_at IS NULL), 0) AS live, COALESCE(SUM(id), 0) AS ids,
                COALESCE(SUM(CRC32(CONCAT_WS('|', id, ${t.includes('definitions') ? 'name' : "IFNULL(line_key,''), IFNULL(effective_from,''), IFNULL(effective_to,'')"}, IFNULL(deleted_at,'')))), 0) AS sig
           FROM ${t} WHERE company_id = ?`, [co.id]);
      out[t] = `${r.n}/${r.live}/${r.ids}/${r.sig}`;
    }
    const [[e]] = await conn.query('SELECT COUNT(*) AS n FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL', [co.id]);
    out.employees = Number(e.n);
    const [[a]] = await conn.query('SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ?', [co.id]);
    out.audit = Number(a.n);
    return out;
  } finally { await conn.end(); }
}
const before = await tenant(slug);
const chartBefore = (await buildOrgChart(pool, (await pool.query('SELECT id FROM companies WHERE slug = ?', [slug]))[0][0].id, {})).counts;

/* ── everything from here on is ONE transaction on ONE connection ─────────── */
const real = { getConnection: pool.getConnection.bind(pool) };
const db = await real.getConnection();
await db.beginTransaction();
let depth = 0;
const inside = {
  query: (...a) => db.query(...a),
  execute: (...a) => db.execute(...a),
  beginTransaction: async () => { depth += 1; await db.query(`SAVEPOINT zz_hist_${depth}`); },
  commit: async () => { if (depth > 0) { await db.query(`RELEASE SAVEPOINT zz_hist_${depth}`); depth -= 1; } },
  rollback: async () => { if (depth > 0) { await db.query(`ROLLBACK TO SAVEPOINT zz_hist_${depth}`); depth -= 1; } },
  release: () => {},
};
pool.query = inside.query;
pool.execute = inside.execute;
pool.getConnection = async () => inside;

const TAG = `ZZJH${Date.now().toString(36).toUpperCase().slice(-5)}`;
const q = async (sql, params) => (await db.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0] ?? null;
const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;

/* ── reading a job ─────────────────────────────────────────────────────────── */
const flat = (c) => [
  ...c.kras.flatMap((k) => [...k.responsibilities.map((l) => ({ ...l, kra: k.name })), ...k.kpis.map((l) => ({ ...l, kra: k.name }))]),
  ...c.ungrouped.responsibilities.map((l) => ({ ...l, kra: null })), ...c.ungrouped.kpis.map((l) => ({ ...l, kra: null })),
];
const has = (c, text) => flat(c).some((l) => l.mark !== 'OFF' && l.name === text);
const line = (c, text) => flat(c).find((l) => l.name === text) ?? null;
const kraNames = (c) => c.kras.map((k) => k.name);

let listener = null;
try {
  const company = await one('SELECT id, name, slug FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
  const COMPANY = company.id;
  const app = await hrmsAppOf(db, COMPANY);
  const owner = await one(
    `SELECT u.id, u.email FROM users u JOIN app_user_access aua ON aua.user_id = u.id AND aua.app_id = ? AND aua.deleted_at IS NULL JOIN roles r ON r.id = aua.role_id
      WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [app.id, COMPANY]);
  const hr = { companyId: COMPANY, userId: owner.id, owner: false };    // anyone with the edit right
  const OWNER = { companyId: COMPANY, userId: owner.id, owner: true };
  console.log(`job_history_test — ${company.name} (${COMPANY}), run tag ${TAG}, today ${T}`);

  /* ══ the fixture ══════════════════════════════════════════════════════════ */
  const dept = async (name) => ins("INSERT INTO hrms_departments (company_id, code, name, department_type) VALUES (?, ?, ?, 'Department')", [COMPANY, `${TAG}${name}`, `${TAG} ${name}`]);
  const D = { a: await dept('A'), b: await dept('B') };
  const role = await ins("INSERT INTO hrms_roles (company_id, role_code, title, role_purpose, status) VALUES (?, ?, ?, 'For a test.', 'ACTIVE')", [COMPANY, `${TAG}R`, `${TAG} Operator`]);
  const bossRole = await ins("INSERT INTO hrms_roles (company_id, role_code, title, role_purpose, status) VALUES (?, ?, ?, 'For a test.', 'ACTIVE')", [COMPANY, `${TAG}B`, `${TAG} Incharge`]);
  const pos = async (code, roleId, departmentId) => ins("INSERT INTO hrms_positions (company_id, position_code, role_id, position_title, department_id, status) VALUES (?, ?, ?, ?, ?, 'ACTIVE')", [COMPANY, `${TAG}-${code}`, roleId, `${TAG} ${code}`, departmentId]);
  const P = { p: await pos('P', role, D.a), q: await pos('Q', role, D.a), q2: await pos('Q2', role, D.a), m: await pos('M', bossRole, D.a), top: await pos('TOP', bossRole, D.a), h: await pos('H', role, D.b) };
  const [[primary]] = await db.query("SELECT id FROM hrms_reporting_relationship_types WHERE company_id = ? AND code = 'PRIMARY_MANAGER' AND deleted_at IS NULL", [COMPANY]);
  for (const [from, to] of [[P.p, P.m], [P.q, P.m], [P.m, P.top]]) {
    await POS.addPositionReporting(db, hr, from, { toPositionId: to, relationshipTypeId: primary.id, isPrimary: true, effectiveFrom: D0 });
  }
  const emp = async (code) => ins(
    "INSERT INTO hrms_employees (company_id, employee_code, full_name, date_of_joining, employment_type, employment_status) VALUES (?, ?, ?, ?, 'EMPLOYEE', 'ACTIVE')",
    [COMPANY, `${TAG}${code}`, `${TAG} Person ${code}`, D0]);
  const seat = async (employeeId, positionId, roleId, departmentId) => ins(
    "INSERT INTO hrms_work_assignments (company_id, employee_id, role_id, position_id, department_id, is_primary, status, effective_from) VALUES (?, ?, ?, ?, ?, 1, 'ACTIVE', ?)",
    [COMPANY, employeeId, roleId, positionId, departmentId, D0]);
  const E = { e: await emp('E'), f: await emp('F'), m: await emp('M'), top: await emp('TOP'), h: await emp('H') };
  await seat(E.e, P.p, role, D.a); await seat(E.f, P.q, role, D.a); await seat(E.m, P.m, bossRole, D.a); await seat(E.top, P.top, bossRole, D.a); await seat(E.h, P.h, role, D.b);

  // The role's job, written the way the screens write it, then dated back to D0.
  const kraQ = await J.createRoleKra(db, hr, role, { name: `${TAG} Quality` });
  const kraS = await J.createRoleKra(db, hr, role, { name: `${TAG} Safety` });
  const respDef = async (text) => (await RC.createMasterItem(db, hr, 'responsibilities', { name: text, description: text, status: 'ACTIVE' })).id;
  const kpiDef = async (text) => (await RC.createMasterItem(db, hr, 'kpis', { name: text, measurementType: 'TEXT', status: 'ACTIVE' })).id;
  const addResp = async (text, kraRow = kraQ.id) => RC.addContent(db, hr, role, 'responsibilities', { responsibilityDefinitionId: await respDef(text), roleKraAssignmentId: kraRow });
  const addKpi = async (text, target, kraRow = kraQ.id) => RC.addContent(db, hr, role, 'kpis', { kpiDefinitionId: await kpiDef(text), roleKraAssignmentId: kraRow, targetOperator: 'EQ', targetValue: target });
  const W = (n) => `${TAG} line ${n}`;
  const r1 = await addResp(W(1));
  const r2 = await addResp(W(2));
  const r4 = await addResp(W(4));
  const r5 = await addResp(W(5));
  const r6 = await addResp(W(6));
  const r7 = await addResp(W(7));
  const r8 = await addResp(W(8));
  const k1 = await addKpi(W('k1'), '95%');
  const k2 = await addKpi(W('k2'), '5', kraS.id);
  const k3 = await addKpi(W('k3'), '10');
  for (const t of ['hrms_role_kra_assignments', 'hrms_role_responsibility_assignments', 'hrms_role_kpi_assignments']) {
    await db.query(`UPDATE ${t} SET effective_from = ? WHERE company_id = ? AND role_id = ?`, [D0, COMPANY, role]);
  }
  const roleJob = (on) => J.roleJobContent(db, COMPANY, role, { on });
  const seatJob = (on, id = P.p) => J.positionJobContent(db, COMPANY, id, { on });
  const personJob = (on, id = E.e) => J.employeeJobContent(db, COMPANY, id, { on });
  const defOf = async (text, on = T) => line(await seatJob(on), text)?.definitionId;
  const start = await roleJob(T);
  ok(flat(start).length === 10 && kraNames(start).length === 2 && flat(start).every((l) => l.layer === 'ROLE' && l.since === D0 && l.lineKey),
    'the fixture: a role with 2 KRAs and 10 lines, every line from the role, since its start day, with a line key');

  /* ══ 1. the role ══════════════════════════════════════════════════════════ */
  section('[1] The role: every change is a new version; the old one stays readable');
  {
    // a KPI target
    await RC.updateContent(db, hr, 'kpis', k1.id, { targetOperator: 'EQ', targetValue: '98%' });
    const y = line(await roleJob(Y), W('k1'));
    const t = line(await roleJob(T), W('k1'));
    ok(y?.targetText === '95%' && t?.targetText === '98%' && y.lineKey === t.lineKey && t.since === T && t.changedFrom?.target === '95%',
      'a KPI target changed today: 95% as on yesterday, 98% today — the same line, since today, "changed from 95%"', JSON.stringify({ y: y?.targetText, t: t?.targetText, cf: t?.changedFrom }));
    const rows = await q('SELECT effective_from, effective_to, deleted_at, ended_by FROM hrms_role_kpi_assignments WHERE company_id = ? AND line_key = ? ORDER BY id', [COMPANY, t.lineKey]);
    ok(rows.length === 2 && POS.dateText(rows[0].effective_to) === Y && rows[0].deleted_at && rows[0].ended_by === hr.userId && POS.dateText(rows[1].effective_from) === T && !rows[1].deleted_at,
      'underneath: the old row closed yesterday (and who closed it), the new one open from today — nothing overwritten');

    // a rewording
    await J.rewordRoleLine(db, hr, 'RESPONSIBILITY', r1.id, { text: `${W(1)} reworded` });
    const y1 = line(await roleJob(Y), W(1));
    const t1 = line(await roleJob(T), `${W(1)} reworded`);
    ok(y1 && t1 && !has(await roleJob(T), W(1)) && y1.lineKey === t1.lineKey && t1.changedFrom?.wording === W(1) && t1.kra === `${TAG} Quality`,
      'a responsibility reworded: the old words as on yesterday, the new today — the SAME line (one key), still under its KRA, "changed from" the old words');
    const lib = await one('SELECT name FROM hrms_responsibility_definitions WHERE id = ?', [y1.definitionId]);
    ok(lib?.name === W(1), 'the shared library text of the old words is untouched (another role may carry them)');

    // a KRA renamed
    await J.renameRoleKra(db, hr, kraQ.id, { name: `${TAG} Quality and finish` });
    const ky = await roleJob(Y);
    const kt = await roleJob(T);
    ok(kraNames(ky).includes(`${TAG} Quality`) && kraNames(kt).includes(`${TAG} Quality and finish`) && !kraNames(kt).includes(`${TAG} Quality`)
      && line(ky, W(2))?.kra === `${TAG} Quality` && line(kt, W(2))?.kra === `${TAG} Quality and finish` && line(kt, W('k1'))?.kra === `${TAG} Quality and finish`,
    'a KRA renamed: the old name with its lines as on yesterday, the new name with the same lines today');
    ok(kt.kras.find((k) => k.name === `${TAG} Quality and finish`)?.changedFrom?.wording === `${TAG} Quality`, 'the renamed KRA says what it was called');

    // removed, added
    await RC.removeContent(db, hr, 'responsibilities', r2.id);
    ok(has(await roleJob(Y), W(2)) && !has(await roleJob(T), W(2)), 'a line removed today: there yesterday, gone today');
    const r3 = await addResp(W(3));
    ok(!has(await roleJob(Y), W(3)) && has(await roleJob(T), W(3)), 'a line added today: not there yesterday, there today');

    // a change dated ahead
    await RC.updateContent(db, hr, 'kpis', k2.id, { targetOperator: 'EQ', targetValue: '7', takesEffect: AHEAD });
    ok(line(await roleJob(T), W('k2'))?.targetText === '5' && line(await roleJob(shift(AHEAD, -1)), W('k2'))?.targetText === '5' && line(await roleJob(AHEAD), W('k2'))?.targetText === '7',
      `a target change from ${AHEAD}: invisible today and the day before, in force on its day`);

    // the past
    const past = await caught(() => RC.updateContent(db, hr, 'kpis', k2.id, { targetOperator: 'EQ', targetValue: '6', takesEffect: Y }));
    ok(refused(past, 422, 'PAST_DATE'), 'a change dated yesterday: 422 PAST_DATE for anyone but the Owner', why(past));
    const noReason = await caught(() => RC.updateContent(db, OWNER, 'kpis', k2.id, { targetOperator: 'EQ', targetValue: '6', takesEffect: Y }));
    ok(refused(noReason, 422, 'REASON_NEEDED'), 'the Owner, without a reason: 422 REASON_NEEDED', why(noReason));
    await RC.updateContent(db, OWNER, 'kpis', k2.id, { targetOperator: 'EQ', targetValue: '6', takesEffect: Y, reason: 'Agreed at the review on Monday' });
    const k2y = line(await roleJob(Y), W('k2'));
    ok(line(await roleJob(Y2), W('k2'))?.targetText === '5' && k2y?.targetText === '6' && line(await roleJob(AHEAD), W('k2'))?.targetText === '6',
      'the Owner, with a reason: in force from yesterday (the day before still reads the old target) — and the change that was waiting for its day is replaced by it');
    const reasonRow = await one('SELECT change_reason FROM hrms_role_kpi_assignments WHERE company_id = ? AND line_key = ? AND deleted_at IS NULL', [COMPANY, k2y.lineKey]);
    ok(reasonRow?.change_reason === 'Agreed at the review on Monday', 'the reason is kept with the change');
    const rewrite = await caught(() => RC.updateContent(db, OWNER, 'kpis', k1.id, { targetOperator: 'EQ', targetValue: '90%', takesEffect: Y, reason: 'x' }));
    ok(refused(rewrite, 409, 'LATER_CHANGE'), 'even the Owner cannot date a change before one that has already happened (k1 changed today): 409 LATER_CHANGE', why(rewrite));

    // a line moved under another KRA, a KRA removed
    await J.moveRoleLines(db, hr, role, { roleKraAssignmentId: kraS.id, responsibilities: [r3.id] });
    ok(line(await roleJob(T), W(3))?.kra === `${TAG} Safety`, 'a line moved under another KRA: from today');
    await J.deleteRoleKra(db, hr, kraS.id);
    const sy = await roleJob(Y);
    const st = await roleJob(T);
    ok(kraNames(sy).includes(`${TAG} Safety`) && line(sy, W('k2'))?.kra === `${TAG} Safety` && !kraNames(st).includes(`${TAG} Safety`) && line(st, W('k2'))?.kra === null && !line(st, W('k2'))?.note,
      'a KRA removed today: there yesterday with its lines under it; today the lines stay on the role, not under any KRA (said plainly, no "not in force" note)');
    const kraRow = await caught(() => J.personAddLine(db, hr, E.e, { kind: 'KRA', text: 'x' }));
    ok(refused(kraRow, 422, 'KRA_FIXED_AT_ROLE'), 'a KRA for one person: 422 KRA_FIXED_AT_ROLE', why(kraRow));
  }

  /* ══ 2. the position ══════════════════════════════════════════════════════ */
  section('[2] A position: add, change, reword, switch off, undo — dated');
  {
    await J.seatAddLine(db, hr, P.p, { kind: 'RESPONSIBILITY', text: `${TAG} P own line` });
    ok(!has(await seatJob(Y), `${TAG} P own line`) && line(await seatJob(T), `${TAG} P own line`)?.mark === 'ADDED' && line(await seatJob(T), `${TAG} P own line`)?.markLayer === 'POSITION',
      'added for the position today: not there yesterday; today, marked "for this position"');
    await J.seatChangeLine(db, hr, P.p, { kind: 'KPI', definitionId: await defOf(W('k3')), target: { operator: 'EQ', value: '12' } });
    const k3y = line(await seatJob(Y), W('k3'));
    const k3t = line(await seatJob(T), W('k3'));
    ok(k3y?.targetText === '10' && k3y.mark === null && k3t?.targetText === '12' && k3t.mark === 'CHANGED' && k3t.layer === 'POSITION' && k3t.since === T && k3t.changedFrom?.target === '10',
      'a target changed for the position: 10 yesterday, 12 today, changed for this position, since today, from 10', JSON.stringify(k3t?.changedFrom));
    const r4def = await defOf(W(4));
    await J.seatChangeLine(db, hr, P.p, { kind: 'RESPONSIBILITY', definitionId: r4def, text: `${W(4)} for P` });
    const r4y = line(await seatJob(Y), W(4));
    const r4t = line(await seatJob(T), `${W(4)} for P`);
    ok(r4y && r4t && !has(await seatJob(T), W(4)) && r4t.lineKey === r4y.lineKey && r4t.mark === 'CHANGED' && r4t.changedFrom?.wording === W(4),
      'reworded for the position: the role’s words yesterday, the position’s today — the same line (one key), changed from the role’s words');
    await J.seatSwitchOffLine(db, hr, P.p, { kind: 'RESPONSIBILITY', definitionId: await defOf(W(5)) });
    ok(line(await seatJob(Y), W(5))?.mark === null && line(await seatJob(T), W(5))?.mark === 'OFF', 'switched off for the position: done yesterday, switched off today');
    // Undo of a change that has been in force for a month (dated by the Owner, with a reason).
    await J.seatSwitchOffLine(db, OWNER, P.p, { kind: 'RESPONSIBILITY', definitionId: await defOf(W(6)), takesEffect: D1, reason: 'Fixture: off since last month' });
    ok(line(await seatJob(shift(D1, -1)), W(6))?.mark === null && line(await seatJob(Y), W(6))?.mark === 'OFF', `the Owner dated a switch-off ${D1}: from then on`);
    await J.seatUndoLine(db, hr, P.p, { kind: 'RESPONSIBILITY', definitionId: await defOf(W(6)) });
    ok(line(await seatJob(Y), W(6))?.mark === 'OFF' && line(await seatJob(T), W(6))?.mark === null, 'undone today: still switched off as on yesterday, back to what the role says today');
    await J.seatAddLine(db, hr, P.p, { kind: 'KPI', text: `${TAG} P future KPI`, takesEffect: AHEAD });
    ok(!has(await seatJob(T), `${TAG} P future KPI`) && has(await seatJob(AHEAD), `${TAG} P future KPI`), 'added for the position from a later day: invisible until then');
    const past = await caught(() => J.seatAddLine(db, hr, P.p, { kind: 'KPI', text: `${TAG} P past`, takesEffect: Y }));
    ok(refused(past, 422, 'PAST_DATE'), 'a position change dated yesterday: 422 PAST_DATE', why(past));
    ok(!has(await seatJob(T, P.q), `${TAG} P own line`) && line(await seatJob(T, P.q), W('k3'))?.targetText === '10', 'the other position of the role is untouched by all of it');
    // A role rewording reaches the position's own switch-off through the line.
    await J.rewordRoleLine(db, hr, 'RESPONSIBILITY', r5.id, { text: `${W(5)} reworded by the role`, takesEffect: AHEAD });
    ok(line(await seatJob(AHEAD), `${W(5)} reworded by the role`)?.mark === 'OFF' && line(await seatJob(AHEAD, P.q), `${W(5)} reworded by the role`)?.mark === null,
      'the role rewords a line the position switched off: it stays switched off for that position (the switch-off follows the line), and reads reworded for the others');
  }

  /* ══ 3. the person ════════════════════════════════════════════════════════ */
  section('[3] A person: their own changes, for them only, ending when they move');
  {
    const r = await J.personAddLine(db, hr, E.e, { kind: 'RESPONSIBILITY', text: `${TAG} E own line` });
    ok(r.subject === 'PERSON' && line(r, `${TAG} E own line`)?.markLayer === 'PERSON' && line(r, `${TAG} E own line`)?.layer === 'PERSON', 'added for the person: marked "for this person"');
    ok(!has(await personJob(Y), `${TAG} E own line`) && has(await personJob(T), `${TAG} E own line`), 'not there yesterday, there today');
    ok(!has(await seatJob(T), `${TAG} E own line`) && !has(await personJob(T, E.f), `${TAG} E own line`), 'not on the position, not on the other person holding the role');
    ok(line(await personJob(T), `${TAG} P own line`)?.markLayer === 'POSITION', 'the person’s job carries the position’s changes, marked as the position’s');
    await J.personChangeLine(db, hr, E.e, { kind: 'KPI', definitionId: line(await personJob(T), W('k3')).definitionId, target: { operator: 'EQ', value: '15' } });
    const k3 = line(await personJob(T), W('k3'));
    ok(k3?.targetText === '15' && k3.markLayer === 'PERSON' && /Position target: 12/.test(k3.was ?? '') && line(await personJob(Y), W('k3'))?.targetText === '10'
      && line(await seatJob(T), W('k3'))?.targetText === '12' && line(await personJob(T, E.f), W('k3'))?.targetText === '10',
    'a target for the person: 15 for them today (was the position’s 12), the position still 12, the other person 10, and 10 for them yesterday', k3?.was);
    const r7def = line(await personJob(T), W(7)).definitionId;
    await J.personChangeLine(db, hr, E.e, { kind: 'RESPONSIBILITY', definitionId: r7def, text: `${W(7)} for E` });
    ok(has(await personJob(T), `${W(7)} for E`) && !has(await personJob(T), W(7)) && has(await personJob(Y), W(7)) && has(await seatJob(T), W(7)),
      'reworded for the person: their words today, the role’s yesterday and on the position');
    await J.personSwitchOffLine(db, hr, E.e, { kind: 'RESPONSIBILITY', definitionId: line(await personJob(T), `${W(1)} reworded`).definitionId });
    ok(line(await personJob(T), `${W(1)} reworded`)?.mark === 'OFF' && line(await personJob(T), `${W(1)} reworded`)?.markLayer === 'PERSON' && has(await personJob(T, E.f), `${W(1)} reworded`),
      'switched off for the person: off for them, still on for the other person');
    await J.personSwitchOffLine(db, OWNER, E.e, { kind: 'RESPONSIBILITY', definitionId: line(await personJob(T), W(8)).definitionId, takesEffect: D1, reason: 'Fixture' });
    await J.personUndoLine(db, hr, E.e, { kind: 'RESPONSIBILITY', definitionId: line(await personJob(T), W(8)).definitionId });
    ok(line(await personJob(Y), W(8))?.mark === 'OFF' && line(await personJob(T), W(8))?.mark === null, 'undone for the person today: off yesterday, back today');
    const r8def = line(await personJob(T), W(8)).definitionId;
    const nothing = await caught(() => J.personUndoLine(db, hr, E.e, { kind: "RESPONSIBILITY", definitionId: r8def }));
    ok(refused(nothing, 422, 'NOTHING_TO_UNDO'), 'undo where the person changed nothing: 422 NOTHING_TO_UNDO', why(nothing));
    // Search answers with positions: the person's own line is not the seat's.
    const lines = (await effectiveLinesForPositions(db, COMPANY, [{ id: P.p, roleId: role }])).get(P.p);
    const eDef = line(await personJob(T), `${TAG} E own line`).definitionId;
    ok(!lines.some((l) => Number(l.definitionId) === Number(eDef)) && lines.some((l) => l.origin === 'POSITION'), 'search does not see the person’s own lines (they are not the position’s); it does see the position’s');
    // Do it in words: a KPI for one person.
    const kpiText = `${TAG} scrap under 2%`;
    const said = `add KPI "${kpiText}" for ${TAG} Person F`;
    const read = await readCommand(said, await loadRecords(db, COMPANY, {}), { useModel: false });
    const step = read.plan.steps[0];
    ok(step?.action === 'add_kpi' && step.fields.person?.ref?.id === E.f && !step.fields.role?.ref && !step.fields.position?.ref,
      'do it in words: "add KPI … for <a person>" reads as a KPI for that person', JSON.stringify(step?.fields ?? null).slice(0, 300));
    await applyPlan(db, { companyId: COMPANY, userId: owner.id, can: () => true, scope: { all: true } }, read.plan.steps, { conn: db, text: said });
    ok(line(await personJob(T, E.f), kpiText)?.markLayer === 'PERSON' && !has(await seatJob(T, P.q), kpiText),
      '…applied, it is on that person’s job, marked for them, and not on their position');
    const noRight = await readCommand(said.replace('scrap', 'waste'), await loadRecords(db, COMPANY, {}), { useModel: false });
    const refusedPlan = await caught(() => applyPlan(db, { companyId: COMPANY, userId: owner.id, can: (t) => t !== PERM.employees.edit, scope: { all: true } }, noRight.plan.steps, { conn: db }));
    ok(refused(refusedPlan, 422, 'PLAN_NOT_CLEAR'), '…and without employees_edit the plan is refused before anything is written', why(refusedPlan));
    // They move: their own changes stay with the old position.
    const moveOn = shift(T, 3);
    await moveEmployee(db, hr, E.e, { positionId: P.q2, effectiveFrom: moveOn });
    const after = await personJob(moveOn);
    ok(after.positionId === P.q2 && !has(after, `${TAG} E own line`) && line(after, W('k3'))?.targetText === '10' && has(after, W(7)),
      `moved on ${moveOn}: in the new position none of their own changes follow them`);
    ok(has(await personJob(shift(moveOn, -1)), `${TAG} E own line`), '…the day before the move, they are all still theirs (history keeps them)');
  }

  /* ══ 4. history ═══════════════════════════════════════════════════════════ */
  section('[4] History, newest first');
  {
    const rh = await H.roleJobHistory(db, COMPANY, role);
    const sorted = rh.items.every((it, i) => i === 0 || (rh.items[i - 1].on ?? '') >= (it.on ?? ''));
    ok(sorted && rh.items[0].on === AHEAD && rh.items[0].coming === true, 'the role’s history is newest first, a change dated ahead at the top marked "coming"');
    const rew = rh.items.find((x) => x.what === 'REWORDED' && x.to === `${W(1)} reworded`);
    const added = rh.items.find((x) => x.what === 'ADDED' && x.line === W(1));
    ok(rew && added && rew.lineKey === added.lineKey && rew.from === W(1) && rew.on === T && rew.by, 'a rewording is listed with the old and the new words, on the same line as when it was added, and who did it');
    ok(rh.items.some((x) => x.what === 'TARGET_CHANGED' && x.line === W('k1') && x.from === '95%' && x.to === '98%')
      && rh.items.some((x) => x.what === 'REMOVED' && x.line === W(2) && x.on === T)
      && rh.items.some((x) => x.what === 'ADDED' && x.line === W(3) && x.on === T)
      && rh.items.some((x) => x.what === 'REWORDED' && x.kind === 'KRA' && x.from === `${TAG} Quality` && x.to === `${TAG} Quality and finish`)
      && rh.items.some((x) => x.what === 'TARGET_CHANGED' && x.line === W('k2') && x.on === Y && x.reason === 'Agreed at the review on Monday')
      && rh.items.some((x) => x.what === 'REMOVED' && x.kind === 'KRA' && x.line === `${TAG} Safety`),
    'target changed (from, to), removed, added, a KRA renamed, an Owner’s past-dated change with its reason, a KRA removed');
    const ph = await H.positionJobHistory(db, COMPANY, P.p);
    const prew = ph.items.find((x) => x.layer === 'POSITION' && x.what === 'REWORDED');
    const role4 = rh.items.find((x) => x.what === 'ADDED' && x.line === W(4));
    ok(prew && prew.from === W(4) && prew.to === `${W(4)} for P` && prew.lineKey === role4?.lineKey, 'the position’s rewording is listed as a change of the role’s line (one line, its story through both layers)');
    ok(['ADDED', 'TARGET_CHANGED', 'SWITCHED_OFF', 'RESTORED'].every((w) => ph.items.some((x) => x.layer === 'POSITION' && x.what === w))
      && ph.items.some((x) => x.layer === 'ROLE') && ph.items.some((x) => x.kind === 'POSITION' && x.what === 'REPORTS_TO'),
    'the position’s history: its own adds, target changes, switch-offs and undos, the role’s changes, and its reporting line');
    const eh = await H.employeeJobHistory(db, COMPANY, E.e);
    ok(eh.items.some((x) => x.layer === 'PERSON' && x.what === 'ADDED' && x.line === `${TAG} E own line`)
      && eh.items.some((x) => x.what === 'STARTED_IN' && x.coming) && eh.items.some((x) => x.what === 'LEFT_POSITION')
      && eh.items.every((it, i) => i === 0 || (eh.items[i - 1].on ?? '') >= (it.on ?? '')),
    'the person’s history: their own changes and the positions they held (the move dated ahead is "coming"), newest first');
  }

  /* ══ 5. readers ═══════════════════════════════════════════════════════════ */
  section('[5] The JD builder and the responsibility profile read the day they are asked for');
  {
    const jdYAll = await buildRoleJd(db, hr, { roleId: role, positionId: P.p, on: Y });
    const jdY = JSON.stringify({ kras: jdYAll.content.kras, additional: jdYAll.content.additional });
    const jdTAll = await buildRoleJd(db, hr, { roleId: role, positionId: P.p, on: T });
    const jdT = JSON.stringify({ kras: jdTAll.content.kras, additional: jdTAll.content.additional });
    ok(jdY.includes(W(4)) && !jdY.includes(`${W(4)} for P`) && jdT.includes(`${W(4)} for P`) && jdY.includes(`${TAG} Quality"`) && jdT.includes(`${TAG} Quality and finish`),
      'the position’s JD as on yesterday has the old words and the old KRA name; as on today the new');
    ok(jdYAll.asOf === Y && jdTAll.asOf === T && jdYAll.positionContext.overrides.every((o) => !o.effectiveTo || o.effectiveTo >= Y), 'each JD is dated the day asked for, and lists no exception that had ended before it');
    const profile = JSON.stringify(await buildResponsibilityProfile(db, hr, { employeeId: E.e, on: T }));
    ok(profile.includes(`${TAG} E own line`) && profile.includes('specific to this person'), 'the person’s responsibility profile carries their own line, said as "specific to this person"');
  }

  /* ══ 6. rights ════════════════════════════════════════════════════════════ */
  section('[6] Rights over HTTP');
  {
    const catalogRows = await ensureCatalog(db);
    const customRole = async (name, tags, scope = 'COMPANY') => {
      const id = await ins('INSERT INTO roles (name, company_id) VALUES (?, ?)', [`${TAG} ${name}`, COMPANY]);
      await db.query('INSERT INTO hrms_access_roles (company_id, role_id, label, scope) VALUES (?, ?, ?, ?)', [COMPANY, id, `${TAG} ${name}`, scope]);
      await setRoleTags(db, { companyId: COMPANY, appId: app.id, roleId: id, tags, catalog: catalogRows });
      return id;
    };
    const [[employeeRole]] = await db.query("SELECT id, name FROM roles WHERE company_id = ? AND name = 'Employee' AND deleted_at IS NULL LIMIT 1", [COMPANY]);
    const login = async (label, roleId, roleName, employeeId = null) => {
      const email = `${TAG.toLowerCase()}.${label.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.test`;
      const id = await ins('INSERT INTO users (name, email, password, role_id, company_id) VALUES (?, ?, ?, ?, ?)', [`${TAG} ${label}`, email, 'x', roleId, COMPANY]);
      await db.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [id, app.id, roleId, COMPANY]);
      if (employeeId) await db.query('UPDATE hrms_employees SET user_id = ? WHERE id = ?', [id, employeeId]);
      return { id, token: signToken({ id, email, role: roleName, company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
    };
    const viewer = await customRole('Viewer', [PERM.employees.view]);
    const editor = await customRole('Editor', [PERM.employees.view, PERM.employees.edit]);
    const scoped = await customRole('Scoped', [PERM.employees.view, PERM.employees.edit], 'DEPARTMENT');
    const posEdit = await customRole('Positions', [PERM.positions.view, PERM.positions.edit, PERM.employees.view]);
    const U = {
      viewer: await login('Viewer', viewer, `${TAG} Viewer`),
      editor: await login('Editor', editor, `${TAG} Editor`),
      scoped: await login('Scoped', scoped, `${TAG} Scoped`, E.h),            // department B
      positions: await login('Positions', posEdit, `${TAG} Positions`),
      manager: await login('Manager', employeeRole.id, employeeRole.name, E.m),   // P and Q report to M
      employee: await login('Employee', employeeRole.id, employeeRole.name, E.f),
    };
    forgetAccess();
    const server = express();
    server.use(express.json({ limit: '5mb' }));
    server.use(cookieParser());
    server.use('/api', appContext);
    hrmsApp.register(server);
    listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
    const base = `http://127.0.0.1:${listener.address().port}/api/${company.slug}/cf_hrms`;
    const call = async (who, method, url, body) => {
      const res = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      let json = null;
      try { json = await res.json(); } catch { /* none */ }
      return { status: res.status, json };
    };
    const add = (who, employeeId, text) => call(who, 'POST', `/people/employees/${employeeId}/job-content/add`, { kind: 'RESPONSIBILITY', text });
    const fRead = await call(U.viewer, 'GET', `/people/employees/${E.f}/job-content`);
    const fWrite = await add(U.viewer, E.f, `${TAG} by viewer`);
    ok(fRead.status === 200 && fRead.json.subject === 'PERSON' && fWrite.status === 403, 'employees_view reads a person’s job (200) but cannot change it (403)', `${fRead.status} ${fWrite.status}`);
    const byEditor = await add(U.editor, E.f, `${TAG} by editor`);
    ok(byEditor.status === 200 && byEditor.json.kras !== undefined, 'employees_edit changes it (200)', `${byEditor.status} ${byEditor.json?.message ?? ''}`);
    const byPositions = await add(U.positions, E.f, `${TAG} by positions`);
    ok(byPositions.status === 403, 'positions_edit is not the right for a person’s job (403)', `${byPositions.status}`);
    const outside = await add(U.scoped, E.f, `${TAG} by scoped`);
    const insideIt = await add(U.scoped, E.h, `${TAG} by scoped`);
    ok(outside.status === 403 && outside.json.code === 'OUT_OF_SCOPE' && insideIt.status === 200, 'a department-scoped login: a person outside its department 403 OUT_OF_SCOPE, inside 200', `${outside.status} ${outside.json?.code} ${insideIt.status}`);
    const pastHttp = await call(U.editor, 'POST', `/people/employees/${E.f}/job-content/add`, { kind: 'KPI', text: `${TAG} past`, takesEffect: Y });
    ok(pastHttp.status === 422 && pastHttp.json.code === 'PAST_DATE', 'over HTTP, a past day from a non-Owner: 422 PAST_DATE');
    const below = await call(U.manager, 'POST', `/user/me/team/employees/${E.f}/job-content/add`, { kind: 'RESPONSIBILITY', text: `${TAG} by manager` });
    const belowRead = await call(U.manager, 'GET', `/user/me/team/employees/${E.f}/job-content`);
    const own = await call(U.manager, 'POST', `/user/me/team/employees/${E.m}/job-content/add`, { kind: 'RESPONSIBILITY', text: `${TAG} own` });
    const boss = await call(U.manager, 'POST', `/user/me/team/employees/${E.top}/job-content/add`, { kind: 'RESPONSIBILITY', text: `${TAG} boss` });
    const kra = await call(U.manager, 'POST', `/user/me/team/employees/${E.f}/job-content/add`, { kind: 'KRA', text: 'x' });
    ok(below.status === 200 && belowRead.status === 200 && has(belowRead.json, `${TAG} by manager`), 'a manager login: a person below them — read and add (200)', `${below.status} ${below.json?.message ?? ''}`);
    ok(own.status === 403 && own.json.code === 'NOT_YOUR_TEAM' && boss.status === 403 && boss.json.code === 'NOT_YOUR_TEAM' && kra.status === 422 && kra.json.code === 'KRA_FIXED_AT_ROLE',
      'their own job and their manager’s: 403 NOT_YOUR_TEAM; a KRA for a person below: 422', `${own.status} ${boss.status} ${kra.status}`);
    const hrRoute = await add(U.manager, E.f, `${TAG} via HR`);
    const empOther = await add(U.employee, E.e, `${TAG} by employee`);
    const empRead = await call(U.employee, 'GET', `/people/employees/${E.e}/job-content`);
    const empTeam = await call(U.employee, 'POST', `/user/me/team/employees/${E.e}/job-content/add`, { kind: 'RESPONSIBILITY', text: 'x' });
    ok(hrRoute.status === 403 && empOther.status === 403 && empRead.status === 403 && empTeam.status === 403,
      'an Employee login: 403 on another person’s job by every door (and a manager login on the HR route: 403)', `${hrRoute.status} ${empOther.status} ${empRead.status} ${empTeam.status}`);
    const hist = await call(U.viewer, 'GET', `/people/employees/${E.e}/job-content/history`);
    const histPos = await call(U.positions, 'GET', `/positions/${P.p}/job-content/history`);
    const histRole = await call(U.positions, 'GET', `/roles/${role}/job-content/history`);
    ok(hist.status === 200 && histPos.status === 200 && histRole.status === 403, 'history follows the read rights: employees_view, positions_view; roles_view for a role (403 without)', `${hist.status} ${histPos.status} ${histRole.status}`);
  }
} catch (e) {
  ok(false, 'the run went to the end', e.stack ?? e.message);
} finally {
  if (listener) await new Promise((resolve) => listener.close(resolve));
  try { await db.rollback(); } catch { /* nothing */ }
  db.release();
  console.log('\n[rolled back]');
}

section('[7] The tenant is as it was found');
{
  const after = await tenant(slug);
  const moved = Object.keys(before).filter((k) => after[k] !== before[k]);
  ok(moved.length === 0, `every job-content table, the employees (${after.employees}) and the audit log hold exactly what they held`, moved.map((k) => `${k} ${before[k]} -> ${after[k]}`).join('; '));
  const fresh = mysql.createPool({ host: process.env.DB_HOST ?? 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306 });
  try {
    const [[co]] = await fresh.query('SELECT id FROM companies WHERE slug = ?', [slug]);
    const chart = (await buildOrgChart(fresh, co.id, {})).counts;
    ok(chart.positions === chartBefore.positions && chart.filled === chartBefore.filled && chart.vacant === chartBefore.vacant,
      `the chart: ${chart.positions} positions / ${chart.filled} filled / ${chart.vacant} vacant, as before`);
  } finally { await fresh.end(); }
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
