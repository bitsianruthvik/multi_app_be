/**
 * label_defaults_test.mjs — leave policy and default shift by label
 * (TM/CF_HRMS_HIRING_SPEC.md §17, 2026-10-15).
 *
 *   0. the schema (apps/cf_hrms/scripts/apply-label-defaults.mjs): applied,
 *      a second run plans nothing; `scope` is a VARCHAR;
 *   1. leave — the resolution order: role beats label beats location beats
 *      company; removing a label's (and a role's) assignment falls back;
 *   2. leave — two labels of two groups pointing to different policies: the
 *      group that comes first wins, the conflict is listed (and flips with the
 *      group order); the same policy twice is no conflict;
 *   3. leave — a label's policy reaches exactly the positions of departments
 *      carrying it (not their children), Kind labels included; GET
 *      /leave/assignments `labels`; every read (position, card, policy-for,
 *      My place's helper, role page) answers through the one resolution;
 *      usedBy.labels, IN_USE, refusals;
 *   4. shift — a label's "New positions start on": set / clear / refused;
 *      the suggestion route; the default in EVERY creation path (POST
 *      /positions, add-sibling, Excel positions upload, command bar
 *      add_position incl. a department made earlier in the same plan); an
 *      explicit shift always wins; existing positions never change;
 *   5. rights; 6. tenant isolation; and nothing is left behind.
 *
 *   node scripts/cf_hrms/label_defaults_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND: like label_groups_test, the whole run is ONE
 * connection inside ONE transaction (pool.query / getConnection point at it; a
 * route's own transaction is a savepoint), rolled back at the end. Local only.
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
import * as LEAVE from '../../apps/cf_hrms/services/leavePolicyService.js';
import * as POS from '../../apps/cf_hrms/services/positionService.js';
import { getRole } from '../../apps/cf_hrms/services/roleContentService.js';
import { getPositionCard } from '../../apps/cf_hrms/services/orgChartService.js';
import { resolveEffective } from '../../apps/cf_hrms/services/leavePolicyRead.js';
import { chooseNewShift } from '../../apps/cf_hrms/services/newPositionShift.js';
import { checkPlan, applyPlan } from '../../apps/cf_hrms/services/commands/plan.js';
import { HOLDS_SEAT_SQL } from '../../apps/cf_hrms/services/seatCount.js';
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
const same = (a, b) => JSON.stringify([...a].map(Number).sort((x, y) => x - y)) === JSON.stringify([...b].map(Number).sort((x, y) => x - y));

const TABLES = ['hrms_label_groups', 'hrms_department_labels', 'hrms_department_label_links', 'hrms_departments', 'hrms_positions', 'hrms_roles', 'hrms_locations',
  'hrms_leave_policies', 'hrms_leave_policy_rules', 'hrms_leave_policy_assignments', 'hrms_leave_types', 'hrms_position_reporting_relationships',
  'hrms_audit_log', 'cf_code_sequences', 'users', 'app_user_access'];
const dbCfg = { host: process.env.DB_HOST ?? 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306 };
async function worldCount() {
  const conn = await mysql.createConnection(dbCfg);
  try {
    const out = {};
    for (const t of TABLES) {
      const [[r]] = await conn.query(`SELECT COUNT(*) AS n${t === 'cf_code_sequences' ? '' : ', COALESCE(SUM(deleted_at IS NULL), 0) AS live'} FROM ${t}`);
      out[t] = `${r.n}/${r.live ?? '-'}`;
    }
    const [[seq]] = await conn.query('SELECT COALESCE(SUM(next_value), 0) AS s FROM cf_code_sequences');
    out.counters = String(seq.s);
    return out;
  } finally { await conn.end(); }
}
/** Karni as the user knows it: positions / employees / vacant positions, and leave policies assigned. */
async function companyShape(q, companyId) {
  const [[p]] = await q("SELECT COUNT(*) AS n FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL AND status <> 'CLOSED'", [companyId]);
  const [[e]] = await q('SELECT COUNT(*) AS n FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const [[f]] = await q(
    `SELECT COUNT(*) AS n FROM hrms_positions p WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status <> 'CLOSED'
        AND NOT EXISTS (SELECT 1 FROM hrms_work_assignments wa WHERE wa.company_id = p.company_id AND wa.position_id = p.id AND ${HOLDS_SEAT_SQL('wa')}
                          AND (wa.effective_from IS NULL OR wa.effective_from <= CURDATE()) AND (wa.effective_to IS NULL OR wa.effective_to >= CURDATE()))`, [companyId]);
  const [[a]] = await q('SELECT COUNT(*) AS n FROM hrms_leave_policy_assignments WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  return `${p.n} / ${e.n} / ${f.n}; ${a.n} leave polic${Number(a.n) === 1 ? 'y' : 'ies'} assigned`;
}
const before = await worldCount();

const real = { query: pool.query.bind(pool), execute: pool.execute.bind(pool), getConnection: pool.getConnection.bind(pool) };
const db = await real.getConnection();
await db.beginTransaction();
let depth = 0;
const inside = {
  query: (...a) => db.query(...a),
  execute: (...a) => db.execute(...a),
  beginTransaction: async () => { depth += 1; await db.query(`SAVEPOINT zz_ld_${depth}`); },
  commit: async () => { if (depth > 0) { await db.query(`RELEASE SAVEPOINT zz_ld_${depth}`); depth -= 1; } },
  rollback: async () => { if (depth > 0) { await db.query(`ROLLBACK TO SAVEPOINT zz_ld_${depth}`); depth -= 1; } },
  release: () => {},
};
pool.query = inside.query;
pool.execute = inside.execute;
pool.getConnection = async () => inside;

const TAG = `ZZLD${Date.now().toString(36).toUpperCase().slice(-5)}`;
const q = async (sql, params) => (await db.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0] ?? null;
const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;

async function open(base64) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(base64, 'base64'));
  const ws = wb.getWorksheet('Data');
  const head = new Map();
  ws.getRow(1).eachCell((cell, col) => head.set(String(cell.value).replace(/\s*★\s*$/, ''), col));
  return {
    ws,
    set(row, h, value) { const col = head.get(h); if (!col) throw new Error(`no column "${h}" (have: ${[...head.keys()].join(', ')})`); ws.getCell(row, col).value = value; },
    async save() { return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64'); },
  };
}

let server;
let shapeBefore = null;
let companyId = null;
try {
  const company = await one('SELECT id, name, slug FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
  if (!company) throw new Error(`No company "${slug}".`);
  const COMPANY = company.id;
  companyId = COMPANY;
  const app = await hrmsAppOf(db, COMPANY);
  const other = await one(
    `SELECT co.id, co.name, co.slug, a.id AS app_id FROM companies co JOIN apps a ON a.company_id = co.id AND a.slug = 'cf_hrms' AND a.deleted_at IS NULL
      WHERE co.id <> ? AND co.deleted_at IS NULL ORDER BY co.id LIMIT 1`, [COMPANY]);
  const owner = await one(
    `SELECT u.id, u.email, u.name FROM users u JOIN app_user_access aua ON aua.user_id = u.id AND aua.app_id = ? AND aua.deleted_at IS NULL JOIN roles r ON r.id = aua.role_id
      WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [app.id, COMPANY]);
  if (!owner) throw new Error('This company has no Owner login.');
  const c = { companyId: COMPANY, userId: owner.id };
  shapeBefore = await companyShape((s, p) => db.query(s, p), COMPANY);
  console.log(`label_defaults_test — ${company.name} (${COMPANY}), run tag ${TAG}; ${shapeBefore} (positions / employees / vacant); the other company is ${other ? `${other.name} (${other.id})` : 'none'}`);

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
  const must = async (who, method, url, body) => {
    const r = await call(who, method, url, body);
    if (r.status !== 200) throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };

  /* ══ 0. the schema ══════════════════════════════════════════════════════ */
  section('[0] The schema: applied, and a second run plans nothing');
  {
    const steps = await schemaSteps(db);
    ok(steps.length === 0, 'apply-label-defaults: nothing left to do on this database (idempotent)', steps.map((s) => s.what).join('; '));
    const scope = await one("SELECT DATA_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_policy_assignments' AND COLUMN_NAME = 'scope'");
    const key = await one("SELECT GENERATION_EXPRESSION AS e FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_policy_assignments' AND COLUMN_NAME = 'target_key'");
    ok(String(scope?.t).toLowerCase() === 'varchar' && /label_id/.test(key?.e ?? ''), 'scope is a VARCHAR (LABEL needs no change to it); target_key has label_id in it');
  }

  /* ══ fixtures: two groups, labels, departments, a location, roles, positions ══ */
  const groups0 = (await must(O, 'GET', '/organisation/label-groups')).groups;
  const KIND = groups0.find((g) => g.isKind);
  const MACHINE = KIND.labels.find((l) => l.name === 'Machine');
  const AREA = await must(O, 'POST', '/organisation/label-groups', { name: `${TAG} Area` });
  const UNIT = await must(O, 'POST', '/organisation/label-groups', { name: `${TAG} Unit` });
  const PLANT = await must(O, 'POST', '/organisation/department-labels', { groupId: AREA.id, name: 'Plant' });
  const U2 = await must(O, 'POST', '/organisation/department-labels', { groupId: UNIT.id, name: 'Unit 2' });
  const dept = async (name, labels, extra = {}) => must(O, 'POST', '/organisation/departments', { name: `${TAG} ${name}`, labels, ...extra });
  const D1 = await dept('Both', { [AREA.id]: PLANT.id, [UNIT.id]: U2.id });      // Plant + Unit 2
  const D2 = await dept('Unit only', { [UNIT.id]: U2.id });                       // Unit 2
  const D3 = await dept('Under both', {}, { parentId: D1.id });                    // a child of D1, no labels of its own
  const D4 = await dept('Plain', {});                                              // nothing but its Kind label
  const location = await ORG.createLocation(db, c, { code: `${TAG}L`, name: `${TAG} Unit`, locationType: 'UNIT' });
  const roleA = await ins("INSERT INTO hrms_roles (company_id, role_code, title, status, created_by) VALUES (?, ?, ?, 'ACTIVE', ?)", [COMPANY, `${TAG}RA`, `${TAG} Role A`, c.userId]);
  const roleB = await ins("INSERT INTO hrms_roles (company_id, role_code, title, status, created_by) VALUES (?, ?, ?, 'ACTIVE', ?)", [COMPANY, `${TAG}RB`, `${TAG} Role B`, c.userId]);
  const shifts = await q('SELECT id, code, name FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY id', [COMPANY]);
  const byCode = (code) => shifts.find((s) => s.code === code);
  const G = byCode('G') ?? shifts[0];
  const DAY = byCode('D') ?? shifts[1];
  const NIGHT = byCode('N') ?? shifts[2];
  if (!G || !DAY || !NIGHT) throw new Error('This test needs three shifts (G, D, N).');
  const pos = async (roleId, departmentId, extra = {}) => (await POS.createPosition(db, c, { roleId, departmentId, locationId: location.id, defaultShiftId: G.id, status: 'ACTIVE', ...extra })).position;
  const pA = await pos(roleA, D1.id);      // role A, Plant + Unit 2
  const pB = await pos(roleB, D1.id);      // role B, Plant + Unit 2
  const pC = await pos(roleB, D2.id);      // role B, Unit 2
  const pChild = await pos(roleB, D3.id);  // role B, under D1 — no labels of its own
  const pPlain = await pos(roleB, D4.id);  // role B, no labels
  const eff = async (p) => (await LEAVE.policyFor(db, COMPANY, { positionId: p.id })).effective;
  const mk = async (name) => (await LEAVE.createPolicy(db, c, { name: `${TAG} ${name}`, fromTemplate: 'TRAINEE', status: 'ACTIVE' })).policy;
  const P = { company: await mk('Company'), location: await mk('Location'), plant: await mk('Plant'), unit: await mk('Unit'), role: await mk('Role') };
  const ref = (p) => ({ id: p.id, name: p.name, status: p.status });
  const put = (body) => call(O, 'PUT', '/leave/assignments', body);

  /* ══ 1. the resolution order ═══════════════════════════════════════════ */
  section('[1] Leave: role beats label beats location beats company');
  {
    ok((await put({ scope: 'COMPANY', policyId: P.company.id })).status === 200, 'the company default is set');
    ok((await eff(pPlain)).from === 'COMPANY', 'company default: a position with nothing more specific gets it');
    ok((await put({ scope: 'LOCATION', locationId: location.id, policyId: P.location.id })).status === 200, 'the location gets its own');
    const viaLocation = await eff(pC);
    ok(viaLocation.from === 'LOCATION' && viaLocation.policy.id === P.location.id && !('label' in viaLocation) && !('conflict' in viaLocation),
      'a location’s policy beats the company’s; an answer not from a label keeps its old shape (no label / conflict keys)', JSON.stringify(viaLocation));
    const put1 = await put({ scope: 'LABEL', labelId: U2.id, policyId: P.unit.id });
    const row = put1.json?.assignments?.labels?.find((l) => l.labelId === U2.id);
    ok(put1.status === 200 && row && row.policy?.id === P.unit.id && row.groupId === UNIT.id && row.groupName === `${TAG} Unit` && row.name === 'Unit 2',
      'PUT /leave/assignments { scope: LABEL, labelId } -> the label row carries its policy', JSON.stringify(row));
    const viaLabel = await eff(pC);
    ok(viaLabel.from === 'LABEL' && viaLabel.policy.id === P.unit.id && viaLabel.label?.id === U2.id && viaLabel.label.groupName === `${TAG} Unit` && viaLabel.conflict === null
      && viaLabel.line === `${P.unit.name} — from the label Unit 2`, 'a label’s policy beats the location’s: "<policy> — from the label Unit 2"', JSON.stringify(viaLabel));
    ok((await eff(pChild)).from === 'LOCATION', 'a department under one that carries the label does not get it (its own labels only)');
    ok((await put({ scope: 'ROLE', roleId: roleA, policyId: P.role.id })).status === 200 && (await eff(pA)).from === 'ROLE' && (await eff(pA)).line === `${P.role.name} — from the role`
      && (await eff(pB)).from === 'LABEL', 'a role’s policy beats the label’s; the other role in the same department still gets the label’s');
    // falling back
    ok((await put({ scope: 'ROLE', roleId: roleA, policyId: null })).status === 200 && (await eff(pA)).from === 'LABEL', 'remove the role’s: back to the label’s');
    ok((await put({ scope: 'LABEL', labelId: U2.id, policyId: null })).status === 200 && (await eff(pC)).from === 'LOCATION' && (await eff(pA)).from === 'LOCATION',
      'remove the label’s: back to the location’s');
    const st = await LEAVE.getAssignments(db, COMPANY);
    ok(st.labels.find((l) => l.labelId === U2.id)?.policy === null, 'the label row reads "no policy of its own" again');
    // the pure function, on its own
    const index = { company: null, byLocation: new Map([[5, ref(P.location)]]), locationName: new Map([[5, 'Unit 2']]), byRole: new Map([[9, ref(P.role)]]),
      byLabel: new Map([[70, { policy: ref(P.plant), label: { id: 70, name: 'Plant', groupId: 1, groupName: 'Area' }, groupSort: 1, groupId: 1 }]]), labelsOfDepartment: new Map([[3, [70]]]) };
    ok(resolveEffective(index, { roleId: 9, locationId: 5, departmentId: 3 }).from === 'ROLE' && resolveEffective(index, { roleId: 8, locationId: 5, departmentId: 3 }).from === 'LABEL'
      && resolveEffective(index, { roleId: 8, locationId: 5, departmentId: 4 }).from === 'LOCATION' && resolveEffective({ ...index, byLocation: new Map() }, { departmentId: 4 }).line === 'No leave policy',
    'resolveEffective on its own: ROLE, LABEL, LOCATION, none');
  }

  /* ══ 2. two labels, two groups, two policies ═══════════════════════════ */
  section('[2] Leave: a label conflict — the first group wins, and says so');
  {
    await put({ scope: 'LABEL', labelId: PLANT.id, policyId: P.plant.id });
    await put({ scope: 'LABEL', labelId: U2.id, policyId: P.unit.id });
    const e = await eff(pB);
    const line = `${P.plant.name} — from the label Plant (Unit 2 points to ${P.unit.name}; Plant comes first)`;
    ok(e.from === 'LABEL' && e.policy.id === P.plant.id && e.label.name === 'Plant' && e.conflict?.length === 1 && e.conflict[0].label.id === U2.id
      && e.conflict[0].policy.id === P.unit.id && e.line === line, `Area comes before Unit: "${line}"`, JSON.stringify(e));
    ok((await eff(pC)).conflict === null && (await eff(pC)).policy.id === P.unit.id, 'a department carrying only one of them: no conflict');
    const a = await LEAVE.getAssignments(db, COMPANY);
    const plantRow = a.labels.find((l) => l.labelId === PLANT.id);
    const unitRow = a.labels.find((l) => l.labelId === U2.id);
    ok(plantRow.conflicts.some((x) => x.positionId === pB.id && x.line === line) && unitRow.conflicts.some((x) => x.positionId === pB.id)
      && !unitRow.conflicts.some((x) => x.positionId === pC.id), 'GET /leave/assignments: the conflicting position is listed under both labels, with the line; a clean one is not');
    // the group order decides
    const order = (await must(O, 'GET', '/organisation/label-groups')).groups.map((g) => g.id);
    const flipped = order.filter((id) => id !== UNIT.id);
    flipped.splice(flipped.indexOf(AREA.id), 0, UNIT.id);
    ok((await call(O, 'PUT', '/organisation/label-groups/order', { ids: flipped })).status === 200, 'Unit moved before Area');
    const e2 = await eff(pB);
    ok(e2.policy.id === P.unit.id && e2.label.name === 'Unit 2' && e2.conflict?.[0]?.label.name === 'Plant'
      && e2.line === `${P.unit.name} — from the label Unit 2 (Plant points to ${P.plant.name}; Unit 2 comes first)`, 'and now Unit 2 wins: the order is the rule', e2.line);
    await call(O, 'PUT', '/organisation/label-groups/order', { ids: order });
    await put({ scope: 'LABEL', labelId: U2.id, policyId: P.plant.id });
    ok((await eff(pB)).conflict === null, 'the same policy on both labels is no conflict');
    await put({ scope: 'LABEL', labelId: U2.id, policyId: P.unit.id });
  }

  /* ══ 3. reach, reads, refusals ═════════════════════════════════════════ */
  section('[3] Leave: what a label reaches, and every read');
  {
    const a = await LEAVE.getAssignments(db, COMPANY);
    ok(JSON.stringify(Object.keys(a)) === JSON.stringify(['company', 'locations', 'labels', 'roles', 'unassignedPositions'])
      && a.labels.every((l) => ['groupId', 'groupName', 'labelId', 'name', 'policy', 'positionCount', 'conflicts'].every((k) => k in l)),
    'GET /leave/assignments: { company, locations, labels: [{ groupId, groupName, labelId, name, policy, positionCount, conflicts }], roles, unassignedPositions }');
    const kindFirst = a.labels.findIndex((l) => l.groupId === KIND.id) < a.labels.findIndex((l) => l.groupId === AREA.id)
      && a.labels.findIndex((l) => l.groupId === AREA.id) < a.labels.findIndex((l) => l.groupId === UNIT.id);
    ok(kindFirst, 'labels in group order: Kind, then Area, then Unit');
    // Plant reaches exactly the positions of D1 (its role-less ones); not D3 (a child), not D2.
    const all = await q("SELECT id, role_id, location_id, department_id FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL AND status <> 'CLOSED'", [COMPANY]);
    const index = await (await import('../../apps/cf_hrms/services/leavePolicyRead.js')).loadAssignmentIndex(db, COMPANY);
    const fromPlant = all.filter((p) => resolveEffective(index, { roleId: p.role_id, locationId: p.location_id, departmentId: p.department_id }).label?.id === PLANT.id).map((p) => p.id);
    ok(same(fromPlant, [pA.id, pB.id]) && a.labels.find((l) => l.labelId === PLANT.id).positionCount === 2,
      'Plant reaches exactly the two positions of the department carrying it — not its child department, not the other', JSON.stringify(fromPlant));
    // A Kind label: every Machine department of the company.
    await put({ scope: 'LABEL', labelId: MACHINE.id, policyId: P.plant.id });
    const [[machine]] = await db.query(
      `SELECT COUNT(*) AS n FROM hrms_positions p JOIN hrms_departments d ON d.company_id = p.company_id AND d.id = p.department_id
        WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status <> 'CLOSED' AND LOWER(d.department_type) = 'machine' AND d.deleted_at IS NULL`, [COMPANY]);
    const a2 = await LEAVE.getAssignments(db, COMPANY);
    ok(Number(machine.n) > 0 && a2.labels.find((l) => l.labelId === MACHINE.id).positionCount === Number(machine.n),
      `a Kind label (Machine) reaches every position of the departments it labels: ${machine.n}`, String(a2.labels.find((l) => l.labelId === MACHINE.id).positionCount));
    await put({ scope: 'LABEL', labelId: MACHINE.id, policyId: null });
    // every read answers through the one resolution
    const byPos = await eff(pB);
    const card = (await getPositionCard(db, COMPANY, pB.id, {})).leavePolicy;
    const detail = (await must(O, 'GET', `/positions/${pB.id}`)).position.leavePolicy;
    const viaQuery = (await must(O, 'GET', `/leave/policy-for?roleId=${roleB}&locationId=${location.id}&departmentId=${D1.id}`)).effective;
    const mine = await LEAVE.leaveOfPosition(db, COMPANY, { roleId: roleB, locationId: location.id, departmentId: D1.id });
    ok([card, detail, viaQuery].every((x) => JSON.stringify(x) === JSON.stringify(byPos)) && mine.line === byPos.line && mine.rules.length > 0,
      'GET /positions/:id, the chart’s position card, policy-for by role+location+department and My place’s leave all say the same', JSON.stringify([card?.line, detail?.line, viaQuery?.line, mine.line]));
    ok((await getRole(db, COMPANY, roleB)).leavePolicy.own === null, 'the role page shows only the role’s own policy (none)');
    const listed = (await LEAVE.listPolicies(db, COMPANY)).policies;
    ok(listed.find((p) => p.id === P.plant.id).usedBy.labels === 1 && listed.find((p) => p.id === P.unit.id).usedBy.labels === 1
      && listed.find((p) => p.id === P.plant.id).usedBy.positions === 2, 'usedBy counts labels, and the positions each policy ends up with', JSON.stringify(listed.find((p) => p.id === P.plant.id).usedBy));
    const used = await call(O, 'GET', '/leave/policies?used=1');
    ok(used.json.policies.some((p) => p.id === P.unit.id), 'the "applied somewhere" filter counts a label');
    const del = await call(O, 'DELETE', `/leave/policies/${P.unit.id}`);
    ok(del.status === 409 && del.json.code === 'IN_USE' && JSON.stringify(del.json.problems ?? del.json).includes('The label Unit 2 uses it.'), 'a policy a label uses cannot be deleted: 409 IN_USE naming the label', JSON.stringify(del.json));
    const draft = (await LEAVE.createPolicy(db, c, { name: `${TAG} Draft`, fromTemplate: 'BLANK' })).policy;
    const r1 = await put({ scope: 'LABEL', labelId: PLANT.id, policyId: draft.id });
    const r2 = await put({ scope: 'LABEL', labelId: 99999999, policyId: P.plant.id });
    const r3 = await put({ scope: 'LABEL', policyId: P.plant.id });
    ok(r1.status === 422 && r2.status === 404 && r3.status === 422, 'a draft policy: 422; a label that is not this company’s: 404; no label: 422', `${r1.status} ${r2.status} ${r3.status}`);
    const twice = await q("SELECT COUNT(*) AS n FROM hrms_leave_policy_assignments WHERE company_id = ? AND scope = 'LABEL' AND label_id = ? AND deleted_at IS NULL", [COMPANY, U2.id]);
    ok(Number(twice[0].n) === 1, 'one live assignment per label (target_key LABEL:<id>)');
  }

  /* ══ 4. the default shift ══════════════════════════════════════════════ */
  section('[4] Shift: "New positions start on", in every creation path');
  {
    const existing = await q('SELECT id, default_shift_id FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL ORDER BY id', [COMPANY]);
    const setNight = await call(O, 'PUT', `/organisation/department-labels/${PLANT.id}`, { defaultShiftId: NIGHT.id });
    const setDay = await call(O, 'PUT', `/organisation/department-labels/${U2.id}`, { defaultShiftId: DAY.id });
    ok(setNight.status === 200 && setNight.json.defaultShiftId === NIGHT.id && setDay.json.defaultShiftId === DAY.id, 'PUT a label { defaultShiftId } -> returned');
    const lg = await must(O, 'GET', '/organisation/label-groups');
    ok(lg.groups.find((g) => g.id === AREA.id).labels.find((l) => l.id === PLANT.id).defaultShiftId === NIGHT.id && Array.isArray(lg.shifts) && lg.shifts.some((s) => s.id === DAY.id),
      'GET /organisation/label-groups: each label with defaultShiftId, and the shifts to choose from');
    const bad = await call(O, 'PUT', `/organisation/department-labels/${PLANT.id}`, { defaultShiftId: 99999999 });
    const made = await call(O, 'POST', '/organisation/department-labels', { groupId: AREA.id, name: 'Yard', defaultShiftId: DAY.id });
    ok(bad.status === 422 && made.status === 200 && made.json.defaultShiftId === DAY.id, 'a shift not of this company: 422; a new label may start with one');
    ok((await call(O, 'PUT', `/organisation/department-labels/${made.json.id}`, { defaultShiftId: null })).json.defaultShiftId === null, 'null clears it ("No default")');

    const suggest = async (qs) => (await must(O, 'GET', `/positions/new-shift?${qs}`)).suggestion;
    const s1 = await suggest(`departmentId=${D1.id}`);
    const s2 = await suggest(`departmentId=${D2.id}`);
    const s3 = await suggest(`departmentId=${D3.id}`);
    const s4 = await suggest(`departmentId=${D4.id}`);
    ok(s1.shift.id === NIGHT.id && s1.from === 'LABEL' && s1.label.name === 'Plant' && s1.line === `Starts on ${NIGHT.name}${/shift$/i.test(NIGHT.name) ? '' : ' shift'} (from the label Plant)`,
      'GET /positions/new-shift: Plant + Unit 2 -> Plant’s shift (its group comes first), "Starts on Night shift (from the label Plant)"', s1.line);
    ok(s2.shift.id === DAY.id && s2.label.name === 'Unit 2' && s3.from === 'GENERAL' && s3.shift.id === G.id && s4.from === 'GENERAL',
      'Unit 2 only -> Day; a child department and a plain one -> General (labels are not inherited)', `${s2.line} / ${s3.line} / ${s4.line}`);
    ok((await call(O, 'GET', '/positions/new-shift?departmentId=99999999')).status === 404, 'a department that is not this company’s: 404');
    ok(chooseNewShift({ labels: [{ labelId: 1, name: 'X', defaultShiftId: 424242 }], shifts }).from === 'GENERAL', 'a default pointing at a shift that is gone is passed over');

    // a. the position form / POST /positions
    const viaRoute = (await must(O, 'POST', '/positions', { roleId: roleB, departmentId: D2.id, status: 'ACTIVE' })).position;
    const explicit = (await must(O, 'POST', '/positions', { roleId: roleB, departmentId: D2.id, defaultShiftId: G.id, status: 'ACTIVE' })).position;
    const plain = (await must(O, 'POST', '/positions', { roleId: roleB, departmentId: D4.id, status: 'ACTIVE' })).position;
    ok(viaRoute.defaultShiftId === DAY.id && explicit.defaultShiftId === G.id && plain.defaultShiftId === G.id,
      'POST /positions: no shift -> the label’s (Day); a shift named -> that one; no label default -> General', JSON.stringify([viaRoute.defaultShiftId, explicit.defaultShiftId, plain.defaultShiftId]));
    // b. add-sibling
    const nightPlain = await pos(roleB, D4.id, { defaultShiftId: NIGHT.id });
    const sib1 = (await must(O, 'POST', `/positions/${pC.id}/add-sibling`, {})).position;           // source on General, department Unit 2
    const sib2 = (await must(O, 'POST', `/positions/${nightPlain.id}/add-sibling`, {})).position;   // source on Night, no label default
    const sib3 = (await must(O, 'POST', `/positions/${pC.id}/add-sibling`, { shiftId: G.id })).position;
    ok(sib1.defaultShiftId === DAY.id && sib2.defaultShiftId === NIGHT.id && sib3.defaultShiftId === G.id,
      'add-sibling: none named -> the label’s (Day) over the source’s; no label default -> the source’s (Night); named -> that one', JSON.stringify([sib1.defaultShiftId, sib2.defaultShiftId, sib3.defaultShiftId]));
    ok((await suggest(`likePositionId=${nightPlain.id}`)).from === 'LIKE' && (await suggest(`likePositionId=${pC.id}`)).from === 'LABEL', 'the suggestion for "Add a position like this" says the same');
    // c. Excel positions upload
    const blank = await must(O, 'GET', '/excel/positions/workbook?blank=1');
    const book = await open(blank.contentBase64);
    const roleText = `${TAG}RB — ${TAG} Role B`;
    book.set(2, 'Role', roleText); book.set(2, 'Department', `${D1.code} — ${D1.name}`); book.set(2, 'Status', 'ACTIVE');
    book.set(3, 'Role', roleText); book.set(3, 'Department', `${D1.code} — ${D1.name}`); book.set(3, 'Shift', `${G.code} — ${G.name}`); book.set(3, 'Status', 'ACTIVE');
    const file = await book.save();
    const pre = await must(O, 'POST', '/excel/positions/preview', { fileName: 'p.xlsx', contentBase64: file });
    const shiftChange = (row) => row?.changes.find((x) => x.column === 'Shift')?.to ?? '';
    ok(pre.summary.add === 2 && pre.summary.problems === 0 && shiftChange(pre.rows[0]) === `${NIGHT.code} — ${NIGHT.name} (from the label Plant)` && shiftChange(pre.rows[1]) === `${G.code} — ${G.name}`,
      'Excel preview: a new row with no shift says what it will start on and why; a named shift stays', JSON.stringify(pre.rows.map((r) => [r.action, shiftChange(r), r.problems])));
    const applied = await must(O, 'POST', '/excel/positions/apply', { fileName: 'p.xlsx', contentBase64: file, expect: { add: 2, change: 0 } });
    const codes = applied.issuedCodes.map((x) => x.code);
    const rows = await q('SELECT position_code, default_shift_id FROM hrms_positions WHERE company_id = ? AND position_code IN (?) ORDER BY id', [COMPANY, codes]);
    ok(applied.added === 2 && rows.length === 2 && rows[0].default_shift_id === NIGHT.id && rows[1].default_shift_id === G.id, 'Excel apply: Night from the label; General as named', JSON.stringify(rows));
    // an existing row cannot be left without a shift
    const full = await must(O, 'GET', `/excel/positions/workbook?department=${D2.id}`);
    const fb = await open(full.contentBase64);
    for (let r = 2; r <= fb.ws.rowCount; r += 1) if (fb.ws.getCell(r, 1).value) fb.set(r, 'Shift', null);
    const pre2 = await must(O, 'POST', '/excel/positions/preview', { fileName: 'p.xlsx', contentBase64: await fb.save() });
    ok(pre2.summary.problems > 0 && pre2.rows.every((r) => r.action !== 'CHANGE' || r.problems.length) && pre2.rows.some((r) => r.problems.some((p) => /a position is on one shift/i.test(p))),
      'Excel: blanking an existing position’s shift is a problem, not a change', JSON.stringify(pre2.summary));
    // d. the command bar
    const OWNER = { companyId: COMPANY, userId: owner.id, can: () => true, scope: { all: true } };
    const field = (kind, id, label) => ({ value: id, ref: { kind, id, label }, fromText: label, confidence: 1 });
    const stepPos = (id, departmentField, shift = null) => ({
      id, action: 'add_position', confidence: 1, sourceText: 'test',
      fields: { role: field('role', roleB, `${TAG} Role B`), department: departmentField, ...(shift ? { shift: field('shift', shift.id, shift.name) } : {}) },
    });
    const checked = await checkPlan(pool, OWNER, [stepPos('s1', field('department', D2.id, D2.name)), stepPos('s2', field('department', D2.id, D2.name), G)]);
    const [cp1, cp2] = checked.preview.positions;
    ok(checked.clean && cp1.shiftName === DAY.name && cp1.shiftFrom === 'LABEL' && /from the label Unit 2/.test(cp1.shiftLine) && cp2.shiftFrom === 'NAMED' && cp2.shiftName === G.name,
      'command bar check: the preview says the shift it will use and why — the label’s, or the one asked for', JSON.stringify([cp1.shiftLine, cp2.shiftLine, checked.steps.map((s) => s.problems)]));
    const withDept = [
      { id: 'd1', action: 'add_department', confidence: 1, sourceText: 'test', fields: { name: { value: `${TAG} New bay`, fromText: 'x', confidence: 1 }, labels: { value: String(U2.id), fromText: 'Unit 2', confidence: 1 } } },
      stepPos('p1', { value: null, ref: { kind: 'step', id: 'd1', label: 'new' }, fromText: 'in it', confidence: 1 }),
    ];
    const checked2 = await checkPlan(pool, OWNER, withDept);
    ok(checked2.clean && checked2.preview.positions[0].shiftFrom === 'LABEL' && checked2.preview.positions[0].shiftName === DAY.name,
      'a department made earlier in the same plan brings its labels: its new position starts on Day', JSON.stringify([checked2.preview.positions[0], checked2.steps.map((s) => s.problems)]));
    const done = await applyPlan(pool, OWNER, [stepPos('s1', field('department', D2.id, D2.name)), ...withDept]);
    const madeIds = done.created.filter((x) => x.kind === 'position').map((x) => x.id);
    const madeRows = await q('SELECT id, default_shift_id FROM hrms_positions WHERE company_id = ? AND id IN (?)', [COMPANY, madeIds]);
    ok(madeRows.length === 2 && madeRows.every((r) => r.default_shift_id === DAY.id), 'command bar apply: both new positions are on Day', JSON.stringify(madeRows));
    // existing positions never change
    const now = await q('SELECT id, default_shift_id FROM hrms_positions WHERE company_id = ? AND id IN (?)', [COMPANY, existing.map((p) => p.id)]);
    const moved = existing.filter((p) => now.find((x) => x.id === p.id)?.default_shift_id !== p.default_shift_id);
    ok(moved.length === 0, `existing positions untouched: all ${existing.length} keep their shift`, JSON.stringify(moved.slice(0, 5)));
  }

  /* ══ 5. rights ═════════════════════════════════════════════════════════ */
  section('[5] Rights');
  {
    if (!U.EMPLOYEE) skip('Employee rights', 'no Employee access role');
    else {
      const e1 = await call(U.EMPLOYEE, 'GET', '/leave/assignments');
      const e2 = await call(U.EMPLOYEE, 'PUT', '/leave/assignments', { scope: 'LABEL', labelId: PLANT.id, policyId: P.unit.id });
      const e3 = await call(U.EMPLOYEE, 'PUT', `/organisation/department-labels/${PLANT.id}`, { defaultShiftId: DAY.id });
      const e4 = await call(U.EMPLOYEE, 'GET', `/positions/new-shift?departmentId=${D1.id}`);
      ok([e1, e2, e3, e4].every((r) => r.status === 403), 'an Employee login: 403 on the assignments, the label default and the suggestion', [e1, e2, e3, e4].map((r) => r.status).join(' '));
    }
    if (!U.HR_EXECUTIVE) skip('HR executive rights', 'no HR executive access role');
    else {
      const h1 = await call(U.HR_EXECUTIVE, 'GET', '/leave/assignments');
      const h2 = await call(U.HR_EXECUTIVE, 'PUT', '/leave/assignments', { scope: 'LABEL', labelId: PLANT.id, policyId: P.unit.id });
      const h3 = await call(U.HR_EXECUTIVE, 'PUT', `/organisation/department-labels/${PLANT.id}`, { defaultShiftId: DAY.id });
      const h4 = await call(U.HR_EXECUTIVE, 'GET', `/positions/new-shift?departmentId=${D1.id}`);
      ok(h1.status === 200 && Array.isArray(h1.json.labels) && h2.status === 403 && h3.status === 403 && h4.status === 200,
        'an HR executive (leave view, no leave edit; org view, no org edit): reads the labels and the suggestion, changes neither', [h1, h2, h3, h4].map((r) => r.status).join(' '));
    }
  }

  /* ══ 6. tenant isolation ═══════════════════════════════════════════════ */
  section('[6] Tenant isolation');
  if (!THEM) skip('tenant isolation', 'no second company with an admin login');
  else {
    const t1 = await call(THEM, 'PUT', '/leave/assignments', { scope: 'LABEL', labelId: PLANT.id, policyId: null }, { as: other.slug });
    const t2 = await call(THEM, 'GET', `/positions/new-shift?departmentId=${D1.id}`, undefined, { as: other.slug });
    const t3 = await call(THEM, 'PUT', `/organisation/department-labels/${PLANT.id}`, { defaultShiftId: null }, { as: other.slug });
    const theirs = (await call(THEM, 'GET', '/leave/assignments', undefined, { as: other.slug })).json;
    const theirGroups = (await call(THEM, 'GET', '/organisation/label-groups', undefined, { as: other.slug })).json;
    const theirLabel = theirGroups?.groups?.[0]?.labels?.[0];
    const t4 = theirLabel ? await call(THEM, 'PUT', `/organisation/department-labels/${theirLabel.id}`, { defaultShiftId: DAY.id }, { as: other.slug }) : { status: 422 };
    ok(t1.status === 404 && t2.status === 404 && t3.status === 404 && t4.status === 422 && !(theirs?.labels ?? []).some((l) => l.labelId === PLANT.id)
      && !(theirGroups?.shifts ?? []).some((s) => s.id === DAY.id),
    'another company: cannot assign or clear our label’s policy (404), ask for our department (404), touch our label (404), give its label our shift (422), nor see ours',
    `${t1.status} ${t2.status} ${t3.status} ${t4.status}`);
    ok((await eff(pB)).policy.id === P.plant.id, 'and our answer is unchanged');
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
  if (shapeBefore && companyId) {
    const conn = await mysql.createConnection(dbCfg);
    try {
      const now = await companyShape((s, p) => conn.query(s, p), companyId);
      ok(now === shapeBefore, `${slug} is as it was: ${now}`, `${shapeBefore} -> ${now}`);
    } finally { await conn.end(); }
  }
}

console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped`);
if (skipped.length) for (const s of skipped) console.log(`  skipped — ${s}`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
