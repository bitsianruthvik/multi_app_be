/**
 * adminPanelService.js — THE COMPANY ADMIN PANEL (user, 2026-11-19): "view all the apps and roles accessible to the
 * admin of that company … create new roles and assign features and capabilities … all user management should also
 * happen through it. Our consultant can leverage it to do the initial set up and later the company can do it themselves."
 *
 * WHAT AN ADMIN SEES: a person, their role in each app, and what that role may do. What is kept in step behind it:
 *
 *   app_user_access     one row a person an app, with the role that counts INSIDE that app (authmiddleware reads it on
 *                       every request). The row is UNIQUE(user, app) whatever deleted_at says, so access taken away and
 *                       given back is the same row.
 *   users.role_id       the "base" role. Only company-level routes read it. The panel sets it when it is empty (a new
 *                       person) and otherwise leaves it — changing it could change what an older app shows.
 *   role_capability     role + app → capability. The panel writes ONE capability per permission (features_capability
 *                       whose list is that one feature — made when missing), so a role's rows of an app ARE its
 *                       permissions. Rows with no app or with a team are someone's older, wider grant: the panel shows
 *                       their permissions as held and locked, and does not touch them.
 *
 * WHAT A PERMISSION IS CALLED comes from the app: apps/<slug>/permissions.js (departments with levels, approvals,
 * switches, standard roles). An app without that file still works here — its permissions are a plain list of ticks.
 *
 * Every write is one transaction of the caller's, ends by clearing the permission cache, and leaves a line in
 * admin_audit. The company is always the caller's own (from the token) — never a parameter.
 */
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { clearPermissionCache } from '../middleware/authmiddleware.js';
import cfErpPermissions from '../../apps/cf_erp/permissions.js';

/** The apps that describe their permissions. Add an app's file here when it has one. */
export const CATALOGS = { cf_erp: cfErpPermissions };

export class AdminError extends Error {
  constructor(code, message, problems = null, status = 422) { super(message); this.code = code; this.problems = problems; this.status = status; }
}
const refuse = (code, message, problems = null) => new AdminError(code, message, problems);
const notFound = (what) => new AdminError('NOT_FOUND', `${what} was not found in this company.`, null, 404);
const blank = (v) => v == null || String(v).trim() === '';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;
const SYNTHETIC = /@[a-z0-9_-]+\.login$/i;
const isAdminName = (name) => String(name ?? '').trim().toLowerCase() === 'admin';

// --- small reads ---------------------------------------------------------------------------------

async function companyOf(db, companyId) {
  const [[c]] = await db.query('SELECT id, slug, name FROM companies WHERE id = ? AND deleted_at IS NULL', [companyId]);
  if (!c) throw notFound('The company');
  return c;
}
async function companyApps(db, companyId) {
  const [rows] = await db.query('SELECT id, slug, name FROM apps WHERE company_id = ? AND deleted_at IS NULL ORDER BY name', [companyId]);
  return rows;
}
const jsonIds = (v) => { let a = v; if (typeof v === 'string') { try { a = JSON.parse(v || '[]'); } catch { a = []; } } return (Array.isArray(a) ? a : []).map((x) => parseInt(x, 10)).filter(Boolean); };

/** Every permission of an app: the tags that start with its slug, and any other feature some role holds in that app. */
async function appFeatures(db, app) {
  const [granted] = await db.query(
    `SELECT DISTINCT fc.features_json FROM role_capability rc JOIN apps a ON a.id = rc.app_id AND a.slug = ?
       JOIN features_capability fc ON fc.capability_id = rc.capability_id AND fc.deleted_at IS NULL
      WHERE rc.deleted_at IS NULL`, [app.slug]);
  const ids = [...new Set(granted.flatMap((g) => jsonIds(g.features_json)))];
  const like = `${app.slug.replace(/[\\%_]/g, (ch) => `\\${ch}`)}\\_%`;
  const [rows] = await db.query(
    `SELECT id, feature_tag, feature_name FROM features WHERE deleted_at IS NULL AND (feature_tag LIKE ? ${ids.length ? 'OR id IN (?)' : ''}) ORDER BY feature_name`,
    ids.length ? [like, ids] : [like]);
  return rows.map((f) => ({ id: f.id, tag: f.feature_tag, label: String(f.feature_name ?? f.feature_tag).replace(/^[A-Za-z ]+:\s*/, '').replace(/^./, (ch) => ch.toUpperCase()) }));
}

/** A role's tags in an app: `own` (the rows the panel manages) and `shared` (rows with no app or with a team). */
async function roleTags(db, roleId, appId) {
  const [rows] = await db.query(
    `SELECT rc.app_id, rc.team_id, f.feature_tag
       FROM role_capability rc
       JOIN features_capability fc ON fc.capability_id = rc.capability_id AND fc.deleted_at IS NULL
       JOIN features f ON JSON_CONTAINS(fc.features_json, CAST(f.id AS JSON)) AND f.deleted_at IS NULL
      WHERE rc.role_id = ? AND (rc.app_id = ? OR rc.app_id IS NULL) AND rc.deleted_at IS NULL`, [roleId, appId]);
  const own = new Set(); const shared = new Set();
  for (const r of rows) (r.app_id != null && r.team_id == null ? own : shared).add(r.feature_tag);
  return { own, shared };
}

// --- the catalog: tags as an admin reads them ------------------------------------------------------

const union = (lists) => [...new Set(lists.flat())];
export function standardTags(catalog, std) {
  return union([
    ...Object.entries(std.levels ?? {}).map(([dep, lvl]) => catalog.departments.find((d) => d.key === dep)?.levels.find((l) => l.key === lvl)?.tags ?? []),
    std.approvals ?? [],
    ...(std.switches ?? []).map((k) => catalog.switches.find((s) => s.key === k)?.tags ?? []),
  ]);
}
/** The level a set of tags is at in a department: 'none', a level key, or 'custom' (some of its tags, matching no level). */
export function levelOf(dept, tags) {
  const all = union(dept.levels.map((l) => l.tags));
  const held = all.filter((x) => tags.has(x));
  if (!held.length) return 'none';
  const hit = dept.levels.find((l) => l.tags.length === held.length && l.tags.every((x) => tags.has(x)));
  return hit ? hit.key : 'custom';
}
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/** One app of a role, for the editor. */
function describe(app, features, catalog, tags, locked, role) {
  const has = (tag) => tags.has(tag);
  const known = new Set();
  const out = { appId: app.id, slug: app.slug, name: app.name, hasCatalog: !!catalog, tags: [...tags].sort(), locked: [...locked].sort(), departments: [], approvals: [], switches: [], other: [], standard: null };
  if (catalog) {
    out.departments = catalog.departments.map((d) => {
      d.levels.forEach((l) => l.tags.forEach((x) => known.add(x)));
      return { key: d.key, label: d.label, help: d.help ?? null, level: levelOf(d, tags), levels: d.levels.map((l) => ({ key: l.key, label: l.label, tags: l.tags })) };
    });
    out.approvals = catalog.approvals.map((a) => { known.add(a.tag); return { tag: a.tag, label: a.label, on: has(a.tag) }; });
    out.switches = catalog.switches.map((s) => { s.tags.forEach((x) => known.add(x)); return { key: s.key, label: s.label, help: s.help ?? null, tags: s.tags, on: s.tags.every(has), partly: s.tags.some(has) && !s.tags.every(has) }; });
    const std = catalog.standardRoles.find((s) => `${app.slug}:${s.key}` === role?.standard_key) ?? catalog.standardRoles.find((s) => s.name.toLowerCase() === String(role?.name ?? '').toLowerCase());
    if (std) out.standard = { key: std.key, name: std.name, differs: !sameSet(standardTags(catalog, std).slice().sort(), [...tags].sort()) };
    out.standards = catalog.standardRoles.map((s) => ({ key: s.key, name: s.name, help: s.help ?? null }));
  }
  out.other = features.filter((f) => !known.has(f.tag)).map((f) => ({ tag: f.tag, label: f.label, on: has(f.tag) }));
  out.all = features.map((f) => ({ tag: f.tag, label: f.label, on: has(f.tag), locked: locked.has(f.tag) }));
  return out;
}

// --- audit ------------------------------------------------------------------------------------------

async function audit(db, c, action, subjectType, subjectId, summary, detail = null) {
  await db.query('INSERT INTO admin_audit (company_id, actor_id, actor_name, action, subject_type, subject_id, summary, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, c.userId ?? null, c.userName ?? null, action, subjectType, subjectId, String(summary).slice(0, 500), detail ? JSON.stringify(detail) : null]);
}

// --- who is an admin --------------------------------------------------------------------------------

/** May this signed-in person open the panel? The tick on the person, or (as before) a base role named admin. */
export async function isCompanyAdmin(db, user) {
  if (!user?.id) return false;
  if (isAdminName(user.role)) return true;
  const [[u]] = await db.query('SELECT is_company_admin, deactivated_at FROM users WHERE id = ? AND company_id = ? AND deleted_at IS NULL', [user.id, user.companyId ?? user.company_id]);
  return !!u && Number(u.is_company_admin) === 1 && !u.deactivated_at;
}
async function activeAdmins(db, companyId) {
  const [rows] = await db.query(
    `SELECT u.id FROM users u LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.company_id = ? AND u.deleted_at IS NULL AND u.deactivated_at IS NULL AND (u.is_company_admin = 1 OR LOWER(TRIM(r.name)) = 'admin')`, [companyId]);
  return rows.map((r) => Number(r.id));
}

// --- people -----------------------------------------------------------------------------------------

const shapePerson = (u, access) => ({
  id: u.id, name: u.name, username: u.username ?? null, email: SYNTHETIC.test(u.email ?? '') ? null : u.email, login: u.username ?? u.email,
  admin: Number(u.is_company_admin) === 1, fullAccess: isAdminName(u.base_role), baseRole: u.base_role ?? null,
  active: !u.deactivated_at, deactivatedAt: u.deactivated_at ?? null, lastLoginAt: u.last_login_at ?? null, mustChangePassword: Number(u.must_change_password) === 1,
  apps: access.filter((a) => Number(a.user_id) === Number(u.id)).map((a) => ({ appId: a.app_id, slug: a.slug, appName: a.app_name, roleId: a.role_id, roleName: a.role_name })),
});
const PERSON_SELECT = `SELECT u.id, u.name, u.email, u.username, u.is_company_admin, u.deactivated_at, u.last_login_at, u.must_change_password, u.role_id, r.name AS base_role
  FROM users u LEFT JOIN roles r ON r.id = u.role_id`;
async function accessRows(db, companyId, userId = null) {
  const [rows] = await db.query(
    `SELECT x.user_id, x.app_id, x.role_id, a.slug, a.name AS app_name, r.name AS role_name
       FROM app_user_access x JOIN apps a ON a.id = x.app_id AND a.deleted_at IS NULL LEFT JOIN roles r ON r.id = x.role_id
      WHERE x.company_id = ? AND x.deleted_at IS NULL ${userId ? 'AND x.user_id = ?' : ''} ORDER BY a.name`, userId ? [companyId, userId] : [companyId]);
  return rows;
}

/** GET /people */
export async function listPeople(db, companyId) {
  const [[users], access] = await Promise.all([
    db.query(`${PERSON_SELECT} WHERE u.company_id = ? AND u.deleted_at IS NULL ORDER BY (u.deactivated_at IS NOT NULL), u.name`, [companyId]),
    accessRows(db, companyId),
  ]);
  const people = users.map((u) => shapePerson(u, access));
  return { people, counts: { all: people.length, active: people.filter((p) => p.active).length, admins: people.filter((p) => p.active && (p.admin || p.fullAccess)).length } };
}

/** GET /people/:id — with the permissions the person's role gives in each app (the screens are worked out from these). */
export async function getPerson(db, companyId, id) {
  const [[u]] = await db.query(`${PERSON_SELECT} WHERE u.company_id = ? AND u.id = ? AND u.deleted_at IS NULL`, [companyId, Number(id)]);
  if (!u) throw notFound('This person');
  const p = shapePerson(u, await accessRows(db, companyId, u.id));
  for (const a of p.apps) { const t = await roleTags(db, a.roleId, a.appId); a.tags = [...new Set([...t.own, ...t.shared])].sort(); }
  return p;
}

/** A login as typed: an email, or a username for someone who has none. → { email, username } or a problem. */
async function readLogin(db, company, raw, problems, exceptUserId = null) {
  const login = String(raw ?? '').trim().toLowerCase();
  if (!login) { problems.push('Give a login: an email, or a username for someone with no email.'); return null; }
  if (login.includes('@')) {
    if (!EMAIL_RE.test(login) || login.length > 100) { problems.push(`"${login}" is not an email address.`); return null; }
    if (SYNTHETIC.test(login)) { problems.push('An address ending in .login is kept for usernames.'); return null; }
    const [[dup]] = await db.query('SELECT id FROM users WHERE email = ? AND id <> ?', [login, exceptUserId ?? 0]);
    if (dup) { problems.push(`${login} is already a login (in this company or another).`); return null; }
    return { email: login, username: null };
  }
  if (!USERNAME_RE.test(login)) { problems.push(`"${login}": a username is 3 to 40 letters, digits, dots, dashes or underscores, starting with a letter or digit.`); return null; }
  const [[dup]] = await db.query('SELECT id FROM users WHERE company_id = ? AND username = ? AND id <> ?', [company.id, login, exceptUserId ?? 0]);
  if (dup) { problems.push(`${login} is already a username in this company.`); return null; }
  return { email: `${login}@${company.slug}.login`.slice(0, 100), username: login };
}

/** A password an admin can read out: 10 characters, no look-alikes. */
export function tempPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz'; const digits = '23456789';
  const pick = (set, n) => Array.from({ length: n }, () => set[crypto.randomInt(set.length)]).join('');
  return `${pick(abc, 1).toUpperCase()}${pick(abc, 4)}-${pick(digits, 4)}`;
}

/** Gives, changes or takes away a person's role in each app named. apps: { [appId]: roleId | null }. → words for the audit. */
async function setAccess(db, c, userId, apps) {
  const mine = await companyApps(db, c.companyId);
  const said = [];
  for (const [appIdRaw, roleRaw] of Object.entries(apps ?? {})) {
    const app = mine.find((a) => Number(a.id) === Number(appIdRaw));
    if (!app) throw refuse('INVALID', 'That app is not one of this company\'s.');
    const [[row]] = await db.query('SELECT id, role_id, deleted_at FROM app_user_access WHERE user_id = ? AND app_id = ?', [userId, app.id]);
    if (blank(roleRaw)) {
      if (row && !row.deleted_at) { await db.query('UPDATE app_user_access SET deleted_at = NOW() WHERE id = ?', [row.id]); said.push(`no access to ${app.name}`); }
      continue;
    }
    const [[role]] = await db.query('SELECT id, name FROM roles WHERE id = ? AND company_id = ? AND deleted_at IS NULL', [Number(roleRaw), c.companyId]);
    if (!role) throw refuse('INVALID', 'That role is not one of this company\'s.');
    if (row) {
      if (row.deleted_at || Number(row.role_id) !== Number(role.id)) {
        await db.query('UPDATE app_user_access SET role_id = ?, company_id = ?, deleted_at = NULL WHERE id = ?', [role.id, c.companyId, row.id]);
        said.push(`${role.name} in ${app.name}`);
      }
    } else {
      await db.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [userId, app.id, role.id, c.companyId]);
      said.push(`${role.name} in ${app.name}`);
    }
    // The base role is set once, when it is empty (see the header).
    await db.query('UPDATE users SET role_id = ? WHERE id = ? AND role_id IS NULL', [role.id, userId]);
  }
  return said;
}

/** POST /people { name, login, apps: { appId: roleId }, admin? } → { person, tempPassword } (the password is shown once). */
export async function createPerson(db, c, input = {}) {
  const company = await companyOf(db, c.companyId);
  const problems = [];
  const name = blank(input.name) ? null : String(input.name).trim().slice(0, 100);
  if (!name) problems.push('Give the person a name.');
  const login = await readLogin(db, company, input.login, problems);
  if (problems.length) throw refuse('INVALID', 'The person cannot be added.', problems);
  const pw = tempPassword();
  const [r] = await db.query(
    'INSERT INTO users (name, email, username, password, company_id, must_change_password, is_company_admin) VALUES (?, ?, ?, ?, ?, 1, ?)',
    [name, login.email, login.username, await bcrypt.hash(pw, 10), c.companyId, input.admin === true ? 1 : 0]);
  const said = await setAccess(db, c, r.insertId, input.apps ?? {});
  await audit(db, c, 'person_added', 'person', r.insertId, `Added ${name}${said.length ? `: ${said.join(', ')}` : ' with no app yet'}${input.admin === true ? '; admin' : ''}.`);
  return { person: await getPerson(db, c.companyId, r.insertId), tempPassword: pw };
}

/**
 * POST /people/bulk { appId, rows: [{ name, login, role }] } — the consultant's first day. `role` is a role's NAME in
 * this company. Every row is checked first; nothing is added unless all are right. → the people with their passwords.
 */
export async function createPeople(db, c, input = {}) {
  const rows = Array.isArray(input.rows) ? input.rows.filter((r) => !blank(r?.name) || !blank(r?.login)) : [];
  if (!rows.length) throw refuse('INVALID', 'Paste at least one person.');
  if (rows.length > 200) throw refuse('INVALID', 'Up to 200 people at a time.');
  const [roles] = await db.query('SELECT id, name FROM roles WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  const apps = await companyApps(db, c.companyId);
  const app = apps.find((a) => Number(a.id) === Number(input.appId));
  if (!app) throw refuse('INVALID', 'Choose the app these people will use.');
  const problems = []; const seen = new Set(); const plan = [];
  for (const [n, r] of rows.entries()) {
    const at = `Row ${n + 1}`;
    const role = roles.find((x) => x.name.toLowerCase() === String(r.role ?? '').trim().toLowerCase());
    if (blank(r.name)) problems.push(`${at}: the name is missing.`);
    if (!role) problems.push(`${at}: "${r.role ?? ''}" is not a role of this company.`);
    const key = String(r.login ?? '').trim().toLowerCase();
    if (seen.has(key)) problems.push(`${at}: ${key} is twice in the list.`);
    seen.add(key);
    plan.push({ name: r.name, login: r.login, roleId: role?.id });
  }
  if (problems.length) throw refuse('INVALID', 'Nobody was added. Correct these and paste again.', problems);
  const out = [];
  for (const [n, p] of plan.entries()) {
    try { const made = await createPerson(db, c, { name: p.name, login: p.login, apps: { [app.id]: p.roleId } }); out.push({ name: made.person.name, login: made.person.login, role: made.person.apps[0]?.roleName ?? null, tempPassword: made.tempPassword }); }
    catch (e) { throw refuse('INVALID', 'Nobody was added. Correct these and paste again.', (e.problems ?? [e.message]).map((m) => `Row ${n + 1}: ${m}`)); }
  }
  return { added: out };
}

/** PUT /people/:id { name?, login?, admin?, apps? } */
export async function updatePerson(db, c, id, input = {}) {
  const company = await companyOf(db, c.companyId);
  const [[u]] = await db.query('SELECT * FROM users WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, Number(id)]);
  if (!u) throw notFound('This person');
  const problems = []; const sets = {}; const said = [];
  if (input.name !== undefined) {
    const name = blank(input.name) ? null : String(input.name).trim().slice(0, 100);
    if (!name) problems.push('Give the person a name.');
    else if (name !== u.name) { sets.name = name; said.push(`renamed to ${name}`); }
  }
  if (input.login !== undefined && String(input.login).trim().toLowerCase() !== String(u.username ?? u.email).toLowerCase()) {
    const login = await readLogin(db, company, input.login, problems, u.id);
    if (login) { sets.email = login.email; sets.username = login.username; said.push(`login is now ${login.username ?? login.email}`); }
  }
  if (input.admin !== undefined && (input.admin === true) !== (Number(u.is_company_admin) === 1)) {
    if (input.admin !== true && Number(u.id) === Number(c.userId)) problems.push('You cannot take the admin tick off yourself; another admin can.');
    sets.is_company_admin = input.admin === true ? 1 : 0;
    said.push(input.admin === true ? 'made an admin' : 'no longer an admin');
  }
  if (problems.length) throw refuse('INVALID', 'The change cannot be saved.', problems);
  if (Object.keys(sets).length) await db.query(`UPDATE users SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(sets), u.id]);
  if (input.apps) said.push(...(await setAccess(db, c, u.id, input.apps)));
  if (!(await activeAdmins(db, c.companyId)).length) throw refuse('LAST_ADMIN', 'A company needs at least one active admin.');
  if (said.length) await audit(db, c, 'person_changed', 'person', u.id, `${u.name}: ${said.join(', ')}.`);
  clearPermissionCache();
  return getPerson(db, c.companyId, u.id);
}

/** POST /people/:id/deactivate | /activate */
export async function setActive(db, c, id, active) {
  const [[u]] = await db.query('SELECT id, name, deactivated_at FROM users WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, Number(id)]);
  if (!u) throw notFound('This person');
  if (!active && Number(u.id) === Number(c.userId)) throw refuse('SELF', 'You cannot deactivate yourself; another admin can.');
  await db.query('UPDATE users SET deactivated_at = ? WHERE id = ?', [active ? null : new Date(), u.id]);
  if (!(await activeAdmins(db, c.companyId)).length) throw refuse('LAST_ADMIN', 'A company needs at least one active admin.');
  await audit(db, c, active ? 'person_activated' : 'person_deactivated', 'person', u.id, `${u.name} was ${active ? 'made active again' : 'deactivated: they can no longer log in'}.`);
  return getPerson(db, c.companyId, u.id);
}

/** POST /people/:id/reset-password → { tempPassword } — shown once; the person must change it at the next login. */
export async function resetPassword(db, c, id) {
  const [[u]] = await db.query('SELECT id, name FROM users WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, Number(id)]);
  if (!u) throw notFound('This person');
  const pw = tempPassword();
  await db.query('UPDATE users SET password = ?, must_change_password = 1 WHERE id = ?', [await bcrypt.hash(pw, 10), u.id]);
  await audit(db, c, 'password_reset', 'person', u.id, `A new temporary password was made for ${u.name}.`);
  return { tempPassword: pw };
}

/** POST /me/password { current, next } — anyone, for themselves. Clears "must change". */
export async function changeOwnPassword(db, c, input = {}) {
  const next = String(input.next ?? '');
  if (next.length < 8) throw refuse('INVALID', 'A password is at least 8 characters.');
  const [[u]] = await db.query('SELECT id, password FROM users WHERE id = ? AND company_id = ? AND deleted_at IS NULL FOR UPDATE', [c.userId, c.companyId]);
  if (!u) throw notFound('Your login');
  if (!(await bcrypt.compare(String(input.current ?? ''), u.password))) throw refuse('WRONG_PASSWORD', 'The current password is not right.');
  if (await bcrypt.compare(next, u.password)) throw refuse('INVALID', 'The new password must differ from the current one.');
  await db.query('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?', [await bcrypt.hash(next, 10), u.id]);
  return { changed: true };
}

// --- roles ------------------------------------------------------------------------------------------

/** GET /roles */
export async function listRoles(db, companyId) {
  const apps = await companyApps(db, companyId);
  const [[roles], [held], [base], [grants]] = await Promise.all([
    db.query('SELECT id, name, standard_key FROM roles WHERE company_id = ? AND deleted_at IS NULL ORDER BY name', [companyId]),
    db.query('SELECT role_id, app_id, COUNT(*) AS n FROM app_user_access WHERE company_id = ? AND deleted_at IS NULL GROUP BY role_id, app_id', [companyId]),
    db.query('SELECT role_id, COUNT(*) AS n FROM users WHERE company_id = ? AND deleted_at IS NULL GROUP BY role_id', [companyId]),
    db.query('SELECT role_id, app_id, COUNT(*) AS n FROM role_capability WHERE company_id = ? AND deleted_at IS NULL AND app_id IS NOT NULL GROUP BY role_id, app_id', [companyId]),
  ]);
  const out = [];
  for (const r of roles) {
    const inApps = apps.filter((a) => grants.some((g) => Number(g.role_id) === Number(r.id) && Number(g.app_id) === Number(a.id)) || held.some((h) => Number(h.role_id) === Number(r.id) && Number(h.app_id) === Number(a.id)));
    let standard = null;
    for (const a of inApps) {
      const cat = CATALOGS[a.slug];
      const std = cat?.standardRoles.find((s) => `${a.slug}:${s.key}` === r.standard_key) ?? cat?.standardRoles.find((s) => s.name.toLowerCase() === r.name.toLowerCase());
      if (!std) continue;
      const t = await roleTags(db, r.id, a.id);
      standard = { app: a.name, name: std.name, differs: !sameSet(standardTags(cat, std).slice().sort(), [...new Set([...t.own, ...t.shared])].sort()) };
    }
    out.push({
      id: r.id, name: r.name, fullAccess: isAdminName(r.name), apps: inApps.map((a) => ({ appId: a.id, slug: a.slug, name: a.name })),
      people: held.filter((h) => Number(h.role_id) === Number(r.id)).reduce((n, h) => n + Number(h.n), 0),
      baseOf: Number(base.find((b) => Number(b.role_id) === Number(r.id))?.n ?? 0), standard,
    });
  }
  // What decides an app's MENU beside permissions (the panel draws "this role sees" from it). cf_erp: which Stores menu.
  let storesDesk = false;
  try { const [[s]] = await db.query('SELECT stores_v2 FROM cf_company_settings WHERE company_id = ?', [companyId]); storesDesk = Number(s?.stores_v2) === 1; } catch { /* the app's table is not there: the older menu */ }
  return { roles: out, apps: apps.map((a) => ({ appId: a.id, slug: a.slug, name: a.name, hasCatalog: !!CATALOGS[a.slug], options: a.slug === 'cf_erp' ? { storesDesk } : {}, standards: (CATALOGS[a.slug]?.standardRoles ?? []).map((s) => ({ key: s.key, name: s.name, help: s.help ?? null })) })) };
}

/** GET /roles/:id — every app of the company, as the editor draws it. */
export async function getRole(db, companyId, id) {
  const [[role]] = await db.query('SELECT id, name, standard_key FROM roles WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(id)]);
  if (!role) throw notFound('This role');
  const apps = await companyApps(db, companyId);
  const [people] = await db.query(
    `SELECT DISTINCT u.id, u.name, a.name AS app_name FROM app_user_access x JOIN users u ON u.id = x.user_id AND u.deleted_at IS NULL JOIN apps a ON a.id = x.app_id
      WHERE x.company_id = ? AND x.role_id = ? AND x.deleted_at IS NULL ORDER BY u.name`, [companyId, role.id]);
  const out = [];
  for (const app of apps) {
    const t = await roleTags(db, role.id, app.id);
    out.push(describe(app, await appFeatures(db, app), CATALOGS[app.slug] ?? null, new Set([...t.own, ...t.shared]), t.shared, role));
  }
  return { id: role.id, name: role.name, fullAccess: isAdminName(role.name), people: people.map((p) => ({ id: p.id, name: p.name, app: p.app_name })), apps: out };
}

/** The one capability that is exactly this feature — found, or made. */
async function capabilityOf(db, feature) {
  const [[have]] = await db.query(
    'SELECT capability_id FROM features_capability WHERE deleted_at IS NULL AND JSON_LENGTH(features_json) = 1 AND JSON_CONTAINS(features_json, CAST(? AS JSON)) ORDER BY (name = ?) DESC, capability_id LIMIT 1',
    [String(feature.id), feature.tag]);
  if (have) return have.capability_id;
  const [r] = await db.query('INSERT INTO features_capability (name, features_json) VALUES (?, JSON_ARRAY(?))', [feature.tag.slice(0, 100), feature.id]);
  return r.insertId;
}

/** Makes a role's permissions in one app exactly `tags` (those it holds through a wider, older grant stay, untouched). */
async function setRoleTags(db, companyId, roleId, app, tags) {
  const features = await appFeatures(db, app);
  const want = [...new Set(tags)];
  const unknown = want.filter((x) => !features.some((f) => f.tag === x));
  if (unknown.length) throw refuse('INVALID', `Not a permission of ${app.name}: ${unknown.join(', ')}.`);
  const before = await roleTags(db, roleId, app.id);
  const stuck = [...before.shared].filter((x) => !want.includes(x));
  if (stuck.length) throw refuse('LOCKED', `This role holds ${stuck.join(', ')} through an older company-wide grant, which this screen does not change. Ask us to remove it.`);
  await db.query('UPDATE role_capability SET deleted_at = NOW() WHERE role_id = ? AND app_id = ? AND team_id IS NULL AND deleted_at IS NULL', [roleId, app.id]);
  for (const tag of want) {
    if (before.shared.has(tag)) continue;
    const cap = await capabilityOf(db, features.find((f) => f.tag === tag));
    await db.query('INSERT INTO role_capability (role_id, team_id, company_id, app_id, capability_id) VALUES (?, NULL, ?, ?, ?)', [roleId, companyId, app.id, cap]);
  }
  const now = new Set(want);
  return { added: want.filter((x) => !before.own.has(x) && !before.shared.has(x)), removed: [...before.own].filter((x) => !now.has(x)) };
}

async function readRoleName(db, companyId, raw, exceptId = 0) {
  const name = blank(raw) ? null : String(raw).trim().slice(0, 100);
  if (!name) throw refuse('INVALID', 'Give the role a name.');
  if (isAdminName(name)) throw refuse('INVALID', 'A role named "admin" passes every check in every app. Tick "Admin" on the person instead.');
  const [[dup]] = await db.query('SELECT id FROM roles WHERE company_id = ? AND deleted_at IS NULL AND LOWER(name) = LOWER(?) AND id <> ?', [companyId, name, exceptId]);
  if (dup) throw refuse('INVALID', `There is already a role called ${name}.`);
  return name;
}

/** POST /roles { name, standard?: { appId, key }, copyOf?: roleId } */
export async function createRole(db, c, input = {}) {
  const name = await readRoleName(db, c.companyId, input.name);
  const apps = await companyApps(db, c.companyId);
  let from = '';
  let standardKey = null; let seed = [];   // [{ app, tags }]
  if (input.standard) {
    const app = apps.find((a) => Number(a.id) === Number(input.standard.appId));
    const cat = app ? CATALOGS[app.slug] : null;
    const std = cat?.standardRoles.find((s) => s.key === input.standard.key);
    if (!std) throw refuse('INVALID', 'That standard role does not exist.');
    standardKey = `${app.slug}:${std.key}`; seed = [{ app, tags: standardTags(cat, std) }]; from = ` from the standard role ${std.name}`;
  } else if (!blank(input.copyOf)) {
    const [[src]] = await db.query('SELECT id, name, standard_key FROM roles WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, Number(input.copyOf)]);
    if (!src) throw notFound('The role to copy');
    for (const app of apps) { const t = await roleTags(db, src.id, app.id); if (t.own.size) seed.push({ app, tags: [...t.own] }); }
    standardKey = src.standard_key ?? null; from = `, a copy of ${src.name}`;
  }
  const [r] = await db.query('INSERT INTO roles (name, company_id, standard_key) VALUES (?, ?, ?)', [name, c.companyId, standardKey]);
  for (const s of seed) await setRoleTags(db, c.companyId, r.insertId, s.app, s.tags);
  await audit(db, c, 'role_added', 'role', r.insertId, `Added the role ${name}${from}.`);
  clearPermissionCache();
  return getRole(db, c.companyId, r.insertId);
}

/** PUT /roles/:id { name?, apps?: { [appId]: { tags: [...] } } } */
export async function saveRole(db, c, id, input = {}) {
  const [[role]] = await db.query('SELECT id, name FROM roles WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, Number(id)]);
  if (!role) throw notFound('This role');
  const said = [];
  if (input.name !== undefined && String(input.name).trim() !== role.name) {
    if (isAdminName(role.name)) throw refuse('INVALID', 'The role named admin is the one the apps treat as full access; it keeps its name.');
    const name = await readRoleName(db, c.companyId, input.name, role.id);
    await db.query('UPDATE roles SET name = ? WHERE id = ?', [name, role.id]);
    said.push(`renamed to ${name}`);
  }
  const apps = await companyApps(db, c.companyId);
  for (const [appId, v] of Object.entries(input.apps ?? {})) {
    const app = apps.find((a) => Number(a.id) === Number(appId));
    if (!app) throw refuse('INVALID', 'That app is not one of this company\'s.');
    const d = await setRoleTags(db, c.companyId, role.id, app, Array.isArray(v?.tags) ? v.tags.map(String) : []);
    if (d.added.length || d.removed.length) said.push(`${app.name}: ${[d.added.length ? `gave ${d.added.join(', ')}` : null, d.removed.length ? `took away ${d.removed.join(', ')}` : null].filter(Boolean).join('; ')}`);
  }
  if (said.length) await audit(db, c, 'role_changed', 'role', role.id, `${role.name}: ${said.join('. ')}.`);
  clearPermissionCache();
  return getRole(db, c.companyId, role.id);
}

/** POST /roles/:id/reset { appId } — back to the standard role it came from (or is named after). */
export async function resetRole(db, c, id, input = {}) {
  const [[role]] = await db.query('SELECT id, name, standard_key FROM roles WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, Number(id)]);
  if (!role) throw notFound('This role');
  const app = (await companyApps(db, c.companyId)).find((a) => Number(a.id) === Number(input.appId));
  const cat = app ? CATALOGS[app.slug] : null;
  const std = cat?.standardRoles.find((s) => `${app.slug}:${s.key}` === role.standard_key) ?? cat?.standardRoles.find((s) => s.name.toLowerCase() === role.name.toLowerCase());
  if (!std) throw refuse('INVALID', 'This role was not made from a standard role.');
  await setRoleTags(db, c.companyId, role.id, app, standardTags(cat, std));
  await db.query('UPDATE roles SET standard_key = ? WHERE id = ?', [`${app.slug}:${std.key}`, role.id]);
  await audit(db, c, 'role_reset', 'role', role.id, `${role.name} was reset to the standard role ${std.name} in ${app.name}.`);
  clearPermissionCache();
  return getRole(db, c.companyId, role.id);
}

/** DELETE /roles/:id — only a role nobody holds. */
export async function deleteRole(db, c, id) {
  const [[role]] = await db.query('SELECT id, name FROM roles WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, Number(id)]);
  if (!role) throw notFound('This role');
  const [[h]] = await db.query(
    `SELECT (SELECT COUNT(*) FROM app_user_access WHERE role_id = ? AND deleted_at IS NULL) AS in_apps,
            (SELECT COUNT(*) FROM users WHERE role_id = ? AND deleted_at IS NULL) AS base`, [role.id, role.id]);
  if (Number(h.in_apps) || Number(h.base)) throw refuse('IN_USE', `${Number(h.in_apps) + Number(h.base)} ${Number(h.in_apps) + Number(h.base) === 1 ? 'person holds' : 'people hold'} ${role.name}. Give them another role first.`);
  await db.query('UPDATE role_capability SET deleted_at = NOW() WHERE role_id = ? AND deleted_at IS NULL', [role.id]);
  await db.query('UPDATE roles SET deleted_at = NOW() WHERE id = ?', [role.id]);
  await audit(db, c, 'role_removed', 'role', role.id, `Removed the role ${role.name}.`);
  clearPermissionCache();
  return { removed: true };
}

// --- apps and history ---------------------------------------------------------------------------------

/** GET /overview — the company, its apps with how many people and roles each has. */
export async function overview(db, companyId) {
  const company = await companyOf(db, companyId);
  const apps = await companyApps(db, companyId);
  const [use] = await db.query('SELECT app_id, COUNT(DISTINCT user_id) AS people, COUNT(DISTINCT role_id) AS roles FROM app_user_access WHERE company_id = ? AND deleted_at IS NULL GROUP BY app_id', [companyId]);
  return {
    company: { id: company.id, slug: company.slug, name: company.name },
    apps: apps.map((a) => {
      const u = use.find((x) => Number(x.app_id) === Number(a.id));
      return { appId: a.id, slug: a.slug, name: a.name, people: Number(u?.people ?? 0), roles: Number(u?.roles ?? 0), hasCatalog: !!CATALOGS[a.slug] };
    }),
  };
}

/** GET /history?limit= — newest first. */
export async function history(db, companyId, q = {}) {
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
  const [rows] = await db.query('SELECT id, actor_name, action, subject_type, subject_id, summary, created_at FROM admin_audit WHERE company_id = ? ORDER BY id DESC LIMIT ?', [companyId, limit]);
  return rows.map((r) => ({ id: r.id, by: r.actor_name ?? null, action: r.action, subject: { type: r.subject_type, id: r.subject_id }, summary: r.summary, at: r.created_at }));
}
