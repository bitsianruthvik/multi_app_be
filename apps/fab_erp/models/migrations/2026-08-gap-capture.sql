-- 2026-08-gap-capture.sql
-- Explaining time that has no derivable cause.
--
-- `unexplained_idle` is, by construction, the case worth chasing: the residual
-- after no_shift / machine_down / no_operator / machine_busy have been carved
-- out — machine there, person there, material there, and nothing happened.
--
-- Detection already worked; the loop did not close. POST /reconciliation/resolve
-- demanded a reason and then wrote a state_note, because
-- fab_task_wait_segments is MATERIALISED by the attribution engine and has no
-- override column — anything written there is destroyed on the next recompute.
-- So the same stall could be explained daily and the number never moved, which
-- teaches people the form is decorative. A form believed to be decorative stops
-- being filled in honestly, and these streams are shared, so that belief
-- contaminates the production timing everything else is estimated from.
--
-- The fix is NOT an override column. It is the shape machine_down already uses:
-- a supervisor explains a gap by writing an EVENT, and attribution derives the
-- cause from it. Nothing overrides the engine; the engine is given more to work
-- with, and stays the single writer of its own table.
--
-- THREE SCOPES, because that is what makes capture cheap:
--   site    weather stops an entire outdoor yard — one row, not one per machine
--   machine breakdown, maintenance (fab_resource_events, already exists)
--   task    an inspection or drawing hold follows the JOB, wherever it sits
--
-- Idempotent: guarded on information_schema, safe to re-run.

-- ── 1. New wait reasons ────────────────────────────────────────────────────
-- Additive to the ENUM; existing rows are untouched.
--
-- `other_explained` is deliberately distinct from `unexplained_idle`. "We know
-- what this was and it fits no code" must not collapse into "nobody looked at
-- it", or the residual stops meaning anything and the metric that drives the
-- whole exercise goes quiet.
SET @cur = (SELECT COLUMN_TYPE FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'fab_task_wait_segments' AND COLUMN_NAME = 'reason');
SET @sql = IF(@cur IS NOT NULL AND @cur NOT LIKE '%waiting_inspection%',
  "ALTER TABLE fab_task_wait_segments MODIFY COLUMN reason ENUM('waiting_predecessors','waiting_materials','no_shift','machine_down','no_operator','machine_busy','output_blocked','unexplained_idle','waiting_inspection','weather','drawing_hold','other_explained') NOT NULL",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. Task-scoped holds ───────────────────────────────────────────────────
-- The job is stopped for something external to the shop.
--
-- `party` earns its place: waiting on the CLIENT's inspector and waiting on our
-- own QC have different escalation paths, and a delay you can prove was the
-- client's is commercially different from one that was yours. `reference` is the
-- inspection call-off or drawing revision number — the thing you quote when
-- arguing about it later.
CREATE TABLE IF NOT EXISTS fab_task_holds (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  company_id       INT NOT NULL,
  task_id          INT NOT NULL,
  hold_code        VARCHAR(40) NOT NULL,   -- validated against fab_gap_reasons
  from_ts          DATETIME NOT NULL,
  to_ts            DATETIME NULL,          -- NULL = still held
  party            VARCHAR(120) NULL,
  reference        VARCHAR(120) NULL,
  note             VARCHAR(400) NULL,
  source           ENUM('live','backfill','system') NOT NULL DEFAULT 'live',
  entered_by       INT NULL,
  superseded_by_id INT NULL,
  deleted_at       DATETIME NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fth_task    (task_id, from_ts),
  KEY idx_fth_company (company_id, from_ts)
);

-- ── 3. Site-scoped stoppages ───────────────────────────────────────────────
-- One row covers every machine at that plant for that span. Rain stopping an
-- outdoor yard is ONE action here and nine on the machine stream; that
-- difference is the whole reason the scope exists.
CREATE TABLE IF NOT EXISTS fab_plant_events (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  company_id       INT NOT NULL,
  plant_id         INT NOT NULL,
  event_code       VARCHAR(40) NOT NULL,   -- validated against fab_gap_reasons
  from_ts          DATETIME NOT NULL,
  to_ts            DATETIME NULL,
  note             VARCHAR(400) NULL,
  source           ENUM('live','backfill','system') NOT NULL DEFAULT 'live',
  entered_by       INT NULL,
  superseded_by_id INT NULL,
  deleted_at       DATETIME NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fpe_plant   (plant_id, from_ts),
  KEY idx_fpe_company (company_id, from_ts)
);

-- ── 4. The reason catalogue ────────────────────────────────────────────────
-- Company-specific ADDITIONS and overrides. A built-in list lives in
-- services/gapReasons.js; this table is empty by default and only holds what a
-- site adds ("waiting for crane", "gas cylinder empty") or hides. Same pattern
-- as fab_resource_downtime_reasons — configurable without a deploy.
--
-- `wait_reason` is the crucial column: it says which fab_task_wait_segments
-- reason this code produces, so a site can add its own vocabulary without
-- inventing a new attribution category the engine knows nothing about.
CREATE TABLE IF NOT EXISTS fab_gap_reasons (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT NOT NULL,
  scope        ENUM('site','machine','task') NOT NULL,
  code         VARCHAR(40)  NOT NULL,
  label        VARCHAR(120) NOT NULL,
  wait_reason  VARCHAR(40)  NOT NULL,
  sort_order   INT NOT NULL DEFAULT 100,
  active       TINYINT(1) NOT NULL DEFAULT 1,
  deleted_at   DATETIME NULL,
  created_at   TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fgr_company_code (company_id, code),
  KEY idx_fgr_company (company_id, active)
);
