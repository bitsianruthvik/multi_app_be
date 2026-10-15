/**
 * The app's own roles. A login's platform role decides whether it may open
 * cf_crm at all (app_user_access); what it may do INSIDE the network is this:
 * a role id on cf_crm_members, whose permissions an owner can change in
 * Setup → Roles (saved in the customer's config as `roles`). Same rules as the
 * original NorthEast Network, enforced on the server.
 */

export const ROLES = {
  admin: { write: true, delete: true, export: true, campaigns: true, send: true, settings: true, all: true },
  manager: { write: true, delete: false, export: false, campaigns: true, send: false, settings: false, all: false },
  entry: { write: true, delete: false, export: false, campaigns: false, send: false, settings: false, all: true },
  readonly: { write: false, delete: false, export: false, campaigns: true, send: false, settings: false, all: true },
};
const PERM_KEYS = ['write', 'delete', 'export', 'campaigns', 'send', 'settings', 'all'];

/** The permissions of a role id, using the definitions saved in the config. */
export function roleDef(roleId, cfgRoles) {
  if (roleId === 'admin') return { ...ROLES.admin };
  const custom = (Array.isArray(cfgRoles) ? cfgRoles : []).find((r) => r && r.id === roleId);
  const base = { ...(ROLES[roleId] || (custom ? {} : ROLES.readonly)) };
  if (custom && custom.perms) PERM_KEYS.forEach((k) => { if (typeof custom.perms[k] === 'boolean') base[k] = custom.perms[k]; });
  PERM_KEYS.forEach((k) => { if (typeof base[k] !== 'boolean') base[k] = false; });
  return base;
}

export const roleExists = (id, cfgRoles) => !!ROLES[id] || (Array.isArray(cfgRoles) && cfgRoles.some((r) => r && r.id === id));

/** Role defaults, adjusted by the per-person permissions an owner sets. */
export function eff(m) {
  const base = { ...(m.roleDef || roleDef(m.role, [])) };
  if (m.role !== 'admin') {
    const p = m.perms || {};
    ['export', 'campaigns', 'send'].forEach((k) => { if (typeof p[k] === 'boolean') base[k] = p[k]; });
  }
  base.businesses = Array.isArray(m.businesses) ? m.businesses : [];
  return base;
}

/** May this login work on business b? No list = every business. */
export const canBiz = (m, b) => !m.businesses || !m.businesses.length || !b || m.businesses.includes(b);
