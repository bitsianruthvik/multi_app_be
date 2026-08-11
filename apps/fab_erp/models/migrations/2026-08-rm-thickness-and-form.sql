-- 2026-08-rm-thickness-and-form.sql
-- ---------------------------------------------------------------------------
-- Raw material gets a shape the system can reason about.
--
-- Thickness already existed on every RM item — as a CUSTOM FIELD whose value is
-- the free text "20 mm". That was fine while it was documentation. It is not
-- fine now that it decides which materials a part is allowed to be cut from: a
-- dropdown driven by string matching returns an empty list the first time
-- somebody types "20mm", and gives no clue why.
--
--   thickness_mm    DECIMAL  — the cross-section dimension a plate is chosen by
--   material_form   VARCHAR  — 'plate' | 'section' | NULL
--
-- material_form exists because thickness alone is a WRONG filter. An ISA
-- 100×100×10 angle records a thickness of 10, so a 10mm plate part would be
-- offered an angle as a valid choice. For a section the whole profile IS the
-- item; thickness is a property of it, not the thing you select on. So plate
-- parts filter by thickness among plates, and sections are chosen directly.
--
-- Length and width deliberately do NOT go here. A plate item is "20mm plate" —
-- the 12000×2500 is a property of the piece that turned up, not of the item, and
-- one item legitimately has pieces of many sizes. They go on fab_stock_pieces.
--
-- Idempotent throughout; re-running is a no-op.
-- ---------------------------------------------------------------------------

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='thickness_mm');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_item_catalog ADD COLUMN thickness_mm DECIMAL(10,3) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='material_form');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_item_catalog ADD COLUMN material_form VARCHAR(20) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Filtering happens per (company, form, thickness) on every BOM row.
SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND INDEX_NAME='idx_fic_form_thickness');
SET @sql = IF(@idx=0,
  'ALTER TABLE fab_item_catalog ADD KEY idx_fic_form_thickness (company_id, material_form, thickness_mm)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── backfill from the custom fields that already hold this ─────────────────
-- "20 mm" / "20mm" / "20" all yield 20. Anything with no leading number is left
-- NULL rather than guessed at: a material with no thickness simply does not
-- appear in a thickness-filtered list, which is the safe failure.

UPDATE fab_item_catalog fic
  JOIN fab_custom_fields cf
    ON cf.level = 'item' AND cf.level_id = fic.id AND cf.company_id = fic.company_id
   AND cf.field_key IN ('Thickness', 'Thickness (mm)', 'Thickness mm') AND cf.deleted_at IS NULL
   SET fic.thickness_mm = CAST(TRIM(cf.field_value) AS DECIMAL(10,3))
 WHERE fic.thickness_mm IS NULL
   AND TRIM(cf.field_value) REGEXP '^[0-9]+(\\.[0-9]+)?';

-- Form, from the Material Type custom field. Plate is anything calling itself a
-- plate or sheet; the rolled sections are listed by their Indian-standard
-- prefixes (ISA angle, ISMB/ISMC beam and channel, and the generic words).
UPDATE fab_item_catalog fic
  JOIN fab_custom_fields cf
    ON cf.level = 'item' AND cf.level_id = fic.id AND cf.company_id = fic.company_id
   AND cf.field_key = 'Material Type' AND cf.deleted_at IS NULL
   SET fic.material_form = CASE
     WHEN LOWER(cf.field_value) REGEXP 'plate|sheet|flat'          THEN 'plate'
     WHEN LOWER(cf.field_value) REGEXP 'isa|ismb|ismc|isnb|angle|channel|beam|section|pipe|tube|rod|bar' THEN 'section'
     ELSE NULL END
 WHERE fic.material_form IS NULL;

-- Sections by their own name, BEFORE the plate fallback. Without this an
-- unclassified ISA 100x100x10 keeps material_form NULL, and NULL is treated as
-- plate by the picker — so it would be offered to every 10mm plate part, which
-- is the precise mistake material_form exists to stop. Prod spells Material
-- Type differently from local, so the name is the more reliable signal.
UPDATE fab_item_catalog
   SET material_form = 'section'
 WHERE material_form IS NULL AND procurement_type = 'buy'
   AND LOWER(name) REGEXP 'isa |isa[0-9]|ismb|ismc|isnb|angle|channel|beam|joist|pipe|tube|^isa';

-- Anything still unclassified but clearly a plate by its own name.
UPDATE fab_item_catalog
   SET material_form = 'plate'
 WHERE material_form IS NULL AND procurement_type = 'buy'
   AND LOWER(name) REGEXP 'plate|sheet';

-- ── batch-level dimensions ────────────────────────────────────────────────
-- A 20mm plate item covers pieces of many sizes, so the size belongs to the
-- piece. Nesting does not read these yet — it still takes a typed plate size —
-- but recording them at stock-in is what will later let a nest be drawn from an
-- identified piece rather than a described one.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_pieces' AND COLUMN_NAME='length_mm');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_stock_pieces ADD COLUMN length_mm DECIMAL(12,3) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_pieces' AND COLUMN_NAME='width_mm');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_stock_pieces ADD COLUMN width_mm DECIMAL(12,3) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
