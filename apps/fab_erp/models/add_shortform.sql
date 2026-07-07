-- Standalone idempotent migration: add shortform column to taxonomy tables
-- Run: source this file via mysql CLI or workbench against a live DB that
-- already has fab_item_categories, fab_item_groups, fab_item_subgroups.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_categories' AND COLUMN_NAME='shortform');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_categories ADD COLUMN shortform VARCHAR(10) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_groups' AND COLUMN_NAME='shortform');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_groups ADD COLUMN shortform VARCHAR(10) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_subgroups' AND COLUMN_NAME='shortform');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_subgroups ADD COLUMN shortform VARCHAR(10) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

UPDATE fab_item_categories SET shortform = code WHERE shortform IS NULL;
UPDATE fab_item_groups SET shortform = code WHERE shortform IS NULL;
UPDATE fab_item_subgroups SET shortform = code WHERE shortform IS NULL;
