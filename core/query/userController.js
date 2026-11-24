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

    // The signed-in person only — never a company named in the request (it used to fall back to the body's `company`).
    const jwtPayload = req.user || null;

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
