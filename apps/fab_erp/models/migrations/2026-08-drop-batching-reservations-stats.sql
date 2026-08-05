-- 2026-08-drop-batching-reservations-stats.sql  (plan Phase 2d)
--
-- Remove three features that shipped, were never used, and are out of spec.
-- All three held ZERO rows in production after a full six-project production
-- run, so every removal below is behaviourally identical to what the code did.
--
--   fab_task_batches         batching. Decision D2: deleted entirely, INCLUDING
--                            the setup data (setup_time_hrs stays -- it is a
--                            plain per-machine figure -- but batch_mode /
--                            batch_capacity / batch_match_keys go). Dispatch
--                            phase 6B accordingly loses setup affinity as a
--                            ranking input. Accepted deliberately.
--
--   fab_stock_reservations   material earmarking. availableQty subtracted active
--                            reservations to give a FREE quantity; with no rows
--                            it always subtracted zero. What is given up: two
--                            tasks needing the same plate can now both clear
--                            their material gate, and whichever starts second
--                            finds the stock consumed.
--
--   fab_operation_stats      learned p80 durations. Decision D1: deleted, and
--                            time-buffer sizing stays a fixed 50% permanently.
--                            One-way door -- reinstating means rebuilding the
--                            table and its sampling.
--
-- fab_project_tasks.formula_hours goes with it: it existed only to preserve the
-- formula's value when a learned duration overrode it. With no learning, the
-- formula IS computed_hours and the column is always NULL.
--
-- fab_project_tasks.attributed_minutes goes too. batchService was its only
-- writer -- it split a shared batch run across its member tasks so eight parts
-- cut in one 40-minute nest were not learned as eight 40-minute samples.
-- taskVarianceService read it; that read is removed in the same commit.
--
-- Idempotent: guarded on information_schema, safe to re-run.

-- ── columns first (they are read by code shipping in this same commit) ───────

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_project_tasks'
            AND COLUMN_NAME = 'formula_hours');
SET @s = IF(@c > 0, 'ALTER TABLE fab_project_tasks DROP COLUMN formula_hours', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_project_tasks'
            AND COLUMN_NAME = 'attributed_minutes');
SET @s = IF(@c > 0, 'ALTER TABLE fab_project_tasks DROP COLUMN attributed_minutes', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- batch_id is indexed; drop the index before the column.
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_project_tasks'
            AND INDEX_NAME = 'idx_fab_project_tasks_batch');
SET @s = IF(@c > 0, 'ALTER TABLE fab_project_tasks DROP INDEX idx_fab_project_tasks_batch', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_project_tasks'
            AND COLUMN_NAME = 'batch_id');
SET @s = IF(@c > 0, 'ALTER TABLE fab_project_tasks DROP COLUMN batch_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- batching config on the operation↔resource-type link
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_operation_resource_types'
            AND COLUMN_NAME = 'batch_mode');
SET @s = IF(@c > 0, 'ALTER TABLE fab_operation_resource_types DROP COLUMN batch_mode', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_operation_resource_types'
            AND COLUMN_NAME = 'batch_capacity');
SET @s = IF(@c > 0, 'ALTER TABLE fab_operation_resource_types DROP COLUMN batch_capacity', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_operation_resource_types'
            AND COLUMN_NAME = 'batch_match_keys');
SET @s = IF(@c > 0, 'ALTER TABLE fab_operation_resource_types DROP COLUMN batch_match_keys', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── then the tables ─────────────────────────────────────────────────────────

DROP TABLE IF EXISTS fab_task_batches;
DROP TABLE IF EXISTS fab_stock_reservations;
DROP TABLE IF EXISTS fab_operation_stats;
DROP TABLE IF EXISTS fab_constants;
