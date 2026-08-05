-- 2026-08-projected-finish.sql
--
-- Separate the LIVE PROJECTION from the COMMITMENT on fab_cc_plans.
--
-- fab_cc_plans.committed_finish had three writers with three different formulas:
--
--   1. criticalChainService.buildBaseline  aggressive_finish + project_buffer
--   2. drumService.sequenceProjects        drum_start + chain_length + project_buffer
--   3. ccBufferService.recomputeForOrder   NOW + remaining work + remaining buffer
--
-- (1) and (2) are a proper pipeline: the baseline sets the commitment, the drum
-- refines it once the project is sequenced against the constraint. Both are
-- statements about what the shop has committed to.
--
-- (3) is a different kind of number entirely -- a live projection measured from
-- the current clock. It runs on a 15-minute sweep and on every task start/stop,
-- so it continuously overwrote whatever (1) and (2) had committed to. Whichever
-- wrote last won, and the value oscillated between two materially different
-- dates. CriticalChain.tsx renders committed_finish against due_date as
-- "finishing after promised" -- a commitment vs a promise -- so a projection
-- sliding forward with the clock made that comparison meaningless.
--
-- committed_finish now belongs to the baseline and the drum. The projection gets
-- its own column, so both survive and neither clobbers the other.
--
-- Idempotent: guarded on information_schema, safe to re-run.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_cc_plans'
              AND COLUMN_NAME  = 'projected_finish');
SET @sql = IF(@col = 0,
  "ALTER TABLE fab_cc_plans ADD COLUMN projected_finish DATETIME NULL COMMENT 'Live projection from now; written by ccBufferService. Not the commitment -- see committed_finish.'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Seed the new column from the existing value so no plan reads empty on first
-- load. Whatever is in committed_finish right now was most likely last written
-- by the projection anyway, given how often it ran.
UPDATE fab_cc_plans
   SET projected_finish = committed_finish
 WHERE projected_finish IS NULL
   AND committed_finish IS NOT NULL;
