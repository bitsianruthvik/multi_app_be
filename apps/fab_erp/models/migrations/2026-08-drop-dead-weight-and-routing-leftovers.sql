-- 2026-08-drop-dead-weight-and-routing-leftovers.sql
-- ---------------------------------------------------------------------------
-- DESTRUCTIVE. Drops schema that nothing in the codebase reads. Authorised on
-- the basis that production currently holds test data only.
--
-- Every item below was checked two ways before being listed: a search of all
-- 411 source files (schema/SQL excluded, since creating a column is not using
-- it) and a foreign-key check. Nothing here is referenced by either.
--
--   fab_operation_flow_step_outputs      whole table, 3 rows. Declared what a
--                                        flow step produces; no reader was ever
--                                        written. Step INPUTS are live and stay.
--   fab_item_catalog.unit_weight         the per-metre weight model, replaced
--   fab_item_catalog.weight_basis        by density_kg_m3 + section_area_mm2
--   fab_material_bom_items.              305 values, zero readers — a leftover
--     manufacturing_plant_id             of the dropped multi-plant BOM routing
--   fab_orders.parent_planned_order_id   MRP leftover; MRP was removed 2026-07-14
--
-- DELIBERATELY NOT DROPPED, having been checked and found live:
--   fab_buffers.kind_active              backs UNIQUE uq_fb_resource_kind
--   fab_mark_schemes.                    backs UNIQUE uq_fms_company_cat_active
--     item_category_id_active            — both are generated columns whose only
--                                        job is to make a soft-delete-aware
--                                        unique index work. Dropping them would
--                                        silently remove a constraint.
--   fab_nest_issues.issued_at            no reader yet, but it records when a
--                                        plate went to the floor. That is an
--                                        audit fact worth keeping even unread.
-- ---------------------------------------------------------------------------

SET foreign_key_checks = 0;

DROP TABLE IF EXISTS fab_operation_flow_step_outputs;

SET foreign_key_checks = 1;

-- ── retired per-metre weight model ──────────────────────────────────────────

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='unit_weight');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_catalog DROP COLUMN unit_weight','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='weight_basis');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_catalog DROP COLUMN weight_basis','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── routing / MRP leftovers ─────────────────────────────────────────────────

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_material_bom_items' AND COLUMN_NAME='manufacturing_plant_id');
SET @sql = IF(@col>0,'ALTER TABLE fab_material_bom_items DROP COLUMN manufacturing_plant_id','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_orders' AND COLUMN_NAME='parent_planned_order_id');
SET @sql = IF(@col>0,'ALTER TABLE fab_orders DROP COLUMN parent_planned_order_id','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
