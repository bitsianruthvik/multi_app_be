-- 2026-08-blocker-detail.sql
-- Naming what is actually holding a task up.
--
-- WHAT WAS WRONG
-- --------------
-- The pre-eligibility window (created_at → deps_cleared) was classified
-- WHOLESALE: one segment, one reason, chosen from the task's CURRENT gate state.
-- In production that is 86.5% of all attributed waiting time — 196,345 hours in
-- one undiagnosable bucket that cannot say WHICH dependency is responsible.
--
-- Measuring it showed something worse than a lost detail:
--
--   * all 3,281 waiting_predecessors segments sit on BLOCKED tasks; none on a
--     task that ever cleared
--   * 533 tasks did clear, and not one carries a pre-eligibility segment — the
--     old rule skipped the window entirely once everything was satisfied
--   * those cleared tasks waited avg 0h, max 0h
--
-- So the figure is not historical delay at all. It is the LIVE BACKLOG: every
-- never-started task contributing its whole lifetime as a single segment. The
-- useful question is therefore not "how long did this wait" but "what is holding
-- it, right now, and how long has that thing been holding it".
--
-- These three columns answer that. The engine still tiles the window with
-- non-overlapping segments — that invariant is untouched — but each segment now
-- names its blocker, and the window is cut wherever the blocking set changes.
--
-- `blocker_label` is denormalised on purpose. A blocker can be a sibling task or
-- a material input, the label needs a join through a different table in each
-- case, and this is read on every feed and report — resolving it at write time
-- keeps the read path one query.
--
-- Idempotent: guarded on information_schema, safe to re-run.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'fab_task_wait_segments' AND COLUMN_NAME = 'blocker_type');
SET @sql = IF(@col = 0,
  "ALTER TABLE fab_task_wait_segments ADD COLUMN blocker_type VARCHAR(20) NULL COMMENT 'predecessor | input — what kind of thing was holding the task during this segment'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'fab_task_wait_segments' AND COLUMN_NAME = 'blocker_ref_id');
SET @sql = IF(@col = 0,
  "ALTER TABLE fab_task_wait_segments ADD COLUMN blocker_ref_id INT NULL COMMENT 'the predecessor fab_project_tasks.id, or the fab_task_inputs.id — NULL when several were outstanding at once'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'fab_task_wait_segments' AND COLUMN_NAME = 'blocker_label');
SET @sql = IF(@col = 0,
  "ALTER TABLE fab_task_wait_segments ADD COLUMN blocker_label VARCHAR(200) NULL COMMENT 'human name of the blocker, denormalised at write time so the read path stays one query'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Answers "what is holding the most work up right now", which is the whole point.
SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'fab_task_wait_segments' AND INDEX_NAME = 'idx_ftws_blocker');
SET @sql = IF(@idx = 0,
  "CREATE INDEX idx_ftws_blocker ON fab_task_wait_segments (company_id, blocker_type, blocker_ref_id)",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
