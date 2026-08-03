-- 2026-08-piece-marks.sql
-- Issue 2 (FAB_ERP_SHOPFLOOR_REALITY_PLAN.md): give every BOM row a piece mark.
--
-- Until now fab_items carried name / qty / parent_item_id and nothing a
-- fabricator could write on a piece of steel with a paint pen, find on a
-- drawing, and search for here. That is why shops keep their own numbering on
-- paper — and once they do, this system is describing a different universe from
-- the one the crew is working in.
--
-- Semantics that the schema has to enforce, and why:
--
--  * Unique per ORDER, not globally. 'B1' on this bridge and 'B1' on the next
--    are different pieces and nobody on site is confused. A global unique index
--    would be wrong and would force ugly synthetic marks.
--
--  * NULL is allowed and common. Marks are assigned by a generation pass or by
--    hand, not at insert time. MySQL/TiDB permit multiple NULLs in a UNIQUE
--    index, which is exactly the behaviour needed here.
--
--  * Identical pieces share ONE mark. Twelve identical stiffeners are all 'S3'
--    with qty 12 — you do not mint twelve marks. Mark is therefore per item
--    ROW (which already carries qty), not per physical unit.
--
--  * mark_prefix / mark_seq are kept alongside the rendered mark so a later
--    pass can continue a sequence without re-parsing strings. The rendered
--    `mark` stays the source of truth for display and search.
--
-- Idempotent: guarded on information_schema, safe to re-run.

-- ── fab_items.mark ──────────────────────────────────────────────────────────
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='mark');
SET @sql = IF(@col=0,
  "ALTER TABLE fab_items ADD COLUMN mark VARCHAR(40) NULL COMMENT 'Piece mark, unique per order (B1, B1-a). Frozen once assigned.'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='mark_prefix');
SET @sql = IF(@col=0,
  "ALTER TABLE fab_items ADD COLUMN mark_prefix VARCHAR(10) NULL",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='mark_seq');
SET @sql = IF(@col=0,
  "ALTER TABLE fab_items ADD COLUMN mark_seq INT NULL",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Unique per order. Deliberately NOT filtered on deleted_at: a soft-deleted
-- row's mark stays reserved, because the steel it named may physically exist.
-- Re-using a mark after deletion is exactly how physical traceability breaks.
SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items'
              AND INDEX_NAME='uq_fab_items_order_mark');
SET @sql = IF(@idx=0,
  "CREATE UNIQUE INDEX uq_fab_items_order_mark ON fab_items (order_id, mark)",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Lookup index for "find the piece marked B1" across a company.
SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items'
              AND INDEX_NAME='idx_fab_items_company_mark');
SET @sql = IF(@idx=0,
  "CREATE INDEX idx_fab_items_company_mark ON fab_items (company_id, mark)",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── Per-company mark scheme: item category → prefix ─────────────────────────
-- Which prefix a part gets is a company convention (B=beam, C=column, PL=plate)
-- and differs per fabricator, so it is data, not code.
CREATE TABLE IF NOT EXISTS fab_mark_schemes (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  company_id        INT          NOT NULL,
  item_category_id  INT          NULL,     -- NULL row = the fallback prefix
  prefix            VARCHAR(10)  NOT NULL,
  sort_order        INT          NOT NULL DEFAULT 0,
  deleted_at        DATETIME     NULL,
  created_at        TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fab_mark_schemes_company (company_id),
  UNIQUE KEY uq_fab_mark_schemes (company_id, item_category_id)
);
