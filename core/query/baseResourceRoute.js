import express from "express";
import { logger } from "../utils/logger.js";
import { buildQuery } from "./queryBuilder/queryBuilder.js";
import { getTableColumns } from "./queryBuilder/schemaCache.js";
import { resolveWriteTarget } from "./resourceRegistry.js";
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

    const { operation, resource, fields, filters, orderBy, pagination, data, include_deleted, includeTotal } =
      req.body || {};

    // For read operations (query)
    if (operation === "query") {
      try {
        logger.info("Building query for resource:", resource);
        const { sql, params, countSql } = await buildQuery({
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

        // `total` is opt-in. It is a genuine COUNT over the same secured WHERE,
        // NOT rows.length — with pagination those differ, and callers that
        // measured the returned array were silently reporting the page size as
        // the total (the fab_erp cockpit read "1 part defined" against 8 items).
        //
        // Opt-in because it costs a second round trip, and the overwhelming
        // majority of reads here don't need a count. Never infer a total from
        // `data.length` on the client.
        if (includeTotal) {
          if (!countSql) {
            // Aggregate queries have no meaningful row count — say so rather
            // than returning a number that answers a different question.
            return res.json({ success: true, data: rows, total: null });
          }
          const [countRows] = await pool.query(countSql, params);
          return res.json({ success: true, data: rows, total: Number(countRows[0]?.total ?? 0) });
        }

        return res.json({ success: true, data: rows });
      } catch (qErr) {
        // The error itself, and which resource — `logger.error("…:", qErr)`
        // dropped both (pino treats the second argument as interpolation), so
        // a failing catalog query left nothing but the words "Query failed".
        logger.error({ err: qErr, resource, orderBy, pagination, sqlMessage: qErr?.sqlMessage }, 'Query failed in base_resource');
        return res.json({
          success: false,
          error: qErr.message || String(qErr),
        });
      }
    }

    // For write operations
    if (["insert", "update", "delete"].includes(operation)) {
      // Resolve `resource` through the registry before touching SQL. It must be
      // a registered slug that opts in with `writable: true`; the table name
      // comes from the definition, never from the request. Tables owned by a
      // service (stock, BOM lines, the production tracker, ...) declare no
      // `writable`, so the generic path refuses them and the caller has to go
      // through the route that enforces the rules.
      const target = resolveWriteTarget(resource);
      if (!target.ok) {
        if (target.reason === "not_writable") {
          return res.status(403).json({
            success: false,
            error: `Resource '${resource}' is not writable through the generic API. Use its app's own route.`,
          });
        }
        if (target.reason === "no_table") {
          return res.status(500).json({
            success: false,
            error: `Resource '${resource}' is marked writable but declares no table.`,
          });
        }
        return res.status(400).json({
          success: false,
          error: `Unknown resource '${resource}'. Writes must name a registered resource, not a table.`,
        });
      }

      // Authored in resourceDef.json, so safe to interpolate — unlike the raw
      // `resource` string this used to splice straight into the statement.
      const table = target.table;
      const allowed = target.allowlist;

      let query;
      let params;

      // Company scoping applies to whatever table actually has a company_id
      // column. This used to be a hardcoded `globalTables` list, consulted by
      // the insert branch alone — so update and delete appended
      // `AND company_id = ?` to every table and hard-failed on the ones without
      // the column. The list had also drifted from the schema in both
      // directions: it missed `fab_nodes`, `fab_node_relationships` and the two
      // `fab_excel_import_*` tables, and it named `apps`, which does have a
      // company_id. Asking the schema cannot drift. `table` came from the
      // registry, so this is not the raw-table lookup the write path refuses.
      let tableColumns;
      try {
        tableColumns = await getTableColumns(table);
      } catch (err) {
        logger.error(
          { err, table, resource },
          "[base_resource] could not read columns for write",
        );
        return res.status(500).json({
          success: false,
          error: `Could not resolve the schema for '${resource}'.`,
        });
      }

      // Service/worker callers (WORKER_SERVICE_TOKEN) carry no company and are
      // deliberately unscoped so they can act across companies.
      const scopeCompanyId =
        tableColumns.has("company_id") && req.user && !req.user.is_service
          ? req.user.company_id || req.user.companyId || null
          : null;

      switch (operation) {
        case "insert":
          // Auto-inject company_id from the caller's JWT for new records
          const insertData = { ...data };

          if (scopeCompanyId) {
            insertData.company_id = scopeCompanyId;
          }

          // Special handling for users table - hash password before storing
          if (table === "users" && insertData.password) {
            logger.info("Hashing password for new user");
            insertData.password = await bcrypt.hash(insertData.password, 10);
          }

          // Filter insertData against the resourceDef.json write allowlist.
          // There is no schema-cache fallback any more: an unresolved resource
          // was refused above, so every write that gets here has a real allowlist.
          const filtered = Object.fromEntries(
            Object.entries(insertData).filter(([k]) => allowed.has(k))
          );
          if (Object.keys(filtered).length === 0) {
            return res.status(400).json({
              success: false,
              error: "No insertable fields provided",
            });
          }
          query = `INSERT INTO \`${table}\` SET ?`;
          params = [filtered];
          break;

        case "update":
          // Special handling for users table - hash password if being updated
          const updateData = { ...data };
          if (table === "users" && updateData.password) {
            logger.info("Hashing password for user update");
            updateData.password = await bcrypt.hash(updateData.password, 10);
          }

          // Filter updateData against the resourceDef.json write allowlist.
          // The old catch-all here re-ran the UPDATE with the *unfiltered*
          // payload whenever the allowlist lookup threw — an error path that
          // wrote more than the success path did.
          const filteredUpd = Object.fromEntries(
            Object.entries(updateData).filter(([k]) => allowed.has(k))
          );
          // `id` addresses the row, it is not a column to set. The allowlist
          // excludes it, so read it from the raw payload for the WHERE clause.
          const targetId = req.body?.id || req.body?.data?.id || updateData.id;
          if (!targetId) {
            return res
              .status(400)
              .json({ success: false, error: "Missing id for update" });
          }
          if (Object.keys(filteredUpd).length === 0) {
            // Nothing to update — return an error instead of producing invalid SQL
            return res.status(400).json({
              success: false,
              error: "No updatable fields provided",
            });
          }
          if (scopeCompanyId) {
            query = `UPDATE \`${table}\` SET ? WHERE id = ? AND company_id = ?`;
            params = [filteredUpd, targetId, scopeCompanyId];
          } else {
            query = `UPDATE \`${table}\` SET ? WHERE id = ?`;
            params = [filteredUpd, targetId];
          }
          break;

        case "delete":
          // Soft delete: set deleted_at timestamp instead of removing the row.
          if (!data || data.id === undefined || data.id === null) {
            return res
              .status(400)
              .json({ success: false, error: "Missing id for delete" });
          }
          if (scopeCompanyId) {
            query = `UPDATE \`${table}\` SET deleted_at = NOW() WHERE id = ? AND company_id = ? AND deleted_at IS NULL`;
            params = [data.id, scopeCompanyId];
          } else {
            query = `UPDATE \`${table}\` SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL`;
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
