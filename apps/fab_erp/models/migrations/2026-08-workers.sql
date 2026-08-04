-- 2026-08-workers.sql
-- People on the floor: roster, and assignment as intervals.
-- See FAB_ERP_PEOPLE_PLAN.md for the reasoning; the short version is below.
--
-- WHAT WAS WRONG
-- --------------
-- `fab_resource_operators` was one table doing two jobs, with `absent_on DATE`
-- overloaded as the discriminator:
--     absent_on IS NULL  → a standing assignment
--     absent_on = a date → absent that whole date
--
-- That shape cannot express any of the four things a real shop floor does:
--   * assign somebody to a machine at all (no UI ever existed — rows appeared
--     only via SQL)
--   * move someone to another machine after lunch (assignment has no time
--     dimension: it is standing, or it does not exist)
--   * let someone leave an hour early (absence is a DATE — all day or nothing;
--     this is also why taskAttributionService's no_operator rule can only look
--     at "full dates where every standing operator is absent")
--   * represent a contract welder from an agency (user_id points at `users`,
--     so a vendor would need a login seat, an invite, and a deprovision)
--
-- Additive only. `fab_resource_operators` is left completely untouched and
-- keeps working; nothing is dropped in the same deploy that adds these tables.
--
-- Idempotent: guarded on information_schema, safe to re-run.

-- ── The floor roster is NOT the login roster ────────────────────────────────
-- The whole fix is that `user_id` is NULLABLE. The people who touch machines
-- and the people who log in are overlapping sets, not the same set, and
-- conflating them is exactly what made vendor labour unrepresentable.
CREATE TABLE IF NOT EXISTS fab_workers (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT NOT NULL,
  name         VARCHAR(255) NOT NULL,
  code         VARCHAR(64)  NULL,          -- badge / what's written on paper
  worker_type  ENUM('employee','contractor','vendor') NOT NULL DEFAULT 'employee',
  user_id      INT          NULL,          -- a login, only if they have one
  vendor_name  VARCHAR(255) NULL,          -- which agency supplied them
  phone        VARCHAR(50)  NULL,
  active       TINYINT(1)   NOT NULL DEFAULT 1,
  deleted_at   DATETIME     NULL,
  created_at   TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fab_workers_company (company_id, active),
  KEY idx_fab_workers_user (user_id)
);

-- ── Assignment and absence as INTERVALS, not flags ──────────────────────────
-- Same idiom `fab_resource_events` already uses for machine state: a timeline
-- of intervals rather than a boolean. Every case collapses into one shape —
--   standing assignment  assigned, from_ts = start date,  to_ts NULL
--   moved at 13:00       close the first, open a second on the new machine
--   left an hour early   away, 16:00 → 17:00, reason 'permission'
--   full day off         away covering the shift, reason 'leave'
--   vendor for a week    assigned, from_ts Mon, to_ts Fri
--
-- `to_ts NULL` means open-ended: still assigned, or still away.
CREATE TABLE IF NOT EXISTS fab_worker_assignments (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT NOT NULL,
  worker_id    INT NOT NULL,
  resource_id  INT NULL,                   -- NULL for an 'away' not tied to a machine
  kind         ENUM('assigned','away') NOT NULL DEFAULT 'assigned',
  from_ts      DATETIME NOT NULL,
  to_ts        DATETIME NULL,
  reason       VARCHAR(64)  NULL,          -- leave / permission / sick / training / reassigned
  note         VARCHAR(400) NULL,
  entered_by   INT NULL,
  deleted_at   DATETIME NULL,
  created_at   TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fwa_company (company_id),
  KEY idx_fwa_worker (worker_id, from_ts),
  KEY idx_fwa_resource (resource_id, kind, from_ts)
);

-- NOTE ON WHAT IS DELIBERATELY ABSENT HERE:
-- there is no worker_id on fab_task_wait_segments, and there is no per-person
-- break/lunch table. Idle time is attributed to the MACHINE's timeline as a
-- cause ('no_operator'), never to a named person, and a lunch break is a
-- property of the shift (fab_shifts.working_minutes vs start/end), not
-- something each person self-reports. The moment a schema can answer "how many
-- minutes was this person responsible for", it creates an incentive to falsify
-- — and because those events share a stream with production timing, the lie
-- would flow into fab_operation_stats and quietly corrupt every future
-- estimate. See FAB_ERP_PEOPLE_PLAN.md §0.

-- ── Backfill: one worker per existing operator ──────────────────────────────
-- Existing rows keep working either way (nothing reads these tables yet), but
-- seeding them means the new screens open with the real crew already in place
-- rather than empty, which is the difference between a feature people adopt and
-- one they have to populate by hand first.
INSERT INTO fab_workers (company_id, name, worker_type, user_id, active)
SELECT DISTINCT o.company_id, COALESCE(u.name, CONCAT('User #', o.user_id)), 'employee', o.user_id, 1
  FROM fab_resource_operators o
  LEFT JOIN users u ON u.id = o.user_id
 WHERE o.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM fab_workers w
      WHERE w.company_id = o.company_id AND w.user_id = o.user_id AND w.deleted_at IS NULL
   );

-- Standing assignments (absent_on IS NULL) → open-ended 'assigned' intervals.
INSERT INTO fab_worker_assignments (company_id, worker_id, resource_id, kind, from_ts, to_ts, note)
SELECT o.company_id, w.id, o.resource_id, 'assigned',
       COALESCE(o.created_at, '2020-01-01 00:00:00'), NULL,
       'migrated from fab_resource_operators'
  FROM fab_resource_operators o
  JOIN fab_workers w ON w.company_id = o.company_id AND w.user_id = o.user_id AND w.deleted_at IS NULL
 WHERE o.deleted_at IS NULL AND o.absent_on IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM fab_worker_assignments a
      WHERE a.company_id = o.company_id AND a.worker_id = w.id
        AND a.resource_id = o.resource_id AND a.kind = 'assigned' AND a.deleted_at IS NULL
   );

-- Whole-day absences → 'away' intervals spanning that date, preserving the old
-- all-day semantics exactly (midnight to midnight) rather than inventing times.
INSERT INTO fab_worker_assignments (company_id, worker_id, resource_id, kind, from_ts, to_ts, reason, note)
SELECT o.company_id, w.id, o.resource_id, 'away',
       TIMESTAMP(o.absent_on), TIMESTAMP(DATE_ADD(o.absent_on, INTERVAL 1 DAY)),
       'leave', 'migrated from fab_resource_operators'
  FROM fab_resource_operators o
  JOIN fab_workers w ON w.company_id = o.company_id AND w.user_id = o.user_id AND w.deleted_at IS NULL
 WHERE o.deleted_at IS NULL AND o.absent_on IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM fab_worker_assignments a
      WHERE a.company_id = o.company_id AND a.worker_id = w.id
        AND a.kind = 'away' AND a.from_ts = TIMESTAMP(o.absent_on) AND a.deleted_at IS NULL
   );
