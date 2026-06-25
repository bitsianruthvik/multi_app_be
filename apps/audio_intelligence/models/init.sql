-- audio_intelligence app schema.
-- Tables owned by this app: audio_recordings, company_documents, team_documents.
-- Depends on core tables: users, companies, teams.
-- Schema reflects production column set (myproject.sql as of 2026-05-17).

CREATE TABLE IF NOT EXISTS company_documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uploader_id INT NOT NULL,
  company_id INT NOT NULL,
  doc_path VARCHAR(1000) NOT NULL,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL DEFAULT NULL,
  FOREIGN KEY (uploader_id) REFERENCES users(id),
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS team_documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uploader_id INT NOT NULL,
  company_id INT NOT NULL,
  team_id INT NOT NULL,
  doc_path VARCHAR(1000) NOT NULL,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  medicines VARCHAR(50) DEFAULT NULL,
  extracted_text LONGTEXT,
  usp_points JSON,
  deleted_at DATETIME NULL DEFAULT NULL,
  FOREIGN KEY (uploader_id) REFERENCES users(id),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (team_id) REFERENCES teams(id),
  KEY idx_medicines (medicines)
);

CREATE TABLE IF NOT EXISTS audio_recordings (
  id INT NOT NULL AUTO_INCREMENT,
  title VARCHAR(255) NOT NULL,
  recorded_by VARCHAR(255) NOT NULL,
  recorded_by_role VARCHAR(50) NOT NULL,
  audio_url TEXT,
  processed_url TEXT,
  transcription TEXT,
  company_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  new_tran LONGTEXT,
  idempotency_key VARCHAR(255) DEFAULT NULL,
  diarization JSON,
  analysis LONGTEXT,
  history_block JSON,
  score INT DEFAULT NULL,
  keywords_of_improvement TEXT,
  medicine VARCHAR(255) DEFAULT NULL COMMENT 'Medicine/Brand name for the recording',
  track JSON,
  deleted_at DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_audio_idempotency (idempotency_key),
  KEY idx_company_id (company_id),
  KEY idx_recorded_by_role (recorded_by_role),
  KEY idx_created_at (created_at),
  KEY idx_audio_medicine (medicine)
);

CREATE TABLE IF NOT EXISTS actions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  company_id INT NOT NULL,
  display_order INT DEFAULT 0,
  deleted_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

DROP PROCEDURE IF EXISTS add_action_id_if_missing;
DELIMITER //
CREATE PROCEDURE add_action_id_if_missing()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'audio_recordings'
      AND COLUMN_NAME = 'action_id'
  ) THEN
    ALTER TABLE audio_recordings ADD COLUMN action_id INT DEFAULT NULL AFTER medicine;
  END IF;
END //
DELIMITER ;
CALL add_action_id_if_missing();
DROP PROCEDURE IF EXISTS add_action_id_if_missing;
