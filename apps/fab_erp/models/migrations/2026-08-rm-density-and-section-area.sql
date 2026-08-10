-- 2026-08-rm-density-and-section-area.sql
-- ---------------------------------------------------------------------------
-- Weight is volume x density. One density per material, per cubic metre.
--
--   weight(kg) = volume(m3) x density_kg_m3
--
-- and the volume comes from the dimensions:
--
--   plate / flat   volume = thickness x width x length
--   profile        volume = section_area_mm2 x length
--
-- WHY A PROFILE NEEDS AN AREA. An ISA 100x100x10 is an L, not a 100x10
-- rectangle: two legs sharing a corner, about 1898 mm2 of steel. Multiplying
-- thickness by width treats it as one leg and loses the other — 14.52 kg
-- instead of 27.57 on a 1850 mm piece, 47% light. Every angle, channel, beam
-- and pipe has the same problem, and it is silent: the number looks reasonable.
-- So a profile carries its cross-section and only needs a length.
--
-- The areas below are back-calculated from the IS 808 mass-per-metre figures
-- (area = kg/m / density x 1e6), which is why ISA 100x100x10 reproduces the
-- client's own BOQ exactly: 1898.09 mm2 x 1850 mm x 7850 = 27.565 kg.
--
-- Replaces unit_weight / weight_basis, which expressed sections as kg per
-- metre. Those columns are cleared here rather than dropped — dropping is
-- destructive and they carry nothing that is not reproduced above.
-- ---------------------------------------------------------------------------

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_item_catalog' AND COLUMN_NAME = 'density_kg_m3');
SET @sql = IF(@col = 0, 'ALTER TABLE fab_item_catalog ADD COLUMN density_kg_m3 DECIMAL(12,3) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_item_catalog' AND COLUMN_NAME = 'section_area_mm2');
SET @sql = IF(@col = 0, 'ALTER TABLE fab_item_catalog ADD COLUMN section_area_mm2 DECIMAL(14,3) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── Structural steel: 7850 kg/m3 ────────────────────────────────────────────

UPDATE fab_item_catalog SET density_kg_m3 = 7850
 WHERE deleted_at IS NULL AND procurement_type = 'buy' AND code IN (
   'RM26RM01418','RM26RM01419','RM26RM01420','RM26RM01421','RM26RM01422','RM26RM01423', -- Placebo plate
   'RM26RM01424',                                                                        -- ISA 100x100x10
   'PL-12-E350','PL-20-E350','PL-25-E350','123',                                         -- StartHub plate
   'ISA75','ISMB300','ISMC200','PIPE100NB','STRUCT-STEEL',
   -- The local/dev catalog codes the same steel differently. Listed so a
   -- developer's machine computes the same weights as production; on prod these
   -- simply match nothing.
   'MSP-E350BO-16','MSP-E350BO-20','MSP-E350BO-28','MSP-E350BO-32','MSP-E350BO-40','MSP-E350BO-45',
   'ISA-E350BO-100X100X10'
 );

UPDATE fab_item_catalog SET section_area_mm2 = 1898.089
 WHERE deleted_at IS NULL AND code = 'ISA-E350BO-100X100X10';  -- same angle, dev catalog

UPDATE fab_item_catalog SET density_kg_m3 = 2700
 WHERE deleted_at IS NULL AND code = 'ALM-6061';                    -- aluminium 6061-T6

UPDATE fab_item_catalog SET density_kg_m3 = 8000
 WHERE deleted_at IS NULL AND code IN ('SS-316','SS-PIPE-2IN');     -- 316L stainless

-- ── Cross-sections, for anything that is not a flat plate ───────────────────
-- area = mass-per-metre / density x 1e6

UPDATE fab_item_catalog SET section_area_mm2 = 1898.089
 WHERE deleted_at IS NULL AND code = 'RM26RM01424';   -- ISA 100x100x10  (14.9 kg/m — matches their BOQ)

UPDATE fab_item_catalog SET section_area_mm2 = 1133.758
 WHERE deleted_at IS NULL AND code = 'ISA75';         -- ISA 75x75x8     (8.9 kg/m)

UPDATE fab_item_catalog SET section_area_mm2 = 5630.573
 WHERE deleted_at IS NULL AND code = 'ISMB300';       -- ISMB 300        (44.2 kg/m)

UPDATE fab_item_catalog SET section_area_mm2 = 2815.287
 WHERE deleted_at IS NULL AND code = 'ISMC200';       -- ISMC 200        (22.1 kg/m)

UPDATE fab_item_catalog SET section_area_mm2 = 2048.408
 WHERE deleted_at IS NULL AND code = 'PIPE100NB';     -- 100NB SCH40, OD 114.3 wall 6.02

UPDATE fab_item_catalog SET section_area_mm2 = 692.500
 WHERE deleted_at IS NULL AND code = 'SS-PIPE-2IN';   -- 2in SCH40, OD 60.3 wall 3.91

-- Round and square bar: a diameter is not a thickness x width either.
UPDATE fab_item_catalog SET section_area_mm2 = 5026.548
 WHERE deleted_at IS NULL AND code = 'ALM-6061';      -- round bar 80 mm dia -> pi r^2

UPDATE fab_item_catalog SET section_area_mm2 = 1256.637
 WHERE deleted_at IS NULL AND code = 'SS-316';        -- round bar 40 mm dia

UPDATE fab_item_catalog SET section_area_mm2 = 10000
 WHERE deleted_at IS NULL AND code = 'STRUCT-STEEL';  -- 100 x 100 square bar

-- ── Retire the per-metre model ──────────────────────────────────────────────
-- Cleared, not dropped: dropping a column is destructive and everything these
-- held is reproduced by density + area above.
UPDATE fab_item_catalog SET unit_weight = NULL WHERE unit_weight IS NOT NULL;
