-- FabFlow: Schedule Versioning + Task Progress
-- Run once after migration_metrics_progress.sql has been applied.

-- ── 1. Schedule Snapshots (version history) ──────────────────────────────────
--      Every manual run, replan, or cron reschedule saves the current schedule
--      as a JSON snapshot before overwriting fab_schedule_tasks.
CREATE TABLE IF NOT EXISTS fab_schedule_snapshots (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  plan_id       INT           NOT NULL,
  company_id    INT           NOT NULL,
  version_no    INT           NOT NULL,           -- auto-increments per plan
  triggered_by  ENUM('manual','replan','cron') NOT NULL DEFAULT 'manual',
  task_count    INT           NOT NULL DEFAULT 0,
  snapshot_data LONGTEXT      NOT NULL,           -- JSON of full ScheduleData blob
  created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_plan_version  (plan_id, version_no),
  KEY idx_fss_plan_company    (plan_id, company_id)
);

-- ── 2. Task Progress Log (daily work log per task) ───────────────────────────
--      One row per (plan, step, node, date).  completion_pct is cumulative.
--      The rescheduler reads the latest log_date row per task to get remaining %.
--      work_start / work_end are HH:MM strings for that day's session.
--      delay_reason_codes is a JSON array of reason strings, written only when
--      the task closes at 100 % and total worked time > 115 % of scheduledHours.
CREATE TABLE IF NOT EXISTS fab_task_progress (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  plan_id             INT           NOT NULL,
  company_id          INT           NOT NULL,
  process_step_id     INT           NOT NULL,
  node_id             INT           NULL,
  log_date            DATE          NOT NULL,
  completion_pct      DECIMAL(5,2)  NOT NULL DEFAULT 0.00,
  work_start          TIME          NULL,
  work_end            TIME          NULL,
  delay_reason_codes  JSON          NULL,
  notes               TEXT          NULL,
  created_by          INT           NULL,
  created_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ftp_task_day  (plan_id, process_step_id, node_id, log_date),
  KEY idx_ftp_plan            (plan_id),
  KEY idx_ftp_plan_task       (plan_id, process_step_id, node_id)
);

SELECT 'fab_schedule_snapshots' AS tbl, COUNT(*) AS cnt FROM fab_schedule_snapshots
UNION ALL SELECT 'fab_task_progress', COUNT(*) FROM fab_task_progress;
