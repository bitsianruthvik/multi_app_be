import { pool } from "../../db.js";

async function main() {
  try {
    const title = process.argv[2] || "upload-1764060183345";
    const audioUrl =
      process.argv[3] ||
      "http://localhost:4000/uploads/original_1764060183345.mp3";
    const processedUrl =
      process.argv[4] ||
      "http://localhost:4000/uploads/processed_1764060183345.mp3";

    const recordedBy = process.argv[5] || "script-user";
    const recordedByRole = process.argv[6] || "service";
    const companyId = process.argv[7] ? Number(process.argv[7]) : 2;

    const [result] = await pool.query(
      "INSERT INTO audio_recordings (title, recorded_by, recorded_by_role, audio_url, processed_url, company_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())",
      [title, recordedBy, recordedByRole, audioUrl, processedUrl, companyId]
    );
    console.log("Inserted id:", result.insertId, "result:", result);
    process.exit(0);
  } catch (e) {
    console.error("Insert failed:", e);
    process.exit(1);
  }
}

main();
