import { pool } from "../../db.js";

async function main() {
  try {
    const id = Number(process.argv[2]);
    if (!id) {
      console.error("id required");
      process.exit(1);
    }
    const audioUrl =
      process.argv[3] || `http://localhost:4000/uploads/original_${id}.mp3`;
    const processedUrl =
      process.argv[4] || `http://localhost:4000/uploads/processed_${id}.mp3`;
    // check existing
    const [rows] = await pool.query(
      "SELECT id FROM audio_recordings WHERE id = ? LIMIT 1",
      [id]
    );
    if (Array.isArray(rows) && rows.length > 0) {
      console.log("row already exists:", id);
      process.exit(0);
    }
    // need required fields: recorded_by, recorded_by_role, company_id
    const recordedBy = process.argv[5] || "script-insert";
    const recordedByRole = process.argv[6] || "service";
    const companyId = process.argv[7] ? Number(process.argv[7]) : 2;
    const [res] = await pool.query(
      "INSERT INTO audio_recordings (id, title, recorded_by, recorded_by_role, audio_url, processed_url, company_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())",
      [
        id,
        `import-${id}`,
        recordedBy,
        recordedByRole,
        audioUrl,
        processedUrl,
        companyId,
      ]
    );
    console.log("inserted id:", id, "result:", res);
    process.exit(0);
  } catch (e) {
    console.error("insert failed:", e);
    process.exit(1);
  }
}

main();
