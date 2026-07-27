-- fab_erp: Critical Chain time-buffer module -- EU-1 schema migration
-- Applies the same CREATE TABLE IF NOT EXISTS statements appended to
-- ../init.sql. Safe to re-run (idempotent). Apply manually to prod TiDB:
--   mysql -h <host> -u <user> -p <db> < 2026-07-critical-chain.sql

-- ===== Critical Chain (EU-1, 2026-07) =====
-- Read-only schema for the fab_erp Critical Chain time-buffer module: one
-- frozen baseline plan per order, its chain tasks and project/feeding
-- buffers, periodic buffer-consumption snapshots, and the company's single
-- drum (constraint resource) with its planned slots. Same convention as the
-- rest of fab_erp: only company_id gets a real FOREIGN KEY, every other
-- cross-reference (order_id, task_id, plan_id, buffer_id, drum_id,
-- resource_type_id, resource_id, feeds_task_id/after_task_id) is a plain
-- INT + KEY index so a soft-deleted parent never blocks a write. Writes go
-- through a dedicated route in a later EU — these tables are read-only via
-- the generic query API (see resourceDef.json, writeFields: []).

CREATE TABLE IF NOT EXISTS fab_cc_plans (
  id                       INT AUTO_INCREMENT PRIMARY KEY,
  company_id               INT           NOT NULL,
  order_id                 INT           NOT NULL,
  status                   ENUM('draft','baselined','superseded','archived') NOT NULL DEFAULT 'draft',
  due_date                 DATETIME      NULL,
  chain_length_minutes     INT           NULL,
  project_buffer_minutes   INT           NULL,
  aggressive_finish        DATETIME      NULL,
  committed_finish         DATETIME      NULL,
  fever_zone               ENUM('green','yellow','red') NULL,
  buffer_consumed_pct      TINYINT       NULL,
  chain_complete_pct       TINYINT       NULL,
  drum_planned_start       DATETIME      NULL,
  baselined_at             DATETIME      NULL,
  superseded_by_plan_id    INT           NULL,
  deleted_at               DATETIME      DEFAULT NULL,
  created_at               TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fccp_company_order  (company_id, order_id),
  KEY idx_fccp_company_status (company_id, status)
);

CREATE TABLE IF NOT EXISTS fab_cc_chain_tasks (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  company_id          INT           NOT NULL,
  plan_id             INT           NOT NULL,
  task_id             INT           NOT NULL,
  seq                 INT           NOT NULL,
  chain_role          ENUM('critical','feeding') NOT NULL,
  feeding_group_id    INT           NULL,
  aggressive_minutes  INT           NOT NULL,
  planned_start       DATETIME      NULL,
  planned_end         DATETIME      NULL,
  deleted_at          DATETIME      DEFAULT NULL,
  created_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fcct_company_plan (company_id, plan_id),
  KEY idx_fcct_company_task (company_id, task_id)
);

CREATE TABLE IF NOT EXISTS fab_cc_buffers (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  company_id         INT           NOT NULL,
  plan_id            INT           NOT NULL,
  kind               ENUM('project','feeding') NOT NULL,
  size_minutes       INT           NOT NULL,
  consumed_minutes   INT           NOT NULL DEFAULT 0,
  feeds_task_id      INT           NULL,
  after_task_id      INT           NULL,
  warn_pct           TINYINT       NOT NULL DEFAULT 33,
  act_pct            TINYINT       NOT NULL DEFAULT 67,
  deleted_at         DATETIME      DEFAULT NULL,
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fccb_company_plan (company_id, plan_id)
);

CREATE TABLE IF NOT EXISTS fab_cc_buffer_snapshots (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  company_id            INT           NOT NULL,
  plan_id               INT           NOT NULL,
  buffer_id             INT           NOT NULL,
  at                    DATETIME      NOT NULL,
  chain_complete_pct    TINYINT       NOT NULL,
  buffer_consumed_pct   TINYINT       NOT NULL,
  zone                  ENUM('green','yellow','red') NOT NULL,
  deleted_at            DATETIME      DEFAULT NULL,
  created_at            TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fccbs_company_plan_at (company_id, plan_id, at)
);

-- One active row per company (enforced at the application layer, not by a
-- DB constraint — matches the plain company_id KEY called for in the EU-1
-- spec rather than inventing a uniqueness idiom it didn't ask for).
CREATE TABLE IF NOT EXISTS fab_cc_drum (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  company_id         INT           NOT NULL,
  resource_type_id   INT           NOT NULL,
  resource_id        INT           NULL,
  load_minutes       INT           NULL,
  method             ENUM('auto') NOT NULL DEFAULT 'auto',
  computed_at        DATETIME      NULL,
  deleted_at         DATETIME      DEFAULT NULL,
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fccd_company (company_id)
);

CREATE TABLE IF NOT EXISTS fab_cc_drum_slots (
  id                        INT AUTO_INCREMENT PRIMARY KEY,
  company_id                INT           NOT NULL,
  drum_id                   INT           NOT NULL,
  order_id                  INT           NOT NULL,
  plan_id                   INT           NOT NULL,
  seq                       INT           NOT NULL,
  planned_start             DATETIME      NULL,
  planned_end               DATETIME      NULL,
  capacity_buffer_minutes   INT           NOT NULL DEFAULT 0,
  is_committed              TINYINT(1)    NOT NULL DEFAULT 0,
  deleted_at                DATETIME      DEFAULT NULL,
  created_at                TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fccds_company_drum_seq (company_id, drum_id, seq)
);
