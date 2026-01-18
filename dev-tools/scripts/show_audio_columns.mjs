import { pool } from "../../db.js";

async function main() {
  try {
    const [cols] = await pool.query("SHOW COLUMNS FROM `audio_recordings`");
    console.log(
      "columns:",
      cols.map((c) => c.Field)
    );
    process.exit(0);
  } catch (e) {
    console.error("error fetching columns:", e);
    process.exit(1);
  }
}

main();
