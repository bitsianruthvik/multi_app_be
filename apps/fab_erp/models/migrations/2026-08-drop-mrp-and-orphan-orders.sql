-- 2026-08-drop-mrp-and-orphan-orders.sql  (plan Phase 2b)
--
-- Remove MRP, and the 20 orders that only existed because of it or of order
-- types the app no longer has.
--
-- MRP was a headless nightly cron: no HTTP route, no resourceDef entry, no
-- screen. Three of its five exports had no callers at all. It ran every 60
-- seconds and, on its scheduled minute, DELETEd and re-INSERTed rows in
-- fab_orders and fab_order_lines unattended.
--
-- The orphans it leaves behind:
--   16 planned orders      order_type='planned', MRP's own output
--    4 manufacturing orders order_type='manufacturing'
--
-- (The 11 purchase orders went with Phase 2a, when suppliers were removed.)
--
-- DELETION ORDER. All surviving FKs are RESTRICT and there is no CASCADE
-- anywhere in fab_*, so children go first. Only THREE real constraints exist in
-- this schema -- verified against information_schema rather than assumed:
--   fab_item_metric_values.item_id -> fab_items
--   fab_items.parent_item_id       -> fab_items   (self)
--   fab_order_lines.order_id       -> fab_orders
-- The conditional fab_items_order_fk is NOT present in this environment.
--
-- The chain is shorter than originally planned because earlier phases already
-- dropped three of its steps: fab_schedule_entries (2e -- it held a live
-- RESTRICT FK onto fab_orders despite no code using it, which is exactly why it
-- was dropped first), fab_stock_reservations and fab_task_batches (2d).
--
-- fab_stock_pieces is NULLed, not deleted: those rows are physical stock that
-- happens to reference a WIP item on a doomed order. The steel does not stop
-- existing because the order does.
--
-- Idempotent: every statement is scoped by a subquery on the surviving parent,
-- so re-running finds nothing.

SET @doomed := 'planned,manufacturing';

-- ── critical chain ──────────────────────────────────────────────────────────
DELETE FROM fab_cc_buffer_snapshots WHERE plan_id IN (
  SELECT id FROM fab_cc_plans WHERE order_id IN (
    SELECT id FROM fab_orders WHERE FIND_IN_SET(order_type, @doomed)));

DELETE FROM fab_cc_chain_tasks WHERE plan_id IN (
  SELECT id FROM fab_cc_plans WHERE order_id IN (
    SELECT id FROM fab_orders WHERE FIND_IN_SET(order_type, @doomed)));

DELETE FROM fab_cc_buffers WHERE plan_id IN (
  SELECT id FROM fab_cc_plans WHERE order_id IN (
    SELECT id FROM fab_orders WHERE FIND_IN_SET(order_type, @doomed)));

DELETE FROM fab_cc_drum_slots WHERE order_id IN (
  SELECT id FROM fab_orders WHERE FIND_IN_SET(order_type, @doomed));

DELETE FROM fab_cc_plans WHERE order_id IN (
  SELECT id FROM fab_orders WHERE FIND_IN_SET(order_type, @doomed));

-- ── task children ───────────────────────────────────────────────────────────
DELETE FROM fab_task_events WHERE task_id IN (
  SELECT id FROM fab_project_tasks WHERE order_id IN (
    SELECT id FROM fab_orders WHERE FIND_IN_SET(order_type, @doomed)));

DELETE FROM fab_task_wait_segments WHERE task_id IN (
  SELECT id FROM fab_project_tasks WHERE order_id IN (
    SELECT id FROM fab_orders WHERE FIND_IN_SET(order_type, @doomed)));

DELETE FROM fab_task_inputs WHERE task_id IN (
  SELECT id FROM fab_project_tasks WHERE order_id IN (
    SELECT id FROM fab_orders WHERE FIND_IN_SET(order_type, @doomed)));

-- fab_buffer_contents rows for these tasks were deleted here when this
-- migration first ran. The statement is retired rather than kept, because
-- 2026-08-drop-buffer-contents.sql sorts BEFORE this file by filename and drops
-- the table outright — so on a clean in-order replay this DELETE would hit a
-- table that no longer exists and abort the migration midway.
--   was: DELETE FROM fab_buffer_contents WHERE task_id IN (...doomed tasks...);

-- ── item children (hard FK) ─────────────────────────────────────────────────
DELETE FROM fab_item_metric_values WHERE item_id IN (
  SELECT id FROM fab_items WHERE order_id IN (
    SELECT id FROM fab_orders WHERE FIND_IN_SET(order_type, @doomed)));

-- Physical stock: detach, never delete.
UPDATE fab_stock_pieces SET wip_item_id = NULL WHERE wip_item_id IN (
  SELECT id FROM fab_items WHERE order_id IN (
    SELECT id FROM fab_orders WHERE FIND_IN_SET(order_type, @doomed)));

-- ── the order tree ──────────────────────────────────────────────────────────
DELETE FROM fab_project_tasks WHERE order_id IN (
  SELECT id FROM fab_orders WHERE FIND_IN_SET(order_type, @doomed));

-- One statement: fab_items.parent_item_id is a self-FK, so parents and children
-- must go together or the delete fails on its own siblings.
DELETE FROM fab_items WHERE order_id IN (
  SELECT id FROM fab_orders WHERE FIND_IN_SET(order_type, @doomed));

DELETE FROM fab_order_lines WHERE order_id IN (
  SELECT id FROM fab_orders WHERE FIND_IN_SET(order_type, @doomed));

-- Unprotected back-references: no FK guards these, so a surviving order could
-- be left pointing at a deleted one.
UPDATE fab_orders SET parent_order_id = NULL WHERE parent_order_id IN (
  SELECT id FROM (SELECT id FROM fab_orders WHERE FIND_IN_SET(order_type, @doomed)) x);
UPDATE fab_orders SET source_order_id = NULL WHERE source_order_id IN (
  SELECT id FROM (SELECT id FROM fab_orders WHERE FIND_IN_SET(order_type, @doomed)) x);
UPDATE fab_orders SET parent_planned_order_id = NULL WHERE parent_planned_order_id IN (
  SELECT id FROM (SELECT id FROM fab_orders WHERE FIND_IN_SET(order_type, @doomed)) x);

DELETE FROM fab_orders WHERE FIND_IN_SET(order_type, @doomed);

-- ── MRP's own tables ────────────────────────────────────────────────────────
DROP TABLE IF EXISTS fab_mrp_runs;
DROP TABLE IF EXISTS fab_mrp_settings;
