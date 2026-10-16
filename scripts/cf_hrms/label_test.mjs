/**
 * label_test.mjs — ONE label per department (TM/CF_HRMS_HIRING_SPEC.md §9; the
 * groups of §15 were removed on 2026-10-16).
 *
 *   1. the list: read (labels + shifts, no group fields), add, a name twice,
 *      rename (renames every department's label), reorder, remove in use
 *      (IN_USE; moveTo another label moves the departments), the last label;
 *   2. a department's label: by id or by name, the first label when none is
 *      given, a stranger's label refused, the read carries `type` + `labelId`;
 *   3. "New positions start on": the label's default shift, set / cleared /
 *      refused; a new position with no shift starts on it;
 *   4. the `label` filter on departments, positions, employees and hiring —
 *      "any of", a department's own label only, by id or by name;
 *   5. Excel: the departments column "Label" (a file with the header "Kind"
 *      still reads), a change is a CHANGE; positions and employees carry ONE
 *      info column "Label";
 *   6. code formats: the one `label` condition;
 *   7. the group routes are gone (404);
 *   8. rights (Employee 403, HR executive reads only) and tenant isolation;
 *   9. the list on the service: the first read of a company with no list,
 *      counts, the order the department form follows, the edge refusals;
 *  10. the 2026-10-12 label migration (cleanupALabels.mjs): mapping, plan,
 *      applied, run twice; this company has no old label left;
 *  11. the schema of §17 is applied (apply-label-defaults.mjs plans nothing);
 *  12. leave BY LABEL: role beats label beats location beats company;
 *  13. what a label's policy reaches (not child departments), every read
 *      agrees, usedBy, IN_USE, refusals;
 *  14. a label's default shift in EVERY creation path: POST /positions,
 *      add-sibling, the Excel upload, the command bar (a department made in the
 *      same plan too); a named shift wins; existing positions never change;
 *  15. rights and tenants for 12-14.
 *  (9-10 from cleanup_a_test, 11-15 from label_defaults_test — both retired 2026-10-16.)
 *
 *   node scripts/cf_hrms/label_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND: the whole run is ONE connection inside ONE
 * transaction (pool.query / getConnection point at it; a route's own
 * transaction is a savepoint), rolled back at the end. Local only.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import ExcelJS from 'exceljs';
import mysql from 'mysql2/promise';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import hrmsApp from '../../apps/cf_hrms/app.js';
import { forgetAccess } from '../../apps/cf_hrms/lib/accessContext.js';
import { hrmsAppOf } from '../../apps/cf_hrms/services/accessGrants.js';
import * as HIRE from '../../apps/cf_hrms/services/hiringService.js';
import { createScheme } from '../../apps/cf_erp/modules/codegen/service.js';
import * as LABELS from '../../apps/cf_hrms/services/departmentLabelService.js';
import * as ORG from '../../apps/cf_hrms/services/organisationService.js';
import * as POS from '../../apps/cf_hrms/services/positionService.js';
import * as LEAVE from '../../apps/cf_hrms/services/leavePolicyService.js';
import { getRole } from '../../apps/cf_hrms/services/roleContentService.js';
import { getPositionCard } from '../../apps/cf_hrms/services/orgChartService.js';
import { resolveEffective, loadAssignmentIndex } from '../../apps/cf_hrms/services/leavePolicyRead.js';
import { chooseNewShift } from '../../apps/cf_hrms/services/newPositionShift.js';
import { checkPlan, applyPlan } from '../../apps/cf_hrms/services/commands/plan.js';
import * as MIG from '../../apps/cf_hrms/scripts/cleanupALabels.mjs';
import { schemaSteps } from '../../apps/cf_hrms/scripts/apply-label-defaults.mjs';

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
const why = (e) => (e ? `${e.status ?? '?'} ${e.code ?? ''} ${e.message ?? ''}` : 'nothing was thrown');
const same = (a, b) => JSON.stringify([...a].map(String).sort()) === JSON.stringify([...b].map(String).sort());

const TABLES = ['hrms_label_groups', 'hrms_department_labels', 'hrms_department_label_links', 'hrms_departments', 'hrms_positions', 'hrms_employees', 'hrms_work_assignments',
  'hrms_hirings', 'hrms_audit_log', 'cf_code_schemes', 'cf_code_sequences', 'users', 'app_user_access', 'hrms_roles', 'hrms_locations', 'hrms_leave_policies',
  'hrms_leave_policy_rules', 'hrms_leave_policy_assignments', 'hrms_leave_types', 'hrms_position_reporting_relationships'];
const dbCfg = { host: process.env.DB_HOST ?? 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306 };
async function worldCount() {
  const conn = await mysql.createConnection(dbCfg);
  try {
    const out = {};
    for (const t of TABLES) { const [[r]] = await conn.query(`SELECT COUNT(*) AS n, COALESCE(SUM(deleted_at IS NULL), 0) AS live FROM ${t}`); out[t] = `${r.n}/${r.live}`; }
    const [[seq]] = await conn.query('SELECT COALESCE(SUM(next_value), 0) AS s FROM cf_code_sequences');
    out.counters = String(seq.s);
    return out;
  } finally { await conn.end(); }
}
const before = await worldCount();

const real = { query: pool.query.bind(pool), execute: pool.execute.bind(pool), getConnection: pool.getConnection.bind(pool) };
const db = await real.getConnection();
await db.beginTransaction();
let depth = 0;
const inside = {
  query: (...a) => db.query(...a),
  execute: (...a) => db.execute(...a),
  beginTransaction: async () => { depth += 1; await db.query(`SAVEPOINT zz_lb_${depth}`); },
  commit: async () => { if (depth > 0) { await db.query(`RELEASE SAVEPOINT zz_lb_${depth}`); depth -= 1; } },
  rollback: async () => { if (depth > 0) { await db.query(`ROLLBACK TO SAVEPOINT zz_lb_${depth}`); depth -= 1; } },
  release: () => {},
};
pool.query = inside.query;
pool.execute = inside.execute;
pool.getConnection = async () => inside;

const TAG = `ZZLB${Date.now().toString(36).toUpperCase().slice(-5)}`;
const q = async (sql, params) => (await db.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0] ?? null;
const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;

async function open(base64) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(base64, 'base64'));
  const ws = wb.getWorksheet('Data');
  const head = new Map();
  ws.getRow(1).eachCell((cell, col) => head.set(String(cell.value).replace(/\s*★\s*$/, ''), col));
  const text = (cell) => { const v = cell.value; return v == null ? '' : String(v); };
  return {
    wb, ws, head,
    col(h) { const col = head.get(h); if (!col) throw new Error(`no column "${h}" (have: ${[...head.keys()].join(', ')})`); return col; },
    get(row, h) { return text(ws.getCell(row, this.col(h))); },
    set(row, h, value) { ws.getCell(row, this.col(h)).value = value; },
    find(h, needle) { for (let r = 2; r <= ws.rowCount; r += 1) if (this.get(r, h).includes(needle)) return r; throw new Error(`no row whose "${h}" holds "${needle}"`); },
    async save() { return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64'); },
  };
}
const edited = async (base64, fn) => { const book = await open(base64); await fn(book); return book.save(); };

let server;
let karniAfter = null;
try {
  const company = await one('SELECT id, name, slug FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
  if (!company) throw new Error(`No company "${slug}".`);
  const COMPANY = company.id;
  const app = await hrmsAppOf(db, COMPANY);
  const other = await one(
    `SELECT co.id, co.name, co.slug, a.id AS app_id FROM companies co JOIN apps a ON a.company_id = co.id AND a.slug = 'cf_hrms' AND a.deleted_at IS NULL
      WHERE co.id <> ? AND co.deleted_at IS NULL ORDER BY co.id LIMIT 1`, [COMPANY]);
  const owner = await one(
    `SELECT u.id, u.email, u.name FROM users u JOIN app_user_access aua ON aua.user_id = u.id AND aua.app_id = ? AND aua.deleted_at IS NULL JOIN roles r ON r.id = aua.role_id
      WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [app.id, COMPANY]);
  if (!owner) throw new Error('This company has no Owner login.');
  const c = { companyId: COMPANY, userId: owner.id };
  console.log(`label_test — ${company.name} (${COMPANY}), run tag ${TAG}; the other company is ${other ? `${other.name} (${other.id})` : 'none'}`);

  const karni = async () => {
    const [[p]] = await db.query("SELECT COUNT(*) AS n FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL AND status <> 'CLOSED'", [COMPANY]);
    const [[e]] = await db.query('SELECT COUNT(*) AS n FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
    const kinds = await q("SELECT department_type AS t, COUNT(*) AS n FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL AND name NOT LIKE 'ZZ%' GROUP BY department_type ORDER BY department_type", [COMPANY]);
    return `${p.n} positions · ${e.n} employees · ${kinds.map((k) => `${k.t} ${k.n}`).join(' · ')}`;
  };
  const karniBefore = await karni();

  /* ══ logins and the in-process server ══════════════════════════════════ */
  const roleByKey = Object.fromEntries((await q('SELECT role_id, template_key FROM hrms_access_roles WHERE company_id = ? AND deleted_at IS NULL AND template_key IS NOT NULL', [COMPANY])).map((r) => [r.template_key, r.role_id]));
  const login = async (label, roleId) => {
    const email = `${TAG.toLowerCase()}.${label.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.test`;
    const id = await ins('INSERT INTO users (name, email, password, role_id, team_id, company_id) VALUES (?, ?, ?, ?, NULL, ?)', [`${TAG} ${label}`, email, 'x', roleId, COMPANY]);
    await db.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [id, app.id, roleId, COMPANY]);
    const roleName = (await one('SELECT name FROM roles WHERE id = ?', [roleId])).name;
    return { id, token: signToken({ id, name: `${TAG} ${label}`, email, role: roleName, company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
  };
  const O = { id: owner.id, token: signToken({ id: owner.id, name: owner.name, email: owner.email, role: 'admin', company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
  const U = {
    EMPLOYEE: roleByKey.EMPLOYEE ? await login('Employee', roleByKey.EMPLOYEE) : null,
    HR_EXECUTIVE: roleByKey.HR_EXECUTIVE ? await login('HR executive', roleByKey.HR_EXECUTIVE) : null,
  };
  let THEM = null;
  if (other) {
    const theirAdmin = await one("SELECT u.id, u.email, u.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1", [other.id]);
    if (theirAdmin) {
      await db.query('INSERT IGNORE INTO app_user_access (user_id, app_id, role_id, company_id) SELECT ?, ?, role_id, ? FROM users WHERE id = ?', [theirAdmin.id, other.app_id, other.id, theirAdmin.id]);
      THEM = { id: theirAdmin.id, token: signToken({ id: theirAdmin.id, name: theirAdmin.name, email: theirAdmin.email, role: 'admin', company: other.slug, companyId: other.id, company_id: other.id, uiPermissions: [] }) };
    }
  }
  forgetAccess();

  server = express();
  server.use(express.json({ limit: '50mb' }));
  server.use(cookieParser());
  server.use('/api', appContext);
  hrmsApp.register(server);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  server.close = () => new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${listener.address().port}/api`;
  const call = async (who, method, url, body, { as = company.slug } = {}) => {
    const res = await fetch(`${base}/${as}/cf_hrms${url}`, {
      method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  const get = async (url, who = O) => { const r = await call(who, 'GET', url); if (r.status !== 200) throw new Error(`GET ${url}: ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
  const typeOf = async (deptId) => (await one('SELECT department_type FROM hrms_departments WHERE id = ?', [deptId])).department_type;
  const linkOf = async (deptId) => (await one(
    'SELECT l.name FROM hrms_department_label_links k JOIN hrms_department_labels l ON l.id = k.label_id WHERE k.company_id = ? AND k.department_id = ? AND k.deleted_at IS NULL', [COMPANY, deptId]))?.name ?? null;

  /* ══ 1. the list ═════════════════════════════════════════════════════════ */
  section('[1] The list: read, add, rename (cascade), reorder, remove with move-to');
  const read0 = await get('/organisation/department-labels');
  const label = (name) => read0.labels.find((l) => l.name === name);
  {
    const typeCounts = Object.fromEntries((await q('SELECT LOWER(department_type) AS t, COUNT(*) AS n FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL GROUP BY LOWER(department_type)', [COMPANY])).map((r) => [r.t, Number(r.n)]));
    ok(read0.labels.length >= 3 && read0.labels.every((l) => l.departmentCount === (typeCounts[l.name.toLowerCase()] ?? 0)),
      'GET /organisation/department-labels: each label with the number of departments that carry it', JSON.stringify(read0.labels.map((l) => [l.name, l.departmentCount])));
    ok(read0.labels.every((l) => !('groupId' in l) && !('groupName' in l)) && !('groups' in read0) && Array.isArray(read0.shifts) && read0.shifts.length > 0,
      'the read has no group fields, and carries the shifts "New positions start on" offers', Object.keys(read0.labels[0] ?? {}).join(','));
    ok(['Department', 'Section', 'Machine'].every((n) => label(n)), 'the list holds Department, Section and Machine');
  }
  const added = await call(O, 'POST', '/organisation/department-labels', { name: `  ${TAG}   Bay ` });
  const BAY = added.json;
  ok(added.status === 200 && BAY.name === `${TAG} Bay` && BAY.departmentCount === 0 && BAY.label?.id === BAY.id && !('groupId' in BAY), 'POST a label: trimmed, no departments yet', JSON.stringify(added.json));
  const dup = await call(O, 'POST', '/organisation/department-labels', { name: `${TAG} BAY` });
  const blank = await call(O, 'POST', '/organisation/department-labels', { name: '  ' });
  const long = await call(O, 'POST', '/organisation/department-labels', { name: 'x'.repeat(41) });
  ok(dup.status === 409 && dup.json.code === 'DUPLICATE' && blank.status === 422 && long.status === 422, 'a name twice (any case): 409 DUPLICATE; blank or over 40: 422', `${dup.status} ${blank.status} ${long.status}`);

  const mk = async (name, extra = {}) => call(O, 'POST', '/organisation/departments', { name: `${TAG} ${name}`, ...extra });
  const A = (await mk('A', { labelId: BAY.id })).json;
  const B = (await mk('B', { type: 'machine' })).json;
  const NONE = (await mk('No label given')).json;
  const CHILD = (await mk('A child', { parentId: A.id, labelId: label('Section').id })).json;
  ok(A.type === `${TAG} Bay` && A.labelId === BAY.id && !('labels' in A), 'a department made with labelId: type is its name, labelId its id, no `labels` list', JSON.stringify({ type: A.type, labelId: A.labelId }));
  ok(B.type === 'Machine' && B.labelId === label('Machine').id, 'a department made with type (the name, any case): the list\'s spelling and id', JSON.stringify({ type: B.type, labelId: B.labelId }));
  ok(NONE.type === read0.labels[0].name && NONE.labelId === read0.labels[0].id, 'no label given: the first label of the list');
  ok(await linkOf(A.id) === `${TAG} Bay` && await linkOf(B.id) === 'Machine', 'the link row is written beside department_type');

  const renamed = await call(O, 'PUT', `/organisation/department-labels/${BAY.id}`, { name: `${TAG} Big bay` });
  ok(renamed.status === 200 && renamed.json.departmentsRenamed === 1 && await typeOf(A.id) === `${TAG} Big bay`
    && (await get(`/organisation/departments?q=${TAG}%20A`)).rows.find((d) => d.id === A.id).type === `${TAG} Big bay`,
  'renaming a label renames it on every department that carries it', JSON.stringify(renamed.json));
  const clash = await call(O, 'PUT', `/organisation/department-labels/${BAY.id}`, { name: 'section' });
  ok(clash.status === 409, 'renaming to a name the list has (any case): 409');

  const order = (await get('/organisation/department-labels')).labels.map((l) => l.id);
  const reordered = await call(O, 'PUT', '/organisation/department-labels/order', { ids: [...order].reverse() });
  const badOrder = await call(O, 'PUT', '/organisation/department-labels/order', { ids: order.slice(1) });
  ok(reordered.status === 200 && JSON.stringify(reordered.json.labels.map((l) => l.id)) === JSON.stringify([...order].reverse()) && badOrder.status === 422,
    'PUT /order: every label once; a short list 422');
  await call(O, 'PUT', '/organisation/department-labels/order', { ids: order });

  const inUse = await call(O, 'DELETE', `/organisation/department-labels/${BAY.id}`);
  const toItself = await call(O, 'DELETE', `/organisation/department-labels/${BAY.id}?moveTo=${BAY.id}`);
  const toNone = await call(O, 'DELETE', `/organisation/department-labels/${BAY.id}?moveTo=none`);
  ok(inUse.status === 409 && inUse.json.code === 'IN_USE' && inUse.json.detail?.departmentCount === 1 && toItself.status === 422 && toNone.status === 422,
    'a label in use: 409 IN_USE (detail.departmentCount); moveTo itself or "none": 422 — a department always has a label', `${inUse.status} ${toItself.status} ${toNone.status}`);
  const moved = await call(O, 'DELETE', `/organisation/department-labels/${BAY.id}?moveTo=${label('Machine').id}`);
  ok(moved.status === 200 && moved.json.departmentsMoved === 1 && await typeOf(A.id) === 'Machine' && await linkOf(A.id) === 'Machine'
    && !(await get('/organisation/department-labels')).labels.some((l) => l.id === BAY.id),
  'removed with moveTo: its departments carry the other label (department_type and link), the label is gone', JSON.stringify(moved.json));
  const unused = (await call(O, 'POST', '/organisation/department-labels', { name: `${TAG} Spare` })).json;
  const goneUnused = await call(O, 'DELETE', `/organisation/department-labels/${unused.id}`);
  ok(goneUnused.status === 200 && goneUnused.json.departmentsMoved === 0, 'a label no department carries is removed without a move');
  {
    // The last label: every other one retired inside this run's transaction.
    await db.query('SAVEPOINT zz_last');
    const keep = label('Department').id;
    await db.query('UPDATE hrms_department_labels SET deleted_at = NOW() WHERE company_id = ? AND id <> ? AND deleted_at IS NULL', [COMPANY, keep]);
    const last = await call(O, 'DELETE', `/organisation/department-labels/${keep}`);
    ok(last.status === 409 && last.json.code === 'LAST_LABEL', 'the last label cannot be removed (409 LAST_LABEL)', `${last.status} ${last.json?.code}`);
    await db.query('ROLLBACK TO SAVEPOINT zz_last');
  }
  ok(Number((await one("SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_department_labels' AND entity_id = ?", [COMPANY, BAY.id])).n) >= 3,
    'label writes are in the audit log');

  /* ══ 2. a department's label ═════════════════════════════════════════════ */
  section('[2] A department\'s ONE label');
  {
    const byId = await call(O, 'PUT', `/organisation/departments/${B.id}`, { labelId: label('Section').id });
    ok(byId.status === 200 && byId.json.type === 'Section' && byId.json.labelId === label('Section').id && await linkOf(B.id) === 'Section', 'PUT labelId: type and link follow');
    const byName = await call(O, 'PUT', `/organisation/departments/${B.id}`, { type: 'Machine' });
    ok(byName.status === 200 && byName.json.type === 'Machine' && await linkOf(B.id) === 'Machine', 'PUT type (the old way): labelId and link follow');
    const nameOnly = await call(O, 'PUT', `/organisation/departments/${B.id}`, { name: `${TAG} B renamed` });
    ok(nameOnly.status === 200 && nameOnly.json.type === 'Machine', 'an edit that does not touch the label keeps it');
    const bogusId = await call(O, 'PUT', `/organisation/departments/${B.id}`, { labelId: 99999999 });
    const bogusName = await mk('Bogus', { type: `${TAG} no such` });
    ok(bogusId.status === 422 && bogusName.status === 422, 'a label id or name that is not in the list: 422', `${bogusId.status} ${bogusName.status}`);
    if (other) {
      const theirLabel = await one(
        `SELECT l.id FROM hrms_department_labels l JOIN hrms_label_groups g ON g.id = l.group_id AND g.is_kind = 1
          WHERE l.company_id = ? AND l.deleted_at IS NULL LIMIT 1`, [other.id]);
      if (theirLabel) ok((await mk('Stranger', { labelId: theirLabel.id })).status === 422, 'another company\'s label: 422');
    }
    const list = await get(`/organisation/departments?q=${TAG}`);
    ok(list.rows.every((d) => 'labelId' in d && !('labels' in d)), 'the list rows carry type + labelId, no `labels`');
    const chart = await get('/orgchart');
    const chartDept = (chart.departments ?? []).find((d) => d.id === A.id);
    ok(chartDept && chartDept.labelId === label('Machine').id && !('labels' in chartDept), 'the org chart\'s departments carry labelId, no `labels`', JSON.stringify(chartDept));
  }

  /* ══ 3. New positions start on ═══════════════════════════════════════════ */
  section('[3] "New positions start on": a label\'s default shift');
  const shifts = (await get('/organisation/department-labels')).shifts;
  const general = shifts.find((s) => String(s.code ?? '').toUpperCase().startsWith('G')) ?? shifts[0];
  const notGeneral = shifts.find((s) => s.id !== general.id) ?? null;
  const role = await ins("INSERT INTO hrms_roles (company_id, role_code, title, role_purpose, status) VALUES (?, ?, ?, 'Runs it.', 'ACTIVE')", [COMPANY, `${TAG}R`, `${TAG} Operator`]);
  {
    const machine = label('Machine');
    const set = await call(O, 'PUT', `/organisation/department-labels/${machine.id}`, { defaultShiftId: (notGeneral ?? general).id });
    const bad = await call(O, 'PUT', `/organisation/department-labels/${machine.id}`, { defaultShiftId: 99999999 });
    ok(set.status === 200 && set.json.defaultShiftId === (notGeneral ?? general).id && bad.status === 422, 'a label takes a default shift; a shift that is not the company\'s: 422', `${set.status} ${bad.status}`);
    const sugg = await get(`/positions/new-shift?departmentId=${A.id}`);
    ok(sugg.suggestion.from === 'LABEL' && sugg.suggestion.shift.id === (notGeneral ?? general).id && sugg.suggestion.label?.name === 'Machine' && !('groupName' in sugg.suggestion.label)
      && /from the label Machine/.test(sugg.suggestion.line), 'GET /positions/new-shift: a department labelled Machine starts on its shift', JSON.stringify(sugg.suggestion));
    const made = await call(O, 'POST', '/positions', { roleId: role, departmentId: A.id, status: 'ACTIVE' });
    const madeId = made.json?.id ?? made.json?.position?.id ?? null;
    const madeShift = madeId ? (await one('SELECT default_shift_id FROM hrms_positions WHERE id = ?', [madeId]))?.default_shift_id : null;
    ok(made.status === 200 && Number(madeShift) === (notGeneral ?? general).id,
      'a new position with no shift starts on its department\'s label default', JSON.stringify({ status: made.status, keys: Object.keys(made.json ?? {}), madeShift }));
    const other2 = await get(`/positions/new-shift?departmentId=${CHILD.id}`);
    ok(other2.suggestion.from === 'GENERAL', 'a department whose label has no default: the General shift (a parent\'s label does not count)');
    const cleared = await call(O, 'PUT', `/organisation/department-labels/${machine.id}`, { defaultShiftId: null });
    ok(cleared.status === 200 && cleared.json.defaultShiftId === null && (await get(`/positions/new-shift?departmentId=${A.id}`)).suggestion.from === 'GENERAL', 'cleared (null): back to the General shift');
  }

  /* ══ 4. filters ══════════════════════════════════════════════════════════ */
  section('[4] The label filter on Departments, Positions, Employees, Hiring');
  {
    const shift = general;
    const pos = async (code, departmentId) => ins("INSERT INTO hrms_positions (company_id, position_code, role_id, position_title, department_id, default_shift_id, status) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')", [COMPANY, `${TAG}-${code}`, role, `${TAG} ${code}`, departmentId, shift.id]);
    const P = { a: await pos('A', A.id), b: await pos('B', B.id), child: await pos('CH', CHILD.id), hire: await pos('HIRE', CHILD.id) };
    const emp = async (code) => ins("INSERT INTO hrms_employees (company_id, employee_code, full_name, date_of_joining, employment_type, employment_status) VALUES (?, ?, ?, '2026-01-01', 'EMPLOYEE', 'ACTIVE')", [COMPANY, `${TAG}${code}`, `${TAG} Person ${code}`]);
    const seat = async (e, p, d) => ins("INSERT INTO hrms_work_assignments (company_id, employee_id, role_id, position_id, department_id, is_primary, status, effective_from) VALUES (?, ?, ?, ?, ?, 1, 'ACTIVE', '2026-01-01')", [COMPANY, e, role, p, d]);
    const E = { a: await emp('A'), child: await emp('CH') };
    await seat(E.a, P.a, A.id); await seat(E.child, P.child, CHILD.id);
    await HIRE.startHiring(db, c, P.hire);
    const M = label('Machine').id;
    const S = label('Section').id;
    const D = async (labelQ) => (await get(`/organisation/departments?q=${TAG}&label=${labelQ}`)).rows.map((r) => r.id);
    ok(same(await D(M), [A.id, B.id]), 'departments ?label=<Machine>: A and B');
    ok(same(await D(`${M},${S}`), [A.id, B.id, CHILD.id]), 'two labels are "any of"');
    ok(same(await D('Section'), [CHILD.id]) && (await D(99999999)).length === 0, 'a label by name works; an id that is no label matches nothing');
    ok(!(await D(S)).includes(A.id), 'a department\'s own label only: A (Machine) is not in Section though its child is');
    const posQ = async (labelQ) => (await get(`/positions?q=${TAG}&label=${labelQ}`)).items.map((p) => p.id);
    ok(same(await posQ(S), [P.child, P.hire]) && (await posQ(M)).includes(P.a) && (await posQ(M)).includes(P.b), 'positions ?label=: by the position\'s department');
    const empQ = async (labelQ) => (await get(`/people/employees?q=${TAG}&label=${labelQ}`)).items.map((e) => e.id);
    ok(same(await empQ(M), [E.a]) && same(await empQ(S), [E.child]), 'employees ?label=: by their position\'s department');
    const hirQ = async (labelQ) => (await get(`/hirings?status=all&label=${labelQ}`)).hirings.filter((h) => String(h.positionCode ?? '').startsWith(TAG)).length;
    ok(await hirQ(S) === 1 && await hirQ(M) === 0, 'hiring ?label=: by the position\'s department');
  }

  /* ══ 5. Excel ════════════════════════════════════════════════════════════ */
  section('[5] Excel: the column "Label"; an old "Kind" file still reads');
  {
    const download = async (entity, query = '') => { const r = await call(O, 'GET', `/excel/${entity}/workbook${query}`); if (r.status !== 200) throw new Error(`download ${entity}: ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
    const preview = (entity, contentBase64) => call(O, 'POST', `/excel/${entity}/preview`, { fileName: `${entity}.xlsx`, contentBase64 });
    const applyX = (entity, contentBase64, expect) => call(O, 'POST', `/excel/${entity}/apply`, { fileName: `${entity}.xlsx`, contentBase64, expect });
    await db.query('UPDATE hrms_departments SET updated_at = NOW() - INTERVAL 1 MINUTE WHERE company_id = ? AND name LIKE ?', [COMPANY, `${TAG}%`]);
    const file = await download('departments', `?q=${TAG}`);
    const book = await open(file.contentBase64);
    const heads = [...book.head.keys()].filter((h) => !h.startsWith('_'));
    ok(heads.includes('Label') && !heads.includes('Kind') && heads.join('|') === 'Code|Name|Label|Under|Shared|Serves|Status',
      'the departments file: Code · Name · Label · Under · Shared · Serves · Status — no per-group columns', heads.join(', '));
    ok(book.get(book.find('Name', `${TAG} A`), 'Label') === 'Machine', 'a department\'s cell holds its label');
    const unchanged = await preview('departments', file.contentBase64);
    ok(unchanged.status === 200 && unchanged.json.summary.change === 0 && unchanged.json.summary.problems === 0, 'download -> upload unchanged = every row SAME', JSON.stringify(unchanged.json?.summary));
    const oldFile = await edited(file.contentBase64, (b) => { b.ws.getRow(1).getCell(b.head.get('Label')).value = 'Kind ★'; });
    const old = await preview('departments', oldFile);
    ok(old.status === 200 && old.json.summary.change === 0 && old.json.summary.problems === 0, 'a file with the header "Kind" (downloaded while labels had groups) reads the same', JSON.stringify(old.json?.summary ?? old.json));
    const changedFile = await edited(file.contentBase64, (b) => b.set(b.find('Name', `${TAG} A`), 'Label', 'Section'));
    const changed = await preview('departments', changedFile);
    const row = changed.json.rows.find((r) => r.action === 'CHANGE');
    ok(changed.json.summary.change === 1 && row?.changes.length === 1 && row.changes[0].column === 'Label' && row.changes[0].from === 'Machine' && row.changes[0].to === 'Section',
      'a label changed in the file = one CHANGE, from -> to', JSON.stringify(row));
    const applied = await applyX('departments', changedFile, { add: 0, change: 1 });
    ok(applied.status === 200 && await typeOf(A.id) === 'Section' && await linkOf(A.id) === 'Section', 'applied: the department now carries Section (department_type and link)');
    await db.query('UPDATE hrms_departments SET updated_at = NOW() - INTERVAL 1 MINUTE WHERE company_id = ? AND name LIKE ?', [COMPANY, `${TAG}%`]);
    const fresh = (await download('departments', `?q=${TAG}`)).contentBase64;
    const oldChanged = await edited(fresh, (b) => { b.ws.getRow(1).getCell(b.head.get('Label')).value = 'Kind ★'; b.head.set('Kind', b.head.get('Label')); b.set(b.find('Name', `${TAG} A`), 'Kind', 'Machine'); });
    const oldApplied = await applyX('departments', oldChanged, { add: 0, change: 1 });
    ok(oldApplied.status === 200 && await typeOf(A.id) === 'Machine', 'a change in an old "Kind" file is applied too', JSON.stringify(oldApplied.json));
    const wrong = await preview('departments', await edited(fresh, (b) => b.set(b.find('Name', `${TAG} B`), 'Label', `${TAG} no such`)));
    ok(wrong.json.rows.some((r) => r.action === 'PROBLEM' && String(r.label ?? '').includes('B') && /no such/.test(JSON.stringify(r.problems))), 'a label that is not in the list = a problem on that row', JSON.stringify(wrong.json.rows.filter((r) => r.action === 'PROBLEM')));
    const pFile = await download('positions', `?q=${TAG}&label=${label('Section').id}`);
    const pBook = await open(pFile.contentBase64);
    const pHeads = [...pBook.head.keys()].filter((h) => !h.startsWith('_'));
    const pList = await get(`/positions?q=${TAG}&label=${label('Section').id}`);
    ok(pHeads.filter((h) => h === 'Label').length === 1 && !pHeads.includes('Kind') && pHeads[pHeads.length - 1] === 'Label'
      && pBook.get(pBook.find('Code', `${TAG}-CH`), 'Label') === 'Section' && pFile.rows === pList.count && pList.count >= 2,
    'positions file: ONE info column "Label" with the department\'s label; the label filter decides the rows', `${pHeads.join(', ')} · ${pFile.rows} rows`);
    const pSame = await preview('positions', pFile.contentBase64);
    ok(pSame.json.summary.change === 0 && pSame.json.summary.problems === 0, 'the info column is ignored on upload (unchanged file = SAME)');
    const eFile = await download('employees', `?q=${TAG}`);
    const eBook = await open(eFile.contentBase64);
    ok([...eBook.head.keys()].filter((h) => h === 'Label').length === 1 && !eBook.head.has('Kind') && eBook.get(eBook.find('Name', `${TAG} Person CH`), 'Label') === 'Section',
      'employees file: ONE info column "Label"', [...eBook.head.keys()].join(', '));
  }

  /* ══ 6. code formats ═════════════════════════════════════════════════════ */
  section('[6] Code formats: the one label condition');
  {
    const entities = await get('/codegen/entities');
    const dept = (Array.isArray(entities) ? entities : entities.entities).find((e) => e.entityType === 'hrms_department');
    const labelConds = dept.conditionTokens.filter((t) => t.key.startsWith('label'));
    ok(labelConds.length === 1 && labelConds[0].key === 'label' && labelConds[0].label === 'Label' && !('groupId' in labelConds[0]),
      'GET /codegen/entities: departments are tested on ONE condition, `label` ("Label"); no per-group conditions', dept.conditionTokens.map((t) => t.key).join(', '));
    await createScheme(db, COMPANY, c.userId, {
      code: `${TAG}_MC`, name: `${TAG} Machines`, entityType: 'hrms_department', targetField: 'code', seqScope: 'prefix', priority: 10, status: 'active',
      conditions: [{ tokenKey: 'label', operator: 'eq', value: String(label('Machine').id) }],
      segments: [{ segmentType: 'literal', literalText: `${TAG}MC-` }, { segmentType: 'sequence', format: '00' }],
    });
    const machine = (await mk('Coded machine', { labelId: label('Machine').id })).json;
    const section2 = (await mk('Coded section', { labelId: label('Section').id })).json;
    ok(machine.code === `${TAG}MC-01` && !String(section2.code).startsWith(`${TAG}MC`), 'a rule "when its label is Machine" codes a Machine department, not a Section', `${machine.code} ${section2.code}`);
    const gone = await caught(() => createScheme(db, COMPANY, c.userId, {
      code: `${TAG}_GRP`, name: `${TAG} group`, entityType: 'hrms_department', targetField: 'code', seqScope: 'prefix', priority: 10, status: 'active',
      conditions: [{ tokenKey: 'label.1', operator: 'eq', value: String(label('Machine').id) }], segments: [{ segmentType: 'sequence', format: '0' }],
    }));
    ok(gone != null, 'a rule with a per-group condition (label.<groupId>) is refused: that condition no longer exists', gone?.message);
    await db.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND code LIKE ?", [COMPANY, `${TAG}%`]);
  }

  /* ══ 7. the group routes are gone ════════════════════════════════════════ */
  section('[7] The label-group routes are gone');
  {
    const r = [
      await call(O, 'GET', '/organisation/label-groups'),
      await call(O, 'POST', '/organisation/label-groups', { name: `${TAG} Unit` }),
      await call(O, 'PUT', '/organisation/label-groups/order', { ids: [] }),
      await call(O, 'PUT', '/organisation/label-groups/1', { name: 'x' }),
      await call(O, 'DELETE', '/organisation/label-groups/1?force=1'),
    ];
    ok(r.every((x) => x.status === 404), 'GET / POST / PUT order / PUT / DELETE /organisation/label-groups: 404', r.map((x) => x.status).join(' '));
    ok(Number((await one('SELECT COUNT(*) AS n FROM hrms_label_groups WHERE company_id = ? AND deleted_at IS NULL', [COMPANY])).n) === 1, 'the company still has its one label group row (the tables stay)');
    const options = await get('/commands/options');
    ok(Array.isArray(options.labels) && options.labels.includes('Machine') && !('labelGroups' in options), 'GET /commands/options: the labels by name, no groups');
  }

  /* ══ 8. rights and tenants ═══════════════════════════════════════════════ */
  section('[8] Rights and tenant isolation');
  {
    if (!U.EMPLOYEE) skip('Employee rights', 'no Employee access role');
    else {
      const e1 = await call(U.EMPLOYEE, 'GET', '/organisation/department-labels');
      const e2 = await call(U.EMPLOYEE, 'POST', '/organisation/department-labels', { name: `${TAG} no` });
      const e3 = await call(U.EMPLOYEE, 'DELETE', `/organisation/department-labels/${label('Machine').id}`);
      ok(e1.status === 403 && e2.status === 403 && e3.status === 403, 'an Employee login: 403 on reading and writing labels', `${e1.status} ${e2.status} ${e3.status}`);
    }
    if (!U.HR_EXECUTIVE) skip('HR executive rights', 'no HR executive access role');
    else {
      const h1 = await call(U.HR_EXECUTIVE, 'GET', '/organisation/department-labels');
      const h2 = await call(U.HR_EXECUTIVE, 'POST', '/organisation/department-labels', { name: `${TAG} no` });
      const h3 = await call(U.HR_EXECUTIVE, 'PUT', `/organisation/department-labels/${label('Machine').id}`, { defaultShiftId: null });
      ok(h1.status === 200 && h2.status === 403 && h3.status === 403, 'an HR executive (org view, no org edit): reads the labels, cannot change them', `${h1.status} ${h2.status} ${h3.status}`);
    }
    if (!THEM) skip('tenant isolation', 'no second company with an admin login');
    else {
      const theirs = await call(THEM, 'GET', '/organisation/department-labels', undefined, { as: other.slug });
      const t2 = await call(THEM, 'PUT', `/organisation/department-labels/${label('Machine').id}`, { name: 'Taken' }, { as: other.slug });
      const t3 = await call(THEM, 'DELETE', `/organisation/department-labels/${label('Machine').id}`, undefined, { as: other.slug });
      const theirFilter = await call(THEM, 'GET', `/organisation/departments?label=${label('Machine').id}`, undefined, { as: other.slug });
      ok(theirs.status === 200 && !theirs.json.labels.some((l) => l.id === label('Machine').id) && t2.status === 404 && t3.status === 404 && theirFilter.json.count === 0,
        'another company: does not see these labels, cannot rename or remove them, and filtering by them finds nothing of theirs',
        `${theirs.status} ${t2.status} ${t3.status} ${theirFilter.json?.count}`);
    }
  }
  /* ══ 9. the list's edges, on the service (from cleanup_a_test, 2026-10-16) ═ */
  section('[9] The list on the service: first read, counts, the order the form follows, edge refusals');
  {
    const refusedAs = (e, status, code) => Boolean(e) && e.status === status && e.code === code;
    const names = (list) => list.labels.map((l) => l.name);
    // A company with no department: its list is made on first read.
    const fresh = await one(
      `SELECT co.id, co.name FROM companies co WHERE co.id <> ? AND co.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM hrms_departments d WHERE d.company_id = co.id) ORDER BY co.id LIMIT 1`, [COMPANY]);
    if (!fresh) skip('a first read', 'no other company without departments');
    else {
      await db.query('DELETE FROM hrms_department_labels WHERE company_id = ?', [fresh.id]);
      const first = await LABELS.listLabels(db, fresh.id);
      ok(JSON.stringify(names(first)) === JSON.stringify(['Department', 'Section', 'Machine']) && first.labels.every((l, i) => l.sortOrder === i + 1 && l.departmentCount === 0 && l.id > 0 && l.defaultShiftId === null)
        && JSON.stringify(Object.keys(first.labels[0])) === JSON.stringify(['id', 'name', 'sortOrder', 'departmentCount', 'defaultShiftId']),
      'a company with no list gets Department, Section, Machine on its first read: { id, name, sortOrder, departmentCount, defaultShiftId }', JSON.stringify(first.labels));
      ok(JSON.stringify((await LABELS.listLabels(db, fresh.id)).labels.map((l) => l.id)) === JSON.stringify(first.labels.map((l) => l.id)), 'a second read writes nothing more');
      await db.query('DELETE FROM hrms_department_labels WHERE company_id = ?', [fresh.id]);
      await db.query("INSERT INTO hrms_departments (company_id, code, name, department_type) VALUES (?, ?, ?, 'Bay'), (?, ?, ?, 'section')", [fresh.id, `${TAG}X1`, `${TAG} X1`, fresh.id, `${TAG}X2`, `${TAG} X2`]);
      const withOwn = await LABELS.listLabels(db, fresh.id);
      ok(JSON.stringify(names(withOwn)) === JSON.stringify(['Department', 'Section', 'Machine', 'Bay']) && withOwn.labels[3].departmentCount === 1 && withOwn.labels[1].departmentCount === 1,
        'a company whose departments already use a label of their own gets it in the list too; counts ignore case', JSON.stringify(withOwn.labels));
    }
    const start = await LABELS.listLabels(db, COMPANY);
    const live = Number((await one('SELECT COUNT(*) AS n FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL', [COMPANY])).n);
    ok(start.labels.reduce((t, l) => t + l.departmentCount, 0) === live, `every department's label is one of the list: the counts add up to the company's ${live} departments`);
    ok(JSON.stringify((await ORG.listDepartments(db, COMPANY)).types) === JSON.stringify(names(start)), 'GET /organisation/departments carries `types`: the list, in its order');

    const line = await LABELS.createLabel(db, c, { name: `${TAG} Line` });
    const groupId = (await one('SELECT group_id FROM hrms_department_labels WHERE id = ?', [line.id])).group_id;
    const dbDup = await caught(() => db.query('INSERT INTO hrms_department_labels (company_id, group_id, name) VALUES (?, ?, ?)', [COMPANY, groupId, `${TAG} line`]));
    ok(dbDup?.errno === 1062, 'the database refuses a name twice too (uq_hdlb_group_name, without case)', dbDup?.code ?? 'accepted');
    const d1 = await ORG.createDepartment(db, c, { name: `${TAG} Svc one`, type: `${TAG} line` });
    const d2 = await ORG.createDepartment(db, c, { name: `${TAG} Svc two`, type: `${TAG} Line`, isShared: true });
    const unknown = await caught(() => ORG.createDepartment(db, c, { name: `${TAG} Bad`, type: `${TAG} Nope` }));
    const blankUpdate = await caught(() => ORG.updateDepartment(db, c, d1.id, { type: '' }));
    ok(d1.type === `${TAG} Line` && refusedAs(unknown, 422, 'INVALID') && /not one of this company/.test(unknown.message) && unknown.problems[0].includes(start.labels[0].name)
      && refusedAs(blankUpdate, 422, 'INVALID') && await typeOf(d1.id) === `${TAG} Line`,
    'a label is stored as the list spells it; one not in the list is refused naming the choices; an update cannot blank it', `${why(unknown)} | ${why(blankUpdate)}`);
    ok((await LABELS.updateLabel(db, c, line.id, { name: `${TAG} Line` })).departmentsRenamed === 0 && (await LABELS.updateLabel(db, c, line.id, { sortOrder: 50 })).sortOrder === 50
      && refusedAs(await caught(() => LABELS.updateLabel(db, c, 999999999, { name: 'x' })), 404, 'NOT_FOUND') && refusedAs(await caught(() => LABELS.updateLabel(db, c, line.id, { name: '' })), 422, 'INVALID'),
    'the same name again renames nothing; sortOrder alone is saved; a label that does not exist: 404; no name: 422');
    const ids = (await LABELS.listLabels(db, COMPANY)).labels.map((l) => l.id);
    ok(refusedAs(await caught(() => LABELS.reorderLabels(db, c, { ids: [...ids.slice(1), ids[1]] })), 422, 'INVALID') && refusedAs(await caught(() => LABELS.reorderLabels(db, c, { ids: [...ids.slice(1), 999999999] })), 422, 'INVALID')
      && refusedAs(await caught(() => LABELS.reorderLabels(db, c, {})), 422, 'INVALID'), 'an order that repeats a label, names a stranger or is missing: 422');
    const theirs = fresh ? (await LABELS.listLabels(db, fresh.id)).labels[0] : null;
    ok(refusedAs(await caught(() => LABELS.deleteLabel(db, c, line.id, { moveTo: 999999999 })), 422, 'INVALID')
      && (!theirs || refusedAs(await caught(() => LABELS.deleteLabel(db, c, line.id, { moveTo: theirs.id })), 422, 'INVALID')) && await typeOf(d1.id) === `${TAG} Line`,
    'moveTo a label that does not exist, or another company\'s: 422, and nothing moved');
    const section2 = start.labels.find((l) => l.name === 'Section');
    const gone = await LABELS.deleteLabel(db, c, line.id, { moveTo: String(section2.id) });
    ok(gone.departmentsMoved === 2 && await typeOf(d2.id) === 'Section' && Number((await one('SELECT is_shared FROM hrms_departments WHERE id = ?', [d2.id])).is_shared) === 1,
      'moved with ?moveTo= (given as text): a shared department stays shared', JSON.stringify(gone));
    ok((await LABELS.createLabel(db, c, { name: `${TAG} Line` })).id !== line.id, 'a removed label\'s name is free again');
  }

  /* ══ 10. the label migration of 2026-10-12 (from cleanup_a_test) ═══════ */
  section('[10] The label migration (apps/cf_hrms/scripts/cleanupALabels.mjs)');
  {
    ok(MIG.renamed('Process') === 'Section' && MIG.renamed('shared CREW') === 'Section' && MIG.renamed(' Machine / area ') === 'Machine' && MIG.renamed(null) === 'Department' && MIG.renamed('  ') === 'Department'
      && MIG.renamed('Department') === 'Department' && MIG.renamed(' Bay ') === 'Bay', 'the mapping: Process -> Section, Shared crew -> Section, Machine / area -> Machine, none -> Department, anything else kept');
    const plan = MIG.planLabels([
      { id: 1, department_type: 'Process', is_shared: 0, deleted_at: null }, { id: 2, department_type: 'Shared crew', is_shared: 0, deleted_at: null },
      { id: 3, department_type: 'Shared crew', is_shared: 1, deleted_at: null }, { id: 4, department_type: 'Machine / area', is_shared: 0, deleted_at: null },
      { id: 5, department_type: null, is_shared: 0, deleted_at: null }, { id: 6, department_type: 'Section', is_shared: 0, deleted_at: null },
      { id: 7, department_type: 'Bay', is_shared: 0, deleted_at: null }, { id: 8, department_type: 'Process', is_shared: 0, deleted_at: '2026-01-01 00:00:00' },
    ], []);
    ok(JSON.stringify(plan.before) === JSON.stringify({ '(no label)': 1, Bay: 1, 'Machine / area': 1, Process: 1, Section: 1, 'Shared crew': 2 })
      && JSON.stringify(plan.after) === JSON.stringify({ Bay: 1, Department: 1, Machine: 1, Section: 4 }) && plan.sharedBefore === 1 && plan.sharedAfter === 2
      && JSON.stringify(plan.share) === JSON.stringify([2]) && JSON.stringify(plan.add) === JSON.stringify(['Department', 'Section', 'Machine', 'Bay']) && plan.renameCount === 6
      && JSON.stringify(plan.rename.get('Section')) === JSON.stringify([1, 2, 3, 8]),
    'the plan: counts per label before and after (live departments), who becomes shared, what the list gains — a deleted department is renamed but not counted');
    const kept = MIG.planLabels([{ id: 1, department_type: 'Machine / area', is_shared: 0, deleted_at: null }, { id: 2, department_type: 'Bay', is_shared: 0, deleted_at: null }],
      [{ id: 9, name: 'Department', sort_order: 1 }, { id: 10, name: 'machine', sort_order: 2 }]);
    ok(JSON.stringify(kept.add) === JSON.stringify(['Bay']), 'a company that already has a list gains only a label its departments use and the list lacks');
    const fresh = await one(
      `SELECT co.id FROM companies co WHERE co.id <> ? AND co.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM hrms_departments d WHERE d.company_id = co.id AND d.name NOT LIKE ?) ORDER BY co.id LIMIT 1`, [COMPANY, `${TAG}%`]);
    if (!fresh) skip('the migration applied', 'no other company without departments');
    else {
      await db.query('DELETE FROM hrms_department_labels WHERE company_id = ?', [fresh.id]);
      await db.query('DELETE FROM hrms_departments WHERE company_id = ? AND name LIKE ?', [fresh.id, `${TAG}%`]);
      const rows = [['Process', 0], ['Shared crew', 0], ['shared crew', 1], ['Machine / area', 0], [null, 0], ['', 0], ['Section', 0], ['Bay', 0]];
      const ids = [];
      for (const [i, [type, shared]] of rows.entries()) ids.push(await ins('INSERT INTO hrms_departments (company_id, code, name, department_type, is_shared) VALUES (?, ?, ?, ?, ?)', [fresh.id, `${TAG}M${i}`, `${TAG} M${i}`, type, shared]));
      const read1 = await MIG.readCompany(db, fresh.id);
      const plan1 = MIG.planLabels(read1.departments, read1.labels);
      await MIG.applyLabels(db, fresh.id, plan1, read1.labels);
      const got = [];
      for (const id of ids) { const r = await one('SELECT department_type, is_shared FROM hrms_departments WHERE id = ?', [id]); got.push(`${r.department_type}:${r.is_shared}`); }
      ok(JSON.stringify(got) === JSON.stringify(['Section:0', 'Section:1', 'Section:1', 'Machine:0', 'Department:0', 'Department:0', 'Section:0', 'Bay:0']),
        'applied: Process -> Section; Shared crew -> Section and SHARED; Machine / area -> Machine; no label -> Department', got.join(' '));
      const listed = await LABELS.listLabels(db, fresh.id);
      ok(JSON.stringify(listed.labels.map((l) => l.name)) === JSON.stringify(['Department', 'Section', 'Machine', 'Bay']) && JSON.stringify(listed.labels.map((l) => l.departmentCount)) === JSON.stringify([2, 4, 1, 1]),
        'its list: the three defaults, then its own label, each with its count', JSON.stringify(listed.labels));
      const read2 = await MIG.readCompany(db, fresh.id);
      const plan2 = MIG.planLabels(read2.departments, read2.labels);
      ok(plan2.nothing === true && plan2.renameCount === 0 && plan2.add.length === 0 && JSON.stringify(plan2.after) === JSON.stringify(plan1.after), 'run again: nothing to rename, nothing to add');
    }
    const here = await MIG.readCompany(db, COMPANY);
    const planHere = MIG.planLabels(here.departments, here.labels);
    ok(!['Process', 'Shared crew', 'Machine / area', '(no label)'].some((k) => k in planHere.after), `${company.name}: migrated — no old label is left`, JSON.stringify(planHere.after));
  }

  /* ══ 11-14. leave policy and default shift BY LABEL (from label_defaults_test, 2026-10-16) ══ */
  const must = async (who, method, url, body) => {
    const r = await call(who, method, url, body);
    if (r.status !== 200) throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  section('[11] The schema of §17 (apply-label-defaults.mjs): nothing left to do');
  {
    const steps = await schemaSteps(db);
    ok(steps.length === 0, 'apply-label-defaults plans nothing on this database (idempotent)', steps.map((s) => s.what).join('; '));
    const scope = await one("SELECT DATA_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_policy_assignments' AND COLUMN_NAME = 'scope'");
    const key = await one("SELECT GENERATION_EXPRESSION AS e FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_policy_assignments' AND COLUMN_NAME = 'target_key'");
    ok(String(scope?.t).toLowerCase() === 'varchar' && /label_id/.test(key?.e ?? ''), 'scope is a VARCHAR (LABEL needs no change to it); target_key has label_id in it');
  }
  // fixtures: two labels of this run, four departments, a location, two roles, five positions
  const PLANT_NAME = `${TAG} Plant`;
  const U2_NAME = `${TAG} Unit 2`;
  const PLANT = await must(O, 'POST', '/organisation/department-labels', { name: PLANT_NAME });
  const U2 = await must(O, 'POST', '/organisation/department-labels', { name: U2_NAME });
  const MACHINE = (await must(O, 'GET', '/organisation/department-labels')).labels.find((l) => l.name === 'Machine');
  const dept = async (name, labelId, extra = {}) => must(O, 'POST', '/organisation/departments', { name: `${TAG} ${name}`, ...(labelId ? { labelId } : {}), ...extra });
  const D1 = await dept('Plant dept', PLANT.id);
  const D2 = await dept('Unit dept', U2.id);
  const D3 = await dept('Under plant', null, { parentId: D1.id });   // a child of D1, the first label (not Plant)
  const D4 = await dept('Plain', null);                              // the first label, which has no policy or shift
  const location = await ORG.createLocation(db, c, { code: `${TAG}L`, name: `${TAG} Unit`, locationType: 'UNIT' });
  const roleA = await ins("INSERT INTO hrms_roles (company_id, role_code, title, status, created_by) VALUES (?, ?, ?, 'ACTIVE', ?)", [COMPANY, `${TAG}RA`, `${TAG} Role A`, c.userId]);
  const roleB = await ins("INSERT INTO hrms_roles (company_id, role_code, title, status, created_by) VALUES (?, ?, ?, 'ACTIVE', ?)", [COMPANY, `${TAG}RB`, `${TAG} Role B`, c.userId]);
  const allShifts = await q('SELECT id, code, name FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY id', [COMPANY]);
  const byCode = (code) => allShifts.find((s) => s.code === code);
  const G = byCode('G') ?? allShifts[0];
  const DAY = byCode('D') ?? allShifts[1];
  const NIGHT = byCode('N') ?? allShifts[2];
  if (!G || !DAY || !NIGHT) throw new Error('This test needs three shifts (G, D, N).');
  const mkPos = async (roleId, departmentId, extra = {}) => (await POS.createPosition(db, c, { roleId, departmentId, locationId: location.id, defaultShiftId: G.id, status: 'ACTIVE', ...extra })).position;
  const pA = await mkPos(roleA, D1.id);
  const pB = await mkPos(roleB, D1.id);
  const pC = await mkPos(roleB, D2.id);
  const pChild = await mkPos(roleB, D3.id);
  const pPlain = await mkPos(roleB, D4.id);
  const eff = async (p) => (await LEAVE.policyFor(db, COMPANY, { positionId: p.id })).effective;
  const mkPolicy = async (name) => (await LEAVE.createPolicy(db, c, { name: `${TAG} ${name}`, fromTemplate: 'TRAINEE', status: 'ACTIVE' })).policy;
  const P = { company: await mkPolicy('Company'), location: await mkPolicy('Location'), plant: await mkPolicy('Plant'), unit: await mkPolicy('Unit'), role: await mkPolicy('Role') };
  const ref = (p) => ({ id: p.id, name: p.name, status: p.status });
  const put = (body) => call(O, 'PUT', '/leave/assignments', body);
  // The tenant's own company default is replaced inside this transaction only.
  section('[12] Leave by label: role beats label beats location beats company');
  {
    ok((await put({ scope: 'COMPANY', policyId: P.company.id })).status === 200 && (await eff(pPlain)).from === 'COMPANY', 'the company default: a position with nothing more specific gets it');
    ok((await put({ scope: 'LOCATION', locationId: location.id, policyId: P.location.id })).status === 200, 'the location gets its own');
    const viaLocation = await eff(pC);
    ok(viaLocation.from === 'LOCATION' && viaLocation.policy.id === P.location.id && !('label' in viaLocation) && !('conflict' in viaLocation),
      'a location’s policy beats the company’s; an answer not from a label carries no label key', JSON.stringify(viaLocation));
    const put1 = await put({ scope: 'LABEL', labelId: U2.id, policyId: P.unit.id });
    const row = put1.json?.assignments?.labels?.find((l) => l.labelId === U2.id);
    ok(put1.status === 200 && row && row.policy?.id === P.unit.id && row.name === U2_NAME && !('groupId' in row) && !('conflicts' in row),
      'PUT /leave/assignments { scope: LABEL, labelId } -> the label row carries its policy (no group, no conflicts)', JSON.stringify(row));
    const viaLabel = await eff(pC);
    ok(viaLabel.from === 'LABEL' && viaLabel.policy.id === P.unit.id && viaLabel.label?.id === U2.id && viaLabel.label.name === U2_NAME && !('groupName' in viaLabel.label) && !('conflict' in viaLabel)
      && viaLabel.line === `${P.unit.name} — from the label ${U2_NAME}`, 'a label’s policy beats the location’s: "<policy> — from the label <name>"', JSON.stringify(viaLabel));
    ok((await put({ scope: 'LABEL', labelId: PLANT.id, policyId: P.plant.id })).status === 200 && (await eff(pA)).from === 'LABEL' && (await eff(pA)).policy.id === P.plant.id,
      'another label gets its own policy: its department’s positions take it');
    ok((await eff(pChild)).from === 'LOCATION', 'a department under one that carries the label does not get it (its own label only)');
    ok((await put({ scope: 'ROLE', roleId: roleA, policyId: P.role.id })).status === 200 && (await eff(pA)).from === 'ROLE' && (await eff(pA)).line === `${P.role.name} — from the role`
      && (await eff(pB)).from === 'LABEL', 'a role’s policy beats the label’s; the other role in the same department still gets the label’s');
    ok((await put({ scope: 'ROLE', roleId: roleA, policyId: null })).status === 200 && (await eff(pA)).from === 'LABEL', 'remove the role’s: back to the label’s');
    ok((await put({ scope: 'LABEL', labelId: U2.id, policyId: null })).status === 200 && (await put({ scope: 'LABEL', labelId: PLANT.id, policyId: null })).status === 200
      && (await eff(pC)).from === 'LOCATION' && (await eff(pA)).from === 'LOCATION', 'remove the labels’: back to the location’s');
    ok((await LEAVE.getAssignments(db, COMPANY)).labels.find((l) => l.labelId === U2.id)?.policy === null, 'the label row reads "no policy of its own" again');
    const index = { company: null, byLocation: new Map([[5, ref(P.location)]]), locationName: new Map([[5, 'Unit 2']]), byRole: new Map([[9, ref(P.role)]]),
      byLabel: new Map([[70, { policy: ref(P.plant), label: { id: 70, name: 'Plant' } }]]), labelOfDepartment: new Map([[3, 70]]) };
    ok(resolveEffective(index, { roleId: 9, locationId: 5, departmentId: 3 }).from === 'ROLE' && resolveEffective(index, { roleId: 8, locationId: 5, departmentId: 3 }).from === 'LABEL'
      && resolveEffective(index, { roleId: 8, locationId: 5, departmentId: 4 }).from === 'LOCATION' && resolveEffective({ ...index, byLocation: new Map() }, { departmentId: 4 }).line === 'No leave policy',
    'resolveEffective on its own: ROLE, LABEL, LOCATION, none');
  }

  section('[13] Leave by label: what a label reaches, and every read');
  {
    await put({ scope: 'LABEL', labelId: PLANT.id, policyId: P.plant.id });
    await put({ scope: 'LABEL', labelId: U2.id, policyId: P.unit.id });
    const a = await LEAVE.getAssignments(db, COMPANY);
    ok(JSON.stringify(Object.keys(a)) === JSON.stringify(['company', 'locations', 'labels', 'roles', 'unassignedPositions'])
      && a.labels.every((l) => JSON.stringify(Object.keys(l)) === JSON.stringify(['labelId', 'name', 'policy', 'positionCount'])),
    'GET /leave/assignments: { company, locations, labels: [{ labelId, name, policy, positionCount }], roles, unassignedPositions }', JSON.stringify(a.labels[0]));
    ok(JSON.stringify(a.labels.map((l) => l.labelId)) === JSON.stringify((await must(O, 'GET', '/organisation/department-labels')).labels.map((l) => l.id)), 'labels in the list’s order, every one of them');
    const all = await q("SELECT id, role_id, location_id, department_id FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL AND status <> 'CLOSED'", [COMPANY]);
    const index = await loadAssignmentIndex(db, COMPANY);
    const fromPlant = all.filter((p) => resolveEffective(index, { roleId: p.role_id, locationId: p.location_id, departmentId: p.department_id }).label?.id === PLANT.id).map((p) => p.id);
    ok(same(fromPlant, [pA.id, pB.id]) && a.labels.find((l) => l.labelId === PLANT.id).positionCount === 2,
      'a label reaches exactly the positions of the department carrying it — not its child department, not another', JSON.stringify(fromPlant));
    await put({ scope: 'LABEL', labelId: MACHINE.id, policyId: P.plant.id });
    const machine = await one(
      `SELECT COUNT(*) AS n FROM hrms_positions p JOIN hrms_departments d ON d.company_id = p.company_id AND d.id = p.department_id
        WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status <> 'CLOSED' AND LOWER(d.department_type) = 'machine' AND d.deleted_at IS NULL`, [COMPANY]);
    const reach = (await LEAVE.getAssignments(db, COMPANY)).labels.find((l) => l.labelId === MACHINE.id).positionCount;
    ok(Number(machine.n) > 0 && reach === Number(machine.n), `a built-in label (Machine) reaches every position of the departments it labels: ${machine.n}`, String(reach));
    await put({ scope: 'LABEL', labelId: MACHINE.id, policyId: null });
    const byPos = await eff(pB);
    const card = (await getPositionCard(db, COMPANY, pB.id, {})).leavePolicy;
    const detail = (await must(O, 'GET', `/positions/${pB.id}`)).position.leavePolicy;
    const viaQuery = (await must(O, 'GET', `/leave/policy-for?roleId=${roleB}&locationId=${location.id}&departmentId=${D1.id}`)).effective;
    const mine = await LEAVE.leaveOfPosition(db, COMPANY, { roleId: roleB, locationId: location.id, departmentId: D1.id });
    ok([card, detail, viaQuery].every((x) => JSON.stringify(x) === JSON.stringify(byPos)) && mine.line === byPos.line && mine.rules.length > 0,
      'GET /positions/:id, the chart’s position card, policy-for by role+location+department and My place’s leave all say the same', JSON.stringify([card?.line, detail?.line, viaQuery?.line, mine.line]));
    ok((await getRole(db, COMPANY, roleB)).leavePolicy.own === null, 'the role page shows only the role’s own policy (none)');
    const listed = (await LEAVE.listPolicies(db, COMPANY)).policies;
    ok(listed.find((p) => p.id === P.plant.id).usedBy.labels === 1 && listed.find((p) => p.id === P.unit.id).usedBy.labels === 1 && listed.find((p) => p.id === P.plant.id).usedBy.positions === 2,
      'usedBy counts labels, and the positions each policy ends up with', JSON.stringify(listed.find((p) => p.id === P.plant.id).usedBy));
    ok((await call(O, 'GET', '/leave/policies?used=1')).json.policies.some((p) => p.id === P.unit.id), 'the "applied somewhere" filter counts a label');
    const del = await call(O, 'DELETE', `/leave/policies/${P.unit.id}`);
    ok(del.status === 409 && del.json.code === 'IN_USE' && JSON.stringify(del.json.problems ?? del.json).includes(`The label ${U2_NAME} uses it.`), 'a policy a label uses cannot be deleted: 409 IN_USE naming the label', JSON.stringify(del.json));
    const draft = (await LEAVE.createPolicy(db, c, { name: `${TAG} Draft`, fromTemplate: 'BLANK' })).policy;
    const r1 = await put({ scope: 'LABEL', labelId: PLANT.id, policyId: draft.id });
    const r2 = await put({ scope: 'LABEL', labelId: 99999999, policyId: P.plant.id });
    const r3 = await put({ scope: 'LABEL', policyId: P.plant.id });
    ok(r1.status === 422 && r2.status === 404 && r3.status === 422, 'a draft policy: 422; a label that is not this company’s: 404; no label: 422', `${r1.status} ${r2.status} ${r3.status}`);
    ok(Number((await one("SELECT COUNT(*) AS n FROM hrms_leave_policy_assignments WHERE company_id = ? AND scope = 'LABEL' AND label_id = ? AND deleted_at IS NULL", [COMPANY, U2.id])).n) === 1,
      'one live assignment per label (target_key LABEL:<id>)');
  }

  section('[14] "New positions start on", in every creation path');
  {
    const existing = await q('SELECT id, default_shift_id FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL ORDER BY id', [COMPANY]);
    ok((await call(O, 'PUT', `/organisation/department-labels/${PLANT.id}`, { defaultShiftId: NIGHT.id })).json.defaultShiftId === NIGHT.id
      && (await call(O, 'PUT', `/organisation/department-labels/${U2.id}`, { defaultShiftId: DAY.id })).json.defaultShiftId === DAY.id, 'two labels take a default shift each');
    const yard = await call(O, 'POST', '/organisation/department-labels', { name: `${TAG} Yard`, defaultShiftId: DAY.id });
    ok(yard.status === 200 && yard.json.defaultShiftId === DAY.id, 'a new label may start with a default shift');
    const suggest = async (qs) => (await must(O, 'GET', `/positions/new-shift?${qs}`)).suggestion;
    const s1 = await suggest(`departmentId=${D1.id}`);
    const s3 = await suggest(`departmentId=${D3.id}`);
    ok(s1.shift.id === NIGHT.id && s1.label.name === PLANT_NAME && s1.line === `Starts on ${NIGHT.name}${/shift$/i.test(NIGHT.name) ? '' : ' shift'} (from the label ${PLANT_NAME})`
      && s3.from === 'GENERAL' && s3.shift.id === G.id, 'the suggestion says the shift and why, in words; a child department is not given its parent’s', `${s1.line} / ${s3.line}`);
    ok((await call(O, 'GET', '/positions/new-shift?departmentId=99999999')).status === 404, 'a department that is not this company’s: 404');
    ok(chooseNewShift({ label: { id: 1, name: 'X', defaultShiftId: 424242 }, shifts: allShifts }).from === 'GENERAL', 'a default pointing at a shift that is gone is passed over');
    const explicit = (await must(O, 'POST', '/positions', { roleId: roleB, departmentId: D2.id, defaultShiftId: G.id, status: 'ACTIVE' })).position;
    const plain = (await must(O, 'POST', '/positions', { roleId: roleB, departmentId: D4.id, status: 'ACTIVE' })).position;
    ok(explicit.defaultShiftId === G.id && plain.defaultShiftId === G.id, 'POST /positions: a shift named wins over the label’s; no label default -> General');
    // add-sibling
    const nightPlain = await mkPos(roleB, D4.id, { defaultShiftId: NIGHT.id });
    const sib1 = (await must(O, 'POST', `/positions/${pC.id}/add-sibling`, {})).position;
    const sib2 = (await must(O, 'POST', `/positions/${nightPlain.id}/add-sibling`, {})).position;
    const sib3 = (await must(O, 'POST', `/positions/${pC.id}/add-sibling`, { shiftId: G.id })).position;
    ok(sib1.defaultShiftId === DAY.id && sib2.defaultShiftId === NIGHT.id && sib3.defaultShiftId === G.id,
      'add-sibling: none named -> the label’s (Day) over the source’s; no label default -> the source’s (Night); named -> that one', JSON.stringify([sib1.defaultShiftId, sib2.defaultShiftId, sib3.defaultShiftId]));
    ok((await suggest(`likePositionId=${nightPlain.id}`)).from === 'LIKE' && (await suggest(`likePositionId=${pC.id}`)).from === 'LABEL', 'the suggestion for "Add a position like this" says the same');
    // the Excel positions upload
    const blankBook = await open((await must(O, 'GET', '/excel/positions/workbook?blank=1')).contentBase64);
    const roleText = `${TAG}RB — ${TAG} Role B`;
    blankBook.set(2, 'Role', roleText); blankBook.set(2, 'Department', `${D1.code} — ${D1.name}`); blankBook.set(2, 'Status', 'ACTIVE');
    blankBook.set(3, 'Role', roleText); blankBook.set(3, 'Department', `${D1.code} — ${D1.name}`); blankBook.set(3, 'Shift', `${G.code} — ${G.name}`); blankBook.set(3, 'Status', 'ACTIVE');
    const file = await blankBook.save();
    const pre = await must(O, 'POST', '/excel/positions/preview', { fileName: 'p.xlsx', contentBase64: file });
    const shiftChange = (r) => r?.changes.find((x) => x.column === 'Shift')?.to ?? '';
    ok(pre.summary.add === 2 && pre.summary.problems === 0 && shiftChange(pre.rows[0]) === `${NIGHT.code} — ${NIGHT.name} (from the label ${PLANT_NAME})` && shiftChange(pre.rows[1]) === `${G.code} — ${G.name}`,
      'Excel preview: a new row with no shift says what it will start on and why; a named shift stays', JSON.stringify(pre.rows.map((r) => [r.action, shiftChange(r), r.problems])));
    const applied = await must(O, 'POST', '/excel/positions/apply', { fileName: 'p.xlsx', contentBase64: file, expect: { add: 2, change: 0 } });
    const rows = await q('SELECT position_code, default_shift_id FROM hrms_positions WHERE company_id = ? AND position_code IN (?) ORDER BY id', [COMPANY, applied.issuedCodes.map((x) => x.code)]);
    ok(applied.added === 2 && rows.length === 2 && rows[0].default_shift_id === NIGHT.id && rows[1].default_shift_id === G.id, 'Excel apply: Night from the label; General as named', JSON.stringify(rows));
    const fb = await open((await must(O, 'GET', `/excel/positions/workbook?department=${D2.id}`)).contentBase64);
    for (let r = 2; r <= fb.ws.rowCount; r += 1) if (fb.ws.getCell(r, 1).value) fb.set(r, 'Shift', null);
    const pre2 = await must(O, 'POST', '/excel/positions/preview', { fileName: 'p.xlsx', contentBase64: await fb.save() });
    ok(pre2.summary.problems > 0 && pre2.rows.every((r) => r.action !== 'CHANGE' || r.problems.length) && pre2.rows.some((r) => r.problems.some((p) => /a position is on one shift/i.test(p))),
      'Excel: blanking an existing position’s shift is a problem, not a change', JSON.stringify(pre2.summary));
    // the command bar, including a department made earlier in the same plan
    const OWNER = { companyId: COMPANY, userId: owner.id, can: () => true, scope: { all: true } };
    const field = (kind, id, text) => ({ value: id, ref: { kind, id, label: text }, fromText: text, confidence: 1 });
    const stepPos = (id, departmentField, shift = null) => ({
      id, action: 'add_position', confidence: 1, sourceText: 'test',
      fields: { role: field('role', roleB, `${TAG} Role B`), department: departmentField, ...(shift ? { shift: field('shift', shift.id, shift.name) } : {}) },
    });
    const checked = await checkPlan(pool, OWNER, [stepPos('s1', field('department', D2.id, D2.name)), stepPos('s2', field('department', D2.id, D2.name), G)]);
    const [cp1, cp2] = checked.preview.positions;
    ok(checked.clean && cp1.shiftName === DAY.name && cp1.shiftFrom === 'LABEL' && cp1.shiftLine.includes(`from the label ${U2_NAME}`) && cp2.shiftFrom === 'NAMED' && cp2.shiftName === G.name,
      'command bar check: the preview says the shift it will use and why — the label’s, or the one asked for', JSON.stringify([cp1.shiftLine, cp2.shiftLine, checked.steps.map((s) => s.problems)]));
    const withDept = [
      { id: 'd1', action: 'add_department', confidence: 1, sourceText: 'test', fields: { name: { value: `${TAG} New bay`, fromText: 'x', confidence: 1 }, label: { value: U2_NAME, fromText: U2_NAME, confidence: 1 } } },
      stepPos('p1', { value: null, ref: { kind: 'step', id: 'd1', label: 'new' }, fromText: 'in it', confidence: 1 }),
    ];
    const checked2 = await checkPlan(pool, OWNER, withDept);
    ok(checked2.clean && checked2.preview.positions[0].shiftFrom === 'LABEL' && checked2.preview.positions[0].shiftName === DAY.name,
      'a department made earlier in the same plan brings its label: its new position starts on Day', JSON.stringify([checked2.preview.positions[0], checked2.steps.map((s) => s.problems)]));
    const done = await applyPlan(pool, OWNER, [stepPos('s1', field('department', D2.id, D2.name)), ...withDept]);
    const madeRows = await q('SELECT id, default_shift_id FROM hrms_positions WHERE company_id = ? AND id IN (?)', [COMPANY, done.created.filter((x) => x.kind === 'position').map((x) => x.id)]);
    ok(madeRows.length === 2 && madeRows.every((r) => r.default_shift_id === DAY.id), 'command bar apply: both new positions are on Day', JSON.stringify(madeRows));
    const now = await q('SELECT id, default_shift_id FROM hrms_positions WHERE company_id = ? AND id IN (?)', [COMPANY, existing.map((p) => p.id)]);
    const moved = existing.filter((p) => now.find((x) => x.id === p.id)?.default_shift_id !== p.default_shift_id);
    ok(moved.length === 0, `existing positions untouched: all ${existing.length} keep their shift`, JSON.stringify(moved.slice(0, 5)));
  }

  section('[15] Rights and tenants: leave assignments by label, a label’s shift, the suggestion');
  {
    if (!U.EMPLOYEE) skip('Employee rights', 'no Employee access role');
    else {
      const r = [await call(U.EMPLOYEE, 'GET', '/leave/assignments'), await call(U.EMPLOYEE, 'PUT', '/leave/assignments', { scope: 'LABEL', labelId: PLANT.id, policyId: P.unit.id }),
        await call(U.EMPLOYEE, 'GET', `/positions/new-shift?departmentId=${D1.id}`)];
      ok(r.every((x) => x.status === 403), 'an Employee login: 403 on the assignments and the suggestion', r.map((x) => x.status).join(' '));
    }
    if (!U.HR_EXECUTIVE) skip('HR executive rights', 'no HR executive access role');
    else {
      const h1 = await call(U.HR_EXECUTIVE, 'GET', '/leave/assignments');
      const h2 = await call(U.HR_EXECUTIVE, 'PUT', '/leave/assignments', { scope: 'LABEL', labelId: PLANT.id, policyId: P.unit.id });
      const h4 = await call(U.HR_EXECUTIVE, 'GET', `/positions/new-shift?departmentId=${D1.id}`);
      ok(h1.status === 200 && Array.isArray(h1.json.labels) && h2.status === 403 && h4.status === 200, 'an HR executive (leave view, no leave edit): reads the label assignments and the suggestion, changes neither', [h1, h2, h4].map((x) => x.status).join(' '));
    }
    if (!THEM) skip('tenant isolation', 'no second company with an admin login');
    else {
      const t1 = await call(THEM, 'PUT', '/leave/assignments', { scope: 'LABEL', labelId: PLANT.id, policyId: null }, { as: other.slug });
      const t2 = await call(THEM, 'GET', `/positions/new-shift?departmentId=${D1.id}`, undefined, { as: other.slug });
      const theirs = (await call(THEM, 'GET', '/leave/assignments', undefined, { as: other.slug })).json;
      const theirList = (await call(THEM, 'GET', '/organisation/department-labels', undefined, { as: other.slug })).json;
      const theirLabel = theirList?.labels?.[0];
      const t4 = theirLabel ? await call(THEM, 'PUT', `/organisation/department-labels/${theirLabel.id}`, { defaultShiftId: DAY.id }, { as: other.slug }) : { status: 422 };
      ok(t1.status === 404 && t2.status === 404 && t4.status === 422 && !(theirs?.labels ?? []).some((l) => l.labelId === PLANT.id) && !(theirList?.shifts ?? []).some((s) => s.id === DAY.id),
        'another company: cannot assign or clear our label’s policy (404), ask for our department (404), give its label our shift (422), nor see ours', `${t1.status} ${t2.status} ${t4.status}`);
      ok((await eff(pB)).policy.id === P.plant.id, 'and our answer is unchanged');
    }
  }

  karniAfter = { before: karniBefore };
} finally {
  if (server?.close) await server.close();
  try { await db.rollback(); } catch { /* nothing to undo */ }
  db.release();
  pool.query = real.query;
  pool.execute = real.execute;
  pool.getConnection = real.getConnection;
  forgetAccess();
}

section('[end] Nothing is left behind');
{
  const after = await worldCount();
  const moved = Object.keys(before).filter((k) => after[k] !== before[k]);
  ok(moved.length === 0, `every count is what it was (${TABLES.length} tables and the code counters)`, moved.map((k) => `${k} ${before[k]} -> ${after[k]}`).join('; '));
  if (karniAfter) {
    const conn = await mysql.createConnection(dbCfg);
    try {
      const [[{ id }]] = await conn.query('SELECT id FROM companies WHERE slug = ?', [slug]);
      const [[p]] = await conn.query("SELECT COUNT(*) AS n FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL AND status <> 'CLOSED'", [id]);
      const [[e]] = await conn.query('SELECT COUNT(*) AS n FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL', [id]);
      const [kinds] = await conn.query("SELECT department_type AS t, COUNT(*) AS n FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL AND name NOT LIKE 'ZZ%' GROUP BY department_type ORDER BY department_type", [id]);
      const now = `${p.n} positions · ${e.n} employees · ${kinds.map((k) => `${k.t} ${k.n}`).join(' · ')}`;
      ok(now === karniAfter.before, `${slug} is as it was: ${now}`, `${karniAfter.before} -> ${now}`);
    } finally { await conn.end(); }
  }
}

console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped`);
if (skipped.length) for (const s of skipped) console.log(`  skipped — ${s}`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
