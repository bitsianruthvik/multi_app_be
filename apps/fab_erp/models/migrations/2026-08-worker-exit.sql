-- 2026-08-worker-exit.sql
-- Leaving the firm is not a long absence.
--
-- `fab_workers.active` already existed, but as a bare flag it could not say WHEN
-- somebody left, and setting it did nothing to their open intervals. That left
-- two problems:
--
--   1. PHANTOM CREW. An open `assigned` interval never closed, so the machine
--      kept a crew member who had left — for `no_operator` attribution forever,
--      and (under capacity_mode='crew') for capacity too.
--   2. A PRESENT-TENSE FLAG FILTERING HISTORICAL QUERIES. crewIntervals and
--      crewCoverageGaps filtered `active = 1` while crewForWindow did not, so
--      the same person counted as crew for attribution but not for capacity.
--      Worse in principle: somebody who left in March WAS on that machine in
--      February, and "who was here last Tuesday" must still say so. Filtering
--      history by a current flag makes that question unanswerable.
--
-- The fix is to record the exit as an INSTANT and close the intervals at it —
-- the same splice every other write path uses. History then stays true on its
-- own, the present goes quiet because the intervals are closed rather than
-- filtered, and there is one rule instead of three. The `active = 1` filters are
-- removed in the same change.
--
-- Exit is reversible: somebody who rejoins is reactivated (exited_at cleared,
-- active back to 1). Their old intervals stay closed — that is the history of
-- the first stint, and the new one opens fresh rather than reopening the old.
--
-- Idempotent: guarded on information_schema, safe to re-run.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_workers'
              AND COLUMN_NAME  = 'exited_at');
SET @sql = IF(@col = 0,
  "ALTER TABLE fab_workers ADD COLUMN exited_at DATETIME NULL COMMENT 'When they left the firm. NULL = still here. Backdatable, because resignations are reported after the fact. Open intervals are closed at this instant.'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Any pre-existing deactivation predates the exit instant. Stamp one so the
-- column is never NULL-while-inactive, which would read as "still here" to
-- anything that trusts exited_at alone. updated_at is the closest thing to a
-- deactivation time that exists on these rows.
UPDATE fab_workers
   SET exited_at = COALESCE(updated_at, created_at)
 WHERE active = 0 AND exited_at IS NULL AND deleted_at IS NULL;

-- Close any open interval left behind by a deactivation that happened before
-- this migration — the phantom crew described above. Bounded to inactive
-- workers, so an active roster is untouched.
UPDATE fab_worker_assignments a
  JOIN fab_workers w ON w.id = a.worker_id
   SET a.to_ts = w.exited_at
 WHERE w.active = 0 AND w.exited_at IS NOT NULL AND w.deleted_at IS NULL
   AND a.kind = 'assigned' AND a.to_ts IS NULL
   AND a.deleted_at IS NULL AND a.superseded_by_id IS NULL;

UPDATE fab_worker_shifts s
  JOIN fab_workers w ON w.id = s.worker_id
   SET s.to_ts = w.exited_at
 WHERE w.active = 0 AND w.exited_at IS NOT NULL AND w.deleted_at IS NULL
   AND s.to_ts IS NULL
   AND s.deleted_at IS NULL AND s.superseded_by_id IS NULL;
