// Middleware to protect routes and verify JWT tokens

import { verifyToken } from "../utils/jwt.js";
import { logger } from "../utils/logger.js";
import { pool } from "../../db.js";

export const protect = async (req, res, next) => {
  try {
    logger.debug({
      hasAuthHeader: !!req.headers.authorization,
      cookieKeys: req.cookies ? Object.keys(req.cookies) : [],
    }, "=== Protect Middleware Debug ===");

    // Check for service-to-service token first (worker requests)
    if (req.headers && req.headers.authorization) {
      const auth = req.headers.authorization;
      if (typeof auth === "string" && auth.startsWith("Bearer ")) {
        const token = auth.substring("Bearer ".length);
        // Allow service token to bypass normal auth
        // Only honor the token if it is set and at least 16 characters long.
        if (
          process.env.WORKER_SERVICE_TOKEN &&
          process.env.WORKER_SERVICE_TOKEN.length >= 16 &&
          token === process.env.WORKER_SERVICE_TOKEN
        ) {
          logger.debug("Service token verified - allowing worker request");
          req.user = { is_service: true, role: "service", id: 0 };
          return next();
        }
      }
    }

    // Read JWT from cookies or Authorization header only.
    // Tokens are deliberately NOT accepted from request body or query string —
    // those locations end up in access logs and request tracing tools.
    let token = req.cookies && req.cookies.token ? req.cookies.token : null;
    if (!token && req.headers && req.headers.authorization) {
      const auth = req.headers.authorization;
      if (typeof auth === "string" && auth.startsWith("Bearer ")) {
        token = auth.substring("Bearer ".length);
        logger.debug("Token found in Authorization header");
      }
    } else if (token) {
      logger.debug("Token found in cookies");
    }

    if (!token) {
      logger.debug("No token found - returning 401");
      return res.status(401).json({ message: "Not authenticated" });
    }

    const decoded = verifyToken(token);
    if (!decoded) {
      logger.debug("Token verification failed - returning 403");
      return res.status(403).json({ message: "Invalid or expired token" });
    }

    logger.debug({
      id: decoded.id,
      email: decoded.email,
      company_id: decoded.company_id || decoded.companyId,
    }, "Token decoded successfully");

    req.user = decoded; // Attach decoded payload (user info + permissions)

    // Check if user has access to the requested company/app
    if (req.company) {
      // First check company access
      const companyMatchesBySlug = req.user.company === req.company.slug;
      const companyMatchesById =
        req.user.companyId &&
        req.company.id &&
        req.user.companyId === req.company.id;
      if (!companyMatchesBySlug && !companyMatchesById) {
        return res.status(403).json({
          message: "Access denied: User does not belong to this company",
          userCompany: req.user.company,
          requestedCompany: req.company.slug,
        });
      }

      // If there's an app context, verify the user has a row in app_user_access
      // and load app-specific uiPermissions so downstream handlers (e.g. mutateController)
      // can check them via req.user.uiPermissions.
      if (req.appCtx && !req.user.is_service) {
        const companyId = req.company?.id ?? req.user.companyId ?? req.user.company_id;
        const [rows] = await pool.query(
          "SELECT id, role_id FROM app_user_access WHERE user_id = ? AND app_id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1",
          [req.user.id, req.appCtx.id, companyId]
        );
        if (!rows.length) {
          return res.status(403).json({ message: "You do not have access to this app" });
        }

        // Load feature_tags for this user's role in this app
        try {
          const roleId = rows[0].role_id;
          const [permRows] = await pool.query(
            `SELECT DISTINCT f.feature_tag
               FROM role_capability rc
               JOIN features_capability fca ON fca.capability_id = rc.capability_id
                 AND fca.deleted_at IS NULL
               JOIN JSON_TABLE(fca.features_json, '$[*]' COLUMNS (fid INT PATH '$')) jt ON TRUE
               JOIN features f ON f.id = jt.fid AND f.deleted_at IS NULL
              WHERE rc.role_id = ?
                AND (rc.app_id = ? OR rc.app_id IS NULL)
                AND rc.deleted_at IS NULL`,
            [roleId, req.appCtx.id]
          );
          req.user.uiPermissions = permRows.map(r => r.feature_tag);
        } catch (permErr) {
          logger.error({ permErr }, "authmiddleware: failed to load app permissions");
          // Non-fatal — uiPermissions stays as decoded JWT value (may be empty)
        }
      }
    }

    next();
  } catch (err) {
    logger.error({ err }, "Auth middleware error");
    res.status(500).json({ message: "Authentication failed" });
  }
};

export const requireAdmin = (req, res, next) => {
  if (!req.user || !req.user.role || req.user.role.toLowerCase() !== "admin") {
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
};
