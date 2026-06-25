import { pool } from "../../db.js";
import { logger } from "../utils/logger.js";

/**
 * GET /api/:appSlug/app/query
 * Return company/app info (settings, logo, name, slug, raw row)
 * Uses req.company if appContext middleware attached it, otherwise falls back
 * to querying the companies table by slug.
 */
export const getAppQuery = async (req, res) => {
  try {
    let company = req.company || null;
    let app = req.appCtx || null;

    // If middleware didn't load company/app, try to resolve from params
    const companySlug = req.params?.company || (company ? company.slug : null);
    const appSlug = req.params?.appSlug || (app ? app.slug : null);

    if (!company && companySlug) {
      const [rows] = await pool
        .promise()
        .query("SELECT * FROM companies WHERE slug = ? LIMIT 1", [companySlug]);
      if (!rows || rows.length === 0)
        return res.status(404).json({ message: "Company not found" });
      company = rows[0];
      try {
        if (company.settings && typeof company.settings === "string")
          company.settings = JSON.parse(company.settings);
      } catch (e) {}
    }

    if (!app && appSlug && company) {
      const [rows] = await pool
        .promise()
        .query("SELECT * FROM apps WHERE slug = ? AND company_id = ? LIMIT 1", [
          appSlug,
          company.id,
        ]);
      if (!rows || rows.length === 0)
        return res.status(404).json({ message: "App not found" });
      app = rows[0];
      try {
        if (app.settings && typeof app.settings === "string")
          app.settings = JSON.parse(app.settings);
      } catch (e) {}
    }

    const response = {
      appSlug: app ? app.slug : company ? company.slug : null,
      companyName: company ? company.name : null,
      settings: app?.settings || company?.settings || {},
      raw: app || company || null,
    };

    return res.json(response);
  } catch (err) {
    logger.error("getAppQuery error", err);
    return res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
};
