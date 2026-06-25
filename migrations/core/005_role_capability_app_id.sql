-- Migration 005: per-app capability scoping
-- NULL app_id = applies to all apps in company (backward compatible)
SET @col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'role_capability' AND COLUMN_NAME = 'app_id'
);
SET @s = IF(@col = 0,
  'ALTER TABLE role_capability ADD COLUMN app_id INT NULL AFTER company_id, ADD KEY idx_rc_app (app_id), ADD CONSTRAINT fk_rc_app FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE',
  'SELECT 1'
);
PREPARE p FROM @s; EXECUTE p; DEALLOCATE PREPARE p;
