import express from "express";
import { logger } from "../utils/logger.js";
import { buildQuery } from "./queryBuilder/queryBuilder.js";
import { getTableColumns } from "./queryBuilder/schemaCache.js";
import { getResourceWriteAllowlist } from "./resourceRegistry.js";
import { pool } from "../../db.js";
import { protect } from "../middleware/authmiddleware.js";
import bcrypt from "bcryptjs";

// Router
const router = express.Router();

// Validate incoming base_resource-like requests and allow some public paths
const validateRequest = (req, res, next) => {
  try {
    const p = req.path || req.url || "";
    if (
      p &&
      (p.startsWith("/upload_audio") ||
        p.startsWith("/transcribe") ||
        p.startsWith("/upload_document") ||
        p.startsWith("/update_document_medicine") ||
        p.startsWith("/debug"))
    ) {
      return next();
    }
  } catch (e) {}

  const { operation, resource } = req.body || {};
  if (!operation) {
    return res
      .status(400)
      .json({ success: false, error: "Operation is required" });
  }
  if (!resource) {
    return res
      .status(400)
      .json({ success: false, error: "Resource is required" });
  }
  return next();
};

// Allow public access to specific resources without JWT
const isPublicResource = (req) => {
  const { resource, operation } = req.body || {};
  logger.info("Checking if public resource:", { resource, operation });
  // Allow public access to companies and apps for query operations
  // Also allow public access to utility paths (transcribe/debug) which do
  // not follow the base_resource JSON contract.
  try {
    const p = req.path || req.url || "";
    if (p && (p.startsWith("/transcribe") || p.startsWith("/debug")))
      return true;
  } catch (e) {}
  return (
    (resource === "companies" || resource === "apps") && operation === "query"
  );
};

// Only verify token for non-public resources
router.use((req, res, next) => {
  // Allow a dedicated worker/service token to bypass normal company scoping.
  try {
    const authHeader =
      req.headers && (req.headers.authorization || req.headers.Authorization);
    if (authHeader && String(authHeader).startsWith("Bearer ")) {
      const token = String(authHeader).split(" ")[1];
      if (
        process.env.WORKER_SERVICE_TOKEN &&
        token === process.env.WORKER_SERVICE_TOKEN
      ) {
        // mark request as service user so later logic can skip company scoping
        req.user = { is_service: true, role: "service" };
        return next();
      }
    }
  } catch (e) {
    // fallback to normal auth flow
  }

  if (isPublicResource(req)) {
    logger.info("Allowing public access for:", req.body && req.body.resource);
    return next();
  }
  logger.info("Requiring auth for:", req.body && req.body.resource);
  // Use the protect middleware for authentication
  protect(req, res, next);
});

// Add request validation
router.use(validateRequest);

// Single endpoint for all resource operations
router.post("/base_resource", async (req, res) => {
  try {
    logger.info("Base resource request:", {
      body: req.body,
      headers: req.headers,
      url: req.url,
    });

    const { operation, resource, fields, filters, orderBy, pagination, data, include_deleted } =
      req.body || {};

    // For read operations (query)
    if (operation === "query") {
      try {
        logger.info("Building query for resource:", resource);
        const { sql, params } = await buildQuery({
          resource,
          fields,
          filters,
          orderBy,
          pagination,
          jwt: req.user,
          includeDeleted: !!include_deleted,
        });
        logger.info("Generated SQL:", sql, params);
        const [rows] = await pool.query(sql, params);
        return res.json({ success: true, data: rows });
      } catch (qErr) {
        logger.error("Query failed in base_resource:", qErr);
        return res.json({
          success: false,
          error: qErr.message || String(qErr),
        });
      }
    }

    // For write operations
    if (["insert", "update", "delete"].includes(operation)) {
      let query;
      let params;

      // Define global tables that don't have company_id
      const globalTables = [
        "features",
        "features_capability",
        "companies",
        "apps",
      ];

      switch (operation) {
        case "insert":
          // Auto-inject company_id from admin's JWT for new records (except global tables)
          const insertData = { ...data };

          if (
            req.user &&
            (req.user.company_id || req.user.companyId) &&
            !globalTables.includes(resource)
          ) {
            insertData.company_id = req.user.company_id || req.user.companyId;
          }

          // Special handling for users table - hash password before storing
          if (resource === "users" && insertData.password) {
            logger.info("Hashing password for new user");
            insertData.password = await bcrypt.hash(insertData.password, 10);
          }

          // Filter insertData against the resourceDef.json write allowlist (preferred)
          // or the schema cache (fallback for unregistered resources).
          try {
            const defAllowlist = getResourceWriteAllowlist(resource);
            const allowed = defAllowlist ?? await getTableColumns(resource);
            const filtered = Object.fromEntries(
              Object.entries(insertData).filter(([k]) => allowed.has(k))
            );
            query = `INSERT INTO ${resource} SET ?`;
            params = [filtered];
          } catch (err) {
            logger.warn("Failed to get schema for", resource, err);
            query = `INSERT INTO ${resource} SET ?`;
            params = [insertData];
          }
          break;

        case "update":
          // Ensure admin can only update records from their company.
          // Service/workers (req.user.is_service) bypass this scoping so they
          // can update records across companies when authorized via the
          // WORKER_SERVICE_TOKEN.
          const companyId =
            req.user && !req.user.is_service
              ? req.user?.company_id || req.user?.companyId
              : null;

          // Special handling for users table - hash password if being updated
          const updateData = { ...data };
          if (resource === "users" && updateData.password) {
            logger.info("Hashing password for user update");
            updateData.password = await bcrypt.hash(updateData.password, 10);
          }

          // Filter updateData against the resourceDef.json write allowlist or schema cache.
          try {
            const defAllowlistUpd = getResourceWriteAllowlist(resource);
            const allowedUpd = defAllowlistUpd ?? await getTableColumns(resource);
            const filteredUpd = Object.fromEntries(
              Object.entries(updateData).filter(([k]) => allowedUpd.has(k))
            );
            // Ensure we don't attempt to run an UPDATE with an empty SET
            // Remove `id` from the SET payload and use it in the WHERE clause
            const targetId =
              req.body?.id ||
              req.body?.data?.id ||
              filteredUpd.id ||
              updateData.id;
            if (filteredUpd.hasOwnProperty("id")) delete filteredUpd.id;
            const keysToUpdate = Object.keys(filteredUpd || {});
            if (!targetId) {
              throw new Error("Missing id for update");
            }
            if (keysToUpdate.length === 0) {
              // Nothing to update — return an error instead of producing invalid SQL
              return res.status(400).json({
                success: false,
                error: "No updatable fields provided",
              });
            }
            if (companyId) {
              query = `UPDATE ${resource} SET ? WHERE id = ? AND company_id = ?`;
              params = [filteredUpd, targetId, companyId];
            } else {
              query = `UPDATE ${resource} SET ? WHERE id = ?`;
              params = [filteredUpd, targetId];
            }
          } catch (err) {
            logger.warn(
              "Failed to introspect table columns for update",
              resource,
              err
            );
            if (companyId) {
              query = `UPDATE ${resource} SET ? WHERE id = ? AND company_id = ?`;
              params = [updateData, updateData.id, companyId];
            } else {
              query = `UPDATE ${resource} SET ? WHERE id = ?`;
              params = [updateData, updateData.id];
            }
          }
          break;

        case "delete":
          // Soft delete: set deleted_at timestamp instead of removing the row.
          // Service users bypass company scoping.
          const deleteCompanyId =
            req.user && !req.user.is_service
              ? req.user?.company_id || req.user?.companyId
              : null;
          if (deleteCompanyId) {
            query = `UPDATE ${resource} SET deleted_at = NOW() WHERE id = ? AND company_id = ? AND deleted_at IS NULL`;
            params = [data.id, deleteCompanyId];
          } else {
            query = `UPDATE ${resource} SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL`;
            params = [data.id];
          }
          break;
      }

      let result;
      try {
        logger.info("[base_resource] Executing SQL:", query, params);
        const qres = await pool.query(query, params);
        result = qres[0];
        logger.info("[base_resource] SQL result:", result);
      } catch (err) {
        logger.error(
          "[base_resource] SQL error:",
          err && err.message ? err.message : err
        );
        throw err;
      }

      return res.json({
        success: true,
        data: result,
      });
    }

    throw new Error("Invalid operation");
  } catch (error) {
    logger.error("Base resource error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Note: debug/dev-only force-update endpoint moved to `dev-tools/force_update_route.js`
// to avoid shipping dev-only routes in production. If you need this endpoint
// for local debugging, require and mount the route in your dev-only server
// setup, e.g. `app.use('/api/dev', require('../dev-tools/force_update_route').default)`.

export default router;
