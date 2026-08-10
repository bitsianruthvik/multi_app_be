-- 2026-08-boq-levels-and-rm-weight.sql
-- ---------------------------------------------------------------------------
-- Two changes, both taken straight from how the shop's real BOQ already works.
--
-- 1. WEIGHT IS CALCULATED, AND THE MATERIAL CARRIES THE FACTOR.
--
--    Their BOQ never types a part weight — it derives one, two ways:
--      plate   : thickness(mm) x length(mm) x width(mm) x 7.85 / 1e6   -> kg
--      section : 14.9 kg/m x length(mm) / 1000                         -> kg
--    7.85 is steel density in g/cc; 14.9 is an ISA 100x100x10's mass per metre.
--    Both live on the MATERIAL, not on the part, so they are stored here:
--      unit_weight  the number (7.85, or 14.9)
--      weight_basis which formula it feeds ('density' | 'per_metre')
--
--    `unit_weight` deliberately does NOT mean "the weight of one of these" —
--    that reading is what the old dropped gross_weight/net_weight columns meant,
--    and conflating them would silently produce weights out by orders of
--    magnitude. It is the factor the formula uses.
--
-- 2. A LINE ITEM HAS A TYPE.
--
--    Composite Girder, BowString, Tub Girder, Openweb Girder, PEB. It decides
--    what the structure wizard offers, and is worth recording regardless: a
--    PEB and a composite girder are not the same kind of job.
-- ---------------------------------------------------------------------------

-- ── fab_item_catalog: the weight factor ─────────────────────────────────────

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_item_catalog' AND COLUMN_NAME = 'unit_weight');
SET @sql = IF(@col = 0, 'ALTER TABLE fab_item_catalog ADD COLUMN unit_weight DECIMAL(18,6) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_item_catalog' AND COLUMN_NAME = 'weight_basis');
SET @sql = IF(@col = 0,
  "ALTER TABLE fab_item_catalog ADD COLUMN weight_basis VARCHAR(20) NOT NULL DEFAULT 'density'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- No heuristic backfill here. An earlier draft matched on name LIKE '%Plate%',
-- which also catches "Plate Girder" and "Fabricated Plate Girder" — finished
-- goods, not plate. A density factor on those would quietly produce a plausible
-- and wrong weight for anything given dimensions.
--
-- Factors are set per material, explicitly, in 2026-08-rm-weight-factors.sql.

-- Undo that earlier draft if it already ran anywhere: a made item is never
-- something a weight is derived from by thickness x length x width.
UPDATE fab_item_catalog
   SET unit_weight = NULL
 WHERE deleted_at IS NULL
   AND unit_weight IS NOT NULL
   AND procurement_type = 'make';

-- ── fab_order_lines: what kind of thing this line is ────────────────────────

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_order_lines' AND COLUMN_NAME = 'line_type');
SET @sql = IF(@col = 0, 'ALTER TABLE fab_order_lines ADD COLUMN line_type VARCHAR(40) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── fab_items: which level of the BOQ a row is ──────────────────────────────
-- Span / girder / segment / part. Derivable by counting parents, but stored so
-- the sheet can be written back out in the same shape it was read in, and so a
-- girder is still identifiable as a girder when a branch is ragged.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_items' AND COLUMN_NAME = 'level_kind');
SET @sql = IF(@col = 0, 'ALTER TABLE fab_items ADD COLUMN level_kind VARCHAR(20) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
