import { pool } from "../db.js";

async function listRecent() {
  try {
    // Inspect columns first so the script is resilient across schema differences
    const [cols] = await pool.query(`SHOW COLUMNS FROM audio_recordings`);
    const available = (cols || []).map((c) => c.Field);

    const wanted = [
      "id",
      "title",
      "recorded_by",
      "audio_url",
      "new_tran",
      "transcription",
      "created_at",
      "idempotency_key",
    ];

    const selectCols = wanted.filter((c) => available.includes(c));
    if (selectCols.length === 0) {
      console.log(
        "No known columns found on audio_recordings, available columns:",
        available
      );
      process.exit(0);
    }

    const q = `SELECT ${selectCols.join(
      ", "
    )} FROM audio_recordings ORDER BY created_at DESC LIMIT 50`;
    const [rows] = await pool.query(q);
    console.log(
      `Found ${rows.length} rows (showing columns: ${selectCols.join(", ")})`
    );
    for (const r of rows) {
      console.log(r);
    }
    process.exit(0);
  } catch (e) {
    console.error("Failed to query audio_recordings:", e.message || e);
    process.exit(1);
  }
}

listRecent();
