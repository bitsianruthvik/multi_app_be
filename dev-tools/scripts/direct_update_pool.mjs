import { pool } from "../../db.js";

async function main() {
  try {
    const id = Number(process.argv[2] || 109);
    const text = process.argv[3] || "direct-pool-update";
    const [res] = await pool.query(
      "UPDATE audio_recordings SET transcription = ? WHERE id = ?",
      [text, id]
    );
    console.log("pool update res:", res);
    process.exit(0);
  } catch (e) {
    console.error("pool update failed:", e);
    process.exit(1);
  }
}

main();
