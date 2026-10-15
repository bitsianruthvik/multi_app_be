import { protect } from '../../../core/middleware/authmiddleware.js';
import { signToken } from '../../../core/utils/jwt.js';
import { q, parseJson } from './db.js';
import { roleDef, eff } from './roles.js';

/**
 * WHO IS ASKING, as this app sees them.
 *
 * `protect` (with appContext before it) has already checked the token, that
 * the URL's company is the token's company, and that the login has an
 * app_user_access row for this app. Here:
 *   1. the company → its CUSTOMER (cf_crm_customer_companies). A company that
 *      is not set up as part of a customer cannot use the app yet.
 *   2. the login → its MEMBER row (role, owner name, businesses, perms). A
 *      login with access but no member row is added on first use: the
 *      company's platform admin as an Owner, anyone else as Read-only on the
 *      company's own business. An owner changes that in Setup → Owners & team.
 *   3. a disabled member is refused.
 * The company and user always come from the token, never the URL or body.
 */

const CACHE_MS = 10000;
const cfgCache = new Map(); // customerId -> { at, cfg }

export function forgetConfig(customerId) { cfgCache.delete(Number(customerId)); }

export async function configOf(customerId) {
  const hit = cfgCache.get(customerId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.cfg;
  const rows = await q('SELECT value FROM cf_crm_settings WHERE customer_id = ? AND k = ?', [customerId, 'config']);
  const cfg = rows[0] ? parseJson(rows[0].value, {}) : {};
  cfgCache.set(customerId, { at: Date.now(), cfg });
  return cfg;
}

export async function customerOfCompany(companyId) {
  const rows = await q(
    `SELECT c.id, c.slug, c.name, c.brand, cc.business_id
       FROM cf_crm_customer_companies cc
       JOIN cf_crm_customers c ON c.id = cc.customer_id AND c.deleted_at IS NULL
      WHERE cc.company_id = ? LIMIT 1`, [companyId]);
  if (!rows[0]) return null;
  return { ...rows[0], brand: parseJson(rows[0].brand, {}) };
}

async function loadMember(customer, req) {
  const userId = Number(req.user.id);
  const rows = await q(
    `SELECT m.*, u.email, u.name AS user_name, u.company_id
       FROM cf_crm_members m JOIN users u ON u.id = m.user_id
      WHERE m.customer_id = ? AND m.user_id = ? LIMIT 1`, [customer.id, userId]);
  if (rows[0]) return rows[0];

  // first use: Owner for the company's platform admin, Read-only otherwise
  const [platform] = await q(
    `SELECT LOWER(r.name) AS role_name FROM app_user_access aua
       JOIN roles r ON r.id = aua.role_id
      WHERE aua.user_id = ? AND aua.app_id = ? AND aua.company_id = ? AND aua.deleted_at IS NULL LIMIT 1`,
    [userId, Number(req.appCtx?.id), Number(req.user.companyId ?? req.user.company_id)]);
  const isAdmin = platform?.role_name === 'admin';
  const biz = !isAdmin && customer.business_id ? [customer.business_id] : [];
  await q(
    `INSERT IGNORE INTO cf_crm_members (customer_id, user_id, role, owner, businesses, perms, active)
     VALUES (?, ?, ?, '', ?, '{}', 1)`, [customer.id, userId, isAdmin ? 'admin' : 'readonly', JSON.stringify(biz)]);
  const again = await q(
    `SELECT m.*, u.email, u.name AS user_name, u.company_id
       FROM cf_crm_members m JOIN users u ON u.id = m.user_id
      WHERE m.customer_id = ? AND m.user_id = ? LIMIT 1`, [customer.id, userId]);
  return again[0] || null;
}

/** The member as the routes use it. `id` is the platform user id (a number). */
function shape(customer, row, cfg) {
  const m = {
    id: Number(row.user_id),
    customerId: customer.id,
    companyId: Number(row.company_id),
    email: row.email || '',
    name: row.user_name || '',
    role: row.role,
    owner: row.owner || '',
    active: !!row.active,
    businesses: parseJson(row.businesses, []),
    perms: parseJson(row.perms, {}),
    lastSeen: row.last_seen,
    createdAt: row.created_at,
    totpEnabled: !!row.totp_enabled,
    mustChangePassword: !!row.must_change_password,
  };
  m.roleDef = roleDef(m.role, Array.isArray(cfg.roles) ? cfg.roles : []);
  m.can = eff(m);
  return m;
}

/** What the browser is told about a login (ids are strings, as the app compares them). */
export function publicMember(m) {
  if (!m) return null;
  return {
    id: String(m.id), email: m.email, name: m.name, role: m.role, owner: m.owner, active: m.active,
    totpEnabled: !!m.totpEnabled, mustChangePassword: !!m.mustChangePassword, lastLogin: m.lastSeen || null, createdAt: m.createdAt || null,
    businesses: m.businesses || [], perms: m.perms || {}, companyId: m.companyId,
  };
}

/**
 * protect, then the customer and member. Puts req.crm = { customer, me, cfg }.
 * opts.settings: owners only (role permission `settings`).
 */
export function crm({ settings = false, pending = false } = {}) {
  const resolve = async (req, res, next) => {
    try {
      if (!req.user || req.user.is_service) return res.status(403).json({ error: 'Sign in to use this app.' });
      if (!req.appCtx) return res.status(404).json({ error: 'This app is not set up for this company.' });
      const companyId = Number(req.user.companyId ?? req.user.company_id);
      const customer = await customerOfCompany(companyId);
      if (!customer) return res.status(403).json({ error: 'This company is not set up as a customer of this app yet.' });
      const cfg = await configOf(customer.id);
      const row = await loadMember(customer, req);
      if (!row) return res.status(403).json({ error: 'You do not have access to this app.' });
      if (!row.active) return res.status(403).json({ error: 'Your access to this app has been turned off. Ask an owner.' });
      const me = shape(customer, row, cfg);

      // A password change, a reset by an owner or "sign out everywhere" ends
      // every sign-in made before it (the platform's token cannot be revoked,
      // so this app refuses it instead).
      // tokens this app issues carry the millisecond (crmIssued); the platform's only the second (iat)
      const validAfter = row.sessions_valid_after ? new Date(row.sessions_valid_after).getTime() : 0;
      const issued = Number(req.user.crmIssued) || Number(req.user.iat) * 1000;
      if (validAfter && !(issued >= validAfter)) {
        return res.status(401).json({ error: 'Your session has ended. Please sign in again.', code: 'SESSION_ENDED' });
      }
      // Two-step sign-in: this sign-in must have passed it (a claim only this
      // app puts in the token, for this login).
      me.twoStepPassed = !me.totpEnabled || Number(req.user.crm2fa) === me.id;
      // Until both gates are passed only the routes marked `pending` answer:
      // who am I, the code check, and the password change.
      if (!pending && !me.twoStepPassed) return res.status(403).json({ error: 'Enter the code from your authenticator app.', code: 'TWO_STEP' });
      if (!pending && me.mustChangePassword) return res.status(403).json({ error: 'Choose a new password first.', code: 'PASSWORD_CHANGE' });

      if (settings && !me.can.settings) return res.status(403).json({ error: 'Only owners can do this.' });
      req.crm = { customer, me, cfg };
      // last seen, at most once a minute
      if (!row.last_seen || Date.now() - new Date(row.last_seen).getTime() > 60000) {
        q('UPDATE cf_crm_members SET last_seen = UTC_TIMESTAMP() WHERE customer_id = ? AND user_id = ?', [customer.id, me.id]).catch(() => {});
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
  return [protect, resolve];
}

/**
 * A fresh platform token for this login, same claims plus `extra`. Used after
 * a password change (so this sign-in survives while the others end) and after
 * a passed two-step code. Signed with the platform's own secret and expiry.
 */
export function mintToken(req, extra = {}) {
  const { iat, exp, nbf, ...claims } = req.user || {};
  return signToken({ ...claims, ...extra, crmIssued: Date.now() });
}

/** Wraps an async handler: { error } on failure, the same shape the app reads. */
export const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res, req.crm);
  } catch (err) {
    if (err && err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    console.error('[cf_crm]', err);
    return res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
  }
};
