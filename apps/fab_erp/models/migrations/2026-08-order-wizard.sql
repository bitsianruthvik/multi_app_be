-- 2026-08-order-wizard.sql
-- ---------------------------------------------------------------------------
-- The sales order becomes one resumable wizard: lines → BOM → nesting → flows
-- → project tree → confirm.
--
-- Three things change in the data model.
--
-- 1. A LINE IS NO LONGER A CATALOG ITEM. The item catalog holds raw materials
--    and consumables; nobody is going to add "42m span composite girder" to it,
--    because every job is one-off and it would be a catalog of one. A line is
--    now free text: a code the user types, a structure type, and a quantity.
--    catalog_item_id had no foreign key, so this is a clean drop.
--
-- 2. DATES AND PLANT LIVE ON THE ORDER ONLY. A line carrying its own requested
--    date and target plant invited two answers to one question, and the order's
--    answer is the one anybody acts on.
--
-- 3. A LINE OWNS ITS BOQ SUBTREE, via fab_items.order_line_id. Line progress
--    used to find its items by matching catalog_item_id — which cannot survive
--    (1) — so the link becomes explicit.
--
-- Also drops bom_id and routing_plan_id: both survive only as names in
-- resourceDef.json, referenced by no query and no screen, left behind when
-- routing plans were removed on 2026-08-05.
--
-- Idempotent throughout (information_schema guards), so a re-run is a no-op.
-- ---------------------------------------------------------------------------

-- ── fab_order_lines: free-text identity ─────────────────────────────────────

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_order_lines' AND COLUMN_NAME='code');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_order_lines ADD COLUMN code VARCHAR(60) NULL AFTER line_no',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_order_lines' AND COLUMN_NAME='description');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_order_lines ADD COLUMN description VARCHAR(255) NULL AFTER code',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Carry across whatever the existing test rows pointed at, so the 6 live lines
-- still read as something rather than turning into blank rows.
UPDATE fab_order_lines fol
   JOIN fab_item_catalog fic ON fic.id = fol.catalog_item_id
    SET fol.code = COALESCE(NULLIF(fol.code, ''), fic.code),
        fol.description = COALESCE(NULLIF(fol.description, ''), fic.name)
 WHERE fol.code IS NULL OR fol.code = '';

-- ── drop what a line no longer decides ──────────────────────────────────────

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_order_lines' AND COLUMN_NAME='catalog_item_id');
SET @sql = IF(@col=1, 'ALTER TABLE fab_order_lines DROP COLUMN catalog_item_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_order_lines' AND COLUMN_NAME='target_plant_id');
SET @sql = IF(@col=1, 'ALTER TABLE fab_order_lines DROP COLUMN target_plant_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_order_lines' AND COLUMN_NAME='requested_date');
SET @sql = IF(@col=1, 'ALTER TABLE fab_order_lines DROP COLUMN requested_date', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_order_lines' AND COLUMN_NAME='bom_id');
SET @sql = IF(@col=1, 'ALTER TABLE fab_order_lines DROP COLUMN bom_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_order_lines' AND COLUMN_NAME='routing_plan_id');
SET @sql = IF(@col=1, 'ALTER TABLE fab_order_lines DROP COLUMN routing_plan_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── a line owns its BOQ subtree ─────────────────────────────────────────────

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='order_line_id');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_items ADD COLUMN order_line_id INT NULL AFTER order_id',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND INDEX_NAME='idx_fi_order_line');
SET @sql = IF(@idx=0,
  'ALTER TABLE fab_items ADD KEY idx_fi_order_line (order_line_id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── the order remembers where the wizard got to ─────────────────────────────
-- Persisted rather than held in the browser: the whole point is that you can
-- close it, go home, and have a colleague pick it up on another machine.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_orders' AND COLUMN_NAME='wizard_step');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_orders ADD COLUMN wizard_step VARCHAR(20) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── retire ready_to_plan ────────────────────────────────────────────────────
-- Added earlier the same day to mark "preparation done, planner can build
-- tasks". The wizard now owns that meaning and shows it far better, and
-- confirmation moved to the end of the wizard — so nothing sets this any more.
-- Any row still carrying it is put back to draft, which is what it now means:
-- in the wizard, not yet confirmed.

UPDATE fab_orders SET status = 'draft' WHERE status = 'ready_to_plan';
