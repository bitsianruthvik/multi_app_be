-- Migration: create audio_recordings table (minimal schema)
-- Run this with your MySQL client: mysql -u root -p < create_audio_recordings.sql
CREATE TABLE IF NOT EXISTS `audio_recordings` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(255) DEFAULT NULL,
  `recorded_by` VARCHAR(255) DEFAULT NULL,
  `recorded_by_role` VARCHAR(100) DEFAULT NULL,
  `audio_url` TEXT DEFAULT NULL,
  `processed_url` TEXT DEFAULT NULL,
  `audio_data` MEDIUMTEXT DEFAULT NULL,
  `transcription` LONGTEXT DEFAULT NULL,
  `analysis` LONGTEXT DEFAULT NULL,
  `status` VARCHAR(50) DEFAULT 'new',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
