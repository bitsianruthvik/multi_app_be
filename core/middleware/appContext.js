import { pool } from "../../db.js";
import { logger } from "../utils/logger.js";

// In-process TTL cache for company + app records. These records change at
// human cadence (rarely) but every API request resolves them, so caching them
// removes 2 DB round trips from the hot path. TTL is intentionally short so
// that config edits propagate within a minute without a deploy.
const CONTEXT_TTL_MS = parseInt(process.env.APP_CONTEXT_TTL_MS, 10) || 60_000;
const contextCache = new Map(); // key -> { company, app, expiresAt }

function cacheGet(key) {
  const entry = contextCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    contextCache.delete(key);
    return null;
  }
  return entry;
}

function cacheSet(key, company, app) {
  contextCache.set(key, {
    company,
    app,
    expiresAt: Date.now() + CONTEXT_TTL_MS,
  });
}

/**
 * Middleware to detect which app/company is being used from the request URL.
 * It expects the URL to include an app slug as the first path segment after /api
 * Example: /api/:appSlug/admin/..., /api/:appSlug/user/...
 * Attaches the company/app record to req.company if found.
 */
export const appContext = async (req, res, next) => {
  try {
    // Expect URL shape: /api/:company/:appSlug/...
    // When middleware is mounted inside a router (e.g. /api/:company/:appSlug/admin),
    // Express sets req.baseUrl to the mount path and req.path to the remaining path.
    // Use baseUrl + path (or originalUrl) to extract slugs reliably.
    const fullPath = (req.baseUrl || "") + (req.path || "") || req.originalUrl || "";
    const parts = fullPath.split("/").filter(Boolean);
    logger.debug({ fullPath }, "[appContext] fullPath");
    logger.debug({ parts }, "[appContext] parts");
    let companySlug = null;
    let appSlug = null;

    // parts may be ['api', company, appSlug, ...] or [company, appSlug, ...]
    if (parts.length > 0 && parts[0].toLowerCase() === "api") {
      companySlug = parts.length > 1 ? parts[1] : null;
      appSlug = parts.length > 2 ? parts[2] : null;
    } else {
      companySlug = parts.length > 0 ? parts[0] : null;
      appSlug = parts.length > 1 ? parts[1] : null;
    }

    // If this is a root public or query API path (e.g. /api/public/... or /api/query/...),
    // skip context detection — these endpoints are global and should not be treated as
    // company/app-scoped requests. Exit early so mounted routes can run.
    if (
      parts.length > 1 &&
      parts[0].toLowerCase() === "api" &&
      ["public", "query"].includes(parts[1].toLowerCase())
    ) {
      req.company = null;
      req.appCtx = null;
      return next();
    }

    // Skip company-level routes: /api/:company/auth/... and /api/:company/apps
    // These use the company slug only (no app slug). We detect them by checking
    // whether the 3rd path segment is a known company-level route keyword.
    if (
      parts.length > 2 &&
      parts[0].toLowerCase() === "api" &&
      ["auth", "apps"].includes(parts[2].toLowerCase())
    ) {
      req.company = null;
      req.appCtx = null;
      return next();
    }

    // normalize leading ':' if present
    if (companySlug && companySlug.startsWith(":"))
      companySlug = companySlug.slice(1);
    if (appSlug && appSlug.startsWith(":")) appSlug = appSlug.slice(1);

    // fallback to express params if not found in path
    if ((!companySlug || !appSlug) && req.params) {
      if (!companySlug && req.params.company) companySlug = req.params.company;
      if (!appSlug && req.params.appSlug) appSlug = req.params.appSlug;
    }

    // If neither slug present, skip attaching context
    if (!companySlug) {
      req.company = null;
      req.appCtx = null;
      return next();
    }

    // Cache lookup first — companies and apps change at human cadence,
    // so a 60s TTL is acceptable and saves 2 DB queries per request.
    const cacheKey = `${companySlug}:${appSlug || ""}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      req.company = cached.company;
      req.appCtx = cached.app;
      return next();
    }

    // Load company record
    const [companyRows] = await pool.query(
      "SELECT * FROM companies WHERE slug = ?",
      [companySlug]
    );
    if (!companyRows || companyRows.length === 0) {
      return res
        .status(404)
        .json({ message: `Company not found: ${companySlug}` });
    }
    const company = companyRows[0];
    try {
      if (company.settings && typeof company.settings === "string")
        company.settings = JSON.parse(company.settings);
    } catch (e) {
      logger.warn({ err: e }, "Failed to parse company.settings JSON");
    }

    // Attach company
    req.company = company;

    // If appSlug provided, load app under this company
    let appRow = null;
    if (appSlug) {
      const [appRows] = await pool.query(
        "SELECT * FROM apps WHERE slug = ? AND company_id = ? LIMIT 1",
        [appSlug, company.id]
      );
      if (!appRows || appRows.length === 0) {
        return res.status(404).json({
          message: `App not found: ${appSlug} for company ${companySlug}`,
        });
      }
      appRow = appRows[0];
      try {
        if (appRow.settings && typeof appRow.settings === "string")
          appRow.settings = JSON.parse(appRow.settings);
      } catch (e) {
        logger.warn({ err: e }, "Failed to parse app.settings JSON");
      }
      req.appCtx = appRow;
    } else {
      req.appCtx = null;
    }

    cacheSet(cacheKey, company, appRow);

    // NOTE: Previously we rewrote req.url to remove the company/app prefix
    // which breaks Express route matching when routes are mounted under
    // `/api/:company/:appSlug/...`. Do NOT modify req.url here — keep the
    // original URL so mounted routes receive the correct path.
    // (Left intentionally blank)

    // Debug log
    logger.debug({ companySlug, appSlug, fullPath }, "[appContext] resolved");

    return next();
  } catch (err) {
    logger.error({ err }, "appContext error");
    return res.status(500).json({ message: "Internal server error" });
  }
};
