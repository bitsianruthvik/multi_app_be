-- 2026-07-23 — FEAT-03: order completion % on the board
-- Persisted task-count completion percentage (0-100) on fab_orders, maintained
-- by taskEngineService.rollUpOrderStatus on every task start/complete. Per-line
-- progress reuses the existing fab_order_lines.qty_completed column (no DDL).
-- Idempotent — safe to re-run.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_orders' AND COLUMN_NAME = 'progress_pct');
SET @sql = IF(@col = 0, 'ALTER TABLE fab_orders ADD COLUMN progress_pct TINYINT UNSIGNED NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
