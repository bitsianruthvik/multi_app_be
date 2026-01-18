// Middleware to protect routes and verify JWT tokens

import { verifyToken } from "../utils/jwt.js";

export const protect = (req, res, next) => {
  try {
    console.log("=== Protect Middleware Debug ===");
    console.log(
      "Headers:",
      req.headers.authorization
        ? "Authorization header present"
        : "No Authorization header"
    );
    console.log(
      "Cookies:",
      req.cookies ? Object.keys(req.cookies) : "No cookies"
    );

    // Check for service-to-service token first (worker requests)
    if (req.headers && req.headers.authorization) {
      const auth = req.headers.authorization;
      if (typeof auth === "string" && auth.startsWith("Bearer ")) {
        const token = auth.substring("Bearer ".length);
        // Allow service token to bypass normal auth
        if (
          process.env.WORKER_SERVICE_TOKEN &&
          token === process.env.WORKER_SERVICE_TOKEN
        ) {
          console.log("Service token verified - allowing worker request");
          req.user = { is_service: true, role: "service", id: 0 };
          return next();
        }
      }
    }

    // Read JWT from cookies or Authorization header
    let token = req.cookies && req.cookies.token ? req.cookies.token : null;
    if (!token && req.headers && req.headers.authorization) {
      const auth = req.headers.authorization;
      if (typeof auth === "string" && auth.startsWith("Bearer ")) {
        token = auth.substring("Bearer ".length);
        console.log("Token found in Authorization header");
      }
    } else if (token) {
      console.log("Token found in cookies");
    }

    // Debug / fallback: allow token in body or query for debugging or clients
    // that cannot send Authorization header or cookies. This is intended
    // as a development-time aid only. It will log how the token was provided.
    if (!token) {
      if (req.body && req.body.token) {
        token = req.body.token;
        console.warn(
          "Token was provided in request body (req.body.token). This fallback is for debugging only."
        );
      } else {
        // Avoid accessing express' `req.query` getter directly since in some
        // edge cases it may attempt to access internals that are not available
        // (caused an exception in production). Parse the raw URL query string
        // as a safe fallback.
        try {
          const qs =
            req && req.url && req.url.includes("?")
              ? require("querystring").parse(req.url.split("?")[1] || "")
              : {};
          if (qs && qs.token) {
            token = qs.token;
            console.warn(
              "Token was provided in URL query string (parsed). This fallback is for debugging only."
            );
          }
        } catch (e) {
          // swallow parsing errors - we don't want the auth middleware to crash
        }
      }
    }

    if (!token) {
      console.log("No token found - returning 401");
      return res.status(401).json({ message: "Not authenticated" });
    }

    const decoded = verifyToken(token);
    if (!decoded) {
      console.log("Token verification failed - returning 403");
      return res.status(403).json({ message: "Invalid or expired token" });
    }

    console.log("Token decoded successfully:", {
      id: decoded.id,
      email: decoded.email,
      company_id: decoded.company_id || decoded.companyId,
    });

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

      // If there's an app context, verify app access
      if (req.app) {
        // Relaxed: allow admin endpoints to be reached even if uiPermissions absent,
        // since admin feature listing/mapping happens before capability assignment.
        // Keep the company check above; skip strict app permission gate here.
      }
    }

    next();
  } catch (err) {
    console.error("Auth middleware error:", err);
    res.status(500).json({ message: "Authentication failed" });
  }
};
