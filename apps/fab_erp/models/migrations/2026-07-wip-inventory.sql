-- 2026-07-23 — WIP inventory (BUG-01/02/07)
-- Ties a work-in-process / produced stock piece to its fab_items BOM-instance
-- node, so a single WIP piece can be located as it moves machine→machine through
-- an operation flow and finalized (wip→in_stock) at the terminal step.
-- Idempotent — safe to re-run. Per-machine WIP areas and the Finished-Goods
-- location are auto-provisioned lazily by wipInventoryService at run time, so no
-- data seed is needed here.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_stock_pieces' AND COLUMN_NAME = 'wip_item_id');
SET @sql = IF(@col = 0, 'ALTER TABLE fab_stock_pieces ADD COLUMN wip_item_id INT NULL AFTER notes', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_stock_pieces' AND INDEX_NAME = 'idx_fsp_wip');
SET @sql = IF(@idx = 0, 'ALTER TABLE fab_stock_pieces ADD KEY idx_fsp_wip (company_id, wip_item_id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
