import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

async function runMigration() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "role_based_auth",
    waitForConnections: true,
  });

  try {
    console.log("🔄 Adding medicines column to team_documents...");

    try {
      await pool.query(`
        ALTER TABLE team_documents 
        ADD COLUMN medicines VARCHAR(500) NULL 
        COMMENT 'Medicine/Brand name for detailing practice'
      `);
      console.log("✅ medicines column added successfully");
    } catch (e) {
      if (e.code === "ER_DUP_FIELDNAME") {
        console.log("ℹ️  medicines column already exists");
      } else {
        throw e;
      }
    }

    try {
      await pool.query(`
        CREATE INDEX idx_medicines 
        ON team_documents(medicines)
      `);
      console.log("✅ index created successfully");
    } catch (e) {
      if (e.code === "ER_DUP_KEYNAME") {
        console.log("ℹ️  index already exists");
      } else {
        throw e;
      }
    }
  } catch (error) {
    console.error("❌ Migration error:", error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

runMigration()
  .then(() => {
    console.log("✅ Migration completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  });
