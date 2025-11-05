import express from "express";
import { buildQuery } from "../utils/queryBuilder/queryBuilder.js";
import { pool } from "../db.js";
import { protect } from "../middleware/authmiddleware.js";
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";
import os from "os";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";

ffmpeg.setFfmpegPath(ffmpegPath);

const router = express.Router();

// Validate required fields for each operation type
const validateRequest = (req, res, next) => {
  const { operation, resource } = req.body;
  console.log("Validating request:", { operation, resource });

  if (!operation) {
    return res.status(400).json({
      success: false,
      error: "Operation is required",
    });
  }
  if (!resource) {
    return res.status(400).json({
      success: false,
      error: "Resource is required",
    });
  }
  next();
};

// Allow public access to specific resources without JWT
const isPublicResource = (req) => {
  const { resource, operation } = req.body;
  console.log("Checking if public resource:", { resource, operation });
  // Allow public access to companies and apps for query operations
  return (
    (resource === "companies" || resource === "apps") && operation === "query"
  );
};

// Only verify token for non-public resources
router.use((req, res, next) => {
  if (isPublicResource(req)) {
    console.log("Allowing public access for:", req.body.resource);
    return next();
  }
  console.log("Requiring auth for:", req.body.resource);
  // Use the protect middleware for authentication
  protect(req, res, next);
});

// Add request validation
router.use(validateRequest);

// Single endpoint for all resource operations
router.post("/base_resource", async (req, res) => {
  try {
    console.log("Base resource request:", {
      body: req.body,
      headers: req.headers,
      url: req.url,
    });

    const { operation, resource, fields, filters, orderBy, pagination, data } =
      req.body;

    // For read operations
    if (operation === "query") {
      console.log("Building query for resource:", resource);
      console.log("JWT payload (req.user):", JSON.stringify(req.user, null, 2));
      const query = await buildQuery({
        resource,
        fields,
        filters,
        orderBy,
        pagination,
        jwt: req.user, // Pass JWT for security injection
      });
      console.log("Generated SQL:", query);

      const [rows] = await pool.query(query);
      console.log("Query result:", {
        rowCount: rows.length,
        firstRow: rows[0],
      });

      return res.json({
        success: true,
        data: rows,
      });
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

          // If idempotencyKey present and a record already exists with that key, return it
          if (idempotencyKey && resource === "audio_recordings") {
            try {
              const [existingRows] = await pool.query(
                `SELECT * FROM audio_recordings WHERE idempotency_key = ? LIMIT 1`,
                [idempotencyKey]
              );
              if (Array.isArray(existingRows) && existingRows.length > 0) {
                // Return the existing record instead of re-processing
                return res.json({ success: true, data: [existingRows[0]] });
              }
              // attach the key so it gets saved with the new row later
              insertData.idempotency_key = idempotencyKey;
            } catch (e) {
              console.warn("Idempotency check failed:", e);
            }
          }
          if (
            req.user &&
            (req.user.company_id || req.user.companyId) &&
            !globalTables.includes(resource)
          ) {
            insertData.company_id = req.user.company_id || req.user.companyId;
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
              const inputPath = path.join(tmpDir, `upload_${ts}.${ext}`);
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
              if (!fs.existsSync(publicUploads))
                fs.mkdirSync(publicUploads, { recursive: true });

              const originalMp3Name = `original_${ts}.mp3`;
              const processedMp3Name = `processed_${ts}.mp3`;
              const originalMp3Tmp = path.join(tmpDir, originalMp3Name);
              const processedMp3Tmp = path.join(tmpDir, processedMp3Name);

              // helper to run ffmpeg and return a promise
              const runFfmpeg = (cmdBuilder) =>
                new Promise((resolve, reject) => {
                  cmdBuilder
                    .on("end", () => resolve(true))
                    .on("error", (err) => reject(err));
                });

              // 1) create original MP3 (convert whatever input is to mp3)
              await runFfmpeg(
                ffmpeg(inputPath)
                  .audioCodec("libmp3lame")
                  .audioBitrate("128k")
                  .format("mp3")
                  .save(originalMp3Tmp)
              );

              // 2) Audio processing pipeline (three ordered steps):
              // Step A - Convert audio to WAV, 16kHz, 16-bit PCM, mono
              const convertedTmp = path.join(tmpDir, `converted_${ts}.wav`);
              await runFfmpeg(
                ffmpeg(inputPath)
                  .audioChannels(1)
                  .audioFrequency(16000)
                  .audioCodec("pcm_s16le")
                  .format("wav")
                  .save(convertedTmp)
              );

              // Step B - Band-pass filter (300-3400 Hz) using requested params
              // User requested: bandpass=f=1700:width_type=h:width=3100
              const filteredTmp = path.join(tmpDir, `filtered_${ts}.wav`);
              const bandpassFilter = "bandpass=f=1700:width_type=h:width=3100";
              await runFfmpeg(
                ffmpeg(convertedTmp)
                  .audioChannels(1)
                  .audioFrequency(16000)
                  .audioFilters(bandpassFilter)
                  .audioCodec("pcm_s16le")
                  .format("wav")
                  .save(filteredTmp)
              );

              // Step C - Silence trimming: remove parts below -50dB longer than 0.5s
              // using: silenceremove=stop_periods=-1:stop_threshold=-50dB:stop_duration=0.5
              const cleanedTmp = path.join(tmpDir, `cleaned_${ts}.wav`);
              const silenceFilter =
                "silenceremove=stop_periods=-1:stop_threshold=-50dB:stop_duration=0.5";
              await runFfmpeg(
                ffmpeg(filteredTmp)
                  .audioChannels(1)
                  .audioFrequency(16000)
                  .audioFilters(silenceFilter)
                  .audioCodec("pcm_s16le")
                  .format("wav")
                  .save(cleanedTmp)
              );

              // Finally, encode the cleaned WAV to MP3 for storage/playback
              await runFfmpeg(
                ffmpeg(cleanedTmp)
                  .audioCodec("libmp3lame")
                  .audioBitrate("128k")
                  .format("mp3")
                  .save(processedMp3Tmp)
              );

              // clean up intermediate WAVs (converted, filtered, cleaned) after encoding
              try {
                if (fs.existsSync(convertedTmp)) fs.unlinkSync(convertedTmp);
                if (fs.existsSync(filteredTmp)) fs.unlinkSync(filteredTmp);
                if (fs.existsSync(cleanedTmp)) fs.unlinkSync(cleanedTmp);
              } catch (e) {
                // ignore cleanup errors
              }

              // move to public/uploads
              const finalOriginal = path.join(publicUploads, originalMp3Name);
              const finalProcessed = path.join(publicUploads, processedMp3Name);
              fs.copyFileSync(originalMp3Tmp, finalOriginal);
              fs.copyFileSync(processedMp3Tmp, finalProcessed);

              // set URL paths that frontend can fetch (index.js exposes /uploads)
              // Use absolute URL (protocol + host) so frontend running on a
              // different origin can load the files directly from the backend.
              const forwardedProto = req.get("x-forwarded-proto") || req.protocol;
              const forwardedHost = req.get("x-forwarded-host") || req.get("host");
              // Allow an explicit backend URL via env to avoid issues when the
              // request is proxied through a dev server (vite) which can rewrite
              // Host headers. Set BACKEND_URL in your .env to something like
              // `http://localhost:4000` when running locally.
              const envBase = process.env.BACKEND_URL || process.env.BASE_URL || null;
              const baseUrl = envBase || `${forwardedProto}://${forwardedHost}`;

              const origUrl = `${baseUrl}/uploads/${originalMp3Name}`;
              const procUrl = `${baseUrl}/uploads/${processedMp3Name}`;

              // Ensure files actually exist before saving URLs to DB; if they
              // don't, log a diagnostic to help debugging.
              if (!fs.existsSync(finalOriginal) || !fs.existsSync(finalProcessed)) {
                console.warn("Audio files missing after processing:", {
                  original: finalOriginal,
                  processed: finalProcessed,
                });
              }

              insertData.audio_url = origUrl;
              // store processed file location in dedicated column `processed_audio`
              insertData.processed_audio = procUrl;

              console.log("Saved audio URLs", { audio_url: insertData.audio_url, processed_audio: insertData.processed_audio });

              // free tmp files
              try {
                fs.unlinkSync(inputPath);
                fs.unlinkSync(originalMp3Tmp);
                fs.unlinkSync(processedMp3Tmp);
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
          // Ensure admin can only update records from their company
          const companyId = req.user?.company_id || req.user?.companyId;

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
            if (companyId) {
              query = `UPDATE ${resource} SET ? WHERE id = ? AND company_id = ?`;
              params = [
                filteredUpd,
                filteredUpd.id || updateData.id,
                companyId,
              ];
            } else {
              query = `UPDATE ${resource} SET ? WHERE id = ?`;
              params = [filteredUpd, filteredUpd.id || updateData.id];
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
          const deleteCompanyId = req.user?.company_id || req.user?.companyId;
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
        const qres = await pool.query(query, params);
        result = qres[0];
      } catch (err) {
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
