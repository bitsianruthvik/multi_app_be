-- 2026-08-plant-timezone.sql
-- The factory's clock, as distinct from the server's.
--
-- WHAT WAS WRONG
-- --------------
-- `fab_shifts.start_time` holds what is written on the board — "the day shift
-- runs 08:00 to 17:00". The calendar walk built that as
-- `new Date('<date>T08:00:00Z')`, i.e. it read the floor's wall clock as UTC.
--
-- On a UTC server with a UTC factory that is harmless, which is why nobody
-- noticed. Prod runs on Render + TiDB (both UTC) while the plant is in India, so
-- a shift the floor means as 08:00–17:00 IST was evaluated as 08:00–17:00 UTC =
-- 13:30–22:30 IST. Everything derived from it inherited that 5½-hour error:
-- `no_shift` attribution, the Shift Log coverage meter, and — once a company is
-- switched to `capacity_mode = 'crew'` — the scheduling calendar itself.
--
-- The zone belongs to the PLANT, not the server and not the company: a company
-- can run sites in different zones, and a shift means what it means at the site
-- where people physically turn up.
--
-- Resolution order at read time (services/plantTime.js):
--   the calendar's plant's `timezone`
--     → `fab_company_settings.timezone` (company default)
--       → 'UTC'
--
-- UTC is the last resort rather than the server's own zone on purpose: falling
-- back to the host would make identical data mean different things on a laptop
-- and on Render, which is the whole class of bug this removes.
--
-- BACKWARD COMPATIBLE. A NULL `timezone` with no company default resolves to
-- UTC, which is exactly the behaviour before this change — so nothing moves
-- until a plant is actually given a zone.
--
-- Idempotent: guarded on information_schema, safe to re-run.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_plants'
              AND COLUMN_NAME  = 'timezone');
SET @sql = IF(@col = 0,
  "ALTER TABLE fab_plants ADD COLUMN timezone VARCHAR(64) NULL COMMENT 'IANA zone (e.g. Asia/Kolkata) the shift times at this site are written in. NULL = company default, else UTC.'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- No seed. Setting a zone changes what every existing shift MEANS, so it is a
-- deliberate per-site decision, not something a migration should guess — and
-- guessing wrong would silently move every historical attribution number.
