import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

async function checkData() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "role_based_auth",
  });

  try {
    const [rows] = await pool.query(
      "SELECT id, doc_path, medicines FROM team_documents"
    );
    console.log("Current team_documents records:");
    console.log(JSON.stringify(rows, null, 2));
  } finally {
    await pool.end();
  }
}

checkData();
