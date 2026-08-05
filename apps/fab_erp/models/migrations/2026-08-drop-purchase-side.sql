-- 2026-08-drop-purchase-side.sql  (plan Phase 2a)
--
-- Remove purchase orders, suppliers and goods receipt. Material now enters
-- through POST /stock/receive, which records the piece, writes the ledger row,
-- and -- critically -- calls reevaluateStockGatedTasks() so tasks blocked
-- waiting for that material become eligible. postGrn() was the only other
-- caller of that function; the replacement was built and proven end to end
-- before this migration was written.
--
-- RUN THIS LAST. routes/search.js fans out into fab_suppliers and fab_grns
-- inside a Promise.all; dropping the tables before that code ships 500s the
-- entire command palette, not just those two result categories.
--
-- Idempotent: guarded on information_schema, safe to re-run.

-- ── columns on surviving tables ─────────────────────────────────────────────
-- fab_stock_pieces and fab_stock_ledger stay; they just stop pointing at a
-- receipt document. Verified before dropping: grn_id / grn_line_id were written
-- only by grnService and read only by GrnDetail and the ItemBatches "View GRN"
-- link, all of which are deleted in the same change.

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
          AND TABLE_NAME='fab_stock_pieces' AND COLUMN_NAME='grn_id');
SET @s = IF(@c>0, 'ALTER TABLE fab_stock_pieces DROP COLUMN grn_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
          AND TABLE_NAME='fab_stock_pieces' AND COLUMN_NAME='grn_line_id');
SET @s = IF(@c>0, 'ALTER TABLE fab_stock_pieces DROP COLUMN grn_line_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
          AND TABLE_NAME='fab_stock_ledger' AND COLUMN_NAME='supplier_id');
SET @s = IF(@c>0, 'ALTER TABLE fab_stock_ledger DROP COLUMN supplier_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
          AND TABLE_NAME='fab_stock_ledger' AND COLUMN_NAME='grn_id');
SET @s = IF(@c>0, 'ALTER TABLE fab_stock_ledger DROP COLUMN grn_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
          AND TABLE_NAME='fab_stock_ledger' AND COLUMN_NAME='grn_line_id');
SET @s = IF(@c>0, 'ALTER TABLE fab_stock_ledger DROP COLUMN grn_line_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
          AND TABLE_NAME='fab_orders' AND COLUMN_NAME='supplier_id');
SET @s = IF(@c>0, 'ALTER TABLE fab_orders DROP COLUMN supplier_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
          AND TABLE_NAME='fab_orders' AND COLUMN_NAME='supplier_ref');
SET @s = IF(@c>0, 'ALTER TABLE fab_orders DROP COLUMN supplier_ref', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── the tables ──────────────────────────────────────────────────────────────
-- No FK constraints exist on any of these (indexes only), so the drops cannot
-- fail on the 203 stock pieces that referenced them.

DROP TABLE IF EXISTS fab_grn_lines;
DROP TABLE IF EXISTS fab_grns;
DROP TABLE IF EXISTS fab_supplier_items;
DROP TABLE IF EXISTS fab_suppliers;

-- ── purchase orders themselves ──────────────────────────────────────────────
-- Order types collapse to 'sales' in Phase 2b, which also deletes the orphan
-- planned/manufacturing rows. Purchase orders are removed here because their
-- reason for existing -- a supplier to buy from -- has just gone.

DELETE FROM fab_order_lines WHERE order_id IN (SELECT id FROM fab_orders WHERE order_type = 'purchase');
DELETE FROM fab_orders WHERE order_type = 'purchase';
