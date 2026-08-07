-- 2026-08-order-item-codes.sql
-- ---------------------------------------------------------------------------
-- A generated identity code for every row of an order's item tree.
--
-- Shape:  <CUSTOMER>-<ORDER NUMBER>-<ABBR>-<ABBR>-…
--   e.g.  BRDG-SO-20260722-0001-GRDRA-TOPFLNG-PLT20
--
-- This is the long descriptive code for drawings, reports and paperwork. It is
-- deliberately NOT the piece mark — a mark gets painted on steel with a pen and
-- has to stay short (B1, B1-a, B1-a-i), which `fab_items.mark` already handles.
-- The two identify the same row for different audiences and neither can do the
-- other's job, so they live side by side.
--
-- Codes are frozen once issued: generation only ever fills blanks. By the time
-- a code exists it is on a drawing, and renaming the item must not move it.
-- That is also why `code` is server-issued and absent from writeFields — the
-- same rule fab_customers.code and fab_stock_pieces.code already follow.
--
-- code_active mirrors the established soft-delete-aware pattern (see
-- fab_resources / fab_stock_pieces): a deleted row's code stops occupying the
-- unique index, so the string can be reissued rather than reserved forever.
-- ---------------------------------------------------------------------------

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_items' AND COLUMN_NAME = 'code');
SET @sql = IF(@col = 0, 'ALTER TABLE fab_items ADD COLUMN code VARCHAR(160) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_items' AND COLUMN_NAME = 'code_active');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_items ADD COLUMN code_active VARCHAR(160) GENERATED ALWAYS AS (IF(deleted_at IS NULL, code, NULL)) VIRTUAL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_items'
               AND INDEX_NAME = 'uq_fi_company_code_active');
SET @sql = IF(@idx = 0,
  'ALTER TABLE fab_items ADD UNIQUE KEY uq_fi_company_code_active (company_id, code_active)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
