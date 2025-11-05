import { pool } from "../db.js";
import { buildQuery } from "../utils/queryBuilder/queryBuilder.js";

// Execute a query built from the request body
export const handleDBQuery = async (req, res) => {
  try {
    const {
      id,
      email,
      role,
      team,
      company,
      resource,
      filters,
      orderBy,
      pagination,
    } = req.body;

    // Build JWT-like security payload from logged-in user if available
    const jwtPayload = req.user || {
      company_id: company,
      team_ids: team ? [team] : [],
    };

    const sql = await buildQuery({
      resource,
      filters,
      orderBy,
      pagination,
      jwt: jwtPayload,
    });

    // Run the query
    const [rows] = await pool.query(sql);

    res.json({ data: rows });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ message: "Error executing query", error: err.message });
  }
};
