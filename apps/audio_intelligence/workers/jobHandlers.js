// apps/audio_intelligence/workers/jobHandlers.js
// Bull job processors for the audio_intelligence app.
// Registered by registerAllJobHandlers() via the app manifest's jobHandlers export.

import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { logger } from "../../../core/utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn a child process and return a Promise that resolves when it exits 0,
 * or rejects with an error (including captured stderr) on non-zero exit.
 */
function spawnAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });

    let stdout = "";
    let stderr = "";

    if (child.stdout) child.stdout.on("data", (d) => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("error", (err) => reject(err));

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ code, stdout, stderr });
      } else {
        const err = new Error(
          `Process exited with code ${code}. stderr: ${stderr.trim() || "(empty)"}`
        );
        err.code = code;
        err.stderr = stderr;
        err.stdout = stdout;
        reject(err);
      }
    });
  });
}

/**
 * Run doc-intelligence Python pipeline and return a Promise that resolves on
 * child exit code 0, rejects otherwise.  This is intentionally a thin wrapper
 * around the existing logic in docIntelligence.js so that Bull can retry on
 * failure without changing the external interface.
 */
function runDocIntelligenceAsync(resource, id, filePath) {
  const py =
    process.env.PYTHON_PATH ||
    (process.platform === "win32" ? "python.exe" : "python3");

  const script = path.join(
    __dirname,
    "../../../workers/rag/doc_intelligence.py"
  );

  logger.info(
    "[doc-intel] spawning (managed):", py, script, resource, id, filePath
  );

  return spawnAsync(py, [script, resource, String(id), filePath], {
    env: { ...process.env },
  }).then(({ stdout, stderr }) => {
    if (stdout) logger.info("[doc-intel stdout]", stdout);
    if (stderr) logger.warn("[doc-intel stderr]", stderr);
  });
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

/**
 * Wire Bull processors onto the "audio_intelligence" queue.
 *
 * @param {{ getQueue: function }} param0
 */
export async function register({ getQueue }) {
  const queue = getQueue("audio_intelligence");
  if (!queue) {
    logger.warn(
      "[jobs] audio_intelligence: queue unavailable, skipping processor registration."
    );
    return;
  }

  // ---- Transcription processor ----
  queue.process("transcription", async (job) => {
    const { audioId } = job.data;
    if (!audioId) throw new Error("transcription job missing audioId in payload");

    const script = path.join(
      process.cwd(),
      "apps",
      "audio_intelligence",
      "workers",
      "transcriptionWorker.cjs"
    );

    logger.info(`[jobs] transcription job ${job.id}: spawning worker for audioId=${audioId}`);

    const { stdout, stderr } = await spawnAsync(
      "node",
      [script, "--audio-id", String(audioId)],
      { env: { ...process.env } }
    );

    if (stdout) {
      stdout.trim().split("\n").forEach((line) =>
        logger.info(`[transcription-worker:${audioId}] stdout: ${line}`)
      );
    }
    if (stderr) {
      stderr.trim().split("\n").forEach((line) =>
        logger.error(`[transcription-worker:${audioId}] stderr: ${line}`)
      );
    }
  });

  // ---- Doc-intelligence processor ----
  queue.process("docIntelligence", async (job) => {
    const { resource, id, filePath } = job.data;
    if (!resource || !id || !filePath) {
      throw new Error(
        "docIntelligence job missing required payload fields (resource, id, filePath)"
      );
    }

    logger.info(
      `[jobs] docIntelligence job ${job.id}: resource=${resource} id=${id} filePath=${filePath}`
    );

    await runDocIntelligenceAsync(resource, id, filePath);
  });

  logger.info(
    "[jobs] audio_intelligence processors registered: transcription, docIntelligence"
  );
}

export default { register };
