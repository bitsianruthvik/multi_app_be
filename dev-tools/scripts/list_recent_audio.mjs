import { pool } from "../../db.js";

async function main() {
  try {
    const [rows] = await pool.query(
      "SELECT id, audio_url, processed_url, transcription, created_at FROM audio_recordings ORDER BY created_at DESC LIMIT 10"
    );
    console.log("recent audio rows:");
    rows.forEach((r) => console.log(r));
    process.exit(0);
  } catch (e) {
    console.error("error listing recent audio:", e);
    process.exit(1);
  }
}

main();
