/**
 * access_test.mjs — rights. (TM/CF_HRMS_HIRING_SPEC.md §12; 2026-10-12.)
 *
 *   1. the catalogue, and the table of routes: no route without a guard, no
 *      guard naming a right that does not exist, ACCESS.md up to date;
 *   2. the migration: before / after for every role, nobody gains, nobody
 *      loses, exact tenant- and app-scoped grants, no duplicates, re-runnable;
 *   3. THE MATRIX: each ready-made role × a route of every area and right and
 *      every named right, through the real middleware;
 *  3b. copying content: the right a copy needs follows its MODE (SEAT, ROLE,
 *      FORK), refusals write nothing, a write is attributed to its login;
 *   4. a change of rights counts on the very next request, with the same token;
 *   5. scope: a Department head, a scoped login with no employee, a scoped role
 *      that may change departments;
 *   6. pay and contact: what is absent from an answer, what a write does not
 *      take, what cannot be opened;
 *   7. access roles: create, copy, change, invalid sets, LOCKED, IN_USE, and
 *      who may give what;
 *   8. logins: create (the password once, hashed as the platform hashes),
 *      change, disable, enable, reset; the last Owner; yourself;
 *   9. the generic API: closed for the access tables, and no hrms table in it;
 *  10. another company.
 *
 *   node scripts/cf_hrms/access_test.mjs [--company=karni] [--verbose]
 *
 * HOW NOTHING IS LEFT BEHIND. This test needs logins on every ready-made role,
 * and the middleware it tests reads them from the database — so they would have
 * to be committed. Instead the WHOLE process is put on ONE connection inside
 * ONE transaction: `pool.query` and `pool.getConnection` are pointed at it (a
 * transaction a route opens becomes a savepoint), the in-process server and
 * every service run on it, and at the end it is rolled back. No user, role,
 * grant or row made here is ever committed. The end re-reads the counts from a
 * fresh connection.
 *
 * Local only — it refuses a non-local DB_HOST. It prints no password.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import { protect } from '../../core/middleware/authmiddleware.js';
import baseResourceRoute from '../../core/query/baseResourceRoute.js';
import hrmsApp, { DESCRIBED_RESOURCES } from '../../apps/cf_hrms/app.js';
import hrmsRouter from '../../apps/cf_hrms/routes/index.js';
import codegenModule from '../../apps/cf_erp/modules/codegen/index.js';
import { PERM } from '../../apps/cf_hrms/lib/http.js';
import { ALL_TAGS, AREAS, NAMED, TEMPLATES, OLD_TAG_MAP, areaTag, lateAreaTags, mapOldTags, tagSetProblems, summaryOf, catalog } from '../../apps/cf_hrms/lib/access.js';
import { forgetAccess } from '../../apps/cf_hrms/lib/accessContext.js';
import { routeTable, routeTableProblems, renderAccessDoc, PUBLIC_ROUTES } from '../../apps/cf_hrms/lib/routeTable.js';
import { hrmsAppOf, ensureCatalog, tagsOfRoles, setRoleTags, newTagsOf } from '../../apps/cf_hrms/services/accessGrants.js';
import { setupAccess } from '../../apps/cf_hrms/services/accessSetup.js';
import { scopeFor } from '../../apps/cf_hrms/services/accessScope.js';
import * as ACCESS from '../../apps/cf_hrms/services/accessService.js';
import * as HIRE from '../../apps/cf_hrms/services/hiringService.js';
import * as PEOPLE from '../../apps/cf_hrms/services/peopleService.js';
import * as RC from '../../apps/cf_hrms/services/roleContentService.js';
import * as POS from '../../apps/cf_hrms/services/positionService.js';
import { isPayPaper, isIdentityPaper } from '../../apps/cf_hrms/lib/redact.js';

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
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/* ── the state of the world before, from a connection of its own ──────────── */
const TABLES = ['users', 'roles', 'role_capability', 'app_user_access', 'features', 'features_capability', 'hrms_access_roles', 'hrms_employees', 'hrms_positions',
  'hrms_departments', 'hrms_work_assignments', 'hrms_hirings', 'hrms_audit_log', 'hrms_employee_documents', 'cf_code_sequences'];
async function worldCount() {
  const conn = await mysql.createConnection({ host: process.env.DB_HOST ?? 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306 });
  try {
    const out = {};
    for (const t of TABLES) {
      const [[r]] = await conn.query(`SELECT COUNT(*) AS n, COALESCE(SUM(deleted_at IS NULL), 0) AS live FROM ${t}`);
      out[t] = `${r.n}/${r.live}`;
    }
    const [[seq]] = await conn.query("SELECT COALESCE(SUM(next_value), 0) AS s FROM cf_code_sequences");
    out.counters = String(seq.s);
    return out;
  } finally { await conn.end(); }
}
const before = await worldCount();

/* ── everything from here on is ONE transaction on ONE connection ─────────── */
const real = { query: pool.query.bind(pool), execute: pool.execute.bind(pool), getConnection: pool.getConnection.bind(pool) };
const db = await real.getConnection();
await db.beginTransaction();
let depth = 0;
const inside = {
  query: (...a) => db.query(...a),
  execute: (...a) => db.execute(...a),
  beginTransaction: async () => { depth += 1; await db.query(`SAVEPOINT zz_access_${depth}`); },
  commit: async () => { if (depth > 0) { await db.query(`RELEASE SAVEPOINT zz_access_${depth}`); depth -= 1; } },
  rollback: async () => { if (depth > 0) { await db.query(`ROLLBACK TO SAVEPOINT zz_access_${depth}`); depth -= 1; } },
  release: () => {},
};
pool.query = inside.query;
pool.execute = inside.execute;
pool.getConnection = async () => inside;

const TAG = `ZZAC${Date.now().toString(36).toUpperCase().slice(-5)}`;
const q = async (sql, params) => (await db.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0] ?? null;

let server;
try {
  const company = await one('SELECT id, name, slug FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
  if (!company) throw new Error(`No company "${slug}".`);
  const COMPANY = company.id;
  const app = await hrmsAppOf(db, COMPANY);
  const other = await one(
    `SELECT co.id, co.name, co.slug, a.id AS app_id FROM companies co JOIN apps a ON a.company_id = co.id AND a.slug = 'cf_hrms' AND a.deleted_at IS NULL
      WHERE co.id <> ? AND co.deleted_at IS NULL ORDER BY co.id LIMIT 1`, [COMPANY]);
  console.log(`access_test — ${company.name} (${COMPANY}), run tag ${TAG}; the other company with the app is ${other ? `${other.name} (${other.id})` : 'none'}`);

  /* ══ 1. the catalogue and the table of routes ═════════════════════════════ */
  section('[1] The catalogue of rights, and the table of routes');
  {
    ok(ALL_TAGS.length === 49 && new Set(ALL_TAGS).size === 49 && ALL_TAGS.every((t) => /^cf_hrms_[a-z_]+$/.test(t)), 'forty-nine rights: twelve areas × their rights (performance since §18, payroll since §25, attendance since §28), and seven named', `${ALL_TAGS.length}`);
    const grid = Object.fromEntries(AREAS.map((a) => [a.key, a.rights.join(' ')]));
    ok(JSON.stringify(grid) === JSON.stringify({
      org: 'view edit remove upload', roles: 'view edit remove upload', positions: 'view edit remove upload', employees: 'view edit upload', hiring: 'view edit',
      documents: 'view edit remove', time: 'view edit remove upload', leave: 'view edit remove', setup: 'view edit remove', performance: 'view edit remove upload',
      payroll: 'view edit remove upload', attendance: 'view edit remove upload',
    }), 'the areas hold exactly the rights of the table (a dash is a right that does not exist)', JSON.stringify(grid));
    ok(JSON.stringify(NAMED.map((n) => n.tag)) === JSON.stringify(['cf_hrms_employee_create', 'cf_hrms_employee_close', 'cf_hrms_employee_bulk_add', 'cf_hrms_contact_view', 'cf_hrms_pay_view', 'cf_hrms_access_manage', 'cf_hrms_self_view'])
      && PERM.positions.edit === 'cf_hrms_positions_edit' && PERM.payView === 'cf_hrms_pay_view' && PERM.hiring.remove === undefined && PERM.employees.remove === undefined,
    'the named rights; PERM is built from the same list, and a right that does not exist is not a property');
    const tpl = Object.fromEntries(TEMPLATES.map((t) => [t.key, t]));
    const view = (k) => areaTag(k, 'view');
    ok(same(tpl.OWNER.tags, ALL_TAGS) && same(tpl.HR_MANAGER.tags, ALL_TAGS.filter((t) => t !== PERM.accessManage))
      && same(tpl.HR_EXECUTIVE.tags, [...AREAS.map((a) => view(a.key)), PERM.employees.edit, PERM.hiring.edit, PERM.positions.edit, PERM.documents.edit, PERM.performance.edit, PERM.payroll.edit, PERM.attendance.edit, PERM.employeeCreate, PERM.contactView, PERM.payView, PERM.selfView])
      && same(tpl.DEPARTMENT_HEAD.tags, [view('org'), view('roles'), view('positions'), view('employees'), view('time'), view('leave'), view('performance'), view('attendance'), PERM.positions.edit, PERM.performance.edit, PERM.contactView, PERM.selfView])
      && same(tpl.EMPLOYEE.tags, [PERM.selfView]) && tpl.DEPARTMENT_HEAD.scope === 'DEPARTMENT' && tpl.HR_MANAGER.scope === 'COMPANY' && tpl.OWNER.platformName === 'admin',
    'the five ready-made roles hold exactly what the spec gives them');
    ok(TEMPLATES.every((t) => tagSetProblems(t.tags).length === 0), 'every ready-made set is one a role may be saved with');
    ok(tagSetProblems([PERM.positions.edit]).length === 1 && /Positions/.test(tagSetProblems([PERM.positions.edit])[0]) && /view/.test(tagSetProblems([PERM.positions.edit])[0])
      && tagSetProblems(['cf_hrms_org_manage']).length === 1 && tagSetProblems('x').length === 1 && tagSetProblems([PERM.positions.view, PERM.positions.remove, PERM.payView]).length === 0,
    'edit, remove or upload without view is refused in words; so is a tag that is not a right (an old tag included)');
    ok(summaryOf(tpl.HR_EXECUTIVE.tags) === 'Sees everything · changes positions, employees, hiring, documents, performance, payroll and attendance · cannot remove · creates employees and sees pay'
      && summaryOf(tpl.EMPLOYEE.tags) === 'Sees their own place only' && summaryOf(tpl.OWNER.tags) === 'Sees everything · changes everything · can remove · creates employees, closes employees, sees pay and manages logins and access'
      && summaryOf([]) === 'Sees nothing', 'the sentence on a role’s card is written by the server', summaryOf(tpl.HR_EXECUTIVE.tags));
    const cat = catalog();
    ok(JSON.stringify(Object.keys(cat)) === JSON.stringify(['areas', 'named', 'templates']) && cat.areas.length === 12 && cat.areas[3].rights.map((r) => r.right).join(' ') === 'view edit upload'
      && cat.areas.every((a) => a.label && a.screens.length && a.rights.every((r) => r.tag && r.label)) && cat.named.every((n) => n.label && n.hint && n.sensitive === (n.tag !== PERM.selfView)) && JSON.stringify(cat.templates.map((x) => x.key)) === JSON.stringify(['HR_MANAGER', 'HR_EXECUTIVE', 'DEPARTMENT_HEAD']),
    'GET /access/catalog -> { areas, named: [{ tag, label, hint, sensitive }], templates }: every named right but the self view is sensitive; the roles to start from are the three that can be copied — not the Owner, not Employee');

    const rows = routeTable(hrmsRouter);
    const problems = routeTableProblems(rows);
    ok(problems.length === 0, `no route without a guard, no guard naming a right that does not exist (${rows.length} routes)`, problems.slice(0, 5).join(' | '));
    ok(rows.length > 200 && rows.filter((r) => !r.guard).map((r) => `${r.method} ${r.path}`).join() === Object.keys(PUBLIC_ROUTES).join(), 'the only open route is GET /health');
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/cf_hrms/ACCESS.md');
    const onDisk = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
    ok(onDisk === renderAccessDoc(rows), 'apps/cf_hrms/ACCESS.md is what the routers say (run apps/cf_hrms/scripts/make-access-doc.mjs after changing a guard)');
    // A guard nobody declared is caught: a router with a bare route, and one with a made-up tag.
    const bare = express.Router();
    bare.get('/x', (req, res) => res.json({}));
    const fake = Object.assign((req, res, next) => next(), { hrmsGuard: { signedIn: false, anyOf: ['cf_hrms_people_view'], also: [], note: null } });
    bare.post('/y', fake, (req, res) => res.json({}));
    const caughtProblems = routeTableProblems(routeTable(bare));
    ok(caughtProblems.length === 2 && /GET \/x has no guard/.test(caughtProblems[0]) && /cf_hrms_people_view/.test(caughtProblems[1]), 'the check itself fails on an unguarded route and on an old tag', caughtProblems.join(' | '));
    const built = await caught(async () => { const { guard } = await import('../../apps/cf_hrms/lib/http.js'); guard(PERM.hiring.remove); });
    ok(Boolean(built) && /name a right|not a right/.test(built.message), 'guard() with a right that does not exist throws when the router is built, not when it is called', built?.message);
    // The code generator's own routes are each behind one of ours.
    const module = codegenModule.createRouter({ viewPerm: PERM.setup.view, managePerm: PERM.setup.edit, entityTypes: ['hrms_role'] });
    const theirs = routeTable(module).map((r) => `${r.method} ${r.path}`);
    const ours = new Set(rows.filter((r) => r.path.startsWith('/codegen')).map((r) => `${r.method} ${r.path}`));
    ok(theirs.length >= 8 && theirs.every((k) => ours.has(k)), 'every route of the code generator is behind a guard of this app', theirs.filter((k) => !ours.has(k)).join(', '));
    const used = new Set(rows.flatMap((r) => (r.guard ? [...r.guard.anyOf, ...r.guard.also] : [])));
    const unused = ALL_TAGS.filter((t) => !used.has(t));
    // The five upload rights guard the Excel uploads since round C (routes/excel.js).
    // Performance upload is the Excel of actuals since step 5 (spec §19.3).
    ok(same(unused, [PERM.documents.remove]),
      'every right opens a route, except removing a generated document (no such route yet)', unused.join(', '));
    ok(rows.filter((r) => r.guard?.anyOf.includes(PERM.selfView)).every((r) => r.path.startsWith('/user/me')) && rows.filter((r) => r.path.startsWith('/user/me')).every((r) => r.guard.anyOf.join() === PERM.selfView),
      'cf_hrms_self_view guards the /user/me routes and nothing else, and they ask for nothing else');
  }

  /* ══ 2. the migration ═════════════════════════════════════════════════════ */
  section('[2] The migration: before and after, for every role');
  const roleIdOf = {};
  {
    // An area added after the company was set up (performance, spec §18): the first run grants each
    // ready-made role exactly that area's rights its template holds, and nothing else.
    const late = await setupAccess(db, COMPANY, { apply: false });
    const lateTags = new Set([...lateAreaTags('performance'), ...lateAreaTags('payroll'), ...lateAreaTags('attendance')]);
    const lateOk = late.problems.length === 0 && late.roles.every((r) => r.lost.length === 0 && r.gained.every((t) => lateTags.has(t))
      && (!r.templateKey || r.templateKey === 'OWNER' || same(r.gained, r.lateGained)))
      && late.catalog.features.every((t) => lateTags.has(t));
    ok(lateOk, 'a new area: the ready-made roles gain only its rights (performance: HR manager all four, HR executive and Department head view + edit; payroll: HR manager all four, HR executive view + edit; attendance: HR manager all four, HR executive view + edit, Department head view), nothing is lost',
      JSON.stringify(late.roles.filter((r) => !r.same).map((r) => [r.platformName, r.gained, r.lost])));
    if (late.roles.some((r) => !r.same) || late.catalog.features.length) await setupAccess(db, COMPANY, { apply: true });
    const dry = await setupAccess(db, COMPANY, { apply: false });
    const byKey = Object.fromEntries(dry.roles.filter((r) => r.templateKey).map((r) => [r.templateKey, r]));
    for (const k of Object.keys(byKey)) roleIdOf[k] = byKey[k].roleId;
    ok(dry.problems.length === 0 && dry.roles.every((r) => r.existed && r.same && r.gained.length === 0 && r.lost.length === 0) && dry.catalog.features.length === 0 && dry.catalog.capabilities.length === 0,
      `${company.name} is migrated: run again, every role comes out with exactly what it has — nothing gained, nothing lost, nothing to create`, JSON.stringify(dry.roles.filter((r) => !r.same).map((r) => [r.platformName, r.gained, r.lost])));
    ok(same(byKey.OWNER.after, ALL_TAGS) && byKey.OWNER.platformName === 'admin' && same(byKey.EMPLOYEE.after, [PERM.selfView]) && byKey.EMPLOYEE.platformName.toLowerCase() === 'employee',
      'the Owner is the company’s existing `admin` role (not renamed) and holds everything; Employee holds self view and nothing else');
    const logins = await q(
      `SELECT r.name, COUNT(*) AS n FROM app_user_access aua JOIN roles r ON r.id = aua.role_id JOIN users u ON u.id = aua.user_id AND u.deleted_at IS NULL
        WHERE aua.company_id = ? AND aua.app_id = ? AND aua.deleted_at IS NULL GROUP BY r.name`, [COMPANY, app.id]);
    const total = logins.reduce((t, r) => t + Number(r.n), 0);
    ok(byKey.OWNER.logins + byKey.EMPLOYEE.logins === total && logins.every((r) => ['admin', 'employee'].includes(r.name.toLowerCase())),
      `all ${total} logins are on the Owner or on Employee, as before — nobody was moved`, JSON.stringify(logins));
    ok(['HR_MANAGER', 'HR_EXECUTIVE', 'DEPARTMENT_HEAD'].every((k) => byKey[k] && byKey[k].logins === 0 && same(byKey[k].after, TEMPLATES.find((t) => t.key === k).tags)),
      'the three new ready-made roles exist, hold their template, and nobody is on them');
    const mine = await q('SELECT role_id, team_id, company_id, app_id, capability_id, COUNT(*) AS n FROM role_capability WHERE deleted_at IS NULL AND role_id IN (SELECT id FROM roles WHERE company_id = ?) GROUP BY 1,2,3,4,5', [COMPANY]);
    ok(mine.every((r) => Number(r.n) === 1) && mine.every((r) => r.company_id === COMPANY && r.app_id === app.id), 'every grant of this company is for this company and its own cf_hrms app — none with no app, none twice', JSON.stringify(mine.filter((r) => Number(r.n) > 1 || r.app_id !== app.id).slice(0, 3)));
    const caps = await q("SELECT fc.name, fc.features_json, f.id FROM features_capability fc JOIN features f ON f.feature_tag = fc.name WHERE fc.name IN (?) AND fc.deleted_at IS NULL", [ALL_TAGS]);
    const idsOf = (v) => (Array.isArray(v) ? v : JSON.parse(v));
    ok(caps.length === ALL_TAGS.length && caps.every((c) => idsOf(c.features_json).length === 1 && Number(idsOf(c.features_json)[0]) === c.id), 'one capability per right, named after it, holding exactly that one feature');
  }

  // A company that has NOT been migrated, with roles on the old tags — built here, on another tenant.
  if (other) {
    const OTHER = other.id;
    const oldCap = async (tag) => (await one('SELECT capability_id FROM features_capability WHERE name = ? AND deleted_at IS NULL ORDER BY capability_id LIMIT 1', [tag])).capability_id;
    const mkRole = async (name, oldTags, { wildcard = [] } = {}) => {
      const id = (await db.query('INSERT INTO roles (name, company_id) VALUES (?, ?)', [name, OTHER]))[0].insertId;
      for (const t of oldTags) await db.query('INSERT INTO role_capability (role_id, team_id, company_id, app_id, capability_id) VALUES (?, NULL, ?, ?, ?)', [id, OTHER, other.app_id, await oldCap(t)]);
      for (const t of wildcard) await db.query('INSERT INTO role_capability (role_id, team_id, company_id, app_id, capability_id) VALUES (?, NULL, ?, NULL, ?)', [id, OTHER, await oldCap(t)]);
      return id;
    };
    const viewer = await mkRole(`${TAG} viewer`, ['cf_hrms_org_view', 'cf_hrms_people_view']);
    const hr = await mkRole(`${TAG} hr`, ['cf_hrms_org_view', 'cf_hrms_people_view', 'cf_hrms_people_manage', 'cf_hrms_people_pii', 'cf_hrms_documents_generate', 'cf_hrms_leave_view', 'cf_hrms_leave_manage']);
    const planner = await mkRole(`${TAG} planner`, ['cf_hrms_org_view', 'cf_hrms_org_manage', 'cf_hrms_roles_manage', 'cf_hrms_assignments_manage', 'cf_hrms_attendance_view', 'cf_hrms_import_manage']);
    const nothing = await mkRole(`${TAG} nothing here`, []);
    const wild = await mkRole(`${TAG} wild`, ['cf_hrms_people_view'], { wildcard: ['cf_hrms_leave_view'] });
    const userOn = async (roleId, n) => {
      const id = (await db.query('INSERT INTO users (name, email, password, role_id, team_id, company_id) VALUES (?, ?, ?, ?, NULL, ?)', [`${TAG} u${n}`, `${TAG.toLowerCase()}.m${n}@example.test`, 'x', roleId, OTHER]))[0].insertId;
      await db.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [id, other.app_id, roleId, OTHER]);
      return id;
    };
    await userOn(viewer, 1); await userOn(hr, 2); await userOn(hr, 3);
    const grantsBefore = Number((await one('SELECT COUNT(*) AS n FROM role_capability WHERE company_id <> ? AND deleted_at IS NULL', [OTHER])).n);

    const plan = await setupAccess(db, OTHER, { apply: false });
    const row = (id) => plan.roles.find((r) => r.roleId === id);
    ok(plan.problems.length === 0 && same(row(viewer).after, mapOldTags(['cf_hrms_org_view', 'cf_hrms_people_view'])) && same(row(viewer).before, row(viewer).after) && row(viewer).same && row(viewer).logins === 1,
      'an old "viewer" role (org_view + people_view): after = view on org, roles, positions, time, setup, employees and hiring — the same as before, in the new words', JSON.stringify(row(viewer)?.after));
    ok(same(row(hr).after, [...mapOldTags(['cf_hrms_org_view', 'cf_hrms_people_view', 'cf_hrms_people_manage', 'cf_hrms_people_pii', 'cf_hrms_documents_generate', 'cf_hrms_leave_view', 'cf_hrms_leave_manage'])])
      && row(hr).after.includes(PERM.employeeCreate) && row(hr).after.includes(PERM.employeeClose) && row(hr).after.includes(PERM.payView) && row(hr).after.includes(PERM.contactView)
      && row(hr).after.includes(PERM.leave.remove) && !row(hr).after.includes(PERM.positions.edit) && !row(hr).after.includes(PERM.accessManage) && row(hr).logins === 2,
    'an old HR role keeps creating and closing employees, pay and contact, leave — and gains no position edit and no access to logins');
    ok(same(row(planner).after, [...mapOldTags(['cf_hrms_org_view', 'cf_hrms_org_manage', 'cf_hrms_roles_manage', 'cf_hrms_assignments_manage']), PERM.attendance.view]) && !row(planner).after.some((t) => /employees|hiring|leave|documents/.test(t))
      && row(planner).after.includes(PERM.setup.remove) && !row(planner).after.includes(PERM.setup.upload), 'an old planner role: organisation, roles, positions, time and setup — attendance view keeps its name (an attendance right since §28), import maps to nothing');
    ok(!plan.roles.some((r) => r.roleId === nothing), 'a role that held no cf_hrms tag is not given an access role');
    ok(JSON.stringify(row(wild).wildcard) === JSON.stringify(['cf_hrms_leave_view']), 'a grant with NO app (which applies in every app) is reported, by role and tag');
    ok(Object.keys(OLD_TAG_MAP).length === 14 && ['cf_hrms_attendance_manage', 'cf_hrms_import_manage'].every((t) => OLD_TAG_MAP[t].length === 0) && same(OLD_TAG_MAP.cf_hrms_attendance_view, [PERM.attendance.view])
      && Object.values(OLD_TAG_MAP).flat().every((t) => ALL_TAGS.includes(t)) && !Object.values(OLD_TAG_MAP).flat().includes(PERM.accessManage),
    'all fourteen old tags are mapped, each to rights of the model, and none of them to "manage logins and access"');

    const applied = await setupAccess(db, OTHER, { apply: true });
    const heldAfter = await tagsOfRoles(db, { appId: other.app_id, roleIds: [viewer, hr, planner, wild] });
    ok(applied.problems.length === 0 && [viewer, hr, planner].every((id) => same(newTagsOf(heldAfter.get(id).tags), row(id).after)),
      'applied: each role holds, as the platform resolves it, exactly the rights the plan printed');
    const rowsOther = await q('SELECT role_id, company_id, app_id, capability_id, COUNT(*) AS n FROM role_capability WHERE deleted_at IS NULL AND role_id IN (?) GROUP BY 1,2,3,4', [[viewer, hr, planner]]);
    ok(rowsOther.every((r) => Number(r.n) === 1 && r.company_id === OTHER && r.app_id === other.app_id), 'its grants: that company, its own cf_hrms app, never twice');
    ok(Number((await one('SELECT COUNT(*) AS n FROM role_capability WHERE company_id <> ? AND deleted_at IS NULL', [OTHER])).n) === grantsBefore, 'and no grant of any other company was written or removed');
    const access = await q('SELECT role_id, label, scope, template_key FROM hrms_access_roles WHERE company_id = ? AND deleted_at IS NULL', [OTHER]);
    ok(access.find((a) => a.role_id === viewer)?.label === `${TAG} viewer` && access.find((a) => a.role_id === viewer).scope === 'COMPANY' && access.find((a) => a.role_id === viewer).template_key === null
      && ['OWNER', 'HR_MANAGER', 'HR_EXECUTIVE', 'DEPARTMENT_HEAD', 'EMPLOYEE'].every((k) => access.some((a) => a.template_key === k)),
    'each migrated role has an access role named after it, scope COMPANY; the five ready-made ones exist');
    const countAll = async () => Number((await one('SELECT COUNT(*) AS n FROM role_capability WHERE company_id = ?', [OTHER])).n);
    const n1 = await countAll();
    const again = await setupAccess(db, OTHER, { apply: true });
    ok(await countAll() === n1 && again.roles.every((r) => r.same) && again.problems.length === 0 && again.roles.find((r) => r.roleId === viewer).before.length === row(viewer).after.length,
      'run again: not one grant row more, and every role "same" — the two old names that live on (org_view, leave_view) are not mapped a second time');

    // A role that already has logins is not handed a ready-made role's rights because of its name.
    await db.query('UPDATE hrms_access_roles SET deleted_at = NOW() WHERE company_id = ? AND template_key = ?', [OTHER, 'HR_EXECUTIVE']);
    const exec = await one("SELECT id FROM roles WHERE company_id = ? AND name = 'HR executive' AND deleted_at IS NULL", [OTHER]);
    await setRoleTags(db, { companyId: OTHER, appId: other.app_id, roleId: exec.id, tags: [], catalog: await ensureCatalog(db) });
    await userOn(exec.id, 9);
    const guarded = await setupAccess(db, OTHER, { apply: true });
    ok(guarded.problems.length === 1 && /already has logins/.test(guarded.problems[0]) && (await tagsOfRoles(db, { appId: other.app_id, roleIds: [exec.id] })).get(exec.id).tags.size === 0,
      'an existing role that has logins and would GAIN rights by its name: nothing is written, and the script says so', guarded.problems.join(' | '));
    const allowed = await setupAccess(db, OTHER, { apply: true, allowGain: true });
    ok(allowed.problems.length === 0 && (await tagsOfRoles(db, { appId: other.app_id, roleIds: [exec.id] })).get(exec.id).tags.size === TEMPLATES.find((t) => t.key === 'HR_EXECUTIVE').tags.length, '--allow-gain is the only way through');

    const cross = await caught(() => setRoleTags(db, { companyId: OTHER, appId: app.id, roleId: viewer, tags: [PERM.org.view], catalog: { byTag: new Map(), capabilityTag: new Map() } }));
    const crossRole = await caught(() => setRoleTags(db, { companyId: OTHER, appId: other.app_id, roleId: roleIdOf.EMPLOYEE, tags: [PERM.org.view], catalog: { byTag: new Map(), capabilityTag: new Map() } }));
    ok(/not company/.test(cross?.message ?? '') && /not a role of company/.test(crossRole?.message ?? ''), 'a grant cannot be written for another company’s app, nor for another company’s role', `${cross?.message} | ${crossRole?.message}`);
  } else skip('migrating old tags', 'no second company has the cf_hrms app');

  /* ══ the fixture: departments, positions, people, a login on every role ════ */
  const owner = await one(
    `SELECT u.id, u.email, u.name FROM users u JOIN app_user_access aua ON aua.user_id = u.id AND aua.app_id = ? AND aua.deleted_at IS NULL JOIN roles r ON r.id = aua.role_id
      WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [app.id, COMPANY]);
  if (!owner) throw new Error('This company has no Owner login.');
  const c = { companyId: COMPANY, userId: owner.id };
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  const dept = async (name, parentId = null) => ins("INSERT INTO hrms_departments (company_id, code, name, department_type, parent_department_id) VALUES (?, ?, ?, 'Department', ?)", [COMPANY, `${TAG}${name}`, `${TAG} ${name}`, parentId]);
  const D = { root: await dept('ROOT') };
  D.sub = await dept('SUB', D.root);
  D.other = await dept('OTHER');
  const hrmsRole = await ins("INSERT INTO hrms_roles (company_id, role_code, title, role_purpose, status) VALUES (?, ?, ?, 'Runs the machine safely and to plan.', 'ACTIVE')", [COMPANY, `${TAG}R`, `${TAG} Operator`]);
  const pos = async (code, departmentId) => ins("INSERT INTO hrms_positions (company_id, position_code, role_id, position_title, department_id, status) VALUES (?, ?, ?, ?, ?, 'ACTIVE')", [COMPANY, `${TAG}-${code}`, hrmsRole, `${TAG} ${code}`, departmentId]);
  const P = { head: await pos('HEAD', D.root), in: await pos('IN', D.root), sub: await pos('SUB', D.sub), out: await pos('OUT', D.other), vac: await pos('VAC', D.sub), vacOut: await pos('VACOUT', D.other), hire: await pos('HIRE', D.sub), hireOut: await pos('HIREOUT', D.other) };
  const emp = async (code, phone) => ins(
    "INSERT INTO hrms_employees (company_id, employee_code, full_name, phone, email, date_of_birth, date_of_joining, employment_type, employment_status) VALUES (?, ?, ?, ?, ?, '1990-01-02', '2026-01-01', 'EMPLOYEE', 'ACTIVE')",
    [COMPANY, `${TAG}${code}`, `${TAG} Person ${code}`, phone, `${TAG.toLowerCase()}.${code.toLowerCase()}@example.test`]);
  const seat = async (employeeId, positionId, departmentId) => ins(
    "INSERT INTO hrms_work_assignments (company_id, employee_id, role_id, position_id, department_id, is_primary, status, effective_from) VALUES (?, ?, ?, ?, ?, 1, 'ACTIVE', '2026-01-01')",
    [COMPANY, employeeId, hrmsRole, positionId, departmentId]);
  const E = { head: await emp('HEAD', '9100000001'), in: await emp('IN', '9100000002'), sub: await emp('SUB', '9100000003'), out: await emp('OUT', '9100000004'), free: await emp('FREE', '9100000005'), none: await emp('NONE', '9100000006') };
  await seat(E.head, P.head, D.root); await seat(E.in, P.in, D.root); await seat(E.sub, P.sub, D.sub); await seat(E.out, P.out, D.other);

  const catalogRows = await ensureCatalog(db);
  const platformRole = async (id) => (await one('SELECT name FROM roles WHERE id = ?', [id])).name;
  const login = async (label, roleId, employeeId = null) => {
    const id = await ins('INSERT INTO users (name, email, password, role_id, team_id, company_id) VALUES (?, ?, ?, ?, NULL, ?)', [`${TAG} ${label}`, `${TAG.toLowerCase()}.${label.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.test`, 'x', roleId, COMPANY]);
    await db.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [id, app.id, roleId, COMPANY]);
    if (employeeId) await db.query('UPDATE hrms_employees SET user_id = ? WHERE id = ?', [id, employeeId]);
    const email = (await one('SELECT email FROM users WHERE id = ?', [id])).email;
    return { id, email, token: signToken({ id, email, role: await platformRole(roleId), company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
  };
  /** A role of this test's own, with exactly these rights. */
  const customRole = async (name, tags, scope = 'COMPANY') => {
    const id = await ins('INSERT INTO roles (name, company_id) VALUES (?, ?)', [`${TAG} ${name}`, COMPANY]);
    await db.query('INSERT INTO hrms_access_roles (company_id, role_id, label, scope) VALUES (?, ?, ?, ?)', [COMPANY, id, `${TAG} ${name}`, scope]);
    await setRoleTags(db, { companyId: COMPANY, appId: app.id, roleId: id, tags, catalog: catalogRows });
    return id;
  };
  const U = {
    OWNER: { id: owner.id, email: owner.email, token: signToken({ id: owner.id, email: owner.email, role: 'admin', company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) },
    HR_MANAGER: await login('HR manager', roleIdOf.HR_MANAGER),
    HR_EXECUTIVE: await login('HR executive', roleIdOf.HR_EXECUTIVE),
    DEPARTMENT_HEAD: await login('Department head', roleIdOf.DEPARTMENT_HEAD, E.head),
    EMPLOYEE: await login('Employee', roleIdOf.EMPLOYEE, E.sub),
  };
  forgetAccess();

  server = express();
  server.use(express.json({ limit: '50mb' }));
  server.use(cookieParser());
  server.use('/api', appContext);
  hrmsApp.register(server);
  server.use('/api/query/v1', protect, baseResourceRoute);
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
  const NONE = 999999999;

  /* ══ 3. the matrix ════════════════════════════════════════════════════════ */
  section('[3] The matrix: each ready-made role × a route of every area, right and named right');
  // [what, method, url, body, any-of, also] — the right the SPEC says the route needs, written here
  // independently of the routers. Ids that do not exist, so an allowed call writes nothing.
  const MATRIX = [
    ['org view', 'GET', '/organisation/departments/staffing', undefined, [PERM.org.view]],
    ['org edit', 'POST', '/organisation/department-labels', {}, [PERM.org.edit]],
    ['org edit (department)', 'PUT', `/organisation/departments/${NONE}`, {}, [PERM.org.edit]],
    ['org remove', 'DELETE', `/organisation/locations/${NONE}`, undefined, [PERM.org.remove]],
    ['roles view', 'GET', '/roles', undefined, [PERM.roles.view]],
    ['roles edit', 'POST', '/roles', {}, [PERM.roles.edit]],
    ['roles edit (library)', 'POST', '/role-masters/kras', {}, [PERM.roles.edit]],
    ['roles remove', 'DELETE', `/roles/${NONE}`, undefined, [PERM.roles.remove]],
    ['positions view', 'GET', `/positions/${NONE}`, undefined, [PERM.positions.view]],
    ['positions view (chart)', 'GET', '/orgchart/departments', undefined, [PERM.positions.view]],
    ['positions edit', 'POST', `/positions/${NONE}/add-sibling`, {}, [PERM.positions.edit]],
    ['positions edit (job content)', 'POST', `/positions/${NONE}/job-content/add`, {}, [PERM.positions.edit]],
    ['positions edit (move a person)', 'POST', `/people/employees/${NONE}/move`, {}, [PERM.positions.edit]],
    ['positions remove', 'DELETE', `/positions/${NONE}`, undefined, [PERM.positions.remove]],
    ['positions remove (close)', 'POST', `/positions/${NONE}/close`, {}, [PERM.positions.remove]],
    ['employees view', 'GET', `/people/employees/${NONE}`, undefined, [PERM.employees.view]],
    ['employees view (positions held)', 'GET', `/people/employees/${NONE}/positions`, undefined, [PERM.employees.view]],
    ['employees edit', 'PUT', `/people/employees/${NONE}`, {}, [PERM.employees.edit]],
    ['hiring view', 'GET', `/hirings/${NONE}`, undefined, [PERM.hiring.view]],
    ['hiring edit', 'POST', `/hirings/${NONE}/accept-offer`, {}, [PERM.hiring.edit]],
    ['hiring edit (start)', 'POST', `/positions/${NONE}/hiring`, {}, [PERM.hiring.edit]],
    ['documents view', 'GET', `/documents/${NONE}`, undefined, [PERM.documents.view]],
    ['documents edit', 'POST', '/documents/generate', {}, [PERM.documents.edit]],
    ['time view', 'GET', '/organisation/holiday-calendars', undefined, [PERM.time.view]],
    ['time edit', 'POST', '/organisation/shifts', {}, [PERM.time.edit]],
    ['time remove', 'DELETE', `/organisation/shifts/${NONE}`, undefined, [PERM.time.remove]],
    ['leave view', 'GET', '/leave/policies', undefined, [PERM.leave.view]],
    ['leave edit', 'POST', '/leave/policies', {}, [PERM.leave.edit]],
    ['leave remove', 'DELETE', `/leave/policies/${NONE}`, undefined, [PERM.leave.remove]],
    ['setup view (code formats)', 'GET', '/codegen/entities', undefined, [PERM.setup.view]],
    ['setup edit (letters)', 'PUT', '/hiring/templates/nonsense', {}, [PERM.setup.edit]],
    ['setup edit (code formats)', 'POST', '/codegen/schemes', {}, [PERM.setup.edit]],
    ['setup remove (reporting types)', 'DELETE', `/organisation/reporting-types/${NONE}`, undefined, [PERM.setup.remove]],
    ['setup remove (a code rule)', 'DELETE', `/codegen/schemes/${NONE}`, undefined, [PERM.setup.remove], [PERM.setup.edit]],
    ['employee_create (appoint)', 'POST', `/hirings/${NONE}/appoint`, {}, [PERM.employeeCreate]],
    ['employee_create (add outright)', 'POST', '/people/employees', {}, [PERM.employeeCreate], [PERM.employees.edit]],
    ['roles remove (retire)', 'PUT', `/roles/${NONE}`, { status: 'RETIRED' }, [PERM.roles.edit], [PERM.roles.remove]],
    ['leave remove (clear where a policy applies)', 'PUT', '/leave/assignments', { scope: 'NOWHERE', policyId: null }, [PERM.leave.edit], [PERM.leave.remove]],
    ['leave remove (archive a policy)', 'PUT', `/leave/policies/${NONE}`, { status: 'ARCHIVED' }, [PERM.leave.edit], [PERM.leave.remove]],
    ['employee_close', 'POST', `/people/employees/${NONE}/exit`, {}, [PERM.employeeClose]],
    ['employee_close (delete a record)', 'DELETE', `/people/employees/${NONE}`, undefined, [PERM.employeeClose]],
    ['employee_bulk_add', 'GET', '/imports/status', undefined, [PERM.employeeBulkAdd]],
    ['contact_view (identifiers)', 'POST', `/people/employees/${NONE}/identifiers`, {}, [PERM.employees.edit], [PERM.contactView]],
    ['pay_view (a letter)', 'GET', `/hirings/${NONE}/letters/1/file`, undefined, [PERM.hiring.view], [PERM.payView]],
    ['pay_view (make the offer letter)', 'POST', `/hirings/${NONE}/offer-letter`, {}, [PERM.hiring.edit], [PERM.payView]],
    ['pay_view (a signed copy)', 'GET', `/hirings/${NONE}/signed/offer/file`, undefined, [PERM.hiring.view], [PERM.payView]],
    ['pay_view (a letter template)', 'GET', '/hiring/templates/offer/file', undefined, [PERM.hiring.view, PERM.setup.view], [PERM.payView]],
    ['access_manage', 'GET', '/access/roles', undefined, [PERM.accessManage]],
    ['access_manage (logins)', 'GET', '/access/logins', undefined, [PERM.accessManage]],
    ['access_manage (catalogue)', 'GET', '/access/catalog', undefined, [PERM.accessManage]],
    ['self_view', 'GET', '/user/me/place', undefined, [PERM.selfView]],
    ['self_view (team)', 'GET', '/user/me/team/shifts', undefined, [PERM.selfView]],
    ['a picker every screen shares', 'GET', '/organisation/lookups', undefined, AREAS.map((a) => areaTag(a.key, 'view'))],
    ['shifts, for the Shifts screen or a position', 'GET', '/organisation/shifts', undefined, [PERM.time.view, PERM.positions.view]],
    ['any login: what may I do', 'GET', '/access/me', undefined, null],
    ['any login: the vocabulary', 'GET', '/meta', undefined, null],
    ['any login: the menu counts', 'GET', '/overview/nav-counts', undefined, null],
  ];
  const DENIED = ['FORBIDDEN', 'PAY_HIDDEN', 'CONTACT_HIDDEN'];
  for (const t of TEMPLATES) {
    const who = U[t.key];
    const have = new Set(t.tags);
    const wrong = [];
    let allowed = 0;
    for (const [what, method, url, body, anyOf, also = []] of MATRIX) {
      // The Owner's self view is the one right that is not a bypass: it needs a linked employee to say anything, but it is allowed.
      const expected = anyOf === null || t.key === 'OWNER' || (anyOf.some((x) => have.has(x)) && also.every((x) => have.has(x)));
      const r = await call(who, method, url, body);
      const got = !(r.status === 403 && DENIED.includes(r.json?.code));
      if (r.status === 401 || r.status >= 500) wrong.push(`${what}: ${r.status}`);
      else if (got !== expected) wrong.push(`${what}: expected ${expected ? 'allowed' : '403'}, got ${r.status} ${r.json?.code ?? ''}`);
      if (expected) allowed += 1;
    }
    ok(wrong.length === 0, `${t.label}: ${allowed} of ${MATRIX.length} routes open, ${MATRIX.length - allowed} refused with 403 — exactly its rights`, wrong.join('; '));
  }
  ok((await call(null, 'GET', '/access/me')).status === 401 && (await call(null, 'GET', '/positions')).status === 401, 'no token at all: 401');
  {
    const me = {};
    for (const t of TEMPLATES) me[t.key] = (await call(U[t.key], 'GET', '/access/me')).json;
    ok(TEMPLATES.every((t) => same(me[t.key].tags, t.tags) && me[t.key].role.label === (t.shownLabel ?? t.label) && me[t.key].role.id === roleIdOf[t.key]),
      'GET /access/me: every role is told exactly its rights, and its role by its label (the Owner’s is "Owner", though the platform role is admin; DEPARTMENT_HEAD shows as "Unit head")');
    ok(me.OWNER.scope.all === true && me.HR_MANAGER.scope.all === true && me.DEPARTMENT_HEAD.scope.all === false && JSON.stringify(me.DEPARTMENT_HEAD.scope.departmentNames) === JSON.stringify([`${TAG} ROOT`])
      && me.DEPARTMENT_HEAD.role.scope === 'DEPARTMENT' && JSON.stringify(Object.keys(me.OWNER)) === JSON.stringify(['role', 'tags', 'scope']),
    '…and its scope: the whole company, or the department it is limited to — { role: { id, label, scope }, tags, scope: { all, departmentNames } }', JSON.stringify(me.DEPARTMENT_HEAD.scope));
  }
  // The real logins of the company, as they are: an Employee and the Owner.
  {
    const realEmployee = await one(
      `SELECT u.id, u.email FROM users u JOIN app_user_access aua ON aua.user_id = u.id AND aua.app_id = ? AND aua.deleted_at IS NULL
        WHERE u.company_id = ? AND u.deleted_at IS NULL AND aua.role_id = ? AND u.email NOT LIKE ? ORDER BY u.id LIMIT 1`, [app.id, COMPANY, roleIdOf.EMPLOYEE, `${TAG.toLowerCase()}%`]);
    if (realEmployee) {
      const who = { token: signToken({ id: realEmployee.id, email: realEmployee.email, role: 'Employee', company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
      const place = await call(who, 'GET', '/user/me/place');
      const chart = await call(who, 'GET', '/user/me/orgchart');
      const others = [];
      for (const [what, method, url, body, anyOf] of MATRIX) if (anyOf && !anyOf.includes(PERM.selfView)) { const r = await call(who, method, url, body); if (r.status !== 403) others.push(`${what} ${r.status}`); }
      ok(place.status === 200 && chart.status === 200 && others.length === 0, 'a real Employee login of the company: its own place and chart answer, everything else is 403 — as before the migration', others.join('; '));
    } else skip('a real Employee login', 'none found');
  }

  /* ══ 3b. copying content: the right follows the MODE ═════════════════════ */
  // One route, three rights: what a copy needs depends on its body (SEAT -> positions edit,
  // ROLE -> roles edit, FORK -> both). The guard alone cannot say it, so it is proven here
  // through the real middleware. WHAT a copy does is content_copy_test's. (Moved here from
  // content_copy_http_test.mjs, 2026-10-16, which needed a server of its own.)
  section('[3b] Copying content: the right follows the mode, through the real middleware');
  {
    const CU = {
      EMPLOYEE: U.EMPLOYEE,
      viewer: await login('Copy viewer', await customRole('copy viewer', [PERM.roles.view, PERM.positions.view])),
      seats: await login('Copy seats', await customRole('copy seats', [PERM.positions.view, PERM.positions.edit])),
      roles: await login('Copy roles', await customRole('copy roles', [PERM.roles.view, PERM.roles.edit])),
      both: await login('Copy both', await customRole('copy both', [PERM.roles.view, PERM.roles.edit, PERM.positions.view, PERM.positions.edit])),
      OWNER: U.OWNER,
    };
    forgetAccess();
    const def = await RC.createMasterItem(db, c, 'responsibilities', { name: `${TAG} copy duty`, description: `${TAG} A duty to copy` });
    const srcRole = await RC.createRole(db, c, { title: `${TAG} copy source`, status: 'ACTIVE' });
    const tgtRole = await RC.createRole(db, c, { title: `${TAG} copy target`, status: 'ACTIVE' });
    await RC.addContent(db, c, srcRole.id, 'responsibilities', { responsibilityDefinitionId: def.id });
    const seat1 = (await POS.createPosition(db, c, { roleId: tgtRole.id, positionTitle: 'Seat 1', status: 'ACTIVE' })).position.id;
    const seat2 = (await POS.createPosition(db, c, { roleId: tgtRole.id, positionTitle: 'Seat 2', status: 'ACTIVE' })).position.id;
    const body = (mode, extra = {}) => ({
      source: { type: 'role', id: srcRole.id }, targets: mode === 'ROLE' ? [{ type: 'role', id: tgtRole.id }] : [{ type: 'position', id: seat1 }], mode, kinds: ['responsibilities'], ...extra,
    });
    const counts = async () => JSON.stringify(await q(
      `SELECT (SELECT COUNT(*) FROM hrms_roles WHERE company_id = ?) AS roles, (SELECT COUNT(*) FROM hrms_positions WHERE company_id = ?) AS positions,
              (SELECT COUNT(*) FROM hrms_role_responsibility_assignments WHERE company_id = ?) AS duties,
              (SELECT COUNT(*) FROM hrms_position_content_overrides WHERE company_id = ?) AS overlays`, [COMPANY, COMPANY, COMPANY, COMPANY]));
    const statuses = async (method, url, payload, keys = Object.keys(CU)) => Object.fromEntries(await Promise.all(keys.map(async (k) => [k, (await call(CU[k], method, url, payload)).status])));

    const read = await statuses('GET', `/role-content-copy/source?type=role&id=${srcRole.id}`);
    ok(same(Object.entries(read).map(([k, s]) => `${k}:${s}`), ['EMPLOYEE:403', 'viewer:200', 'seats:200', 'roles:200', 'both:200', 'OWNER:200']),
      'reading a source needs roles view OR positions view: an Employee 403, everyone else 200', JSON.stringify(read));

    const before0 = await counts();
    const expected = {
      SEAT: { EMPLOYEE: 403, viewer: 403, seats: 200, roles: 403, both: 200, OWNER: 200 },
      ROLE: { EMPLOYEE: 403, viewer: 403, seats: 403, roles: 200, both: 200, OWNER: 200 },
      FORK: { EMPLOYEE: 403, viewer: 403, seats: 403, roles: 403, both: 200, OWNER: 200 },
    };
    const previews = {};
    for (const mode of Object.keys(expected)) previews[mode] = await statuses('POST', '/role-content-copy/preview', body(mode));
    ok(JSON.stringify(previews) === JSON.stringify(expected), 'preview: SEAT needs positions edit, ROLE roles edit, FORK both; the Owner may do any', JSON.stringify(previews));
    const unknown = await statuses('POST', '/role-content-copy/preview', { mode: 'TELEPORT' });
    const empty = await statuses('POST', '/role-content-copy/preview', undefined, ['EMPLOYEE', 'seats']);
    ok(JSON.stringify(unknown) === JSON.stringify({ EMPLOYEE: 403, viewer: 403, seats: 422, roles: 422, both: 422, OWNER: 422 }) && empty.EMPLOYEE === 403 && empty.seats === 422,
      'an unknown mode or an empty body: 403 for whoever holds neither edit right (never a peek at the validation), 422 for the rest', JSON.stringify({ unknown, empty }));
    ok(await counts() === before0, 'no preview wrote anything');

    const wrong = [];
    for (const [k, mode, extra] of [['EMPLOYEE', 'SEAT'], ['EMPLOYEE', 'ROLE', { confirm: { seats: 2 } }], ['viewer', 'SEAT'], ['roles', 'SEAT'], ['seats', 'ROLE', { confirm: { seats: 2 } }], ['seats', 'FORK'], ['roles', 'FORK']]) {
      const r = await call(CU[k], 'POST', '/role-content-copy', body(mode, extra));
      if (r.status !== 403) wrong.push(`${k} ${mode} ${r.status}`);
    }
    ok(wrong.length === 0 && await counts() === before0, 'every write with the wrong right for its mode is 403, and none of them wrote a row', wrong.join('; '));

    const seatOk = await call(CU.seats, 'POST', '/role-content-copy', body('SEAT'));
    const overlayBy = await one('SELECT COUNT(*) AS n, MAX(created_by) AS who FROM hrms_position_content_overrides WHERE company_id = ? AND position_id = ? AND deleted_at IS NULL', [COMPANY, seat1]);
    ok(seatOk.status === 200 && seatOk.json?.totals?.created === 1 && Number(overlayBy.n) === 1 && Number(overlayBy.who) === CU.seats.id,
      'positions edit alone copies onto a seat: one overlay row, on that seat, written as that login', JSON.stringify({ totals: seatOk.json?.totals, overlayBy }));
    const fork = await call(CU.both, 'POST', '/role-content-copy', { ...body('FORK'), targets: [{ type: 'position', id: seat2 }], forkTitle: `${TAG} seat 2 own role` });
    ok(fork.status === 200 && fork.json?.totals?.newRoles === 1 && (await one('SELECT role_id FROM hrms_positions WHERE id = ?', [seat2])).role_id === fork.json.targets[0].fork.newRoleId,
      'both rights fork a seat onto a role of its own', JSON.stringify(fork.json?.totals ?? fork.json));
    // The target role has one seat left (seat 2 took a role of its own).
    const noConfirm = await call(CU.roles, 'POST', '/role-content-copy', body('ROLE'));
    const roleOk = await call(CU.roles, 'POST', '/role-content-copy', body('ROLE', { confirm: { seats: 1 } }));
    ok(noConfirm.status === 422 && noConfirm.json?.code === 'CONFIRM_SEATS' && roleOk.status === 200 && roleOk.json?.totals?.created === 1,
      'roles edit alone copies onto a role — over HTTP the missing seat count is a 422 CONFIRM_SEATS, the confirmed one a 200', `${noConfirm.status} ${noConfirm.json?.code} ${roleOk.status} ${JSON.stringify(roleOk.json?.totals ?? roleOk.json)}`);
  }

  /* ══ 4. the next request ══════════════════════════════════════════════════ */
  section('[4] A change of rights counts on the very next request, with the same token');
  {
    const who = U.HR_EXECUTIVE;
    ok((await call(who, 'GET', `/positions/${P.in}`)).status === 200, 'an HR executive reads a position');
    const tags = TEMPLATES.find((t) => t.key === 'HR_EXECUTIVE').tags;
    const cut = await call(U.OWNER, 'PUT', `/access/roles/${roleIdOf.HR_EXECUTIVE}`, { tags: tags.filter((t) => ![PERM.positions.view, PERM.positions.edit].includes(t)) });
    const next = await call(who, 'GET', `/positions/${P.in}`);
    ok(cut.status === 200 && cut.json.loginsAffected === 1 && next.status === 403 && next.json.code === 'FORBIDDEN', 'the Owner takes "positions" away from the role: the very next call with the SAME token is 403 (and the save said it changes 1 login)', `${cut.status} ${next.status}`);
    ok((await call(who, 'GET', '/roles')).status === 200 && same((await call(who, 'GET', '/access/me')).json.tags, tags.filter((t) => ![PERM.positions.view, PERM.positions.edit].includes(t))), 'what it still holds still works, and /access/me says the new set');
    await call(U.OWNER, 'PUT', `/access/roles/${roleIdOf.HR_EXECUTIVE}`, { tags });
    ok((await call(who, 'GET', `/positions/${P.in}`)).status === 200, 'given back: the next call is allowed again');

    const off = await call(U.OWNER, 'POST', `/access/logins/${who.id}/disable`);
    const blocked = await call(who, 'GET', '/access/me');
    ok(off.status === 200 && off.json.login.state === 'DISABLED' && blocked.status === 403 && /access to this app/.test(blocked.json.message), 'disabled: the same token is refused on the next call — "You do not have access to this app"', `${off.status} ${blocked.status} ${blocked.json?.message}`);
    const on = await call(U.OWNER, 'POST', `/access/logins/${who.id}/enable`);
    ok(on.status === 200 && on.json.login.state === 'ACTIVE' && (await call(who, 'GET', '/access/me')).status === 200, 'enabled: it works again');

    // The Owner's pass is on the role the login is on NOW, not on what its token says.
    const second = await login('Second owner', roleIdOf.OWNER);
    forgetAccess();
    ok((await call(second, 'GET', '/access/roles')).status === 200, 'a second Owner (token says admin) manages access');
    const demoted = await call(U.OWNER, 'PUT', `/access/logins/${second.id}`, { roleId: roleIdOf.EMPLOYEE });
    const stale = await call(second, 'GET', '/access/roles');
    const staleWrite = await call(second, 'PUT', `/positions/${P.in}`, { positionTitle: 'x' });
    ok(demoted.status === 200 && stale.status === 403 && staleWrite.status === 403, 'demoted to Employee: the token still SAYS admin, and it opens nothing — the pass is read from the database on every request', `${demoted.status} ${stale.status} ${staleWrite.status}`);
    const staleGeneric = await call(second, 'POST', '/query/v1/base_resource', { operation: 'update', resource: 'users', id: second.id, data: { name: 'x' } }, { raw: true });
    ok(staleGeneric.status === 403, '…nor does it write the access tables through the generic API', `${staleGeneric.status}`);
  }

  /* ══ 5. scope ═════════════════════════════════════════════════════════════ */
  section('[5] Scope: only my department and below');
  {
    const head = U.DEPARTMENT_HEAD;
    const s = await scopeFor(db, { companyId: COMPANY, userId: head.id, scope: 'DEPARTMENT' });
    ok(s.all === false && same([...s.departmentIds], [D.root, D.sub]) && JSON.stringify(s.rootIds) === JSON.stringify([D.root]) && s.employeeId === E.head,
      'a Department head’s scope: the department of the position they hold, and its sub-department');
    ok((await scopeFor(db, { companyId: COMPANY, userId: head.id, scope: 'COMPANY' })).all === true && (await scopeFor(db, { companyId: COMPANY, userId: head.id, scope: 'DEPARTMENT', owner: true })).all === true,
      'a whole-company role, and the Owner, are not scoped');

    // the structure, company-wide
    const [chartHead, chartOwner, depts, positions] = [await call(head, 'GET', '/orgchart'), await call(U.OWNER, 'GET', '/orgchart'), await call(head, 'GET', '/organisation/departments'), await call(head, 'GET', `/positions/${P.out}`)];
    ok(chartHead.status === 200 && chartHead.json.nodes.length === chartOwner.json.nodes.length && chartHead.json.nodes.some((n) => n.id === P.out) && depts.status === 200 && depts.json.rows.some((r) => r.id === D.other) && positions.status === 200,
      'they see the WHOLE chart, every department and a position outside their own — the structure is the company’s', `${chartHead.json?.nodes?.length} vs ${chartOwner.json?.nodes?.length}`);

    // the people
    const list = await call(head, 'GET', '/people/employees?status=ALL&limit=2000');
    const mine = list.json.items.filter((i) => String(i.employeeCode).startsWith(TAG)).map((i) => i.id);
    ok(list.status === 200 && same(list.json.items.map((i) => i.id), [E.head, E.in, E.sub]) && same(mine, [E.head, E.in, E.sub]),
      'the employees list holds the people of their department and below — and nobody else in the company', `${list.json?.items?.length} rows`);
    const inside1 = await call(head, 'GET', `/people/employees/${E.sub}`);
    const outside1 = await call(head, 'GET', `/people/employees/${E.out}`);
    ok(inside1.status === 200 && inside1.json.employee.phone === '9100000003' && outside1.status === 403 && outside1.json.code === 'OUT_OF_SCOPE' && /outside your org unit/.test(outside1.json.message),
      'one of theirs opens, with contact details (the role holds contact view); one outside is 403 OUT_OF_SCOPE, in words', `${inside1.status} ${outside1.status} ${outside1.json?.message}`);
    const refusedReads = [];
    for (const url of [`/people/employees/${E.out}/positions`, `/people/employees/${E.out}/assignments`, `/people/employees/${E.out}/identifiers`, `/people/employees/${E.out}/documents`, `/people/employees/${E.out}/events`, `/people/employees/${E.out}/exits`, `/people/employees/${E.free}`]) {
      const r = await call(head, 'GET', url);
      if (!(r.status === 403 && r.json.code === 'OUT_OF_SCOPE')) refusedReads.push(`${url} ${r.status}`);
    }
    ok(refusedReads.length === 0 && (await call(head, 'GET', `/people/employees/${E.in}/positions`)).status === 200, 'positions held, work, identifiers, documents, events and leaving of somebody outside — or of somebody in no position — are all 403 OUT_OF_SCOPE', refusedReads.join('; '));
    const work = await call(head, 'GET', '/assignments?limit=2000');
    ok(work.status === 200 && same([...new Set(work.json.items.map((i) => i.employeeId))], [E.head, E.in, E.sub]), 'the list of people’s work is cut the same way');

    // writes on positions
    const title = (id) => one('SELECT position_title, department_id FROM hrms_positions WHERE id = ?', [id]);
    const w1 = await call(head, 'PUT', `/positions/${P.in}`, { positionTitle: `${TAG} renamed in` });
    const w2 = await call(head, 'PUT', `/positions/${P.sub}`, { positionTitle: `${TAG} renamed sub` });
    const w3 = await call(head, 'PUT', `/positions/${P.out}`, { positionTitle: `${TAG} renamed out` });
    ok(w1.status === 200 && w2.status === 200 && (await title(P.in)).position_title === `${TAG} renamed in` && (await title(P.sub)).position_title === `${TAG} renamed sub`
      && w3.status === 403 && w3.json.code === 'OUT_OF_SCOPE' && (await title(P.out)).position_title === `${TAG} OUT`,
    'they change a position in their department and in a sub-department; one outside is 403 OUT_OF_SCOPE and is not changed', `${w1.status} ${w2.status} ${w3.status}`);
    const outsideWrites = [];
    for (const [method, url, body] of [
      ['POST', `/positions/${P.out}/add-sibling`, {}], ['POST', `/positions/${P.out}/job-content/add`, { kind: 'responsibilities', name: 'x' }], ['POST', `/positions/${P.out}/reporting-relationships`, { toPositionId: P.head }],
      ['POST', `/positions/${P.out}/work-contexts`, {}], ['POST', `/positions/${P.out}/overrides`, {}], ['POST', `/positions/${P.out}/status`, { status: 'FROZEN' }],
      ['PUT', `/positions/${P.in}`, { departmentId: D.other }], ['POST', '/positions', { roleId: hrmsRole, departmentId: D.other }], ['POST', '/positions', { roleId: hrmsRole }],
      ['POST', `/people/employees/${E.in}/move`, { positionId: P.vacOut }], ['POST', `/people/employees/${E.out}/move`, { positionId: P.vac }],
      ['POST', '/assignments', { employeeId: E.out, roleId: hrmsRole, positionId: P.vac }], ['POST', '/assignments', { employeeId: E.in, roleId: hrmsRole, positionId: P.vacOut }],
      ['POST', '/role-content-copy', { mode: 'SEAT', source: { type: 'position', id: P.in }, targets: [{ type: 'position', id: P.out }], kinds: ['responsibilities'] }],
    ]) {
      const r = await call(head, method, url, body);
      if (!(r.status === 403 && r.json.code === 'OUT_OF_SCOPE')) outsideWrites.push(`${method} ${url} ${r.status} ${r.json?.code ?? ''}`);
    }
    ok(outsideWrites.length === 0, 'every write that reaches outside is 403 OUT_OF_SCOPE: a sibling, job content, a reporting line, a status, moving a position out, creating one outside or nowhere, moving a person out or in, copying content onto one', outsideWrites.join('; '));
    ok((await title(P.in)).department_id === D.root && Number((await one('SELECT COUNT(*) AS n FROM hrms_positions WHERE company_id = ? AND department_id = ? AND deleted_at IS NULL', [COMPANY, D.other])).n) === 3, '…and none of them wrote anything');
    const made = await call(head, 'POST', '/positions', { roleId: hrmsRole, departmentId: D.sub, status: 'ACTIVE' });
    const moved = await call(head, 'POST', `/people/employees/${E.in}/move`, { positionId: P.vac });
    ok(made.status === 200 && made.json.position.departmentId === D.sub && moved.status === 200 && moved.json.moved.positionId === P.vac, 'inside, they add a position and move one of their people to another of their positions', `${made.status} ${moved.status} ${JSON.stringify(moved.json).slice(0, 120)}`);
    const noRemove = await call(head, 'DELETE', `/positions/${P.vac}`);
    const noClose = await call(head, 'POST', `/positions/${P.sub}/status`, { status: 'CLOSED' });
    const noClose2 = await call(head, 'PUT', `/positions/${P.sub}`, { status: 'CLOSED' });
    ok(noRemove.status === 403 && noRemove.json.code === 'FORBIDDEN' && noClose.status === 403 && noClose2.status === 403 && (await one('SELECT status FROM hrms_positions WHERE id = ?', [P.sub])).status === 'ACTIVE',
      'edit is not remove: deleting a position, or closing it by its status through either door, is 403 for a role without "remove"', `${noRemove.status} ${noClose.status} ${noClose2.status}`);
    const nav = await call(head, 'GET', '/overview/home');
    ok(nav.status === 200 && !('employees' in nav.json.counts) && nav.json.recentPeople === null && 'departments' in nav.json.counts, 'Home gives a scoped login the structure’s numbers and not the company’s people numbers');

    // a scoped login with no employee
    const nobody = await login('Head without employee', roleIdOf.DEPARTMENT_HEAD);
    forgetAccess();
    const n1 = await call(nobody, 'GET', '/orgchart');
    const n2 = await call(nobody, 'GET', '/people/employees');
    const n3 = await call(nobody, 'PUT', `/positions/${P.in}`, { positionTitle: 'x' });
    const n4 = await call(nobody, 'GET', '/access/me');
    const n5 = await call(nobody, 'POST', '/positions', { roleId: hrmsRole, departmentId: D.root });
    ok(n1.status === 200 && n2.status === 200 && n2.json.items.length === 0 && n3.status === 403 && n3.json.code === 'OUT_OF_SCOPE' && n5.status === 403 && n4.json.scope.all === false && n4.json.scope.departmentNames.length === 0,
      'a scoped login with no linked employee: sees the structure, sees no people, can change nothing — and /access/me says its scope is empty', `${n1.status} ${n2.json?.items?.length} ${n3.status} ${n5.status}`);
    // …and one whose employee holds no position
    const adrift = await login('Head with no position', roleIdOf.DEPARTMENT_HEAD, E.free);
    forgetAccess();
    ok((await call(adrift, 'GET', '/people/employees')).json.items.length === 0 && (await call(adrift, 'PUT', `/positions/${P.in}`, { positionTitle: 'x' })).status === 403, 'the same for one whose employee holds no position');

    // a scoped role that may change departments, start hirings and edit employees
    const scopedRole = await customRole('Scoped HR', [PERM.org.view, PERM.org.edit, PERM.org.remove, PERM.positions.view, PERM.employees.view, PERM.employees.edit, PERM.hiring.view, PERM.hiring.edit, PERM.time.view, PERM.time.edit, PERM.roles.view, PERM.roles.edit, PERM.employeeCreate, PERM.employeeClose, PERM.contactView], 'DEPARTMENT');
    await db.query('UPDATE hrms_employees SET user_id = NULL WHERE id = ?', [E.head]);
    const scoped = await login('Scoped HR', scopedRole, E.head);
    forgetAccess();
    const d1 = await call(scoped, 'POST', '/organisation/departments', { name: `${TAG} New under sub`, parentId: D.sub });
    const d2 = await call(scoped, 'PUT', `/organisation/departments/${D.sub}`, { name: `${TAG} SUB renamed` });
    const dBad = [];
    for (const [method, url, body] of [
      ['POST', '/organisation/departments', { name: `${TAG} At the top` }], ['POST', '/organisation/departments', { name: `${TAG} Under other`, parentId: D.other }],
      ['PUT', `/organisation/departments/${D.root}`, { name: 'x' }], ['PUT', `/organisation/departments/${D.sub}`, { parentId: D.other }], ['PUT', `/organisation/departments/${D.sub}`, { parentId: null }],
      ['PUT', `/organisation/departments/${D.other}`, { name: 'x' }], ['DELETE', `/organisation/departments/${D.other}`], ['DELETE', `/organisation/departments/${D.root}`],
      ['POST', '/organisation/shifts', { code: 'ZZ', name: 'x' }], ['POST', '/organisation/department-labels', { name: `${TAG} label` }], ['POST', '/roles', { title: `${TAG} role`, status: 'ACTIVE' }],
      ['POST', '/people/employees', { fullName: `${TAG} Outright`, dateOfJoining: '2026-10-01' }], ['PUT', `/people/employees/${E.out}`, { fullName: 'x' }], ['POST', `/people/employees/${E.out}/exit`, {}],
      ['POST', `/positions/${P.hireOut}/hiring`, {}],
    ]) {
      const r = await call(scoped, method, url, body);
      if (!(r.status === 403 && r.json.code === 'OUT_OF_SCOPE')) dBad.push(`${method} ${url} ${r.status} ${r.json?.code ?? ''}`);
    }
    ok(d1.status === 200 && d2.status === 200 && dBad.length === 0,
      'a scoped role that may change departments: inside its tree yes; at the top, under another department, its OWN department, moving one out — and anything that belongs to the whole company (a shift, a label, a role, a person added outright) — 403 OUT_OF_SCOPE', `${d1.status} ${d2.status} | ${dBad.join('; ')}`);
    const h1 = await call(scoped, 'POST', `/positions/${P.hire}/hiring`, {});
    const hOwner = await call(U.OWNER, 'POST', `/positions/${P.hireOut}/hiring`, {});
    const hList = await call(scoped, 'GET', '/hirings');
    const hOut = await call(scoped, 'GET', `/hirings/${hOwner.json?.hiring?.id}`);
    ok(h1.status === 200 && hOwner.status === 200 && hList.status === 200 && hList.json.hirings.some((h) => h.id === h1.json.hiring.id) && hList.json.hirings.every((h) => [P.hire].includes(h.positionId) || [D.root, D.sub].includes(h.departmentId) || h.id === h1.json.hiring.id)
      && !hList.json.hirings.some((h) => h.id === hOwner.json.hiring.id) && hOut.status === 403 && hOut.json.code === 'OUT_OF_SCOPE',
    'hirings follow the position: started and listed inside the scope, and one on a position outside is neither listed nor opened', `${h1.status} ${hList.json?.hirings?.length} ${hOut.status}`);
    ok((await call(scoped, 'PUT', `/people/employees/${E.in}`, { fullName: `${TAG} Person IN edited` })).status === 200 && (await one('SELECT full_name FROM hrms_employees WHERE id = ?', [E.in])).full_name === `${TAG} Person IN edited`, 'an employee inside is changed');
    await db.query('UPDATE hrms_employees SET user_id = NULL WHERE id = ?', [E.head]);
    await db.query('UPDATE hrms_employees SET user_id = ? WHERE id = ?', [head.id, E.head]);
    forgetAccess();
  }

  /* ══ 6. pay and contact ═══════════════════════════════════════════════════ */
  section('[6] Pay and contact');
  {
    const noPay = await login('No pay', await customRole('No pay', [PERM.hiring.view, PERM.hiring.edit, PERM.setup.view, PERM.employees.view, PERM.employees.edit, PERM.contactView, PERM.employeeCreate]));
    const noContact = await login('No contact', await customRole('No contact', [PERM.hiring.view, PERM.hiring.edit, PERM.employees.view, PERM.employees.edit, PERM.payView]));
    forgetAccess();
    const started = (await HIRE.startHiring(db, c, P.vacOut)).hiring;
    await HIRE.confirmJd(db, c, started.id);
    await HIRE.updateHiring(db, c, started.id, {
      candidateSalutation: 'Ms.', candidateName: `${TAG} Candidate`, candidatePhone: '9000000000', candidateEmail: `${TAG.toLowerCase()}.cand@example.test`, candidateAddress: 'Flat 1,\nSample Street.',
      candidateDateOfBirth: '1995-04-03', proposedJoiningDate: '2027-01-10', offerValidUntil: '2026-12-31', annualCtc: 345678, designation: `${TAG} Operator`,
    });
    const H = started.id;
    const full = await call(U.HR_EXECUTIVE, 'GET', `/hirings/${H}`);
    const a = await call(noPay, 'GET', `/hirings/${H}`);
    const b = await call(noContact, 'GET', `/hirings/${H}`);
    ok(full.status === 200 && full.json.hiring.terms.annualCtc === 345678 && full.json.hiring.candidate.phone === '9000000000' && !('payHidden' in full.json.hiring) && !('contactHidden' in full.json.hiring) && full.json.hiring.can.generateOffer === true,
      'with pay and contact access a hiring carries the CTC and the candidate’s phone', JSON.stringify(full.json?.hiring?.terms)?.slice(0, 80));
    ok(a.status === 200 && a.json.hiring.terms.annualCtc === null && a.json.hiring.payHidden === true && a.json.hiring.can.generateOffer === false && a.json.hiring.candidate.phone === '9000000000' && a.json.hiring.terms.designation === `${TAG} Operator`
      && !JSON.stringify(a.json).includes('345678'), 'without pay access: annualCtc is null, payHidden is true, the offer letter is not theirs to make — and the number is nowhere in the answer');
    ok(b.status === 200 && b.json.hiring.candidate.phone === null && b.json.hiring.candidate.email === null && b.json.hiring.candidate.address === null && b.json.hiring.candidate.dateOfBirth === null && b.json.hiring.contactHidden === true
      && b.json.hiring.candidate.name === `${TAG} Candidate` && b.json.hiring.terms.annualCtc === 345678 && !JSON.stringify(b.json).includes('9000000000'),
    'without contact access: the candidate’s phone, email, address and date of birth are absent (contactHidden), the name and the pay are there');
    const row = () => one('SELECT annual_ctc, candidate_phone, candidate_email, candidate_address, designation FROM hrms_hirings WHERE id = ?', [H]);
    const put1 = await call(noPay, 'PUT', `/hirings/${H}`, { annualCtc: 1, terms: { annualCtc: 2 }, designation: `${TAG} Senior operator` });
    const after1 = await row();
    ok(put1.status === 200 && Number(after1.annual_ctc) === 345678 && after1.designation === `${TAG} Senior operator` && put1.json.hiring.terms.annualCtc === null,
      'a save from somebody without pay access does not touch the CTC (not set, not erased) and saves the rest', `${put1.status} ${after1.annual_ctc}`);
    const put1b = await call(noPay, 'PUT', `/hirings/${H}`, { annualCtc: null });
    ok(Number((await row()).annual_ctc) === 345678 && put1b.status === 200, '…nor does the blank a form was shown erase it');
    const put2 = await call(noContact, 'PUT', `/hirings/${H}`, { candidatePhone: null, candidateEmail: '', candidate: { address: 'gone' }, annualCtc: 400000 });
    const after2 = await row();
    ok(put2.status === 200 && after2.candidate_phone === '9000000000' && after2.candidate_email === `${TAG.toLowerCase()}.cand@example.test` && /Sample Street/.test(after2.candidate_address) && Number(after2.annual_ctc) === 400000,
      'a save from somebody without contact access leaves the candidate’s contact as it was, and may set the pay it can see');
    const gen = await call(noPay, 'POST', `/hirings/${H}/offer-letter`, {});
    ok(gen.status === 403 && gen.json.code === 'PAY_HIDDEN' && /access to pay/.test(gen.json.message) && Number((await one('SELECT COUNT(*) AS n FROM hrms_hiring_letters WHERE hiring_id = ?', [H])).n) === 0,
      'the offer letter cannot be generated without pay access: 403 PAY_HIDDEN, a plain sentence, nothing written', `${gen.status} ${gen.json?.message}`);
    const letter = await call(U.HR_EXECUTIVE, 'POST', `/hirings/${H}/offer-letter`, {});
    const letterId = letter.json?.hiring?.letters?.[0]?.id;
    if (letter.status === 200 && letterId) {
      const open = await call(U.HR_EXECUTIVE, 'GET', `/hirings/${H}/letters/${letterId}/file`);
      const shut = await call(noPay, 'GET', `/hirings/${H}/letters/${letterId}/file`);
      const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000050001a5f645400000000049454e44ae426082', 'hex').toString('base64');
      const up = await call(U.HR_EXECUTIVE, 'PUT', `/hirings/${H}/signed/offer`, { fileName: 'signed.png', contentBase64: png });
      const signedShut = await call(noPay, 'GET', `/hirings/${H}/signed/offer/file`);
      const signedUp = await call(noPay, 'PUT', `/hirings/${H}/signed/offer`, { fileName: 'signed.png', contentBase64: png });
      const signedDel = await call(noPay, 'DELETE', `/hirings/${H}/signed/offer`);
      ok(open.status === 200 && typeof open.json.contentBase64 === 'string' && shut.status === 403 && shut.json.code === 'PAY_HIDDEN' && up.status === 200
        && signedShut.status === 403 && signedUp.status === 403 && signedDel.status === 403 && (await call(U.HR_EXECUTIVE, 'GET', `/hirings/${H}/signed/offer/file`)).status === 200,
      'the letter and its signed copy open with pay access; without it the letter, the signed copy, its upload and its removal are all 403 PAY_HIDDEN', `${open.status} ${shut.status} ${up.status} ${signedShut.status}`);
      const listed = await call(noPay, 'GET', `/hirings/${H}`);
      ok(listed.json.hiring.letters.length === 1 && listed.json.hiring.terms.annualCtc === null && !JSON.stringify(listed.json).includes('400000') && !JSON.stringify(listed.json).includes('4,00,000'), 'the hiring still lists that a letter exists — its name and date, not its content');
    } else skip('letters and signed copies', `the offer letter could not be generated here (${letter.status} ${letter.json?.message ?? ''})`);
    const tplShut = await call(noPay, 'GET', '/hiring/templates/offer/file');
    ok(tplShut.status === 403 && tplShut.json.code === 'PAY_HIDDEN' && (await call(noPay, 'GET', '/hiring/templates')).status === 200, 'a letter template’s file is not downloaded without pay access; the list of templates is');
    const hidden = await call(noPay, 'GET', '/hirings');
    ok(hidden.status === 200 && hidden.json.hirings.every((h) => !('annualCtc' in h) && !('candidatePhone' in h)), 'the list of hirings carries neither pay nor contact for anybody');

    // employees
    const l1 = await call(noContact, 'GET', '/people/employees?status=ALL&limit=2000');
    const l2 = await call(noPay, 'GET', '/people/employees?status=ALL&limit=2000');
    const mineOf = (r) => r.json.items.find((i) => i.id === E.out);
    ok(l1.status === 200 && l1.json.items.every((i) => i.phone === null && i.email === null && i.dateOfBirth === null && i.contactHidden === true) && mineOf(l1).fullName === `${TAG} Person OUT` && mineOf(l2).phone === '9100000004' && !('contactHidden' in mineOf(l2)),
      'the employees list: without contact access every row has phone, email and date of birth removed (contactHidden); with it they are there');
    const g1 = await call(noContact, 'GET', `/people/employees/${E.out}`);
    const g1c = await call(noContact, 'GET', `/people/employees/${E.out}?contact=1`);
    const g2 = await call(noPay, 'GET', `/people/employees/${E.out}`);
    ok(g1.status === 200 && g1.json.employee.phone === null && g1.json.employee.email === null && g1.json.contact === 'HIDDEN' && g1c.json.employee.phone === null && g2.json.employee.phone === '9100000004' && !JSON.stringify(g1.json).includes('9100000004'),
      'one employee: removed on the server with or without ?contact=1 — the plain read no longer hands phone and email to everybody who may see employees');
    const s1 = await call(noContact, 'GET', '/people/employees?status=ALL&search=9100000004');
    const s2 = await call(noPay, 'GET', '/people/employees?status=ALL&search=9100000004');
    const s3 = await call(noContact, 'GET', `/people/employees?status=ALL&search=${encodeURIComponent(`${TAG} Person OUT`)}`);
    ok(s1.json.items.length === 0 && s2.json.items.length === 1 && s3.json.items.length === 1, 'the search box does not match a phone number for somebody who cannot see phone numbers (it would say whose it is); a name still finds the person');
    const e1 = await call(noContact, 'PUT', `/people/employees/${E.out}`, { fullName: `${TAG} Person OUT renamed`, phone: null, email: '', address: { city: 'x' } });
    const eRow = await one('SELECT full_name, phone, email FROM hrms_employees WHERE id = ?', [E.out]);
    ok(e1.status === 200 && eRow.full_name === `${TAG} Person OUT renamed` && eRow.phone === '9100000004' && eRow.email && e1.json.employee?.phone == null,
      'a save from somebody without contact access changes the name and leaves the phone and email as they were', `${e1.status} ${eRow.phone}`);
    const ident = await call(noContact, 'POST', `/people/employees/${E.out}/identifiers`, { identifierType: 'PAN', identifierValue: 'ABCDE1234F' });
    const identList = await call(noContact, 'GET', `/people/employees/${E.out}/identifiers?reveal=1`);
    ok(ident.status === 403 && ident.json.code === 'CONTACT_HIDDEN' && identList.status === 200 && identList.json.canSeePii === false, 'statutory identifiers: listed masked, and not written, without contact access', `${ident.status} ${ident.json?.code}`);

    // an employee's filed papers
    ok(isPayPaper('APPOINTMENT_LETTER') && isPayPaper('Signed appointment letter') && isPayPaper('Offer letter') && isPayPaper('CONTRACT') && !isPayPaper('EDUCATION_CERTIFICATE') && isIdentityPaper('AADHAAR') && isIdentityPaper('PAN') && isIdentityPaper('Driving licence') && !isIdentityPaper('EXPERIENCE_CERTIFICATE') && !isIdentityPaper('Company policy'),
      'papers are told apart by their type: an appointment letter shows pay, an Aadhaar or PAN scan shows the number');
    const tiny = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000050001a5f645400000000049454e44ae426082', 'hex').toString('base64');
    const paper = async (documentType) => (await PEOPLE.addDocument(db, c, E.out, { documentType, title: documentType, fileName: 'p.png', mimeType: 'image/png', dataBase64: tiny })).id;
    const docs = { pan: await paper('PAN'), appointment: await paper('APPOINTMENT_LETTER'), education: await paper('EDUCATION_CERTIFICATE') };
    const open = async (who, id) => { const r = await call(who, 'GET', `/people/documents/${id}/file`); return r.status === 403 ? r.json.code : r.status; };
    const got = { noContact: [await open(noContact, docs.pan), await open(noContact, docs.appointment), await open(noContact, docs.education)], noPay: [await open(noPay, docs.pan), await open(noPay, docs.appointment), await open(noPay, docs.education)], both: [await open(U.HR_EXECUTIVE, docs.pan), await open(U.HR_EXECUTIVE, docs.appointment)] };
    ok(JSON.stringify(got) === JSON.stringify({ noContact: ['CONTACT_HIDDEN', 200, 200], noPay: [200, 'PAY_HIDDEN', 200], both: [200, 200] }),
      'opening a filed paper: a PAN scan needs contact access, an appointment letter pay access, a certificate neither', JSON.stringify(got));
    ok((await call(noContact, 'GET', `/people/employees/${E.out}/documents`)).status === 200, 'the list of a person’s papers (names and dates) is open to anybody who may see employees');
  }

  /* ══ 7. access roles ══════════════════════════════════════════════════════ */
  section('[7] Access roles');
  let madeRoleId = null;
  {
    const list = await call(U.OWNER, 'GET', '/access/roles');
    const five = list.json.roles.filter((r) => r.templateKey);
    ok(list.status === 200 && JSON.stringify(five.map((r) => r.templateKey)) === JSON.stringify(['OWNER', 'HR_MANAGER', 'HR_EXECUTIVE', 'DEPARTMENT_HEAD', 'EMPLOYEE'])
      && JSON.stringify(Object.keys(five[0])) === JSON.stringify(['roleId', 'label', 'platformName', 'description', 'scope', 'templateKey', 'locked', 'tags', 'loginCount', 'summary'])
      && five[0].label === 'Owner' && five[0].platformName === 'admin' && five[0].locked === true && five[4].locked === true && five[1].locked === false && five[3].scope === 'DEPARTMENT'
      && five[2].summary === 'Sees everything · changes positions, employees, hiring, documents, performance, payroll and attendance · cannot remove · creates employees and sees pay' && five.every((r) => typeof r.loginCount === 'number'),
    'GET /access/roles: the five ready-made roles first, each { roleId, label, platformName, description, scope, templateKey, locked, tags, loginCount, summary }', JSON.stringify(five.map((r) => r.templateKey)));
    const [[dhRow]] = await db.query('SELECT label FROM hrms_access_roles WHERE company_id = ? AND role_id = ? AND deleted_at IS NULL', [COMPANY, five[3].roleId]);
    const cat = await call(U.OWNER, 'GET', '/access/catalog');
    ok(five[3].label === 'Unit head' && five[3].platformName === 'Department head' && dhRow?.label === 'Department head'
      && cat.status === 200 && cat.json.templates?.find((t) => t.key === 'DEPARTMENT_HEAD')?.label === 'Unit head',
      'spec §33: the ready-made DEPARTMENT_HEAD shows as "Unit head" (list and catalog); its platform role and stored label stay "Department head"', JSON.stringify({ label: five[3].label, platformName: five[3].platformName, stored: dhRow?.label, cat: cat.status }));

    const made = await call(U.OWNER, 'POST', '/access/roles', { label: `  ${TAG}  Payroll clerk `, description: 'Reads people and pay.', scope: 'COMPANY', copyFrom: 'HR_EXECUTIVE' });
    madeRoleId = made.json?.role?.roleId;
    ok(made.status === 200 && made.json.role.label === `${TAG} Payroll clerk` && made.json.role.platformName === `${TAG} Payroll clerk` && same(made.json.role.tags, TEMPLATES[2].tags) && made.json.role.templateKey === null && made.json.role.locked === false && made.json.role.loginCount === 0,
      'POST /access/roles copies a ready-made role by its key: a new platform role of that name with the same rights');
    const copy = await call(U.OWNER, 'POST', '/access/roles', { label: `${TAG} Clerk two`, scope: 'DEPARTMENT', copyFrom: madeRoleId });
    const empty = await call(U.OWNER, 'POST', '/access/roles', { label: `${TAG} Empty`, scope: 'COMPANY' });
    ok(copy.status === 200 && same(copy.json.role.tags, made.json.role.tags) && copy.json.role.scope === 'DEPARTMENT' && empty.status === 200 && empty.json.role.tags.length === 0 && empty.json.role.summary === 'Sees nothing',
      '…or an existing role by its id; with no copyFrom it starts with nothing');
    const bad = [];
    for (const [what, body, status, code] of [
      ['no name', { scope: 'COMPANY' }, 422, 'INVALID'], ['the name admin', { label: 'Admin', scope: 'COMPANY' }, 422, 'INVALID'], ['the name Owner', { label: 'owner', scope: 'COMPANY' }, 422, 'INVALID'],
      ['a scope nobody knows', { label: `${TAG} x`, scope: 'TEAM' }, 422, 'INVALID'], ['a name already used', { label: `${TAG} payroll CLERK`, scope: 'COMPANY' }, 409, 'DUPLICATE'],
      ['the label of a ready-made role', { label: 'hr manager', scope: 'COMPANY' }, 409, 'DUPLICATE'], ['a copy of nothing', { label: `${TAG} y`, scope: 'COMPANY', copyFrom: NONE }, 404, 'NOT_FOUND'],
      ['a copy of the Owner', { label: `${TAG} o1`, scope: 'COMPANY', copyFrom: 'OWNER' }, 422, 'INVALID'], ['a copy of the Owner by its id', { label: `${TAG} o2`, scope: 'COMPANY', copyFrom: roleIdOf.OWNER }, 422, 'INVALID'], ['a copy of Employee', { label: `${TAG} o3`, scope: 'COMPANY', copyFrom: 'EMPLOYEE' }, 422, 'INVALID'],
    ]) { const r = await call(U.OWNER, 'POST', '/access/roles', body); if (r.status !== status || r.json.code !== code) bad.push(`${what}: ${r.status} ${r.json?.code}`); }
    ok(bad.length === 0, 'refused: no name, "admin" or "owner" (the platform’s own names), an unknown scope: 422; a name or label already used: 409; a copy of a role that does not exist: 404', bad.join('; '));

    const grantsOf = () => q('SELECT rc.capability_id, rc.company_id, rc.app_id, rc.team_id FROM role_capability rc WHERE rc.role_id = ? AND rc.deleted_at IS NULL', [madeRoleId]);
    const put = await call(U.OWNER, 'PUT', `/access/roles/${madeRoleId}`, { label: `${TAG} Payroll`, scope: 'DEPARTMENT', tags: [PERM.employees.view, PERM.payView, PERM.employees.view] });
    const rowsNow = await grantsOf();
    ok(put.status === 200 && same(put.json.role.tags, [PERM.employees.view, PERM.payView]) && put.json.role.label === `${TAG} Payroll` && put.json.role.platformName === `${TAG} Payroll clerk` && put.json.role.scope === 'DEPARTMENT' && put.json.loginsAffected === 0
      && rowsNow.length === 2 && rowsNow.every((r) => r.company_id === COMPANY && r.app_id === app.id && r.team_id === null),
    'PUT with `tags` REPLACES the rights: two grant rows are left, for this company and this app; the label changes, the platform role’s name does not', JSON.stringify(put.json?.role?.tags));
    await call(U.OWNER, 'PUT', `/access/roles/${madeRoleId}`, { tags: [PERM.employees.view, PERM.payView] });
    await call(U.OWNER, 'PUT', `/access/roles/${madeRoleId}`, { tags: [PERM.employees.view, PERM.payView, PERM.contactView] });
    const dup = await q('SELECT capability_id, COUNT(*) AS n FROM role_capability WHERE role_id = ? AND deleted_at IS NULL GROUP BY capability_id HAVING n > 1', [madeRoleId]);
    ok(dup.length === 0 && (await grantsOf()).length === 3, 'saved again and again: never a grant twice');
    const invalid = [];
    for (const [what, tags, pattern] of [
      ['edit without view', [PERM.positions.edit], /Positions.*needs “view”/], ['remove and upload without view', [PERM.org.remove, PERM.org.upload], /Organisation/], ['an old tag', [PERM.employees.view, 'cf_hrms_people_manage'], /not a right/],
      ['a tag of another app', ['cf_erp_view'], /not a right/], ['not a list', 'cf_hrms_org_view', /list/],
    ]) { const r = await call(U.OWNER, 'PUT', `/access/roles/${madeRoleId}`, { tags }); if (r.status !== 422 || r.json.code !== 'INVALID' || !pattern.test(r.json.problems?.join(' ') ?? '')) invalid.push(`${what}: ${r.status} ${JSON.stringify(r.json?.problems)}`); }
    ok(invalid.length === 0 && (await grantsOf()).length === 3, 'a set that means nothing is 422 INVALID in words — edit without view, an old tag, another app’s tag — and the role keeps what it had', invalid.join('; '));

    const lockedPut = await call(U.OWNER, 'PUT', `/access/roles/${roleIdOf.OWNER}`, { tags: [PERM.org.view] });
    const lockedPut2 = await call(U.OWNER, 'PUT', `/access/roles/${roleIdOf.OWNER}`, { scope: 'DEPARTMENT' });
    const lockedDel = await call(U.OWNER, 'DELETE', `/access/roles/${roleIdOf.OWNER}`);
    const lockedDel2 = await call(U.OWNER, 'DELETE', `/access/roles/${roleIdOf.EMPLOYEE}`);
    ok(lockedPut.status === 409 && lockedPut.json.code === 'LOCKED' && lockedPut2.status === 409 && lockedDel.status === 409 && lockedDel.json.code === 'LOCKED' && lockedDel2.status === 409 && lockedDel2.json.code === 'LOCKED'
      && same((await call(U.OWNER, 'GET', '/access/me')).json.tags, ALL_TAGS), 'the Owner cannot be changed (409 LOCKED: its rights, its scope); the Owner and Employee cannot be deleted', `${lockedPut.status} ${lockedDel.status} ${lockedDel2.status}`);
    const inUse = await call(U.OWNER, 'DELETE', `/access/roles/${roleIdOf.HR_MANAGER}`);
    ok(inUse.status === 409 && inUse.json.code === 'IN_USE' && inUse.json.detail.logins.length === 1 && inUse.json.detail.logins[0].userId === U.HR_MANAGER.id && /Move it/.test(inUse.json.message),
      'deleting a role a login is on: 409 IN_USE, with the logins holding it', `${inUse.status} ${JSON.stringify(inUse.json?.detail)?.slice(0, 100)}`);
    const gone = await call(U.OWNER, 'DELETE', `/access/roles/${copy.json.role.roleId}`);
    ok(gone.status === 200 && (await one('SELECT deleted_at FROM roles WHERE id = ?', [copy.json.role.roleId])).deleted_at !== null && Number((await one('SELECT COUNT(*) AS n FROM role_capability WHERE role_id = ? AND deleted_at IS NULL', [copy.json.role.roleId])).n) === 0
      && (await call(U.OWNER, 'DELETE', `/access/roles/${copy.json.role.roleId}`)).status === 404, 'a role nobody is on is deleted with its grants; twice is 404');

    // who may give what
    const delegateRole = await customRole('Access clerk', [PERM.accessManage, PERM.employees.view, PERM.positions.view]);
    const delegate = await login('Access clerk', delegateRole);
    forgetAccess();
    const g1 = await call(delegate, 'PUT', `/access/roles/${madeRoleId}`, { tags: [PERM.employees.view, PERM.payView, PERM.contactView, PERM.positions.view] });
    const g2 = await call(delegate, 'PUT', `/access/roles/${madeRoleId}`, { tags: [PERM.employees.view, PERM.payView, PERM.contactView, PERM.hiring.view] });
    const g3 = await call(delegate, 'POST', '/access/roles', { label: `${TAG} Sneaky`, scope: 'COMPANY', copyFrom: 'HR_MANAGER' });
    const g4 = await call(delegate, 'PUT', `/access/logins/${delegate.id}`, { roleId: roleIdOf.OWNER });
    const g5 = await call(delegate, 'PUT', `/access/logins/${U.EMPLOYEE.id}`, { roleId: roleIdOf.OWNER });
    const g6 = await call(delegate, 'PUT', `/access/logins/${U.EMPLOYEE.id}`, { roleId: roleIdOf.HR_MANAGER });
    const g7 = await call(delegate, 'POST', `/access/logins/${U.OWNER.id}/reset-password`);
    const g8 = await call(delegate, 'POST', `/access/logins/${U.OWNER.id}/disable`);
    const g9 = await call(delegate, 'POST', `/access/logins/${U.HR_MANAGER.id}/reset-password`);
    const g10 = await call(delegate, 'PUT', `/access/roles/${delegateRole}`, { tags: [PERM.employees.view, PERM.positions.view] });
    const g11 = await call(delegate, 'PUT', `/access/logins/${U.OWNER.id}`, { email: `${TAG.toLowerCase()}.taken@example.test` });
    ok(g1.status === 200 && g2.status === 403 && g2.json.code === 'CANNOT_GRANT' && g3.status === 403 && g3.json.code === 'CANNOT_GRANT',
      'somebody trusted with logins (not an Owner) may add a right they hold to a role — and may NOT add one they do not hold, nor copy a role that holds more than they do (403 CANNOT_GRANT)', `${g1.status} ${g2.status} ${g2.json?.code} ${g3.status}`);
    ok(g4.status === 403 && g5.status === 403 && g5.json.code === 'OWNER_ONLY' && g6.status === 403 && g6.json.code === 'CANNOT_GRANT'
      && (await one('SELECT role_id FROM app_user_access WHERE user_id = ? AND app_id = ?', [U.EMPLOYEE.id, app.id])).role_id === roleIdOf.EMPLOYEE,
    'they cannot make themselves or anybody an Owner (403 OWNER_ONLY), nor put a login on a role that holds more than they do', `${g4.status} ${g4.json?.code} ${g5.status} ${g6.status} ${g6.json?.code}`);
    ok(g7.status === 403 && g7.json.code === 'OWNER_ONLY' && g8.status === 403 && g11.status === 403 && g9.status === 403 && g9.json.code === 'CANNOT_GRANT' && (await one('SELECT password FROM users WHERE id = ?', [U.OWNER.id])).password !== 'x',
      'they cannot reset an Owner’s password, disable an Owner or change an Owner’s email — nor reset the password of a login that holds more than they do (that is signing in as them)', `${g7.status} ${g8.status} ${g9.status} ${g9.json?.code} ${g11.status}`);
    ok(g10.status === 409 && g10.json.code === 'SELF_LOCKOUT' && (await call(delegate, 'GET', '/access/roles')).status === 200, 'and they cannot take "manage logins and access" away from their own role (409 SELF_LOCKOUT)', `${g10.status} ${g10.json?.code}`);
  }

  /* ══ 8. logins ════════════════════════════════════════════════════════════ */
  section('[8] Logins');
  {
    const list = await call(U.OWNER, 'GET', '/access/logins');
    const me = list.json.logins.find((l) => l.userId === U.OWNER.id);
    const dh = list.json.logins.find((l) => l.userId === U.DEPARTMENT_HEAD.id);
    ok(list.status === 200 && JSON.stringify(Object.keys(dh)) === JSON.stringify(['userId', 'name', 'email', 'role', 'state', 'employee', 'isYou']) && me.isYou === true && dh.isYou === false && me.role.label === 'Owner'
      && dh.role.id === roleIdOf.DEPARTMENT_HEAD && dh.role.label === 'Unit head' && dh.state === 'ACTIVE'
      && JSON.stringify(dh.employee) === JSON.stringify({ id: E.head, employeeCode: `${TAG}HEAD`, fullName: `${TAG} Person HEAD`, positionCode: `${TAG}-HEAD`, departmentName: `${TAG} ROOT` }),
    'GET /access/logins -> { logins: [{ userId, name, email, role: { id, label }, state, employee: { id, employeeCode, fullName, positionCode, departmentName } | null, isYou }], withoutLogin }', JSON.stringify(dh));
    const without = list.json.withoutLogin.find((w) => w.employeeId === E.out);
    ok(JSON.stringify(without) === JSON.stringify({ employeeId: E.out, employeeCode: `${TAG}OUT`, name: `${TAG} Person OUT renamed`, positionCode: `${TAG}-OUT`, roleTitle: `${TAG} Operator` })
      && !list.json.withoutLogin.some((w) => w.employeeId === E.head) && new Set(list.json.logins.map((l) => l.userId)).size === list.json.logins.length && !JSON.stringify(list.json).includes('password'),
    'withoutLogin: the employees who have none — { employeeId, employeeCode, name, positionCode, roleTitle }; nobody is listed twice; no password or hash anywhere in the answer', JSON.stringify(without));
    const filtered = await call(U.OWNER, 'GET', `/access/logins?roleId=${roleIdOf.DEPARTMENT_HEAD}&state=ACTIVE&q=${encodeURIComponent(TAG.toLowerCase())}`);
    ok(filtered.json.logins.length >= 1 && filtered.json.logins.every((l) => l.role.id === roleIdOf.DEPARTMENT_HEAD && l.state === 'ACTIVE'), '?q=&roleId=&state= narrow the list');

    const auditBefore = Number((await one('SELECT COALESCE(MAX(id), 0) AS n FROM hrms_audit_log')).n);
    const email = `${TAG.toLowerCase()}.new.login@example.test`;
    const made = await call(U.OWNER, 'POST', '/access/logins', { employeeId: E.out, email: `  ${email.toUpperCase()} `, roleId: roleIdOf.HR_EXECUTIVE });
    const pw = made.json?.password;
    const userRow = made.json?.login ? await one('SELECT id, name, email, password, role_id, company_id, team_id FROM users WHERE id = ?', [made.json.login.userId]) : null;
    ok(made.status === 200 && typeof pw === 'string' && pw.length === 16 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw) && /[@#%+=?]/.test(pw) && !/[0O1lI]/.test(pw),
      'POST /access/logins -> { login, password }: a generated password — 16 characters, a capital, a small letter, a digit and a sign, no look-alikes');
    ok(userRow && userRow.email === email && userRow.name === `${TAG} Person OUT renamed` && userRow.role_id === roleIdOf.HR_EXECUTIVE && userRow.company_id === COMPANY && /^\$2[aby]\$10\$/.test(userRow.password) && userRow.password !== pw
      && await bcrypt.compare(pw, userRow.password) && !(await bcrypt.compare(`${pw}x`, userRow.password)),
    'stored as the platform stores every password: a bcrypt hash at cost 10 that the returned password verifies against — never the password itself');
    const accessRow = userRow ? await one('SELECT role_id, company_id, deleted_at FROM app_user_access WHERE user_id = ? AND app_id = ?', [userRow.id, app.id]) : null;
    ok(accessRow?.role_id === roleIdOf.HR_EXECUTIVE && accessRow.company_id === COMPANY && accessRow.deleted_at === null && (await one('SELECT user_id FROM hrms_employees WHERE id = ?', [E.out])).user_id === userRow.id
      && made.json.login.state === 'ACTIVE' && made.json.login.employee.id === E.out && made.json.login.role.label === 'HR executive',
    'the login is on the role in BOTH places (the user and this app’s access row), has access to the app, and is linked to the employee');
    const auditRows = await q('SELECT entity_type, action, before_json, after_json FROM hrms_audit_log WHERE id > ?', [auditBefore]);
    ok(auditRows.length >= 1 && auditRows.every((r) => !JSON.stringify(r).includes(pw) && !JSON.stringify(r).includes(userRow.password)) && auditRows.some((r) => r.entity_type === 'users' && r.action === 'CREATE'),
      'the audit log says a login was created — and holds neither the password nor its hash');
    const fresh = { id: userRow.id, token: signToken({ id: userRow.id, email, role: 'HR executive', company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
    ok((await call(fresh, 'GET', '/positions/options')).status === 200 && !JSON.stringify((await call(U.OWNER, 'GET', '/access/logins')).json).includes(pw), 'the new login works at once; the password is in the answer that made it and in no later one');
    const again = [];
    for (const [what, body, status, code] of [
      ['an employee who has a login', { employeeId: E.out, email: `${TAG.toLowerCase()}.other@example.test`, roleId: roleIdOf.EMPLOYEE }, 409, 'HAS_LOGIN'],
      ['an email that has a login', { employeeId: E.none, email, roleId: roleIdOf.EMPLOYEE }, 409, 'DUPLICATE'], ['an email that is not one', { employeeId: E.none, email: 'nobody', roleId: roleIdOf.EMPLOYEE }, 422, 'INVALID'],
      ['no role', { employeeId: E.none, email: `${TAG.toLowerCase()}.z@example.test` }, 422, 'INVALID'], ['a role that does not exist', { employeeId: E.none, email: `${TAG.toLowerCase()}.z@example.test`, roleId: NONE }, 404, 'NOT_FOUND'],
      ['an employee that does not exist', { employeeId: NONE, email: `${TAG.toLowerCase()}.z@example.test`, roleId: roleIdOf.EMPLOYEE }, 404, 'NOT_FOUND'], ['no employee', { email: `${TAG.toLowerCase()}.z@example.test`, roleId: roleIdOf.EMPLOYEE }, 422, 'INVALID'],
    ]) { const r = await call(U.OWNER, 'POST', '/access/logins', body); if (r.status !== status || r.json.code !== code) again.push(`${what}: ${r.status} ${r.json?.code}`); }
    ok(again.length === 0, 'refused: an employee who already has a login (409 HAS_LOGIN), an email already used (409), a bad email or no role (422), a role or employee that does not exist (404)', again.join('; '));

    // change
    const changed = await call(U.OWNER, 'PUT', `/access/logins/${userRow.id}`, { roleId: roleIdOf.DEPARTMENT_HEAD });
    const both = await one('SELECT u.role_id AS a, aua.role_id AS b FROM users u JOIN app_user_access aua ON aua.user_id = u.id AND aua.app_id = ? WHERE u.id = ?', [app.id, userRow.id]);
    ok(changed.status === 200 && changed.json.login.role.id === roleIdOf.DEPARTMENT_HEAD && both.a === roleIdOf.DEPARTMENT_HEAD && both.b === roleIdOf.DEPARTMENT_HEAD && (await call(fresh, 'GET', '/hirings')).status === 403,
      'PUT /access/logins/:userId { roleId } sets BOTH users.role_id and this app’s access row — and counts on the next call');
    // the two columns drifted apart: this app's row is what counts, and saving brings the other back
    await db.query('UPDATE users SET role_id = ? WHERE id = ?', [roleIdOf.HR_MANAGER, userRow.id]);
    forgetAccess();
    const drift = (await call(U.OWNER, 'GET', '/access/logins')).json.logins.find((l) => l.userId === userRow.id);
    const stillHead = await call(fresh, 'GET', '/hirings');
    const aligned = await call(U.OWNER, 'PUT', `/access/logins/${userRow.id}`, { roleId: roleIdOf.DEPARTMENT_HEAD });
    ok(drift.role.id === roleIdOf.DEPARTMENT_HEAD && stillHead.status === 403 && aligned.status === 200 && (await one('SELECT role_id FROM users WHERE id = ?', [userRow.id])).role_id === roleIdOf.DEPARTMENT_HEAD,
      'a login whose company role and app role differ: this app goes by its own access row (shown, and enforced), and saving the role sets the other to match');
    const mail = await call(U.OWNER, 'PUT', `/access/logins/${userRow.id}`, { email: `${TAG.toLowerCase()}.renamed@example.test` });
    const mailTaken = await call(U.OWNER, 'PUT', `/access/logins/${userRow.id}`, { email: U.HR_MANAGER.email });
    ok(mail.status === 200 && mail.json.login.email === `${TAG.toLowerCase()}.renamed@example.test` && mailTaken.status === 409 && mailTaken.json.code === 'DUPLICATE' && (await call(U.OWNER, 'PUT', `/access/logins/${NONE}`, { roleId: roleIdOf.EMPLOYEE })).status === 404,
      'the email can be changed, not to one that has a login; a login that does not exist is 404');

    // reset
    const hashBefore = (await one('SELECT password FROM users WHERE id = ?', [userRow.id])).password;
    const reset = await call(U.OWNER, 'POST', `/access/logins/${userRow.id}/reset-password`);
    const hashAfter = (await one('SELECT password FROM users WHERE id = ?', [userRow.id])).password;
    ok(reset.status === 200 && JSON.stringify(Object.keys(reset.json)) === JSON.stringify(['password']) && reset.json.password.length === 16 && reset.json.password !== pw && hashAfter !== hashBefore
      && await bcrypt.compare(reset.json.password, hashAfter) && !(await bcrypt.compare(pw, hashAfter)), 'reset-password -> { password }: a new one, returned once; the old one no longer verifies');
    ok(new Set(Array.from({ length: 50 }, () => ACCESS.makePassword())).size === 50, 'fifty generated passwords are fifty different passwords');

    // disable / enable
    const off = await call(U.OWNER, 'POST', `/access/logins/${userRow.id}/disable`);
    const offAgain = await call(U.OWNER, 'POST', `/access/logins/${userRow.id}/disable`);
    const rowOff = await one('SELECT deleted_at FROM app_user_access WHERE user_id = ? AND app_id = ?', [userRow.id, app.id]);
    const listedOff = (await call(U.OWNER, 'GET', '/access/logins?state=DISABLED')).json.logins.find((l) => l.userId === userRow.id);
    ok(off.status === 200 && off.json.login.state === 'DISABLED' && offAgain.status === 200 && rowOff.deleted_at !== null && listedOff?.role.id === roleIdOf.DEPARTMENT_HEAD && (await one('SELECT deleted_at FROM users WHERE id = ?', [userRow.id])).deleted_at === null,
      'disable removes this app’s access row and nothing else — the user stays, and the login is still listed, as DISABLED, with its role');
    const on = await call(U.OWNER, 'POST', `/access/logins/${userRow.id}/enable`);
    ok(on.status === 200 && on.json.login.state === 'ACTIVE' && Number((await one('SELECT COUNT(*) AS n FROM app_user_access WHERE user_id = ? AND app_id = ?', [userRow.id, app.id])).n) === 1 && (await call(fresh, 'GET', '/access/me')).status === 200,
      'enable restores the same row (never a second one)');
    await call(U.OWNER, 'POST', `/access/logins/${userRow.id}/disable`);
    await db.query("UPDATE hrms_employees SET employment_status = 'EXITED' WHERE id = ?", [E.out]);
    const leftOn = await call(U.OWNER, 'POST', `/access/logins/${userRow.id}/enable`);
    ok(leftOn.status === 409 && leftOn.json.code === 'EMPLOYEE_LEFT', 'the login of somebody who has left stays disabled (409 EMPLOYEE_LEFT)', `${leftOn.status} ${leftOn.json?.code}`);

    // the last Owner, and yourself
    const owners = Number((await one("SELECT COUNT(*) AS n FROM app_user_access aua JOIN roles r ON r.id = aua.role_id WHERE aua.company_id = ? AND aua.app_id = ? AND aua.deleted_at IS NULL AND LOWER(r.name) = 'admin'", [COMPANY, app.id])).n);
    const selfDisable = await call(U.OWNER, 'POST', `/access/logins/${U.OWNER.id}/disable`);
    const selfDemote = await call(U.OWNER, 'PUT', `/access/logins/${U.OWNER.id}`, { roleId: roleIdOf.HR_MANAGER });
    if (owners === 1) {
      ok(selfDisable.status === 409 && selfDisable.json.code === 'LAST_OWNER' && selfDemote.status === 409 && selfDemote.json.code === 'LAST_OWNER', 'the only Owner cannot be disabled or demoted (409 LAST_OWNER) — not even by themselves', `${selfDisable.json?.code} ${selfDemote.json?.code}`);
    } else skip('the last Owner', `this company has ${owners} Owners`);
    const third = await login('Third owner', roleIdOf.OWNER);
    forgetAccess();
    const selfDisable2 = await call(U.OWNER, 'POST', `/access/logins/${U.OWNER.id}/disable`);
    const selfDemote2 = await call(U.OWNER, 'PUT', `/access/logins/${U.OWNER.id}`, { roleId: roleIdOf.HR_MANAGER });
    ok(selfDisable2.status === 409 && selfDisable2.json.code === 'SELF' && selfDemote2.status === 409 && selfDemote2.json.code === 'SELF' && (await call(U.OWNER, 'GET', '/access/roles')).status === 200,
      'with another Owner present, nobody disables themselves or changes their own role (409 SELF)', `${selfDisable2.json?.code} ${selfDemote2.json?.code}`);
    const demoteOther = await call(U.OWNER, 'PUT', `/access/logins/${third.id}`, { roleId: roleIdOf.HR_MANAGER });
    ok(demoteOther.status === 200 && demoteOther.json.login.role.label === 'HR manager', 'an Owner may demote ANOTHER Owner while one remains');
    // …and the guard itself, where the request could not otherwise reach it
    const lastErr = await caught(() => ACCESS.disableLogin(db, { companyId: COMPANY, userId: third.id }, U.OWNER.id));
    ok(lastErr?.status === 403 && lastErr.code === 'OWNER_ONLY', 'somebody who is no longer an Owner cannot disable the Owner (403 OWNER_ONLY)', why(lastErr));
  }

  /* ══ 9. the generic API ═══════════════════════════════════════════════════ */
  section('[9] The generic API (/api/query/v1/base_resource)');
  {
    const gen = (who, body) => call(who, 'POST', '/query/v1/base_resource', body, { raw: true });
    const NINE = ['users', 'teams', 'companies', 'apps', 'roles', 'features', 'features_capability', 'role_capability', 'app_user_access'];
    for (const [label, who] of [['an Employee login', U.EMPLOYEE], ['an HR manager (not an administrator)', U.HR_MANAGER]]) {
      const wrong = [];
      for (const resource of NINE) {
        for (const body of [{ operation: 'insert', resource, data: { name: `${TAG} x`, user_id: who.id, role_id: roleIdOf.OWNER, capability_id: 1, app_id: app.id, feature_tag: `${TAG}_x`, features_json: '[1]', email: `${TAG}@x.test`, password: 'p', slug: `${TAG}x` } },
          { operation: 'update', resource, id: NONE, data: { name: 'x', role_id: roleIdOf.OWNER, password: 'p', features_json: '[1]' } }, { operation: 'delete', resource, data: { id: NONE } }]) {
          const r = await gen(who, body);
          if (r.status !== 403 || !/administrator/.test(r.json?.error ?? '')) wrong.push(`${body.operation} ${resource} ${r.status}`);
        }
      }
      ok(wrong.length === 0, `${label} cannot insert, update or delete any of the nine access tables through it (27 calls, all 403 "Only an administrator…")`, wrong.join('; '));
    }
    // The three things that were possible before: take the admin role, set anybody's password, grant your role a capability.
    const mine = () => one('SELECT role_id, password FROM users WHERE id = ?', [U.EMPLOYEE.id]);
    const snap = await mine();
    const a1 = await gen(U.EMPLOYEE, { operation: 'update', resource: 'users', id: U.EMPLOYEE.id, data: { role_id: roleIdOf.OWNER } });
    const a2 = await gen(U.EMPLOYEE, { operation: 'update', resource: 'users', id: U.OWNER.id, data: { password: 'taken-over' } });
    const a3 = await gen(U.EMPLOYEE, { operation: 'insert', resource: 'role_capability', data: { role_id: roleIdOf.EMPLOYEE, capability_id: catalogRows.byTag.get(PERM.accessManage).capabilityId } });
    const a4 = await gen(U.EMPLOYEE, { operation: 'update', resource: 'roles', id: roleIdOf.EMPLOYEE, data: { name: 'admin' } });
    const a5 = await gen(U.EMPLOYEE, { operation: 'update', resource: 'features_capability', id: catalogRows.byTag.get(PERM.selfView).capabilityId, data: { features_json: '[1,2,3]' } });
    const now = await mine();
    ok([a1, a2, a3, a4, a5].every((r) => r.status === 403) && now.role_id === snap.role_id && (await one('SELECT name FROM roles WHERE id = ?', [roleIdOf.EMPLOYEE])).name.toLowerCase() === 'employee'
      && same(newTagsOf((await tagsOfRoles(db, { appId: app.id, roleIds: [roleIdOf.EMPLOYEE] })).get(roleIdOf.EMPLOYEE).tags), [PERM.selfView]),
    'an Employee login can no longer: give itself the admin role, set the Owner’s password, grant its role a capability, rename its role "admin", or widen a capability every company shares');
    const o1 = await gen(U.OWNER, { operation: 'update', resource: 'users', id: U.OWNER.id, data: { name: owner.name } });
    const r1 = await gen(U.EMPLOYEE, { operation: 'query', resource: 'roles', fields: ['id', 'name'] });
    ok(o1.status === 200 && o1.json.success === true && r1.status === 200 && Array.isArray(r1.json.data), 'an administrator still writes them (the admin screens of the other apps go on working); reads are as they were');

    // no hrms table in it
    ok(DESCRIBED_RESOURCES.length === 46 && DESCRIBED_RESOURCES.includes('cfHrmsEmployee'), 'resourceDef.json describes 46 hrms tables');
    const open = [];
    for (const resource of DESCRIBED_RESOURCES) {
      const read = await gen(U.OWNER, { operation: 'query', resource, fields: ['id'], pagination: { limit: 1 } });
      const write = await gen(U.OWNER, { operation: 'update', resource, id: NONE, data: { name: 'x' } });
      // A read that fails answers 200 with success: false — so it is `success` that is looked at, not the status.
      if (read.json?.success === true || write.json?.success === true) open.push(`${resource} read ${read.json?.success} write ${write.json?.success}`);
    }
    ok(open.length === 0, 'none of them is registered with the generic API: not read, not written — even by the Owner (it ran no rights check and served every employee’s phone and email to any login of the tenant)', open.slice(0, 4).join('; '));
    const raw = [];
    for (const resource of ['hrms_employees', 'hrms_access_roles', 'hrms_hirings', 'hrms_positions', 'hrms_audit_log']) {
      for (const operation of ['insert', 'update', 'delete', 'query']) {
        const r = await gen(U.OWNER, { operation, resource, id: NONE, data: { id: NONE, name: 'x' }, fields: ['id'] });
        if (r.json?.success === true) raw.push(`${operation} ${resource}`);
      }
    }
    ok(raw.length === 0, 'and a raw hrms table name is not accepted for a read or a write', raw.join('; '));
    const emp = await gen(U.EMPLOYEE, { operation: 'query', resource: 'cfHrmsEmployee', fields: ['id', 'fullName', 'phone', 'email'] });
    ok(emp.json?.success === false && !Array.isArray(emp.json.data) && !JSON.stringify(emp.json).includes('9100000'), 'an Employee login asking the generic API for every employee’s phone and email gets none', JSON.stringify(emp.json).slice(0, 120));
  }

  /* ══ 10. another company ══════════════════════════════════════════════════ */
  section('[10] Another company');
  if (other) {
    const theirOwner = await one(
      `SELECT u.id, u.email FROM users u JOIN app_user_access aua ON aua.user_id = u.id AND aua.app_id = ? AND aua.deleted_at IS NULL JOIN roles r ON r.id = aua.role_id
        WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [other.app_id, other.id]);
    if (theirOwner) {
      const them = { token: signToken({ id: theirOwner.id, email: theirOwner.email, role: 'admin', company: other.slug, companyId: other.id, company_id: other.id, uiPermissions: [] }) };
      const theirs = `/${other.slug}/cf_hrms`;
      const t = (method, url, body) => call(them, method, `${theirs}${url}`, body, { raw: true });
      const wrong = [];
      for (const [what, method, url, body, status] of [
        ['change this company’s role', 'PUT', `/access/roles/${roleIdOf.HR_MANAGER}`, { tags: [] }, 404], ['delete it', 'DELETE', `/access/roles/${madeRoleId}`, undefined, 404],
        ['copy it', 'POST', '/access/roles', { label: `${TAG} stolen`, scope: 'COMPANY', copyFrom: roleIdOf.HR_MANAGER }, 404],
        ['change this company’s login', 'PUT', `/access/logins/${U.HR_MANAGER.id}`, { roleId: roleIdOf.OWNER }, 404], ['disable it', 'POST', `/access/logins/${U.HR_MANAGER.id}/disable`, undefined, 404],
        ['reset its password', 'POST', `/access/logins/${U.HR_MANAGER.id}/reset-password`, undefined, 404], ['make a login for this company’s employee', 'POST', '/access/logins', { employeeId: E.none, email: `${TAG.toLowerCase()}.x@example.test`, roleId: roleIdOf.EMPLOYEE }, 404],
      ]) { const r = await t(method, url, body); if (r.status !== status) wrong.push(`${what}: ${r.status} ${r.json?.code ?? ''}`); }
      const theirList = await t('GET', '/access/roles');
      const theirLogins = await t('GET', '/access/logins');
      ok(wrong.length === 0 && theirList.status === 200 && theirList.json.roles.every((r) => !Object.values(roleIdOf).includes(r.roleId)) && theirLogins.json.logins.every((l) => l.userId !== U.HR_MANAGER.id)
        && (await one('SELECT password FROM users WHERE id = ?', [U.HR_MANAGER.id])).password === 'x',
      'another company’s Owner cannot see, change, delete or copy this company’s roles, nor see, change, disable or reset its logins: 404', wrong.join('; '));
      const cross = await call(them, 'GET', '/access/roles');
      const crossBack = await call(U.OWNER, 'GET', `${theirs}/access/roles`, undefined, { raw: true });
      ok(cross.status === 403 && crossBack.status === 403, 'and a token of one company opens nothing under the other company’s address: 403');
    } else skip('another company’s Owner', 'it has no Owner login with access to the app');
  } else skip('another company', 'no second company has the cf_hrms app');
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
  ok(moved.length === 0, `every count is what it was: users, roles, grants, access rows, features, capabilities, access roles, employees, positions, departments, hirings, the audit log, the code counters (${TABLES.length} tables)`,
    moved.map((k) => `${k} ${before[k]} -> ${after[k]}`).join('; '));
  const [[left]] = await pool.query('SELECT (SELECT COUNT(*) FROM users WHERE email LIKE ?) AS users, (SELECT COUNT(*) FROM roles WHERE name LIKE ?) AS roles', [`${TAG.toLowerCase()}%`, `${TAG}%`]);
  ok(Number(left.users) === 0 && Number(left.roles) === 0, 'no login and no role made by this run exists');
}

console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped`);
if (skipped.length) for (const s of skipped) console.log(`  skipped — ${s}`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
