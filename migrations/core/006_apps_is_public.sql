-- Migration 006: ensure apps.is_public exists (schema drift fix)
-- MySQL 8.0 has no ADD COLUMN IF NOT EXISTS — use information_schema guard
SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'apps' AND COLUMN_NAME = 'is_public'
);
SET @s = IF(@col = 0,
  'ALTER TABLE apps ADD COLUMN is_public TINYINT(1) NOT NULL DEFAULT 1 AFTER slug, ADD KEY idx_apps_public (is_public)',
  'SELECT 1'
);
PREPARE p FROM @s; EXECUTE p; DEALLOCATE PREPARE p;