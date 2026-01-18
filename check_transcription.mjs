import mysql from "mysql2/promise";

const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "root123",
  database: "sqldb",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

async function checkTranscription() {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query(
      `SELECT id, title, transcription, processed_url, created_at FROM audio_recordings WHERE id >= 204 ORDER BY id DESC LIMIT 5`
    );
    console.log("\n=== Latest Audio Recordings ===");
    rows.forEach((row) => {
      console.log(`\nID: ${row.id}`);
      console.log(`Title: ${row.title}`);
      console.log(`Processed URL: ${row.processed_url}`);
      console.log(
        `Transcription: ${
          row.transcription
            ? row.transcription.substring(0, 100) + "..."
            : "NULL"
        }`
      );
      console.log(`Created: ${row.created_at}`);
    });
    connection.release();
    process.exit(0);
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

checkTranscription();
