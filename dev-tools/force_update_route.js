import express from "express";
import { pool } from "../db.js";

// Dev-only force update route. NOT mounted by default — intended for local
// debugging only. Protects access with WORKER_SERVICE_TOKEN.
const router = express.Router();

router.post("/debug/force_update", async (req, res) => {
  try {
    const authHeader =
      req.headers && (req.headers.authorization || req.headers.Authorization);
    const token =
      authHeader && String(authHeader).startsWith("Bearer ")
        ? String(authHeader).split(" ")[1]
        : null;
    if (
      !token ||
      !process.env.WORKER_SERVICE_TOKEN ||
      token !== process.env.WORKER_SERVICE_TOKEN
    ) {
      return res.status(403).json({ success: false, error: "forbidden" });
    }
    const id = Number(
      req.body && (req.body.id || req.body.audio_id || req.body.audioId)
    );
    const transcription =
      req.body &&
      (req.body.transcription || req.body.text || req.body.t || null);
    if (!id || typeof transcription !== "string") {
      return res
        .status(400)
        .json({ success: false, error: "id and transcription required" });
    }
    try {
      const [result] = await pool.query(
        "UPDATE audio_recordings SET transcription = ? WHERE id = ?",
        [transcription, id]
      );
      return res.json({ success: true, data: result });
    } catch (e) {
      console.error("force_update DB error:", e && e.message ? e.message : e);
      return res
        .status(500)
        .json({
          success: false,
          error: e && e.message ? e.message : String(e),
        });
    }
  } catch (err) {
    console.error("force_update error:", err);
    res
      .status(500)
      .json({
        success: false,
        error: err && err.message ? err.message : String(err),
      });
  }
});

export default router;
