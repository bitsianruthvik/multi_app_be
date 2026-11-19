/**
 * loginRules.js — what both sign-in paths (company-level and app-level) share since the company admin panel
 * (core-init.sql "COMPANY ADMIN PANEL", 2026-11-19):
 *
 *   a login is an EMAIL, or a USERNAME for someone who has none (unique within the company);
 *   a DEACTIVATED person cannot sign in, and a signed-in one is stopped at their next request;
 *   a password SET BY AN ADMIN must be changed before anything else is allowed.
 *
 * Every read here tolerates the columns not being there yet (the code may deploy before the migration).
 */
import { pool } from "../../db.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/i;
const missing = (e) => e?.errno === 1054 || e?.errno === 1146;

/** Is this text a login at all? (An email, or a username.) */
export const validLogin = (text) => EMAIL_RE.test(String(text ?? "")) || USERNAME_RE.test(String(text ?? ""));

/** The user a login names in a company: by email (anywhere — the caller checks the company), else by username there. */
export async function findLoginUser(login, companyId) {
  const text = String(login ?? "").trim();
  if (text.includes("@")) {
    const [rows] = await pool.query("SELECT * FROM users WHERE email = ? LIMIT 1", [text]);
    return rows[0] ?? null;
  }
  if (!companyId) return null;
  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE company_id = ? AND username = ? AND deleted_at IS NULL LIMIT 1", [companyId, text.toLowerCase()]);
    return rows[0] ?? null;
  } catch (e) { if (missing(e)) return null; throw e; }
}

/** Why this user may not sign in, or null. */
export function loginRefusal(user) {
  if (user?.deleted_at || user?.deactivated_at) return "This login has been deactivated. Ask your company's admin.";
  return null;
}

/** What the token and the frontend carry beside the user. */
export const loginFlags = (user) => ({
  username: user?.username ?? null,
  mustChangePassword: Number(user?.must_change_password) === 1,
  isCompanyAdmin: Number(user?.is_company_admin) === 1,
});

export async function touchLogin(userId) {
  try { await pool.query("UPDATE users SET last_login_at = NOW() WHERE id = ?", [userId]); } catch { /* not worth failing a sign-in for */ }
}

// A signed-in person's state, re-read at most every 30 s (authmiddleware.protect): deactivated, must change password.
const STATE_TTL_MS = 30 * 1000;
const stateCache = new Map();
export function clearUserState(userId = null) { if (userId == null) stateCache.clear(); else stateCache.delete(Number(userId)); }
export async function userState(userId) {
  const id = Number(userId);
  const kept = stateCache.get(id);
  if (kept && Date.now() - kept.at < STATE_TTL_MS) return kept;
  let s = { deactivated: false, mustChange: false, isCompanyAdmin: false };
  try {
    const [[u]] = await pool.query("SELECT deactivated_at, deleted_at, must_change_password, is_company_admin FROM users WHERE id = ?", [id]);
    if (u) s = { deactivated: !!(u.deactivated_at || u.deleted_at), mustChange: Number(u.must_change_password) === 1, isCompanyAdmin: Number(u.is_company_admin) === 1 };
  } catch (e) { if (!missing(e)) throw e; }
  if (stateCache.size > 5000) stateCache.clear();
  const out = { ...s, at: Date.now() };
  stateCache.set(id, out);
  return out;
}
