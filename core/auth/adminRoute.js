import express from "express";
import { registerAdmin } from "./adminController.js";
import { appContext } from "../middleware/appContext.js";
import { pool } from "../../db.js";
import { logger } from "../utils/logger.js";

const router = express.Router();

// Admin registration endpoint - This is an authentication operation, not a data query
// All other admin operations (add-user, add-feature, etc.) now go through /api/query/v1/base_resource
router.post("/register", appContext, registerAdmin);

// GET /api/:company/:app/admin/error-logs
// Returns recent error log entries. No persistent log storage is currently configured,
// so this returns an empty array. Extend this endpoint if a log table is added in future.
router.get("/error-logs", (req, res) => {
  try {
    res.json([]);
  } catch (err) {
    logger.error({ err }, "admin error-logs handler error");
    res.status(500).json({ message: "Failed to load error logs" });
  }
});

export default router;
