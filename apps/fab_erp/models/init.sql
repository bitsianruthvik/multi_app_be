-- fab_erp app schema (redesigned 2026-06-06)
-- Run: source this file via mysql CLI or workbench.
-- IMPORTANT: Uses foreign_key_checks=0 for safe drops.

SET foreign_key_checks = 0;

-- ===== DROP OBSOLETE TABLES =====

DROP TABLE IF EXISTS fab_manufacturing_method_lines;
DROP TABLE IF EXISTS fab_manufacturing_method_templates;
DROP TABLE IF EXISTS fab_routing_template_steps;
DROP TABLE IF EXISTS fab_routing_templates;
DROP TABLE IF EXISTS fab_formulas;
DROP TABLE IF EXISTS fab_formula_sets;

SET foreign_key_checks = 1;

-- ===== MASTER DATA =====

CREATE TABLE IF NOT EXISTS fab_plants (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  name         VARCHAR(255)  NOT NULL,
  code         VARCHAR(100)  NOT NULL,
  deleted_at   DATETIME      DEFAULT NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fpl_company (company_id)
);

CREATE TABLE IF NOT EXISTS fab_resource_types (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  plant_id     INT           NULL,
  name         VARCHAR(255)  NOT NULL,
  code         VARCHAR(100)  NOT NULL,
  category     VARCHAR(100)  DEFAULT NULL,
  deleted_at   DATETIME      DEFAULT NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (plant_id)   REFERENCES fab_plants(id),
  KEY idx_frt_company (company_id),
  KEY idx_frt_plant   (plant_id)
);

CREATE TABLE IF NOT EXISTS fab_resource_type_metrics (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  company_id        INT           NOT NULL,
  resource_type_id  INT           NOT NULL,
  metric_key        VARCHAR(100)  NOT NULL,
  metric_label      VARCHAR(255)  NOT NULL,
  data_type         VARCHAR(50)   NOT NULL DEFAULT 'decimal',
  unit              VARCHAR(50)   DEFAULT NULL,
  deleted_at        DATETIME      DEFAULT NULL,
  created_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id)       REFERENCES companies(id),
  FOREIGN KEY (resource_type_id) REFERENCES fab_resource_types(id),
  KEY idx_frtm_company          (company_id),
  KEY idx_frtm_resource_type    (resource_type_id)
);

CREATE TABLE IF NOT EXISTS fab_resources (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  company_id       INT           NOT NULL,
  plant_id         INT           NULL,
  stock_location_id INT          NULL,
  resource_type_id INT           NOT NULL,
  name             VARCHAR(255)  NOT NULL,
  code             VARCHAR(100)  NOT NULL,
  deleted_at       DATETIME      DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id)       REFERENCES companies(id),
  FOREIGN KEY (plant_id)         REFERENCES fab_plants(id),
  FOREIGN KEY (resource_type_id) REFERENCES fab_resource_types(id),
  KEY idx_fr_company        (company_id),
  KEY idx_fr_plant          (plant_id),
  KEY idx_fr_stock_location (stock_location_id),
  KEY idx_fr_resource_type  (resource_type_id)
);

CREATE TABLE IF NOT EXISTS fab_item_metric_defs (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  metric_key   VARCHAR(100)  NOT NULL,
  metric_label VARCHAR(255)  NOT NULL,
  data_type    VARCHAR(50)   NOT NULL DEFAULT 'decimal',
  unit         VARCHAR(50)   DEFAULT NULL,
  deleted_at   DATETIME      DEFAULT NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fimd_company (company_id)
);

CREATE TABLE IF NOT EXISTS fab_constants (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  company_id  INT             NOT NULL,
  const_key   VARCHAR(100)    NOT NULL,
  const_value DECIMAL(18,6)   NOT NULL,
  label       VARCHAR(255)    DEFAULT NULL,
  deleted_at  DATETIME        DEFAULT NULL,
  created_at  TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP       DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fc_company (company_id)
);

CREATE TABLE IF NOT EXISTS fab_codegen_rules (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  company_id     INT           NOT NULL,
  entity_type    VARCHAR(50)   NOT NULL,
  segments_json  JSON          NOT NULL,
  next_seq       INT           NOT NULL DEFAULT 1,
  seq_period_key VARCHAR(20)   NULL,
  created_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fab_codegen_rules (company_id, entity_type)
);

-- ===== TEMPLATES =====

CREATE TABLE IF NOT EXISTS fab_process_templates (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  company_id         INT           NOT NULL,
  plant_id           INT           NULL,
  name               VARCHAR(255)  NOT NULL,
  code               VARCHAR(100)  NOT NULL,
  version_group_id   INT           NULL,
  version_no         INT           NOT NULL DEFAULT 1,
  is_current_version TINYINT(1)    NOT NULL DEFAULT 1,
  approval_status    ENUM('draft','pending','approved') NOT NULL DEFAULT 'draft',
  deleted_at         DATETIME      DEFAULT NULL,
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (plant_id)   REFERENCES fab_plants(id),
  KEY idx_fpt_company       (company_id),
  KEY idx_fpt_plant         (plant_id),
  KEY idx_fpt_version_group (version_group_id),
  KEY idx_fpt_current       (company_id, is_current_version)
);

CREATE TABLE IF NOT EXISTS fab_process_template_steps (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  company_id           INT           NOT NULL,
  process_template_id  INT           NOT NULL,
  seq_no               INT           NOT NULL,
  name                 VARCHAR(255)  NOT NULL,
  resource_type_id     INT           NULL,
  deleted_at           DATETIME      DEFAULT NULL,
  created_at           TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id)          REFERENCES companies(id),
  FOREIGN KEY (process_template_id) REFERENCES fab_process_templates(id),
  FOREIGN KEY (resource_type_id)    REFERENCES fab_resource_types(id),
  KEY idx_fpts_company          (company_id),
  KEY idx_fpts_process_template (process_template_id),
  KEY idx_fpts_seq              (process_template_id, seq_no)
);

-- ===== NEW TABLES =====

CREATE TABLE IF NOT EXISTS fab_process_master (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  company_id    INT           NOT NULL,
  name          VARCHAR(255)  NOT NULL,
  code          VARCHAR(100)  NOT NULL,
  description   TEXT,
  deleted_at    DATETIME      DEFAULT NULL,
  created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_process_master_code (company_id, code),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fpm_company (company_id)
);

CREATE TABLE IF NOT EXISTS fab_resource_type_properties (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  resource_type_id INT           NOT NULL,
  property_key     VARCHAR(100)  NOT NULL,
  property_label   VARCHAR(255)  NOT NULL,
  unit             VARCHAR(50)   NULL,
  default_value    DECIMAL(18,6) NULL,
  deleted_at       DATETIME      DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rtp_key (resource_type_id, property_key),
  FOREIGN KEY (resource_type_id) REFERENCES fab_resource_types(id),
  KEY idx_frtp_resource_type (resource_type_id)
);

-- ===== TRANSACTIONAL =====

CREATE TABLE IF NOT EXISTS fab_projects (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  plant_id     INT           NULL,
  name         VARCHAR(255)  NOT NULL,
  code         VARCHAR(100)  NOT NULL,
  status       VARCHAR(100)  NOT NULL DEFAULT 'active',
  start_date   DATE          NULL,
  due_date     DATE          NULL,
  deleted_at   DATETIME      DEFAULT NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (plant_id)   REFERENCES fab_plants(id),
  KEY idx_fproj_company (company_id),
  KEY idx_fproj_plant   (plant_id),
  KEY idx_fproj_status  (company_id, status)
);

CREATE TABLE IF NOT EXISTS fab_items (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  company_id      INT             NOT NULL,
  project_id      INT             NOT NULL,
  parent_item_id  INT             NULL,
  name            VARCHAR(255)    NOT NULL,
  qty             DECIMAL(18,4)   NOT NULL DEFAULT 1,
  deleted_at      DATETIME        DEFAULT NULL,
  created_at      TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP       DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id)    REFERENCES companies(id),
  FOREIGN KEY (project_id)    REFERENCES fab_projects(id),
  FOREIGN KEY (parent_item_id) REFERENCES fab_items(id),
  KEY idx_fi_company  (company_id),
  KEY idx_fi_project  (project_id),
  KEY idx_fi_parent   (parent_item_id)
);

CREATE TABLE IF NOT EXISTS fab_item_metric_values (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT             NOT NULL,
  item_id      INT             NOT NULL,
  metric_key   VARCHAR(100)    NOT NULL,
  metric_value DECIMAL(18,6)   NULL,
  deleted_at   DATETIME        DEFAULT NULL,
  created_at   TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP       DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (item_id)    REFERENCES fab_items(id),
  KEY idx_fimv_company    (company_id),
  KEY idx_fimv_item       (item_id),
  KEY idx_fimv_metric_key (item_id, metric_key)
);

CREATE TABLE IF NOT EXISTS fab_planned_operations (
  id                     INT AUTO_INCREMENT PRIMARY KEY,
  company_id             INT             NOT NULL,
  project_id             INT             NOT NULL,
  item_id                INT             NOT NULL,
  resource_type_id       INT             NULL,
  seq_no                 INT             NOT NULL,
  name                   VARCHAR(255)    NULL,
  planned_hours          DECIMAL(18,4)   NULL,
  planned_start          DATETIME        NULL,
  planned_end            DATETIME        NULL,
  status                 VARCHAR(100)    NOT NULL DEFAULT 'planned',
  source_routing_step_id INT             NULL,
  deleted_at             DATETIME        DEFAULT NULL,
  created_at             TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP       DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id)       REFERENCES companies(id),
  FOREIGN KEY (project_id)       REFERENCES fab_projects(id),
  FOREIGN KEY (item_id)          REFERENCES fab_items(id),
  FOREIGN KEY (resource_type_id) REFERENCES fab_resource_types(id),
  KEY idx_fpo_company       (company_id),
  KEY idx_fpo_project       (project_id),
  KEY idx_fpo_item          (item_id),
  KEY idx_fpo_resource_type (resource_type_id),
  KEY idx_fpo_status        (company_id, status),
  KEY idx_fpo_seq           (item_id, seq_no)
);

CREATE TABLE IF NOT EXISTS fab_resource_assignments (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  company_id            INT           NOT NULL,
  planned_operation_id  INT           NOT NULL,
  resource_id           INT           NULL,
  assigned_shift_id     INT           NULL,
  assigned_date         DATE          NULL,
  deleted_at            DATETIME      DEFAULT NULL,
  created_at            TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id)           REFERENCES companies(id),
  FOREIGN KEY (planned_operation_id) REFERENCES fab_planned_operations(id),
  FOREIGN KEY (resource_id)          REFERENCES fab_resources(id),
  KEY idx_fra_company           (company_id),
  KEY idx_fra_planned_operation (planned_operation_id),
  KEY idx_fra_resource          (resource_id),
  KEY idx_fra_assigned_date     (company_id, assigned_date)
);

-- ===== SHIFT / CALENDAR =====

CREATE TABLE IF NOT EXISTS fab_shift_calendars (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT           NOT NULL,
  plant_id   INT           NULL,
  name       VARCHAR(255)  NOT NULL,
  code       VARCHAR(100)  NOT NULL,
  deleted_at DATETIME      DEFAULT NULL,
  created_at TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (plant_id)   REFERENCES fab_plants(id),
  KEY idx_fsc_company (company_id),
  KEY idx_fsc_plant   (plant_id)
);

CREATE TABLE IF NOT EXISTS fab_shifts (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  company_id       INT           NOT NULL,
  calendar_id      INT           NOT NULL,
  name             VARCHAR(255)  NOT NULL,
  start_time       TIME          NOT NULL,
  end_time         TIME          NOT NULL,
  working_minutes  INT           NOT NULL,
  deleted_at       DATETIME      DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id)  REFERENCES companies(id),
  FOREIGN KEY (calendar_id) REFERENCES fab_shift_calendars(id),
  KEY idx_fsft_company  (company_id),
  KEY idx_fsft_calendar (calendar_id)
);

CREATE TABLE IF NOT EXISTS fab_calendar_days (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  company_id  INT           NOT NULL,
  calendar_id INT           NOT NULL,
  day_date    DATE          NOT NULL,
  is_working  TINYINT(1)    NOT NULL DEFAULT 1,
  deleted_at  DATETIME      DEFAULT NULL,
  created_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id)  REFERENCES companies(id),
  FOREIGN KEY (calendar_id) REFERENCES fab_shift_calendars(id),
  UNIQUE KEY uq_fcd_cal_date (calendar_id, day_date),
  KEY idx_fcd_company  (company_id),
  KEY idx_fcd_calendar (calendar_id),
  KEY idx_fcd_date     (calendar_id, day_date, is_working)
);

-- ===== INVENTORY MASTER DATA & STOCK TABLES =====

CREATE TABLE IF NOT EXISTS fab_item_categories (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  name         VARCHAR(120)  NOT NULL,
  code         VARCHAR(20)   NOT NULL,
  description  TEXT          NULL,
  is_system    TINYINT(1)    NOT NULL DEFAULT 0,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at   TIMESTAMP     NULL,
  UNIQUE KEY uq_fab_item_categories (company_id, code),
  KEY idx_fab_item_categories_company (company_id)
);

CREATE TABLE IF NOT EXISTS fab_item_groups (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  category_id  INT           NOT NULL,
  name         VARCHAR(120)  NOT NULL,
  code         VARCHAR(20)   NOT NULL,
  description  TEXT          NULL,
  is_system    TINYINT(1)    NOT NULL DEFAULT 0,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at   TIMESTAMP     NULL,
  UNIQUE KEY uq_fab_item_groups (company_id, category_id, code),
  KEY idx_fab_item_groups_company  (company_id),
  KEY idx_fab_item_groups_category (category_id)
);

CREATE TABLE IF NOT EXISTS fab_item_subgroups (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  group_id     INT           NOT NULL,
  name         VARCHAR(120)  NOT NULL,
  code         VARCHAR(20)   NOT NULL,
  description  TEXT          NULL,
  is_system    TINYINT(1)    NOT NULL DEFAULT 0,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at   TIMESTAMP     NULL,
  UNIQUE KEY uq_fab_item_subgroups (company_id, group_id, code),
  KEY idx_fab_item_subgroups_company (company_id),
  KEY idx_fab_item_subgroups_group   (group_id)
);

CREATE TABLE IF NOT EXISTS fab_stock_locations (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  plant_id     INT           NOT NULL,
  name         VARCHAR(120)  NOT NULL,
  code         VARCHAR(20)   NOT NULL,
  description  TEXT          NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at   TIMESTAMP     NULL,
  UNIQUE KEY uq_fab_stock_locations (company_id, plant_id, code),
  KEY idx_fab_stock_locations_company (company_id),
  KEY idx_fab_stock_locations_plant   (plant_id)
);

CREATE TABLE IF NOT EXISTS fab_suppliers (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  name         VARCHAR(150)  NOT NULL,
  code         VARCHAR(40)   NOT NULL,
  contact_name VARCHAR(120)  NULL,
  phone        VARCHAR(40)   NULL,
  email        VARCHAR(150)  NULL,
  address      TEXT          NULL,
  notes        TEXT          NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at   TIMESTAMP     NULL,
  UNIQUE KEY uq_fab_suppliers (company_id, code),
  KEY idx_fab_suppliers_company (company_id)
);

CREATE TABLE IF NOT EXISTS fab_customers (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  name         VARCHAR(150)  NOT NULL,
  code         VARCHAR(40)   NOT NULL,
  contact_name VARCHAR(120)  NULL,
  phone        VARCHAR(40)   NULL,
  email        VARCHAR(150)  NULL,
  address      TEXT          NULL,
  notes        TEXT          NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at   TIMESTAMP     NULL,
  UNIQUE KEY uq_fab_customers (company_id, code),
  KEY idx_fab_customers_company (company_id)
);

CREATE TABLE IF NOT EXISTS fab_item_batches (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  company_id        INT            NOT NULL,
  catalog_item_id   INT            NOT NULL,
  plant_id          INT            NOT NULL,
  stock_location_id INT            NOT NULL,
  batch_code        VARCHAR(60)    NOT NULL,
  qty_on_hand       DECIMAL(14,4)  NOT NULL DEFAULT 0,
  received_date     DATE           NULL,
  notes             TEXT           NULL,
  created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at        TIMESTAMP      NULL,
  UNIQUE KEY uq_fab_item_batches (company_id, catalog_item_id, plant_id, stock_location_id, batch_code),
  KEY idx_fab_item_batches_company (company_id),
  KEY idx_fab_item_batches_item    (catalog_item_id)
);

CREATE TABLE IF NOT EXISTS fab_stock_balances (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  company_id        INT            NOT NULL,
  catalog_item_id   INT            NOT NULL,
  plant_id          INT            NOT NULL,
  stock_location_id INT            NOT NULL,
  qty_ordered       DECIMAL(14,4)  NOT NULL DEFAULT 0,
  qty_earmarked     DECIMAL(14,4)  NOT NULL DEFAULT 0,
  created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at        TIMESTAMP      NULL,
  UNIQUE KEY uq_fab_stock_balances (company_id, catalog_item_id, plant_id, stock_location_id),
  KEY idx_fab_stock_balances_company (company_id),
  KEY idx_fab_stock_balances_item    (catalog_item_id)
);

CREATE TABLE IF NOT EXISTS fab_stock_policies (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  company_id        INT            NOT NULL,
  catalog_item_id   INT            NOT NULL,
  plant_id          INT            NOT NULL,
  stock_location_id INT            NOT NULL,
  min_qty           DECIMAL(14,4)  NOT NULL DEFAULT 0,
  reorder_qty       DECIMAL(14,4)  NOT NULL DEFAULT 0,
  created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at        TIMESTAMP      NULL,
  UNIQUE KEY uq_fab_stock_policies (company_id, catalog_item_id, plant_id, stock_location_id),
  KEY idx_fab_stock_policies_company (company_id),
  KEY idx_fab_stock_policies_item    (catalog_item_id)
);

CREATE TABLE IF NOT EXISTS fab_grns (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  company_id        INT           NOT NULL,
  grn_number        VARCHAR(60)   NOT NULL,
  grn_date          DATE          NOT NULL,
  plant_id          INT           NOT NULL,
  stock_location_id INT           NOT NULL,
  supplier_id       INT           NULL,
  supplier_ref      VARCHAR(120)  NULL,
  notes             TEXT          NULL,
  status            VARCHAR(20)   NOT NULL DEFAULT 'posted',
  created_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at        TIMESTAMP     NULL,
  UNIQUE KEY uq_fab_grns_number (company_id, grn_number),
  KEY idx_fab_grns_company  (company_id),
  KEY idx_fab_grns_supplier (supplier_id)
);

CREATE TABLE IF NOT EXISTS fab_grn_lines (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  grn_id          INT            NOT NULL,
  catalog_item_id INT            NOT NULL,
  batch_id        INT            NULL,
  batch_code      VARCHAR(60)    NOT NULL,
  qty             DECIMAL(14,4)  NOT NULL,
  unit_cost       DECIMAL(14,4)  NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at      TIMESTAMP      NULL,
  KEY idx_fab_grn_lines_company (company_id),
  KEY idx_fab_grn_lines_grn     (grn_id),
  KEY idx_fab_grn_lines_item    (catalog_item_id),
  KEY idx_fab_grn_lines_batch   (batch_id)
);

CREATE TABLE IF NOT EXISTS fab_stock_ledger (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  company_id        INT            NOT NULL,
  catalog_item_id   INT            NOT NULL,
  plant_id          INT            NOT NULL,
  stock_location_id INT            NOT NULL,
  batch_id          INT            NOT NULL,
  batch_code        VARCHAR(60)    NOT NULL,
  txn_type          VARCHAR(30)    NOT NULL DEFAULT 'grn_receipt',
  qty               DECIMAL(14,4)  NOT NULL,
  unit_cost         DECIMAL(14,4)  NULL,
  supplier_id       INT            NULL,
  grn_id            INT            NULL,
  grn_line_id       INT            NULL,
  txn_date          DATE           NOT NULL,
  notes             TEXT           NULL,
  created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at        TIMESTAMP      NULL,
  KEY idx_fab_stock_ledger_batch (batch_id),
  KEY idx_fab_stock_ledger_item  (company_id, catalog_item_id, plant_id, stock_location_id),
  KEY idx_fab_stock_ledger_grn   (grn_id)
);

-- ===== STANDARD ITEM TAXONOMY SEED (system rows, all companies) =====

-- 1. Categories: one row per company per taxonomy entry
INSERT INTO fab_item_categories (company_id, name, code, description, is_system)
SELECT c.id, v.name, v.code, v.description, 1
FROM companies c
CROSS JOIN (
  SELECT 'Raw Materials' AS name, 'rm' AS code, 'Unprocessed materials used in fabrication' AS description
  UNION ALL SELECT 'Consumables', 'cons', 'Items consumed during production'
  UNION ALL SELECT 'Fasteners & Hardware', 'fast', 'Bolts, nuts, pins and similar hardware'
  UNION ALL SELECT 'Semi-Finished Goods', 'sfg', 'Partially processed in-house items'
  UNION ALL SELECT 'Finished Goods', 'fg', 'Completed products ready for delivery'
  UNION ALL SELECT 'Tools & Tooling', 'tool', 'Hand tools, power tools, jigs and fixtures'
  UNION ALL SELECT 'MRO & Spares', 'mro', 'Maintenance, repair and operating supplies'
  UNION ALL SELECT 'Packaging', 'pack', 'Packaging and shipping materials'
) v
WHERE c.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM fab_item_categories x
    WHERE x.company_id = c.id AND x.code = v.code AND x.deleted_at IS NULL
  );

-- 2. Groups: join back to the categories just inserted, per company
INSERT INTO fab_item_groups (company_id, category_id, name, code, description, is_system)
SELECT cat.company_id, cat.id, v.name, v.code, NULL, 1
FROM fab_item_categories cat
CROSS JOIN (
  SELECT 'rm' AS cat_code, 'Metals' AS name, 'met' AS code
  UNION ALL SELECT 'rm', 'Plastics', 'plas'
  UNION ALL SELECT 'rm', 'Composites', 'comp'
  UNION ALL SELECT 'cons', 'Welding Consumables', 'weld'
  UNION ALL SELECT 'cons', 'Cutting Tools', 'cutt'
  UNION ALL SELECT 'cons', 'Adhesives & Sealants', 'adh'
  UNION ALL SELECT 'cons', 'Abrasives', 'abr'
  UNION ALL SELECT 'fast', 'Bolts & Screws', 'bolt'
  UNION ALL SELECT 'fast', 'Nuts & Washers', 'nut'
  UNION ALL SELECT 'fast', 'Pins & Clips', 'pin'
  UNION ALL SELECT 'fast', 'Rivets', 'riv'
  UNION ALL SELECT 'sfg', 'Cut Parts', 'cutp'
  UNION ALL SELECT 'sfg', 'Machined Parts', 'mchp'
  UNION ALL SELECT 'sfg', 'Welded Assemblies', 'wass'
  UNION ALL SELECT 'fg', 'Assemblies', 'asm'
  UNION ALL SELECT 'fg', 'Products', 'prod'
  UNION ALL SELECT 'tool', 'Hand Tools', 'hand'
  UNION ALL SELECT 'tool', 'Power Tools', 'power'
  UNION ALL SELECT 'tool', 'Jigs & Fixtures', 'jig'
  UNION ALL SELECT 'tool', 'Measuring Instruments', 'meas'
  UNION ALL SELECT 'mro', 'Machine Spares', 'mspr'
  UNION ALL SELECT 'mro', 'Lubricants', 'lube'
  UNION ALL SELECT 'mro', 'Electrical Spares', 'espr'
  UNION ALL SELECT 'mro', 'PPE', 'ppe'
  UNION ALL SELECT 'pack', 'Boxes & Crates', 'box'
  UNION ALL SELECT 'pack', 'Pallets', 'plt'
  UNION ALL SELECT 'pack', 'Wrapping Material', 'wrap'
) v
WHERE cat.code = v.cat_code AND cat.is_system = 1 AND cat.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM fab_item_groups g
    WHERE g.company_id = cat.company_id AND g.category_id = cat.id AND g.code = v.code AND g.deleted_at IS NULL
  );

-- 3. Sub-groups: join back to the groups just inserted, per company
INSERT INTO fab_item_subgroups (company_id, group_id, name, code, description, is_system)
SELECT grp.company_id, grp.id, v.name, v.code, NULL, 1
FROM fab_item_groups grp
CROSS JOIN (
  SELECT 'met' AS grp_code, 'Sheet Metal' AS name, 'sheet' AS code
  UNION ALL SELECT 'met', 'Bar Stock', 'bar'
  UNION ALL SELECT 'met', 'Tube & Pipe', 'tube'
  UNION ALL SELECT 'met', 'Plate', 'plate'
  UNION ALL SELECT 'plas', 'Sheet', 'psh'
  UNION ALL SELECT 'plas', 'Rod', 'prd'
  UNION ALL SELECT 'plas', 'Film', 'pfl'
  UNION ALL SELECT 'comp', 'Fiberglass', 'fbg'
  UNION ALL SELECT 'comp', 'Carbon Fiber', 'cfb'
  UNION ALL SELECT 'weld', 'Electrodes', 'elec'
  UNION ALL SELECT 'weld', 'Welding Wire', 'wwir'
  UNION ALL SELECT 'weld', 'Shielding Gas', 'gas'
  UNION ALL SELECT 'cutt', 'Drill Bits', 'drl'
  UNION ALL SELECT 'cutt', 'Saw Blades', 'blade'
  UNION ALL SELECT 'cutt', 'Cutting Inserts', 'insrt'
  UNION ALL SELECT 'bolt', 'Hex Bolts', 'hex'
  UNION ALL SELECT 'bolt', 'Socket Screws', 'sock'
  UNION ALL SELECT 'bolt', 'Machine Screws', 'msc'
) v
WHERE grp.code = v.grp_code AND grp.is_system = 1 AND grp.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM fab_item_subgroups sg
    WHERE sg.company_id = grp.company_id AND sg.group_id = grp.id AND sg.code = v.code AND sg.deleted_at IS NULL
  );

-- ===== ALTER: ADD NEW COLUMNS (MySQL 8.0-safe guards) =====

-- Add process_master_id to fab_process_template_steps
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_process_template_steps'
              AND COLUMN_NAME  = 'process_master_id');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_process_template_steps ADD COLUMN process_master_id INT DEFAULT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add allowed_resource_type_ids to fab_process_template_steps
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_process_template_steps'
              AND COLUMN_NAME  = 'allowed_resource_type_ids');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_process_template_steps ADD COLUMN allowed_resource_type_ids JSON DEFAULT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add formula to fab_process_template_steps
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_process_template_steps'
              AND COLUMN_NAME  = 'formula');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_process_template_steps ADD COLUMN formula TEXT DEFAULT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add standard_values to fab_process_template_steps
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_process_template_steps'
              AND COLUMN_NAME  = 'standard_values');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_process_template_steps ADD COLUMN standard_values JSON DEFAULT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add sub_template_id to fab_process_template_steps
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_process_template_steps'
              AND COLUMN_NAME  = 'sub_template_id');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_process_template_steps ADD COLUMN sub_template_id INT DEFAULT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add standard_values to fab_planned_operations
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_planned_operations'
              AND COLUMN_NAME  = 'standard_values');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_planned_operations ADD COLUMN standard_values JSON DEFAULT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add computed_hours to fab_planned_operations
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_planned_operations'
              AND COLUMN_NAME  = 'computed_hours');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_planned_operations ADD COLUMN computed_hours DECIMAL(10,4) DEFAULT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add assigned_resource_type_id to fab_planned_operations
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_planned_operations'
              AND COLUMN_NAME  = 'assigned_resource_type_id');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_planned_operations ADD COLUMN assigned_resource_type_id INT DEFAULT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add FK for process_master_id (guard: only if constraint doesn't exist)
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME   = 'fab_process_template_steps'
             AND CONSTRAINT_NAME = 'fk_pts_process_master');
SET @sql = IF(@fk = 0,
  'ALTER TABLE fab_process_template_steps ADD CONSTRAINT fk_pts_process_master FOREIGN KEY (process_master_id) REFERENCES fab_process_master(id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add FK for sub_template_id (guard: only if constraint doesn't exist)
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME   = 'fab_process_template_steps'
             AND CONSTRAINT_NAME = 'fk_pts_sub_template');
SET @sql = IF(@fk = 0,
  'ALTER TABLE fab_process_template_steps ADD CONSTRAINT fk_pts_sub_template FOREIGN KEY (sub_template_id) REFERENCES fab_process_templates(id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add category_id to fab_item_catalog
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_item_catalog'
              AND COLUMN_NAME  = 'category_id');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_item_catalog ADD COLUMN category_id INT DEFAULT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add group_id to fab_item_catalog
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_item_catalog'
              AND COLUMN_NAME  = 'group_id');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_item_catalog ADD COLUMN group_id INT DEFAULT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add subgroup_id to fab_item_catalog
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_item_catalog'
              AND COLUMN_NAME  = 'subgroup_id');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_item_catalog ADD COLUMN subgroup_id INT DEFAULT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add SAP Basic Data fields to fab_item_catalog
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='gross_weight');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_catalog ADD COLUMN gross_weight DECIMAL(14,3) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='net_weight');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_catalog ADD COLUMN net_weight DECIMAL(14,3) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='weight_unit');
SET @sql = IF(@col=0,"ALTER TABLE fab_item_catalog ADD COLUMN weight_unit VARCHAR(10) NOT NULL DEFAULT 'kg'",'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='volume');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_catalog ADD COLUMN volume DECIMAL(14,4) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='volume_unit');
SET @sql = IF(@col=0,"ALTER TABLE fab_item_catalog ADD COLUMN volume_unit VARCHAR(10) NOT NULL DEFAULT 'm3'",'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='length');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_catalog ADD COLUMN `length` DECIMAL(14,3) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='width');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_catalog ADD COLUMN width DECIMAL(14,3) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='height');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_catalog ADD COLUMN height DECIMAL(14,3) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='dimension_unit');
SET @sql = IF(@col=0,"ALTER TABLE fab_item_catalog ADD COLUMN dimension_unit VARCHAR(10) NOT NULL DEFAULT 'mm'",'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='barcode');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_catalog ADD COLUMN barcode VARCHAR(50) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='hsn_code');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_catalog ADD COLUMN hsn_code VARCHAR(20) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='division');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_catalog ADD COLUMN division VARCHAR(20) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ===== MATERIAL BOM & CONFIG VALUES =====

CREATE TABLE IF NOT EXISTS fab_material_bom_items (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  company_id          INT            NOT NULL,
  catalog_item_id     INT            NOT NULL,
  parent_bom_item_id  INT            NULL,
  ref_catalog_item_id INT            NULL,
  name                VARCHAR(255)   NOT NULL,
  qty                 DECIMAL(18,4)  NOT NULL DEFAULT 1,
  unit                VARCHAR(50)    NULL,
  deleted_at          DATETIME       DEFAULT NULL,
  created_at          TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id)      REFERENCES companies(id),
  FOREIGN KEY (catalog_item_id) REFERENCES fab_item_catalog(id),
  KEY idx_fmbi_company      (company_id),
  KEY idx_fmbi_catalog_item (catalog_item_id),
  KEY idx_fmbi_parent       (parent_bom_item_id)
);

CREATE TABLE IF NOT EXISTS fab_item_config_values (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  company_id      INT           NOT NULL,
  catalog_item_id INT           NOT NULL,
  field_key       VARCHAR(100)  NOT NULL,
  field_value     TEXT          NULL,
  sort_order      INT           NOT NULL DEFAULT 0,
  deleted_at      DATETIME      DEFAULT NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id)      REFERENCES companies(id),
  FOREIGN KEY (catalog_item_id) REFERENCES fab_item_catalog(id),
  KEY idx_ficv_company      (company_id),
  KEY idx_ficv_catalog_item (catalog_item_id)
);

-- BOM header: one record per BOM alternative for a catalog item
CREATE TABLE IF NOT EXISTS fab_material_boms (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  company_id      INT           NOT NULL,
  catalog_item_id INT           NOT NULL,
  name            VARCHAR(255)  NOT NULL DEFAULT 'BOM 1',
  description     TEXT          NULL,
  is_default      TINYINT(1)    NOT NULL DEFAULT 0,
  deleted_at      DATETIME      DEFAULT NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id)      REFERENCES companies(id),
  FOREIGN KEY (catalog_item_id) REFERENCES fab_item_catalog(id),
  KEY idx_fmb_company      (company_id),
  KEY idx_fmb_catalog_item (catalog_item_id)
);

-- Project final products: multiple target items per project
CREATE TABLE IF NOT EXISTS fab_project_items (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  project_id      INT            NOT NULL,
  catalog_item_id INT            NOT NULL,
  qty             DECIMAL(18,4)  NOT NULL DEFAULT 1,
  target_plant_id INT            NULL,
  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id)      REFERENCES companies(id),
  FOREIGN KEY (project_id)      REFERENCES fab_projects(id),
  FOREIGN KEY (catalog_item_id) REFERENCES fab_item_catalog(id),
  FOREIGN KEY (target_plant_id) REFERENCES fab_plants(id),
  KEY idx_fpri_company (company_id),
  KEY idx_fpri_project (project_id)
);

-- Add top_item_id to fab_projects
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_projects' AND COLUMN_NAME='top_item_id');
SET @sql = IF(@col=0,'ALTER TABLE fab_projects ADD COLUMN top_item_id INT NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add catalog_item_id to fab_items (guarded — may already exist)
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='catalog_item_id');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN catalog_item_id INT NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add unit to fab_items (guarded — may already exist)
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='unit');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN unit VARCHAR(50) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add bom_id to fab_material_bom_items
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_material_bom_items' AND COLUMN_NAME='bom_id');
SET @sql = IF(@col=0,'ALTER TABLE fab_material_bom_items ADD COLUMN bom_id INT NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add item_category to fab_material_bom_items
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_material_bom_items' AND COLUMN_NAME='item_category');
SET @sql = IF(@col=0,"ALTER TABLE fab_material_bom_items ADD COLUMN item_category VARCHAR(20) NOT NULL DEFAULT 'component'",'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add manufacturing_plant_id to fab_material_bom_items
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_material_bom_items' AND COLUMN_NAME='manufacturing_plant_id');
SET @sql = IF(@col=0,'ALTER TABLE fab_material_bom_items ADD COLUMN manufacturing_plant_id INT NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add material_type to fab_item_catalog
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='material_type');
SET @sql = IF(@col=0,"ALTER TABLE fab_item_catalog ADD COLUMN material_type VARCHAR(30) NOT NULL DEFAULT 'component'",'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add purchase_cost to fab_item_catalog
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='purchase_cost');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_catalog ADD COLUMN purchase_cost DECIMAL(14,4) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add storage_location_id to fab_projects
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_projects' AND COLUMN_NAME='storage_location_id');
SET @sql = IF(@col=0,'ALTER TABLE fab_projects ADD COLUMN storage_location_id INT NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add priority to fab_projects
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_projects' AND COLUMN_NAME='priority');
SET @sql = IF(@col=0,'ALTER TABLE fab_projects ADD COLUMN priority VARCHAR(50) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add customer_reference to fab_projects
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_projects' AND COLUMN_NAME='customer_reference');
SET @sql = IF(@col=0,'ALTER TABLE fab_projects ADD COLUMN customer_reference VARCHAR(255) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add mrp_controller to fab_projects
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_projects' AND COLUMN_NAME='mrp_controller');
SET @sql = IF(@col=0,'ALTER TABLE fab_projects ADD COLUMN mrp_controller VARCHAR(100) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add production_supervisor to fab_projects
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_projects' AND COLUMN_NAME='production_supervisor');
SET @sql = IF(@col=0,'ALTER TABLE fab_projects ADD COLUMN production_supervisor VARCHAR(100) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add notes to fab_projects
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_projects' AND COLUMN_NAME='notes');
SET @sql = IF(@col=0,'ALTER TABLE fab_projects ADD COLUMN notes TEXT NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add scheduled_start to fab_projects
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_projects' AND COLUMN_NAME='scheduled_start');
SET @sql = IF(@col=0,'ALTER TABLE fab_projects ADD COLUMN scheduled_start DATE NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add scheduled_end to fab_projects
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_projects' AND COLUMN_NAME='scheduled_end');
SET @sql = IF(@col=0,'ALTER TABLE fab_projects ADD COLUMN scheduled_end DATE NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ===== PERMISSION SEEDS =====
INSERT IGNORE INTO features (feature_name, feature_tag, type)
VALUES
  ('Fab ERP — Process Master Manage',            'fab_erp_process_master_manage',            'frontend'),
  ('Fab ERP — Resource Type Properties Manage',  'fab_erp_resource_type_properties_manage',  'frontend');

INSERT IGNORE INTO features (feature_name, feature_tag, type)
VALUES
  ('View Inventory',            'fab_erp_inventory_view',          'frontend'),
  ('Manage Inventory',          'fab_erp_inventory_manage',        'frontend'),
  ('Manage Stock Locations',    'fab_erp_stock_location_manage',   'frontend'),
  ('Manage Item Taxonomy',      'fab_erp_taxonomy_manage',          'frontend'),
  ('View GRNs',                 'fab_erp_grn_view',                 'frontend'),
  ('Manage GRNs',               'fab_erp_grn_manage',               'frontend');

-- ── Sales Orders ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fab_sales_orders (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  company_id           INT            NOT NULL,
  so_number            VARCHAR(100)   NOT NULL,
  type                 VARCHAR(50)    NOT NULL DEFAULT 'standard',
  status               VARCHAR(50)    NOT NULL DEFAULT 'draft',
  customer_name        VARCHAR(255)   NULL,
  customer_po_ref      VARCHAR(255)   NULL,
  plant_id             INT            NULL,
  requested_date       DATE           NULL,
  confirmed_date       DATE           NULL,
  scheduled_ship_date  DATE           NULL,
  delivery_address     TEXT           NULL,
  payment_terms        VARCHAR(255)   NULL,
  currency             VARCHAR(10)    NULL DEFAULT 'INR',
  priority             VARCHAR(50)    NULL,
  mrp_controller       VARCHAR(100)   NULL,
  notes                TEXT           NULL,
  deleted_at           DATETIME       NULL,
  created_at           TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fab_so_company (company_id)
);

CREATE TABLE IF NOT EXISTS fab_so_items (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  company_id       INT            NOT NULL,
  so_id            INT            NOT NULL,
  catalog_item_id  INT            NOT NULL,
  qty              DECIMAL(14,4)  NOT NULL DEFAULT 1,
  unit             VARCHAR(50)    NULL,
  unit_price       DECIMAL(14,4)  NULL,
  discount         DECIMAL(5,2)   NULL DEFAULT 0,
  target_plant_id  INT            NULL,
  requested_date   DATE           NULL,
  notes            TEXT           NULL,
  deleted_at       DATETIME       NULL,
  created_at       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fab_so_items_so (so_id),
  KEY idx_fab_so_items_company (company_id)
);

-- ── Supplier × Item records ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fab_supplier_items (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  company_id       INT            NOT NULL,
  supplier_id      INT            NOT NULL,
  catalog_item_id  INT            NOT NULL,
  lead_time_days   INT            NULL,
  unit_cost        DECIMAL(14,4)  NULL,
  currency         VARCHAR(10)    NULL DEFAULT 'INR',
  min_order_qty    DECIMAL(14,4)  NULL,
  is_preferred     TINYINT(1)     NOT NULL DEFAULT 0,
  notes            TEXT           NULL,
  deleted_at       DATETIME       NULL,
  created_at       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fab_supplier_items_supplier (supplier_id),
  KEY idx_fab_supplier_items_item (catalog_item_id),
  KEY idx_fab_supplier_items_company (company_id)
);

-- ── fab_item_catalog new columns ────────────────────────────────────────────

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='procurement_type');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_catalog ADD COLUMN procurement_type VARCHAR(20) NOT NULL DEFAULT ''buy''','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='lead_time_days');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_catalog ADD COLUMN lead_time_days INT NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='mrp_active');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_catalog ADD COLUMN mrp_active TINYINT(1) NOT NULL DEFAULT 1','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── fab_material_boms: base qty/unit for scaling sub-BOM quantities ──────────

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_material_boms' AND COLUMN_NAME='base_qty');
SET @sql = IF(@col=0,'ALTER TABLE fab_material_boms ADD COLUMN base_qty DECIMAL(14,4) NOT NULL DEFAULT 1','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_material_boms' AND COLUMN_NAME='base_unit');
SET @sql = IF(@col=0,'ALTER TABLE fab_material_boms ADD COLUMN base_unit VARCHAR(50) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── Custom fields hierarchy (category / group / subgroup / item) ─────────────

CREATE TABLE IF NOT EXISTS fab_custom_fields (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  company_id  INT          NOT NULL,
  level       VARCHAR(20)  NOT NULL,
  level_id    INT          NOT NULL,
  field_key   VARCHAR(100) NOT NULL,
  field_type  VARCHAR(20)  NOT NULL DEFAULT 'text',
  field_value TEXT         NULL,
  sort_order  INT          NOT NULL DEFAULT 0,
  deleted_at  DATETIME     NULL,
  created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fcf_company (company_id),
  KEY idx_fcf_level   (level, level_id)
);

-- Migrate existing item-level config values (idempotent)
INSERT INTO fab_custom_fields
  (company_id, level, level_id, field_key, field_type, field_value, sort_order, deleted_at, created_at, updated_at)
SELECT ficv.company_id, 'item', ficv.catalog_item_id, ficv.field_key, 'text',
       ficv.field_value, ficv.sort_order, ficv.deleted_at, ficv.created_at, ficv.updated_at
FROM fab_item_config_values ficv
WHERE NOT EXISTS (
  SELECT 1 FROM fab_custom_fields fcf
  WHERE fcf.company_id = ficv.company_id
    AND fcf.level      = 'item'
    AND fcf.level_id   = ficv.catalog_item_id
    AND fcf.field_key  = ficv.field_key
);

-- ── Standard fields for fab_resource_types (SAP Work Center defaults) ─────────

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resource_types' AND COLUMN_NAME='capacity_hrs_per_day');
SET @sql = IF(@col=0,'ALTER TABLE fab_resource_types ADD COLUMN capacity_hrs_per_day DECIMAL(10,2) NULL DEFAULT 8.00','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resource_types' AND COLUMN_NAME='num_units');
SET @sql = IF(@col=0,'ALTER TABLE fab_resource_types ADD COLUMN num_units INT NULL DEFAULT 1','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resource_types' AND COLUMN_NAME='utilization_pct');
SET @sql = IF(@col=0,'ALTER TABLE fab_resource_types ADD COLUMN utilization_pct DECIMAL(5,2) NULL DEFAULT 85.00','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resource_types' AND COLUMN_NAME='efficiency_pct');
SET @sql = IF(@col=0,'ALTER TABLE fab_resource_types ADD COLUMN efficiency_pct DECIMAL(5,2) NULL DEFAULT 100.00','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resource_types' AND COLUMN_NAME='overload_pct');
SET @sql = IF(@col=0,'ALTER TABLE fab_resource_types ADD COLUMN overload_pct DECIMAL(5,2) NULL DEFAULT 100.00','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resource_types' AND COLUMN_NAME='setup_time_hrs');
SET @sql = IF(@col=0,'ALTER TABLE fab_resource_types ADD COLUMN setup_time_hrs DECIMAL(10,4) NULL DEFAULT 0.0000','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resource_types' AND COLUMN_NAME='teardown_time_hrs');
SET @sql = IF(@col=0,'ALTER TABLE fab_resource_types ADD COLUMN teardown_time_hrs DECIMAL(10,4) NULL DEFAULT 0.0000','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resource_types' AND COLUMN_NAME='queue_time_hrs');
SET @sql = IF(@col=0,'ALTER TABLE fab_resource_types ADD COLUMN queue_time_hrs DECIMAL(10,4) NULL DEFAULT 0.0000','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resource_types' AND COLUMN_NAME='move_time_hrs');
SET @sql = IF(@col=0,'ALTER TABLE fab_resource_types ADD COLUMN move_time_hrs DECIMAL(10,4) NULL DEFAULT 0.0000','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resource_types' AND COLUMN_NAME='scheduling_basis');
SET @sql = IF(@col=0,"ALTER TABLE fab_resource_types ADD COLUMN scheduling_basis VARCHAR(20) NULL DEFAULT 'machine'",'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resource_types' AND COLUMN_NAME='cost_per_hour');
SET @sql = IF(@col=0,'ALTER TABLE fab_resource_types ADD COLUMN cost_per_hour DECIMAL(14,4) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resource_types' AND COLUMN_NAME='currency');
SET @sql = IF(@col=0,"ALTER TABLE fab_resource_types ADD COLUMN currency VARCHAR(10) NULL DEFAULT 'INR'",'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── Resource-level overrides (NULL = inherit from resource type) ───────────────

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resources' AND COLUMN_NAME='capacity_hrs_per_day');
SET @sql = IF(@col=0,'ALTER TABLE fab_resources ADD COLUMN capacity_hrs_per_day DECIMAL(10,2) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resources' AND COLUMN_NAME='num_units');
SET @sql = IF(@col=0,'ALTER TABLE fab_resources ADD COLUMN num_units INT NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resources' AND COLUMN_NAME='utilization_pct');
SET @sql = IF(@col=0,'ALTER TABLE fab_resources ADD COLUMN utilization_pct DECIMAL(5,2) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resources' AND COLUMN_NAME='efficiency_pct');
SET @sql = IF(@col=0,'ALTER TABLE fab_resources ADD COLUMN efficiency_pct DECIMAL(5,2) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resources' AND COLUMN_NAME='overload_pct');
SET @sql = IF(@col=0,'ALTER TABLE fab_resources ADD COLUMN overload_pct DECIMAL(5,2) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resources' AND COLUMN_NAME='setup_time_hrs');
SET @sql = IF(@col=0,'ALTER TABLE fab_resources ADD COLUMN setup_time_hrs DECIMAL(10,4) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resources' AND COLUMN_NAME='teardown_time_hrs');
SET @sql = IF(@col=0,'ALTER TABLE fab_resources ADD COLUMN teardown_time_hrs DECIMAL(10,4) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resources' AND COLUMN_NAME='queue_time_hrs');
SET @sql = IF(@col=0,'ALTER TABLE fab_resources ADD COLUMN queue_time_hrs DECIMAL(10,4) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resources' AND COLUMN_NAME='move_time_hrs');
SET @sql = IF(@col=0,'ALTER TABLE fab_resources ADD COLUMN move_time_hrs DECIMAL(10,4) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resources' AND COLUMN_NAME='scheduling_basis');
SET @sql = IF(@col=0,'ALTER TABLE fab_resources ADD COLUMN scheduling_basis VARCHAR(20) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resources' AND COLUMN_NAME='cost_per_hour');
SET @sql = IF(@col=0,'ALTER TABLE fab_resources ADD COLUMN cost_per_hour DECIMAL(14,4) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resources' AND COLUMN_NAME='currency');
SET @sql = IF(@col=0,'ALTER TABLE fab_resources ADD COLUMN currency VARCHAR(10) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── Resource custom fields (level: resource_type | resource) ──────────────────

CREATE TABLE IF NOT EXISTS fab_resource_custom_fields (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  company_id  INT           NOT NULL,
  level       VARCHAR(20)   NOT NULL,
  level_id    INT           NOT NULL,
  field_key   VARCHAR(100)  NOT NULL,
  field_label VARCHAR(255)  NOT NULL,
  field_type  VARCHAR(20)   NOT NULL DEFAULT 'text',
  field_value TEXT          NULL,
  sort_order  INT           NOT NULL DEFAULT 0,
  deleted_at  DATETIME      NULL,
  created_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_frcf_company (company_id),
  KEY idx_frcf_level   (level, level_id)
);

-- ===== ROUTING PLANS =====

CREATE TABLE IF NOT EXISTS fab_routing_plans (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  company_id       INT            NOT NULL,
  bom_id           INT            NOT NULL,
  name             VARCHAR(255)   NOT NULL,
  version_no       INT            NOT NULL DEFAULT 1,
  version_group_id INT            NULL,
  is_current       TINYINT(1)     NOT NULL DEFAULT 1,
  status           ENUM('draft','released','superseded','archived') NOT NULL DEFAULT 'draft',
  released_by      INT            NULL,
  released_at      DATETIME       NULL,
  notes            TEXT           NULL,
  deleted_at       DATETIME       NULL,
  created_at       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_frp_company (company_id),
  KEY idx_frp_bom     (bom_id)
);

CREATE TABLE IF NOT EXISTS fab_routing_op_steps (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  company_id       INT            NOT NULL,
  routing_plan_id  INT            NOT NULL,
  name             VARCHAR(255)   NOT NULL,
  description      TEXT           NULL,
  resource_type_id INT            NULL,
  seq_no           INT            NOT NULL DEFAULT 0,
  x_pos            DECIMAL(10,2)  NOT NULL DEFAULT 100,
  y_pos            DECIMAL(10,2)  NOT NULL DEFAULT 100,
  is_optional      TINYINT(1)     NOT NULL DEFAULT 0,
  notes            TEXT           NULL,
  deleted_at       DATETIME       NULL,
  created_at       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id)      REFERENCES companies(id),
  FOREIGN KEY (routing_plan_id) REFERENCES fab_routing_plans(id),
  KEY idx_fros_plan (routing_plan_id)
);

CREATE TABLE IF NOT EXISTS fab_routing_op_deps (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  routing_plan_id INT            NOT NULL,
  from_step_id    INT            NOT NULL,
  to_step_id      INT            NOT NULL,
  lag_minutes     DECIMAL(10,2)  NULL DEFAULT 0,
  notes           TEXT           NULL,
  deleted_at      DATETIME       NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id)      REFERENCES companies(id),
  FOREIGN KEY (routing_plan_id) REFERENCES fab_routing_plans(id),
  KEY idx_frod_plan (routing_plan_id),
  KEY idx_frod_from (from_step_id),
  KEY idx_frod_to   (to_step_id)
);

CREATE TABLE IF NOT EXISTS fab_routing_op_inputs (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  company_id     INT            NOT NULL,
  step_id        INT            NOT NULL,
  source_type    ENUM('bom_item','op_output') NOT NULL DEFAULT 'bom_item',
  bom_item_id    INT            NULL,
  source_step_id INT            NULL,
  label          VARCHAR(255)   NULL,
  qty            DECIMAL(14,4)  NULL,
  uom            VARCHAR(20)    NULL,
  notes          TEXT           NULL,
  deleted_at     DATETIME       NULL,
  created_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_froi_step    (step_id),
  KEY idx_froi_company (company_id)
);

CREATE TABLE IF NOT EXISTS fab_routing_op_outputs (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  company_id  INT            NOT NULL,
  step_id     INT            NOT NULL,
  name        VARCHAR(255)   NOT NULL,
  output_type ENUM('wip','final','scrap') NOT NULL DEFAULT 'wip',
  qty_formula TEXT           NULL,
  uom         VARCHAR(20)    NULL,
  notes       TEXT           NULL,
  deleted_at  DATETIME       NULL,
  created_at  TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_froo_step    (step_id),
  KEY idx_froo_company (company_id)
);

CREATE TABLE IF NOT EXISTS fab_routing_op_formulas (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT            NOT NULL,
  step_id      INT            NOT NULL,
  formula_type ENUM('setup_time','machine_time','people_time','wait_time','move_time') NOT NULL,
  expression   TEXT           NOT NULL,
  output_unit  VARCHAR(20)    NULL DEFAULT 'hours',
  is_valid     TINYINT(1)     NOT NULL DEFAULT 0,
  deleted_at   DATETIME       NULL,
  created_at   TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_frof_step    (step_id),
  KEY idx_frof_company (company_id)
);

-- ===== ALTER: NAME/CODE UNIQUENESS (case-insensitive, soft-delete-aware) =====
-- A plain UNIQUE(company_id, name) would (a) be case-sensitive unless the
-- column's collation already folds case, and (b) block reusing a name/code
-- after the original row is soft-deleted. `name_active`/`code_active` are
-- generated columns that are NULL when deleted_at IS NOT NULL, and MySQL's
-- UNIQUE indexes never enforce uniqueness among NULLs, so soft-deleted rows
-- never collide while still enforcing case-insensitive uniqueness among live rows.
-- NOTE: run TM/fab_erp_dedupe.sql against the target database BEFORE this
-- migration — these ALTERs will fail outright if duplicate active rows exist.

-- fab_resource_types: name_active + unique(company_id, name_active)
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_resource_types'
              AND COLUMN_NAME  = 'name_active');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_resource_types ADD COLUMN name_active VARCHAR(255) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_resource_types'
              AND INDEX_NAME    = 'uq_frt_company_name_active');
SET @sql = IF(@idx = 0,
  'ALTER TABLE fab_resource_types ADD UNIQUE KEY uq_frt_company_name_active (company_id, name_active)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- fab_resource_types: code_active + unique(company_id, code_active)
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_resource_types'
              AND COLUMN_NAME  = 'code_active');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_resource_types ADD COLUMN code_active VARCHAR(100) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_resource_types'
              AND INDEX_NAME    = 'uq_frt_company_code_active');
SET @sql = IF(@idx = 0,
  'ALTER TABLE fab_resource_types ADD UNIQUE KEY uq_frt_company_code_active (company_id, code_active)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- fab_resources: name_active + unique(company_id, name_active)
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_resources'
              AND COLUMN_NAME  = 'name_active');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_resources ADD COLUMN name_active VARCHAR(255) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_resources'
              AND INDEX_NAME    = 'uq_fr_company_name_active');
SET @sql = IF(@idx = 0,
  'ALTER TABLE fab_resources ADD UNIQUE KEY uq_fr_company_name_active (company_id, name_active)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- fab_resources: code_active + unique(company_id, code_active)
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_resources'
              AND COLUMN_NAME  = 'code_active');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_resources ADD COLUMN code_active VARCHAR(100) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_resources'
              AND INDEX_NAME    = 'uq_fr_company_code_active');
SET @sql = IF(@idx = 0,
  'ALTER TABLE fab_resources ADD UNIQUE KEY uq_fr_company_code_active (company_id, code_active)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- fab_item_categories: name_active + unique(company_id, name_active)
-- (code already has UNIQUE KEY uq_fab_item_categories (company_id, code) from CREATE TABLE)
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_item_categories'
              AND COLUMN_NAME  = 'name_active');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_item_categories ADD COLUMN name_active VARCHAR(120) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_item_categories'
              AND INDEX_NAME    = 'uq_fic_company_name_active');
SET @sql = IF(@idx = 0,
  'ALTER TABLE fab_item_categories ADD UNIQUE KEY uq_fic_company_name_active (company_id, name_active)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- fab_item_groups: name_active + unique(company_id, category_id, name_active) — scoped to parent category
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_item_groups'
              AND COLUMN_NAME  = 'name_active');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_item_groups ADD COLUMN name_active VARCHAR(120) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_item_groups'
              AND INDEX_NAME    = 'uq_fig_category_name_active');
SET @sql = IF(@idx = 0,
  'ALTER TABLE fab_item_groups ADD UNIQUE KEY uq_fig_category_name_active (company_id, category_id, name_active)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- fab_item_subgroups: name_active + unique(company_id, group_id, name_active) — scoped to parent group
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_item_subgroups'
              AND COLUMN_NAME  = 'name_active');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_item_subgroups ADD COLUMN name_active VARCHAR(120) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_item_subgroups'
              AND INDEX_NAME    = 'uq_fis_group_name_active');
SET @sql = IF(@idx = 0,
  'ALTER TABLE fab_item_subgroups ADD UNIQUE KEY uq_fis_group_name_active (company_id, group_id, name_active)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- fab_item_catalog: name_active + unique(company_id, name_active)
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_item_catalog'
              AND COLUMN_NAME  = 'name_active');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_item_catalog ADD COLUMN name_active VARCHAR(255) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_item_catalog'
              AND INDEX_NAME    = 'uq_fic2_company_name_active');
SET @sql = IF(@idx = 0,
  'ALTER TABLE fab_item_catalog ADD UNIQUE KEY uq_fic2_company_name_active (company_id, name_active)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- fab_item_catalog: code_active + unique(company_id, code_active)
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_item_catalog'
              AND COLUMN_NAME  = 'code_active');
SET @sql = IF(@col = 0,
  'ALTER TABLE fab_item_catalog ADD COLUMN code_active VARCHAR(100) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'fab_item_catalog'
              AND INDEX_NAME    = 'uq_fic2_company_code_active');
SET @sql = IF(@idx = 0,
  'ALTER TABLE fab_item_catalog ADD UNIQUE KEY uq_fic2_company_code_active (company_id, code_active)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ===== ALTER: PER-ITEM CONFIGURABLE DECIMAL PRECISION =====

-- fab_item_catalog: widen dimension/weight columns to DECIMAL(18,6)
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_item_catalog'
              AND COLUMN_NAME = 'length' AND DATA_TYPE = 'decimal' AND NUMERIC_PRECISION = 18 AND NUMERIC_SCALE = 6);
SET @sql = IF(@col = 0,'ALTER TABLE fab_item_catalog MODIFY COLUMN `length` DECIMAL(18,6) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_item_catalog'
              AND COLUMN_NAME = 'width' AND DATA_TYPE = 'decimal' AND NUMERIC_PRECISION = 18 AND NUMERIC_SCALE = 6);
SET @sql = IF(@col = 0,'ALTER TABLE fab_item_catalog MODIFY COLUMN width DECIMAL(18,6) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_item_catalog'
              AND COLUMN_NAME = 'height' AND DATA_TYPE = 'decimal' AND NUMERIC_PRECISION = 18 AND NUMERIC_SCALE = 6);
SET @sql = IF(@col = 0,'ALTER TABLE fab_item_catalog MODIFY COLUMN height DECIMAL(18,6) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_item_catalog'
              AND COLUMN_NAME = 'gross_weight' AND DATA_TYPE = 'decimal' AND NUMERIC_PRECISION = 18 AND NUMERIC_SCALE = 6);
SET @sql = IF(@col = 0,'ALTER TABLE fab_item_catalog MODIFY COLUMN gross_weight DECIMAL(18,6) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_item_catalog'
              AND COLUMN_NAME = 'net_weight' AND DATA_TYPE = 'decimal' AND NUMERIC_PRECISION = 18 AND NUMERIC_SCALE = 6);
SET @sql = IF(@col = 0,'ALTER TABLE fab_item_catalog MODIFY COLUMN net_weight DECIMAL(18,6) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_item_catalog'
              AND COLUMN_NAME = 'volume' AND DATA_TYPE = 'decimal' AND NUMERIC_PRECISION = 18 AND NUMERIC_SCALE = 6);
SET @sql = IF(@col = 0,'ALTER TABLE fab_item_catalog MODIFY COLUMN volume DECIMAL(18,6) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add dimension_decimals to fab_item_catalog
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='dimension_decimals');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_catalog ADD COLUMN dimension_decimals INT NOT NULL DEFAULT 3','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
