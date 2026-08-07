-- 2026-08-nest-grouping.sql
-- ---------------------------------------------------------------------------
-- Which parts come off the SAME piece of raw material.
--
-- Until now every part carried its own raw-material link, so a plate feeding
-- twenty parts was recorded as twenty unrelated "needs 20mm plate" rows. That
-- is not what nesting is. A nest is ONE physical plate with a set of parts laid
-- out on it, and the shop cuts it as a unit: the parts share the plate, share
-- its heat number, and become available together.
--
-- `nest_no` is that grouping. Rows sharing (order_id, catalog_item_id, nest_no)
-- are one plate. It is deliberately a plain label rather than a table:
--
--   * The gate and consumption paths are untouched. They still read the
--     per-part rows exactly as before, so nothing that is currently working in
--     production changes behaviour on the day this ships.
--   * What was missing was the ability to SAY "these twenty are one plate", and
--     a label says it.
--
-- Deliberately NOT solved here, because both change live material maths and
-- deserve their own decision:
--   * material requirement — still the sum of the per-part quantities, not
--     "one plate per nest";
--   * traceability — no link yet from a nest to the fab_stock_pieces row it was
--     actually cut from, so a part cannot yet name its heat number.
-- ---------------------------------------------------------------------------

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_items' AND COLUMN_NAME = 'nest_no');
SET @sql = IF(@col = 0, 'ALTER TABLE fab_items ADD COLUMN nest_no VARCHAR(40) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- The nesting view groups by (order, material, nest) — this is that lookup.
SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_items'
               AND INDEX_NAME = 'idx_fi_order_nest');
SET @sql = IF(@idx = 0,
  'ALTER TABLE fab_items ADD INDEX idx_fi_order_nest (order_id, catalog_item_id, nest_no)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
