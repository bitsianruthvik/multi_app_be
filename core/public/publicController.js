import { pool } from "../../db.js";
import { logger } from "../utils/logger.js";
import { buildQuery } from "../query/queryBuilder/queryBuilder.js";

const DEFAULT_LIMIT = 200;

export const getPublicData = (req, res) => {
  res.json({ message: "This is a public route accessible without login." });
};

// GET /api/public/companies
export const getCompanies = async (req, res) => {
  try {
    const { sql, params } = await buildQuery({
      resource: "companies",
      pagination: { limit: DEFAULT_LIMIT },
      jwt: null,
      includeDeleted: false,
    });
    const [rows] = await pool.query(sql, params);
    return res.json(rows);
  } catch (err) {
    logger.error("getCompanies error:", err);
    return res.status(500).json({ message: "Failed to load companies" });
  }
};

// GET /api/public/companies/:companySlug — single company by slug
export const getCompanyBySlug = async (req, res) => {
  const { companySlug } = req.params;
  try {
    const [rows] = await pool.query(
      "SELECT id, name, slug FROM companies WHERE slug = ? AND deleted_at IS NULL LIMIT 1",
      [companySlug]
    );
    if (!rows.length) return res.status(404).json({ message: "Company not found" });
    return res.json(rows[0]);
  } catch (err) {
    logger.error("getCompanyBySlug error:", err);
    return res.status(500).json({ message: "Failed to load company" });
  }
};

// GET /api/public/companies/:companySlug/apps — only public apps
export const getCompanyApps = async (req, res) => {
  const { companySlug } = req.params;
  try {
    const [companyRows] = await pool.query(
      "SELECT id FROM companies WHERE slug = ? AND deleted_at IS NULL LIMIT 1",
      [companySlug]
    );
    if (!companyRows || companyRows.length === 0) {
      return res.status(404).json({ message: "Company not found" });
    }
    const companyId = companyRows[0].id;
    const [apps] = await pool.query(
      "SELECT id, name, slug, settings FROM apps WHERE company_id = ? AND is_public = 1 AND deleted_at IS NULL ORDER BY name ASC",
      [companyId]
    );
    return res.json(apps);
  } catch (err) {
    logger.error("getCompanyApps error:", err);
    return res.status(500).json({ message: "Failed to load apps for company" });
  }
};

// GET /api/public/teams
export const getTeams = async (req, res) => {
  try {
    const { sql, params } = await buildQuery({
      resource: "teams",
      pagination: { limit: DEFAULT_LIMIT },
      jwt: null,
      includeDeleted: false,
    });
    const [rows] = await pool.query(sql, params);
    return res.json(rows);
  } catch (err) {
    logger.error("getTeams error:", err);
    return res.status(500).json({ message: "Failed to load teams" });
  }
};

// GET /api/public/roles
export const getRoles = async (req, res) => {
  try {
    const { sql, params } = await buildQuery({
      resource: "roles",
      pagination: { limit: DEFAULT_LIMIT },
      jwt: null,
      includeDeleted: false,
    });
    const [rows] = await pool.query(sql, params);
    return res.json(rows);
  } catch (err) {
    logger.error("getRoles error:", err);
    return res.status(500).json({ message: "Failed to load roles" });
  }
};

// GET /api/public/capabilities
export const getCapabilities = async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT DISTINCT capability_id AS id, capability_id AS name FROM features_capability"
    );
    return res.json(rows);
  } catch (err) {
    logger.error("getCapabilities error:", err);
    return res.status(500).json({ message: "Failed to load capabilities" });
  }
};

// GET /api/public/features
export const getFeatures = async (req, res) => {
  try {
    const { sql, params } = await buildQuery({
      resource: "features",
      pagination: { limit: DEFAULT_LIMIT },
      jwt: null,
      includeDeleted: false,
    });
    const [rows] = await pool.query(sql, params);
    return res.json(rows);
  } catch (err) {
    logger.error("getFeatures error:", err);
    return res.status(500).json({ message: "Failed to load features" });
  }
};
