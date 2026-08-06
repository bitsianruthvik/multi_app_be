-- 2026-08-people-v2.sql
-- People own the calendar, and who touched the task is recorded.
-- See FAB_ERP_PEOPLE_PLAN.md Part 2 for the reasoning; short version below.
--
-- WHAT PART 1 LEFT OPEN
-- ---------------------
-- 2026-08-workers.sql made the ROSTER real (fab_workers) and made assignment an
-- INTERVAL (fab_worker_assignments). What it could not express:
--
--   * when a person is meant to be here at all. Shift calendars hung off
--     PLANTS and MACHINES (fab_resources.shift_calendar_id), so a night-shift
--     operator and a day-shift operator on the same machine were the same fact.
--   * who actually did the work. fab_task_events records `entered_by` — the
--     LOGIN that tapped the screen, typically a supervisor — and nothing about
--     the welder. That makes AWS D1.1 / EN 1090 joint traceability impossible,
--     which is the one genuinely defensible reason to record people at all
--     (FAB_ERP_PEOPLE_PLAN.md §0).
--   * a correction that can be told apart from the original. Fixing a backdated
--     mistake meant soft-deleting and re-inserting, so "what did we believe last
--     Tuesday" had no answer — and machine/project delays are DERIVED from these
--     rows.
--
-- Additive only. Nothing is dropped, fab_resources.shift_calendar_id keeps
-- working, and no existing read path changes until the services are moved over.
--
-- Idempotent: guarded on information_schema, safe to re-run.

-- ── Which shift a person is on, as intervals ────────────────────────────────
-- A person is assigned to a SHIFT ROW, not to a bare time range. fab_shifts
-- already rolls end_time <= start_time forward a day (so a 22:00–06:00 night
-- shift works), already carves the unpaid break out of the middle via
-- working_minutes, and its parent calendar already holds the plant's
-- non-working days as an exception list. Pointing at it inherits all three
-- instead of reimplementing them per person.
--
-- Reassignment is close-one-open-the-next, exactly like machine assignment.
-- Because to_ts is nullable, a standing roster projects FORWARD indefinitely —
-- which is what lets the scheduler plan next month from today's roster once
-- capacity is derived from crew.
CREATE TABLE IF NOT EXISTS fab_worker_shifts (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  company_id       INT NOT NULL,
  worker_id        INT NOT NULL,
  shift_id         INT NOT NULL,
  from_ts          DATETIME NOT NULL,
  to_ts            DATETIME NULL,              -- NULL = still on this shift
  source           ENUM('live','backfill','system') NOT NULL DEFAULT 'live',
  entered_by       INT NULL,
  superseded_by_id INT NULL,                   -- see the correction note below
  note             VARCHAR(400) NULL,
  deleted_at       DATETIME NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fws_worker  (worker_id, from_ts),
  KEY idx_fws_company (company_id),
  KEY idx_fws_shift   (shift_id)
);

-- ── Who actually touched the task ───────────────────────────────────────────
-- The traceability record: which qualified welder made which joint. Interval-
-- shaped like everything else, so a person joining a task halfway through, or
-- handing it over, is one more row rather than a special case.
--
-- NOTE what is absent, deliberately: no minutes, no efficiency, no output per
-- person. This says WHO, never HOW FAST. The moment it can rank people it
-- becomes something to manage rather than something to tell the truth to, and
-- because these rows share a stream with production timing the falsification
-- would flow into fab_operation_stats and corrupt every future estimate.
-- FAB_ERP_PEOPLE_PLAN.md §0 and §14.
CREATE TABLE IF NOT EXISTS fab_task_workers (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  company_id       INT NOT NULL,
  task_id          INT NOT NULL,
  worker_id        INT NOT NULL,
  role             VARCHAR(64) NULL,           -- welder / operator / helper
  from_ts          DATETIME NOT NULL,
  to_ts            DATETIME NULL,
  source           ENUM('live','backfill','system') NOT NULL DEFAULT 'live',
  entered_by       INT NULL,
  superseded_by_id INT NULL,
  note             VARCHAR(400) NULL,
  deleted_at       DATETIME NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_ftw_task    (task_id, from_ts),
  KEY idx_ftw_worker  (worker_id, from_ts),
  KEY idx_ftw_company (company_id)
);

-- ── Append-only correction on the existing assignment table ─────────────────
-- Correcting a row must never UPDATE it. Insert the corrected row, then point
-- the old row's superseded_by_id at the new one, in one transaction; every read
-- filters `deleted_at IS NULL AND superseded_by_id IS NULL`.
--
-- This is the idiom fab_task_events.superseded_by_event_id already uses, so the
-- app has exactly one correction pattern rather than two. It matters here more
-- than there: a delay figure that changes with no record of why is worse than a
-- wrong one, because nothing signals that it moved.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_worker_assignments'
              AND COLUMN_NAME  = 'superseded_by_id');
SET @sql = IF(@col = 0,
  "ALTER TABLE fab_worker_assignments ADD COLUMN superseded_by_id INT NULL COMMENT 'Append-only correction: this row was replaced by that one. Reads filter superseded_by_id IS NULL.'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- `source` distinguishes a live tap on the floor from a backdated write-up.
-- Without it a correction entered weeks later is indistinguishable from an
-- observation made at the time, and the two carry very different confidence.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_worker_assignments'
              AND COLUMN_NAME  = 'source');
SET @sql = IF(@col = 0,
  "ALTER TABLE fab_worker_assignments ADD COLUMN source ENUM('live','backfill','system') NOT NULL DEFAULT 'live' COMMENT 'live = recorded as it happened; backfill = written up later'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Existing rows predate the distinction. The ones the Part 1 migration created
-- from fab_resource_operators were derived by the system, not observed, and
-- saying so is more honest than letting them default to 'live'.
UPDATE fab_worker_assignments
   SET source = 'system'
 WHERE note = 'migrated from fab_resource_operators'
   AND source = 'live';

-- Index supporting the read filter every consumer now applies.
SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_worker_assignments'
              AND INDEX_NAME   = 'idx_fwa_live');
SET @sql = IF(@idx = 0,
  "CREATE INDEX idx_fwa_live ON fab_worker_assignments (company_id, kind, superseded_by_id, from_ts)",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
