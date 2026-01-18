const mysql = require("mysql2/promise");

(async () => {
  try {
    const conn = await mysql.createConnection({
      host: "localhost",
      user: "root",
      password: "",
      database: "sqldb",
    });

    console.log("Adding medicine column to audio_recordings...");
    await conn.query(
      'ALTER TABLE audio_recordings ADD COLUMN IF NOT EXISTS medicine VARCHAR(255) NULL COMMENT "Medicine/Brand name for the recording"'
    );
    console.log("✓ medicine column added");

    await conn.query(
      "CREATE INDEX IF NOT EXISTS idx_audio_medicine ON audio_recordings(medicine)"
    );
    console.log("✓ index created");

    conn.end();
    console.log("✓ Migration complete!");
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exit(1);
  }
})();
