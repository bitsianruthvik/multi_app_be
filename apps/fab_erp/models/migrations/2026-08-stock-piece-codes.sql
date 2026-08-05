-- 2026-08-stock-piece-codes.sql  (plan Phase 5b/5c)
--
-- The product spec asks for auto-coding on machines, plant areas, stock and
-- WIP. Machines (fab_resources.code) and plant areas (fab_stock_locations.code)
-- already had code columns and now get generated values from the mutate
-- controller. Stock had nothing to generate INTO: fab_stock_pieces carried
-- batch_no / heat_no / serial_no / mark_no but no identity of its own, so a
-- physical piece on the floor could not be named.
--
-- Deliberately NOT reusing the *_no columns as the identity. They are not
-- unique and must not be: one heat of steel becomes many plates, so several
-- pieces legitimately share a heat_no. Only a dedicated code is per-piece.
--
-- NULLable, because 200-odd pieces already exist with no code and there is no
-- honest value to backfill them with — a code invented today would claim a
-- traceability that was never recorded. Repeated NULLs are legal in a unique
-- index, so old rows coexist with new coded ones.
--
-- Idempotent: every step guarded on information_schema. Safe to re-run.

-- ── 1. fab_stock_pieces.code ────────────────────────────────────────────────
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_stock_pieces'
               AND COLUMN_NAME = 'code');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_stock_pieces ADD COLUMN code VARCHAR(40) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Soft-delete-aware, like fab_resources.code_active: a scrapped piece's code
-- must not reserve that string forever.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_stock_pieces'
               AND COLUMN_NAME = 'code_active');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_stock_pieces ADD COLUMN code_active VARCHAR(40) GENERATED ALWAYS AS (IF(deleted_at IS NULL, code, NULL)) VIRTUAL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_stock_pieces'
               AND INDEX_NAME = 'uq_fsp_company_code_active');
SET @sql = IF(@idx = 0,
  'ALTER TABLE fab_stock_pieces ADD UNIQUE KEY uq_fsp_company_code_active (company_id, code_active)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. fab_plants.code uniqueness ───────────────────────────────────────────
-- fab_plants was left out of the uniqueness sweep that covered resource types,
-- resources and the item taxonomy. Codes ARE generated for plants, but the edit
-- form can also type one, so a generated PLT-001 and a hand-typed PLT-001 could
-- sit side by side and every lookup by code would silently pick one at random.
-- Verified 0 duplicates before adding this.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_plants'
               AND COLUMN_NAME = 'code_active');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_plants ADD COLUMN code_active VARCHAR(100) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_plants'
               AND INDEX_NAME = 'uq_fpl_company_code_active');
SET @sql = IF(@idx = 0,
  'ALTER TABLE fab_plants ADD UNIQUE KEY uq_fpl_company_code_active (company_id, code_active)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 3. fab_stock_locations.code uniqueness ──────────────────────────────────
-- The existing uq_fab_stock_locations (company_id, plant_id, code) counts
-- soft-deleted rows, so deleting a location and recreating it with the same
-- code fails — and now that codes are generated, a tombstone would poison that
-- string permanently. Replaced with the soft-delete-aware form.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_stock_locations'
               AND COLUMN_NAME = 'code_active');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_stock_locations ADD COLUMN code_active VARCHAR(20) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_stock_locations'
               AND INDEX_NAME = 'uq_fsl_company_plant_code_active');
SET @sql = IF(@idx = 0,
  'ALTER TABLE fab_stock_locations ADD UNIQUE KEY uq_fsl_company_plant_code_active (company_id, plant_id, code_active)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_stock_locations'
               AND INDEX_NAME = 'uq_fab_stock_locations');
SET @sql = IF(@idx > 0,
  'ALTER TABLE fab_stock_locations DROP INDEX uq_fab_stock_locations',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
