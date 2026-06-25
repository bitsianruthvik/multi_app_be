import express from "express";
import { handleVersionedQuery } from "./queryController.js";
import { versionControl } from "../middleware/versionControl.js";

const router = express.Router();

/**
 * Dynamic Query API Routes with Version Control
 *
 * This module handles all versioned query endpoints with proper version control
 * and feature flag management. Each request is validated against version-specific
 * configurations and constraints.
 *
 * Supported Versions:
 * - v1: Current stable version
 *   Features: filtering, sorting, pagination, row-level security
 *
 * Route Pattern: /query/:version/:resource
 *
 * GET /:version/:resource
 * - Fetches data from the specified resource
 * - Version-specific features:
 *   - filters: JSON string of WHERE conditions (if supported)
 *   - orderBy: JSON string of sort criteria (if supported)
 *   - pagination: JSON string with cursor/limit (if supported)
 *
 * POST /:version/:resource
 * - Creates a new record in the specified resource
 * - Request body validated against version-specific schema
 * - Field mappings applied for backwards compatibility
 *
 * Version Control:
 * - Validates API version
 * - Enforces version-specific feature limits
 * - Handles deprecation notices
 * - Provides feature flag management
 *
 * Examples:
 * GET /query/v1/users?filters={"role":"admin"}&orderBy={"name":"asc"}
 * POST /query/v1/orders with {"userId": 1, "total": 99.99}
 *
 * Note: Use the X-Api-Version header to check version capabilities
 */

// Apply version control middleware to all routes
router.use(versionControl);

// Mount the versioned query handler
router.route("/query/:version/:resource").all(handleVersionedQuery);

export default router;
