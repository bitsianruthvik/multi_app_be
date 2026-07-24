-- 2026-07-23 — FEAT-05: production output capture + rework routing
-- Adds per-task completion capture to fab_project_tasks:
--   produced_qty  good units produced (NULL until the task is stopped)
--   scrap_qty     rejected/scrapped units at this operation
--   qc_result     'pass' books good units to stock; 'fail' spawns a rework task
--   is_rework / rework_of_task_id  link a rework task back to the QC-failed one
-- Idempotent — safe to re-run. No data seed: defaults (scrap 0, is_rework 0)
-- and NULLs leave already-completed tasks unchanged.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_project_tasks' AND COLUMN_NAME = 'produced_qty');
SET @sql = IF(@col = 0, 'ALTER TABLE fab_project_tasks ADD COLUMN produced_qty DECIMAL(18,4) NULL AFTER formula_hours', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_project_tasks' AND COLUMN_NAME = 'scrap_qty');
SET @sql = IF(@col = 0, 'ALTER TABLE fab_project_tasks ADD COLUMN scrap_qty DECIMAL(18,4) NOT NULL DEFAULT 0 AFTER produced_qty', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_project_tasks' AND COLUMN_NAME = 'qc_result');
SET @sql = IF(@col = 0, "ALTER TABLE fab_project_tasks ADD COLUMN qc_result ENUM('pass','fail') NULL AFTER scrap_qty", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_project_tasks' AND COLUMN_NAME = 'is_rework');
SET @sql = IF(@col = 0, 'ALTER TABLE fab_project_tasks ADD COLUMN is_rework TINYINT(1) NOT NULL DEFAULT 0 AFTER qc_result', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_project_tasks' AND COLUMN_NAME = 'rework_of_task_id');
SET @sql = IF(@col = 0, 'ALTER TABLE fab_project_tasks ADD COLUMN rework_of_task_id INT NULL AFTER is_rework', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_project_tasks' AND INDEX_NAME = 'idx_fpjt_rework_of');
SET @sql = IF(@idx = 0, 'ALTER TABLE fab_project_tasks ADD KEY idx_fpjt_rework_of (company_id, rework_of_task_id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
