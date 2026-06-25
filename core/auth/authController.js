import bcrypt from "bcryptjs";
import { pool } from "../../db.js";
import { signToken, verifyToken } from "../utils/jwt.js";
import { logger } from "../utils/logger.js";
import crypto from "crypto";
import { getAppAccessForUser } from "../routes/appsRoutes.js";
// LOGIN controller
export const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Invalid email format" });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }
    // Determine current company/app from middleware (req.company) or params
    const companySlug =
      req.company?.slug || req.params?.company || req.companySlug || null;
    const appSlug = req.appCtx?.slug || req.params?.appSlug || req.appSlug || null;

    const [companys] = await pool.query(
      "SELECT id, slug, name FROM companies WHERE slug = ?",
      [companySlug]
    );

    if (!companySlug || companys.length === 0) {
      return res.status(404).json({ message: "Company not found" });
    }

    const correctCompanySlug = companys[0].slug;
    const companyName = companys[0].name;

    const [rows] = await pool.query(`SELECT * FROM users WHERE email = ?`, [
      email,
    ]);

    if (rows.length === 0)
      return res.status(404).json({ message: "User not found" });

    const user = rows[0];

    // Fetch the role name and team name from their respective tables
    const [roleRows] = await pool.query(
      "SELECT name FROM roles WHERE id = ? LIMIT 1",
      [user.role_id]
    );
    const [teamRows] = await pool.query(
      "SELECT name FROM teams WHERE id = ? LIMIT 1",
      [user.team_id]
    );

    const roleName = roleRows.length > 0 ? roleRows[0].name : null;
    const teamName = teamRows.length > 0 ? teamRows[0].name : null;

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch)
      return res.status(401).json({ message: "Invalid credentials" });

    // H01: Compare user's company_id against the company resolved from the URL
    if (user.company_id !== companys[0].id) {
      return res.status(403).json({ message: "User not in this company" });
    }

    // Fetch role-based capability and features (permissions)
    // Single query via JSON_TABLE (MySQL 8.0+); falls back to two queries for older MySQL.
    let uiPermissions = [];
    try {
      let featureRows = [];
      try {
        [featureRows] = await pool.query(
          `SELECT DISTINCT f.id, f.feature_name, f.feature_tag, f.type
           FROM role_capability rc
           JOIN features_capability fc ON rc.capability_id = fc.capability_id
           JOIN JSON_TABLE(fc.features_json, '$[*]' COLUMNS (fid INT PATH '$')) jt ON TRUE
           JOIN features f ON f.id = jt.fid
           WHERE rc.role_id = ? AND rc.team_id <=> ? AND rc.company_id = ?
             AND f.type = 'frontend'`,
          [user.role_id, user.team_id, user.company_id]
        );
      } catch (_jsonTableErr) {
        // Fallback for MySQL < 8.0
        const [capabilityRows] = await pool.query(
          `SELECT fc.features_json
           FROM role_capability rc
           JOIN features_capability fc ON rc.capability_id = fc.capability_id
           WHERE rc.role_id = ? AND rc.team_id = ? AND rc.company_id = ?`,
          [user.role_id, user.team_id, user.company_id]
        );
        const allIds = [];
        for (const row of capabilityRows) {
          const raw = row.features_json;
          let parsed = Array.isArray(raw) ? raw : [];
          if (!Array.isArray(raw) && typeof raw === "string") {
            try { parsed = JSON.parse(raw || "[]"); } catch (_) { parsed = []; }
          }
          for (const fid of parsed) {
            const n = typeof fid === "string" && /^\d+$/.test(fid) ? parseInt(fid, 10) : fid;
            if (n != null && n !== "") allIds.push(n);
          }
        }
        const ids = Array.from(new Set(allIds));
        if (ids.length > 0) {
          const ph = ids.map(() => "?").join(",");
          [featureRows] = await pool.query(
            `SELECT id, feature_name, feature_tag, type FROM features WHERE id IN (${ph}) AND type = ?`,
            [...ids, "frontend"]
          );
        }
      }
      // H02: Return slug strings, not objects
      uiPermissions = featureRows.map((f) => f.feature_tag);
    } catch (e) {
      logger.error({ err: e }, "Capability lookup failed");
    }

    // H04: Guard against null appSlug — fall back gracefully if app context is unresolved
    const resolvedAppSlug = req.appCtx?.slug || null;

    // A user's company-wide role (users.role_id, used for `uiPermissions` above)
    // and their app-specific role (app_user_access.role_id, used for `appRoles`
    // below) can be different `roles` rows with different grants — e.g. a PM or
    // Planner is often granted a broader role via app_user_access for a specific
    // app than their generic company role carries. Backend write-permission
    // checks (mutateController, and the scheduler/orders/items routes) gate on
    // the flat `uiPermissions` list embedded in the JWT, so it must include the
    // app-specific grants for the app being logged into — not just the generic
    // company-role grants — or the frontend (which checks appRoles first) will
    // show write actions the backend then rejects with 403.
    let appRoles = {};
    try {
      const appAccess = await getAppAccessForUser(user.id, companys[0].id);
      appRoles = Object.fromEntries(
        appAccess.map(a => [a.slug, { roleId: a.userRoleId, uiPermissions: a.uiPermissions }])
      );
      const currentAppAccess = resolvedAppSlug
        ? appAccess.find((a) => a.slug === resolvedAppSlug)
        : null;
      if (currentAppAccess) {
        uiPermissions = Array.from(new Set([...uiPermissions, ...currentAppAccess.uiPermissions]));
      }
    } catch (e) {
      logger.error({ err: e }, "appRoles lookup failed during login");
    }

    // Create JWT payload with user info and permissions
    const tokenPayload = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: roleName,
      team: teamName,
      team_id: user.team_id,
      company: companySlug || user.company,
      companyId: companys[0]?.id,
      company_id: companys[0]?.id,
      uiPermissions,
    };

    let token;
    try {
      token = signToken(tokenPayload);
    } catch (e) {
      logger.error({ err: e }, "Failed to sign JWT token");
      return res.status(500).json({ message: "Server error: failed to create authentication token" });
    }

    // Send token as session cookie (cleared when browser closes)
    // H03: Use sameSite "none" in production to allow cross-origin requests
    res.cookie("token", token, {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      secure: process.env.NODE_ENV === "production",
    });

    let dashboardRoute = resolvedAppSlug
      ? `/${companySlug}/${resolvedAppSlug}/dashboard`
      : "/select-company";

    // Admins go to admin dashboard; non-admins go to the app dashboard
    if (resolvedAppSlug && roleName && roleName.toLowerCase() === "admin") {
      dashboardRoute = `/${companySlug}/${resolvedAppSlug}/admin/dashboard`;
    }

    res.status(200).json({
      message: "Login successful",
      user: { ...tokenPayload, appRoles },
      token,
      dashboardRoute,
      company: {
        slug: correctCompanySlug,
        name: companys[0].name,
      },
      app: req.appCtx,
      appRoles,
    });
  } catch (err) {
    logger.error({ err }, "Login error");
    // Include error.message during development to help debugging
    res
      .status(500)
      .json({ message: "Server error during login", error: err.message });
  }
};

// Verify token from cookie and return user payload (if valid)
export const verifyUser = async (req, res) => {
  try {
    let token = req.cookies?.token;
    if (!token && req.headers && req.headers.authorization) {
      const auth = req.headers.authorization;
      if (typeof auth === "string" && auth.startsWith("Bearer ")) {
        token = auth.substring("Bearer ".length);
      }
    }
    if (!token) return res.status(401).json({ message: "Not authenticated" });
    const decoded = verifyToken(token);
    if (!decoded)
      return res.status(403).json({ message: "Invalid or expired token" });
    let appRoles = {};
    try {
      const userId = decoded.id;
      const companyId = decoded.companyId ?? decoded.company_id;
      if (userId && companyId) {
        const appAccess = await getAppAccessForUser(userId, companyId);
        appRoles = Object.fromEntries(
          appAccess.map(a => [a.slug, { roleId: a.userRoleId, uiPermissions: a.uiPermissions }])
        );
      }
    } catch (e) {
      logger.error({ err: e }, "appRoles lookup failed during verify");
    }
    return res.status(200).json({ user: { ...decoded, appRoles }, appRoles });
  } catch (err) {
    logger.error({ err }, "Verify user error");
    return res.status(500).json({ message: "Server error" });
  }
};

// Logout: clear the token cookie
export const logoutUser = async (req, res) => {
  try {
    res.clearCookie("token", {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "strict" : "lax",
      secure: process.env.NODE_ENV === "production",
    });
    return res.status(200).json({ message: "Logout successful" });
  } catch (err) {
    logger.error({ err }, "Logout error");
    return res.status(500).json({ message: "Server error" });
  }
};

// POST /api/:company/:appSlug/auth/register
export const registerUser = async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password)
      return res.status(400).json({ message: "Name, email, and password are required" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ message: "Invalid email format" });
    if (password.length < 8)
      return res.status(400).json({ message: "Password must be at least 8 characters" });

    const company = req.company;
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
    logger.error({ err }, "registerUser error");
    return res.status(500).json({ message: "Server error during registration" });
  }
};

// POST /api/:company/:appSlug/auth/forgot-password
export const requestOtp = async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ message: "Email is required" });

    const company = req.company;
    if (!company) return res.status(404).json({ message: "Company not found" });

    const [userRows] = await pool.query(
      "SELECT id FROM users WHERE email = ? AND company_id = ? LIMIT 1",
      [email, company.id]
    );

    // Always return same message to prevent email enumeration
    if (!userRows.length) {
      return res.json({ message: "If your email is registered, an OTP has been sent." });
    }

    const userId = userRows[0].id;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await pool.query("DELETE FROM password_resets WHERE user_id = ?", [userId]);
    await pool.query(
      "INSERT INTO password_resets (user_id, otp_hash, expires_at) VALUES (?, ?, ?)",
      [userId, otpHash, expiresAt]
    );

    const isDev = process.env.NODE_ENV !== "production";
    return res.json({
      message: "If your email is registered, an OTP has been sent.",
      ...(isDev && { otp }),
    });
  } catch (err) {
    logger.error({ err }, "requestOtp error");
    return res.status(500).json({ message: "Server error" });
  }
};

// POST /api/:company/:appSlug/auth/reset-password
export const resetWithOtp = async (req, res) => {
  try {
    const { email, otp, password } = req.body || {};
    if (!email || !otp || !password)
      return res.status(400).json({ message: "Email, OTP, and new password are required" });
    if (password.length < 8)
      return res.status(400).json({ message: "Password must be at least 8 characters" });

    const company = req.company;
    if (!company) return res.status(404).json({ message: "Company not found" });

    const [userRows] = await pool.query(
      "SELECT id FROM users WHERE email = ? AND company_id = ? LIMIT 1",
      [email, company.id]
    );
    if (!userRows.length) return res.status(400).json({ message: "Invalid request" });

    const userId = userRows[0].id;
    const [resetRows] = await pool.query(
      "SELECT id, otp_hash FROM password_resets WHERE user_id = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1",
      [userId]
    );
    if (!resetRows.length) return res.status(400).json({ message: "OTP has expired or is invalid. Please request a new one." });

    const isMatch = await bcrypt.compare(otp, resetRows[0].otp_hash);
    if (!isMatch) return res.status(400).json({ message: "Incorrect OTP. Please try again." });

    const newHash = await bcrypt.hash(password, 10);
    await pool.query("UPDATE users SET password = ? WHERE id = ?", [newHash, userId]);
    await pool.query("UPDATE password_resets SET used_at = NOW() WHERE id = ?", [resetRows[0].id]);

    return res.json({ message: "Password reset successful. You can now log in." });
  } catch (err) {
    logger.error({ err }, "resetWithOtp error");
    return res.status(500).json({ message: "Server error" });
  }
};
