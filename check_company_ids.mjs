import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

async function checkCompanyIds() {
  try {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST || "localhost",
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    });

    console.log("Checking team_documents company_id values:\n");
    const [docs] = await connection.query(
      "SELECT id, doc_path, medicines, company_id FROM team_documents LIMIT 10"
    );
    console.log("Team Documents:");
    console.table(docs);

    console.log("\n\nChecking distinct company_id values:");
    const [distinctCompanies] = await connection.query(
      "SELECT DISTINCT company_id FROM team_documents"
    );
    console.log(
      "Distinct company_ids:",
      distinctCompanies.map((r) => r.company_id)
    );

    console.log("\n\nChecking users table for user company_ids:");
    const [users] = await connection.query(
      "SELECT id, name, email, company_id FROM users LIMIT 5"
    );
    console.table(users);

    await connection.end();
  } catch (error) {
    console.error("Error:", error);
  }
}

checkCompanyIds();
