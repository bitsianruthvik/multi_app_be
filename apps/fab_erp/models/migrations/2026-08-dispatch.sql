-- 2026-08-dispatch.sql  (plan Phase 6A)
--
-- Dispatch answers one question per machine: what should this machine work on
-- next, and why. Two things are needed for that beyond what already exists.
--
-- 1. A manual project rank.
--    fab_orders.priority is deliberately NOT reused: it is free text
--    (VARCHAR(20), values like 'high'), user-visible, and read by exactly zero
--    lines of backend code. Overloading it would make an ordering depend on
--    whatever someone typed.
--
-- 2. A record of each run.
--    A confirmation means nothing without a record of what was confirmed. The
--    inputs to a ranking — buffer levels, order slack, task status — all move
--    within minutes, so "why was this ranked first?" is unanswerable an hour
--    later unless the component scores are frozen at run time. The header/rows
--    shape mirrors fab_cc_drum + fab_cc_drum_slots, the live analogue.
--    (fab_mrp_runs, which the plan named as the template, was dropped with the
--    rest of MRP.)
--
-- Idempotent: guarded ALTER, CREATE TABLE IF NOT EXISTS. Safe to re-run.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_orders'
               AND COLUMN_NAME = 'priority_rank');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_orders ADD COLUMN priority_rank INT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_orders'
               AND INDEX_NAME = 'idx_fo_company_priority_rank');
SET @sql = IF(@idx = 0,
  'ALTER TABLE fab_orders ADD KEY idx_fo_company_priority_rank (company_id, priority_rank)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- One row per confirmed dispatch run.
CREATE TABLE IF NOT EXISTS fab_dispatch_runs (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  company_id     INT          NOT NULL,
  status         ENUM('preview','confirmed') NOT NULL DEFAULT 'preview',
  computed_at    DATETIME     NOT NULL,
  confirmed_at   DATETIME     NULL,
  confirmed_by   INT          NULL,
  machine_count  INT          NOT NULL DEFAULT 0,
  task_count     INT          NOT NULL DEFAULT 0,
  notes          VARCHAR(400) NULL,
  deleted_at     DATETIME     NULL,
  created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fdr_company_computed (company_id, computed_at)
);

-- What each machine was told to do, with the numbers that decided it. The score
-- components are frozen copies, not joins: the whole point is that they stay
-- readable after the live values have moved on.
--
-- assigned_resource_id is the machine this task was given to. An unassigned
-- task is eligible on every machine of its type, so without recording one
-- choice per run, "tell every machine what to do next" tells three machines the
-- same thing and two of them lose the race at Start.
CREATE TABLE IF NOT EXISTS fab_dispatch_run_items (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  company_id           INT           NOT NULL,
  run_id               INT           NOT NULL,
  resource_id          INT           NOT NULL,
  task_id              INT           NOT NULL,
  order_id             INT           NULL,
  rank_in_machine      INT           NOT NULL,
  order_slack_minutes  INT           NULL,
  is_critical_chain    TINYINT(1)    NOT NULL DEFAULT 0,
  seq_no               INT           NULL,
  queued_at            DATETIME      NULL,
  reason               VARCHAR(300)  NULL,
  deleted_at           DATETIME      NULL,
  created_at           TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fdri_run_resource (company_id, run_id, resource_id, rank_in_machine),
  KEY idx_fdri_task (company_id, task_id)
);
