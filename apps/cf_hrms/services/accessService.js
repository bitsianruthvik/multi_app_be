/**
 * accessService.js — access roles and logins. (TM/CF_HRMS_HIRING_SPEC.md §12.5.)
 *
 * AN ACCESS ROLE is a platform role of the company (`roles`) plus this app's
 * settings for it (`hrms_access_roles`: label, description, scope). Its rights
 * are ordinary platform grants, written only through accessGrants.js — for this
 * company and its own cf_hrms app, never wider.
 *
 * A LOGIN is a platform user (`users`) with an access row for this app
 * (`app_user_access`). ACTIVE = a live access row; DISABLED = none. Disabling
 * removes that one row, which is what leaving already does, and a token the
 * person holds stops working on the next request.
 *
 * THE GUARDS — every one of them is here, on the server:
 *   - the Owner is the company's `admin` role. It is never renamed (the
 *     platform's bypass is on that name), its rights cannot be changed, and no
 *     other role may be called admin or owner;
 *   - only an Owner may hand out the Owner role, or change, disable or reset
 *     the password of an Owner's login. Without this, anyone trusted with
 *     logins could make themselves Owner or sign in as one;
 *   - nobody may give a right they do not hold themselves: a role cannot be
 *     saved with, nor a login moved to a role holding, a right the person doing
 *     it lacks;
 *   - the last Owner cannot be demoted or disabled; nobody can disable
 *     themselves, change their own role, or take their own role's access to
 *     this screen away.
 *
 * PASSWORDS are made here, hashed with bcrypt at cost 10 — exactly what the
 * platform's own sign-up and reset do (core/auth/authController.js) — and
 * returned ONCE in the response. They are never logged and never written to the
 * audit log; only the hash is stored.
 *
 * Every write ends with forgetAccess(), so it counts on the next request.
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { invalid, notFound, conflict, HrmsError } from '../lib/errors.js';
import { ALL_TAGS, SCOPES, TEMPLATES, templateOf, tagSetProblems, orderTags, summaryOf, catalog as rightsCatalog } from '../lib/access.js';
import { forgetAccess } from '../lib/accessContext.js';
import { hrmsAppOf, ensureCatalog, tagsOfRoles, newTagsOf, setRoleTags } from './accessGrants.js';
import { scopeFor } from './accessScope.js';

const BCRYPT_COST = 10;
const RESERVED = ['admin', 'owner', 'administrator', 'service'];
const lower = (s) => String(s ?? '').trim().toLowerCase();
const isOwnerName = (name) => lower(name) === 'admin';

const forbidden = (code, message) => new HrmsError(403, code, message);

async function audit(conn, c, entityType, entityId, action, before, after, requestId = null) {
  await conn.query(
    `INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, request_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, c.userId ?? null, entityType, entityId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, requestId, c.userId ?? null],
  );
}

async function requireApp(conn, companyId) {
  const app = await hrmsAppOf(conn, companyId);
  if (!app) throw new HrmsError(409, 'NO_APP', 'This company does not have the HR app.');
  return app;
}

/**
 * Who is doing this, read from the database now (not from the token): the role
 * this app's access row points at, whether it is the Owner, and the rights it holds.
 */
async function actorOf(conn, c, appId) {
  const [[row]] = await conn.query(
    `SELECT aua.role_id, r.name FROM app_user_access aua JOIN roles r ON r.id = aua.role_id AND r.deleted_at IS NULL
      WHERE aua.user_id = ? AND aua.app_id = ? AND aua.company_id = ? AND aua.deleted_at IS NULL LIMIT 1`,
    [c.userId, appId, c.companyId],
  );
  if (!row) throw forbidden('FORBIDDEN', 'You do not have access to this app');
  const owner = isOwnerName(row.name);
  const tags = owner ? new Set(ALL_TAGS) : (await tagsOfRoles(conn, { appId, roleIds: [row.role_id] })).get(row.role_id).tags;
  return { roleId: row.role_id, owner, tags };
}

/** Nobody gives a right they do not hold. */
function assertMayGive(actor, tags, what) {
  if (actor.owner) return;
  const lacking = orderTags(tags.filter((t) => !actor.tags.has(t)));
  if (lacking.length) {
    throw forbidden('CANNOT_GRANT', `${what} holds rights you do not have yourself (${lacking.length}), so you cannot give it. Ask an Owner.`);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * Catalogue
 * ══════════════════════════════════════════════════════════════════════════ */

export function getCatalog() {
  return rightsCatalog();
}

/* ══════════════════════════════════════════════════════════════════════════
 * Access roles
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Every role this app knows: one with an access row, one that holds a cf_hrms
 * right in this app, or one a login of this app is on.
 */
async function loadRoles(conn, companyId, appId, { roleId = null } = {}) {
  const [rows] = await conn.query(
    `SELECT r.id, r.name, har.label, har.description, har.scope, har.template_key, har.is_locked,
            (SELECT COUNT(*) FROM app_user_access aua JOIN users u ON u.id = aua.user_id AND u.deleted_at IS NULL
              WHERE aua.company_id = r.company_id AND aua.app_id = ? AND aua.role_id = r.id AND aua.deleted_at IS NULL) AS login_count
       FROM roles r
       LEFT JOIN hrms_access_roles har ON har.company_id = r.company_id AND har.role_id = r.id AND har.deleted_at IS NULL
      WHERE r.company_id = ? AND r.deleted_at IS NULL${roleId ? ' AND r.id = ?' : ''}
      ORDER BY r.id`,
    roleId ? [appId, companyId, roleId] : [appId, companyId],
  );
  const held = await tagsOfRoles(conn, { appId, roleIds: rows.map((r) => r.id) });
  const order = (r) => { const i = TEMPLATES.findIndex((t) => t.key === r.template_key); return i < 0 ? TEMPLATES.length : i; };
  return rows
    .map((r) => {
      const owner = isOwnerName(r.name);
      const tags = owner ? [...ALL_TAGS] : newTagsOf(held.get(r.id).tags);
      return {
        row: r,
        known: r.label != null || tags.length > 0 || Number(r.login_count) > 0 || owner,
        shape: {
          roleId: r.id,
          label: r.label ?? (owner ? 'Owner' : r.name),
          platformName: r.name,
          description: r.description ?? null,
          scope: owner ? 'COMPANY' : (r.scope === 'DEPARTMENT' ? 'DEPARTMENT' : 'COMPANY'),
          templateKey: r.template_key ?? (owner ? 'OWNER' : null),
          locked: owner || Boolean(r.is_locked),
          tags,
          loginCount: Number(r.login_count),
          summary: summaryOf(tags),
        },
      };
    })
    .filter((x) => x.known || roleId)
    .sort((a, b) => order(a.row) - order(b.row) || a.shape.label.localeCompare(b.shape.label))
    .map((x) => x.shape);
}

export async function listRoles(conn, companyId) {
  const app = await requireApp(conn, companyId);
  return { roles: await loadRoles(conn, companyId, app.id) };
}

async function requireRole(conn, companyId, appId, roleId) {
  const [role] = await loadRoles(conn, companyId, appId, { roleId });
  if (!role) throw notFound('Access role');
  return role;
}

function readLabel(value) {
  const label = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!label) throw invalid('INVALID', 'An access role needs a name.', { problems: ['An access role needs a name.'] });
  if (label.length > 100) throw invalid('INVALID', 'The name is up to 100 characters.', { problems: ['The name is up to 100 characters.'] });
  if (RESERVED.includes(lower(label))) {
    throw invalid('INVALID', `“${label}” is kept for the platform. Choose another name.`, { problems: [`“${label}” is a name the platform keeps for itself. Choose another.`] });
  }
  return label;
}
const readDescription = (value) => {
  const text = String(value ?? '').trim();
  if (text.length > 500) throw invalid('INVALID', 'The description is up to 500 characters.', { problems: ['The description is up to 500 characters.'] });
  return text || null;
};
function readScope(value) {
  const scope = String(value ?? '').trim().toUpperCase();
  if (!SCOPES.includes(scope)) throw invalid('INVALID', 'Choose the scope: the whole company, or only their department and below.', { problems: ['Scope is COMPANY or DEPARTMENT.'] });
  return scope;
}

async function assertLabelFree(conn, companyId, label, exceptRoleId = 0) {
  const [[clash]] = await conn.query(
    `SELECT r.id FROM roles r LEFT JOIN hrms_access_roles har ON har.company_id = r.company_id AND har.role_id = r.id AND har.deleted_at IS NULL
      WHERE r.company_id = ? AND r.deleted_at IS NULL AND r.id <> ? AND (LOWER(r.name) = LOWER(?) OR LOWER(har.label) = LOWER(?)) LIMIT 1`,
    [companyId, exceptRoleId, label, label],
  );
  if (clash) throw conflict('DUPLICATE', `An access role called “${label}” already exists.`, { problems: [`“${label}” already exists. Names are matched without case.`], detail: { roleId: clash.id } });
}

/** POST /access/roles { label, description?, scope, copyFrom? } */
export async function createRole(conn, c, body = {}, requestId = null) {
  const app = await requireApp(conn, c.companyId);
  const actor = await actorOf(conn, c, app.id);
  const label = readLabel(body.label);
  const description = readDescription(body.description);
  const scope = readScope(body.scope ?? 'COMPANY');
  await assertLabelFree(conn, c.companyId, label);

  let tags = [];
  if (body.copyFrom !== undefined && body.copyFrom !== null && body.copyFrom !== '') {
    const template = typeof body.copyFrom === 'string' && !/^\d+$/.test(body.copyFrom) ? templateOf(body.copyFrom) : null;
    if (template?.locked) throw invalid('INVALID', `${template.label} is not a role to copy. Start from another one.`, { problems: [`${template.label} cannot be copied.`] });
    if (template) tags = [...template.tags];
    else {
      const sourceId = Number(body.copyFrom);
      if (!Number.isInteger(sourceId) || sourceId <= 0) throw invalid('INVALID', 'Copy from a ready-made role or an existing one.', { problems: ['copyFrom is a ready-made role’s key or an access role’s id.'] });
      const source = await requireRole(conn, c.companyId, app.id, sourceId);
      if (isOwnerName(source.platformName)) throw invalid('INVALID', 'The Owner is not a role to copy. Start from another one.', { problems: ['The Owner cannot be copied.'] });
      tags = source.tags;
    }
  }
  assertMayGive(actor, tags, 'The role you are copying');

  // The platform role. Its name is the label as first given, and is not renamed afterwards.
  const [res] = await conn.query('INSERT INTO roles (name, company_id) VALUES (?, ?)', [label, c.companyId]);
  const roleId = res.insertId;
  await conn.query(
    'INSERT INTO hrms_access_roles (company_id, role_id, label, description, scope, template_key, is_locked, created_by) VALUES (?, ?, ?, ?, ?, NULL, 0, ?)',
    [c.companyId, roleId, label, description, scope, c.userId ?? null],
  );
  if (tags.length) await setRoleTags(conn, { companyId: c.companyId, appId: app.id, roleId, tags, catalog: await ensureCatalog(conn) });
  await audit(conn, c, 'hrms_access_roles', roleId, 'CREATE', null, { label, scope, tags, copyFrom: body.copyFrom ?? null }, requestId);
  forgetAccess();
  return { role: await requireRole(conn, c.companyId, app.id, roleId) };
}

/** PUT /access/roles/:roleId { label?, description?, scope?, tags? } — `tags` REPLACES the role's rights. */
export async function updateRole(conn, c, roleId, body = {}, requestId = null) {
  const app = await requireApp(conn, c.companyId);
  const actor = await actorOf(conn, c, app.id);
  const before = await requireRole(conn, c.companyId, app.id, roleId);
  if (isOwnerName(before.platformName)) {
    throw conflict('LOCKED', 'The Owner holds everything and cannot be changed. Make another access role for anything less.');
  }
  const has = (k) => Object.prototype.hasOwnProperty.call(body ?? {}, k);
  const next = {
    label: has('label') ? readLabel(body.label) : before.label,
    description: has('description') ? readDescription(body.description) : before.description,
    scope: has('scope') ? readScope(body.scope) : before.scope,
  };
  if (lower(next.label) !== lower(before.label)) await assertLabelFree(conn, c.companyId, next.label, roleId);

  let tags = null;
  if (has('tags')) {
    const problems = tagSetProblems(body.tags);
    if (problems.length) throw invalid('INVALID', problems[0], { problems });
    tags = orderTags(body.tags);
    // Only what CHANGES is weighed: a role may keep a right its editor lacks, but may not be given one.
    const adding = tags.filter((t) => !before.tags.includes(t));
    assertMayGive(actor, adding, 'This set');
    if (!actor.owner && actor.roleId === Number(roleId) && !tags.includes('cf_hrms_access_manage')) {
      throw conflict('SELF_LOCKOUT', 'This is your own access role. Taking “Manage logins and access” away from it would lock you out of this screen.');
    }
  }
  // Narrowing your own role to a department is the same lockout by another door.
  if (!actor.owner && actor.roleId === Number(roleId) && next.scope !== before.scope) {
    throw conflict('SELF_LOCKOUT', 'This is your own access role. Ask an Owner to change its scope.');
  }

  await conn.query(
    `INSERT INTO hrms_access_roles (company_id, role_id, label, description, scope, created_by) VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE label = VALUES(label), description = VALUES(description), scope = VALUES(scope)`,
    [c.companyId, roleId, next.label, next.description, next.scope, c.userId ?? null],
  );
  let change = null;
  if (tags) change = await setRoleTags(conn, { companyId: c.companyId, appId: app.id, roleId, tags, catalog: await ensureCatalog(conn) });
  await audit(conn, c, 'hrms_access_roles', roleId, 'UPDATE',
    { label: before.label, scope: before.scope, tags: before.tags },
    { ...next, ...(change ? { added: change.added, removed: change.removed } : {}) }, requestId);
  forgetAccess();
  const role = await requireRole(conn, c.companyId, app.id, roleId);
  return { role, loginsAffected: role.loginCount, ...(change?.stuck?.length ? { stillHeld: change.stuck } : {}) };
}

/** DELETE /access/roles/:roleId — 409 IN_USE with the logins holding it; 409 LOCKED for Owner and Employee. */
export async function deleteRole(conn, c, roleId, requestId = null) {
  const app = await requireApp(conn, c.companyId);
  await actorOf(conn, c, app.id);
  const role = await requireRole(conn, c.companyId, app.id, roleId);
  if (role.locked) throw conflict('LOCKED', `${role.label} is a ready-made role every company keeps. It cannot be deleted.`);
  const [logins] = await conn.query(
    `SELECT u.id AS userId, u.name, u.email FROM users u
      WHERE u.company_id = ? AND u.deleted_at IS NULL
        AND (u.role_id = ? OR EXISTS (SELECT 1 FROM app_user_access aua WHERE aua.user_id = u.id AND aua.company_id = u.company_id AND aua.role_id = ?))
      ORDER BY u.name LIMIT 50`,
    [c.companyId, roleId, roleId],
  );
  if (logins.length) {
    throw conflict('IN_USE', `${logins.length === 1 ? 'A login is' : `${logins.length} logins are`} on ${role.label}. Move ${logins.length === 1 ? 'it' : 'them'} to another access role first.`, {
      problems: logins.slice(0, 10).map((l) => `${l.name} (${l.email}) is on it.`),
      detail: { logins: logins.map((l) => ({ userId: l.userId, name: l.name, email: l.email })) },
    });
  }
  await setRoleTags(conn, { companyId: c.companyId, appId: app.id, roleId, tags: [], catalog: await ensureCatalog(conn) });
  await conn.query('UPDATE hrms_access_roles SET deleted_at = NOW() WHERE company_id = ? AND role_id = ? AND deleted_at IS NULL', [c.companyId, roleId]);
  // The platform role goes too, unless it still grants something somewhere else.
  const [[other]] = await conn.query('SELECT COUNT(*) AS n FROM role_capability WHERE role_id = ? AND deleted_at IS NULL', [roleId]);
  if (Number(other.n) === 0) await conn.query('UPDATE roles SET deleted_at = NOW() WHERE id = ? AND company_id = ?', [roleId, c.companyId]);
  await audit(conn, c, 'hrms_access_roles', roleId, 'DELETE', { label: role.label, tags: role.tags }, null, requestId);
  forgetAccess();
  return { ok: true, roleId: Number(roleId) };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Logins
 * ══════════════════════════════════════════════════════════════════════════ */

const LOGIN_SELECT = (appIdParam = '?') => `
  SELECT u.id, u.name, u.email, u.role_id AS user_role_id,
         aua.id AS access_id, aua.role_id AS app_role_id, aua.deleted_at AS access_deleted_at,
         r.id AS role_id, r.name AS role_name, har.label AS role_label,
         e.id AS employee_id, e.employee_code, e.full_name, e.employment_status,
         p.position_code, d.name AS department_name
    FROM users u
    LEFT JOIN app_user_access aua ON aua.user_id = u.id AND aua.app_id = ${appIdParam}
    LEFT JOIN roles r ON r.id = COALESCE(aua.role_id, u.role_id)
    LEFT JOIN hrms_access_roles har ON har.company_id = u.company_id AND har.role_id = r.id AND har.deleted_at IS NULL
    LEFT JOIN hrms_employees e ON e.company_id = u.company_id AND e.user_id = u.id AND e.deleted_at IS NULL
    LEFT JOIN hrms_work_assignments wa ON wa.company_id = u.company_id AND wa.employee_id = e.id AND wa.deleted_at IS NULL
         AND wa.status <> 'ENDED' AND wa.is_primary = 1 AND (wa.effective_to IS NULL OR wa.effective_to >= CURDATE())
         AND (wa.effective_from IS NULL OR wa.effective_from <= CURDATE())
    LEFT JOIN hrms_positions p ON p.company_id = u.company_id AND p.id = wa.position_id
    LEFT JOIN hrms_departments d ON d.company_id = u.company_id AND d.id = COALESCE(p.department_id, wa.department_id)`;

const shapeLogin = (r, c) => ({
  userId: r.id,
  name: r.name,
  email: r.email,
  role: { id: r.role_id ?? null, label: r.role_label ?? (isOwnerName(r.role_name) ? 'Owner' : (r.role_name ?? '')) },
  state: r.access_id != null && r.access_deleted_at == null ? 'ACTIVE' : 'DISABLED',
  employee: r.employee_id ? {
    id: r.employee_id, employeeCode: r.employee_code, fullName: r.full_name,
    positionCode: r.position_code ?? null, departmentName: r.department_name ?? null,
  } : null,
  isYou: Number(r.id) === Number(c.userId),
});

/** GET /access/logins ?q=&roleId=&state= */
export async function listLogins(conn, c, query = {}) {
  const app = await requireApp(conn, c.companyId);
  const [rows] = await conn.query(
    `${LOGIN_SELECT()}
      WHERE u.company_id = ? AND u.deleted_at IS NULL AND (aua.id IS NOT NULL OR e.id IS NOT NULL)
      ORDER BY u.name, u.id`,
    [app.id, c.companyId],
  );
  // One row per user: a person with two live main positions (bad data) must not be listed twice.
  const seen = new Set();
  let logins = rows.filter((r) => (seen.has(r.id) ? false : seen.add(r.id))).map((r) => shapeLogin(r, c));
  const q = lower(query.q);
  if (q) logins = logins.filter((l) => [l.name, l.email, l.employee?.employeeCode, l.employee?.fullName].some((v) => lower(v).includes(q)));
  if (query.roleId !== undefined && query.roleId !== null && query.roleId !== '') logins = logins.filter((l) => Number(l.role.id) === Number(query.roleId));
  const state = String(query.state ?? '').trim().toUpperCase();
  if (state === 'ACTIVE' || state === 'DISABLED') logins = logins.filter((l) => l.state === state);

  const [without] = await conn.query(
    `SELECT e.id AS employeeId, e.employee_code AS employeeCode, e.full_name AS name, p.position_code AS positionCode, r.title AS roleTitle
       FROM hrms_employees e
       LEFT JOIN hrms_work_assignments wa ON wa.company_id = e.company_id AND wa.employee_id = e.id AND wa.deleted_at IS NULL
            AND wa.status <> 'ENDED' AND wa.is_primary = 1 AND (wa.effective_to IS NULL OR wa.effective_to >= CURDATE())
            AND (wa.effective_from IS NULL OR wa.effective_from <= CURDATE())
       LEFT JOIN hrms_positions p ON p.company_id = e.company_id AND p.id = wa.position_id
       LEFT JOIN hrms_roles r ON r.company_id = e.company_id AND r.id = COALESCE(p.role_id, wa.role_id)
      WHERE e.company_id = ? AND e.deleted_at IS NULL AND e.user_id IS NULL AND e.employment_status <> 'EXITED'
      ORDER BY e.full_name, e.id`,
    [c.companyId],
  );
  const once = new Set();
  return { logins, withoutLogin: without.filter((w) => (once.has(w.employeeId) ? false : once.add(w.employeeId))) };
}

async function loadLogin(conn, c, appId, userId, { lock = false } = {}) {
  if (lock) await conn.query('SELECT id FROM users WHERE id = ? AND company_id = ? FOR UPDATE', [userId, c.companyId]);
  const [rows] = await conn.query(`${LOGIN_SELECT()} WHERE u.company_id = ? AND u.id = ? AND u.deleted_at IS NULL`, [appId, c.companyId, userId]);
  if (!rows.length) throw notFound('Login');
  return rows[0];
}

/** How many ACTIVE logins are Owners, other than `exceptUserId`. */
async function otherOwners(conn, companyId, appId, exceptUserId) {
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS n FROM app_user_access aua
       JOIN users u ON u.id = aua.user_id AND u.deleted_at IS NULL
       JOIN roles r ON r.id = aua.role_id AND r.deleted_at IS NULL
      WHERE aua.company_id = ? AND aua.app_id = ? AND aua.deleted_at IS NULL AND LOWER(r.name) = 'admin' AND u.id <> ?`,
    [companyId, appId, exceptUserId],
  );
  return Number(row.n);
}

const isActive = (row) => row.access_id != null && row.access_deleted_at == null;
const isOwnerLogin = (row) => isOwnerName(row.role_name);

function assertMayTouch(actor, row) {
  if (isOwnerLogin(row) && !actor.owner) throw forbidden('OWNER_ONLY', 'This is an Owner’s login. Only an Owner can change it.');
}

/** The role a login is being put on: it must be one of this company's, and one the actor may give. */
async function roleToGive(conn, c, appId, actor, roleId) {
  const id = Number(roleId);
  if (!Number.isInteger(id) || id <= 0) throw invalid('INVALID', 'Choose an access role.', { problems: ['Choose an access role.'] });
  const role = await requireRole(conn, c.companyId, appId, id);
  if (isOwnerName(role.platformName)) {
    if (!actor.owner) throw forbidden('OWNER_ONLY', 'Only an Owner can make somebody an Owner.');
  } else assertMayGive(actor, role.tags, role.label);
  return role;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function readEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 200) throw invalid('INVALID', 'Enter an email address.', { problems: ['The email does not look like an email address.'] });
  return email;
}
async function assertEmailFree(conn, email, exceptUserId = 0) {
  // users.email is unique across the whole platform, deleted users included.
  const [[clash]] = await conn.query('SELECT id FROM users WHERE LOWER(email) = ? AND id <> ? LIMIT 1', [email, exceptUserId]);
  if (clash) throw conflict('DUPLICATE', 'That email already has a login. Use another address.', { problems: ['That email already has a login on this platform.'] });
}

/**
 * A password nobody chose: 16 characters from an alphabet with no look-alikes
 * (no 0/O, 1/l/I), with at least one capital, one small letter, one digit and
 * one sign. From the operating system's random source.
 */
export function makePassword() {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '@#%+=?'];
  const all = sets.join('');
  const pick = (chars) => chars[crypto.randomInt(chars.length)];
  const out = sets.map(pick);
  while (out.length < 16) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

/** POST /access/logins { employeeId, email, roleId } -> { login, password } — the password is in this answer and nowhere else. */
export async function createLogin(conn, c, body = {}, requestId = null) {
  const app = await requireApp(conn, c.companyId);
  const actor = await actorOf(conn, c, app.id);
  const employeeId = Number(body.employeeId);
  if (!Number.isInteger(employeeId) || employeeId <= 0) throw invalid('INVALID', 'Choose the employee the login is for.', { problems: ['Choose the employee the login is for.'] });
  const [[employee]] = await conn.query(
    'SELECT id, full_name, employee_code, user_id, employment_status FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE',
    [c.companyId, employeeId],
  );
  if (!employee) throw notFound('Employee');
  if (employee.user_id) throw conflict('HAS_LOGIN', `${employee.full_name} already has a login.`);
  if (employee.employment_status === 'EXITED') throw conflict('EMPLOYEE_LEFT', `${employee.full_name} has left the company and cannot be given a login.`);
  const email = readEmail(body.email);
  await assertEmailFree(conn, email);
  const role = await roleToGive(conn, c, app.id, actor, body.roleId);

  const password = makePassword();
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  const [res] = await conn.query(
    'INSERT INTO users (name, email, password, role_id, team_id, company_id) VALUES (?, ?, ?, ?, NULL, ?)',
    [employee.full_name, email, hash, role.roleId, c.companyId],
  );
  const userId = res.insertId;
  await conn.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [userId, app.id, role.roleId, c.companyId]);
  await conn.query('UPDATE hrms_employees SET user_id = ? WHERE company_id = ? AND id = ?', [userId, c.companyId, employeeId]);
  // What happened, never the password.
  await audit(conn, c, 'users', userId, 'CREATE', null, { employeeId, email, roleId: role.roleId, roleLabel: role.label }, requestId);
  forgetAccess();
  return { login: shapeLogin(await loadLogin(conn, c, app.id, userId), c), password };
}

/** PUT /access/logins/:userId { roleId?, email? } — sets BOTH users.role_id and this app's access row. */
export async function updateLogin(conn, c, userId, body = {}, requestId = null) {
  const app = await requireApp(conn, c.companyId);
  const actor = await actorOf(conn, c, app.id);
  const row = await loadLogin(conn, c, app.id, userId, { lock: true });
  assertMayTouch(actor, row);
  const has = (k) => Object.prototype.hasOwnProperty.call(body ?? {}, k);
  const change = {};

  if (has('roleId') && Number(body.roleId) !== Number(row.role_id)) {
    const role = await roleToGive(conn, c, app.id, actor, body.roleId);
    // The last Owner first — it is the more useful thing to be told, also when the last Owner is you.
    if (isOwnerLogin(row) && isActive(row) && !isOwnerName(role.platformName) && (await otherOwners(conn, c.companyId, app.id, userId)) === 0) {
      throw conflict('LAST_OWNER', `${row.name} is the only Owner. Make somebody else an Owner first.`);
    }
    if (Number(userId) === Number(c.userId)) throw conflict('SELF', 'You cannot change your own access role. Ask another Owner.');
    // Both columns, so the platform's sign-in and this app's request check agree.
    await conn.query('UPDATE users SET role_id = ? WHERE id = ? AND company_id = ?', [role.roleId, userId, c.companyId]);
    await conn.query('UPDATE app_user_access SET role_id = ? WHERE user_id = ? AND app_id = ? AND company_id = ?', [role.roleId, userId, app.id, c.companyId]);
    change.roleId = role.roleId;
    change.roleLabel = role.label;
  } else if (has('roleId') && Number(row.user_role_id) !== Number(row.role_id) && row.access_id != null) {
    // The two columns had drifted apart and the same role was sent: this app's row wins, and the other follows.
    if (isOwnerLogin(row) && !actor.owner) throw forbidden('OWNER_ONLY', 'Only an Owner can make somebody an Owner.');
    await conn.query('UPDATE users SET role_id = ? WHERE id = ? AND company_id = ?', [row.role_id, userId, c.companyId]);
    change.companyRoleAligned = true;
  }

  if (has('email')) {
    const email = readEmail(body.email);
    if (email !== lower(row.email)) {
      await assertEmailFree(conn, email, userId);
      await conn.query('UPDATE users SET email = ? WHERE id = ? AND company_id = ?', [email, userId, c.companyId]);
      change.email = email;
    }
  }
  if (Object.keys(change).length) {
    await audit(conn, c, 'users', userId, 'UPDATE', { roleId: row.role_id, email: row.email }, change, requestId);
    forgetAccess();
  }
  return { login: shapeLogin(await loadLogin(conn, c, app.id, userId), c) };
}

/** POST /access/logins/:userId/disable — removes this app's access row. */
export async function disableLogin(conn, c, userId, requestId = null) {
  const app = await requireApp(conn, c.companyId);
  const actor = await actorOf(conn, c, app.id);
  const row = await loadLogin(conn, c, app.id, userId, { lock: true });
  assertMayTouch(actor, row);
  if (isActive(row) && isOwnerLogin(row) && (await otherOwners(conn, c.companyId, app.id, userId)) === 0) {
    throw conflict('LAST_OWNER', `${row.name} is the only Owner. Make somebody else an Owner first.`);
  }
  if (Number(userId) === Number(c.userId)) throw conflict('SELF', 'You cannot disable your own login.');
  if (isActive(row)) {
    await conn.query('UPDATE app_user_access SET deleted_at = NOW() WHERE id = ? AND user_id = ? AND company_id = ?', [row.access_id, userId, c.companyId]);
    await audit(conn, c, 'users', userId, 'UPDATE', { state: 'ACTIVE' }, { state: 'DISABLED', accessRowId: row.access_id }, requestId);
    forgetAccess();
  }
  return { login: shapeLogin(await loadLogin(conn, c, app.id, userId), c) };
}

/** POST /access/logins/:userId/enable — restores it. */
export async function enableLogin(conn, c, userId, requestId = null) {
  const app = await requireApp(conn, c.companyId);
  const actor = await actorOf(conn, c, app.id);
  const row = await loadLogin(conn, c, app.id, userId, { lock: true });
  assertMayTouch(actor, row);
  if (!isActive(row)) {
    if (row.employment_status === 'EXITED') throw conflict('EMPLOYEE_LEFT', `${row.full_name ?? row.name} has left the company. Their login stays disabled.`);
    // Coming back on a role is being given it: the same two rules as a change of role.
    const role = await roleToGive(conn, c, app.id, actor, row.role_id);
    if (row.access_id != null) {
      await conn.query('UPDATE app_user_access SET deleted_at = NULL, role_id = ? WHERE id = ? AND user_id = ? AND company_id = ?', [role.roleId, row.access_id, userId, c.companyId]);
    } else {
      await conn.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [userId, app.id, role.roleId, c.companyId]);
    }
    await audit(conn, c, 'users', userId, 'UPDATE', { state: 'DISABLED' }, { state: 'ACTIVE', roleId: role.roleId }, requestId);
    forgetAccess();
  }
  return { login: shapeLogin(await loadLogin(conn, c, app.id, userId), c) };
}

/** POST /access/logins/:userId/reset-password -> { password } — a new one, returned once. */
export async function resetPassword(conn, c, userId, requestId = null) {
  const app = await requireApp(conn, c.companyId);
  const actor = await actorOf(conn, c, app.id);
  const row = await loadLogin(conn, c, app.id, userId, { lock: true });
  assertMayTouch(actor, row);
  // Resetting a password is signing in as that person: not for a login that holds more than you do.
  if (!actor.owner && Number(userId) !== Number(c.userId) && row.role_id != null) {
    assertMayGive(actor, (await requireRole(conn, c.companyId, app.id, row.role_id)).tags, `${row.name}’s access role`);
  }
  const password = makePassword();
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  await conn.query('UPDATE users SET password = ? WHERE id = ? AND company_id = ?', [hash, userId, c.companyId]);
  await audit(conn, c, 'users', userId, 'UPDATE', null, { passwordReset: true }, requestId);
  return { password };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Me
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * GET /access/me — what the person asking may do, read now:
 * { role: { id, label, scope }, tags, scope: { all, departmentNames } }.
 */
export async function me(conn, c, access) {
  const app = await requireApp(conn, c.companyId);
  const tags = access.owner ? [...ALL_TAGS] : newTagsOf((await tagsOfRoles(conn, { appId: app.id, roleIds: [access.roleId] })).get(access.roleId).tags);
  const scope = await scopeFor(conn, { companyId: c.companyId, userId: c.userId, scope: access.scope, owner: access.owner });
  return {
    role: { id: access.roleId, label: access.label, scope: access.scope },
    tags,
    scope: { all: Boolean(scope.all), departmentNames: scope.all ? [] : scope.departmentNames },
  };
}

export default {
  getCatalog, listRoles, createRole, updateRole, deleteRole,
  listLogins, createLogin, updateLogin, disableLogin, enableLogin, resetPassword, makePassword, me,
};
