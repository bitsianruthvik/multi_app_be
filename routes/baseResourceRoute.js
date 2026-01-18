import express from "express";
import multer from "multer";
import { buildQuery } from "../utils/queryBuilder/queryBuilder.js";
import { pool } from "../db.js";
import { protect } from "../middleware/authmiddleware.js";
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";
import { transcribeFile } from "../utils/transcribe.js";
import { spawnSync, spawn } from "child_process";
import os from "os";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";

// Helper: run document-intelligence pipeline (visible spawn for debugging)
function runDocIntelligence(resource, id, filePath) {
  const py =
    process.env.PYTHON_PATH ||
    (process.platform === "win32" ? "python.exe" : "python3");

  const script = path.join(
    process.cwd(),
    "workers",
    "rag",
    "doc_intelligence.py"
  );

  console.log("[doc-intel] spawning:", py, script, resource, id, filePath);

  const child = spawn(py, [script, resource, String(id), filePath], {
    env: { ...process.env },
  });

  child.stdout.on("data", (d) =>
    console.log("[doc-intel stdout]", d.toString())
  );
  child.stderr.on("data", (d) =>
    console.error("[doc-intel stderr]", d.toString())
  );
  child.on("close", (code) => console.log("[doc-intel exit]", code));
}

// Router and multer temp upload config
const router = express.Router();
const uploadTmp = multer({ dest: path.join(process.cwd(), "tmp") });

// Helper: check and (if needed) create idempotency column and return existing row
async function audioRecordingsHasIdempotency(conn, tableName, idempotencyKey) {
  if (!conn || !idempotencyKey) return null;
  try {
    // Ensure column exists (MySQL supports IF NOT EXISTS in newer versions)
    try {
      await conn.query(
        `ALTER TABLE audio_recordings ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255) NULL`
      );
    } catch (e) {
      // ignore if not supported or fails; we'll continue
    }
    // Try to add unique index (best-effort)
    try {
      await conn.query(
        `ALTER TABLE audio_recordings ADD UNIQUE INDEX uq_audio_idempotency (idempotency_key)`
      );
    } catch (e) {
      // ignore failures (index may already exist)
    }

    // Query for existing row with this idempotency key
    const [rows] = await conn.query(
      `SELECT * FROM audio_recordings WHERE idempotency_key = ? LIMIT 1`,
      [idempotencyKey]
    );
    if (Array.isArray(rows) && rows.length > 0) return rows[0];
    return null;
  } catch (err) {
    console.warn(
      "audioRecordingsHasIdempotency helper failed:",
      err && err.message
    );
    return null;
  }
}

// Validate incoming base_resource-like requests and allow some public paths
const validateRequest = (req, res, next) => {
  try {
    const p = req.path || req.url || "";
    if (
      p &&
      (p.startsWith("/upload_audio") ||
        p.startsWith("/transcribe") ||
        p.startsWith("/upload_document") ||
        p.startsWith("/update_document_medicine") ||
        p.startsWith("/debug"))
    ) {
      return next();
    }
  } catch (e) {}

  const { operation, resource } = req.body || {};
  if (!operation) {
    return res
      .status(400)
      .json({ success: false, error: "Operation is required" });
  }
  if (!resource) {
    return res
      .status(400)
      .json({ success: false, error: "Resource is required" });
  }
  return next();
};

// Allow public access to specific resources without JWT
const isPublicResource = (req) => {
  const { resource, operation } = req.body || {};
  console.log("Checking if public resource:", { resource, operation });
  // Allow public access to companies and apps for query operations
  // Also allow public access to utility paths (transcribe/debug) which do
  // not follow the base_resource JSON contract.
  try {
    const p = req.path || req.url || "";
    if (p && (p.startsWith("/transcribe") || p.startsWith("/debug")))
      return true;
  } catch (e) {}
  return (
    (resource === "companies" || resource === "apps") && operation === "query"
  );
};

// Only verify token for non-public resources
router.use((req, res, next) => {
  // Allow a dedicated worker/service token to bypass normal company scoping.
  try {
    const authHeader =
      req.headers && (req.headers.authorization || req.headers.Authorization);
    if (authHeader && String(authHeader).startsWith("Bearer ")) {
      const token = String(authHeader).split(" ")[1];
      if (
        process.env.WORKER_SERVICE_TOKEN &&
        token === process.env.WORKER_SERVICE_TOKEN
      ) {
        // mark request as service user so later logic can skip company scoping
        req.user = { is_service: true, role: "service" };
        return next();
      }
    }
  } catch (e) {
    // fallback to normal auth flow
  }

  if (isPublicResource(req)) {
    console.log("Allowing public access for:", req.body && req.body.resource);
    return next();
  }
  console.log("Requiring auth for:", req.body && req.body.resource);
  // Use the protect middleware for authentication
  protect(req, res, next);
});

// Add request validation
router.use(validateRequest);

// Single endpoint for all resource operations
// Multipart upload endpoint for audio files. This accepts a file field `audio_file`
// and optional form fields `title`, `status`, and `idempotencyKey`.
router.post(
  "/upload_audio",
  uploadTmp.single("audio_file"),
  async (req, res) => {
    try {
      console.log("Upload audio multipart request:", {
        headers: req.headers,
        body: req.body,
        file: req.file && {
          originalname: req.file.originalname,
          size: req.file.size,
        },
      });

      // Require auth for uploads
      try {
        // If protect is a middleware that accepts (req,res,next) we call it to ensure req.user is present
        await new Promise((resolve, reject) => {
          protect(req, res, (err) => {
            // protect calls next() on success; if it handled response, reject
            if (res.headersSent) return reject(new Error("Auth failed"));
            resolve(true);
          });
        });
      } catch (authErr) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const file = req.file;
      if (!file)
        return res
          .status(400)
          .json({ success: false, error: "No audio_file uploaded" });
      const mime = file.mimetype || "audio/webm";
      let buffer;
      try {
        buffer = fs.readFileSync(file.path);
      } catch (e) {
        console.error("Failed to read uploaded audio file:", e);
        return res
          .status(500)
          .json({ success: false, error: "Failed to read uploaded file" });
      }
      const b64 = buffer.toString("base64");
      const dataUrl = `data:${mime};base64,${b64}`;
      const insertData = {
        title: req.body.title || "Recording",
        audio_data: dataUrl,
        status: req.body.status || "new",
      };

      // propagate idempotency key if provided in headers or form
      const idempotencyKey =
        req.headers["idempotency-key"] || req.body.idempotencyKey || null;

      // Attach company from JWT if present
      if (req.user && (req.user.company_id || req.user.companyId)) {
        insertData.company_id = req.user.company_id || req.user.companyId;
      }

      // Auto-fill recorded_by and recorded_by_role for uploaded audio
      try {
        if (!insertData.recorded_by && req.user) {
          insertData.recorded_by =
            req.user.name || req.user.email || String(req.user.id || "unknown");
        }
        if (!insertData.recorded_by_role && req.user) {
          insertData.recorded_by_role =
            req.user.role || req.user.roleName || "user";
        }
      } catch (e) {}

      // Reuse the audio processing logic from the base_resource insert branch.
      // This largely mirrors the original code path: create tmp dirs, run ffmpeg
      // processing, and then insert the DB row.
      try {
        const tmpDir = path.join(process.cwd(), "tmp");
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        const ts = Date.now();
        const reqTmpDir = path.join(tmpDir, String(ts));
        if (!fs.existsSync(reqTmpDir))
          fs.mkdirSync(reqTmpDir, { recursive: true });
        const ext = mime.includes("webm")
          ? "webm"
          : mime.includes("wav")
          ? "wav"
          : "bin";
        const inputPath = path.join(reqTmpDir, `upload_${ts}.${ext}`);
        fs.writeFileSync(inputPath, buffer);

        // ensure public uploads folder
        const publicUploads = path.join(process.cwd(), "public", "uploads");
        try {
          if (fs.existsSync(publicUploads)) {
            const stat = fs.statSync(publicUploads);
            if (!stat.isDirectory()) {
              // If it's a file (not a directory), remove and create the directory
              fs.unlinkSync(publicUploads);
              fs.mkdirSync(publicUploads, { recursive: true });
            }
          } else {
            fs.mkdirSync(publicUploads, { recursive: true });
          }
        } catch (e) {
          console.error("Failed to ensure public/uploads:", e);
        }

        // helper to run ffmpeg and return a promise
        const runFfmpeg = (cmdBuilder) =>
          new Promise((resolve, reject) => {
            cmdBuilder
              .on("end", () => resolve(true))
              .on("error", (err) => reject(err));
          });

        // Prepare filenames and temp paths for original/processed MP3 files
        const originalMp3Name = `original_${ts}.mp3`;
        const processedMp3Name = `processed_${ts}.mp3`;
        const originalMp3Tmp = path.join(reqTmpDir, originalMp3Name);
        const processedMp3Tmp = path.join(reqTmpDir, processedMp3Name);

        // 1) create original MP3 from whatever input was uploaded
        try {
          await runFfmpeg(
            ffmpeg(inputPath)
              .audioCodec("libmp3lame")
              .audioBitrate("128k")
              .format("mp3")
              .save(originalMp3Tmp)
          );
        } catch (e) {
          console.error("Failed to create original MP3 (ffmpeg):", e);
          throw e;
        }

        // 2) Run Python pipeline to produce processed WAV
        const py = path.join(process.cwd(), "scripts", "audio_pipeline.py");
        const pyCmd = process.env.PYTHON_PATH || "python";
        const processedWavTmp = path.join(reqTmpDir, `processed_${ts}.wav`);

        try {
          const pyArgs = [
            py,
            "--input",
            inputPath,
            "--output",
            processedWavTmp,
          ];
          if (process.env.DOWNLOAD_RNNOISE === "true")
            pyArgs.push("--download-rnnoise");
          console.log("Running audio pipeline:", pyCmd, pyArgs.join(" "));
          const sp = spawnSync(pyCmd, pyArgs, {
            encoding: "utf8",
            maxBuffer: 20 * 1024 * 1024,
            timeout: 10 * 60 * 1000,
          });
          // Always log stdout/stderr so failures are visible
          if (sp.stdout) console.log("audio_pipeline stdout:", sp.stdout);
          if (sp.stderr) console.warn("audio_pipeline stderr:", sp.stderr);
          if (sp.error) {
            console.error("Audio pipeline failed to start:", sp.error);
            throw sp.error;
          }
          if (sp.status !== 0) {
            console.error(
              "Audio pipeline exited with non-zero status:",
              sp.status
            );
            // If processed WAV was not created, include stdout/stderr in error
            if (!fs.existsSync(processedWavTmp)) {
              throw new Error(
                `audio_pipeline failed to produce processed wav. status=${sp.status} stdout=${sp.stdout} stderr=${sp.stderr}`
              );
            }
          }
          // Ensure processed WAV exists
          if (!fs.existsSync(processedWavTmp)) {
            throw new Error(
              `Processed WAV missing after audio_pipeline: ${processedWavTmp} stdout=${sp.stdout} stderr=${sp.stderr}`
            );
          }
          console.log(
            "Audio pipeline completed, processed WAV at:",
            processedWavTmp
          );
        } catch (pyErr) {
          console.error("Error while running audio_pipeline.py:", pyErr);
          throw pyErr;
        }

        // 3) Convert processed WAV to MP3 for storage/playback (if present)

        try {
          if (!fs.existsSync(processedWavTmp)) {
            throw new Error(`Processed WAV does not exist: ${processedWavTmp}`);
          }
          await runFfmpeg(
            ffmpeg(processedWavTmp)
              .audioCodec("libmp3lame")
              .audioBitrate("128k")
              .format("mp3")
              .save(processedMp3Tmp)
          );
        } catch (convErr) {
          console.error("Failed to convert processed WAV to MP3:", convErr);
          throw convErr;
        }

        const finalOriginal = path.join(publicUploads, originalMp3Name);
        const finalProcessed = path.join(publicUploads, processedMp3Name);
        try {
          if (fs.existsSync(originalMp3Tmp))
            fs.copyFileSync(originalMp3Tmp, finalOriginal);
          if (fs.existsSync(processedMp3Tmp))
            fs.copyFileSync(processedMp3Tmp, finalProcessed);
        } catch (copyErr) {
          console.warn(
            "Failed to copy processed audio to public/uploads:",
            copyErr
          );
        }

        const envBase = process.env.BACKEND_URL || process.env.BASE_URL || null;
        let baseUrl = envBase;
        if (!baseUrl) {
          try {
            if (req && typeof req.get === "function") {
              const forwardedProto =
                req.get("x-forwarded-proto") || req.protocol;
              const forwardedHost =
                req.get("x-forwarded-host") || req.get("host");
              baseUrl = `${forwardedProto}://${forwardedHost}`;
            } else {
              const port = process.env.PORT || 4000;
              baseUrl = `http://localhost:${port}`;
            }
          } catch (e) {
            const port = process.env.PORT || 4000;
            baseUrl = `http://localhost:${port}`;
          }
        }

        insertData.audio_url = `${baseUrl}/uploads/${originalMp3Name}`;
        insertData.processed_url = `${baseUrl}/uploads/${processedMp3Name}`;

        if (process.env.ENABLE_TRANSCRIPTION === "true") {
          try {
            const transcription = await transcribeFile(finalProcessed);
            insertData.new_tran = transcription;
          } catch (tErr) {
            console.warn("Transcription failed:", tErr && tErr.message);
          }
        }

        try {
          if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        } catch (e) {}
      } catch (procErr) {
        console.error("Audio processing failed in upload route:", procErr);
      }

      // Attempt DB insert, respecting idempotency if requested
      try {
        if (idempotencyKey) {
          const [existingRows] = await pool.query(
            "SELECT * FROM audio_recordings WHERE idempotency_key = ? LIMIT 1",
            [idempotencyKey]
          );
          if (Array.isArray(existingRows) && existingRows.length > 0) {
            return res.json({ success: true, data: [existingRows[0]] });
          }
          insertData.idempotency_key = idempotencyKey;
        }

        // Insert filtered columns only
        try {
          const [cols] = await pool.query(
            `SHOW COLUMNS FROM \`audio_recordings\``
          );
          const allowed = new Set((cols || []).map((c) => c.Field));
          const filtered = Object.fromEntries(
            Object.entries(insertData).filter(([k]) => allowed.has(k))
          );
          const [result] = await pool.query(
            "INSERT INTO audio_recordings SET ?",
            [filtered]
          );
          // Fetch the inserted row so we can return the exact fields the frontend expects
          try {
            const [rows] = await pool.query(
              "SELECT * FROM audio_recordings WHERE id = ? LIMIT 1",
              [result.insertId]
            );
            const row = Array.isArray(rows) && rows.length ? rows[0] : null;
            const origUrl = row
              ? row.audio_url || row.audio_url_path || row.audio_data || null
              : null;
            const procUrl = row ? row.processed_url || null : null;
            const transcript = row
              ? row.transcription || row.transcript || row.new_tran || null
              : null;

            // Spawn transcription worker (detached) if not running inline
            try {
              const script = path.join(
                process.cwd(),
                "workers",
                "transcription_worker.cjs"
              );
              const child = spawn(
                "node",
                [script, "--audio-id", String(result.insertId)],
                {
                  detached: true,
                  stdio: ["ignore", "pipe", "pipe"],
                  env: { ...process.env },
                }
              );
              // Pipe child stdout/stderr to server logs for observability
              if (child.stdout) {
                child.stdout.on("data", (d) =>
                  console.log(
                    `[transcription-worker:${result.insertId}] stdout: ${String(
                      d
                    ).trim()}`
                  )
                );
              }
              if (child.stderr) {
                child.stderr.on("data", (d) =>
                  console.error(
                    `[transcription-worker:${result.insertId}] stderr: ${String(
                      d
                    ).trim()}`
                  )
                );
              }
              child.on("error", (e) =>
                console.error(
                  `[transcription-worker:${result.insertId}] spawn error:`,
                  e
                )
              );
              child.unref();
            } catch (spawnErr) {
              console.warn("Failed to spawn transcription worker:", spawnErr);
            }

            return res.json({
              success: true,
              id: result.insertId,
              originalAudioUrl: origUrl,
              processedAudioUrl: procUrl,
              transcript: transcript,
            });
          } catch (fetchErr) {
            // Fall back to returning insert result if fetching the row failed
            console.warn("Inserted audio but failed to fetch row:", fetchErr);
            return res.json({
              success: true,
              id: result.insertId,
              originalAudioUrl: null,
              processedAudioUrl: null,
              transcript: null,
            });
          }
        } catch (insErr) {
          console.error("DB insert failed in upload route:", insErr);
          return res
            .status(500)
            .json({ success: false, error: insErr.message || String(insErr) });
        }
      } catch (dbErr) {
        console.error("Upload audio DB error:", dbErr);
        return res
          .status(500)
          .json({ success: false, error: dbErr.message || String(dbErr) });
      }
    } catch (error) {
      console.error("Upload audio error:", error);
      return res
        .status(500)
        .json({ success: false, error: error.message || String(error) });
    }
  }
);

// Multipart upload endpoint for generic documents (company/team)
// Accepts a file field `doc_file` and form fields:
// - `resource`: either `company_documents` or `team_documents`
// - optional `team_id` when resource is `team_documents` (fallback to req.user.team_id)
// - optional `id` to replace/update an existing document record
router.post(
  "/upload_document",
  uploadTmp.single("doc_file"),
  async (req, res) => {
    try {
      // Require auth
      try {
        await new Promise((resolve, reject) => {
          protect(req, res, (err) => {
            if (res.headersSent) return reject(new Error("Auth failed"));
            resolve(true);
          });
        });
      } catch (authErr) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

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
        console.log("/upload_document incoming:", {
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
        console.warn("Failed to log upload metadata:", e && e.message);
      }

      // Ensure uploads/docs folder exists
      const docsDir = path.join(process.cwd(), "public", "uploads", "docs");
      try {
        if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
      } catch (e) {
        console.warn("Failed to ensure uploads/docs directory:", e);
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
          console.error("Failed to move uploaded file:", copyErr);
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
            console.error("upload_document error: invalid team_id provided", {
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
        console.warn("Failed to parse team_id:", e && e.message);
      }

      // Validate required context for each resource to avoid DB NOT NULL errors
      if (resource === "company_documents" && !companyId) {
        console.error(
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
        console.error(
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
          runDocIntelligence(resource, existingId, finalPath);
          const [rows] = await pool.query(
            `SELECT * FROM ${resource} WHERE id = ? LIMIT 1`,
            [existingId]
          );
          return res.json({
            success: true,
            data: Array.isArray(rows) && rows.length ? rows[0] : null,
          });
        } catch (e) {
          console.error("Failed to update document record:", e);
          return res
            .status(500)
            .json({ success: false, error: e.message || String(e) });
        }
      }

      // Insert new record
      try {
        if (resource === "company_documents") {
          const [r] = await pool.query(
            "INSERT INTO company_documents (uploader_id, company_id, doc_path, medicines) VALUES (?, ?, ?, ?)",
            [uploaderId, companyId, docPath, medicine]
          );
          runDocIntelligence("company_documents", r.insertId, finalPath);
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
          runDocIntelligence("team_documents", r.insertId, finalPath);
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
        console.error("Failed to insert document record:", e);
        return res
          .status(500)
          .json({ success: false, error: e.message || String(e) });
      }
    } catch (error) {
      console.error("upload_document error:", error);
      return res
        .status(500)
        .json({ success: false, error: error.message || String(error) });
    }
  }
);

// Continue with the existing base_resource POST handler
router.post("/base_resource", async (req, res) => {
  try {
    console.log("Base resource request:", {
      body: req.body,
      headers: req.headers,
      url: req.url,
    });

    const { operation, resource, fields, filters, orderBy, pagination, data } =
      req.body || {};

    // For read operations (query)
    if (operation === "query") {
      try {
        console.log("Building query for resource:", resource);
        const query = await buildQuery({
          resource,
          fields,
          filters,
          orderBy,
          pagination,
          jwt: req.user,
        });
        console.log("Generated SQL:", query);
        const [rows] = await pool.query(query);
        return res.json({ success: true, data: rows });
      } catch (qErr) {
        console.error("Query failed in base_resource:", qErr);
        return res.json({
          success: false,
          error: qErr.message || String(qErr),
        });
      }
    }

    // For write operations
    if (["insert", "update", "delete"].includes(operation)) {
      let query;
      let params;

      // Define global tables that don't have company_id
      const globalTables = [
        "features",
        "features_capability",
        "companies",
        "apps",
      ];

      switch (operation) {
        case "insert":
          // Auto-inject company_id from admin's JWT for new records (except global tables)
          const insertData = { ...data };
          // Read idempotency key from headers or body (client sends Idempotency-Key header)
          const idempotencyKey =
            (req.headers &&
              (req.headers["idempotency-key"] ||
                req.headers["Idempotency-Key"])) ||
            req.body?.idempotencyKey ||
            null;

          // If idempotencyKey present and resource is audio_recordings, check existing row
          if (idempotencyKey && resource === "audio_recordings") {
            try {
              const existing = await audioRecordingsHasIdempotency(
                pool,
                "audio_recordings",
                idempotencyKey
              );
              if (existing) {
                // Return the existing record instead of re-processing
                return res.json({ status: "duplicate", record: existing });
              }
              // attach the key so it gets saved with the new row later
              insertData.idempotency_key = idempotencyKey;
            } catch (e) {
              console.warn("Idempotency check failed:", e && e.message);
            }
          }
          if (
            req.user &&
            (req.user.company_id || req.user.companyId) &&
            !globalTables.includes(resource)
          ) {
            insertData.company_id = req.user.company_id || req.user.companyId;
          }

          // Auto-fill recorded_by and recorded_by_role for audio_recordings
          if (resource === "audio_recordings") {
            try {
              if (!insertData.recorded_by && req.user) {
                insertData.recorded_by =
                  req.user.name ||
                  req.user.email ||
                  String(req.user.id || "unknown");
              }
              if (!insertData.recorded_by_role && req.user) {
                insertData.recorded_by_role =
                  req.user.role || req.user.roleName || "user";
              }
            } catch (e) {
              // ignore
            }
          }

          // Special handling for users table - hash password before storing
          if (resource === "users" && insertData.password) {
            console.log("Hashing password for new user");
            insertData.password = await bcrypt.hash(insertData.password, 10);
          }

          // Special handling for audio_recordings: accept base64 audio_data from client,
          // create original MP3 + processed MP3 files and replace audio_data/audio_url
          if (resource === "audio_recordings" && insertData.audio_data) {
            try {
              // prepare tmp dirs
              const tmpDir = path.join(process.cwd(), "tmp");
              if (!fs.existsSync(tmpDir))
                fs.mkdirSync(tmpDir, { recursive: true });

              // parse data URL: data:<mime>;base64,<data>
              const m = String(insertData.audio_data).match(
                /^data:(.+);base64,(.+)$/
              );
              const mime = m ? m[1] : "audio/webm";
              const b64 = m ? m[2] : null;
              const ext = mime.includes("webm")
                ? "webm"
                : mime.includes("wav")
                ? "wav"
                : "bin";
              const ts = Date.now();

              // create a per-request tmp folder so original/processed MP3s
              // are preserved for debugging/inspection. We will NOT delete
              // these preserved mp3 files automatically.
              const reqTmpDir = path.join(tmpDir, String(ts));
              if (!fs.existsSync(reqTmpDir))
                fs.mkdirSync(reqTmpDir, { recursive: true });

              const inputPath = path.join(reqTmpDir, `upload_${ts}.${ext}`);
              if (!b64) {
                // if client sent a plain base64 string without data: prefix
                // write as webm by default
                fs.writeFileSync(
                  inputPath,
                  Buffer.from(String(insertData.audio_data), "base64")
                );
              } else {
                fs.writeFileSync(inputPath, Buffer.from(b64, "base64"));
              }

              // ensure public uploads folder
              const publicUploads = path.join(
                process.cwd(),
                "public",
                "uploads"
              );
              // If path exists but is a file (not a directory) remove it and
              // create the proper uploads directory. This fixes cases where
              // an accidental empty file named `uploads` blocks directory ops.
              try {
                if (fs.existsSync(publicUploads)) {
                  const stat = fs.statSync(publicUploads);
                  if (!stat.isDirectory()) {
                    console.warn(
                      "public/uploads exists but is not a directory - replacing with directory"
                    );
                    fs.unlinkSync(publicUploads);
                    fs.mkdirSync(publicUploads, { recursive: true });
                  }
                } else {
                  fs.mkdirSync(publicUploads, { recursive: true });
                }
              } catch (e) {
                console.error("Failed to ensure public/uploads directory:", e);
                // rethrow so the outer try/catch handles it
                throw e;
              }

              const originalMp3Name = `original_${ts}.mp3`;
              const processedMp3Name = `processed_${ts}.mp3`;
              const originalMp3Tmp = path.join(reqTmpDir, originalMp3Name);
              const processedMp3Tmp = path.join(reqTmpDir, processedMp3Name);

              // helper to run ffmpeg and return a promise
              const runFfmpeg = (cmdBuilder) =>
                new Promise((resolve, reject) => {
                  cmdBuilder
                    .on("end", () => resolve(true))
                    .on("error", (err) => reject(err));
                });

              // 1) create original MP3 from input
              try {
                await runFfmpeg(
                  ffmpeg(inputPath)
                    .audioCodec("libmp3lame")
                    .audioBitrate("128k")
                    .format("mp3")
                    .save(originalMp3Tmp)
                );
              } catch (e) {
                console.warn("Failed to create original MP3 (ffmpeg):", e);
              }

              // 2) Run consolidated Python pipeline to create processed WAV
              const py = path.join(
                process.cwd(),
                "scripts",
                "audio_pipeline.py"
              );
              const pyCmd = process.env.PYTHON_PATH || "python";
              const processedWavTmp = path.join(
                reqTmpDir,
                `processed_${ts}.wav`
              );
              try {
                const pyArgs = [
                  py,
                  "--input",
                  inputPath,
                  "--output",
                  processedWavTmp,
                ];
                if (process.env.DOWNLOAD_RNNOISE === "true")
                  pyArgs.push("--download-rnnoise");
                const sp = spawnSync(pyCmd, pyArgs, {
                  encoding: "utf8",
                  maxBuffer: 10 * 1024 * 1024,
                  timeout: 10 * 60 * 1000,
                });
                if (sp.error) {
                  console.warn("Audio pipeline failed to start:", sp.error);
                } else if (sp.status !== 0) {
                  console.warn(
                    "Audio pipeline exited with non-zero status:",
                    sp.status,
                    sp.stderr || sp.stdout
                  );
                } else {
                  console.log("Audio pipeline output:", sp.stdout);
                }
              } catch (pyErr) {
                console.warn("Error while running audio_pipeline.py:", pyErr);
              }

              // 3) Convert processed WAV to MP3 for storage/playback (if available)
              try {
                if (fs.existsSync(processedWavTmp)) {
                  await runFfmpeg(
                    ffmpeg(processedWavTmp)
                      .audioCodec("libmp3lame")
                      .audioBitrate("128k")
                      .format("mp3")
                      .save(processedMp3Tmp)
                  );
                } else {
                  console.warn(
                    "Processed WAV not found, skipping MP3 conversion:",
                    processedWavTmp
                  );
                }
              } catch (convErr) {
                console.warn(
                  "Failed to convert processed WAV to MP3:",
                  convErr
                );
              }

              // move to public/uploads
              const finalOriginal = path.join(publicUploads, originalMp3Name);
              const finalProcessed = path.join(publicUploads, processedMp3Name);
              try {
                // Ensure public uploads exists (idempotent)
                fs.mkdirSync(publicUploads, { recursive: true });

                if (!fs.existsSync(originalMp3Tmp)) {
                  throw new Error(`Original MP3 missing: ${originalMp3Tmp}`);
                }
                if (!fs.existsSync(processedMp3Tmp)) {
                  throw new Error(`Processed MP3 missing: ${processedMp3Tmp}`);
                }

                fs.copyFileSync(originalMp3Tmp, finalOriginal);
                fs.copyFileSync(processedMp3Tmp, finalProcessed);
              } catch (copyErr) {
                console.error(
                  "Failed to copy processed audio to public/uploads:",
                  copyErr
                );
                throw copyErr;
              }

              // set URL paths that frontend can fetch (index.js exposes /uploads)
              // Use absolute URL (protocol + host) so frontend running on a
              // different origin can load the files directly from the backend.
              // Build a safe baseUrl. Prefer explicit BACKEND_URL env var.
              // Fall back to request headers only if req is present and usable.
              const envBase =
                process.env.BACKEND_URL || process.env.BASE_URL || null;
              let baseUrl = envBase;
              if (!baseUrl) {
                try {
                  if (req && typeof req.get === "function") {
                    const forwardedProto =
                      req.get("x-forwarded-proto") || req.protocol;
                    const forwardedHost =
                      req.get("x-forwarded-host") || req.get("host");
                    baseUrl = `${forwardedProto}://${forwardedHost}`;
                  } else {
                    // As a last resort, use localhost with the configured PORT
                    const port = process.env.PORT || 4000;
                    baseUrl = `http://localhost:${port}`;
                  }
                } catch (e) {
                  const port = process.env.PORT || 4000;
                  baseUrl = `http://localhost:${port}`;
                }
              }

              const origUrl = `${baseUrl}/uploads/${originalMp3Name}`;
              const procUrl = `${baseUrl}/uploads/${processedMp3Name}`;

              // Ensure final files exist and log their paths
              console.log("FINAL original:", finalOriginal);
              console.log("FINAL processed:", finalProcessed);
              console.log("Exists original:", fs.existsSync(finalOriginal));
              console.log("Exists processed:", fs.existsSync(finalProcessed));

              insertData.audio_url = origUrl;
              // store processed file location in dedicated column `processed_url`
              insertData.processed_url = procUrl;

              console.log("Saved audio URLs", {
                audio_url: insertData.audio_url,
                processed_url: insertData.processed_url,
              });

              // Transcription: optional step controlled by env var
              if (process.env.ENABLE_TRANSCRIPTION === "true") {
                try {
                  console.log(
                    "Transcribing processed audio...",
                    finalProcessed
                  );
                  // prefer the file on disk (finalProcessed) for transcription
                  const transcription = await transcribeFile(finalProcessed);
                  // store transcription in new_tran column so it will be saved
                  insertData.new_tran = transcription;
                  console.log(
                    "Transcription complete (chars):",
                    (transcription || "").length
                  );
                } catch (tErr) {
                  console.warn("Transcription failed:", tErr && tErr.message);
                }
              }

              console.log("Skipping speaker diarization – disabled.");

              // free only the original upload input file (we keep original
              // and processed mp3 files in the per-request tmp folder for
              // inspection). This avoids losing the files that you asked to
              // keep while still removing the raw upload.
              try {
                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
              } catch (e) {
                // ignore
              }
            } catch (err) {
              console.error("Audio processing failed:", err);
              // continue without blocking insert - keep original audio_data if present
            }
          }

          // Filter insertData to only include actual table columns to avoid
          // "Unknown column" MySQL errors if client sends extra fields.
          try {
            const [cols] = await pool.query(
              `SHOW COLUMNS FROM \`${resource}\``
            );
            const allowed = new Set((cols || []).map((c) => c.Field));
            const filtered = Object.fromEntries(
              Object.entries(insertData).filter(([k]) => allowed.has(k))
            );
            query = `INSERT INTO ${resource} SET ?`;
            params = [filtered];
          } catch (err) {
            // If SHOW COLUMNS fails (table missing, permissions), fall back to raw insert
            console.warn(
              "Failed to introspect table columns for",
              resource,
              err
            );
            query = `INSERT INTO ${resource} SET ?`;
            params = [insertData];
          }
          break;

        case "update":
          // Ensure admin can only update records from their company.
          // Service/workers (req.user.is_service) bypass this scoping so they
          // can update records across companies when authorized via the
          // WORKER_SERVICE_TOKEN.
          const companyId =
            req.user && !req.user.is_service
              ? req.user?.company_id || req.user?.companyId
              : null;

          // Special handling for users table - hash password if being updated
          const updateData = { ...data };
          if (resource === "users" && updateData.password) {
            console.log("Hashing password for user update");
            updateData.password = await bcrypt.hash(updateData.password, 10);
          }

          // Filter updateData to allowed columns to avoid Unknown column errors
          try {
            const [colsUpd] = await pool.query(
              `SHOW COLUMNS FROM \`${resource}\``
            );
            const allowedUpd = new Set((colsUpd || []).map((c) => c.Field));
            const filteredUpd = Object.fromEntries(
              Object.entries(updateData).filter(([k]) => allowedUpd.has(k))
            );
            // Ensure we don't attempt to run an UPDATE with an empty SET
            // Remove `id` from the SET payload and use it in the WHERE clause
            const targetId =
              req.body?.id ||
              req.body?.data?.id ||
              filteredUpd.id ||
              updateData.id;
            if (filteredUpd.hasOwnProperty("id")) delete filteredUpd.id;
            const keysToUpdate = Object.keys(filteredUpd || {});
            if (!targetId) {
              throw new Error("Missing id for update");
            }
            if (keysToUpdate.length === 0) {
              // Nothing to update — return an error instead of producing invalid SQL
              return res.status(400).json({
                success: false,
                error: "No updatable fields provided",
              });
            }
            if (companyId) {
              query = `UPDATE ${resource} SET ? WHERE id = ? AND company_id = ?`;
              params = [filteredUpd, targetId, companyId];
            } else {
              query = `UPDATE ${resource} SET ? WHERE id = ?`;
              params = [filteredUpd, targetId];
            }
          } catch (err) {
            console.warn(
              "Failed to introspect table columns for update",
              resource,
              err
            );
            if (companyId) {
              query = `UPDATE ${resource} SET ? WHERE id = ? AND company_id = ?`;
              params = [updateData, updateData.id, companyId];
            } else {
              query = `UPDATE ${resource} SET ? WHERE id = ?`;
              params = [updateData, updateData.id];
            }
          }
          break;

        case "delete":
          // Ensure admin can only delete records from their company
          // Service users bypass company scoping.
          const deleteCompanyId =
            req.user && !req.user.is_service
              ? req.user?.company_id || req.user?.companyId
              : null;
          if (deleteCompanyId) {
            query = `DELETE FROM ${resource} WHERE id = ? AND company_id = ?`;
            params = [data.id, deleteCompanyId];
          } else {
            query = `DELETE FROM ${resource} WHERE id = ?`;
            params = [data.id];
          }
          break;
      }

      let result;
      try {
        console.log("[base_resource] Executing SQL:", query, params);
        const qres = await pool.query(query, params);
        result = qres[0];
        console.log("[base_resource] SQL result:", result);
      } catch (err) {
        console.error(
          "[base_resource] SQL error:",
          err && err.message ? err.message : err
        );
        // Handle duplicate idempotency insert race: return existing row instead of error
        if (
          err &&
          (err.code === "ER_DUP_ENTRY" || err.errno === 1062) &&
          insertData &&
          insertData.idempotency_key
        ) {
          try {
            const [existingRows] = await pool.query(
              `SELECT * FROM audio_recordings WHERE idempotency_key = ? LIMIT 1`,
              [insertData.idempotency_key]
            );
            if (Array.isArray(existingRows) && existingRows.length > 0) {
              return res.json({ success: true, data: [existingRows[0]] });
            }
          } catch (e2) {
            console.warn(
              "Failed to recover from duplicate idempotency error:",
              e2
            );
          }
        }
        throw err;
      }

      // If we just inserted an audio_recordings row, kick off transcription
      try {
        if (resource === "audio_recordings" && result && result.insertId) {
          try {
            const script = path.join(
              process.cwd(),
              "workers",
              "transcription_worker.cjs"
            );
            const child = spawn(
              "node",
              [script, "--audio-id", String(result.insertId)],
              {
                detached: true,
                stdio: ["ignore", "pipe", "pipe"],
                env: { ...process.env },
              }
            );
            if (child.stdout) {
              child.stdout.on("data", (d) =>
                console.log(
                  `[transcription-worker:${result.insertId}] stdout: ${String(
                    d
                  ).trim()}`
                )
              );
            }
            if (child.stderr) {
              child.stderr.on("data", (d) =>
                console.error(
                  `[transcription-worker:${result.insertId}] stderr: ${String(
                    d
                  ).trim()}`
                )
              );
            }
            child.on("error", (e) =>
              console.error(
                `[transcription-worker:${result.insertId}] spawn error:`,
                e
              )
            );
            child.unref();
            console.log(
              `Spawned transcription worker for audio_id=${result.insertId}`
            );
          } catch (spawnErr) {
            console.warn("Failed to spawn transcription worker:", spawnErr);
          }
        }
      } catch (e) {
        console.warn(
          "Error while attempting to start transcription worker:",
          e
        );
      }

      // For audio_recordings inserts return normalized shape the frontend expects
      try {
        if (resource === "audio_recordings") {
          if (result && result.insertId) {
            const [rowsAfter] = await pool.query(
              "SELECT * FROM audio_recordings WHERE id = ? LIMIT 1",
              [result.insertId]
            );
            const rowAfter =
              Array.isArray(rowsAfter) && rowsAfter.length
                ? rowsAfter[0]
                : null;
            const origUrl = rowAfter
              ? rowAfter.audio_url ||
                rowAfter.audio_url_path ||
                rowAfter.audio_data ||
                null
              : null;
            const procUrl = rowAfter ? rowAfter.processed_url || null : null;
            const transcript = rowAfter
              ? rowAfter.transcription ||
                rowAfter.transcript ||
                rowAfter.new_tran ||
                null
              : null;
            return res.json({
              success: true,
              id: result.insertId,
              originalAudioUrl: origUrl,
              processedAudioUrl: procUrl,
              transcript: transcript,
            });
          }
        }
      } catch (fetchErr) {
        console.warn(
          "Inserted record but failed to fetch audio_recordings row:",
          fetchErr
        );
      }

      return res.json({
        success: true,
        data: result,
      });
    }

    throw new Error("Invalid operation");
  } catch (error) {
    console.error("Base resource error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;

// Debug helper: return audio_recordings row and check file existence for original/processed audio
// GET /debug/audio/:id
router.get("/debug/audio/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id)
      return res.status(400).json({ success: false, error: "invalid id" });
    const [rows] = await pool.query(
      "SELECT * FROM audio_recordings WHERE id = ? LIMIT 1",
      [id]
    );
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(404).json({ success: false, error: "not found" });
    const row = rows[0];

    const checkFile = (urlOrPath) => {
      if (!urlOrPath) return { exists: false };
      try {
        // If URL contains /uploads/, map to local public/uploads path
        const u = String(urlOrPath);
        const idx = u.indexOf("/uploads/");
        if (idx !== -1) {
          const rel = u.slice(idx + "/uploads/".length).replace(/^\/+/, "");
          const fp = path.join(process.cwd(), "public", "uploads", rel);
          if (fs.existsSync(fp)) {
            const st = fs.statSync(fp);
            return { exists: true, path: fp, size: st.size };
          }
          return { exists: false, path: fp };
        }
        // If looks like a local path
        if (fs.existsSync(u)) {
          const st = fs.statSync(u);
          return { exists: true, path: u, size: st.size };
        }
      } catch (e) {
        return { exists: false, error: String(e) };
      }
      return { exists: false };
    };

    const orig = checkFile(
      row.audio_url || row.audio_url_path || row.audio_data
    );
    const proc = checkFile(row.processed_url);

    res.json({
      success: true,
      record: row,
      files: { original: orig, processed: proc },
    });
  } catch (error) {
    console.error("Debug audio endpoint error:", error);
    res
      .status(500)
      .json({ success: false, error: error.message || String(error) });
  }
});

// Additional route: trigger transcription for a given audio_recordings.id
// Accessible at POST /api/query/v1/transcribe with JSON { audio_id: <number> }
router.post("/transcribe", async (req, res) => {
  try {
    // Accept either `audio_id` or `audioId` in the body. Resolve to a DB PK
    // when possible so callers that supply filename-like ids still work.
    let audioId = req.body && (req.body.audio_id || req.body.audioId);
    if (!audioId)
      return res
        .status(400)
        .json({ success: false, error: "audio_id is required" });

    // If caller provided an identifier that is not the DB primary key (for
    // example a timestamp-based filename id), try resolving it to the actual
    // `audio_recordings.id` before spawning the worker. This prevents the
    // worker from attempting to update a non-existent PK.
    try {
      let resolved = null;
      const maybeNum = Number(audioId);
      if (maybeNum && Number.isFinite(maybeNum)) {
        const [r] = await pool.query(
          "SELECT id FROM audio_recordings WHERE id = ? LIMIT 1",
          [maybeNum]
        );
        if (Array.isArray(r) && r.length > 0) resolved = r[0];
      }
      if (!resolved) {
        // Try to find a row where the provided identifier appears in the
        // processed_url or audio_url (covers filename-based ids embedded in URLs)
        const likePattern = `%${String(audioId)}%`;
        try {
          const [r2] = await pool.query(
            "SELECT id FROM audio_recordings WHERE processed_url LIKE ? OR audio_url LIKE ? LIMIT 1",
            [likePattern, likePattern]
          );
          if (Array.isArray(r2) && r2.length > 0) resolved = r2[0];
        } catch (e) {
          // ignore search failure and fall back to whatever was provided
          console.warn("audio id lookup by URL failed:", e && e.message);
        }
      }
      if (resolved && resolved.id) {
        console.log("Resolved provided audio identifier to DB id:", {
          provided: audioId,
          resolved: resolved.id,
        });
        audioId = resolved.id;
      }
    } catch (e) {
      console.warn("Failed to resolve audio id to DB id:", e && e.message);
    }
    // Queue transcription worker (detached Node worker). Do not run Python synchronously.
    let scriptResult = { started: false, queued: false, error: null };
    try {
      const script = path.join(
        process.cwd(),
        "workers",
        "transcription_worker.cjs"
      );
      const child = spawn("node", [script, "--audio-id", String(audioId)], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      if (child.stdout) {
        child.stdout.on("data", (d) =>
          console.log(
            `[transcription-worker:${audioId}] stdout: ${String(d).trim()}`
          )
        );
      }
      if (child.stderr) {
        child.stderr.on("data", (d) =>
          console.error(
            `[transcription-worker:${audioId}] stderr: ${String(d).trim()}`
          )
        );
      }
      child.on("error", (e) =>
        console.error(`[transcription-worker:${audioId}] spawn error:`, e)
      );
      child.unref();
      scriptResult.started = true;
      scriptResult.queued = true;
    } catch (runErr) {
      scriptResult.error = String(runErr);
      console.warn("Failed to queue transcription worker:", runErr);
    }

    // After running transcription, fetch audio_recordings row and any audio_transcription rows
    try {
      const [rows] = await pool.query(
        "SELECT * FROM audio_recordings WHERE id = ? LIMIT 1",
        [audioId]
      );
      const record = Array.isArray(rows) && rows.length ? rows[0] : null;

      // Attempt to read transcription rows, but tolerate missing table/schema.
      let trows = [];
      try {
        const tRes = await pool.query(
          "SELECT * FROM audio_transcription WHERE audio_id = ? ORDER BY id DESC",
          [audioId]
        );
        trows = Array.isArray(tRes) && Array.isArray(tRes[0]) ? tRes[0] : tRes;
      } catch (tErr) {
        console.warn(
          "audio_transcription query failed (table may be missing). Returning empty transcriptions list:",
          tErr && (tErr.message || tErr)
        );
        trows = [];
      }

      // Normalize URLs and pick transcript text (prefer transcription table, then audio_recordings fields)
      const originalAudioUrl =
        record &&
        (record.audio_url || record.audio_url_path || record.audio_data)
          ? record.audio_url || record.audio_url_path || record.audio_data
          : null;
      const processedAudioUrl = record ? record.processed_url || null : null;

      let transcriptText = null;
      if (Array.isArray(trows) && trows.length > 0) {
        const first = trows[0];
        transcriptText =
          first.text ||
          first.transcription ||
          first.transcript ||
          first.new_tran ||
          null;
      }
      if (!transcriptText && record) {
        transcriptText =
          record.new_tran || record.transcription || record.transcript || null;
      }

      // Log summary for debugging
      console.log("Transcribe result summary for audioId:", audioId, {
        originalAudioUrl,
        processedAudioUrl,
        transcriptTextPresent: !!transcriptText,
        scriptResultStatus: scriptResult.status,
      });

      return res.json({
        success: true,
        originalAudioUrl,
        processedAudioUrl,
        transcript: transcriptText,
        debug: {
          stdout: scriptResult.stdout || null,
          stderr: scriptResult.stderr || null,
          status: scriptResult.status,
        },
      });
    } catch (dbErr) {
      console.warn("Failed to fetch transcription results:", dbErr);
      return res.json({
        success: false,
        error: dbErr.message || String(dbErr),
        debug: {
          stdout: scriptResult.stdout || null,
          stderr: scriptResult.stderr || null,
          status: scriptResult.status,
        },
      });
    }
  } catch (error) {
    console.error("Transcribe endpoint error:", error);
    res.json({
      success: false,
      error: error.message || String(error),
      debug: { stdout: null, stderr: null, status: null },
    });
  }
});
// Update document medicine (for frontend UI to tag documents)
router.post("/update_document_medicine", async (req, res) => {
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
    console.error("update_document_medicine error:", error);
    return res
      .status(500)
      .json({ success: false, error: error.message || String(error) });
  }
});
// Note: debug/dev-only force-update endpoint moved to `dev-tools/force_update_route.js`
// to avoid shipping dev-only routes in production. If you need this endpoint
// for local debugging, require and mount the route in your dev-only server
// setup, e.g. `app.use('/api/dev', require('../dev-tools/force_update_route').default)`.
