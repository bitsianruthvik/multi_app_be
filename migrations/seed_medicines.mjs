import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

async function seedMedicines() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "role_based_auth",
    waitForConnections: true,
  });

  try {
    console.log("🔄 Checking for existing team_documents records...");

    // Get first company and team
    const [companies] = await pool.query("SELECT id FROM companies LIMIT 1");
    const [teams] = await pool.query("SELECT id FROM teams LIMIT 1");
    const [users] = await pool.query("SELECT id FROM users LIMIT 1");

    if (!companies.length || !teams.length || !users.length) {
      console.log(
        "⚠️  No company, team, or user found. Please create them first."
      );
      return;
    }

    const companyId = companies[0].id;
    const teamId = teams[0].id;
    const uploaderId = users[0].id;

    // Sample medicines to add
    const medicines = [
      "Paracetamol",
      "Ibuprofen",
      "Amoxicillin",
      "Aspirin",
      "Ciprofloxacin",
      "Metformin",
      "Atorvastatin",
      "Omeprazole",
      "Amlodipine",
      "Losartan",
    ];

    console.log("🔄 Adding sample medicines to team_documents...");

    for (const medicine of medicines) {
      // Check if already exists
      const [existing] = await pool.query(
        "SELECT id FROM team_documents WHERE medicines = ? AND company_id = ? LIMIT 1",
        [medicine, companyId]
      );

      if (existing.length === 0) {
        await pool.query(
          "INSERT INTO team_documents (uploader_id, company_id, team_id, doc_path, medicines) VALUES (?, ?, ?, ?, ?)",
          [
            uploaderId,
            companyId,
            teamId,
            `/docs/${medicine.toLowerCase()}.pdf`,
            medicine,
          ]
        );
        console.log(`✅ Added ${medicine}`);
      } else {
        console.log(`ℹ️  ${medicine} already exists`);
      }
    }

    console.log("✅ Seed completed successfully");
  } catch (error) {
    console.error("❌ Seed error:", error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

seedMedicines()
  .then(() => {
    console.log("✅ Seed completed");
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ Seed failed:", error);
    process.exit(1);
  });
