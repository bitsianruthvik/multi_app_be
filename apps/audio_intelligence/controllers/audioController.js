import fs from "fs";
import { logger } from "../../../core/utils/logger.js";
import path from "path";
import { spawn } from "child_process";
import ffmpeg from "fluent-ffmpeg";
import { pool } from "../../../db.js";
import { getTableColumns } from "../../../core/query/queryBuilder/schemaCache.js";
import { transcribeFile } from "../services/transcribe.js";
import { runPipeline } from "../services/audioProcessor.js";
import { enqueue } from "../../../core/jobs/dispatcher.js";

// Multipart upload endpoint for audio files. This accepts a file field `audio_file`
// and optional form fields `title`, `status`, and `idempotencyKey`.
export const uploadAudio = async (req, res) => {
  try {
    logger.info("Upload audio multipart request:", {
      headers: req.headers,
      body: req.body,
      file: req.file && {
        originalname: req.file.originalname,
        size: req.file.size,
      },
    });

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
      logger.error("Failed to read uploaded audio file:", e);
      return res
        .status(500)
        .json({ success: false, error: "Failed to read uploaded file" });
    }
    const b64 = buffer.toString("base64");
    const dataUrl = `data:${mime};base64,${b64}`;
    const insertData = {
      title: req.body.title || "Recording",
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
        logger.error("Failed to ensure public/uploads:", e);
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
        logger.error("Failed to create original MP3 (ffmpeg):", e);
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
        logger.info("Running audio pipeline:", pyCmd, pyArgs.join(" "));
        const sp = await runPipeline(pyCmd, pyArgs);
        if (sp.stdout) logger.info("audio_pipeline stdout:", sp.stdout);
        if (sp.stderr) logger.warn("audio_pipeline stderr:", sp.stderr);
        if (sp.status !== 0) {
          logger.error("Audio pipeline exited with non-zero status:", sp.status);
          if (!fs.existsSync(processedWavTmp)) {
            throw new Error(
              `audio_pipeline failed to produce processed wav. status=${sp.status} stdout=${sp.stdout} stderr=${sp.stderr}`
            );
          }
        }
        if (!fs.existsSync(processedWavTmp)) {
          throw new Error(
            `Processed WAV missing after audio_pipeline: ${processedWavTmp} stdout=${sp.stdout} stderr=${sp.stderr}`
          );
        }
        logger.info("Audio pipeline completed, processed WAV at:", processedWavTmp);
      } catch (pyErr) {
        logger.error("Error while running audio_pipeline.py:", pyErr);
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
        logger.error("Failed to convert processed WAV to MP3:", convErr);
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
        logger.warn(
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
          logger.warn("Transcription failed:", tErr && tErr.message);
        }
      }

      try {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      } catch (e) {}
    } catch (procErr) {
      logger.error("Audio processing failed in upload route:", procErr);
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
        const allowed = await getTableColumns("audio_recordings");
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
            ? row.audio_url || row.audio_url_path || null
            : null;
          const procUrl = row ? row.processed_url || null : null;
          const transcript = row
            ? row.transcription || row.transcript || row.new_tran || null
            : null;

          // Dispatch transcription to the managed queue (falls back to inline spawn).
          try {
            const audioId = result.insertId;
            const script = path.join(
              process.cwd(),
              "apps",
              "audio_intelligence",
              "workers",
              "transcriptionWorker.cjs"
            );
            const inlineFallback = () => {
              const child = spawn(
                "node",
                [script, "--audio-id", String(audioId)],
                {
                  stdio: ["ignore", "pipe", "pipe"],
                  env: { ...process.env },
                }
              );
              if (child.stdout) {
                child.stdout.on("data", (d) =>
                  logger.info(
                    `[transcription-worker:${audioId}] stdout: ${String(d).trim()}`
                  )
                );
              }
              if (child.stderr) {
                child.stderr.on("data", (d) =>
                  logger.error(
                    `[transcription-worker:${audioId}] stderr: ${String(d).trim()}`
                  )
                );
              }
              child.on("error", (e) =>
                logger.error(`[transcription-worker:${audioId}] spawn error:`, e)
              );
              child.unref();
            };
            enqueue(
              "audio_intelligence",
              "transcription",
              { audioId },
              {},
              inlineFallback
            ).catch((e) =>
              logger.warn("Failed to enqueue transcription job:", e && e.message)
            );
          } catch (spawnErr) {
            logger.warn("Failed to dispatch transcription job:", spawnErr);
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
          logger.warn("Inserted audio but failed to fetch row:", fetchErr);
          return res.json({
            success: true,
            id: result.insertId,
            originalAudioUrl: null,
            processedAudioUrl: null,
            transcript: null,
          });
        }
      } catch (insErr) {
        logger.error("DB insert failed in upload route:", insErr);
        return res
          .status(500)
          .json({ success: false, error: insErr.message || String(insErr) });
      }
    } catch (dbErr) {
      logger.error("Upload audio DB error:", dbErr);
      return res
        .status(500)
        .json({ success: false, error: dbErr.message || String(dbErr) });
    }
  } catch (error) {
    logger.error("Upload audio error:", error);
    return res
      .status(500)
      .json({ success: false, error: error.message || String(error) });
  }
};

// Additional route: trigger transcription for a given audio_recordings.id
// Accessible at POST /api/query/v1/audio/transcribe with JSON { audio_id: <number> }
export const transcribe = async (req, res) => {
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
          logger.warn("audio id lookup by URL failed:", e && e.message);
        }
      }
      if (resolved && resolved.id) {
        logger.info("Resolved provided audio identifier to DB id:", {
          provided: audioId,
          resolved: resolved.id,
        });
        audioId = resolved.id;
      }
    } catch (e) {
      logger.warn("Failed to resolve audio id to DB id:", e && e.message);
    }
    // Dispatch transcription to the managed queue (falls back to inline spawn).
    let scriptResult = { started: false, queued: false, error: null };
    try {
      const script = path.join(
        process.cwd(),
        "apps",
        "audio_intelligence",
        "workers",
        "transcriptionWorker.cjs"
      );
      const inlineFallback = () => {
        const child = spawn("node", [script, "--audio-id", String(audioId)], {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env },
        });
        if (child.stdout) {
          child.stdout.on("data", (d) =>
            logger.info(
              `[transcription-worker:${audioId}] stdout: ${String(d).trim()}`
            )
          );
        }
        if (child.stderr) {
          child.stderr.on("data", (d) =>
            logger.error(
              `[transcription-worker:${audioId}] stderr: ${String(d).trim()}`
            )
          );
        }
        child.on("error", (e) =>
          logger.error(`[transcription-worker:${audioId}] spawn error:`, e)
        );
        child.unref();
      };
      enqueue(
        "audio_intelligence",
        "transcription",
        { audioId },
        {},
        inlineFallback
      ).catch((e) =>
        logger.warn("Failed to enqueue transcription job:", e && e.message)
      );
      scriptResult.started = true;
      scriptResult.queued = true;
    } catch (runErr) {
      scriptResult.error = String(runErr);
      logger.warn("Failed to dispatch transcription job:", runErr);
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
        logger.warn(
          "audio_transcription query failed (table may be missing). Returning empty transcriptions list:",
          tErr && (tErr.message || tErr)
        );
        trows = [];
      }

      // Normalize URLs and pick transcript text (prefer transcription table, then audio_recordings fields)
      const originalAudioUrl =
        record && (record.audio_url || record.audio_url_path)
          ? record.audio_url || record.audio_url_path
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
      logger.info("Transcribe result summary for audioId:", audioId, {
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
      logger.warn("Failed to fetch transcription results:", dbErr);
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
    logger.error("Transcribe endpoint error:", error);
    res.json({
      success: false,
      error: error.message || String(error),
      debug: { stdout: null, stderr: null, status: null },
    });
  }
};
