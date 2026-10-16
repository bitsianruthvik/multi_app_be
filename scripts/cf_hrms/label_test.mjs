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
 *   8. rights (Employee 403, HR executive reads only) and tenant isolation.
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
const same = (a, b) => JSON.stringify([...a].map(String).sort()) === JSON.stringify([...b].map(String).sort());

const TABLES = ['hrms_label_groups', 'hrms_department_labels', 'hrms_department_label_links', 'hrms_departments', 'hrms_positions', 'hrms_employees', 'hrms_work_assignments',
  'hrms_hirings', 'hrms_audit_log', 'cf_code_schemes', 'cf_code_sequences', 'users', 'app_user_access'];
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
