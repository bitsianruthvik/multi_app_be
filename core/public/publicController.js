import { pool } from "../../db.js";
import { logger } from "../utils/logger.js";

/** The signed-in person's company id (the token; /api/public has no company in its address). */
const ownCompany = (req) => Number(req.user?.companyId ?? req.user?.company_id) || null;
const fail = (res, what) => (err) => {
  logger.error({ err }, `public ${what} error`);
  res.status(500).json({ message: `Failed to load ${what}` });
};

// GET /api/public/companies/:companySlug — the sign-in page. It answers the same for every address, so it tells nobody
// whether a company is there (the name comes after sign-in, from the login answer).
export const getCompanyBySlug = (req, res) => {
  const slug = String(req.params.companySlug ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 64);
  res.json({ slug, name: null });
};

// GET /api/public/companies — the signed-in person's own company only.
export const getCompanies = async (req, res) => {
  const cid = ownCompany(req);
  if (!cid) return res.json([]);
  try {
    const [rows] = await pool.query("SELECT id, name, slug FROM companies WHERE id = ? AND deleted_at IS NULL", [cid]);
    res.json(rows);
  } catch (err) { fail(res, "companies")(err); }
};

// GET /api/public/companies/:companySlug/apps — the apps of the signed-in person's own company, and only when the
// address names it (any other answers like an empty company).
export const getCompanyApps = async (req, res) => {
  const cid = ownCompany(req);
  if (!cid || String(req.user?.company ?? "").toLowerCase() !== String(req.params.companySlug ?? "").toLowerCase()) return res.json([]);
  try {
    const [apps] = await pool.query(
      "SELECT id, name, slug, settings FROM apps WHERE company_id = ? AND is_public = 1 AND deleted_at IS NULL ORDER BY name ASC",
      [cid]
    );
    res.json(apps);
  } catch (err) { fail(res, "apps")(err); }
};

// GET /api/public/teams — own company only.
export const getTeams = async (req, res) => {
  const cid = ownCompany(req);
  if (!cid) return res.json([]);
  try {
    const [rows] = await pool.query("SELECT * FROM teams WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 500", [cid]);
    res.json(rows);
  } catch (err) { fail(res, "teams")(err); }
};

// GET /api/public/roles — own company only.
export const getRoles = async (req, res) => {
  const cid = ownCompany(req);
  if (!cid) return res.json([]);
  try {
    const [rows] = await pool.query("SELECT * FROM roles WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 500", [cid]);
    res.json(rows);
  } catch (err) { fail(res, "roles")(err); }
};

// GET /api/public/capabilities — the platform's capability ids (no company data).
export const getCapabilities = async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT DISTINCT capability_id AS id, capability_id AS name FROM features_capability");
    res.json(rows);
  } catch (err) { fail(res, "capabilities")(err); }
};

// GET /api/public/features — the platform's feature catalogue (no company data).
export const getFeatures = async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM features WHERE deleted_at IS NULL ORDER BY id LIMIT 1000");
    res.json(rows);
  } catch (err) { fail(res, "features")(err); }
};
