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

/**
 * THE ONE ANSWER A FAILED SIGN-IN GETS (2026-11-24): an unknown company, an unknown login, a login of ANOTHER company and
 * a wrong password all read the same, so a sign-in page tells nobody which emails or companies exist. (They said "User
 * not found", "User not in this company" and "Invalid credentials" before.)
 */
export const LOGIN_FAILED = { status: 401, message: "Invalid email or password" };
/** Sign-up is closed (companyAuthController.selfRegister): people are added by their company's admin. */
export const SIGNUP_CLOSED = { status: 403, message: "Accounts are created by your company's admin. Ask them to add you." };
let dummyHash = null; // made once, at the same cost as the users' own
/** Spends a password check's time when there is no user, so the answer's timing does not tell either. */
export async function burnPasswordCheck(bcrypt, password) {
  try { dummyHash ??= await bcrypt.hash("not-a-password", 10); await bcrypt.compare(String(password ?? ""), dummyHash); } catch { /* timing only */ }
}

/** The user a login names in THIS company — by email or by username — never one of another company. */
export async function findLoginUser(login, companyId) {
  const text = String(login ?? "").trim();
  if (!companyId) return null;
  if (text.includes("@")) {
    const [rows] = await pool.query("SELECT * FROM users WHERE email = ? AND company_id = ? ORDER BY deleted_at IS NULL DESC, id LIMIT 1", [text, companyId]);
    return rows[0] ?? null;
  }
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
