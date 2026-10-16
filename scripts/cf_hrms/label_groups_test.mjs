/**
 * label_groups_test.mjs — labels in groups (TM/CF_HRMS_HIRING_SPEC.md §15, 2026-10-15).
 *
 *   1. the migration (apps/cf_hrms/scripts/labelGroupsMigration.mjs — the code
 *      apply-label-groups.mjs runs): on a company put back to before §15, Kind
 *      is made, the labels move into it, every department is linked to its Kind
 *      label from department_type; a second run plans nothing; Karni reads the
 *      same through Kind (Department 14 · Section 11 · Machine 19);
 *   2. groups: list, add, rename, required, order, remove (IN_USE, force,
 *      LOCKED Kind); labels per group (a name once per group, moveTo within the
 *      group, `none` for an optional group);
 *   3. a department's labels: one per group (also in the database), the
 *      required-group rule on create and update, the Kind mirror into
 *      department_type both ways;
 *   4. the `label` filter on departments, positions, employees, hiring — labels
 *      of one group are "or", groups are "and"; a department's own labels only;
 *   5. Excel: a column per group on departments (round trip SAME, a change is a
 *      CHANGE, a label of the wrong group is a problem), info columns and the
 *      `label` filter on positions and employees;
 *   6. code formats: the condition label.<groupId>; the old Kind condition;
 *   7. the command bar: "add a Machine department Printing 3 under Production in
 *      Unit 2" when a group Unit with the label Unit 2 exists;
 *   8. rights (Employee 403, HR executive reads only) and tenant isolation.
 *
 *   node scripts/cf_hrms/label_groups_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND: as excel_test, the whole run is ONE connection inside
 * ONE transaction (pool.query / getConnection point at it; a route's own
 * transaction is a savepoint), rolled back at the end. Every group made here is
 * made inside it. Local only.
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
import * as ORG from '../../apps/cf_hrms/services/organisationService.js';
import * as HIRE from '../../apps/cf_hrms/services/hiringService.js';
import { createScheme } from '../../apps/cf_erp/modules/codegen/service.js';
import { readCompany, planCompany, applyCompany } from '../../apps/cf_hrms/scripts/labelGroupsMigration.mjs';

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
const same = (a, b) => JSON.stringify([...a].map(String).sort()) === JSON.stringify([...b].map(String).sort());
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

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
  beginTransaction: async () => { depth += 1; await db.query(`SAVEPOINT zz_lg_${depth}`); },
  commit: async () => { if (depth > 0) { await db.query(`RELEASE SAVEPOINT zz_lg_${depth}`); depth -= 1; } },
  rollback: async () => { if (depth > 0) { await db.query(`ROLLBACK TO SAVEPOINT zz_lg_${depth}`); depth -= 1; } },
  release: () => {},
};
pool.query = inside.query;
pool.execute = inside.execute;
pool.getConnection = async () => inside;

const TAG = `ZZLG${Date.now().toString(36).toUpperCase().slice(-5)}`;
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
    dataRows() { let n = 0; for (let r = 2; r <= ws.rowCount; r += 1) if (text(ws.getCell(r, 1)) !== '') n += 1; return n; },
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
  console.log(`label_groups_test — ${company.name} (${COMPANY}), run tag ${TAG}; the other company is ${other ? `${other.name} (${other.id})` : 'none'}`);

  // What Karni looks like before anything here: it must look the same at the end.
  const karni = async () => {
    const [[p]] = await db.query("SELECT COUNT(*) AS n FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL AND status <> 'CLOSED'", [COMPANY]);
    const [[e]] = await db.query('SELECT COUNT(*) AS n FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
    const kinds = await q("SELECT department_type AS t, COUNT(*) AS n FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL AND name NOT LIKE 'ZZ%' GROUP BY department_type ORDER BY department_type", [COMPANY]);
    return `${p.n} positions · ${e.n} employees · ${kinds.map((k) => `${k.t} ${k.n}`).join(' · ')}`;
  };
  const karniBefore = await karni();

  /* ══ logins and the in-process server ══════════════════════════════════ */
  const roleByKey = Object.fromEntries((await q('SELECT role_id, template_key FROM hrms_access_roles WHERE company_id = ? AND deleted_at IS NULL AND template_key IS NOT NULL', [COMPANY])).map((r) => [r.template_key, r.role_id]));
  const login = async (label, roleId, companyId = COMPANY, slugOf = company.slug, appId = app.id) => {
    const email = `${TAG.toLowerCase()}.${label.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.test`;
    const id = await ins('INSERT INTO users (name, email, password, role_id, team_id, company_id) VALUES (?, ?, ?, ?, NULL, ?)', [`${TAG} ${label}`, email, 'x', roleId, companyId]);
    await db.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [id, appId, roleId, companyId]);
    const roleName = (await one('SELECT name FROM roles WHERE id = ?', [roleId])).name;
    return { id, token: signToken({ id, name: `${TAG} ${label}`, email, role: roleName, company: slugOf, companyId, company_id: companyId, uiPermissions: [] }) };
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

  /* ══ 1. the migration ═══════════════════════════════════════════════════ */
  section('[1] The migration: Kind made, labels moved, departments linked');
  {
    // Karni: migrated already — nothing to do, and the Kind list reads Department 14 · Section 11 · Machine 19.
    const here = planCompany(await readCompany(db, COMPANY));
    ok(here.nothing === true && here.link.length === 0 && here.relink.length === 0, `${company.name}: migrated — a run plans nothing (idempotent)`, JSON.stringify({ link: here.link.length, relink: here.relink.length, add: here.addLabels }));
    const groups = await get('/organisation/label-groups');
    const kind = groups.groups[0];
    ok(kind && kind.isKind && kind.locked && kind.isRequired && kind.name === 'Kind', 'GET /organisation/label-groups: Kind first, required, locked', JSON.stringify(kind && { ...kind, labels: undefined }));
    const kindCounts = Object.fromEntries((kind?.labels ?? []).map((l) => [l.name, l.departmentCount]));
    ok(kindCounts.Department === 14 && kindCounts.Section === 11 && kindCounts.Machine === 19, `${company.name} reads Department 14 · Section 11 · Machine 19 through the Kind group`, JSON.stringify(kindCounts));
    const [[links]] = await db.query(
      `SELECT COUNT(*) AS n, SUM(LOWER(l.name) = LOWER(d.department_type)) AS agree FROM hrms_departments d
         JOIN hrms_department_label_links k ON k.company_id = d.company_id AND k.department_id = d.id AND k.deleted_at IS NULL AND k.group_id = ?
         JOIN hrms_department_labels l ON l.company_id = k.company_id AND l.id = k.label_id
        WHERE d.company_id = ? AND d.deleted_at IS NULL`, [kind.id, COMPANY]);
    const [[live]] = await db.query('SELECT COUNT(*) AS n FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
    ok(Number(links.n) === Number(live.n) && Number(links.agree) === Number(live.n), 'every live department has ONE Kind link, and it agrees with department_type', `${links.n} links, ${links.agree} agree, ${live.n} departments`);

    // A company put back to before §15, inside this transaction.
    if (!other) skip('the migration on a fresh company', 'there is no second company');
    else {
      const O2 = other.id;
      await db.query('UPDATE hrms_department_labels SET group_id = NULL WHERE company_id = ?', [O2]);
      await db.query('DELETE FROM hrms_department_label_links WHERE company_id = ?', [O2]);
      await db.query('DELETE FROM hrms_label_groups WHERE company_id = ?', [O2]);
      const typed = await ins("INSERT INTO hrms_departments (company_id, code, name, department_type) VALUES (?, ?, ?, 'bay')", [O2, `${TAG}B`, `${TAG} Bay one`]);
      const blank = await ins('INSERT INTO hrms_departments (company_id, code, name, department_type) VALUES (?, ?, ?, NULL)', [O2, `${TAG}N`, `${TAG} No label`]);
      const state = await readCompany(db, O2);
      const plan = planCompany(state);
      const liveThere = state.departments.filter((d) => d.deleted_at == null).length;
      ok(plan.makeKind && plan.moveLabels.length === state.labels.length && plan.link.length === liveThere && same(plan.blankDepartments, [blank])
        && plan.addLabels.some((n) => n.toLowerCase() === 'bay'),
      'the plan for a company before §15: make Kind, move every label into it, add the labels its departments use, link every live department', JSON.stringify({ make: plan.makeKind, move: plan.moveLabels.length, add: plan.addLabels, link: plan.link.length }));
      await applyCompany(db, O2, plan);
      const after = await readCompany(db, O2);
      const kind2 = after.groups.find((g) => Number(g.is_kind) === 1);
      ok(kind2 && kind2.name === 'Kind' && Number(kind2.is_required) === 1 && after.labels.every((l) => l.group_id === kind2.id), 'Kind made (required) and every label moved into it, deleted ones too');
      const typeOf = new Map(after.departments.map((d) => [d.id, d.department_type]));
      const nameOf = new Map(after.labels.map((l) => [l.id, l.name]));
      ok(after.links.length === liveThere && after.links.every((k) => k.group_id === kind2.id && nameOf.get(k.label_id).toLowerCase() === String(typeOf.get(k.department_id)).toLowerCase()),
        'every live department linked to the Kind label its department_type names (without case)');
      ok(typeOf.get(typed) === 'bay' && typeOf.get(blank) === after.labels.filter((l) => l.deleted_at == null).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)[0].name,
        'department_type is left as it was; a department with none takes the first Kind label', `${typeOf.get(typed)} / ${typeOf.get(blank)}`);
      const again = planCompany(await readCompany(db, O2));
      ok(again.nothing === true, 'run again: nothing to do (idempotent)', JSON.stringify(again));
      ok(JSON.stringify(plan.after.byType) === JSON.stringify(planCompany(await readCompany(db, O2)).before.byType), 'the counts printed "after" are the counts a second run sees "before"');
    }
  }

  /* ══ 2. groups and their labels ═════════════════════════════════════════ */
  section('[2] Groups: add, rename, required, order, remove; labels per group');
  const groups0 = (await get('/organisation/label-groups')).groups;
  const KIND = groups0.find((g) => g.isKind);
  const kindLabel = (name) => KIND.labels.find((l) => l.name === name);
  const unitR = await call(O, 'POST', '/organisation/label-groups', { name: `  ${TAG}   Unit ` });
  const UNIT = unitR.json;
  ok(unitR.status === 200 && UNIT.name === `${TAG} Unit` && UNIT.isRequired === false && UNIT.isKind === false && UNIT.labels.length === 0 && UNIT.group.id === UNIT.id
    && UNIT.sortOrder > Math.max(...groups0.map((g) => g.sortOrder)) - 1, 'POST a group: trimmed, optional by default, at the end, no labels yet', JSON.stringify(unitR.json));
  const AREA = (await call(O, 'POST', '/organisation/label-groups', { name: `${TAG} Area`, isRequired: false })).json;
  ok((await call(O, 'POST', '/organisation/label-groups', { name: `${TAG} UNIT` })).status === 409 && (await call(O, 'POST', '/organisation/label-groups', { name: ' ' })).status === 422
    && (await call(O, 'POST', '/organisation/label-groups', { name: 'x'.repeat(41) })).status === 422, 'a group name twice (any case): 409; blank or over 40: 422');
  const lab = async (groupId, name) => (await call(O, 'POST', '/organisation/department-labels', { groupId, name })).json;
  const U1 = await lab(UNIT.id, 'Unit 1');
  const U2 = await lab(UNIT.id, 'Unit 2');
  const AX = await lab(AREA.id, 'Plant');
  const AU = await lab(AREA.id, 'Unit 1');
  ok(U1.groupId === UNIT.id && U2.groupId === UNIT.id && AX.groupId === AREA.id && AU.id && AU.groupId === AREA.id,
    'labels are added to a group (POST { groupId, name }); the same name may be in two groups', JSON.stringify([U1, AU].map((l) => [l.id, l.groupId, l.name])));
  const dupLabel = await call(O, 'POST', '/organisation/department-labels', { groupId: UNIT.id, name: 'unit 2' });
  const noGroup = await call(O, 'POST', '/organisation/department-labels', { name: `${TAG} kindish` });
  ok(dupLabel.status === 409 && dupLabel.json.code === 'DUPLICATE' && noGroup.status === 200 && noGroup.json.groupId === KIND.id,
    'a label name twice in one group: 409 DUPLICATE; POST without groupId is a Kind label (older callers)');
  const dbDup = await caught(() => db.query('INSERT INTO hrms_department_labels (company_id, group_id, name) VALUES (?, ?, ?)', [COMPANY, UNIT.id, 'UNIT 1']));
  ok(dbDup?.errno === 1062, 'the database refuses a name twice in a group too (uq_hdlb_group_name)');
  const listed = await get(`/organisation/department-labels?groupId=${UNIT.id}`);
  const kindOnly = await get('/organisation/department-labels');
  ok(same(listed.labels.map((l) => l.name), ['Unit 1', 'Unit 2']) && kindOnly.labels.every((l) => l.groupId === KIND.id), 'GET /organisation/department-labels?groupId= gives that group; without it, Kind');
  const renamed = await call(O, 'PUT', `/organisation/label-groups/${UNIT.id}`, { name: `${TAG} Units` });
  const kindOptional = await call(O, 'PUT', `/organisation/label-groups/${KIND.id}`, { isRequired: false });
  const kindGone = await call(O, 'DELETE', `/organisation/label-groups/${KIND.id}`);
  const kindRenamedBack = await call(O, 'PUT', `/organisation/label-groups/${KIND.id}`, { name: 'Kind' });
  ok(renamed.status === 200 && renamed.json.name === `${TAG} Units` && kindOptional.status === 409 && kindOptional.json.code === 'LOCKED' && kindGone.status === 409 && kindGone.json.code === 'LOCKED' && kindRenamedBack.status === 200,
    'a group is renamed; Kind cannot be made optional or removed (409 LOCKED)', `${kindOptional.status} ${kindGone.status}`);
  const order = (await get('/organisation/label-groups')).groups.map((g) => g.id);
  const reordered = await call(O, 'PUT', '/organisation/label-groups/order', { ids: [...order].reverse() });
  const badOrder = await call(O, 'PUT', '/organisation/label-groups/order', { ids: order.slice(1) });
  ok(reordered.status === 200 && JSON.stringify(reordered.json.groups.map((g) => g.id)) === JSON.stringify([...order].reverse()) && badOrder.status === 422, 'PUT /order: every group once; a short list 422');
  await call(O, 'PUT', '/organisation/label-groups/order', { ids: order });

  /* ══ 3. a department's labels ═══════════════════════════════════════════ */
  section('[3] A department\'s labels: one per group, required groups, the Kind mirror');
  const mk = async (name, labels, extra = {}) => call(O, 'POST', '/organisation/departments', { name: `${TAG} ${name}`, labels, ...extra });
  const A = (await mk('A', { [UNIT.id]: U1.id, [AREA.id]: AX.id }, { type: 'Section' })).json;
  const B = (await mk('B', { [UNIT.id]: U2.id, [AREA.id]: AX.id })).json;
  const C = (await mk('C', { [UNIT.id]: U2.id }, { type: 'Machine' })).json;
  const Dchild = (await mk('A child', {}, { parentId: A.id })).json;
  ok(JSON.stringify(A.labels.map((l) => [l.groupId, l.name])) === JSON.stringify([[KIND.id, 'Section'], [UNIT.id, 'Unit 1'], [AREA.id, 'Plant']]) && A.type === 'Section',
    'a department read: labels [{ groupId, groupName, labelId, name }] in group order, Kind first; `type` is still the Kind label', JSON.stringify(A.labels));
  ok(B.type === kindOnly.labels[0].name && B.labels[0].name === B.type && Dchild.labels.length === 1, 'no Kind given: the first Kind label; a child does not inherit its parent\'s labels', JSON.stringify(Dchild.labels));
  const wrongGroup = await mk('Wrong', { [UNIT.id]: AU.id });
  const strangerGroup = await mk('Stranger', { 99999999: U1.id });
  ok(wrongGroup.status === 422 && /not one of this group/.test(JSON.stringify(wrongGroup.json)) && strangerGroup.status === 422, 'a label of another group in a group: 422; a group that is not this company\'s: 422');
  const twoLinks = await caught(() => db.query('INSERT INTO hrms_department_label_links (company_id, department_id, group_id, label_id) VALUES (?, ?, ?, ?)', [COMPANY, A.id, UNIT.id, U2.id]));
  ok(twoLinks?.errno === 1062, 'the database holds ONE live label per department and group (uq_hdll_one)');
  // required
  const madeRequired = await call(O, 'PUT', `/organisation/label-groups/${UNIT.id}`, { isRequired: true });
  const without = await mk('No unit', {});
  const withNull = await call(O, 'PUT', `/organisation/departments/${A.id}`, { labels: { [UNIT.id]: null } });
  const nameOnly = await call(O, 'PUT', `/organisation/departments/${Dchild.id}`, { name: `${TAG} A child renamed` });
  const groupsNow = (await get('/organisation/label-groups')).groups;
  ok(madeRequired.status === 200 && madeRequired.json.isRequired === true && without.status === 422 && /Units: choose a label/.test(JSON.stringify(without.json))
    && withNull.status === 422 && nameOnly.status === 200 && groupsNow.find((g) => g.id === UNIT.id).departmentsWithout > 0,
  'a required group: a new department needs its label (422), a label cannot be cleared (422); an edit that does not touch labels is saved, and the group says how many departments still have none',
  `${without.status} ${withNull.status} ${nameOnly.status} ${groupsNow.find((g) => g.id === UNIT.id)?.departmentsWithout}`);
  await call(O, 'PUT', `/organisation/label-groups/${UNIT.id}`, { isRequired: false });
  const cleared = await call(O, 'PUT', `/organisation/departments/${C.id}`, { labels: { [UNIT.id]: null } });
  ok(cleared.status === 200 && !cleared.json.labels.some((l) => l.groupId === UNIT.id), 'an optional group\'s label can be cleared (null)');
  await call(O, 'PUT', `/organisation/departments/${C.id}`, { labels: { [UNIT.id]: U2.id } });
  // the mirror
  const toMachine = await call(O, 'PUT', `/organisation/departments/${B.id}`, { labels: { [KIND.id]: kindLabel('Machine').id } });
  const kindLink = async (deptId) => one('SELECT l.name FROM hrms_department_label_links k JOIN hrms_department_labels l ON l.id = k.label_id WHERE k.company_id = ? AND k.department_id = ? AND k.group_id = ? AND k.deleted_at IS NULL', [COMPANY, deptId, KIND.id]);
  const typeOf = async (deptId) => (await one('SELECT department_type FROM hrms_departments WHERE id = ?', [deptId])).department_type;
  ok(toMachine.status === 200 && await typeOf(B.id) === 'Machine' && (await kindLink(B.id)).name === 'Machine' && toMachine.json.type === 'Machine',
    'the Kind label set through labels: department_type follows in the same write (the mirror)');
  await call(O, 'PUT', `/organisation/departments/${B.id}`, { type: 'Section' });
  ok(await typeOf(B.id) === 'Section' && (await kindLink(B.id)).name === 'Section', 'the Kind label set the old way (type): the link follows');
  const kindNew = (await call(O, 'POST', '/organisation/department-labels', { name: `${TAG} Bay` })).json;
  await call(O, 'PUT', `/organisation/departments/${C.id}`, { type: `${TAG} Bay` });
  await call(O, 'PUT', `/organisation/department-labels/${kindNew.id}`, { name: `${TAG} Big bay` });
  ok(await typeOf(C.id) === `${TAG} Big bay` && (await kindLink(C.id)).name === `${TAG} Big bay` && (await get(`/organisation/departments?q=${TAG}%20C`)).rows.find((d) => d.id === C.id).labels[0].name === `${TAG} Big bay`,
    'renaming a Kind label renames department_type; the link (by id) reads the new name');
  const moved = await call(O, 'DELETE', `/organisation/department-labels/${kindNew.id}?moveTo=${kindLabel('Machine').id}`);
  ok(moved.status === 200 && await typeOf(C.id) === 'Machine' && (await kindLink(C.id)).name === 'Machine', 'removing a Kind label with moveTo: department_type and the link move together');
  // remove: IN_USE, moveTo within the group, none, force
  const inUse = await call(O, 'DELETE', `/organisation/department-labels/${U1.id}`);
  const crossMove = await call(O, 'DELETE', `/organisation/department-labels/${U1.id}?moveTo=${AU.id}`);
  ok(inUse.status === 409 && inUse.json.code === 'IN_USE' && inUse.json.detail?.departmentCount === 1 && crossMove.status === 422, 'a label in use: 409 IN_USE (detail.departmentCount); moveTo a label of ANOTHER group: 422');
  const areaNone = await call(O, 'DELETE', `/organisation/department-labels/${AX.id}?moveTo=none`);
  ok(areaNone.status === 200 && areaNone.json.departmentsMoved === 2 && !(await get(`/organisation/departments?q=${TAG}`)).rows.some((d) => d.labels.some((l) => l.groupId === AREA.id)),
    'an optional group\'s label removed with moveTo=none: taken off its departments', JSON.stringify(areaNone.json));
  const AX2 = await lab(AREA.id, 'Plant');
  await call(O, 'PUT', `/organisation/departments/${A.id}`, { labels: { [AREA.id]: AX2.id } });
  await call(O, 'PUT', `/organisation/departments/${B.id}`, { labels: { [AREA.id]: AX2.id } });
  const temp = (await call(O, 'POST', '/organisation/label-groups', { name: `${TAG} Temp` })).json;
  const tl = await lab(temp.id, 'T1');
  await call(O, 'PUT', `/organisation/departments/${C.id}`, { labels: { [temp.id]: tl.id } });
  const tempInUse = await call(O, 'DELETE', `/organisation/label-groups/${temp.id}`);
  const tempForced = await call(O, 'DELETE', `/organisation/label-groups/${temp.id}?force=1`);
  ok(tempInUse.status === 409 && tempInUse.json.code === 'IN_USE' && tempInUse.json.detail.departmentCount === 1 && tempForced.status === 200 && tempForced.json.labelsRemoved === 1
    && !(await get(`/organisation/departments?q=${TAG}`)).rows.find((d) => d.id === C.id).labels.some((l) => l.groupId === temp.id),
  'removing a group in use: 409 IN_USE; with ?force=1 its labels go and every department loses its label in it');
  ok(Number((await one('SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ? AND entity_type = ? AND entity_id IN (?)', [COMPANY, 'hrms_label_groups', [UNIT.id, temp.id]])).n) >= 4,
    'group writes are in the audit log');

  /* ══ 4. filters ══════════════════════════════════════════════════════════ */
  section('[4] The label filter on Departments, Positions, Employees, Hiring');
  const role = await ins("INSERT INTO hrms_roles (company_id, role_code, title, role_purpose, status) VALUES (?, ?, ?, 'Runs it.', 'ACTIVE')", [COMPANY, `${TAG}R`, `${TAG} Operator`]);
  const shift = await one('SELECT id FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const pos = async (code, departmentId) => ins("INSERT INTO hrms_positions (company_id, position_code, role_id, position_title, department_id, default_shift_id, status) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')", [COMPANY, `${TAG}-${code}`, role, `${TAG} ${code}`, departmentId, shift.id]);
  const P = { a: await pos('A', A.id), b: await pos('B', B.id), c: await pos('C', C.id), child: await pos('CH', Dchild.id), hire: await pos('HIRE', B.id) };
  const emp = async (code) => ins("INSERT INTO hrms_employees (company_id, employee_code, full_name, date_of_joining, employment_type, employment_status) VALUES (?, ?, ?, '2026-01-01', 'EMPLOYEE', 'ACTIVE')", [COMPANY, `${TAG}${code}`, `${TAG} Person ${code}`]);
  const seat = async (e, p, d) => ins("INSERT INTO hrms_work_assignments (company_id, employee_id, role_id, position_id, department_id, is_primary, status, effective_from) VALUES (?, ?, ?, ?, ?, 1, 'ACTIVE', '2026-01-01')", [COMPANY, e, role, p, d]);
  const E = { a: await emp('A'), b: await emp('B'), c: await emp('C') };
  await seat(E.a, P.a, A.id); await seat(E.b, P.b, B.id); await seat(E.c, P.c, C.id);
  await HIRE.startHiring(db, c, P.hire);
  const ids = (rows) => rows.map((r) => r.id);
  const D = (labelQ) => get(`/organisation/departments?q=${TAG}&label=${labelQ}`);
  ok(same(ids((await D(U1.id)).rows), [A.id]), 'departments ?label=<Unit 1>: only A');
  ok(same(ids((await D(`${U1.id},${U2.id}`)).rows), [A.id, B.id, C.id]), 'two labels of ONE group are "any of": Unit 1 or Unit 2 -> A, B, C');
  ok(same(ids((await D(`${U2.id},${AX2.id}`)).rows), [B.id]), 'labels of two groups are "and": Unit 2 and Plant -> B only');
  ok(same(ids((await D(`${U1.id},${U2.id},${AX2.id}`)).rows), [A.id, B.id]), '(Unit 1 or Unit 2) and Plant -> A, B');
  ok((await D(99999999)).count === 0 && same(ids((await D('Machine')).rows), [C.id]) && same(ids((await D(kindLabel('Section').id)).rows), [A.id, B.id]),
    'an id that is no label matches nothing; a Kind label by name (as §13.6) or by id works');
  ok(!(await D(U1.id)).rows.some((r) => r.id === Dchild.id), 'a department\'s own labels only: A\'s child is not "in Unit 1"');
  const posQ = async (labelQ) => (await get(`/positions?q=${TAG}&label=${labelQ}`)).items.map((p) => p.id);
  ok(same(await posQ(U2.id), [P.b, P.c, P.hire]) && same(await posQ(`${U2.id},${AX2.id}`), [P.b, P.hire]) && same(await posQ(`${U1.id},${U2.id}`), [P.a, P.b, P.c, P.hire]),
    'positions ?label=: by the position\'s department — one group "or", two groups "and"');
  const empQ = async (labelQ) => (await get(`/people/employees?q=${TAG}&label=${labelQ}`)).items.map((e) => e.id);
  ok(same(await empQ(U2.id), [E.b, E.c]) && same(await empQ(`${U2.id},${AX2.id}`), [E.b]) && same(await empQ(AX2.id), [E.a, E.b]),
    'employees ?label=: by their position\'s department');
  const hirQ = async (labelQ) => (await get(`/hirings?status=all&label=${labelQ}`)).hirings.filter((h) => String(h.positionCode ?? '').startsWith(TAG)).map((h) => h.positionId ?? h.position?.id);
  const hirAll = await get(`/hirings?status=all&label=${U2.id}`);
  ok(same(await hirQ(U2.id), [P.hire]) && (await hirQ(U1.id)).length === 0 && typeof hirAll.total === 'number' && hirAll.count <= hirAll.total,
    'hiring ?label=: by the position\'s department, with total and count', JSON.stringify(await hirQ(U2.id)));

  /* ══ 5. Excel ════════════════════════════════════════════════════════════ */
  section('[5] Excel: a column per group; the label filter on the downloads');
  const download = async (entity, query = '') => { const r = await call(O, 'GET', `/excel/${entity}/workbook${query}`); if (r.status !== 200) throw new Error(`download ${entity}: ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
  const preview = (entity, contentBase64) => call(O, 'POST', `/excel/${entity}/preview`, { fileName: `${entity}.xlsx`, contentBase64 });
  const applyX = (entity, contentBase64, expect) => call(O, 'POST', `/excel/${entity}/apply`, { fileName: `${entity}.xlsx`, contentBase64, expect });
  {
    // Rows written a moment ago must not look newer than the file.
    await db.query('UPDATE hrms_departments SET updated_at = NOW() - INTERVAL 1 MINUTE WHERE company_id = ? AND name LIKE ?', [COMPANY, `${TAG}%`]);
    const file = await download('departments', `?q=${TAG}`);
    const book = await open(file.contentBase64);
    const heads = [...book.head.keys()];
    ok(heads.includes(KIND.name) && !heads.includes('Label') && heads.includes(`${TAG} Units`) && heads.includes(`${TAG} Area`) && heads.indexOf(`${TAG} Units`) === heads.indexOf(KIND.name) + 1,
      `the departments file: "${KIND.name}" (the Kind group's own name) then one column per group, in group order`, heads.join(', '));
    {
      // A file with the older header "Label" still reads.
      const oldFile = await edited(file.contentBase64, (b) => { b.ws.getRow(1).getCell(b.head.get(KIND.name)).value = 'Label ★'; });
      const old = await preview('departments', oldFile);
      ok(old.status === 200 && old.json.summary.change === 0 && old.json.summary.problems === 0, 'a file with the old "Label" header reads the same', JSON.stringify(old.json?.summary ?? old.json));
    }
    const listsSheet = book.wb.getWorksheet('Lists');
    const listValues = []; listsSheet.eachRow((r) => r.eachCell((cell) => listValues.push(String(cell.value))));
    ok(listValues.includes(`${TAG} Units labels`) && listValues.includes('Unit 2') && book.wb.definedNames.model.some((n) => n.name === `List_group_${UNIT.id}`),
      'the Lists sheet has a list per group, behind its drop-down');
    ok(book.get(book.find('Name', `${TAG} B`), `${TAG} Units`) === 'Unit 2' && book.get(book.find('Name', `${TAG} B`), `${TAG} Area`) === 'Plant' && book.get(book.find('Name', `${TAG} C`), `${TAG} Area`) === '',
      'each department\'s cells hold its label in that group (blank where it has none)');
    const unchanged = await preview('departments', file.contentBase64);
    ok(unchanged.status === 200 && unchanged.json.summary.change === 0 && unchanged.json.summary.problems === 0 && unchanged.json.rows.every((r) => r.action === 'SAME'),
      'download -> upload unchanged = every row SAME', JSON.stringify(unchanged.json?.summary));
    const changedFile = await edited(file.contentBase64, (b) => b.set(b.find('Name', `${TAG} A`), `${TAG} Units`, 'Unit 2'));
    const changed = await preview('departments', changedFile);
    const row = changed.json.rows.find((r) => r.action === 'CHANGE');
    ok(changed.json.summary.change === 1 && row?.changes.length === 1 && row.changes[0].column === `${TAG} Units` && row.changes[0].from === 'Unit 1' && row.changes[0].to === 'Unit 2',
      'a group label changed in the file = one CHANGE, from -> to', JSON.stringify(row));
    const applied = await applyX('departments', changedFile, { add: 0, change: 1 });
    const aNow = (await get(`/organisation/departments?q=${TAG}%20A`)).rows.find((d) => d.id === A.id);
    ok(applied.status === 200 && applied.json.changed === 1 && aNow.labels.find((l) => l.groupId === UNIT.id)?.name === 'Unit 2', 'applied: the department now carries Unit 2');
    const wrong = await preview('departments', await edited(file.contentBase64, (b) => b.set(b.find('Name', `${TAG} C`), `${TAG} Area`, 'Unit 2')));
    ok(wrong.json.summary.problems === 1 && /Unit 2/.test(JSON.stringify(wrong.json.rows.find((r) => r.action === 'PROBLEM')?.problems)), 'a label of the wrong group in a group\'s column = a problem', JSON.stringify(wrong.json.rows.find((r) => r.action === 'PROBLEM')));
    const fresh = await download('departments', `?q=${TAG}`);
    const addRow = await edited(fresh.contentBase64, (b) => { const r = b.ws.rowCount + 1; b.set(r, 'Name', `${TAG} From file`); b.set(r, KIND.name, 'Section'); b.set(r, `${TAG} Units`, 'Unit 1'); });
    const added = await applyX('departments', addRow, { add: 1, change: 0 });
    const fromFile = (await get(`/organisation/departments?q=${encodeURIComponent(`${TAG} From file`)}`)).rows[0];
    ok(added.status === 200 && fromFile?.labels.map((l) => l.name).join('|') === 'Section|Unit 1', 'a new row with a group label: the department is created with it', JSON.stringify({ added: added.json, labels: fromFile?.labels }));
    // positions and employees: info columns, and the label filter honoured by the download
    const pFile = await download('positions', `?q=${TAG}&label=${U2.id}`);
    const pBook = await open(pFile.contentBase64);
    const pList = await get(`/positions?q=${TAG}&label=${U2.id}`);
    ok(pFile.rows === pList.count && pBook.dataRows() === pList.count && pBook.head.has(`${TAG} Units`) && pBook.head.has('Kind')
      && pBook.get(pBook.find('Code', `${TAG}-B`), `${TAG} Units`) === 'Unit 2',
    'positions file: the label filter decides the rows; one info column per group with the department\'s label', `${pFile.rows} vs ${pList.count}`);
    const pSame = await preview('positions', pFile.contentBase64);
    ok(pSame.json.summary.change === 0 && pSame.json.summary.problems === 0, 'the info columns are ignored on upload (unchanged file = SAME)');
    const eFile = await download('employees', `?q=${TAG}&label=${AX2.id}`);
    const eBook = await open(eFile.contentBase64);
    ok(eFile.rows === 2 && eBook.head.has(`${TAG} Area`) && eBook.get(eBook.find('Name', `${TAG} Person A`), `${TAG} Area`) === 'Plant', 'employees file: the label filter and the info columns', `${eFile.rows}`);
  }

  /* ══ 6. code formats ═════════════════════════════════════════════════════ */
  section('[6] Code formats: a condition per group, and the old Kind condition');
  {
    const entities = await get('/codegen/entities');
    const dept = (Array.isArray(entities) ? entities : entities.entities).find((e) => e.entityType === 'hrms_department');
    ok(dept.conditionTokens.some((t) => t.key === 'label') && dept.conditionTokens.some((t) => t.key === `label.${UNIT.id}` && t.groupId === UNIT.id && t.valueKind === 'departmentLabel'),
      'GET /codegen/entities: departments can be tested on Kind (`label`) and on each group (`label.<groupId>`)', dept.conditionTokens.map((t) => t.key).join(', '));
    const seq = (f) => ({ segmentType: 'sequence', format: f });
    const lit = (t) => ({ segmentType: 'literal', literalText: t });
    await createScheme(db, COMPANY, c.userId, {
      code: `${TAG}_U2`, name: `${TAG} Unit 2 departments`, entityType: 'hrms_department', targetField: 'code', seqScope: 'prefix', priority: 10, status: 'active',
      conditions: [{ tokenKey: `label.${UNIT.id}`, operator: 'eq', value: String(U2.id) }], segments: [lit(`${TAG}U2-`), seq('00')],
    });
    await createScheme(db, COMPANY, c.userId, {
      code: `${TAG}_MC`, name: `${TAG} Machines`, entityType: 'hrms_department', targetField: 'code', seqScope: 'prefix', priority: 10, status: 'active',
      conditions: [{ tokenKey: 'label', operator: 'eq', value: String(kindLabel('Machine').id) }], segments: [lit(`${TAG}MC-`), seq('00')],
    });
    const inU2 = (await mk('Coded U2', { [UNIT.id]: U2.id })).json;
    const inU1 = (await mk('Coded U1', { [UNIT.id]: U1.id })).json;
    const machine = (await mk('Coded machine', {}, { type: 'Machine' })).json;
    ok(inU2.code === `${TAG}U2-01` && !String(inU1.code).startsWith(`${TAG}U2`) && machine.code === `${TAG}MC-01`,
      'a rule "when its Unit label is Unit 2" codes that department; a Unit 1 department gets another rule; the old Kind condition still works', `${inU2.code} ${inU1.code} ${machine.code}`);
    const theirs = await caught(() => createScheme(db, COMPANY, c.userId, {
      code: `${TAG}_BAD`, name: `${TAG} bad`, entityType: 'hrms_department', targetField: 'code', seqScope: 'prefix', priority: 10, status: 'active',
      conditions: [{ tokenKey: `label.${UNIT.id}`, operator: 'eq', value: String(AU.id) }], segments: [seq('0')],
    }));
    ok(theirs && /that group/.test(JSON.stringify(theirs.problems ?? theirs.message)), 'a condition on a group with a label of ANOTHER group is refused', theirs?.message);
    await db.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND code LIKE ?", [COMPANY, `${TAG}%`]);
  }

  /* ══ 7. the command bar ══════════════════════════════════════════════════ */
  section('[7] The command bar: labels by name from any group');
  {
    // A group "Unit" with the label "Unit 2", as the sentence names it (the test group with a "Unit 2" goes first).
    await call(O, 'DELETE', `/organisation/label-groups/${UNIT.id}?force=1`);
    const unit = (await call(O, 'POST', '/organisation/label-groups', { name: 'Unit' })).json;
    const unit2 = await lab(unit.id, 'Unit 2');
    const production = await one("SELECT id FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL AND name = 'Production' LIMIT 1", [COMPANY]);
    if (!production || !unit?.id) skip('the command bar sentence', 'this company has no department called Production');
    else {
      const read = await call(O, 'POST', '/commands/read', { text: 'add a Machine department Printing 3 under Production in Unit 2' });
      const step = read.json?.plan?.steps?.[0];
      const f = step?.fields ?? {};
      ok(read.status === 200 && step?.action === 'add_department' && f.name?.value === 'Printing 3' && f.label?.value === 'Machine' && Number(f.under?.ref?.id) === production.id
        && String(f.labels?.value) === String(unit2.id), 'read: add_department — name Printing 3, Kind Machine, under Production, Unit: Unit 2', JSON.stringify(f));
      const checked = await call(O, 'POST', '/commands/check', { steps: read.json.plan.steps });
      ok(checked.status === 200 && checked.json.steps.every((s) => !s.problems.length), 'check: no problems', JSON.stringify(checked.json?.steps?.map((s) => s.problems)));
      const done = await call(O, 'POST', '/commands/apply', { steps: read.json.plan.steps });
      const made = (await get(`/organisation/departments?q=${encodeURIComponent('Printing 3')}`)).rows.find((d) => d.parentId === production.id);
      ok(done.status === 200 && made && made.type === 'Machine' && made.labels.some((l) => l.groupId === unit.id && l.labelId === unit2.id), 'apply: the department is made, a Machine, labelled Unit 2', JSON.stringify(made?.labels));
      const twoInOne = await call(O, 'POST', '/commands/check', { steps: [{ ...read.json.plan.steps[0], fields: { ...f, name: { value: `${TAG} two`, fromText: null, confidence: 1 }, labels: { value: `${U1.id},${U2.id}`, fromText: null, confidence: 1 } } }] });
      ok(twoInOne.json.steps[0].problems.some((p) => /one .* label/.test(p)), 'two labels of one group in a step: a problem', JSON.stringify(twoInOne.json.steps[0].problems));
      const options = await get('/commands/options');
      ok(Array.isArray(options.labelGroups) && options.labelGroups.some((g) => g.id === unit.id && g.labels.some((l) => l.id === unit2.id)), 'GET /commands/options carries the groups and their labels');
    }
  }

  /* ══ 8. rights and tenants ═══════════════════════════════════════════════ */
  section('[8] Rights and tenant isolation');
  {
    if (!U.EMPLOYEE) skip('Employee rights', 'no Employee access role');
    else {
      const e1 = await call(U.EMPLOYEE, 'GET', '/organisation/label-groups');
      const e2 = await call(U.EMPLOYEE, 'POST', '/organisation/label-groups', { name: `${TAG} no` });
      const e3 = await call(U.EMPLOYEE, 'DELETE', `/organisation/label-groups/${AREA.id}`);
      ok(e1.status === 403 && e2.status === 403 && e3.status === 403, 'an Employee login: 403 on reading and writing groups', `${e1.status} ${e2.status} ${e3.status}`);
    }
    if (!U.HR_EXECUTIVE) skip('HR executive rights', 'no HR executive access role');
    else {
      const h1 = await call(U.HR_EXECUTIVE, 'GET', '/organisation/label-groups');
      const h2 = await call(U.HR_EXECUTIVE, 'POST', '/organisation/label-groups', { name: `${TAG} no` });
      const h3 = await call(U.HR_EXECUTIVE, 'PUT', `/organisation/label-groups/${AREA.id}`, { name: 'x' });
      ok(h1.status === 200 && h2.status === 403 && h3.status === 403, 'an HR executive (org view, no org edit): reads the groups, cannot change them', `${h1.status} ${h2.status} ${h3.status}`);
    }
    if (!THEM) skip('tenant isolation', 'no second company with an admin login');
    else {
      const theirList = await call(THEM, 'GET', '/organisation/label-groups', undefined, { as: other.slug });
      const t2 = await call(THEM, 'PUT', `/organisation/label-groups/${AREA.id}`, { name: 'Taken' }, { as: other.slug });
      const t3 = await call(THEM, 'DELETE', `/organisation/label-groups/${AREA.id}?force=1`, undefined, { as: other.slug });
      const t4 = await call(THEM, 'POST', '/organisation/department-labels', { groupId: AREA.id, name: 'Sneaky' }, { as: other.slug });
      const theirFilter = await call(THEM, 'GET', `/organisation/departments?label=${AX2.id}`, undefined, { as: other.slug });
      ok(theirList.status === 200 && !theirList.json.groups.some((g) => g.id === AREA.id) && t2.status === 404 && t3.status === 404 && t4.status === 422
        && theirFilter.status === 200 && theirFilter.json.count === 0, 'another company: does not see these groups, cannot rename, remove or add to them, and filtering by these labels finds nothing of theirs',
      `${theirList.status} ${t2.status} ${t3.status} ${t4.status} ${theirFilter.json?.count}`);
      const theirDept = await call(THEM, 'POST', '/organisation/departments', { name: `${TAG} theirs`, labels: { [AREA.id]: AX2.id } }, { as: other.slug });
      ok(theirDept.status === 422, 'another company cannot give its department a label of this company (422)');
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
