import { pool } from "./db.js";

try {
  const [columns] = await pool.query("SHOW COLUMNS FROM audio_recordings");
  console.log("\nAll columns in audio_recordings:");
  console.log("================================");
  columns.forEach((col) => {
    console.log(`- ${col.Field} (${col.Type})`);
  });

  console.log("\n\nChecking for historical tracking columns:");
  console.log("==========================================");
  const historicalColumns = ["history_block", "track", "updated_at"];
  historicalColumns.forEach((colName) => {
    const exists = columns.some((c) => c.Field === colName);
    console.log(`${colName}: ${exists ? "✅ EXISTS" : "❌ MISSING"}`);
  });

  await pool.end();
} catch (error) {
  console.error("Error:", error.message);
  process.exit(1);
}
