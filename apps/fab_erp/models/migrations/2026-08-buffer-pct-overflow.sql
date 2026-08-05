-- 2026-08-buffer-pct-overflow.sql  (plan Phase 7 — machine/CC analytics)
--
-- fab_cc_plans.buffer_consumed_pct is a TINYINT, so it saturates at 127.
--
-- Buffer consumption is not a percentage of a whole — it is burn against the
-- project buffer, and it exceeds 100% precisely when a project is in the
-- trouble the fever chart exists to show. Four baselined plans in production
-- were storing 127 while their real consumption was 339%, 201%, 227% and 134%.
-- Every genuinely late project looked identically late, and the one at 339%
-- was indistinguishable from the one at 134%.
--
-- Widened to SMALLINT. chain_complete_pct stays TINYINT: it is a true 0-100
-- proportion and cannot overflow.
--
-- The same overflow applies to fab_cc_buffer_snapshots' copy of the value,
-- which feeds the fever-chart trend line.
--
-- Idempotent: guarded on the current column type. Safe to re-run.

SET @t = (SELECT DATA_TYPE FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_cc_plans'
             AND COLUMN_NAME = 'buffer_consumed_pct');
SET @sql = IF(@t = 'tinyint',
  'ALTER TABLE fab_cc_plans MODIFY COLUMN buffer_consumed_pct SMALLINT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @t = (SELECT DATA_TYPE FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_cc_buffer_snapshots'
             AND COLUMN_NAME = 'buffer_consumed_pct');
SET @sql = IF(@t = 'tinyint',
  'ALTER TABLE fab_cc_buffer_snapshots MODIFY COLUMN buffer_consumed_pct SMALLINT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
