import { pool } from "../../db.js";

async function main() {
  try {
    const id = Number(process.argv[2] || 0);
    if (!id) {
      console.error("id required");
      process.exit(1);
    }
    const [rows] = await pool.query(
      "SELECT id, audio_url, processed_url, transcription FROM audio_recordings WHERE id = ? LIMIT 1",
      [id]
    );
    console.log("row:", rows && rows[0] ? rows[0] : null);
    process.exit(0);
  } catch (e) {
    console.error("error fetching row:", e);
    process.exit(1);
  }
}

main();
