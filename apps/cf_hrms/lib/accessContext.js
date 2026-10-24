/**
 * accessContext.js — who is asking, as this app sees them, read fresh.
 * (TM/CF_HRMS_HIRING_SPEC.md §12.)
 *
 * The platform's `protect` reloads a login's TAGS on every request to an app
 * (from `app_user_access.role_id`), so a right granted or taken away counts on
 * the very next call. Two things it does NOT reload are read here:
 *
 *   - THE ROLE'S NAME. `req.user.role` is whatever the login token was signed
 *     with — and the Owner's bypass is on the name `admin`. Taken from the
 *     token, a login demoted from Owner would keep the bypass until the token
 *     expired. Here the name is the name of the role this app's access row
 *     points at NOW.
 *   - THE ACCESS ROLE'S SETTINGS: its label and its scope (hrms_access_roles).
 *
 * One query, remembered for a few seconds per login so a screen that makes ten
 * calls asks once. Every write in accessService.js calls forgetAccess(), so on
 * the server that made the change it counts at once; another server process
 * would be at most CACHE_MS behind. Tags are never cached here.
 */
import { pool } from './db.js';
import { shownRoleLabel } from './access.js';

const CACHE_MS = 5000;
const cache = new Map(); // `${userId}:${appId}` -> { at, value }

/** Called after any change to roles, logins or their rights. */
export function forgetAccess() {
  cache.clear();
}

/**
 * @returns {Promise<null | { roleId, roleName, owner, label, scope, templateKey, locked }>}
 *   null when the login has no live access row for this app.
 */
export async function accessOf(req) {
  const userId = Number(req.user?.id);
  const appId = Number(req.appCtx?.id);
  const companyId = Number(req.user?.companyId ?? req.user?.company_id);
  if (!userId || !appId || !companyId || req.user?.is_service) return null;
  const key = `${userId}:${appId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const [[row]] = await pool.query(
    `SELECT aua.role_id, r.name AS role_name, har.label, har.scope, har.template_key, har.is_locked
       FROM app_user_access aua
       JOIN roles r ON r.id = aua.role_id AND r.company_id = aua.company_id AND r.deleted_at IS NULL
       LEFT JOIN hrms_access_roles har ON har.company_id = aua.company_id AND har.role_id = aua.role_id AND har.deleted_at IS NULL
      WHERE aua.user_id = ? AND aua.app_id = ? AND aua.company_id = ? AND aua.deleted_at IS NULL
      LIMIT 1`,
    [userId, appId, companyId],
  );
  const owner = Boolean(row) && String(row.role_name ?? '').toLowerCase() === 'admin';
  const value = row ? {
    roleId: row.role_id,
    roleName: row.role_name,
    owner,
    label: shownRoleLabel(row.label, row.template_key) ?? (owner ? 'Owner' : row.role_name),
    // A role nobody has described keeps what it always had: the whole company.
    scope: owner ? 'COMPANY' : (row.scope === 'DEPARTMENT' ? 'DEPARTMENT' : 'COMPANY'),
    templateKey: row.template_key ?? null,
    locked: Boolean(row.is_locked),
  } : null;
  if (cache.size > 5000) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export default { accessOf, forgetAccess };
