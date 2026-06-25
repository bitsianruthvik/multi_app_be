import fs from "fs";
import { logger } from "../../../core/utils/logger.js";
import path from "path";
import { pool } from "../../../db.js";
import { protect } from "../../../core/middleware/authmiddleware.js";
import { runDocIntelligence } from "../services/docIntelligence.js";
import { enqueue } from "../../../core/jobs/dispatcher.js";

// Multipart upload endpoint for generic documents (company/team)
// Accepts a file field `doc_file` and form fields:
// - `resource`: either `company_documents` or `team_documents`
// - optional `team_id` when resource is `team_documents` (fallback to req.user.team_id)
// - optional `id` to replace/update an existing document record
export const uploadDocument = async (req, res) => {
  try {
    const file = req.file;
    const resource = (req.body && req.body.resource) || null;
    const medicine =
      req.body && typeof req.body.medicine === "string"
        ? req.body.medicine.trim()
        : null;
    const allowed = ["company_documents", "team_documents"];
    if (!file)
      return res
        .status(400)
        .json({ success: false, error: "No doc_file uploaded" });
    if (!resource || !allowed.includes(resource)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid resource" });
    }

    // Debug log incoming upload metadata for easier diagnosis
    try {
      logger.info("/upload_document incoming:", {
        file: file && {
          originalname: file.originalname,
          size: file.size,
          path: file.path,
        },
        body: req.body,
        headers: req.headers && {
          authorization: req.headers.authorization,
          host: req.headers.host,
        },
      });
    } catch (e) {
      logger.warn("Failed to log upload metadata:", e && e.message);
    }

    // Ensure uploads/docs folder exists
    const docsDir = path.join(process.cwd(), "public", "uploads", "docs");
    try {
      if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
    } catch (e) {
      logger.warn("Failed to ensure uploads/docs directory:", e);
    }

    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filename = `${Date.now()}_${safeName}`;
    const finalPath = path.join(docsDir, filename);

    try {
      fs.renameSync(file.path, finalPath);
    } catch (e) {
      // fallback to copy
      try {
        fs.copyFileSync(file.path, finalPath);
        fs.unlinkSync(file.path);
      } catch (copyErr) {
        logger.error("Failed to move uploaded file:", copyErr);
        return res
          .status(500)
          .json({ success: false, error: "Failed to save uploaded file" });
      }
    }

    // Build accessible URL for frontend
    const host =
      process.env.BACKEND_URL ||
      (req.get && req.get("host")
        ? `${req.protocol}://${req.get("host")}`
        : null);
    const docPath = host
      ? `${host}/uploads/docs/${filename}`
      : `/uploads/docs/${filename}`;

    // Insert or update record
    const uploaderId = (req.user && (req.user.id || req.user.userId)) || null;
    const companyId =
      (req.user && (req.user.company_id || req.user.companyId)) || null;
    // Normalize and validate incoming team_id (may come from multipart form as string)
    let teamId = null;
    try {
      const rawTeam = req.body && (req.body.team_id || req.body.teamId);
      if (
        rawTeam !== undefined &&
        rawTeam !== null &&
        String(rawTeam).trim() !== ""
      ) {
        const parsed = Number(String(rawTeam).trim());
        if (!Number.isInteger(parsed)) {
          logger.error("upload_document error: invalid team_id provided", {
            rawTeam,
          });
          return res
            .status(400)
            .json({ success: false, error: "Invalid team_id" });
        }
        teamId = parsed;
      } else if (req.user && (req.user.team_id || req.user.teamId)) {
        const parsedUserTeam = Number(req.user.team_id || req.user.teamId);
        if (Number.isInteger(parsedUserTeam)) teamId = parsedUserTeam;
      }
    } catch (e) {
      logger.warn("Failed to parse team_id:", e && e.message);
    }

    // Validate required context for each resource to avoid DB NOT NULL errors
    if (resource === "company_documents" && !companyId) {
      logger.error(
        "upload_document error: missing companyId for company_documents",
        {
          uploaderId,
          companyId,
          teamId,
        }
      );
      return res.status(400).json({
        success: false,
        error: "Missing company context for company_documents upload",
      });
    }
    if (resource === "team_documents" && !teamId) {
      logger.error(
        "upload_document error: missing teamId for team_documents",
        {
          uploaderId,
          companyId,
          teamId,
        }
      );
      return res.status(400).json({
        success: false,
        error: "Missing team_id for team_documents upload",
      });
    }

    // If `id` provided, perform update (replace file)
    const existingId = req.body && (req.body.id || null);
    if (existingId) {
      // Update doc_path and uploader/uploaded_at; scope by company
      try {
        if (companyId) {
          await pool.query(
            `UPDATE ${resource} SET doc_path = ?, uploader_id = ?, uploaded_at = NOW() WHERE id = ? AND company_id = ?`,
            [docPath, uploaderId, existingId, companyId]
          );
        } else {
          await pool.query(
            `UPDATE ${resource} SET doc_path = ?, uploader_id = ?, uploaded_at = NOW() WHERE id = ?`,
            [docPath, uploaderId, existingId]
          );
        }
        enqueue(
          "audio_intelligence",
          "docIntelligence",
          { resource, id: existingId, filePath: finalPath },
          {},
          () => runDocIntelligence(resource, existingId, finalPath)
        ).catch((e) =>
          logger.warn("Failed to enqueue docIntelligence job:", e && e.message)
        );
        const [rows] = await pool.query(
          `SELECT * FROM ${resource} WHERE id = ? LIMIT 1`,
          [existingId]
        );
        return res.json({
          success: true,
          data: Array.isArray(rows) && rows.length ? rows[0] : null,
        });
      } catch (e) {
        logger.error("Failed to update document record:", e);
        return res
          .status(500)
          .json({ success: false, error: e.message || String(e) });
      }
    }

    // Insert new record
    try {
      if (resource === "company_documents") {
        const [r] = await pool.query(
          "INSERT INTO company_documents (uploader_id, company_id, doc_path) VALUES (?, ?, ?)",
          [uploaderId, companyId, docPath]
        );
        enqueue(
          "audio_intelligence",
          "docIntelligence",
          { resource: "company_documents", id: r.insertId, filePath: finalPath },
          {},
          () => runDocIntelligence("company_documents", r.insertId, finalPath)
        ).catch((e) =>
          logger.warn("Failed to enqueue docIntelligence job:", e && e.message)
        );
        const [rows] = await pool.query(
          "SELECT * FROM company_documents WHERE id = ? LIMIT 1",
          [r.insertId]
        );
        return res.json({
          success: true,
          data: Array.isArray(rows) && rows.length ? rows[0] : null,
        });
      }
      if (resource === "team_documents") {
        const tId = teamId;
        const [r] = await pool.query(
          "INSERT INTO team_documents (uploader_id, company_id, team_id, doc_path, medicines) VALUES (?, ?, ?, ?, ?)",
          [uploaderId, companyId, tId, docPath, medicine]
        );
        enqueue(
          "audio_intelligence",
          "docIntelligence",
          { resource: "team_documents", id: r.insertId, filePath: finalPath },
          {},
          () => runDocIntelligence("team_documents", r.insertId, finalPath)
        ).catch((e) =>
          logger.warn("Failed to enqueue docIntelligence job:", e && e.message)
        );
        const [rows] = await pool.query(
          "SELECT * FROM team_documents WHERE id = ? LIMIT 1",
          [r.insertId]
        );
        return res.json({
          success: true,
          data: Array.isArray(rows) && rows.length ? rows[0] : null,
        });
      }
      return res
        .status(400)
        .json({ success: false, error: "Unsupported resource" });
    } catch (e) {
      logger.error("Failed to insert document record:", e);
      return res
        .status(500)
        .json({ success: false, error: e.message || String(e) });
    }
  } catch (error) {
    logger.error("upload_document error:", error);
    return res
      .status(500)
      .json({ success: false, error: error.message || String(error) });
  }
};

// Update document medicine (for frontend UI to tag documents)
export const updateMedicine = async (req, res) => {
  try {
    // Require auth
    await new Promise((resolve, reject) => {
      protect(req, res, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    const { document_id, medicine } = req.body || {};

    // Validate inputs
    if (!document_id || !Number.isInteger(document_id)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid document_id" });
    }
    if (!medicine || typeof medicine !== "string" || medicine.trim() === "") {
      return res
        .status(400)
        .json({ success: false, error: "Invalid medicine" });
    }

    const companyId = req.user && req.user.company_id;
    if (!companyId) {
      return res
        .status(403)
        .json({ success: false, error: "Missing company context" });
    }

    // Update team_documents
    const [result] = await pool.query(
      "UPDATE team_documents SET medicines = ?, updated_at = NOW() WHERE id = ? AND company_id = ?",
      [medicine.trim(), document_id, companyId]
    );

    if (!result || result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: "Document not found or not authorized",
      });
    }

    return res.json({ success: true });
  } catch (error) {
    logger.error("update_document_medicine error:", error);
    return res
      .status(500)
      .json({ success: false, error: error.message || String(error) });
  }
};
