-- 2026-08-mark-schemes-write-path.sql  (plan Phase 5a)
--
-- fab_mark_schemes has existed since the piece-marks migration but had no write
-- path at all — no resourceDef entry, no route, no helper — so loadScheme()
-- always read zero rows and every mark on every order fell back to the
-- hardcoded prefix 'P'. The engine was complete; nothing could feed it.
--
-- Giving it a write path means the generic mutate endpoint now deletes from it,
-- and that endpoint SOFT-deletes. The original unique key does not know about
-- deleted_at:
--
--   UNIQUE KEY uq_fab_mark_schemes (company_id, item_category_id)
--
-- so removing the scheme for a category and then adding it back collides with
-- the tombstone and surfaces as a 409 reading "A record with this name or code
-- already exists" — on a table that has neither a name nor a code.
--
-- Replaced with the same generated-column idiom the rest of this schema uses
-- for soft-delete-aware uniqueness (see fab_resources.code_active): a deleted
-- row's key value becomes NULL, and SQL permits repeated NULLs in a unique
-- index, so tombstones stop blocking reuse.
--
-- NOTE this index cannot enforce the "at most one fallback row" rule, and never
-- could: the fallback row is precisely the one with item_category_id = NULL,
-- and repeated NULLs are legal. That rule is enforced in the editor UI. Two
-- fallback rows would otherwise make loadScheme's result depend on row order.
--
-- Idempotent: guarded on information_schema, safe to re-run.

SET @has_gen = (SELECT COUNT(*) FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_mark_schemes'
                   AND COLUMN_NAME = 'item_category_id_active');
SET @sql = IF(@has_gen = 0,
  'ALTER TABLE fab_mark_schemes ADD COLUMN item_category_id_active INT GENERATED ALWAYS AS (IF(deleted_at IS NULL, item_category_id, NULL)) VIRTUAL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @old_idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_mark_schemes'
                   AND INDEX_NAME = 'uq_fab_mark_schemes');
SET @sql = IF(@old_idx > 0,
  'ALTER TABLE fab_mark_schemes DROP INDEX uq_fab_mark_schemes',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @new_idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_mark_schemes'
                   AND INDEX_NAME = 'uq_fms_company_cat_active');
SET @sql = IF(@new_idx = 0,
  'ALTER TABLE fab_mark_schemes ADD UNIQUE KEY uq_fms_company_cat_active (company_id, item_category_id_active)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
