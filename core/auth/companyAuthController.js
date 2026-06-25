import bcrypt from "bcryptjs";
import crypto from "crypto";
import { pool } from "../../db.js";
import { signToken, verifyToken } from "../utils/jwt.js";
import { logger } from "../utils/logger.js";
import { getAppAccessForUser } from "../routes/appsRoutes.js";

const resolveCompany = async (slug) => {
  const [rows] = await pool.query(
    "SELECT id, slug, name FROM companies WHERE slug = ? AND deleted_at IS NULL LIMIT 1",
    [slug]
  );
  return rows[0] || null;
};

const fetchUiPermissions = async (roleId, teamId, companyId) => {
  try {
    let featureRows = [];
    try {
      // JSON_CONTAINS instead of JSON_TABLE — JSON_TABLE isn't supported on
      // TiDB (MySQL-compatible but not MySQL 8's JSON_TABLE), and this form
      // works identically on both. team_id uses <=> since many roles have a
      // NULL team_id, which `=` never matches.
      [featureRows] = await pool.query(
        `SELECT DISTINCT f.feature_tag FROM role_capability rc
         JOIN features_capability fc ON rc.capability_id = fc.capability_id AND fc.deleted_at IS NULL
         JOIN features f ON JSON_CONTAINS(fc.features_json, CAST(f.id AS JSON))
         WHERE rc.role_id = ? AND rc.team_id <=> ? AND rc.company_id = ?
           AND rc.deleted_at IS NULL AND f.type = 'frontend'`,
        [roleId, teamId, companyId]
      );
    } catch {
      const [capRows] = await pool.query(
        `SELECT fc.features_json FROM role_capability rc
         JOIN features_capability fc ON rc.capability_id = fc.capability_id AND fc.deleted_at IS NULL
         WHERE rc.role_id = ? AND rc.team_id <=> ? AND rc.company_id = ?
           AND rc.deleted_at IS NULL`,
        [roleId, teamId, companyId]
      );
      const ids = [];
      for (const r of capRows) {
        let arr = Array.isArray(r.features_json) ? r.features_json : [];
        if (!Array.isArray(r.features_json) && typeof r.features_json === "string") {
          try { arr = JSON.parse(r.features_json || "[]"); } catch { arr = []; }
        }
        ids.push(...arr.map((x) => parseInt(x, 10)).filter(Boolean));
      }
      if (ids.length) {
        const ph = ids.map(() => "?").join(",");
        [featureRows] = await pool.query(
          `SELECT feature_tag FROM features WHERE id IN (${ph}) AND type = 'frontend'`,
          ids
        );
      }
    }
    return featureRows.map((f) => f.feature_tag);
  } catch (e) {
    logger.error({ err: e }, "fetchUiPermissions failed");
    return [];
  }
};

// POST /api/:company/auth/login
export const companyLogin = async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ message: "Email and password are required" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ message: "Invalid email format" });
    if (password.length < 8)
      return res.status(400).json({ message: "Password must be at least 8 characters" });

    const company = await resolveCompany(req.params.company);
    if (!company) return res.status(404).json({ message: "Company not found" });

    const [userRows] = await pool.query("SELECT * FROM users WHERE email = ? LIMIT 1", [email]);
    if (!userRows.length) return res.status(404).json({ message: "User not found" });
    const user = userRows[0];

    if (user.company_id !== company.id)
      return res.status(403).json({ message: "User does not belong to this company" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: "Invalid credentials" });

    const [[roleRow]] = await pool.query("SELECT name FROM roles WHERE id = ? LIMIT 1", [user.role_id]);
    const [[teamRow]] = await pool.query("SELECT name FROM teams WHERE id = ? LIMIT 1", [user.team_id]);
    const roleName = roleRow?.name || null;
    const teamName = teamRow?.name || null;

    const uiPermissions = await fetchUiPermissions(user.role_id, user.team_id, user.company_id);

    const payload = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: roleName,
      team: teamName,
      company: company.slug,
      companyId: company.id,
      company_id: company.id,
      uiPermissions,
    };

    const token = signToken(payload);
    res.cookie("token", token, {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      secure: process.env.NODE_ENV === "production",
    });

    let appRoles = {};
    try {
      const appAccess = await getAppAccessForUser(user.id, company.id);
      appRoles = Object.fromEntries(
        appAccess.map(a => [a.slug, { roleId: a.userRoleId, uiPermissions: a.uiPermissions }])
      );
    } catch (e) {
      logger.error({ err: e }, "appRoles lookup failed during companyLogin");
    }

    return res.json({ message: "Login successful", token, user: { ...payload, appRoles }, appRoles, company });
  } catch (err) {
    logger.error({ err }, "companyLogin error");
    return res.status(500).json({ message: "Server error during login" });
  }
};

// GET /api/:company/auth/verify
export const companyVerify = async (req, res) => {
  try {
    let token = req.cookies?.token;
    if (!token && req.headers?.authorization?.startsWith("Bearer "))
      token = req.headers.authorization.substring(7);
    if (!token) return res.status(401).json({ message: "Not authenticated" });
    const decoded = verifyToken(token);
    if (!decoded) return res.status(403).json({ message: "Invalid or expired token" });
    let appRoles = {};
    try {
      const appAccess = await getAppAccessForUser(decoded.id, decoded.companyId ?? decoded.company_id);
      appRoles = Object.fromEntries(
        appAccess.map(a => [a.slug, { roleId: a.userRoleId, uiPermissions: a.uiPermissions }])
      );
    } catch (e) {
      logger.error({ err: e }, "appRoles lookup failed during companyVerify");
    }
    return res.json({ user: { ...decoded, appRoles }, appRoles });
  } catch (err) {
    logger.error({ err }, "companyVerify error");
    return res.status(500).json({ message: "Server error" });
  }
};

// POST /api/:company/auth/logout
export const companyLogout = async (req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "strict" : "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return res.json({ message: "Logged out" });
};

// POST /api/:company/auth/register
export const selfRegister = async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password)
      return res.status(400).json({ message: "Name, email, and password are required" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ message: "Invalid email format" });
    if (password.length < 8)
      return res.status(400).json({ message: "Password must be at least 8 characters" });

    const company = await resolveCompany(req.params.company);
    if (!company) return res.status(404).json({ message: "Company not found" });

    const [existing] = await pool.query("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
    if (existing.length) return res.status(409).json({ message: "Email already registered" });

    const [roles] = await pool.query(
      "SELECT id FROM roles WHERE company_id = ? AND LOWER(name) != 'admin' ORDER BY id ASC LIMIT 1",
      [company.id]
    );
    const [teams] = await pool.query(
      "SELECT id FROM teams WHERE company_id = ? ORDER BY id ASC LIMIT 1",
      [company.id]
    );
    if (!roles.length || !teams.length)
      return res.status(400).json({ message: "Company is not set up for self-registration yet. Please contact your admin." });

    const hashed = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      "INSERT INTO users (name, email, password, role_id, team_id, company_id) VALUES (?, ?, ?, ?, ?, ?)",
      [name, email, hashed, roles[0].id, teams[0].id, company.id]
    );

    return res.status(201).json({ message: "Registration successful", userId: result.insertId });
  } catch (err) {
    logger.error({ err }, "selfRegister error");
    return res.status(500).json({ message: "Server error during registration" });
  }
};

// POST /api/:company/auth/forgot-password
export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ message: "Email is required" });

    const company = await resolveCompany(req.params.company);
    if (!company) return res.status(404).json({ message: "Company not found" });

    const [userRows] = await pool.query(
      "SELECT id FROM users WHERE email = ? AND company_id = ? LIMIT 1",
      [email, company.id]
    );

    // Always return same message to prevent email enumeration
    if (!userRows.length) {
      return res.json({ message: "If your email is registered, a reset link has been sent." });
    }

    const userId = userRows[0].id;
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await pool.query("DELETE FROM password_resets WHERE user_id = ?", [userId]);
    await pool.query(
      "INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)",
      [userId, token, expiresAt]
    );

    const isDev = process.env.NODE_ENV !== "production";
    return res.json({
      message: "If your email is registered, a reset link has been sent.",
      ...(isDev && { devResetToken: token }),
    });
  } catch (err) {
    logger.error({ err }, "forgotPassword error");
    return res.status(500).json({ message: "Server error" });
  }
};

// POST /api/:company/auth/reset-password
export const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password)
      return res.status(400).json({ message: "Token and new password are required" });
    if (password.length < 8)
      return res.status(400).json({ message: "Password must be at least 8 characters" });

    const [rows] = await pool.query(
      "SELECT * FROM password_resets WHERE token = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1",
      [token]
    );
    if (!rows.length)
      return res.status(400).json({ message: "Invalid or expired reset token" });

    const reset = rows[0];
    const hashed = await bcrypt.hash(password, 10);
    await pool.query("UPDATE users SET password = ? WHERE id = ?", [hashed, reset.user_id]);
    await pool.query("UPDATE password_resets SET used_at = NOW() WHERE id = ?", [reset.id]);

    return res.json({ message: "Password reset successful. You can now sign in." });
  } catch (err) {
    logger.error({ err }, "resetPassword error");
    return res.status(500).json({ message: "Server error" });
  }
};
