import { pool } from "../../db.js";
import { logger } from "../utils/logger.js";
import { buildQuery } from "./queryBuilder/queryBuilder.js";

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
      include_deleted,
    } = req.body;

    // Build JWT-like security payload from logged-in user if available
    const jwtPayload = req.user || {
      company_id: company,
      team_ids: team ? [team] : [],
    };

    const { sql, params } = await buildQuery({
      resource,
      filters,
      orderBy,
      pagination,
      jwt: jwtPayload,
      includeDeleted: !!include_deleted,
    });

    // Run the query
    const [rows] = await pool.query(sql, params);

    res.json({ data: rows });
  } catch (err) {
    logger.error(err);
    res
      .status(500)
      .json({ message: "Error executing query", error: err.message });
  }
};
