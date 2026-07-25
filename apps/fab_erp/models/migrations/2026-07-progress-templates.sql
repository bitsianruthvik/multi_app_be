-- 2026-07-24 — Project Progress view: stage-report templates
-- A template is a named, ordered set of stages; each stage clubs operations, so
-- the Progress tab can show a fixed comparable set of columns per project.
-- Resolution: fab_orders.progress_template_id override first, else the active
-- template whose match_item_category_id matches the order's top-level finished-
-- good category. Reporting only — never drives materialization. Idempotent.

CREATE TABLE IF NOT EXISTS fab_progress_templates (
  id                     INT AUTO_INCREMENT PRIMARY KEY,
  company_id             INT           NOT NULL,
  name                   VARCHAR(120)  NOT NULL,
  code                   VARCHAR(40)   NULL,
  match_item_category_id INT           NULL,
  active                 TINYINT(1)    NOT NULL DEFAULT 1,
  created_at             TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at             DATETIME      DEFAULT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fpt_company  (company_id),
  KEY idx_fpt_match    (company_id, match_item_category_id)
);

CREATE TABLE IF NOT EXISTS fab_progress_stages (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  template_id  INT           NOT NULL,
  name         VARCHAR(120)  NOT NULL,
  seq_no       INT           NOT NULL DEFAULT 0,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at   DATETIME      DEFAULT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fps_template (company_id, template_id)
);

CREATE TABLE IF NOT EXISTS fab_progress_stage_ops (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  stage_id     INT           NOT NULL,
  operation_id INT           NOT NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  deleted_at   DATETIME      DEFAULT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fpso_stage (company_id, stage_id),
  KEY idx_fpso_op    (company_id, operation_id)
);

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_orders' AND COLUMN_NAME = 'progress_template_id');
SET @sql = IF(@col = 0, 'ALTER TABLE fab_orders ADD COLUMN progress_template_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
