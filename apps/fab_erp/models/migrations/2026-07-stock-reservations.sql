-- 2026-07-23 — FEAT-02: material reservations (gate-ready earmarking)
-- A task's gated material is reserved when its gate first clears, so a later
-- task can't clear against the same stock. Gating availability becomes
--   SUM(in_stock pieces) − SUM(active reservations).
-- Reservation is 'consumed' when the task starts (physical deduct) or 'released'
-- on cancel / re-materialize. Idempotent (CREATE TABLE IF NOT EXISTS); no seed.

CREATE TABLE IF NOT EXISTS fab_stock_reservations (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  company_id        INT            NOT NULL,
  catalog_item_id   INT            NOT NULL,
  task_id           INT            NOT NULL,
  order_id          INT            NULL,
  qty               DECIMAL(18,4)  NOT NULL DEFAULT 0,
  status            ENUM('active','consumed','released') NOT NULL DEFAULT 'active',
  created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  released_at       DATETIME       NULL,
  deleted_at        DATETIME       DEFAULT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fsr_avail  (company_id, catalog_item_id, status),
  KEY idx_fsr_task   (company_id, task_id, status)
);
