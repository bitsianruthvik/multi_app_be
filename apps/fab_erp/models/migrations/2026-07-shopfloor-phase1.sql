-- fab_erp: Shop-Floor Time Intelligence (Phase 1) -- EU-1 schema migration
-- Applies the same CREATE TABLE IF NOT EXISTS statements appended to
-- ../init.sql. Safe to re-run (idempotent). Apply manually to prod TiDB:
--   mysql -h <host> -u <user> -p <db> < 2026-07-shopfloor-phase1.sql

-- ===== Shop-Floor Time Intelligence (Phase 1) =====
-- EU-1: event tables + operator assignment. Append-only event logs feed the
-- (not-yet-built) wait-attribution engine; fab_task_wait_segments is the
-- computed/materialized output of that engine, written by a backend job, not
-- by users directly. All five tables follow the established fab_erp
-- convention: only company_id gets a real FOREIGN KEY, every other cross-ref
-- (task_id, resource_id, entered_by, user_id, superseded_by_event_id) is a
-- plain INT + KEY index so a soft-deleted parent never blocks a write.

-- Append-only log of task lifecycle events (deps cleared, materials ready,
-- queued, started, paused, resumed, completed, cancelled, or a free-text
-- state_note). source distinguishes events entered live on the shop floor
-- from backfilled/system-generated ones. superseded_by_event_id lets a
-- correction event point at the event it replaces without deleting history.
CREATE TABLE IF NOT EXISTS fab_task_events (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  company_id              INT           NOT NULL,
  task_id                 INT           NOT NULL,
  event_type              ENUM('deps_cleared','materials_ready','queued','started','paused','resumed','completed','cancelled','state_note') NOT NULL,
  at                      DATETIME      NOT NULL,
  source                  ENUM('live','backfill','system') NOT NULL DEFAULT 'live',
  entered_by              INT           NULL,
  note                    VARCHAR(500)  NULL,
  superseded_by_event_id  INT           NULL,
  deleted_at              DATETIME      DEFAULT NULL,
  created_at              TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fte_company_task_at (company_id, task_id, at),
  KEY idx_fte_task_type        (task_id, event_type)
);

-- Append-only log of resource (machine) state changes: running/idle/down/off,
-- with an optional reason_code (see fab_resource_downtime_reasons). Same
-- source/entered_by/note/superseded_by_event_id pattern as fab_task_events.
CREATE TABLE IF NOT EXISTS fab_resource_events (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  company_id              INT           NOT NULL,
  resource_id             INT           NOT NULL,
  state                   ENUM('running','idle','down','off') NOT NULL,
  reason_code             VARCHAR(50)   NULL,
  at                      DATETIME      NOT NULL,
  source                  ENUM('live','backfill','system') NOT NULL DEFAULT 'live',
  entered_by              INT           NULL,
  note                    VARCHAR(500)  NULL,
  superseded_by_event_id  INT           NULL,
  deleted_at              DATETIME      DEFAULT NULL,
  created_at              TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fre_company_resource_at (company_id, resource_id, at)
);

-- Per-company configurable downtime reason codes, picked from when logging a
-- fab_resource_events 'down' state. Deliberately NOT seeded with any rows
-- here (or anywhere in init.sql) — when a company has zero rows in this
-- table, the API layer falls back to the built-in default reason list:
-- breakdown, maintenance, no_operator, no_power, other.
CREATE TABLE IF NOT EXISTS fab_resource_downtime_reasons (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  company_id  INT           NOT NULL,
  code        VARCHAR(50)   NOT NULL,
  label       VARCHAR(255)  NOT NULL,
  active      TINYINT(1)    NOT NULL DEFAULT 1,
  deleted_at  DATETIME      DEFAULT NULL,
  created_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_frdr_company (company_id)
);

-- Operator-to-resource assignment. A row with absent_on IS NULL is a standing
-- assignment (this user normally operates this resource); a row with
-- absent_on set marks that specific operator absent on that date (used by
-- the wait-attribution engine to explain no_operator idle time). The unique
-- key relies on MySQL treating NULLs as distinct values in a unique index —
-- multiple standing-assignment rows (absent_on NULL) for the same
-- resource_id/user_id pair are not blocked by this key, which is acceptable
-- here since a standing assignment is naturally a single row per pair in
-- practice.
CREATE TABLE IF NOT EXISTS fab_resource_operators (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  resource_id  INT           NOT NULL,
  user_id      INT           NOT NULL,
  is_primary   TINYINT(1)    NOT NULL DEFAULT 0,
  absent_on    DATE          NULL,
  deleted_at   DATETIME      DEFAULT NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE KEY uq_fro_resource_user_absent (resource_id, user_id, absent_on),
  KEY idx_fro_company_resource (company_id, resource_id)
);

-- Computed/materialized wait-time segments for a task, classified by reason
-- (waiting on predecessors, materials, shift, a down/busy machine, an absent
-- operator, blocked output, or unexplained idle time). Written by the
-- wait-attribution engine (a later unit), not by users — computed_at records
-- when the engine last (re)computed this segment.
CREATE TABLE IF NOT EXISTS fab_task_wait_segments (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  company_id       INT           NOT NULL,
  task_id          INT           NOT NULL,
  reason           ENUM('waiting_predecessors','waiting_materials','no_shift','machine_down','no_operator','machine_busy','output_blocked','unexplained_idle') NOT NULL,
  seg_start        DATETIME      NOT NULL,
  seg_end          DATETIME      NOT NULL,
  working_minutes  INT           NOT NULL DEFAULT 0,
  computed_at      DATETIME      NULL,
  deleted_at       DATETIME      DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_ftws_company_task   (company_id, task_id),
  KEY idx_ftws_company_reason (company_id, reason)
);
