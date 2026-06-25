-- Per-node parallel scheduling: add node_id to fab_schedule_tasks
-- Run once against sqldb. After running, re-generate all schedules.

ALTER TABLE fab_schedule_tasks
  ADD COLUMN node_id INT NULL AFTER node_prefix,
  ADD INDEX idx_fab_sched_node (plan_id, node_id);
