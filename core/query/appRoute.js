import express from "express";
import { protect } from "../middleware/authmiddleware.js";
import { getAppQuery } from "./appController.js";

const router = express.Router();

// Signed in only (2026-11-24): it was public and told anyone which companies and apps exist.
router.get("/query", protect, getAppQuery);

export default router;
