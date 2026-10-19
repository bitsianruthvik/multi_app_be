/**
 * excel_test.mjs — clean-up round C: list filters, and Excel with guardrails.
 * (TM/CF_HRMS_HIRING_SPEC.md §13; 2026-10-13.)
 *
 *   1. list filters: the parameters of §13.6, `total` and `count`;
 *   2. the workbook itself: sheets, validations, defined names, protection,
 *      the frozen header, the hidden plumbing, the How to use sheet;
 *   3. EVERY entity: download -> upload unchanged = all SAME; change a cell =
 *      one CHANGE with its from / to; add a row = one ADD, with an issued code
 *      where the entity has one; applied, and read back;
 *   4. files that are not ours: another company's, another entity's, a changed
 *      hidden sheet, an older layout, not an xlsx, macros, 5 MB, a lost column,
 *      more than 2,000 rows;
 *   5. rows that are wrong: an id of another tenant, of a removed record, twice;
 *      a list value typed by hand; a formula; text too long; a date as text;
 *      a number as text; trailing spaces; an emptied required cell; a loop;
 *      a new row under a new row; a record changed since the download;
 *   6. apply: PREVIEW_STALE, HAS_PROBLEMS, skipProblemRows, all-or-nothing when
 *      a rule only the service knows refuses a row, never removes;
 *   7. employees: the bulk-add right, contact columns, the position rules, a
 *      joining date in the future;
 *   8. rights and scope;
 *   9. round trips for 200 rows.
 *
 *   node scripts/cf_hrms/excel_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND. As in access_test: the whole process runs on ONE
 * connection inside ONE transaction (`pool.query` / `pool.getConnection` are
 * pointed at it; a transaction a route opens becomes a savepoint) and it is
 * rolled back at the end. Local only.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import ExcelJS from 'exceljs';
import mysql from 'mysql2/promise';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import hrmsApp from '../../apps/cf_hrms/app.js';
import { PERM } from '../../apps/cf_hrms/lib/http.js';
import { forgetAccess } from '../../apps/cf_hrms/lib/accessContext.js';
import { hrmsAppOf, ensureCatalog, setRoleTags } from '../../apps/cf_hrms/services/accessGrants.js';
import { ENTITIES } from '../../apps/cf_hrms/services/excel/entities/index.js';
import { sign, SCHEMA_VERSION, EXTRA_ROWS } from '../../apps/cf_hrms/services/excel/workbook.js';
import * as ORG from '../../apps/cf_hrms/services/organisationService.js';
import * as RC from '../../apps/cf_hrms/services/roleContentService.js';
import * as HIRE from '../../apps/cf_hrms/services/hiringService.js';

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
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const TABLES = ['users', 'roles', 'role_capability', 'app_user_access', 'hrms_employees', 'hrms_positions', 'hrms_departments', 'hrms_locations', 'hrms_roles', 'hrms_work_assignments',
  'hrms_holidays', 'hrms_holiday_calendars', 'hrms_shifts', 'hrms_shift_days', 'hrms_kra_definitions', 'hrms_responsibility_definitions', 'hrms_kpi_definitions', 'hrms_skill_definitions',
  'hrms_qualification_definitions', 'hrms_authority_definitions', 'hrms_audit_log', 'hrms_hirings', 'hrms_position_reporting_relationships', 'hrms_department_labels', 'cf_code_sequences'];
async function worldCount() {
  const conn = await mysql.createConnection({ host: process.env.DB_HOST ?? 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306 });
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
let queries = 0;
const inside = {
  query: (...a) => { queries += 1; return db.query(...a); },
  execute: (...a) => { queries += 1; return db.execute(...a); },
  beginTransaction: async () => { depth += 1; await db.query(`SAVEPOINT zz_excel_${depth}`); },
  commit: async () => { if (depth > 0) { await db.query(`RELEASE SAVEPOINT zz_excel_${depth}`); depth -= 1; } },
  rollback: async () => { if (depth > 0) { await db.query(`ROLLBACK TO SAVEPOINT zz_excel_${depth}`); depth -= 1; } },
  release: () => {},
};
pool.query = inside.query;
pool.execute = inside.execute;
pool.getConnection = async () => inside;

const TAG = `ZZXL${Date.now().toString(36).toUpperCase().slice(-5)}`;
const q = async (sql, params) => (await db.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0] ?? null;
const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
const pad2 = (n) => String(n).padStart(2, '0');
const dayText = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return dayText(d); };

/* ── editing a workbook the way a person, or a paste, does ────────────────── */
async function open(base64) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(base64, 'base64'));
  const ws = wb.getWorksheet('Data');
  const head = new Map();
  if (ws) ws.getRow(1).eachCell((cell, col) => head.set(String(cell.value).replace(/\s*★\s*$/, ''), col));
  const text = (cell) => { const v = cell.value; return v == null ? '' : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v.richText ? v.richText.map((p) => p.text).join('') : v)); };
  const lastUsed = () => { let n = 1; if (ws) for (let r = 2; r <= ws.rowCount; r += 1) if (text(ws.getCell(r, 1)) !== '' || [...head.values()].some((col) => text(ws.getCell(r, col)) !== '')) n = r; return n; };
  return {
    wb, ws, head,
    col: (h) => { const col = head.get(h); if (!col) throw new Error(`no column "${h}" (have: ${[...head.keys()].join(', ')})`); return col; },
    get(row, h) { return text(ws.getCell(row, this.col(h))); },
    set(row, h, value) { ws.getCell(row, this.col(h)).value = value; },
    find(h, needle) { for (let r = 2; r <= ws.rowCount; r += 1) if (this.get(r, h).includes(needle)) return r; throw new Error(`no row whose "${h}" holds "${needle}"`); },
    rows() { return lastUsed() - 1; },
    append(values) { const r = lastUsed() + 1; for (const [h, v] of Object.entries(values)) this.set(r, h, v); return r; },
    copyRow(from) { const r = lastUsed() + 1; for (let col = 1; col <= ws.columnCount; col += 1) ws.getCell(r, col).value = ws.getCell(from, col).value; return r; },
    async save() { return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64'); },
  };
}
const edited = async (base64, fn) => { const book = await open(base64); await fn(book); return book.save(); };

let server;
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
  console.log(`excel_test — ${company.name} (${COMPANY}), run tag ${TAG}; the other company with the app is ${other ? `${other.name} (${other.id})` : 'none'}`);

  /* ── the fixture ─────────────────────────────────────────────────────────── */
  const dept = async (name, parentId = null) => ins("INSERT INTO hrms_departments (company_id, code, name, department_type, parent_department_id) VALUES (?, ?, ?, 'Department', ?)", [COMPANY, `${TAG}${name}`, `${TAG} ${name}`, parentId]);
  const D = { root: await dept('ROOT') };
  D.sub = await dept('SUB', D.root);
  D.other = await dept('OTHER');
  const hrmsRole = await ins("INSERT INTO hrms_roles (company_id, role_code, title, role_purpose, status) VALUES (?, ?, ?, 'Runs the machine safely and to plan.', 'ACTIVE')", [COMPANY, `${TAG}R`, `${TAG} Operator`]);
  const shifts = await q("SELECT id, code, name FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY id", [COMPANY]);
  if (shifts.length < 2) throw new Error('This company needs two shifts.');
  const [S1, S2] = shifts;
  const pos = async (code, departmentId, shiftId = S1.id) => ins("INSERT INTO hrms_positions (company_id, position_code, role_id, position_title, department_id, default_shift_id, status) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')", [COMPANY, `${TAG}-${code}`, hrmsRole, `${TAG} ${code}`, departmentId, shiftId]);
  const P = { head: await pos('HEAD', D.root), in: await pos('IN', D.root), sub: await pos('SUB', D.sub), out: await pos('OUT', D.other), vac: await pos('VAC', D.sub), vac2: await pos('VAC2', D.sub), vacOut: await pos('VACOUT', D.other), hire: await pos('HIRE', D.sub), closed: await pos('CLOSED', D.sub) };
  await db.query("UPDATE hrms_positions SET status = 'CLOSED' WHERE id = ?", [P.closed]);
  const emp = async (code, phone) => ins(
    "INSERT INTO hrms_employees (company_id, employee_code, full_name, phone, email, date_of_birth, date_of_joining, employment_type, employment_status, address_json) VALUES (?, ?, ?, ?, ?, '1990-01-02', '2026-01-01', 'EMPLOYEE', 'ACTIVE', ?)",
    [COMPANY, `${TAG}${code}`, `${TAG} Person ${code}`, phone, `${TAG.toLowerCase()}.${code.toLowerCase()}@example.test`, JSON.stringify({ line1: `${code} Street`, city: 'Hyderabad' })]);
  const seat = async (employeeId, positionId, departmentId) => ins(
    "INSERT INTO hrms_work_assignments (company_id, employee_id, role_id, position_id, department_id, is_primary, status, effective_from) VALUES (?, ?, ?, ?, ?, 1, 'ACTIVE', '2026-01-01')", [COMPANY, employeeId, hrmsRole, positionId, departmentId]);
  const E = { head: await emp('HEAD', '9100000001'), in: await emp('IN', '9100000002'), sub: await emp('SUB', '9100000003'), out: await emp('OUT', '9100000004') };
  await seat(E.head, P.head, D.root); await seat(E.in, P.in, D.root); await seat(E.sub, P.sub, D.sub); await seat(E.out, P.out, D.other);
  const primaryType = await one("SELECT id FROM hrms_reporting_relationship_types WHERE company_id = ? AND code = 'PRIMARY_MANAGER' AND deleted_at IS NULL", [COMPANY]);
  if (primaryType) for (const from of [P.in, P.sub]) await db.query("INSERT INTO hrms_position_reporting_relationships (company_id, from_position_id, to_position_id, relationship_type_id, is_primary, effective_from) VALUES (?, ?, ?, ?, 1, '2026-01-01')", [COMPANY, from, P.head, primaryType.id]);
  const location = await ORG.createLocation(db, c, { name: `${TAG} Unit`, locationType: 'UNIT', address: { line1: '1 Test Road', city: 'Pune' } });
  const calendar = (await ORG.createHolidayCalendar(db, c, { name: `${TAG} Calendar` })).calendar;
  await ORG.createCalendarHoliday(db, c, calendar.id, { date: '2027-01-26', name: `${TAG} Republic Day` });
  const shift = await ORG.createShift(db, c, { code: `${TAG}S`, name: `${TAG} Shift`, startTime: '08:00', endTime: '17:00' });
  const LIB = {
    kras: { name: `${TAG} KRA`, description: 'd', category: 'c' }, responsibilities: { name: `${TAG} Duty`, description: 'Does the thing.', responsibilityClass: 'OWNER' },
    kpis: { name: `${TAG} KPI`, measurementType: 'NUMBER' }, skills: { name: `${TAG} Skill`, skillType: 'TECHNICAL' },
    qualifications: { name: `${TAG} Qualification`, qualificationType: 'EDUCATION' }, authorities: { name: `${TAG} Authority`, authorityType: 'STOP', description: 'May stop the line.' },
  };
  for (const [kind, input] of Object.entries(LIB)) await RC.createMasterItem(db, c, kind, input);
  // Everything above was written a moment ago; a file downloaded now must not look older than the records.
  for (const t of ['hrms_departments', 'hrms_roles', 'hrms_positions', 'hrms_employees']) await db.query(`UPDATE ${t} SET updated_at = NOW() - INTERVAL 1 MINUTE WHERE company_id = ? AND (id >= ?)`, [COMPANY, 0]).catch(() => {});

  /* ── logins ─────────────────────────────────────────────────────────────── */
  const catalogRows = await ensureCatalog(db);
  const roleByKey = Object.fromEntries((await q('SELECT role_id, template_key FROM hrms_access_roles WHERE company_id = ? AND deleted_at IS NULL AND template_key IS NOT NULL', [COMPANY])).map((r) => [r.template_key, r.role_id]));
  const login = async (label, roleId, employeeId = null, slugOf = company.slug, companyId = COMPANY, appId = app.id) => {
    const email = `${TAG.toLowerCase()}.${label.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.test`;
    const id = await ins('INSERT INTO users (name, email, password, role_id, team_id, company_id) VALUES (?, ?, ?, ?, NULL, ?)', [`${TAG} ${label}`, email, 'x', roleId, companyId]);
    await db.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [id, appId, roleId, companyId]);
    if (employeeId) await db.query('UPDATE hrms_employees SET user_id = ? WHERE id = ?', [id, employeeId]);
    const roleName = (await one('SELECT name FROM roles WHERE id = ?', [roleId])).name;
    return { id, email, token: signToken({ id, name: `${TAG} ${label}`, email, role: roleName, company: slugOf, companyId, company_id: companyId, uiPermissions: [] }) };
  };
  const customRole = async (name, tags, scope = 'COMPANY') => {
    const id = await ins('INSERT INTO roles (name, company_id) VALUES (?, ?)', [`${TAG} ${name}`, COMPANY]);
    await db.query('INSERT INTO hrms_access_roles (company_id, role_id, label, scope) VALUES (?, ?, ?, ?)', [COMPANY, id, `${TAG} ${name}`, scope]);
    await setRoleTags(db, { companyId: COMPANY, appId: app.id, roleId: id, tags, catalog: catalogRows });
    return id;
  };
  const U = {
    OWNER: { id: owner.id, token: signToken({ id: owner.id, name: owner.name, email: owner.email, role: 'admin', company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) },
    HR_EXECUTIVE: await login('HR executive', roleByKey.HR_EXECUTIVE),
    HR_MANAGER: await login('HR manager', roleByKey.HR_MANAGER),
    DEPARTMENT_HEAD: await login('Department head', roleByKey.DEPARTMENT_HEAD, E.head),
  };
  forgetAccess();

  server = express();
  server.use(express.json({ limit: '50mb' }));
  server.use(cookieParser());
  server.use('/api', appContext);
  hrmsApp.register(server);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  server.close = () => new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${listener.address().port}/api`;
  const api = `/${company.slug}/cf_hrms`;
  const call = async (who, method, url, body, { raw = false } = {}) => {
    const res = await fetch(`${base}${raw ? url : `${api}${url}`}`, {
      method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  const download = async (who, entity, query = '') => { const r = await call(who, 'GET', `/excel/${entity}/workbook${query}`); if (r.status !== 200) throw new Error(`download ${entity}: ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
  const preview = (who, entity, contentBase64, fileName = `${entity}.xlsx`) => call(who, 'POST', `/excel/${entity}/preview`, { fileName, contentBase64 });
  const apply = (who, entity, contentBase64, expect, extra = {}) => call(who, 'POST', `/excel/${entity}/apply`, { fileName: `${entity}.xlsx`, contentBase64, expect, ...extra });
  const O = U.OWNER;
  const problemsOf = (p) => (p.json?.rows ?? []).filter((r) => r.action === 'PROBLEM').flatMap((r) => r.problems).join(' | ');
  const fileSays = (p, pattern) => p.status === 200 && p.json.fileProblems.length >= 1 && pattern.test(p.json.fileProblems.join(' ')) && p.json.rows.length === 0;

  /* ══ 1. list filters ══════════════════════════════════════════════════════ */
  section('[1] List filters: the parameters, total and count');
  {
    const get = async (url) => (await call(O, 'GET', url)).json;
    const all = await get('/positions');
    const inRoot = await get(`/positions?department=${D.root}`);
    ok(all.total === all.items.length && all.count === all.total && inRoot.total === all.total && inRoot.count === 7 && inRoot.items.length === 7 && inRoot.items.every((p) => [D.root, D.sub].includes(p.departmentId)),
      'GET /positions?department= : the department AND the ones below it; `total` is the whole list, `count` what is shown', `${inRoot.count} of ${inRoot.total}`);
    const vac = await get(`/positions?department=${D.root}&state=vacant`);
    const filled = await get(`/positions?department=${D.root}&state=filled`);
    const byShift = await get(`/positions?department=${D.root}&shift=${S2.id}`);
    const byRole = await get(`/positions?role=${hrmsRole}&q=${encodeURIComponent(`${TAG}-VAC`)}`);
    ok(vac.count === 4 && vac.items.every((p) => !p.occupant) && filled.count === 3 && filled.items.every((p) => p.occupant) && byShift.count === 0 && same(byRole.items.map((p) => p.positionCode), [`${TAG}-VAC`, `${TAG}-VAC2`, `${TAG}-VACOUT`]),
      '…state=vacant|filled, shift=, role= and q= narrow it; several filters together are "and"', `${vac.count} ${filled.count} ${byShift.count} ${byRole.count}`);
    const emps = await get(`/people/employees?department=${D.root}`);
    const hasLogin = await get(`/people/employees?department=${D.root}&hasLogin=1`);
    const joined = await get(`/people/employees?department=${D.root}&joinedFrom=2026-01-02`);
    const joined2 = await get(`/people/employees?role=${hrmsRole}&joinedFrom=2026-01-01&joinedTo=2026-01-01`);
    ok(same(emps.items.map((e) => e.id), [E.head, E.in, E.sub]) && emps.count === 3 && emps.total > 3 && same(hasLogin.items.map((e) => e.id), [E.head]) && joined.count === 0 && joined2.count === 4,
      'GET /people/employees?department=&hasLogin=&joinedFrom=&joinedTo=&role=', `${emps.count} ${hasLogin.count} ${joined.count} ${joined2.count}`);
    const depts = await get(`/organisation/departments?parent=${D.root}`);
    const deptLabel = await get(`/organisation/departments?label=department&q=${TAG}`);
    ok(same(depts.rows.map((d) => d.id), [D.sub]) && depts.total >= 3 && deptLabel.count === 3, 'GET /organisation/departments?parent=&label=&q=');
    const roles = await get(`/roles?q=${TAG}&hasPositions=1`);
    const rolesNone = await get(`/roles?q=${TAG}&hasPositions=0`);
    const kras = await get(`/role-masters/kras?q=${TAG}&used=0`);
    const logins = await get('/access/logins?state=ACTIVE');
    const shiftsList = await get(`/organisation/shifts?q=${TAG}`);
    ok(roles.count === 1 && rolesNone.count === 0 && roles.total > 1 && kras.count === 1 && kras.items[0].name === `${TAG} KRA` && typeof logins.total === 'number' && logins.count === logins.logins.length && shiftsList.count === 1 && shiftsList.shifts.length === 1,
      'roles (hasPositions), libraries (used), logins and shifts answer total and count too');
  }

  /* ══ 2. the workbook itself ═══════════════════════════════════════════════ */
  section('[2] The workbook: what the generated file holds');
  {
    const file = await download(O, 'positions', `?department=${D.root}`);
    const book = await open(file.contentBase64);
    const { wb, ws } = book;
    ok(/^[A-Za-z0-9]+-Positions-\d{4}-\d{2}-\d{2}\.xlsx$/.test(file.fileName) && file.mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' && file.rows === 6,
      'the answer is { fileName, mimeType, contentBase64, rows } and the file is named Company-Positions-date.xlsx', file.fileName);
    ok(JSON.stringify(wb.worksheets.map((s) => s.name)) === JSON.stringify(['How to use', 'Data', 'Lists', '_meta']) && wb.getWorksheet('_meta').state === 'veryHidden',
      'four sheets: How to use first, Data, Lists, and a hidden _meta');
    ok(String(ws.getCell(1, 1).value) === '_id' && String(ws.getCell(1, 2).value) === '_seen' && ws.getColumn(1).hidden === true && ws.getColumn(2).hidden === true
      && JSON.stringify([...book.head.keys()].slice(2)) === JSON.stringify(['Code', 'Role', 'Department', 'Shift', 'Location', 'Reports to', 'Status', 'Person', 'Label']) && String(ws.getCell(1, 4).value) === 'Role ★',
    'the Data sheet: hidden _id and _seen, then the columns of the spec — the required ones starred', [...book.head.keys()].join(', '));
    ok(ws.views?.[0]?.state === 'frozen' && ws.views[0].ySplit === 1 && ws.getCell(1, 3).font?.bold === true && Boolean(ws.sheetProtection?.sheet), 'the header row is frozen and bold, and the sheet is protected');
    const row = book.find('Code', `${TAG}-IN`);
    ok(ws.getCell(row, book.col('Code')).protection?.locked !== false && ws.getCell(row, book.col('Person')).protection?.locked !== false && ws.getCell(row, book.col('Role')).protection?.locked === false
      && ws.getCell(row, book.col('Code')).fill?.fgColor?.argb === 'FFEDEDED' && Number(ws.getCell(row, 1).value) === P.in && book.get(row, 'Person').includes(`${TAG} Person IN`)
      && /issued by the system/i.test(String(ws.getCell(1, book.col('Code')).note?.texts?.map((t) => t.text).join('') ?? ws.getCell(1, book.col('Code')).note ?? '')),
    'issued and info cells are grey and locked, with a note on the header; the cells a person fills are unlocked');
    const validations = ws.dataValidations.model;
    const last = file.rows + 1 + EXTRA_ROWS;
    const refs = Object.keys(validations);
    const letter = (h) => ws.getColumn(book.col(h)).letter;
    const v = (h) => validations[`${letter(h)}2:${letter(h)}${last}`] ?? validations[`${letter(h)}2`];
    ok(refs.length >= 6 && v('Role')?.type === 'list' && /List_roles/.test(String(v('Role').formulae[0])) && v('Status')?.type === 'list' && v('Reports to')?.type === 'list' && v('Role').showErrorMessage === true && /Roles/.test(v('Role').error),
      `every list column has a drop-down fed from a named list, with a plain message — down to 500 rows past the last record (row ${last})`, refs.slice(0, 4).join(' '));
    const names = new Set((wb.definedNames.model ?? []).map((n) => n.name));
    ok(['List_roles', 'List_departments', 'List_shifts', 'List_locations', 'List_positions', 'List_status'].every((n) => names.has(n)), 'a defined name per list', [...names].join(', '));
    const lists = wb.getWorksheet('Lists');
    const listHead = []; lists.getRow(1).eachCell((cell) => listHead.push(String(cell.value)));
    const listCol = (name) => { const out = []; const col = listHead.indexOf(name) + 1; for (let r = 2; r <= lists.rowCount; r += 1) { const x = lists.getCell(r, col).value; if (x) out.push(String(x)); } return out; };
    ok(JSON.stringify(listHead) === JSON.stringify(['Roles', 'Departments', 'Shifts', 'Locations', 'Positions', 'Status']) && listCol('Departments').includes(`${TAG}ROOT — ${TAG} ROOT`) && listCol('Positions').includes(`${TAG}-HEAD — ${TAG} Operator`)
      && !listCol('Positions').some((x) => x.startsWith(`${TAG}-CLOSED`)) && JSON.stringify(listCol('Status')) === JSON.stringify(['DRAFT', 'ACTIVE', 'FROZEN']) && Boolean(lists.sheetProtection?.sheet),
    'the Lists sheet is the company’s own values, one column per list, "CODE — Name", protected — and a closed position is not offered');
    const how = wb.getWorksheet('How to use');
    const words = []; how.eachRow((r) => r.eachCell((cell) => words.push(String(cell.value))));
    const howText = words.join('\n');
    ok([...book.head.keys()].slice(2).every((h) => words.includes(h)) && /never removes/i.test(howText) && /2026-10-12/.test(howText) && howText.includes(company.name) && /Downloaded on \d{4}-\d{2}-\d{2} by/.test(howText) && /formulas are not read/i.test(howText),
      'How to use: when, by whom and for which company; every column with what goes in it; the rules — dates as year-month-day, formulas not read, an upload never removes');
    const meta = {}; wb.getWorksheet('_meta').eachRow((r) => { meta[String(r.getCell(1).value)] = String(r.getCell(2).value); });
    ok(meta.entity === 'positions' && Number(meta.companyId) === COMPANY && Number(meta.schemaVersion) === SCHEMA_VERSION && meta.signature === sign(meta) && /^\d{4}-\d{2}-\d{2}T/.test(meta.generatedAt),
      '_meta: the entity, the company, the layout version, when — and a signature of those');
    const blank = await download(O, 'positions', '?blank=1');
    const blankBook = await open(blank.contentBase64);
    ok(blank.rows === 0 && blankBook.rows() === 0 && Object.keys(blankBook.ws.dataValidations.model).length >= 6, '?blank=1 is the same workbook with no rows, the first 500 already guarded');
    const emps = await open((await download(O, 'employees', `?department=${D.root}`)).contentBase64);
    ok(emps.ws.getCell(emps.find('Code', `${TAG}IN`), emps.col('Date of joining')).numFmt === 'yyyy-mm-dd' && emps.ws.getCell(emps.find('Code', `${TAG}IN`), emps.col('Date of joining')).value instanceof Date
      && (emps.ws.dataValidations.model[`${emps.ws.getColumn(emps.col('Date of joining')).letter}2:${emps.ws.getColumn(emps.col('Date of joining')).letter}${3 + 1 + EXTRA_ROWS}`] ?? emps.ws.dataValidations.model[`${emps.ws.getColumn(emps.col('Date of joining')).letter}2`])?.type === 'date',
    'a date column holds real dates, shown as year-month-day, and its cells accept only dates');
    const list = await call(O, 'GET', '/excel/entities');
    ok(list.status === 200 && JSON.stringify(list.json.map((e) => e.entity)) === JSON.stringify(['departments', 'locations', 'roles', 'positions', 'employees', 'holidays', 'shifts', 'library-kras', 'library-responsibilities', 'library-kpis', 'library-skills', 'library-qualifications', 'library-authorities', 'actuals', 'leave-balances', 'pay-salaries', 'pay-items'])
      && list.json.every((e) => e.label && e.area && e.canDownload === true && e.canUpload === true), 'GET /excel/entities -> the seventeen files, [{ entity, label, area, canDownload, canUpload }]');
  }

  /* ══ 3. every entity ══════════════════════════════════════════════════════ */
  section('[3] Every entity: unchanged = SAME; a changed cell = CHANGE; a new row = ADD');
  const deptCode = async (id) => (await one('SELECT code FROM hrms_departments WHERE id = ?', [id])).code;
  const CASES = {
    departments: { query: `?q=${TAG}`, at: ['Name', `${TAG} SUB`], change: ['Name', `${TAG} SUB renamed`], add: async () => ({ Name: `${TAG} Added department`, Label: 'Section', Under: await deptCode(D.root), Shared: 'No' }), issued: true, read: 'Name' },
    locations: { query: `?q=${TAG}`, at: ['Name', `${TAG} Unit`], change: ['City', 'Nagpur'], add: () => ({ Name: `${TAG} Added location`, City: 'Indore', Pincode: '452001' }), issued: true, read: 'City' },
    roles: { query: `?q=${TAG}`, at: ['Title', `${TAG} Operator`], change: ['Purpose', 'Runs the machine and keeps it clean.'], add: () => ({ Title: `${TAG} Added role`, Purpose: 'A new job.', Status: 'ACTIVE' }), issued: true, read: 'Purpose' },
    positions: { query: `?department=${D.root}`, at: ['Code', `${TAG}-VAC2`], change: ['Shift', `${S2.code} — ${S2.name}`], add: () => ({ Role: `${TAG}R`, Department: `${TAG}SUB`, Shift: S1.code, 'Reports to': `${TAG}-HEAD`, Status: 'ACTIVE' }), issued: true, read: 'Shift' },
    employees: { query: `?department=${D.root}`, at: ['Code', `${TAG}IN`], change: ['Phone', '9222222222'], add: () => ({ Name: `${TAG} Added person`, 'Date of joining': '2026-10-01', Phone: '9333333333', Position: `${TAG}-VAC` }), issued: true, read: 'Phone' },
    holidays: { query: `?calendar=${calendar.id}`, at: ['Name', `${TAG} Republic Day`], change: ['Name', `${TAG} Republic Day (renamed)`], add: () => ({ Calendar: `${TAG} Calendar`, Date: new Date(Date.UTC(2027, 7, 15)), Name: `${TAG} Independence Day`, Optional: 'Yes' }), issued: false, read: 'Name' },
    shifts: { query: `?q=${TAG}`, at: ['Code', `${TAG}S`], change: ['Monday start', '09:00'], add: () => ({ Code: `${TAG}N`, Name: `${TAG} Added shift`, 'Monday working': 'Yes', 'Monday start': '22:00', 'Monday end': '06:00', 'Monday break minutes': 30 }), issued: false, read: 'Monday start' },
    'library-kras': { query: `?q=${TAG}`, at: ['Name', `${TAG} KRA`], change: ['Category', 'Changed'], add: () => ({ Name: `${TAG} Added KRA`, Category: 'New' }), read: 'Category' },
    'library-responsibilities': { query: `?q=${TAG}`, at: ['Name', `${TAG} Duty`], change: ['Statement', 'Does the thing, every shift.'], add: () => ({ Name: `${TAG} Added duty`, Statement: 'A new duty.', Class: 'SUPPORT' }), read: 'Statement' },
    'library-kpis': { query: `?q=${TAG}`, at: ['Name', `${TAG} KPI`], change: ['Unit', 'pcs'], add: () => ({ Name: `${TAG} Added KPI`, 'Measured in': 'Percentage', Frequency: 'MONTHLY' }), read: 'Unit' },
    'library-skills': { query: `?q=${TAG}`, at: ['Name', `${TAG} Skill`], change: ['Description', 'Changed.'], add: () => ({ Name: `${TAG} Added skill`, 'Skill type': 'MACHINE' }), read: 'Description' },
    'library-qualifications': { query: `?q=${TAG}`, at: ['Name', `${TAG} Qualification`], change: ['Qualification type', 'LICENCE'], add: () => ({ Name: `${TAG} Added qualification`, 'Qualification type': 'CERTIFICATION' }), read: 'Qualification type' },
    'library-authorities': { query: `?q=${TAG}`, at: ['Name', `${TAG} Authority`], change: ['What the holder may do', 'May stop the line and call maintenance.'], add: () => ({ Name: `${TAG} Added authority`, 'Authority type': 'APPROVE', 'What the holder may do': 'May approve overtime.' }), read: 'What the holder may do' },
  };
  // Actuals (spec §19.3) are rows of person × KPI × slot, never added by a file: their round trip is in actuals_test.mjs.
  // Leave balances (spec §22.5) are rows of person × leave year, never added by a file: theirs is in leave_request_test.mjs.
  // Salaries and one-time pay items (spec §25.2): theirs are in payroll_test.mjs.
  const ROUND_TRIP = ENTITIES.filter((e) => e.entity !== 'actuals' && e.entity !== 'leave-balances' && !e.entity.startsWith('pay-'));
  ok(same(Object.keys(CASES), ROUND_TRIP.map((e) => e.entity)), 'every entity the engine knows is tested here (actuals: in actuals_test.mjs; leave balances: in leave_request_test.mjs; payroll: in payroll_test.mjs)', ROUND_TRIP.map((e) => e.entity).filter((e) => !CASES[e]).join(', '));
  const issuedOf = {};
  for (const def of ROUND_TRIP) {
    const k = CASES[def.entity];
    try {
      const file = await download(O, def.entity, k.query);
      const unchanged = await preview(O, def.entity, file.contentBase64);
      ok(unchanged.status === 200 && unchanged.json.fileProblems.length === 0 && unchanged.json.summary.same === file.rows && file.rows >= 1 && unchanged.json.summary.add + unchanged.json.summary.change + unchanged.json.summary.problems === 0
        && unchanged.json.rows.every((r) => r.action === 'SAME' && r.changes.length === 0 && r.label),
      `${def.entity}: downloaded and uploaded unchanged — all ${file.rows} SAME`, `${JSON.stringify(unchanged.json?.summary)} ${problemsOf(unchanged)} ${(unchanged.json?.fileProblems ?? []).join(' ')}`.slice(0, 400));

      let rowNo = 0; let from = '';
      const changedFile = await edited(file.contentBase64, (b) => { rowNo = b.find(...k.at); from = b.get(rowNo, k.change[0]); b.set(rowNo, k.change[0], k.change[1]); });
      const pc = await preview(O, def.entity, changedFile);
      const changedRow = pc.json?.rows?.find((r) => r.row === rowNo);
      ok(pc.status === 200 && pc.json.summary.change === 1 && pc.json.summary.same === file.rows - 1 && pc.json.summary.problems === 0 && changedRow?.action === 'CHANGE'
        && JSON.stringify(changedRow.changes) === JSON.stringify([{ column: k.change[0], from, to: k.change[1].split(' — ').length > 1 ? k.change[1] : k.change[1] }]),
      `${def.entity}: one cell changed — one CHANGE, naming the column and its from → to`, `${JSON.stringify(pc.json?.summary)} ${JSON.stringify(changedRow)} ${problemsOf(pc)}`.slice(0, 400));
      const ac = await apply(O, def.entity, changedFile, { add: 0, change: 1 });
      ok(ac.status === 200 && ac.json.changed === 1 && ac.json.added === 0 && ac.json.skipped === 0, `${def.entity}: applied — { added: 0, changed: 1, skipped: 0 }`, `${ac.status} ${JSON.stringify(ac.json).slice(0, 300)}`);

      const file2 = await download(O, def.entity, k.query);
      const book2 = await open(file2.contentBase64);
      ok(book2.get(book2.find(k.change[0], k.change[1]), k.read) === k.change[1] && file2.rows === file.rows, `${def.entity}: read back — the new value is on the record`);
      const values = await k.add();
      let addedRow = 0;
      const addFile = await edited(file2.contentBase64, (b) => { addedRow = b.append(values); });
      const pa = await preview(O, def.entity, addFile);
      ok(pa.status === 200 && pa.json.summary.add === 1 && pa.json.summary.change === 0 && pa.json.summary.problems === 0 && pa.json.rows.find((r) => r.row === addedRow)?.action === 'ADD' && pa.json.rows.find((r) => r.row === addedRow).changes.length >= 1,
        `${def.entity}: a row added at the bottom — one ADD`, `${JSON.stringify(pa.json?.summary)} ${problemsOf(pa)}`.slice(0, 400));
      const aa = await apply(O, def.entity, addFile, { add: 1, change: 0 });
      const code = aa.json?.issuedCodes?.[0]?.code;
      issuedOf[def.entity] = code ?? null;
      ok(aa.status === 200 && aa.json.added === 1 && (k.issued ? (aa.json.issuedCodes.length === 1 && aa.json.issuedCodes[0].row === addedRow && typeof code === 'string' && code.length > 0) : true),
        `${def.entity}: applied — added 1${k.issued ? `, with the code the system issued (${code})` : ''}`, `${aa.status} ${JSON.stringify(aa.json).slice(0, 300)}`);
      const file3 = await download(O, def.entity, k.query.startsWith('?q=') ? k.query : '');
      const book3 = await open(file3.contentBase64);
      const firstKey = Object.keys(values).find((h) => typeof values[h] === 'string' && values[h].startsWith(TAG) && !['Role', 'Department', 'Calendar', 'Position', 'Under', 'Reports to'].includes(h));
      const again = await preview(O, def.entity, file3.contentBase64);
      ok((firstKey ? book3.get(book3.find(firstKey, values[firstKey]), firstKey) === values[firstKey] : (k.issued && book3.find('Code', code) > 1)) && again.json.summary.same === file3.rows && again.json.summary.problems === 0,
        `${def.entity}: the new record is in the next download, which uploads as all SAME`, `${JSON.stringify(again.json?.summary)} ${problemsOf(again)}`.slice(0, 300));
    } catch (err) {
      ok(false, `${def.entity}: the round trip ran`, `${err.message} ${(err.stack ?? '').split('\n')[1] ?? ''}`);
    }
  }
  {
    const added = await one('SELECT id, employment_status, employee_code FROM hrms_employees WHERE company_id = ? AND full_name = ?', [COMPANY, `${TAG} Added person`]);
    const wa = added ? await one('SELECT position_id, status, effective_from, is_primary, default_shift_id FROM hrms_work_assignments WHERE employee_id = ? AND deleted_at IS NULL', [added.id]) : null;
    const audit = await one("SELECT after_json FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_employees' AND action = 'IMPORT' ORDER BY id DESC LIMIT 1", [COMPANY]);
    const after = audit ? (typeof audit.after_json === 'string' ? JSON.parse(audit.after_json) : audit.after_json) : {};
    ok(added?.employment_status === 'ACTIVE' && wa?.position_id === P.vac && wa.status === 'ACTIVE' && dayText(new Date(wa.effective_from)) === '2026-10-01' && wa.is_primary === 1 && wa.default_shift_id === S1.id
      && Number((await one('SELECT COUNT(*) AS n FROM hrms_hirings WHERE position_id = ?', [P.vac])).n) === 0,
    'the employee added by the file is ACTIVE, in the vacant position named, on its shift, from the joining date — with no hiring record');
    ok(after.event === 'BULK_ADD' && after.fileName === 'employees.xlsx' && after.rows === 1 && after.codes?.[0] === added.employee_code, 'and the run is in the audit log as BULK_ADD, with the file name and the row count', JSON.stringify(after));
    const newPos = await one('SELECT p.id, p.position_code FROM hrms_positions p WHERE p.company_id = ? AND p.position_code = ? AND p.deleted_at IS NULL', [COMPANY, issuedOf.positions]);
    const line = newPos ? await one('SELECT to_position_id FROM hrms_position_reporting_relationships WHERE from_position_id = ? AND deleted_at IS NULL', [newPos.id]) : null;
    ok(line?.to_position_id === P.head, 'the position added by the file reports to the position named in "Reports to"', JSON.stringify({ newPos, line }));
    const shiftRow = await one("SELECT COUNT(*) AS n FROM hrms_shift_days d JOIN hrms_shifts s ON s.id = d.shift_id WHERE s.company_id = ? AND s.code = ? AND d.deleted_at IS NULL", [COMPANY, `${TAG}N`]);
    ok(Number(shiftRow.n) === 7, 'the shift added by the file has its seven days');
  }

  /* ══ 4. files that are not ours ═══════════════════════════════════════════ */
  section('[4] Files that are refused whole');
  const posFile = await download(O, 'positions', `?department=${D.root}`);
  {
    const roleFile = await download(O, 'roles', `?q=${TAG}`);
    ok(fileSays(await preview(O, 'positions', roleFile.contentBase64), /This is the Roles file/), 'another entity’s file: "This is the Roles file. Upload it on that screen"');
    const notXlsx = Buffer.from('this is not a workbook at all, it is a text file').toString('base64');
    ok(fileSays(await preview(O, 'positions', notXlsx), /not an Excel workbook/), 'not an xlsx');
    ok(fileSays(await preview(O, 'positions', Buffer.from('PK\u0003\u0004 broken zip content').toString('base64')), /could not be opened/), 'a broken zip');
    ok(fileSays(await preview(O, 'positions', posFile.contentBase64, 'Positions.xlsm'), /macros/), 'an .xlsm by its name');
    ok(fileSays(await preview(O, 'positions', Buffer.concat([Buffer.from(posFile.contentBase64, 'base64'), Buffer.from('xl/vbaProject.bin')]).toString('base64')), /macros/), 'a workbook that carries a macro project under an .xlsx name');
    ok(fileSays(await preview(O, 'positions', Buffer.alloc(5 * 1024 * 1024 + 10, 0x50).toString('base64')), /5 MB/), 'a file over 5 MB');
    ok((await preview(O, 'positions', '')).status === 422, 'no file at all: 422');
    const tamper = async (fn) => edited(posFile.contentBase64, (b) => { const m = b.wb.getWorksheet('_meta'); const set = (key, value) => m.eachRow((r) => { if (String(r.getCell(1).value) === key) r.getCell(2).value = String(value); }); fn(set, m); });
    ok(fileSays(await preview(O, 'positions', await tamper((set) => set('entity', 'roles'))), /not made by this app, or its hidden sheet has been changed/), 'the hidden sheet changed (the entity): refused — the signature no longer fits');
    ok(fileSays(await preview(O, 'positions', await tamper((set) => set('companyId', other?.id ?? 1))), /not made by this app/), 'the hidden sheet changed (the company)');
    ok(fileSays(await preview(O, 'positions', await edited(posFile.contentBase64, (b) => { b.wb.removeWorksheet(b.wb.getWorksheet('_meta').id); })), /not a workbook from this app/), 'the hidden sheet removed');
    ok(fileSays(await preview(O, 'positions', await edited(posFile.contentBase64, (b) => { b.ws.name = 'Sheet1'; })), /not a workbook from this app/), 'the Data sheet renamed');
    const plain = new ExcelJS.Workbook(); plain.addWorksheet('Data').addRow(['Code', 'Role']);
    ok(fileSays(await preview(O, 'positions', Buffer.from(await plain.xlsx.writeBuffer()).toString('base64')), /not a workbook from this app/), 'somebody’s own spreadsheet');
    // An older layout, signed properly: only the version differs.
    const old = await tamper((set, m) => { const meta = {}; m.eachRow((r) => { meta[String(r.getCell(1).value)] = String(r.getCell(2).value); }); meta.schemaVersion = String(SCHEMA_VERSION - 1); set('schemaVersion', meta.schemaVersion); set('signature', sign(meta)); });
    ok(fileSays(await preview(O, 'positions', old), /older layout/), 'a file of an older layout');
    ok(fileSays(await preview(O, 'positions', await edited(posFile.contentBase64, (b) => { b.ws.getCell(1, b.col('Shift')).value = 'Timing'; })), /lost a column: Shift/), 'a column renamed or removed: "The Data sheet has lost a column: Shift"');
    ok(fileSays(await preview(O, 'positions', await edited(posFile.contentBase64, (b) => { b.ws.getCell(1, 1).value = 'id'; })), /hidden columns/), 'the hidden columns moved');
    const many = await edited((await download(O, 'library-skills', '?blank=1')).contentBase64, (b) => { for (let i = 0; i < 2001; i += 1) b.ws.getCell(i + 2, b.col('Name')).value = `${TAG} bulk ${i}`; });
    ok(fileSays(await preview(O, 'library-skills', many), /more than 2,000 rows/), 'more than 2,000 rows: "Upload it in parts"');
    if (other) {
      const theirOwner = await one(
        `SELECT u.id, u.email FROM users u JOIN app_user_access aua ON aua.user_id = u.id AND aua.app_id = ? AND aua.deleted_at IS NULL JOIN roles r ON r.id = aua.role_id
          WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [other.app_id, other.id]);
      if (theirOwner) {
        const them = { token: signToken({ id: theirOwner.id, email: theirOwner.email, role: 'admin', company: other.slug, companyId: other.id, company_id: other.id, uiPermissions: [] }) };
        const theirs = await call(them, 'GET', `/${other.slug}/cf_hrms/excel/roles/workbook`, undefined, { raw: true });
        ok(theirs.status === 200 && fileSays(await preview(O, 'roles', theirs.json.contentBase64), /another company/), 'another company’s file: "This file was downloaded for another company"');
        const back = await call(them, 'POST', `/${other.slug}/cf_hrms/excel/positions/preview`, { fileName: 'p.xlsx', contentBase64: posFile.contentBase64 }, { raw: true });
        ok(fileSays(back, /another company/), 'and this company’s file is refused there');
      } else skip('another company’s file', 'it has no Owner login');
    } else skip('another company’s file', 'no second company has the app');
    const applied = await apply(O, 'positions', notXlsx, { add: 0, change: 0 });
    ok(applied.status === 422 && applied.json.code === 'FILE_PROBLEM' && applied.json.problems.length === 1, 'apply refuses such a file as 422 FILE_PROBLEM');
  }

  /* ══ 5. rows that are wrong ═══════════════════════════════════════════════ */
  section('[5] Rows that are refused, each in a sentence');
  {
    const rowProblem = async (entity, base64, pattern, { rows = 1 } = {}) => {
      const p = await preview(O, entity, base64);
      const bad = (p.json?.rows ?? []).filter((r) => r.action === 'PROBLEM');
      return p.status === 200 && p.json.fileProblems.length === 0 && bad.length === rows && bad.every((r) => r.problems.some((x) => pattern.test(x)));
    };
    const at = (b) => b.find('Code', `${TAG}-VAC2`);
    const foreign = other ? await one('SELECT id FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL LIMIT 1', [other.id]) : null;
    if (foreign) ok(await rowProblem('positions', await edited(posFile.contentBase64, (b) => { b.ws.getCell(at(b), 1).value = foreign.id; }), /not in this company any more/), 'a hidden id changed to another company’s record: "belongs to a record that is not in this company any more"');
    else skip('another tenant’s id', 'no position in another company');
    ok(await rowProblem('positions', await edited(posFile.contentBase64, (b) => { b.ws.getCell(at(b), 1).value = P.closed; }), /not in this company any more/), 'the id of a CLOSED position (not in the file’s world): refused the same way');
    ok(await rowProblem('positions', await edited(posFile.contentBase64, (b) => { b.ws.getCell(at(b), 1).value = 'abc'; }), /not in this company any more/), 'an id that is not a number');
    ok(await rowProblem('positions', await edited(posFile.contentBase64, (b) => { b.copyRow(at(b)); }), /in the file more than once/, { rows: 2 }), 'the same record on two rows: both are refused');
    ok(await rowProblem('positions', await edited(posFile.contentBase64, (b) => { b.ws.getCell(at(b), 2).value = ''; }), /hidden columns of this row were changed/), 'the hidden _seen emptied');
    ok(await rowProblem('positions', await edited(posFile.contentBase64, (b) => b.set(at(b), 'Shift', 'Afternoon')), /Shift: “Afternoon” is not in the “Shifts” list/), 'a list value typed by hand (paste goes past Excel’s validation): named, with the list');
    ok(await rowProblem('positions', await edited(posFile.contentBase64, (b) => b.set(at(b), 'Reports to', `${TAG}-CLOSED`)), /not in the “Positions” list/), 'a closed position typed into "Reports to": not in the list');
    ok(await rowProblem('positions', await edited(posFile.contentBase64, (b) => b.set(at(b), 'Status', { formula: '"ACT"&"IVE"', result: 'ACTIVE' })), /Status holds a formula/), 'a formula: not evaluated, and its cached result is not taken either');
    ok(await rowProblem('positions', await edited(posFile.contentBase64, (b) => b.set(at(b), 'Status', '=CONCAT("ACT","IVE")')), /holds a formula/), 'a text that starts with "="');
    ok(await rowProblem('positions', await edited(posFile.contentBase64, (b) => b.set(at(b), 'Role', null)), /Role is required/), 'a required cell emptied');
    ok(await rowProblem('positions', await edited(posFile.contentBase64, (b) => b.set(at(b), 'Reports to', `${TAG}-VAC2`)), /cannot report to itself/), 'a position reporting to itself');
    const loop = await edited(posFile.contentBase64, (b) => { b.set(b.find('Code', `${TAG}-HEAD`), 'Reports to', `${TAG}-SUB`); });
    ok(await rowProblem('positions', loop, /would make a loop/), '"Reports to" that closes a loop (the head under one of its own team): refused');
    const loop2 = await edited(posFile.contentBase64, (b) => { b.set(b.find('Code', `${TAG}-VAC2`), 'Reports to', `${TAG}-HIRE`); b.set(b.find('Code', `${TAG}-HIRE`), 'Reports to', `${TAG}-VAC2`); });
    ok(await rowProblem('positions', loop2, /would make a loop/, { rows: 2 }), 'a loop made by two rows of the same file: both refused');

    const deptFile = await download(O, 'departments', `?q=${TAG}`);
    const dAt = (b, name) => b.find('Code', `${TAG}${name}`);
    ok(await rowProblem('departments', await edited(deptFile.contentBase64, (b) => b.set(dAt(b, 'ROOT'), 'Under', `${TAG}SUB`)), /inside itself/), 'a department put under its own sub-department: "would put the department inside itself"');
    ok(await rowProblem('departments', await edited(deptFile.contentBase64, (b) => { b.set(dAt(b, 'ROOT'), 'Under', `${TAG}OTHER`); b.set(dAt(b, 'OTHER'), 'Under', `${TAG}ROOT`); }), /inside itself/, { rows: 2 }), 'a cycle made by two rows of the file');
    ok(await rowProblem('departments', await edited(deptFile.contentBase64, (b) => b.set(dAt(b, 'OTHER'), 'Under', `${TAG}OTHER`)), /cannot be under itself/), 'a department under itself');
    ok(await rowProblem('departments', await edited(deptFile.contentBase64, (b) => b.set(dAt(b, 'OTHER'), 'Label', 'Machine / area')), /Label: “Machine \/ area” is not in the “Labels” list/), 'a label that is not in the company’s list');
    ok(await rowProblem('departments', await edited(deptFile.contentBase64, (b) => b.set(dAt(b, 'OTHER'), 'Serves', `${TAG}ROOT`)), /only a shared department serves others/), 'Serves on a department that is not shared');
    ok(await rowProblem('departments', await edited(deptFile.contentBase64, (b) => { b.set(dAt(b, 'OTHER'), 'Shared', 'Yes'); b.set(dAt(b, 'OTHER'), 'Serves', `${TAG}ROOT, NOPE-1`); }), /“NOPE-1” is not the code of a department/), 'Serves naming a code that is no department');
    const twoNew = await edited(deptFile.contentBase64, (b) => { b.append({ Name: `${TAG} Parent new`, Label: 'Section' }); b.append({ Name: `${TAG} Child new`, Label: 'Section', Under: `${TAG} Parent new` }); });
    const pTwo = await preview(O, 'departments', twoNew);
    ok(pTwo.json.summary.add === 1 && pTwo.json.summary.problems === 1 && /Under: “.*Parent new” is not in the “Departments” list/.test(problemsOf(pTwo)),
      'a new department under another NEW department of the same file: refused plainly (a new row has no code to be pointed at) — the first is an ADD, the second a problem', problemsOf(pTwo));
    ok(await rowProblem('departments', await edited(deptFile.contentBase64, (b) => b.set(dAt(b, 'OTHER'), 'Name', 'x'.repeat(201))), /Name is 201 characters long; it can be up to 200/), 'text longer than the column holds: said, with both numbers');
    const spaces = await preview(O, 'departments', await edited(deptFile.contentBase64, (b) => { b.set(dAt(b, 'OTHER'), 'Name', `  ${TAG} OTHER   `); b.set(dAt(b, 'OTHER'), 'Label', ' department '); b.set(dAt(b, 'OTHER'), 'Shared', 'no'); }));
    ok(spaces.json.summary.same === deptFile.rows && spaces.json.summary.problems === 0, 'trailing spaces, and a list value in other capitals, are the same value: SAME', JSON.stringify(spaces.json.summary));

    const empFile = await download(O, 'employees', `?department=${D.root}`);
    const eAt = (b) => b.find('Code', `${TAG}IN`);
    ok(await rowProblem('employees', await edited(empFile.contentBase64, (b) => b.set(eAt(b), 'Date of joining', '12/10/2026')), /cannot be read as one for certain.*year-month-day: 2026-10-12/), 'a date typed as text, 12/10/2026: refused — day or month? — and told how to write it');
    ok(await rowProblem('employees', await edited(empFile.contentBase64, (b) => b.set(eAt(b), 'Date of joining', '2026-02-30')), /cannot be read as one for certain/), 'a date that does not exist (2026-02-30)');
    // (A copy of the style: exceljs shares one style object between the cells of a column.)
    ok(await rowProblem('employees', await edited(empFile.contentBase64, (b) => { const cell = b.ws.getCell(eAt(b), b.col('Date of joining')); cell.style = { ...cell.style, numFmt: '0' }; cell.value = 46000; }), /“46000” cannot be read as one for certain/), 'a bare number in a cell that is no longer a date cell');
    const isoDate = await preview(O, 'employees', await edited(empFile.contentBase64, (b) => b.set(eAt(b), 'Date of joining', '2026-01-01')));
    const realDate = await preview(O, 'employees', await edited(empFile.contentBase64, (b) => b.set(eAt(b), 'Date of joining', new Date(Date.UTC(2026, 1, 3)))));
    ok(isoDate.json.summary.same === empFile.rows && realDate.json.summary.change === 1 && realDate.json.rows.find((r) => r.action === 'CHANGE').changes[0].to === '2026-02-03',
      'year-month-day as text is read (the same date: SAME); a real Excel date is read (a CHANGE to 2026-02-03)');
    ok(await rowProblem('employees', await edited(empFile.contentBase64, (b) => b.set(eAt(b), 'Email', 'not an email')), /does not look like an email/), 'an email that is not one');
    ok(await rowProblem('employees', await edited(empFile.contentBase64, (b) => b.set(eAt(b), 'Name', null)), /Name is required/), 'an employee’s name emptied');

    const shiftFile = await download(O, 'shifts', `?q=${TAG}`);
    const sAt = (b) => b.find('Code', `${TAG}S`);
    const asText = await preview(O, 'shifts', await edited(shiftFile.contentBase64, (b) => b.set(sAt(b), 'Tuesday break minutes', '45')));
    ok(asText.json.summary.change === 1 && asText.json.summary.problems === 0 && asText.json.rows.find((r) => r.action === 'CHANGE').changes[0].to === '45', 'a number stored as text ("45") is read as the number');
    ok(await rowProblem('shifts', await edited(shiftFile.contentBase64, (b) => b.set(sAt(b), 'Tuesday break minutes', 'half an hour')), /is a number, and “half an hour” is not one/), 'words in a number cell');
    ok(await rowProblem('shifts', await edited(shiftFile.contentBase64, (b) => b.set(sAt(b), 'Tuesday start', '8 am')), /is a time as HH:MM/), 'a time that is not HH:MM');
    const timeCell = await preview(O, 'shifts', await edited(shiftFile.contentBase64, (b) => b.set(sAt(b), 'Tuesday start', new Date(Date.UTC(1899, 11, 30, 7, 30)))));
    ok(timeCell.json.summary.change === 1 && timeCell.json.rows.find((r) => r.action === 'CHANGE').changes[0].to === '07:30', 'an Excel time cell is read as 07:30');
    ok(await rowProblem('shifts', await edited(shiftFile.contentBase64, (b) => b.set(sAt(b), 'Sunday start', '09:00')), /Sunday: it is not a working day/), 'times on a day that is not worked');
    ok(await rowProblem('shifts', await edited(shiftFile.contentBase64, (b) => b.set(sAt(b), 'Monday working', 'maybe')), /is Yes or No, and “maybe” is neither/), 'a yes/no cell that is neither');

    const holFile = await download(O, 'holidays', `?calendar=${calendar.id}`);
    ok(await rowProblem('holidays', await edited(holFile.contentBase64, (b) => b.append({ Calendar: `${TAG} Calendar`, Date: '2027-01-26', Name: `${TAG} Again` })), /already a holiday in the/), 'a second holiday on a date the calendar already has');
    ok(await rowProblem('holidays', await edited(holFile.contentBase64, (b) => b.append({ Calendar: 'No such calendar', Date: '2027-03-01', Name: `${TAG} X` })), /not in the “Holiday calendars” list/), 'a holiday in a calendar that does not exist');
    const roleFile = await download(O, 'roles', `?q=${TAG}`);
    ok(await rowProblem('roles', await edited(roleFile.contentBase64, (b) => b.append({ Title: `${TAG} operator` })), /already exists\. One title is one role/), 'a new role whose title already exists (in other capitals)');
    ok(await rowProblem('roles', await edited(roleFile.contentBase64, (b) => b.set(b.find('Title', `${TAG} Operator`), 'Status', 'RETIRED')), /retired on the Roles screen/), 'retiring a role through the file: refused — uploading never removes');

    // a record changed in the app since the download
    await db.query('UPDATE hrms_positions SET position_title = ?, updated_at = NOW() + INTERVAL 2 SECOND WHERE id = ?', [`${TAG} retitled meanwhile`, P.vac2]);
    ok(await rowProblem('positions', await edited(posFile.contentBase64, (b) => b.set(at(b), 'Status', 'FROZEN')), /changed in the app since this file was downloaded — download again/), 'a record changed in the app since the download: refused, never silently overwritten');
    const stillSame = await preview(O, 'positions', posFile.contentBase64);
    ok(stillSame.json.summary.problems === 1 && stillSame.json.summary.same === posFile.rows - 1, '…and only that row; the rest of the file is still read');
    await db.query('UPDATE hrms_positions SET updated_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?', [P.vac2]);
  }

  /* ══ 6. apply ═════════════════════════════════════════════════════════════ */
  section('[6] Apply: stale previews, problems, all or nothing, never removes');
  {
    const file = await download(O, 'positions', `?department=${D.root}`);
    const at = (b, code) => b.find('Code', `${TAG}-${code}`);
    const good = await edited(file.contentBase64, (b) => b.set(at(b, 'HIRE'), 'Status', 'FROZEN'));
    const stale = await apply(O, 'positions', good, { add: 0, change: 2 });
    const stale2 = await apply(O, 'positions', good, {});
    ok(stale.status === 409 && stale.json.code === 'PREVIEW_STALE' && stale.json.detail.summary.change === 1 && stale2.status === 409 && (await one('SELECT status FROM hrms_positions WHERE id = ?', [P.hire])).status === 'ACTIVE',
      'apply with counts that are not what the file gives: 409 PREVIEW_STALE, with the real counts, nothing written', `${stale.status} ${stale.json?.code}`);
    const mixed = await edited(file.contentBase64, (b) => { b.set(at(b, 'HIRE'), 'Status', 'FROZEN'); b.set(at(b, 'VAC2'), 'Shift', 'Nonsense'); });
    const pm = await preview(O, 'positions', mixed);
    const refused = await apply(O, 'positions', mixed, { add: 0, change: 1 });
    ok(pm.json.summary.change === 1 && pm.json.summary.problems === 1 && refused.status === 422 && refused.json.code === 'HAS_PROBLEMS' && /^Row \d+: Shift/.test(refused.json.problems[0]) && (await one('SELECT status FROM hrms_positions WHERE id = ?', [P.hire])).status === 'ACTIVE',
      'a file with a problem row: 422 HAS_PROBLEMS naming the row, and the good row is NOT applied either');
    const skippedApply = await apply(O, 'positions', mixed, { add: 0, change: 1 }, { skipProblemRows: true });
    ok(skippedApply.status === 200 && skippedApply.json.changed === 1 && skippedApply.json.skipped === 1 && skippedApply.json.added === 0 && (await one('SELECT status FROM hrms_positions WHERE id = ?', [P.hire])).status === 'FROZEN'
      && (await one('SELECT default_shift_id FROM hrms_positions WHERE id = ?', [P.vac2])).default_shift_id !== null,
    'with skipProblemRows: the good row is applied, the problem row is skipped and counted — { changed: 1, skipped: 1 }', JSON.stringify(skippedApply.json));

    // a rule only the service knows: a break as long as the working day
    const sFile = await download(O, 'shifts', `?q=${TAG}`);
    const bad = await edited(sFile.contentBase64, (b) => { b.set(b.find('Code', `${TAG}S`), 'Name', `${TAG} Shift renamed`); b.set(b.find('Code', `${TAG}N`), 'Monday break minutes', 600); });
    const pb = await preview(O, 'shifts', bad);
    const failedApply = await apply(O, 'shifts', bad, { add: 0, change: 2 });
    ok(pb.json.summary.change === 2 && pb.json.summary.problems === 0 && failedApply.status === 422 && failedApply.json.code === 'APPLY_FAILED' && /^Row \d+ \(.*\): .*break.*Nothing of this file was saved\.$/.test(failedApply.json.message)
      && (await one('SELECT name FROM hrms_shifts WHERE id = ?', [shift.id])).name === `${TAG} Shift`,
    'a row the service refuses in the middle of an apply: 422 APPLY_FAILED naming the row — and the row applied before it is rolled back with it (all or nothing)', `${failedApply.status} ${failedApply.json?.message}`);

    // never removes
    const fresh = await download(O, 'positions', `?department=${D.root}`);
    const fewer = await edited(fresh.contentBase64, (b) => { const r = at(b, 'SUB'); for (let col = 1; col <= b.ws.columnCount; col += 1) b.ws.getCell(r, col).value = null; });
    const pf = await preview(O, 'positions', fewer);
    const af = await apply(O, 'positions', fewer, { add: pf.json.summary.add, change: pf.json.summary.change });
    ok(pf.json.summary.same + pf.json.summary.change === fresh.rows - 1 && pf.json.summary.problems === 0 && af.status === 200
      && (await one('SELECT deleted_at, status FROM hrms_positions WHERE id = ?', [P.sub])).deleted_at === null && (await one('SELECT status FROM hrms_positions WHERE id = ?', [P.sub])).status === 'ACTIVE',
    'a record taken out of the file is not looked at: an upload never removes');
    const emptyFile = await preview(O, 'positions', (await download(O, 'positions', '?blank=1')).contentBase64);
    ok(emptyFile.json.rows.length === 0 && emptyFile.json.fileProblems.length === 0 && Number((await one('SELECT COUNT(*) AS n FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL AND position_code LIKE ?', [COMPANY, `${TAG}-%`])).n) === 9,
      'a blank file uploaded changes nothing and removes nothing');
  }

  /* ══ 7. employees ═════════════════════════════════════════════════════════ */
  section('[7] Employees: the bulk-add right, contact, the position rules');
  {
    const uploader = await login('Uploader', await customRole('Uploader', [PERM.employees.view, PERM.employees.edit, PERM.employees.upload, PERM.contactView]));
    const noContact = await login('No contact', await customRole('No contact', [PERM.employees.view, PERM.employees.edit, PERM.employees.upload, PERM.employeeBulkAdd]));
    forgetAccess();
    const file = await download(uploader, 'employees', `?department=${D.root}`);
    const withNew = await edited(file.contentBase64, (b) => b.append({ Name: `${TAG} Sneaked in`, 'Date of joining': '2026-10-01' }));
    const refused = await preview(uploader, 'employees', withNew);
    ok(refused.status === 200 && refused.json.fileProblems.length === 1 && /adds 1 employee.*skips the hiring steps.*“Add employees from Excel”.*Owner or an HR manager/.test(refused.json.fileProblems[0]),
      'a file with a new row from somebody WITHOUT the bulk-add right: refused whole, saying who can do it', refused.json?.fileProblems?.[0]);
    const refusedApply = await apply(uploader, 'employees', withNew, { add: 1, change: 0 });
    ok(refusedApply.status === 422 && refusedApply.json.code === 'FILE_PROBLEM' && Number((await one('SELECT COUNT(*) AS n FROM hrms_employees WHERE full_name = ?', [`${TAG} Sneaked in`])).n) === 0, '…and apply refuses it too (422 FILE_PROBLEM): nobody is created');
    const onlyChange = await edited(file.contentBase64, (b) => b.set(b.find('Code', `${TAG}SUB`), 'Phone', '9444444444'));
    const okApply = await apply(uploader, 'employees', onlyChange, { add: 0, change: 1 });
    ok(okApply.status === 200 && okApply.json.changed === 1 && (await one('SELECT phone FROM hrms_employees WHERE id = ?', [E.sub])).phone === '9444444444', 'the same login may upload CHANGES to people who exist');

    const hidden = await download(noContact, 'employees', `?department=${D.root}`);
    const hb = await open(hidden.contentBase64);
    ok(JSON.stringify([...hb.head.keys()].slice(2)) === JSON.stringify(['Code', 'Salutation', 'Name', 'Gender', 'Date of joining', 'Employment type', 'Status', 'Position', 'Label']) && !Buffer.from(hidden.contentBase64, 'base64').includes(Buffer.from('9100000001')),
      'without contact access the file has NO date of birth, phone, email or address columns — and no phone number anywhere in it', [...hb.head.keys()].join(', '));
    const renamed = await edited(hidden.contentBase64, (b) => { b.set(b.find('Code', `${TAG}HEAD`), 'Name', `${TAG} Person HEAD renamed`); b.append({ Name: `${TAG} Added without contact`, 'Date of joining': '2026-10-02' }); });
    const hiddenApply = await apply(noContact, 'employees', renamed, { add: 1, change: 1 });
    const headRow = await one('SELECT full_name, phone, email, date_of_birth, address_json FROM hrms_employees WHERE id = ?', [E.head]);
    ok(hiddenApply.status === 200 && headRow.full_name === `${TAG} Person HEAD renamed` && headRow.phone === '9100000001' && headRow.email && headRow.date_of_birth !== null && /HEAD Street/.test(JSON.stringify(headRow.address_json)),
      'its upload changes the name and leaves the contact details exactly as they were', `${hiddenApply.status} ${JSON.stringify(hiddenApply.json).slice(0, 200)}`);
    // a file WITH contact columns, uploaded by somebody who may not see them: the columns are simply not read
    const full = await download(O, 'employees', `?department=${D.root}`);
    const sneaky = await edited(full.contentBase64, (b) => b.set(b.find('Code', `${TAG}IN`), 'Phone', '9555555555'));
    const ps = await preview(noContact, 'employees', sneaky);
    ok(ps.json.summary.change === 0 && ps.json.summary.problems === 0, 'somebody else’s file, with a phone changed, uploaded by a login without contact access: the phone column is not read at all', JSON.stringify(ps.json.summary));

    // the position rules, for the Owner
    await HIRE.startHiring(db, c, P.hire);
    await db.query("UPDATE hrms_positions SET status = 'ACTIVE' WHERE id = ?", [P.hire]);
    const base2 = await download(O, 'employees', `?department=${D.root}`);
    const tryRows = async (rows) => preview(O, 'employees', await edited(base2.contentBase64, (b) => { for (const r of rows) b.append({ 'Date of joining': '2026-10-05', ...r }); }));
    const cases = await tryRows([
      { Name: `${TAG} A`, Position: `${TAG}-IN` }, { Name: `${TAG} B`, Position: `${TAG}-HIRE` }, { Name: `${TAG} C`, Position: `${TAG}-CLOSED` }, { Name: `${TAG} D`, Position: 'P-NOWHERE' },
      { Name: `${TAG} E`, Position: `${TAG}-VAC2` }, { Name: `${TAG} F`, Position: `${TAG}-VAC2 — whatever` }, { Name: `${TAG} G` }, { Name: `${TAG} H`, 'Employment type': 'CONTRACT' },
    ]);
    const said = (name) => cases.json.rows.find((r) => r.label === `${TAG} ${name}`);
    ok(/is not vacant — somebody is in it/.test(said('A').problems[0]) && /a hiring is open for/.test(said('B').problems[0]) && /is closed/.test(said('C').problems[0]) && /is not a position of this company/.test(said('D').problems[0]),
      'a new person’s position: filled → "not vacant"; with an open hiring → "a hiring is open"; closed → "is closed"; unknown → "is not a position of this company"', cases.json.rows.filter((r) => r.problems.length).map((r) => r.problems[0]).join(' | ').slice(0, 300));
    ok(/is named on 2 rows/.test(said('E').problems[0]) && /is named on 2 rows/.test(said('F').problems[0]) && said('G').action === 'ADD' && /contract worker is added on the Employees screen/.test(said('H').problems[0]),
      'the same vacant position on two rows: both refused ("a position is for one person"); no position at all is fine; a contract worker is not added here');
    const lists = (await open(base2.contentBase64)).wb.getWorksheet('Lists');
    const vacantList = []; lists.eachRow((r) => r.eachCell((cell) => vacantList.push(String(cell.value))));
    ok(vacantList.some((x) => x.startsWith(`${TAG}-VAC2 — `)) && !vacantList.some((x) => x.startsWith(`${TAG}-IN — `) || x.startsWith(`${TAG}-HIRE — `) || x.startsWith(`${TAG}-CLOSED — `)),
      'the file’s "Vacant positions" list offers only positions that are vacant, not closed and not being hired for');

    // joining in the future: as a hiring's last step does it
    const future = plusDays(20);
    const fFile = await edited(base2.contentBase64, (b) => b.append({ Name: `${TAG} Joins later`, 'Date of joining': future, Position: `${TAG}-VAC2` }));
    const fa = await apply(O, 'employees', fFile, { add: 1, change: 0 });
    const joiner = await one('SELECT id, employment_status FROM hrms_employees WHERE full_name = ?', [`${TAG} Joins later`]);
    const fwa = joiner ? await one('SELECT status, effective_from FROM hrms_work_assignments WHERE employee_id = ?', [joiner.id]) : null;
    const seatNow = (await call(O, 'GET', `/positions/${P.vac2}`)).json.position;
    ok(fa.status === 200 && joiner?.employment_status === 'ACTIVE' && fwa?.status === 'ACTIVE' && dayText(new Date(fwa.effective_from)) === future && seatNow.occupant === null && seatNow.joining?.employeeId === joiner.id,
      'a joining date in the future: the person is added, and the position shows them as joining on that date — vacant until then, as after a hiring', `${fa.status} ${JSON.stringify(fa.json).slice(0, 160)}`);
    const taken = await tryRows([{ Name: `${TAG} Too late`, Position: `${TAG}-VAC2` }]);
    ok(/is not vacant — somebody is in it, or is due to join it/.test(taken.json.rows.find((r) => r.label === `${TAG} Too late`).problems[0]), 'and that position is no longer offered to anybody else');
  }

  /* ══ 8. rights and scope ══════════════════════════════════════════════════ */
  section('[8] Rights and scope');
  {
    const exec = U.HR_EXECUTIVE; // view everywhere, no upload
    const file = await call(exec, 'GET', `/excel/positions/workbook?department=${D.root}`);
    const up = await preview(exec, 'positions', file.json?.contentBase64 ?? '');
    const ap = await apply(exec, 'positions', file.json?.contentBase64 ?? '', { add: 0, change: 0 });
    const ents = (await call(exec, 'GET', '/excel/entities')).json;
    ok(file.status === 200 && up.status === 403 && up.json.code === 'FORBIDDEN' && ap.status === 403 && ents.every((e) => e.canUpload === false)
      // performance view reaches a ready-made role through setup-access (LATE_AREAS), which this test does not run
      // (and payroll, spec §25, the same way)
      && ents.filter((e) => e.area !== 'performance' && e.area !== 'payroll').every((e) => e.canDownload === true),
      'view is enough to DOWNLOAD and not to upload: an HR executive gets the file, and 403 on preview and apply', `${file.status} ${up.status} ${ap.status}`);
    const wrong = [];
    for (const def of ENTITIES) {
      for (const [method, url] of [['GET', `/excel/${def.entity}/workbook`], ['POST', `/excel/${def.entity}/preview`], ['POST', `/excel/${def.entity}/apply`]]) {
        const employee = await call(U.DEPARTMENT_HEAD, method, url, method === 'POST' ? { fileName: 'x.xlsx', contentBase64: '' } : undefined);
        // A Department head views org, roles, positions, employees, time, leave: downloads those; uploads nothing.
        const expectDownload = ['departments', 'locations', 'roles', 'positions', 'employees', 'holidays', 'shifts', 'leave-balances'].includes(def.entity) || def.entity.startsWith('library-');
        if (method === 'GET' ? (employee.status === 200) !== expectDownload : employee.status !== 403) wrong.push(`${method} ${url} ${employee.status}`);
      }
    }
    ok(wrong.length === 0, `each of the ${ENTITIES.length * 3} Excel routes asks for its own area: a Department head downloads what it may view, and uploads nothing (403)`, wrong.join('; '));
    ok((await call(null, 'GET', '/excel/positions/workbook')).status === 401 && (await call(null, 'POST', '/excel/positions/apply', {})).status === 401, 'no token: 401');
    const manager = await preview(U.HR_MANAGER, 'positions', file.json.contentBase64);
    ok(manager.status === 200 && manager.json.summary.problems === 0, 'an HR manager (upload on every area) previews the file');

    // scope
    const headFile = await download(U.DEPARTMENT_HEAD, 'positions');
    const headBook = await open(headFile.contentBase64);
    const codes = []; for (let r = 2; r <= headBook.rows() + 1; r += 1) codes.push(headBook.get(r, 'Code'));
    const headEmp = await open((await download(U.DEPARTMENT_HEAD, 'employees')).contentBase64);
    const empCodes = []; for (let r = 2; r <= headEmp.rows() + 1; r += 1) empCodes.push(headEmp.get(r, 'Code'));
    ok(codes.length >= 6 && codes.includes(`${TAG}-SUB`) && !codes.includes(`${TAG}-OUT`) && !codes.includes(`${TAG}-VACOUT`) && empCodes.includes(`${TAG}IN`) && !empCodes.includes(`${TAG}OUT`)
      && codes.length === Number((await one("SELECT COUNT(*) AS n FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL AND status <> 'CLOSED' AND department_id IN (?, ?)", [COMPANY, D.root, D.sub])).n),
    'a department-scoped login’s download holds only its department and below — positions and people', `${codes.length} positions, ${empCodes.length} people`);
    const scoped = await login('Scoped uploader', await customRole('Scoped uploader', [PERM.positions.view, PERM.positions.edit, PERM.positions.upload, PERM.org.view, PERM.org.upload, PERM.employees.view, PERM.employees.upload, PERM.employeeBulkAdd, PERM.contactView, PERM.time.view, PERM.time.upload], 'DEPARTMENT'));
    await db.query('UPDATE hrms_employees SET user_id = ? WHERE id = ?', [scoped.id, E.in]);
    forgetAccess();
    const mine = await download(scoped, 'positions');
    const inScopeChange = await edited(mine.contentBase64, (b) => b.set(b.find('Code', `${TAG}-SUB`), 'Status', 'FROZEN'));
    ok((await preview(scoped, 'positions', inScopeChange)).json.summary.change === 1, 'inside its scope a scoped login’s upload is read as a change');
    const moveOut = await preview(scoped, 'positions', await edited(mine.contentBase64, (b) => b.set(b.find('Code', `${TAG}-SUB`), 'Department', `${TAG}OTHER`)));
    const ownerFile = await download(O, 'positions', `?q=${TAG}`);
    const outside = await preview(scoped, 'positions', await edited(ownerFile.contentBase64, (b) => b.set(b.find('Code', `${TAG}-OUT`), 'Status', 'FROZEN')));
    const newOutside = await preview(scoped, 'positions', await edited(mine.contentBase64, (b) => b.append({ Role: `${TAG}R`, Department: `${TAG}OTHER`, Shift: S1.code })));
    ok(/Department: choose a department inside your own/.test(problemsOf(moveOut)) && /outside your department/.test(problemsOf(outside)) && outside.json.rows.filter((r) => r.action === 'PROBLEM').length >= 2 && /inside your own/.test(problemsOf(newOutside)),
      'a row outside it is a problem: moving a position out, changing a position that is outside (somebody else’s file), adding one outside', `${problemsOf(moveOut)} | ${problemsOf(newOutside)}`.slice(0, 300));
    const deptMine = await download(scoped, 'departments');
    const dTop = await preview(scoped, 'departments', await edited(deptMine.contentBase64, (b) => b.set(b.find('Code', `${TAG}ROOT`), 'Name', `${TAG} ROOT x`)));
    const dNewTop = await preview(scoped, 'departments', await edited(deptMine.contentBase64, (b) => b.append({ Name: `${TAG} At the top`, Label: 'Section' })));
    const dNewIn = await preview(scoped, 'departments', await edited(deptMine.contentBase64, (b) => b.append({ Name: `${TAG} Inside`, Label: 'Section', Under: `${TAG}SUB` })));
    ok(/This is your own department/.test(problemsOf(dTop)) && /choose a department inside your own/.test(problemsOf(dNewTop)) && dNewIn.json.summary.add === 1 && dNewIn.json.summary.problems === 0 && deptMine.rows === 3,
      'departments: its own top department cannot be changed, nothing can be added at the top, a department inside can', `${problemsOf(dTop)} | ${problemsOf(dNewTop)}`.slice(0, 300));
    const wholeDownload = await call(scoped, 'GET', '/excel/shifts/workbook');
    const wholeUpload = await preview(scoped, 'shifts', wholeDownload.json?.contentBase64 ?? '');
    ok(wholeDownload.status === 200 && wholeUpload.status === 403 && wholeUpload.json.code === 'OUT_OF_SCOPE' && /belong to the whole company/.test(wholeUpload.json.message)
      && (await call(scoped, 'GET', '/excel/entities')).json.find((e) => e.entity === 'shifts').canUpload === false && (await call(scoped, 'GET', '/excel/entities')).json.find((e) => e.entity === 'positions').canUpload === true,
    'what belongs to no department (shifts, holidays, locations, roles, libraries) a scoped login downloads but cannot upload: 403 OUT_OF_SCOPE — and /excel/entities says so');
    const empMine = await download(scoped, 'employees');
    const eOut = await preview(scoped, 'employees', await edited(empMine.contentBase64, (b) => b.append({ Name: `${TAG} Out`, 'Date of joining': '2026-10-01', Position: `${TAG}-VACOUT` })));
    const eNone = await preview(scoped, 'employees', await edited(empMine.contentBase64, (b) => b.append({ Name: `${TAG} Nowhere`, 'Date of joining': '2026-10-01' })));
    ok(/is not a position of this company|outside your department/.test(problemsOf(eOut)) && /a new person is added to a position inside your department/.test(problemsOf(eNone)),
      'a scoped login adds people only into vacant positions of its own department', `${problemsOf(eOut)} | ${problemsOf(eNone)}`.slice(0, 300));
  }

  /* ══ 9. round trips ═══════════════════════════════════════════════════════ */
  section('[9] Round trips for 200 rows (measured)');
  {
    const N = 200;
    // One file adds a bounded number of rows (see below); lifted here to measure 200.
    const capOf = Object.fromEntries(ENTITIES.map((e) => [e.entity, e.maxAdds]));
    for (const e of ENTITIES) e.maxAdds = 5000;
    const measure = async (fn) => { queries = 0; const t = Date.now(); const out = await fn(); return { out, queries, ms: Date.now() - t }; };
    const report = [];
    // positions
    for (let i = 0; i < N; i += 1) await db.query("INSERT INTO hrms_positions (company_id, position_code, role_id, position_title, department_id, default_shift_id, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', NOW() - INTERVAL 1 MINUTE)", [COMPANY, `${TAG}-B${String(i).padStart(3, '0')}`, hrmsRole, `${TAG} bulk`, D.other, S1.id]);
    const pFile = await download(O, 'positions', `?department=${D.other}`);
    const pChange = await edited(pFile.contentBase64, (b) => { for (let r = 2; r <= b.rows() + 1; r += 1) if (b.get(r, 'Code').startsWith(`${TAG}-B`)) b.set(r, 'Status', 'FROZEN'); });
    const pPrev = await measure(() => preview(O, 'positions', pChange));
    const pApply = await measure(() => apply(O, 'positions', pChange, { add: 0, change: N }));
    ok(pPrev.out.json.summary.change === N && pApply.out.status === 200 && pApply.out.json.changed === N, `positions: ${N} rows changed — preview ${pPrev.queries} queries, apply ${pApply.queries} queries`, `${pApply.out.status} ${JSON.stringify(pApply.out.json).slice(0, 200)}`);
    report.push(['positions', 'change', pPrev.queries, pApply.queries, pApply.ms]);
    const pAdd = await edited((await download(O, 'positions', '?blank=1')).contentBase64, (b) => { for (let i = 0; i < N; i += 1) { b.set(i + 2, 'Role', `${TAG}R`); b.set(i + 2, 'Department', `${TAG}OTHER`); b.set(i + 2, 'Shift', S1.code); b.set(i + 2, 'Reports to', `${TAG}-OUT`); } });
    const pAddPrev = await measure(() => preview(O, 'positions', pAdd));
    const pAddApply = await measure(() => apply(O, 'positions', pAdd, { add: N, change: 0 }));
    ok(pAddPrev.out.json.summary.add === N && pAddApply.out.status === 200 && pAddApply.out.json.added === N && pAddApply.out.json.issuedCodes.length === N && new Set(pAddApply.out.json.issuedCodes.map((x) => x.code)).size === N,
      `positions: ${N} rows added, each with its own code and a reporting line — preview ${pAddPrev.queries} queries, apply ${pAddApply.queries} queries`, `${pAddApply.out.status} ${JSON.stringify(pAddApply.out.json).slice(0, 200)}`);
    report.push(['positions', 'add', pAddPrev.queries, pAddApply.queries, pAddApply.ms]);
    // employees
    for (let i = 0; i < N; i += 1) await db.query("INSERT INTO hrms_employees (company_id, employee_code, full_name, date_of_joining, employment_type, employment_status, updated_at) VALUES (?, ?, ?, '2026-01-01', 'EMPLOYEE', 'ACTIVE', NOW() - INTERVAL 1 MINUTE)", [COMPANY, `${TAG}B${String(i).padStart(3, '0')}`, `${TAG} Bulk ${i}`]);
    const eFile = await download(O, 'employees', `?q=${encodeURIComponent(`${TAG} Bulk`)}&limit=2000`);
    const eChange = await edited(eFile.contentBase64, (b) => { for (let r = 2; r <= b.rows() + 1; r += 1) b.set(r, 'Phone', `93${String(r).padStart(8, '0')}`); });
    const ePrev = await measure(() => preview(O, 'employees', eChange));
    const eApply = await measure(() => apply(O, 'employees', eChange, { add: 0, change: N }));
    ok(eFile.rows === N && ePrev.out.json.summary.change === N && eApply.out.status === 200 && eApply.out.json.changed === N, `employees: ${N} rows changed — preview ${ePrev.queries} queries, apply ${eApply.queries} queries`, `${eFile.rows} ${eApply.out.status} ${JSON.stringify(eApply.out.json).slice(0, 200)}`);
    report.push(['employees', 'change', ePrev.queries, eApply.queries, eApply.ms]);
    const vacantCodes = pAddApply.out.json.issuedCodes.map((x) => x.code);
    const eAdd = await edited((await download(O, 'employees', '?blank=1')).contentBase64, (b) => { for (let i = 0; i < N; i += 1) { b.set(i + 2, 'Name', `${TAG} New ${i}`); b.set(i + 2, 'Date of joining', '2026-10-01'); b.set(i + 2, 'Position', vacantCodes[i]); } });
    const eAddPrev = await measure(() => preview(O, 'employees', eAdd));
    const eAddApply = await measure(() => apply(O, 'employees', eAdd, { add: N, change: 0 }));
    ok(eAddPrev.out.json.summary.add === N && eAddApply.out.status === 200 && eAddApply.out.json.added === N && new Set(eAddApply.out.json.issuedCodes.map((x) => x.code)).size === N,
      `employees: ${N} rows added, each with a code and put in a position — preview ${eAddPrev.queries} queries, apply ${eAddApply.queries} queries`, `${eAddApply.out.status} ${JSON.stringify(eAddApply.out.json).slice(0, 300)}`);
    report.push(['employees', 'add', eAddPrev.queries, eAddApply.queries, eAddApply.ms]);
    // one simple entity, for comparison
    const kAdd = await edited((await download(O, 'library-skills', '?blank=1')).contentBase64, (b) => { for (let i = 0; i < N; i += 1) b.set(i + 2, 'Name', `${TAG} Skill ${i}`); });
    const kApply = await measure(() => apply(O, 'library-skills', kAdd, { add: N, change: 0 }));
    ok(kApply.out.status === 200 && kApply.out.json.added === N, `library-skills: ${N} rows added — apply ${kApply.queries} queries`);
    report.push(['library-skills', 'add', 1, kApply.queries, kApply.ms]);
    console.log('\n  entity            what     preview  apply   per row   local ms');
    for (const [e, w, p, a, ms] of report) console.log(`  ${e.padEnd(17)} ${w.padEnd(8)} ${String(p).padStart(7)} ${String(a).padStart(6)} ${(a / N).toFixed(1).padStart(9)} ${String(ms).padStart(10)}`);
    for (const e of ENTITIES) e.maxAdds = capOf[e.entity];
    const tooMany = await preview(O, 'employees', eAdd);
    const tooManyPositions = await preview(O, 'positions', pAdd);
    ok(fileSays(tooMany, /This file adds 200 employees. Add up to 75 at a time: upload it in parts./) && fileSays(tooManyPositions, /adds 200 positions. Add up to 100 at a time/) && (await apply(O, 'employees', eAdd, { add: N, change: 0 })).status === 422,
      'one file adds a bounded number of new rows — 75 employees, 100 positions — so an apply cannot outlast its request', `${tooMany.json?.fileProblems?.[0]}`);
    const posDef = ENTITIES.find((e) => e.entity === 'positions');
    posDef.maxChanges = 50;
    const manyChanges = await preview(O, 'positions', await edited((await download(O, 'positions', `?department=${D.other}`)).contentBase64, (b) => { for (let r = 2; r <= 80; r += 1) b.set(r, 'Status', 'DRAFT'); }));
    delete posDef.maxChanges;
    ok(fileSays(manyChanges, /This file changes \d+ positions\. Change up to 50 at a time: upload it in parts\./), 'and changes a bounded number too (500 by default; lowered here to see it)', manyChanges.json?.fileProblems?.[0]);
    ok(report.every(([, , p]) => p <= 12), 'a preview costs the same handful of queries whatever the number of rows (every list is read once; the checking is in memory)', report.map((r) => r[2]).join(', '));
  }
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
}

console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped`);
if (skipped.length) for (const s of skipped) console.log(`  skipped — ${s}`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
