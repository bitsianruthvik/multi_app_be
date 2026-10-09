/**
 * content_copy_http_test.mjs — WHO may copy content, through the real server.
 *
 *   (a backend must be running)   cd multi_app_be && node scripts/cf_hrms/content_copy_http_test.mjs
 *   CF_TEST_BASE=http://localhost:4100 CF_TEST_COMPANY=60006 node scripts/cf_hrms/content_copy_http_test.mjs
 *
 * The service suite (content_copy_test.mjs) proves WHAT a copy does. This proves
 * who is let near it, which only the real middleware chain can answer: the token,
 * then the user's role for the app (app_user_access), then that role's capability
 * tags. A minted JWT cannot stand in for it — `protect` replaces the token's
 * permissions with the ones the database says the user has.
 *
 * It creates, in the LOCAL database, one user per case — each with a role holding
 * exactly the tags in its name — plus a small fixture of cf_hrms rows, drives the
 * routes over HTTP, and then DELETES everything it made (and says how many rows
 * of each it removed). The employee case uses the tenant's real `Employee` role,
 * i.e. exactly what the 71 Karni employee logins hold: cf_hrms_self_view only.
 *
 * Refuses to run against anything that is not local.
 */
import path from 'path';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';
import crypto from 'crypto';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const require = createRequire(path.join(BE, 'package.json'));
const bcrypt = require('bcryptjs');
const { pool } = await imp('db.js');
const RC = await imp('apps/cf_hrms/services/roleContentService.js');
const POS = await imp('apps/cf_hrms/services/positionService.js');

const COMPANY = Number(process.env.CF_TEST_COMPANY ?? 60006);
const BASE = process.env.CF_TEST_BASE ?? 'http://localhost:4100';
const SLUG = 'karni';
const TAG = `ZZ-CPYH-${Date.now().toString(36).toUpperCase()}`;
const API = `${BASE}/api/${SLUG}/cf_hrms`;

if (!/^(localhost|127\.0\.0\.1)$/.test(String(process.env.DB_HOST ?? 'localhost'))) throw new Error('Refusing: DB_HOST is not local.');
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('Refusing: CF_TEST_BASE is not local.');

let passed = 0;
let failed = 0;
const fails = [];
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label: string, cond: boolean) — got (${typeof label}, ${typeof cond})`);
  if (cond) { passed += 1; console.log(`  ok    ${label}`); return; }
  failed += 1; fails.push(label);
  console.log(`  FAIL  ${label}${detail ? `   -> ${detail}` : ''}`);
}

const q = async (sql, params = []) => (await pool.query(sql, params))[0];
const made = { users: [], roles: [], capRows: [], access: [], hrmsRoles: [], positions: [], defs: [] };

/** Every table this run can touch, counted whole — to prove the clean-up left the database as it found it. */
const WATCH = ['users', 'roles', 'role_capability', 'app_user_access', 'hrms_roles', 'hrms_positions', 'hrms_responsibility_definitions',
  'hrms_role_responsibility_assignments', 'hrms_role_kra_assignments', 'hrms_role_kpi_assignments', 'hrms_position_content_overrides',
  'hrms_manpower_requirements', 'hrms_work_assignments', 'hrms_audit_log'];
const snapshot = async () => Object.fromEntries(await Promise.all(WATCH.map(async (t) => [t, Number((await q(`SELECT COUNT(*) n FROM ${t}`))[0].n)])));
const startSnapshot = await snapshot();

async function http(method, url, token, body) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* an empty body */ }
  return { status: res.status, json };
}

async function login(email, password) {
  const res = await fetch(`${API}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const j = await res.json().catch(() => ({}));
  if (!j.token) throw new Error(`login failed for ${email}: ${res.status} ${j.message ?? ''}`);
  return j.token;
}

const hrmsCounts = async () => {
  const out = {};
  for (const t of ['hrms_roles', 'hrms_positions', 'hrms_role_responsibility_assignments', 'hrms_position_content_overrides', 'hrms_audit_log']) {
    out[t] = Number((await q(`SELECT COUNT(*) n FROM ${t} WHERE company_id = ?`, [COMPANY]))[0].n);
  }
  return out;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

try {
  const [app] = await q("SELECT id FROM apps WHERE company_id = ? AND slug = 'cf_hrms' AND deleted_at IS NULL", [COMPANY]);
  const APP_ID = app.id;
  const cap = async (name) => (await q('SELECT capability_id FROM features_capability WHERE name = ? AND deleted_at IS NULL', [name]))[0].capability_id;
  const caps = {
    view: await cap('cf_hrms_org_view'), orgManage: await cap('cf_hrms_org_manage'),
    rolesManage: await cap('cf_hrms_roles_manage'),
  };
  const [employeeRole] = await q("SELECT id FROM roles WHERE company_id = ? AND name = 'Employee' AND deleted_at IS NULL", [COMPANY]);

  // One user per case. The password is random and never printed.
  const password = `Tt-${crypto.randomBytes(9).toString('base64url')}`;
  const hash = await bcrypt.hash(password, 10);
  async function makeUser(label, roleId) {
    const email = `${TAG.toLowerCase()}-${label}@karni.test`;
    const [r] = await pool.query('INSERT INTO users (name, email, password, role_id, company_id) VALUES (?, ?, ?, ?, ?)', [`${TAG} ${label}`, email, hash, roleId, COMPANY]);
    made.users.push(r.insertId);
    const [a] = await pool.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [r.insertId, APP_ID, roleId, COMPANY]);
    made.access.push(a.insertId);
    return { id: r.insertId, email };
  }
  async function makeRole(label, capIds) {
    const [r] = await pool.query('INSERT INTO roles (name, company_id) VALUES (?, ?)', [`${TAG} ${label}`, COMPANY]);
    made.roles.push(r.insertId);
    for (const capId of capIds) {
      const [c] = await pool.query('INSERT INTO role_capability (role_id, capability_id, app_id, company_id) VALUES (?, ?, ?, ?)', [r.insertId, capId, APP_ID, COMPANY]);
      made.capRows.push(c.insertId);
    }
    return r.insertId;
  }
  const who = {
    employee: await makeUser('employee', employeeRole.id),
    viewer: await makeUser('viewer', await makeRole('viewer', [caps.view])),
    org: await makeUser('org', await makeRole('org', [caps.view, caps.orgManage])),
    roles: await makeUser('roles', await makeRole('roles', [caps.view, caps.rolesManage])),
    both: await makeUser('both', await makeRole('both', [caps.view, caps.orgManage, caps.rolesManage])),
  };
  const tok = {};
  for (const [k, u] of Object.entries(who)) tok[k] = await login(u.email, password);
  // The login route allows 5 attempts a minute, and five were just spent. The
  // admin's token is signed the way the server signs it, for the tenant's own
  // test admin (`protect` still checks app_user_access and loads permissions).
  const [adminRow] = await q("SELECT u.id, u.email FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND LOWER(r.name) = 'admin' AND u.email NOT LIKE ? ORDER BY u.id LIMIT 1", [COMPANY, `${TAG.toLowerCase()}%`]);
  const { signToken } = await imp('core/utils/jwt.js');
  tok.admin = signToken({ id: adminRow.id, email: adminRow.email, role: 'admin', company: SLUG, companyId: COMPANY });

  // Fixture: a source role with one duty; a target role with two seats. Created as `both`.
  const c = { companyId: COMPANY, userId: who.both.id };
  const def = await RC.createMasterItem(pool, c, 'responsibilities', { name: `${TAG} duty`, description: `${TAG} A duty to copy` });
  made.defs.push(def.id);
  const srcRole = await RC.createRole(pool, c, { title: `${TAG} source`, status: 'ACTIVE' });
  const tgtRole = await RC.createRole(pool, c, { title: `${TAG} target`, status: 'ACTIVE' });
  made.hrmsRoles.push(srcRole.id, tgtRole.id);
  await RC.addContent(pool, c, srcRole.id, 'responsibilities', { responsibilityDefinitionId: def.id });
  const seat1 = (await POS.createPosition(pool, c, { roleId: tgtRole.id, positionCode: `${TAG}-1`, positionTitle: 'Seat 1', status: 'ACTIVE' })).position.id;
  const seat2 = (await POS.createPosition(pool, c, { roleId: tgtRole.id, positionCode: `${TAG}-2`, positionTitle: 'Seat 2', status: 'ACTIVE' })).position.id;
  made.positions.push(seat1, seat2);

  const req = (mode, extra = {}) => ({
    source: { type: 'role', id: srcRole.id },
    targets: mode === 'ROLE' ? [{ type: 'role', id: tgtRole.id }] : [{ type: 'position', id: seat1 }],
    mode, kinds: ['responsibilities'], ...extra,
  });

  /* ------------------------------------------------------------------ */
  console.log(`\ncontent_copy_http_test — ${API}, run tag ${TAG}`);

  console.log('\n[A] reading a source (org_view)');
  const src = (t) => http('GET', `/role-content-copy/source?type=role&id=${srcRole.id}`, tok[t]);
  const readAs = Object.fromEntries(await Promise.all(Object.keys(tok).map(async (t) => [t, (await src(t)).status])));
  ok('an employee (cf_hrms_self_view only) is refused: 403', readAs.employee === 403, JSON.stringify(readAs));
  ok('a viewer, either manager, both and the admin may read it: 200', ['viewer', 'org', 'roles', 'both', 'admin'].every((t) => readAs[t] === 200), JSON.stringify(readAs));
  ok('with no token at all: 401', (await http('GET', `/role-content-copy/source?type=role&id=${srcRole.id}`, null)).status === 401);

  console.log('\n[B] the permission follows the MODE (preview — nothing is written by any of these)');
  const matrix = [
    // mode,   employee viewer  org  roles both admin
    ['SEAT', { employee: 403, viewer: 403, org: 200, roles: 403, both: 200, admin: 200 }],
    ['ROLE', { employee: 403, viewer: 403, org: 403, roles: 200, both: 200, admin: 200 }],
    ['FORK', { employee: 403, viewer: 403, org: 403, roles: 403, both: 200, admin: 200 }],
  ];
  const before = await hrmsCounts();
  for (const [mode, expected] of matrix) {
    const got = {};
    for (const t of Object.keys(expected)) got[t] = (await http('POST', '/role-content-copy/preview', tok[t], req(mode))).status;
    ok(`${mode}: ${JSON.stringify(expected)}`, same(got, expected), JSON.stringify(got));
  }
  const unknown = {};
  for (const t of ['employee', 'viewer', 'org', 'roles', 'both', 'admin']) unknown[t] = (await http('POST', '/role-content-copy/preview', tok[t], { mode: 'TELEPORT' })).status;
  ok('an unknown mode is a 403 for anyone holding neither manage tag (employee, viewer) and a 422 for the rest — never a peek at the validation', same(unknown, { employee: 403, viewer: 403, org: 422, roles: 422, both: 422, admin: 422 }), JSON.stringify(unknown));
  const noBody = {};
  for (const t of ['employee', 'org']) noBody[t] = (await http('POST', '/role-content-copy/preview', tok[t])).status;
  ok('an empty body is still a 403 for an employee, not a validation message', noBody.employee === 403 && noBody.org === 422, JSON.stringify(noBody));
  ok('the previews wrote nothing', same(before, await hrmsCounts()));

  console.log('\n[C] writing — refusals write nothing; each manager can do only their own mode');
  const b0 = await hrmsCounts();
  const denied = [
    ['employee', 'SEAT'], ['employee', 'ROLE', { confirm: { seats: 2 } }], ['employee', 'FORK'], ['viewer', 'SEAT'],
    ['roles', 'SEAT'], ['org', 'ROLE', { confirm: { seats: 2 } }], ['org', 'FORK'], ['roles', 'FORK'],
  ];
  const results = [];
  for (const [t, mode, extra] of denied) results.push([t, mode, (await http('POST', '/role-content-copy', tok[t], req(mode, extra))).status]);
  ok('every one of the 8 wrong combinations is a 403', results.every((r) => r[2] === 403), JSON.stringify(results.filter((r) => r[2] !== 403)));
  ok('...and not one row was written by them', same(b0, await hrmsCounts()));

  const seatOk = await http('POST', '/role-content-copy', tok.org, req('SEAT'));
  ok('org_manage alone can copy to a seat (200)', seatOk.status === 200 && seatOk.json?.totals?.created === 1 && seatOk.json?.mode === 'SEAT', JSON.stringify(seatOk.json?.totals));
  const [ovr] = await q('SELECT COUNT(*) n FROM hrms_position_content_overrides WHERE company_id = ? AND position_id = ? AND deleted_at IS NULL', [COMPANY, seat1]);
  ok('...and it wrote one overlay row on that seat only', Number(ovr.n) === 1 && Number((await q('SELECT COUNT(*) n FROM hrms_position_content_overrides WHERE company_id = ? AND position_id = ? AND deleted_at IS NULL', [COMPANY, seat2]))[0].n) === 0);
  ok('the row is attributed to the user who did it', Number((await q('SELECT created_by FROM hrms_position_content_overrides WHERE company_id = ? AND position_id = ? AND deleted_at IS NULL LIMIT 1', [COMPANY, seat1]))[0].created_by) === who.org.id);

  const noConfirm = await http('POST', '/role-content-copy', tok.roles, req('ROLE'));
  ok('roles_manage alone can copy to a role — but only after confirming the seat count (422 without it)', noConfirm.status === 422 && noConfirm.json?.code === 'CONFIRM_SEATS', JSON.stringify(noConfirm.json));
  const stale = await http('POST', '/role-content-copy', tok.roles, req('ROLE', { confirm: { seats: 1 } }));
  ok('...and a stale number is a 409 that names both counts', stale.status === 409 && stale.json?.code === 'STALE_COUNT' && /1 seat/.test(stale.json.message) && /2 seats/.test(stale.json.message), stale.json?.message);
  const prev = await http('POST', '/role-content-copy/preview', tok.roles, req('ROLE'));
  ok('the preview says how many seats it would reach: 2', prev.json?.confirmSeats === 2 && prev.json?.needsSeatConfirmation === true, JSON.stringify(prev.json?.totals));
  const roleOk = await http('POST', '/role-content-copy', tok.roles, req('ROLE', { confirm: { seats: prev.json.confirmSeats } }));
  ok('with the confirmed number it is written (200)', roleOk.status === 200 && roleOk.json?.totals?.created === 1, JSON.stringify(roleOk.json?.totals ?? roleOk.json));

  const forkBody = { source: { type: 'role', id: srcRole.id }, targets: [{ type: 'position', id: seat2 }], mode: 'FORK', kinds: ['responsibilities'] };
  const forkSame = await http('POST', '/role-content-copy', tok.both, forkBody);
  ok('a fork whose lines the seat\'s role already carries is refused, not run as an empty copy (409)', forkSame.status === 409, JSON.stringify(forkSame.json));

  // the same-role refusal, over HTTP, as a person would meet it
  const same1 = await http('POST', '/role-content-copy', tok.both, { source: { type: 'role', id: tgtRole.id }, targets: [{ type: 'position', id: seat1 }], mode: 'SEAT', kinds: ['responsibilities'] });
  ok('source and target sharing a role: 409 SAME_ROLE with a sentence', same1.status === 409 && same1.json?.code === 'SAME_ROLE' && /already/.test(same1.json.message) && same1.json.message.includes(tgtRole.title), same1.json?.message);

  // a real fork, as `both`, from a fresh source so there is something to add
  const def2 = await RC.createMasterItem(pool, c, 'responsibilities', { name: `${TAG} duty two`, description: `${TAG} A second duty` });
  made.defs.push(def2.id);
  const src2 = await RC.createRole(pool, c, { title: `${TAG} source two`, status: 'ACTIVE' });
  made.hrmsRoles.push(src2.id);
  await RC.addContent(pool, c, src2.id, 'responsibilities', { responsibilityDefinitionId: def2.id });
  const fork = await http('POST', '/role-content-copy', tok.both, { source: { type: 'role', id: src2.id }, targets: [{ type: 'position', id: seat2 }], mode: 'FORK', kinds: ['responsibilities'], forkTitle: `${TAG} seat 2 own role` });
  if (fork.json?.targets?.[0]?.fork?.newRoleId) made.hrmsRoles.push(fork.json.targets[0].fork.newRoleId);
  ok('both tags can fork a seat onto a role of its own (200)', fork.status === 200 && fork.json?.totals?.newRoles === 1 && fork.json.targets[0].fork.newRoleTitle === `${TAG} seat 2 own role`, JSON.stringify(fork.json?.totals ?? fork.json));
  const [moved] = await q('SELECT role_id FROM hrms_positions WHERE company_id = ? AND id = ?', [COMPANY, seat2]);
  ok('...and the seat now holds the new role while its sibling still holds the old one',
    moved.role_id === fork.json.targets[0].fork.newRoleId && (await q('SELECT role_id FROM hrms_positions WHERE company_id = ? AND id = ?', [COMPANY, seat1]))[0].role_id === tgtRole.id);
  const dup = await http('POST', '/role-content-copy', tok.both, { source: { type: 'role', id: src2.id }, targets: [{ type: 'position', id: seat1 }], mode: 'FORK', kinds: ['responsibilities'], forkTitle: `${TAG} SEAT 2 OWN ROLE` });
  ok('a fork title that already exists (any case) is a 409 naming the clash', dup.status === 409 && dup.json?.code === 'DUPLICATE_TITLE', JSON.stringify(dup.json));

  console.log('\n[D] the admin bypass is the platform\'s own, not a hole');
  const adminSeat = await http('POST', '/role-content-copy/preview', tok.admin, req('SEAT'));
  ok('an admin may preview any mode', adminSeat.status === 200);
} catch (e) {
  failed += 1; fails.push(`unexpected error: ${e.message}`);
  console.error('\nUNEXPECTED ERROR', e);
} finally {
  /* ---------------------------------------------------------------------
   * Delete everything this run made, children first. Everything is found by
   * the ids it recorded or by the tag it carries — never by a broad filter.
   * ------------------------------------------------------------------- */
  const ids = (xs) => (xs.length ? xs : [0]);
  const del = async (label, sql, params) => { const [r] = await pool.query(sql, params); return `${label} ${r.affectedRows}`; };
  const removed = [];
  try {
    const roleIds = ids(made.hrmsRoles);
    const posIds = ids(made.positions);
    const userIds = ids(made.users);
    removed.push(await del('audit', 'DELETE FROM hrms_audit_log WHERE company_id = ? AND (actor_user_id IN (?) OR created_by IN (?))', [COMPANY, userIds, userIds]));
    removed.push(await del('overlays', 'DELETE FROM hrms_position_content_overrides WHERE company_id = ? AND position_id IN (?)', [COMPANY, posIds]));
    removed.push(await del('manpower', 'DELETE FROM hrms_manpower_requirements WHERE company_id = ? AND position_id IN (?)', [COMPANY, posIds]));
    for (const t of ['hrms_role_responsibility_assignments', 'hrms_role_kpi_assignments', 'hrms_role_kra_assignments', 'hrms_role_qualification_requirements',
      'hrms_role_skill_requirements', 'hrms_role_authority_assignments', 'hrms_role_experience_requirements', 'hrms_role_relationship_expectations', 'hrms_role_working_conditions']) {
      // a forked role is recorded above; anything it cloned goes with it
      const [r] = await pool.query(`DELETE FROM ${t} WHERE company_id = ? AND (role_id IN (?) OR created_by IN (?))`, [COMPANY, roleIds, userIds]);
      if (r.affectedRows) removed.push(`${t.replace('hrms_role_', '')} ${r.affectedRows}`);
    }
    removed.push(await del('positions', 'DELETE FROM hrms_positions WHERE company_id = ? AND (id IN (?) OR created_by IN (?))', [COMPANY, posIds, userIds]));
    removed.push(await del('hrms roles', 'DELETE FROM hrms_roles WHERE company_id = ? AND (id IN (?) OR created_by IN (?))', [COMPANY, roleIds, userIds]));
    removed.push(await del('definitions', 'DELETE FROM hrms_responsibility_definitions WHERE company_id = ? AND (id IN (?) OR created_by IN (?))', [COMPANY, ids(made.defs), userIds]));
    removed.push(await del('role_capability', 'DELETE FROM role_capability WHERE id IN (?)', [ids(made.capRows)]));
    removed.push(await del('app_user_access', 'DELETE FROM app_user_access WHERE id IN (?)', [ids(made.access)]));
    removed.push(await del('users', 'DELETE FROM users WHERE id IN (?)', [userIds]));
    removed.push(await del('platform roles', 'DELETE FROM roles WHERE id IN (?)', [ids(made.roles)]));
    console.log(`\ncleanup: ${removed.join(' | ')}`);
    const endSnapshot = await snapshot();
    const moved = WATCH.filter((t) => endSnapshot[t] !== startSnapshot[t]);
    ok('after the clean-up every table has exactly the rows it started with', moved.length === 0, moved.map((t) => `${t} ${startSnapshot[t]}->${endSnapshot[t]}`).join(', '));
  } catch (e) {
    failed += 1; fails.push(`CLEANUP FAILED — rows tagged ${TAG} may remain: ${e.message}`);
    console.error('CLEANUP FAILED', e);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log('failed:\n  - ' + fails.join('\n  - '));
await pool.end();
process.exit(failed ? 1 : 0);
