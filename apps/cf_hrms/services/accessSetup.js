/**
 * accessSetup.js — moving a company onto the rights model, so that nobody
 * loses access and nobody gains any. (TM/CF_HRMS_HIRING_SPEC.md §12.4.)
 *
 * The script (scripts/setup-access.mjs) and the test run THIS function; the
 * script only prints what it returns.
 *
 *   1. the feature rows and one capability per tag exist (global, created once);
 *   2. the company has its ready-made roles — Owner (its existing `admin` role,
 *      never renamed), HR manager, HR executive, Department head, Employee —
 *      each with its hrms_access_roles row and its grants, for this company
 *      and its own cf_hrms app only;
 *   3. every OTHER role of the company that holds old cf_hrms tags gets the new
 *      tags those map to, and an access role named after it, scope COMPANY.
 *
 * WHAT "BEFORE" AND "AFTER" MEAN. Before: what the role could do under the old
 * backend, said in the new words — the old tags it held, mapped (lib/access.js
 * OLD_TAG_MAP); for the `admin` role, everything, because the platform lets
 * that name through every check. After: the new tags it holds once this has
 * run. For a role that existed, the two must be the same set; `gained` and
 * `lost` say where they are not, and the script refuses to write when a role
 * that existed would gain anything except what its ready-made role is defined
 * to hold (reported as `byDesign`).
 *
 * IDEMPOTENT. A second run finds the roles, the rows and the grants. It never
 * takes a right away: a ready-made role somebody has since edited keeps what it
 * has, and only the Owner is brought back to "everything".
 */
import { ALL_TAGS, TEMPLATES, mapOldTags, orderTags } from '../lib/access.js';
import { hrmsAppOf, ensureCatalog, tagsOfRoles, newTagsOf, oldTagsOf, setRoleTags } from './accessGrants.js';

const lower = (s) => String(s ?? '').trim().toLowerCase();

/**
 * @returns {{
 *   company, app, apply,
 *   catalog: { features: string[], capabilities: string[], repaired: string[] },   // created / repaired (or would be)
 *   roles: [{ roleId, platformName, label, scope, templateKey, existed, logins, loginsOfRole,
 *             oldTags, before, after, gained, lost, byDesign, same, wildcard, accessRow: 'exists'|'created' }],
 *   diverged: [{ userId, userRoleId, appRoleId }],     // logins whose two role columns differ
 *   problems: string[],                                // why nothing may be written
 * }}
 */
export async function setupAccess(conn, companyId, { apply = false, userId = null, allowGain = false } = {}) {
  const [[company]] = await conn.query('SELECT id, name, slug FROM companies WHERE id = ? AND deleted_at IS NULL', [companyId]);
  if (!company) throw new Error(`No company ${companyId}.`);
  const app = await hrmsAppOf(conn, companyId);
  if (!app) throw new Error(`${company.name} has no cf_hrms app. Give it the app first.`);

  const catalog = await ensureCatalog(conn, { apply });

  const [roleRows] = await conn.query('SELECT id, name FROM roles WHERE company_id = ? AND deleted_at IS NULL ORDER BY id', [companyId]);
  const [accessRows] = await conn.query('SELECT role_id, label, scope, template_key, is_locked FROM hrms_access_roles WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const accessOfRole = new Map(accessRows.map((r) => [r.role_id, r]));
  const held = await tagsOfRoles(conn, { appId: app.id, roleIds: roleRows.map((r) => r.id) });
  const [loginRows] = await conn.query(
    `SELECT aua.role_id, COUNT(*) AS n FROM app_user_access aua JOIN users u ON u.id = aua.user_id AND u.deleted_at IS NULL
      WHERE aua.company_id = ? AND aua.app_id = ? AND aua.deleted_at IS NULL GROUP BY aua.role_id`, [companyId, app.id]);
  const loginsOf = new Map(loginRows.map((r) => [r.role_id, Number(r.n)]));
  const [userRows] = await conn.query('SELECT role_id, COUNT(*) AS n FROM users WHERE company_id = ? AND deleted_at IS NULL GROUP BY role_id', [companyId]);
  const usersOf = new Map(userRows.map((r) => [r.role_id, Number(r.n)]));

  const problems = [];
  const plan = [];
  const claimed = new Set();

  // ── 2. the ready-made roles ───────────────────────────────────────────────
  for (const t of TEMPLATES) {
    // The role that already carries this template, else the role of that platform name.
    const byKey = accessRows.find((r) => r.template_key === t.key);
    const role = roleRows.find((r) => (byKey ? r.id === byKey.role_id : lower(r.name) === lower(t.platformName))) ?? null;
    if (!role && t.key === 'OWNER') {
      problems.push(`${company.name} has no role called "admin". The Owner is that role; create it on the platform first.`);
      continue;
    }
    if (role) claimed.add(role.id);
    const have = role ? held.get(role.id) : { tags: new Set(), wildcard: new Set() };
    const oldTags = oldTagsOf(have.tags);
    const current = newTagsOf(have.tags);
    const existed = Boolean(role);
    // What the role could do before, in the new words.
    // Old tags are read ONCE: a role that has its access row is on the new model, and two old
    // names (org_view, leave_view) live on in it with a narrower meaning — mapping them again
    // on a second run would widen the role.
    const migrated = existed && accessOfRole.has(role.id);
    const before = !existed ? [] : (t.key === 'OWNER' ? [...ALL_TAGS] : orderTags([...(migrated ? [] : mapOldTags(oldTags)), ...current]));
    // A ready-made role is given its template when it is first set up; later runs add nothing
    // to one somebody may have edited. The Owner is always everything.
    const firstTime = !existed || !accessOfRole.has(role.id);
    const after = t.key === 'OWNER' ? [...ALL_TAGS] : orderTags(firstTime ? [...before, ...t.tags] : before);
    plan.push({ template: t, role, existed, oldTags, before, after, wildcard: [...have.wildcard], label: t.label, scope: t.scope, locked: t.locked });
  }

  // ── 3. every other role that holds old tags (or new ones somebody granted by hand) ──
  for (const role of roleRows) {
    if (claimed.has(role.id)) continue;
    const have = held.get(role.id);
    if (!have.tags.size && !accessOfRole.has(role.id)) continue;
    const oldTags = oldTagsOf(have.tags);
    const before = orderTags([...(accessOfRole.has(role.id) ? [] : mapOldTags(oldTags)), ...newTagsOf(have.tags)]);
    plan.push({ template: null, role, existed: true, oldTags, before, after: before, wildcard: [...have.wildcard], label: role.name, scope: 'COMPANY', locked: false });
  }

  const roles = [];
  for (const p of plan) {
    const beforeSet = new Set(p.before);
    const afterSet = new Set(p.after);
    const gained = p.after.filter((t) => !beforeSet.has(t));
    const lost = p.before.filter((t) => !afterSet.has(t));
    // A role that existed may gain only what its ready-made role is defined to hold.
    const byDesign = p.template ? gained.filter((t) => p.template.tags.includes(t)) : [];
    const unexpected = p.existed ? gained.filter((t) => !byDesign.includes(t)) : [];
    if (unexpected.length) problems.push(`${p.role.name} would gain ${unexpected.join(', ')}.`);
    // A role that already has logins is not handed its ready-made rights without somebody saying so.
    const loginCount = p.role ? (loginsOf.get(p.role.id) ?? 0) + (usersOf.get(p.role.id) ?? 0) : 0;
    if (p.existed && byDesign.length && loginCount > 0 && !allowGain) {
      problems.push(`${p.role.name} already has logins and, as the ready-made ${p.template.label}, would gain ${byDesign.join(', ')}. Run again with --allow-gain if that is meant.`);
    }
    if (lost.length) problems.push(`${p.role?.name ?? p.label} would lose ${lost.join(', ')}.`);
    roles.push({
      roleId: p.role?.id ?? null,
      platformName: p.role?.name ?? p.template.platformName,
      label: accessOfRole.get(p.role?.id)?.label ?? p.label,
      scope: accessOfRole.get(p.role?.id)?.scope ?? p.scope,
      templateKey: p.template?.key ?? null,
      existed: p.existed,
      logins: p.role ? (loginsOf.get(p.role.id) ?? 0) : 0,
      loginsOfRole: p.role ? (usersOf.get(p.role.id) ?? 0) : 0,
      oldTags: p.oldTags,
      before: p.before,
      after: p.after,
      gained,
      lost,
      byDesign,
      same: gained.length === 0 && lost.length === 0,
      wildcard: p.wildcard,
      accessRow: p.role && accessOfRole.has(p.role.id) ? 'exists' : 'created',
    });
  }

  const [diverged] = await conn.query(
    `SELECT u.id AS userId, u.role_id AS userRoleId, aua.role_id AS appRoleId
       FROM app_user_access aua JOIN users u ON u.id = aua.user_id AND u.deleted_at IS NULL
      WHERE aua.company_id = ? AND aua.app_id = ? AND aua.deleted_at IS NULL AND NOT (u.role_id <=> aua.role_id) ORDER BY u.id`,
    [companyId, app.id]);

  const report = {
    company: { id: company.id, name: company.name, slug: company.slug }, app: { id: app.id }, apply,
    catalog: { features: catalog.created.features, capabilities: catalog.created.capabilities, repaired: catalog.repaired },
    roles, diverged, problems,
  };
  if (!apply || problems.length) return report;

  // ── write ─────────────────────────────────────────────────────────────────
  for (const [i, p] of plan.entries()) {
    let roleId = p.role?.id ?? null;
    if (roleId == null) {
      const [res] = await conn.query('INSERT INTO roles (name, company_id) VALUES (?, ?)', [p.template.platformName, companyId]);
      roleId = res.insertId;
      roles[i].roleId = roleId;
    }
    if (!accessOfRole.has(roleId)) {
      await conn.query(
        `INSERT INTO hrms_access_roles (company_id, role_id, label, description, scope, template_key, is_locked, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [companyId, roleId, p.label, p.template?.description ?? null, p.scope, p.template?.key ?? null, p.locked ? 1 : 0, userId],
      );
    }
    // addOnly: this never takes a right away. `after` is a superset of what the role holds.
    await setRoleTags(conn, { companyId, appId: app.id, roleId, tags: p.after, catalog, addOnly: true });
  }
  return report;
}

export default { setupAccess };
