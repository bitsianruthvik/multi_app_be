import express from "express";
import { buildQuery } from "../utils/queryBuilder/queryBuilder.js";
import { pool } from "../db.js";
import { protect } from "../middleware/authmiddleware.js";
import bcrypt from "bcryptjs";

const router = express.Router();

// Validate required fields for each operation type
const validateRequest = (req, res, next) => {
  const { operation, resource } = req.body;
  console.log("Validating request:", { operation, resource });

  if (!operation) {
    return res.status(400).json({
      success: false,
      error: "Operation is required",
    });
  }
  if (!resource) {
    return res.status(400).json({
      success: false,
      error: "Resource is required",
    });
  }
  next();
};

// Allow public access to specific resources without JWT
const isPublicResource = (req) => {
  const { resource, operation } = req.body;
  console.log("Checking if public resource:", { resource, operation });
  // Allow public access to companies and apps for query operations
  return (
    (resource === "companies" || resource === "apps") && operation === "query"
  );
};

// Only verify token for non-public resources
router.use((req, res, next) => {
  if (isPublicResource(req)) {
    console.log("Allowing public access for:", req.body.resource);
    return next();
  }
  console.log("Requiring auth for:", req.body.resource);
  // Use the protect middleware for authentication
  protect(req, res, next);
});

// Add request validation
router.use(validateRequest);

// Single endpoint for all resource operations
router.post("/base_resource", async (req, res) => {
  try {
    console.log("Base resource request:", {
      body: req.body,
      headers: req.headers,
      url: req.url,
    });

    const { operation, resource, fields, filters, orderBy, pagination, data } =
      req.body;

    // For read operations
    if (operation === "query") {
      console.log("Building query for resource:", resource);
      console.log("JWT payload (req.user):", JSON.stringify(req.user, null, 2));
      const query = buildQuery({
        resource,
        fields,
        filters,
        orderBy,
        pagination,
        jwt: req.user, // Pass JWT for security injection
      });
      console.log("Generated SQL:", query);

      const [rows] = await pool.query(query);
      console.log("Query result:", {
        rowCount: rows.length,
        firstRow: rows[0],
      });

      return res.json({
        success: true,
        data: rows,
      });
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
            console.log("Hashing password for new user");
            insertData.password = await bcrypt.hash(insertData.password, 10);
          }

          query = `INSERT INTO ${resource} SET ?`;
          params = [insertData];
          break;

        case "update":
          // Ensure admin can only update records from their company
          const companyId = req.user?.company_id || req.user?.companyId;

          // Special handling for users table - hash password if being updated
          const updateData = { ...data };
          if (resource === "users" && updateData.password) {
            console.log("Hashing password for user update");
            updateData.password = await bcrypt.hash(updateData.password, 10);
          }

          if (companyId) {
            query = `UPDATE ${resource} SET ? WHERE id = ? AND company_id = ?`;
            params = [updateData, updateData.id, companyId];
          } else {
            query = `UPDATE ${resource} SET ? WHERE id = ?`;
            params = [updateData, updateData.id];
          }
          break;

        case "delete":
          // Ensure admin can only delete records from their company
          const deleteCompanyId = req.user?.company_id || req.user?.companyId;
          if (deleteCompanyId) {
            query = `DELETE FROM ${resource} WHERE id = ? AND company_id = ?`;
            params = [data.id, deleteCompanyId];
          } else {
            query = `DELETE FROM ${resource} WHERE id = ?`;
            params = [data.id];
          }
          break;
      }

      const [result] = await pool.query(query, params);

      return res.json({
        success: true,
        data: result,
      });
    }

    throw new Error("Invalid operation");
  } catch (error) {
    console.error("Base resource error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
