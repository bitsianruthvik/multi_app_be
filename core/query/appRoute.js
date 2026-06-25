import express from "express";
import { getAppQuery } from "./appController.js";

const router = express.Router();

// Public route that returns app/company info. Keep it public so landing pages
// can fetch logo before login. If you want it protected, move to protected
// middleware or apply auth middleware here.
router.get("/query", getAppQuery);

export default router;
