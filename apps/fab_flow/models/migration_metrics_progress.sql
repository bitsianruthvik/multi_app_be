-- FabFlow: Metrics, Process Type Registry, Progress Tracking, Schedule Tasks
-- Run once after migration_capacity.sql has been applied.
-- Safe to re-run: CREATE TABLE IF NOT EXISTS + INFORMATION_SCHEMA guards on ALTER.

DROP PROCEDURE IF EXISTS fab_add_col2;
DELIMITER $$
CREATE PROCEDURE fab_add_col2(tbl VARCHAR(64), col VARCHAR(64), def TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', def);
    PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
  END IF;
END$$
DELIMITER ;

-- ── 1. Process Type Registry (company-level generic process definitions) ────────
--      Each row defines: for a given process_type_name, which node metric drives
--      duration and at what rate (e.g. Welding = 0.1 hr per mm of weld_length_mm).

CREATE TABLE IF NOT EXISTS fab_process_type_registry (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  company_id        INT           NOT NULL,
  process_type_name VARCHAR(100)  NOT NULL,
  description       TEXT          DEFAULT NULL,
  metric_key        VARCHAR(100)  DEFAULT NULL,   -- e.g. 'weld_length_mm', 'num_holes'
  rate_value        DECIMAL(12,6) DEFAULT NULL,   -- hours per one unit of the metric
  rate_unit         VARCHAR(50)   DEFAULT NULL,   -- human label e.g. 'hr/mm', 'hr/kg'
  active            TINYINT(1)    DEFAULT 1,
  deleted_at        DATETIME      DEFAULT NULL,
  created_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE KEY uq_fptr_company_type (company_id, process_type_name),
  KEY idx_fptr_company (company_id)
);

-- ── 2. Node Metrics (fluid key-value per node) ───────────────────────────────────
--      Stores any measurable attribute of a node that a process step may need
--      for duration calculation.  Keys evolve freely without schema changes.
--      Examples: weld_length_mm, cut_length_mm, num_holes, num_studs,
--                paint_area_m2, blast_area_m2, bend_length_mm, grind_length_mm

CREATE TABLE IF NOT EXISTS fab_node_metrics (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  node_id      INT           NOT NULL,
  company_id   INT           NOT NULL,
  metric_key   VARCHAR(100)  NOT NULL,   -- matches fab_process_type_registry.metric_key
  metric_value DECIMAL(14,4) NOT NULL,
  metric_unit  VARCHAR(50)   DEFAULT NULL,
  deleted_at   DATETIME      DEFAULT NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (node_id)    REFERENCES fab_nodes(id),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE KEY uq_fnm_node_key (node_id, metric_key),
  KEY idx_fnm_node    (node_id),
  KEY idx_fnm_company (company_id)
);

-- ── 3. Alter fab_process_steps: metric-based duration columns ───────────────────
--      time_calc_mode='manual'  → use estimated_time_value as before
--      time_calc_mode='metric'  → duration = node metric value × time_rate_value
--      time_metric_key          → which fab_node_metrics.metric_key to read
--      time_rate_value          → hours per unit (mirrors process_type_registry rate
--                                 but can be overridden per step)
--      time_rate_unit           → human label for display only

CALL fab_add_col2('fab_process_steps','time_calc_mode',  "ENUM('manual','metric') NOT NULL DEFAULT 'manual' AFTER resource_notes");
CALL fab_add_col2('fab_process_steps','time_metric_key', 'VARCHAR(100) DEFAULT NULL AFTER time_calc_mode');
CALL fab_add_col2('fab_process_steps','time_rate_value', 'DECIMAL(12,6) DEFAULT NULL AFTER time_metric_key');
CALL fab_add_col2('fab_process_steps','time_rate_unit',  "VARCHAR(50) DEFAULT NULL AFTER time_rate_value");

-- ── 4. Node Process Progress (daily progress snapshots) ─────────────────────────
--      Each snapshot_date replaces the previous one for the same node+step.
--      Multiple rows per (node_id, process_step_id, snapshot_date) allowed —
--      each row is one "batch bucket" (qty pieces at a given completion %).
--      Scheduler uses the latest snapshot_date to compute remaining work.

CREATE TABLE IF NOT EXISTS fab_node_process_progress (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  plan_id         INT           NOT NULL,
  node_id         INT           NOT NULL,
  process_step_id INT           NOT NULL,
  company_id      INT           NOT NULL,
  snapshot_date   DATE          NOT NULL,
  batch_qty       DECIMAL(10,3) NOT NULL DEFAULT 1,   -- pieces in this bucket
  completion_pct  DECIMAL(5,2)  NOT NULL DEFAULT 0,   -- 0-100
  reported_by     INT           DEFAULT NULL,
  notes           TEXT          DEFAULT NULL,
  deleted_at      DATETIME      DEFAULT NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (plan_id)         REFERENCES fab_project_plans(id),
  FOREIGN KEY (node_id)         REFERENCES fab_nodes(id),
  FOREIGN KEY (process_step_id) REFERENCES fab_process_steps(id),
  FOREIGN KEY (company_id)      REFERENCES companies(id),
  FOREIGN KEY (reported_by)     REFERENCES users(id),
  KEY idx_fnpp_plan_step  (plan_id, process_step_id),
  KEY idx_fnpp_node_step  (node_id, process_step_id),
  KEY idx_fnpp_date       (snapshot_date),
  KEY idx_fnpp_company    (company_id)
);

-- ── 5. Schedule Tasks (created here if not yet present) ─────────────────────────
CREATE TABLE IF NOT EXISTS fab_schedule_tasks (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  plan_id         INT           NOT NULL,
  company_id      INT           NOT NULL,
  node_prefix     VARCHAR(200)  DEFAULT NULL,
  process_step_id INT           NOT NULL,
  work_area_id    INT           DEFAULT NULL,
  scheduled_start DATE          DEFAULT NULL,
  scheduled_end   DATE          DEFAULT NULL,
  scheduled_hours DECIMAL(10,2) DEFAULT 0,
  is_critical     TINYINT(1)    DEFAULT 0,
  is_unassigned   TINYINT(1)    DEFAULT 0,
  deleted_at      DATETIME      DEFAULT NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (plan_id)         REFERENCES fab_project_plans(id),
  FOREIGN KEY (company_id)      REFERENCES companies(id),
  FOREIGN KEY (process_step_id) REFERENCES fab_process_steps(id),
  FOREIGN KEY (work_area_id)    REFERENCES fab_work_areas(id),
  KEY idx_fst_plan    (plan_id, company_id),
  KEY idx_fst_step    (process_step_id),
  KEY idx_fst_start   (scheduled_start)
);

DROP PROCEDURE IF EXISTS fab_add_col2;

-- ── 6. Verify ────────────────────────────────────────────────────────────────────
SELECT 'fab_process_type_registry'  AS tbl, COUNT(*) AS cnt FROM fab_process_type_registry
UNION ALL SELECT 'fab_node_metrics',          COUNT(*) FROM fab_node_metrics
UNION ALL SELECT 'fab_node_process_progress', COUNT(*) FROM fab_node_process_progress
UNION ALL SELECT 'fab_schedule_tasks',        COUNT(*) FROM fab_schedule_tasks;
