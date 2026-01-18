import express from "express";
import {
  loginUser,
  verifyUser,
  logoutUser,
} from "../controller/authController.js";
const router = express.Router();
import { appContext } from "../middleware/appContext.js";

// Mount under /api/:company/:appSlug/auth/...
router.post("/login", appContext, loginUser);
router.get("/verify", appContext, verifyUser);
router.post("/logout", appContext, logoutUser);

export default router;
