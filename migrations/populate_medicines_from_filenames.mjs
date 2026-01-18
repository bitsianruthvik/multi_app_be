import mysql from "mysql2/promise";
import dotenv from "dotenv";
import path from "path";

dotenv.config();

function extractMedicineName(docPath) {
  // Extract filename from path
  const filename = path.basename(docPath);

  // Remove file extension
  const nameWithoutExt = filename.replace(/\.[^.]+$/, "");

  // Remove timestamp prefix (pattern: numbers followed by underscore)
  const withoutTimestamp = nameWithoutExt.replace(/^\d+_/, "");

  // Extract medicine name (first word/phrase before common suffixes)
  const cleaned = withoutTimestamp
    .replace(/_Doctor_Detailing.*$/i, "")
    .replace(/_Detailing.*$/i, "")
    .replace(/_expanded_dossier.*$/i, "")
    .replace(/_Final.*$/i, "")
    .replace(/_MR_.*$/i, "")
    .replace(/_Evaluation.*$/i, "")
    .replace(/_/g, " ")
    .trim();

  return cleaned || nameWithoutExt;
}

async function populateMedicines() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "role_based_auth",
  });

  try {
    console.log("🔄 Fetching team_documents...");
    const [rows] = await pool.query(
      "SELECT id, doc_path, medicines FROM team_documents"
    );

    console.log(`\n📝 Processing ${rows.length} documents...\n`);

    for (const row of rows) {
      const medicineName = extractMedicineName(row.doc_path);

      console.log(`ID ${row.id}:`);
      console.log(`  File: ${path.basename(row.doc_path)}`);
      console.log(`  Extracted: ${medicineName}`);

      await pool.query("UPDATE team_documents SET medicines = ? WHERE id = ?", [
        medicineName,
        row.id,
      ]);

      console.log(`  ✅ Updated\n`);
    }

    console.log("✅ All medicines column populated successfully!");

    // Show final result
    console.log("\n📋 Final team_documents with medicines:");
    const [updated] = await pool.query(
      "SELECT id, medicines FROM team_documents ORDER BY id"
    );
    updated.forEach((row) => {
      console.log(`  ${row.id}: ${row.medicines}`);
    });
  } finally {
    await pool.end();
  }
}

populateMedicines()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Error:", error);
    process.exit(1);
  });
