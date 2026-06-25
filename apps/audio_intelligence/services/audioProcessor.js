import { spawn } from "child_process";
import { logger } from "../../../core/utils/logger.js";

// Async replacement for spawnSync — runs a child process and resolves with
// { status, stdout, stderr } instead of blocking the event loop.
export function runPipeline(cmd, args, { timeout = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, { env: process.env });
    if (child.stdout) child.stdout.on("data", (d) => { stdout += d; });
    if (child.stderr) child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Pipeline timed out after ${timeout}ms`));
    }, timeout);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
  });
}

// Helper: check and (if needed) create idempotency column and return existing row
export async function audioRecordingsHasIdempotency(conn, tableName, idempotencyKey) {
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
    logger.warn(
      "audioRecordingsHasIdempotency helper failed:",
      err && err.message
    );
    return null;
  }
}
