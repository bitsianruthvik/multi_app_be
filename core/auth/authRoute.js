import express from "express";
import {
  loginUser,
  verifyUser,
  logoutUser,
  registerUser,
  requestOtp,
  resetWithOtp,
} from "./authController.js";
const router = express.Router();
import { appContext } from "../middleware/appContext.js";

// Mount under /api/:company/:appSlug/auth/...
router.post("/login", appContext, loginUser);
router.get("/verify", appContext, verifyUser);
router.post("/logout", appContext, logoutUser);
router.post("/register", appContext, registerUser);
router.post("/forgot-password", appContext, requestOtp);
router.post("/reset-password", appContext, resetWithOtp);

export default router;
