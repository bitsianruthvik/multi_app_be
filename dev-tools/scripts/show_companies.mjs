import { pool } from "../../db.js";

async function main() {
  try {
    const [rows] = await pool.query("SELECT id, name FROM companies LIMIT 10");
    console.log("companies:", rows);
    process.exit(0);
  } catch (e) {
    console.error("error fetching companies:", e);
    process.exit(1);
  }
}

main();
