import express from "express";
import { protect } from "../middleware/authmiddleware.js";
import { handleDBQuery } from "./userController.js";
import {
  getProfile,
  updateProfile,
  changePassword,
  updatePreferences,
} from "./profileController.js";

const router = express.Router();

router.use(protect); // Only logged-in users

router.post("/query", handleDBQuery);

// Profile & settings endpoints
router.get("/me", getProfile);
router.put("/profile", updateProfile);
router.put("/change-password", changePassword);
router.put("/preferences", updatePreferences);

export default router;
