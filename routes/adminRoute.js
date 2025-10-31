import express from "express";
import { registerAdmin } from "../controller/adminController.js";
import { appContext } from "../middleware/appContext.js";
import { pool } from "../db.js";

const router = express.Router();

// Debug endpoint to check database state (no auth required for debugging)
router.get("/debug/data", async (req, res) => {
  try {
    const [companies] = await pool.query(
      "SELECT id, name, slug FROM companies"
    );
    const [roles] = await pool.query("SELECT id, name, company_id FROM roles");
    const [teams] = await pool.query("SELECT id, name, company_id FROM teams");
    const [users] = await pool.query(
      "SELECT id, name, email, role_id, team_id, company_id FROM users"
    );

    res.json({
      companies,
      roles,
      teams,
      users,
      jwt_sample: req.user || null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin registration endpoint - This is an authentication operation, not a data query
// All other admin operations (add-user, add-feature, etc.) now go through /api/query/v1/base_resource
router.post("/register", appContext, registerAdmin);

export default router;
