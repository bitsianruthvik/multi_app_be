-- 2026-08-drop-dead-tables.sql  (plan Phase 2e)
--
-- Drop four tables that no code in any app reads or writes.
--
-- Verified across multi_app_be/apps/** and multi_app_fe/src/** under BOTH naming
-- schemes -- the raw table name in SQL, and the fabErpX resource name the generic
-- query API addresses tables by. That double check matters: an earlier draft of
-- this plan nearly dropped fab_calendar_days, which has zero rows and zero
-- table-name references but is queried live as `fabErpCalendarDay` by
-- ShiftCalendars.tsx.
--
--   fab_so_items          1 row   superseded by fab_order_lines
--   fab_sales_orders      2 rows  superseded by fab_orders
--   fab_schedule_entries  6 rows  superseded by fab_project_tasks
--   fab_scheduler_runs    5 rows  superseded by fab_project_tasks
--
-- ORDER MATTERS, and not only for the usual child-before-parent reason:
-- fab_schedule_entries holds a live RESTRICT foreign key onto fab_orders. It is
-- referenced by no code, but it will block the orphan-order deletion in Phase 2b.
-- Dropping it here removes a whole step from that chain. Run this migration
-- BEFORE deleting any orders.
--
-- Idempotent: DROP TABLE IF EXISTS, safe to re-run.
-- No live fab_erp table holds a foreign key INTO any of these, so
-- foreign_key_checks does not need disabling.

DROP TABLE IF EXISTS fab_so_items;
DROP TABLE IF EXISTS fab_sales_orders;
DROP TABLE IF EXISTS fab_schedule_entries;
DROP TABLE IF EXISTS fab_scheduler_runs;
