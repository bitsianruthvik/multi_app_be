-- fab_erp: Shop-Floor Time Intelligence (Phase 4 — Learned Durations) -- EU-15 schema migration
-- Applies the same guarded ALTER appended to ../init.sql. Safe to re-run
-- (idempotent via the information_schema existence check). Apply manually to
-- prod TiDB:
--   mysql -h <host> -u <user> -p <db> < 2026-08-shopfloor-phase4-formula-hours.sql

-- ===== fab_project_tasks.formula_hours (EU-15, 2026-08) =====
-- EU-15 seeds computed_hours from a learned p80 stat (operationStatsService.
-- getUsableStat) at materialization time when one is usable for the task's
-- (operation_id, resource_type_id), which overwrites the formula-derived
-- estimate that used to live in computed_hours. formula_hours preserves that
-- original formula value so it's never lost. Guarded ALTER since
-- fab_project_tasks predates this column in already-provisioned databases —
-- same idiom as the fab_orders.customer_id gap fix in init.sql
-- (information_schema existence check + PREPARE/EXECUTE).
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_project_tasks' AND COLUMN_NAME='formula_hours');
SET @sql = IF(@col=0,'ALTER TABLE fab_project_tasks ADD COLUMN formula_hours DECIMAL(10,2) NULL AFTER computed_hours','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
