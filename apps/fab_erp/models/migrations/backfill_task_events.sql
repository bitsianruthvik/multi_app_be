-- backfill_task_events.sql
-- EU-2: One-time, idempotent backfill of fab_task_events from the existing
-- fab_project_tasks lifecycle timestamp columns. Safe to re-run: each event
-- type is only inserted for a task if that (task_id, event_type) pair does
-- not already exist in fab_task_events.
--
-- Scope: every non-deleted, non-cancelled fab_project_tasks row.
-- Source: 'system' for every synthesized row (per spec — not 'backfill',
-- since fab_task_events.source ENUM's 'backfill' value is reserved for a
-- separate historical-import use case; 'system' matches the other
-- machine-derived events written by taskGatingService).

INSERT INTO fab_task_events (company_id, task_id, event_type, at, source)
SELECT t.company_id, t.id, 'deps_cleared', t.deps_cleared_at, 'system'
FROM fab_project_tasks t
WHERE t.deleted_at IS NULL
  AND t.status <> 'cancelled'
  AND t.deps_cleared_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM fab_task_events e
    WHERE e.task_id = t.id AND e.event_type = 'deps_cleared'
  );

INSERT INTO fab_task_events (company_id, task_id, event_type, at, source)
SELECT t.company_id, t.id, 'queued', t.queued_at, 'system'
FROM fab_project_tasks t
WHERE t.deleted_at IS NULL
  AND t.status <> 'cancelled'
  AND t.queued_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM fab_task_events e
    WHERE e.task_id = t.id AND e.event_type = 'queued'
  );

INSERT INTO fab_task_events (company_id, task_id, event_type, at, source)
SELECT t.company_id, t.id, 'started', t.started_at, 'system'
FROM fab_project_tasks t
WHERE t.deleted_at IS NULL
  AND t.status <> 'cancelled'
  AND t.started_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM fab_task_events e
    WHERE e.task_id = t.id AND e.event_type = 'started'
  );

INSERT INTO fab_task_events (company_id, task_id, event_type, at, source)
SELECT t.company_id, t.id, 'paused', t.paused_at, 'system'
FROM fab_project_tasks t
WHERE t.deleted_at IS NULL
  AND t.status <> 'cancelled'
  AND t.paused_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM fab_task_events e
    WHERE e.task_id = t.id AND e.event_type = 'paused'
  );

INSERT INTO fab_task_events (company_id, task_id, event_type, at, source)
SELECT t.company_id, t.id, 'completed', t.completed_at, 'system'
FROM fab_project_tasks t
WHERE t.deleted_at IS NULL
  AND t.status <> 'cancelled'
  AND t.completed_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM fab_task_events e
    WHERE e.task_id = t.id AND e.event_type = 'completed'
  );
