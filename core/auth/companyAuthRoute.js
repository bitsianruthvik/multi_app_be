import express from "express";
import {
  companyLogin,
  companyVerify,
  companyLogout,
  selfRegister,
  forgotPassword,
  resetPassword,
} from "./companyAuthController.js";

const router = express.Router({ mergeParams: true });

router.post("/login", companyLogin);
router.get("/verify", companyVerify);
router.post("/logout", companyLogout);
router.post("/register", selfRegister);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

export default router;
