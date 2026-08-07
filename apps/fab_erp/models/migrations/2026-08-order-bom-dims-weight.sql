-- 2026-08-order-bom-dims-weight.sql
-- ---------------------------------------------------------------------------
-- Dimensions + weight as first-class columns on fab_items.
--
-- Why columns and not fab_custom_fields: length/width were being written to
-- fab_custom_fields with level='item', level_id=fab_items.id, while the Item
-- Catalog writes level='item', level_id=fab_item_catalog.id. Two different ID
-- spaces sharing one key — catalog item #42 and order item #42 collide. Rather
-- than add height and weight into that collision, dimensions move onto the row
-- they describe. The legacy custom-field rows are backfilled below and then
-- left alone (harmless; nothing reads them after this migration).
--
-- Weight model (three columns, one rule):
--   unit_weight           manually entered weight of ONE of this item. NULL =
--                         not entered. Only ever set by a human.
--   computed_unit_weight  Σ over children of (child.qty × child effective unit
--                         weight). NULL when the row has no weighed children.
--                         Only ever set by itemWeightService.
--   total_weight          (unit_weight ?? computed_unit_weight) × qty — what
--                         this row contributes to its parent. Stored so that
--                         reports and the order total are a plain SUM.
--
-- Keeping entered and computed apart is what lets the UI show "you typed 420 kg,
-- the parts add up to 397 kg" instead of silently overwriting one with the other.
-- A fabricated assembly legitimately weighs more than its parts (welds, bolts,
-- paint), so the entered value wins — but the gap stays visible.
-- ---------------------------------------------------------------------------

-- ── fab_items: dimensions ───────────────────────────────────────────────────

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='length');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN `length` DECIMAL(18,6) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='width');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN width DECIMAL(18,6) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='height');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN height DECIMAL(18,6) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='dim_unit');
SET @sql = IF(@col=0,"ALTER TABLE fab_items ADD COLUMN dim_unit VARCHAR(10) NOT NULL DEFAULT 'mm'",'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── fab_items: weight ───────────────────────────────────────────────────────

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='unit_weight');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN unit_weight DECIMAL(18,6) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='computed_unit_weight');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN computed_unit_weight DECIMAL(18,6) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='total_weight');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN total_weight DECIMAL(18,6) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='weight_unit');
SET @sql = IF(@col=0,"ALTER TABLE fab_items ADD COLUMN weight_unit VARCHAR(10) NOT NULL DEFAULT 'kg'",'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── backfill length/width from the legacy custom-field rows ─────────────────
-- Scoped by an EXISTS against fab_items on the SAME company, so a catalog-item
-- custom field whose level_id happens to collide with a fab_items id in ANOTHER
-- company can never leak across the tenant boundary. Within one company the two
-- ID spaces can still collide — that is exactly the bug this migration ends —
-- so only rows whose value parses as a number are copied, and only where the
-- column is still NULL (never overwrite something already migrated).

UPDATE fab_items fi
  JOIN fab_custom_fields cf
    ON cf.level = 'item'
   AND cf.level_id = fi.id
   AND cf.company_id = fi.company_id
   AND cf.field_key = 'length'
   AND cf.deleted_at IS NULL
   SET fi.length = CAST(cf.field_value AS DECIMAL(18,6))
 WHERE fi.deleted_at IS NULL
   AND fi.length IS NULL
   AND cf.field_value REGEXP '^[0-9]+(\\.[0-9]+)?$';

UPDATE fab_items fi
  JOIN fab_custom_fields cf
    ON cf.level = 'item'
   AND cf.level_id = fi.id
   AND cf.company_id = fi.company_id
   AND cf.field_key = 'width'
   AND cf.deleted_at IS NULL
   SET fi.width = CAST(cf.field_value AS DECIMAL(18,6))
 WHERE fi.deleted_at IS NULL
   AND fi.width IS NULL
   AND cf.field_value REGEXP '^[0-9]+(\\.[0-9]+)?$';

-- ── index for the roll-up walk ──────────────────────────────────────────────
-- itemWeightService loads one order's whole tree in a single query.
SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND INDEX_NAME='idx_fi_order_parent');
SET @sql = IF(@idx=0,'ALTER TABLE fab_items ADD INDEX idx_fi_order_parent (order_id, parent_item_id)','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
