import express from "express";
import { protect } from "../middleware/authmiddleware.js";
import {
  getCompanies,
  getCompanyBySlug,
  getCompanyApps,
  getTeams,
  getCapabilities,
  getFeatures,
  getRoles,
} from "./publicController.js";

/**
 * /api/public — mounted before appContext, so req.company is never set here.
 *
 * NO COMPANY LEARNS OF ANOTHER (user, 2026-11-24: "No one should even know if other companies exist"). Only the
 * sign-in page's lookup stays open, and it answers the same for every address, real company or not. Everything else
 * needs a sign-in and answers with the signed-in person's own company only. Until that day /companies listed every
 * customer to anyone on the internet, and /teams and /roles every company's teams and roles.
 */
const router = express.Router();

// The sign-in page: the same answer for any address (no "company not found").
router.get("/companies/:companySlug", getCompanyBySlug);

// Signed in, own company only.
router.get("/companies", protect, getCompanies);
router.get("/companies/:companySlug/apps", protect, getCompanyApps);
router.get("/teams", protect, getTeams);
router.get("/roles", protect, getRoles);
// The platform's feature catalogue (no company in it): signed in only.
router.get("/capabilities", protect, getCapabilities);
router.get("/features", protect, getFeatures);

export default router;
