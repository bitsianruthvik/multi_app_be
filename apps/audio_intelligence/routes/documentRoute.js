import express from "express";
import multer from "multer";
import path from "path";
import { protect } from "../../../core/middleware/authmiddleware.js";
import { uploadDocument, updateMedicine } from "../controllers/documentController.js";

const router = express.Router();
const upload = multer({ dest: path.join(process.cwd(), "tmp") });

router.post("/upload", protect, upload.single("doc_file"), uploadDocument);
router.post("/update_medicine", protect, updateMedicine);

export default router;
