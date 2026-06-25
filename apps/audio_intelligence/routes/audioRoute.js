import express from "express";
import multer from "multer";
import path from "path";
import { protect } from "../../../core/middleware/authmiddleware.js";
import { uploadAudio, transcribe } from "../controllers/audioController.js";

const router = express.Router();
const upload = multer({ dest: path.join(process.cwd(), "tmp") });

router.post("/upload", protect, upload.single("audio_file"), uploadAudio);
router.post("/transcribe", protect, transcribe);

export default router;
