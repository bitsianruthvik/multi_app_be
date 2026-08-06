-- 2026-08-capacity-mode.sql
-- Per-company switch between calendar-derived and crew-derived machine capacity.
--
-- WHY THIS IS A SWITCH AND NOT A REWRITE
-- --------------------------------------
-- FAB_ERP_PEOPLE_PLAN.md §6 decided that people own the calendar and an unmanned
-- machine has ZERO capacity. Applied unconditionally that is unshippable: the
-- roster measured on 2026-08-06 was empty locally and covered 14 of 43 machines
-- in prod, so flipping every company at once would take most machines to zero
-- capacity, the scheduler would return nothing, and every project would lose its
-- finish date.
--
-- So the flip is per-company and explicit, defaulting to 'calendar' — i.e. every
-- existing company keeps behaving exactly as it does today until somebody builds
-- a roster and turns it on. POST /capacity-mode refuses to switch to 'crew'
-- while any machine with queued work still has nobody on it.
--
-- Idempotent: guarded on information_schema, safe to re-run.

CREATE TABLE IF NOT EXISTS fab_company_settings (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT NOT NULL,
  setting_key  VARCHAR(64)  NOT NULL,
  setting_value VARCHAR(255) NULL,
  updated_by   INT NULL,
  deleted_at   DATETIME NULL,
  created_at   TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fcs_company_key (company_id, setting_key)
);

-- No seed rows. A missing row reads as the default ('calendar'), which is what
-- makes this additive: no company changes behaviour until it is switched on
-- deliberately. Writing 'calendar' rows for everybody would be the same result
-- with more to go wrong.
