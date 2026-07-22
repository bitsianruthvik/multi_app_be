-- fab_erp: Shop-Floor Time Intelligence (Phase 2) -- EU-6 schema migration
-- Applies the same CREATE TABLE IF NOT EXISTS statements appended to
-- ../init.sql. Safe to re-run (idempotent). Apply manually to prod TiDB:
--   mysql -h <host> -u <user> -p <db> < 2026-07-shopfloor-phase2.sql

-- ===== Shop-Floor Time Intelligence (Phase 2 — Buffers) =====
-- EU-6: buffers (per-resource input/output staging areas) + their live
-- contents + periodic level snapshots for capacity/overflow monitoring. All
-- three tables follow the established fab_erp convention: only company_id
-- gets a real FOREIGN KEY, every other cross-ref (resource_id,
-- stock_location_id, buffer_id, task_id, item_id) is a plain INT + KEY index
-- so a soft-deleted parent never blocks a write.

-- One row per input/output staging buffer on a resource. Uniqueness on
-- (resource_id, kind) must be soft-delete-aware, so it follows the same
-- generated-VIRTUAL-column idiom used by fab_operations/fab_resource_types/
-- fab_operation_flows (name_active/code_active): kind_active mirrors `kind`
-- while the row is live and goes NULL once deleted_at is set, which releases
-- the uniqueness constraint on soft delete (a NULL component makes MySQL
-- treat the row as distinct from all others in the index) — same mechanism
-- as pairing a real column (company_id) with a generated *_active column
-- there, applied here to the real resource_id column paired with the
-- generated kind_active column.
CREATE TABLE IF NOT EXISTS fab_buffers (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  company_id         INT           NOT NULL,
  resource_id        INT           NOT NULL,
  kind               ENUM('input','output') NOT NULL,
  stock_location_id  INT           NULL,
  capacity_value     DECIMAL(18,4) NULL,
  capacity_uom       VARCHAR(20)   NOT NULL DEFAULT 'kg',
  weight_metric_key  VARCHAR(100)  NOT NULL DEFAULT 'unit_weight_kg',
  warn_pct           TINYINT       NOT NULL DEFAULT 80,
  block_pct          TINYINT       NOT NULL DEFAULT 100,
  active             TINYINT(1)    NOT NULL DEFAULT 1,
  deleted_at         DATETIME      DEFAULT NULL,
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  kind_active        VARCHAR(10)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, kind, NULL)) VIRTUAL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE KEY uq_fb_resource_kind (resource_id, kind_active),
  KEY idx_fb_company_resource (company_id, resource_id)
);

-- Live (and historical) contents of a buffer: one row per item placed into
-- it. A row is "currently in the buffer" while moved_out_at IS NULL; once set,
-- the row becomes history rather than being deleted, so occupancy can be
-- reconstructed for any point in time.
CREATE TABLE IF NOT EXISTS fab_buffer_contents (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  company_id       INT           NOT NULL,
  buffer_id        INT           NOT NULL,
  task_id          INT           NULL,
  item_id          INT           NOT NULL,
  qty              DECIMAL(18,4) NULL,
  unit             VARCHAR(20)   NULL,
  computed_weight  DECIMAL(18,4) NULL,
  placed_at        DATETIME      NOT NULL,
  moved_out_at     DATETIME      NULL,
  deleted_at       DATETIME      DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fbc_company_buffer   (company_id, buffer_id),
  KEY idx_fbc_buffer_moved_out (buffer_id, moved_out_at),
  KEY idx_fbc_task             (task_id)
);

-- Periodic point-in-time snapshots of a buffer's load vs. capacity, written
-- by a backend job (not by users directly) to power buffer-level
-- capacity/overflow monitoring and history charts.
CREATE TABLE IF NOT EXISTS fab_buffer_level_snapshots (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  company_id      INT           NOT NULL,
  buffer_id       INT           NOT NULL,
  at              DATETIME      NOT NULL,
  load_value      DECIMAL(18,4) NULL,
  capacity_value  DECIMAL(18,4) NULL,
  pct             DECIMAL(6,2)  NULL,
  deleted_at      DATETIME      DEFAULT NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fbls_company_buffer_at (company_id, buffer_id, at)
);
