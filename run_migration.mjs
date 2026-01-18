import mysql from "mysql2/promise";

(async () => {
  try {
    const conn = await mysql.createConnection({
      host: "localhost",
      user: "root",
      password: "root123",
      database: "sqldb",
    });

    console.log("Adding medicine column to audio_recordings...");
    try {
      await conn.query(
        'ALTER TABLE audio_recordings ADD COLUMN medicine VARCHAR(255) NULL COMMENT "Medicine/Brand name for the recording"'
      );
      console.log("✓ medicine column added");
    } catch (err) {
      if (err.code === "ER_DUP_FIELDNAME") {
        console.log("✓ medicine column already exists");
      } else {
        throw err;
      }
    }

    try {
      await conn.query(
        "CREATE INDEX idx_audio_medicine ON audio_recordings(medicine)"
      );
      console.log("✓ index created");
    } catch (err) {
      if (err.code === "ER_DUP_KEYNAME") {
        console.log("✓ index already exists");
      } else {
        throw err;
      }
    }

    conn.end();
    console.log("✓ Migration complete!");
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exit(1);
  }
})();
