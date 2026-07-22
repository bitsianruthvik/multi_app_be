-- fab_erp: Shop-Floor Time Intelligence (Phase 4 — Learned Durations) -- EU-14 schema migration
-- Applies the same CREATE TABLE IF NOT EXISTS statement appended to
-- ../init.sql. Safe to re-run (idempotent). Apply manually to prod TiDB:
--   mysql -h <host> -u <user> -p <db> < 2026-08-shopfloor-phase4.sql

-- ===== Shop-Floor Time Intelligence (Phase 4 — Learned Durations) =====
-- EU-14: rolling per-(operation, resource_type) duration stats, computed
-- nightly by operationStatsService.recomputeAllCompanies() from completed
-- fab_project_tasks' touch time (see fab_task_events). Read by EU-15 to seed
-- estimated durations for not-yet-run tasks of the same operation/resource
-- type. Written exclusively by the backend job — never by users directly.
--
-- Uniqueness on (company_id, operation_id, resource_type_id) needs to be
-- soft-delete-aware AND resource_type_id may legitimately be NULL (an
-- operation with no resource-type breakdown). Mirroring the established
-- generated-column idiom (fab_buffers.kind_active etc.) verbatim doesn't
-- work here because MySQL/TiDB treat every NULL in a unique index as
-- distinct from every other NULL — a plain UNIQUE (company_id, operation_id,
-- resource_type_id) would let the nightly job insert a fresh row each run
-- for any group with a NULL resource_type_id instead of updating the
-- existing one. Fix: resource_type_key COALESCEs NULL resource_type_id to
-- the sentinel 0 (real resource_type_id values are AUTO_INCREMENT and never
-- 0) *and* goes NULL once deleted_at is set, same soft-delete-release
-- mechanism as name_active/kind_active elsewhere in this file. That keeps
-- "no resource type" a single group per (company, operation) while still
-- releasing the key on soft delete.
CREATE TABLE IF NOT EXISTS fab_operation_stats (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  company_id         INT           NOT NULL,
  operation_id       INT           NOT NULL,
  resource_type_id   INT           NULL,
  sample_count       INT           NOT NULL DEFAULT 0,
  median_minutes     DECIMAL(10,2) NULL,
  p80_minutes        DECIMAL(10,2) NULL,
  ewma_minutes       DECIMAL(10,2) NULL,
  deleted_at         DATETIME      DEFAULT NULL,
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  resource_type_key  INT           GENERATED ALWAYS AS (IF(deleted_at IS NULL, COALESCE(resource_type_id, 0), NULL)) VIRTUAL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE KEY uq_fos_company_op_restype (company_id, operation_id, resource_type_key),
  KEY idx_fos_company   (company_id),
  KEY idx_fos_operation (operation_id)
);
