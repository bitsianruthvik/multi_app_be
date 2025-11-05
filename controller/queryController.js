import { pool } from "../db.js";
import { buildQuery } from "../utils/queryBuilder/queryBuilder.js";

export async function handleVersionedQuery(req, res) {
  const { version, resource } = req.params;
  const method = req.method;
  const { filters, orderBy, pagination } = req.query;

  // Validate API version
  if (version !== "v1") {
    return res.status(400).json({ message: "Invalid API version" });
  }

  // GET request handler for fetching data
  if (method === "GET") {
    try {
      // Build the SQL query using the query builder
      const query = await buildQuery({
        resource, // The resource to query (e.g., 'users', 'products')
        filters: filters ? JSON.parse(filters) : null, // WHERE conditions
        orderBy: orderBy ? JSON.parse(orderBy) : null, // ORDER BY clause
        pagination: pagination ? JSON.parse(pagination) : null, // LIMIT/OFFSET
        jwt: req.jwt, // Security context for row-level security
      });

      // Execute the query
      const [rows] = await pool.query(query);

      // Format response with pagination metadata
      return res.json({
        data: rows,
        meta: {
          nextCursor: pagination?.cursor || null,
          total: rows.length,
        },
      });
    } catch (error) {
      console.error("Query execution failed:", error);
      return res.status(500).json({
        message: "Database query failed",
        error: error.message,
      });
    }
  }

  // POST request handler for inserting data
  if (method === "POST") {
    const body = req.body;
    try {
      // Validate the resource exists
      const query = await buildQuery({
        resource,
        filters: null,
        orderBy: null,
        pagination: null,
        jwt: req.jwt,
      });

      // If query builds successfully, resource is valid
      const [result] = await pool.query(`INSERT INTO ${resource} SET ?`, [
        body,
      ]);

      return res.status(201).json({
        data: {
          created: true,
          id: result.insertId,
          payload: body,
        },
      });
    } catch (error) {
      console.error("Insert operation failed:", error);
      return res.status(500).json({
        message: "Database insert failed",
        error: error.message,
      });
    }
  }

  return res.status(405).json({ message: "Method not allowed" });
}
