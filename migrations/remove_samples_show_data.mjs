import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

async function removeAndShowData() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "role_based_auth",
  });

  try {
    // Delete the sample medicine records we added
    console.log("🔄 Removing sample medicines...");
    const [result] = await pool.query(
      `DELETE FROM team_documents WHERE doc_path LIKE '/docs/%.pdf'`
    );
    console.log(`✅ Removed ${result.affectedRows} sample records`);

    // Show remaining data
    console.log("\n📋 Remaining team_documents records:");
    const [rows] = await pool.query("SELECT * FROM team_documents");

    if (rows.length === 0) {
      console.log("⚠️  No records found in team_documents table");
      console.log(
        "ℹ️  You need to upload documents first or have existing data"
      );
    } else {
      console.log(`Found ${rows.length} records:`);
      rows.forEach((row, idx) => {
        console.log(`\n${idx + 1}. ID: ${row.id}`);
        console.log(`   doc_path: ${row.doc_path}`);
        console.log(`   medicines: ${row.medicines || "(empty)"}`);
        console.log(`   company_id: ${row.company_id}`);
        console.log(`   team_id: ${row.team_id}`);
      });
    }
  } finally {
    await pool.end();
  }
}

removeAndShowData()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Error:", error);
    process.exit(1);
  });
