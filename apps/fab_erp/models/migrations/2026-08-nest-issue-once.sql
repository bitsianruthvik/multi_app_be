-- 2026-08-nest-issue-once.sql
-- ---------------------------------------------------------------------------
-- A nested plate is issued from stock ONCE, not once per part cut from it.
--
-- Until now every part on a nest issued material independently at its first
-- operation, so a plate carrying twenty parts was drawn from stock twenty
-- times. The shop takes ONE plate to the machine and cuts everything out of it;
-- the stock ledger has to say the same thing or the numbers drift every job.
--
-- This table is the record of "that plate has already gone to the floor". The
-- first task to start on a nest inserts a row and consumes; every later part on
-- the same nest finds the row and consumes nothing. The UNIQUE key is what makes
-- that safe under concurrent starts — two operators hitting Start at the same
-- second cannot both win, because the second INSERT is rejected by the index
-- rather than by a check that has already gone stale.
--
-- Scope: only links that carry a nest_no. A raw-material link with nest_no NULL
-- keeps the exact per-part behaviour it has today, which is what every order
-- created before nests existed relies on.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fab_nest_issues (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  order_id        INT            NOT NULL,
  catalog_item_id INT            NOT NULL,
  nest_no         VARCHAR(40)    NOT NULL,
  qty             DECIMAL(18,6)  NULL,
  unit            VARCHAR(20)    NULL,
  task_id         INT            NULL,   -- the start that drew the plate
  item_id         INT            NULL,   -- the part whose start drew it
  issued_at       DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE KEY uq_fni_nest (company_id, order_id, catalog_item_id, nest_no),
  KEY idx_fni_order (order_id)
);
