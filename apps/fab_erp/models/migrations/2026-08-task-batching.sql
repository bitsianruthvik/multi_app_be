-- 2026-08-task-batching.sql
-- Issue 4 (FAB_ERP_SHOPFLOOR_REALITY_PLAN.md): several items through one
-- machine in a single run.
--
-- Every task is currently one item × one operation with its own computed_hours.
-- But eight plates get nested on one sheet and cut in a single CNC run; twelve
-- stiffeners are stacked and drilled in one setup; a whole batch is galvanised
-- in one dip that takes the same time for 3 pieces or 30. The system counted
-- those as 8, 12 and 30 independent jobs each consuming its full estimate, so
-- utilisation was overstated, capacity looked worse than it is, and the
-- learned-duration engine was being taught nonsense.
--
-- KEY MODELLING DECISION: batchability lives on the operation × resource-type
-- mapping, NOT on the operation and NOT on the item. A plate does not know
-- whether it can be batched — a plasma table batches and a welding bay does
-- not, and the same "Drill" operation batches on a multi-spindle drill line but
-- not on a mag drill. The machine decides.
--
-- Idempotent: guarded on information_schema, safe to re-run.

-- ── Batchability, per operation × resource type ─────────────────────────────
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_operation_resource_types'
              AND COLUMN_NAME='batch_mode');
SET @sql = IF(@col=0,
  "ALTER TABLE fab_operation_resource_types
     ADD COLUMN batch_mode ENUM('none','shared_setup','fixed_cycle','capacity_cycle')
     NOT NULL DEFAULT 'none'
     COMMENT 'none: n x unit. shared_setup: setup + n x unit. fixed_cycle: one cycle regardless of n. capacity_cycle: ceil(n/capacity) x cycle.'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- NULL falls back to fab_resources.num_units — the per-machine parallel-unit
-- count that already existed on that table and was never used by anything.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_operation_resource_types'
              AND COLUMN_NAME='batch_capacity');
SET @sql = IF(@col=0,
  "ALTER TABLE fab_operation_resource_types ADD COLUMN batch_capacity INT NULL",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- What must MATCH for two tasks to share a batch, as a JSON array of item
-- custom-field / metric keys, e.g. ["thickness_mm","material_grade"]. This is a
-- physical constraint, not a preference: you cannot nest 20 mm and 6 mm plate
-- on the same cut.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_operation_resource_types'
              AND COLUMN_NAME='batch_match_keys');
SET @sql = IF(@col=0,
  "ALTER TABLE fab_operation_resource_types ADD COLUMN batch_match_keys JSON NULL",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── A batch is a real, auditable run ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fab_task_batches (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  company_id     INT NOT NULL,
  resource_id    INT NOT NULL,
  operation_id   INT NOT NULL,
  batch_mode     VARCHAR(20)  NOT NULL DEFAULT 'none',
  status         ENUM('open','in_progress','done','cancelled') NOT NULL DEFAULT 'open',
  started_at     DATETIME     NULL,
  completed_at   DATETIME     NULL,
  -- Wall-clock the batch actually took, and the portion attributed to setup.
  -- Setup is held at the BATCH level and never divided into the parts: a batch
  -- of 2 would otherwise make every part look expensive, and operationStatsService
  -- feeds actuals back into planning, so that error compounds into every
  -- future estimate.
  total_minutes  INT          NULL,
  setup_minutes  INT          NULL,
  created_by     INT          NULL,
  deleted_at     DATETIME     NULL,
  created_at     TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fab_task_batches_company (company_id),
  KEY idx_fab_task_batches_resource (resource_id, status)
);

-- ── Task → batch membership ─────────────────────────────────────────────────
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_project_tasks'
              AND COLUMN_NAME='batch_id');
SET @sql = IF(@col=0,
  "ALTER TABLE fab_project_tasks ADD COLUMN batch_id INT NULL",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_project_tasks'
              AND INDEX_NAME='idx_fab_project_tasks_batch');
SET @sql = IF(@idx=0,
  "CREATE INDEX idx_fab_project_tasks_batch ON fab_project_tasks (batch_id)",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── Attributed touch time ───────────────────────────────────────────────────
-- Actual duration is DERIVED from the event log (started → completed minus
-- pauses) — see operationStatsService.buildSample. That derivation is correct
-- for a solo task and badly wrong for a batched one: eight tasks that all start
-- at 09:00 and all complete at 09:40 each derive 40 minutes, so a 40-minute run
-- is learned as 320 minutes of work and every future estimate for that
-- operation inflates.
--
-- The events are not wrong — all eight really were open for those 40 minutes —
-- so they are left alone. This column carries each task's SHARE of the run, and
-- the two readers of touch time (computeActualHoursForTasks, the nightly
-- recomputeStatsForCompany) prefer it when it is set. NULL for every unbatched
-- task, which keeps the existing derivation as the default path.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_project_tasks'
              AND COLUMN_NAME='attributed_minutes');
SET @sql = IF(@col=0,
  "ALTER TABLE fab_project_tasks ADD COLUMN attributed_minutes DECIMAL(12,2) NULL
     COMMENT 'Batching: this task share of the batch run. Overrides event-derived touch time.'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
