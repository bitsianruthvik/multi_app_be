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

-- ===== DROP: MRP/Scheduler + legacy visual routing-graph (EU-15, 2026-07-14) =====
-- Superseded by the DAG task engine (fab_project_tasks/fab_bom_flow_bindings) —
-- routes/mrp.js, routes/scheduler.js, routes/planner.js, routes/orders.js,
-- routes/routing.js, services/plannedOpService.js, services/schedulerService.js
-- were all deleted in the same change. Full clean removal (pre-live, user-approved) —
-- not a deprecate-in-place.
DROP TABLE IF EXISTS fab_resource_assignments;
DROP TABLE IF EXISTS fab_planned_operations;
DROP TABLE IF EXISTS fab_routing_op_deps;
DROP TABLE IF EXISTS fab_routing_op_inputs;
DROP TABLE IF EXISTS fab_routing_op_outputs;
DROP TABLE IF EXISTS fab_routing_op_formulas;
DROP TABLE IF EXISTS fab_routing_op_steps;
DROP TABLE IF EXISTS fab_routing_plans;

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

-- fab_planned_operations / fab_resource_assignments removed 2026-07-14 (EU-15) —
-- superseded by fab_project_tasks (DAG task engine). See top-of-file DROP section.

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

-- fab_planned_operations column-guard ALTERs removed 2026-07-14 (EU-15) — table dropped.

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
-- fab_routing_plans / fab_routing_op_steps / _deps / _inputs / _outputs / _formulas
-- removed 2026-07-14 (EU-15) — the visual routing-graph builder is superseded by
-- Operations/Operation Flows (fab_operation_flows/_steps) + fab_bom_flow_bindings.
-- See top-of-file DROP section.

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

-- ===== TRACEABILITY (batch / serial / heat / mark) =====
--
-- Traceability requirements live on the Category ("Item Type") and can be
-- overridden per item. `@col` gates both the ALTERs and the one-time default
-- seed below it — if the columns already exist, neither runs again, so a
-- user's later edits to these flags are never clobbered on server restart.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_categories' AND COLUMN_NAME='batch_required');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_categories ADD COLUMN batch_required TINYINT(1) NOT NULL DEFAULT 0','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_item_categories ADD COLUMN serial_required TINYINT(1) NOT NULL DEFAULT 0','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_item_categories ADD COLUMN heat_required TINYINT(1) NOT NULL DEFAULT 0','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_item_categories ADD COLUMN mark_required TINYINT(1) NOT NULL DEFAULT 0','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- One-time default rules for the standard seeded taxonomy (only fires the
-- first time the columns above are created).
SET @sql = IF(@col=0,"UPDATE fab_item_categories SET batch_required=1, heat_required=1 WHERE code='rm' AND is_system=1",'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,"UPDATE fab_item_categories SET batch_required=1 WHERE code='cons' AND is_system=1",'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,"UPDATE fab_item_categories SET mark_required=1 WHERE code='sfg' AND is_system=1",'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,"UPDATE fab_item_categories SET mark_required=1 WHERE code='fg' AND is_system=1",'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Item-level overrides — NULL means "inherit from Category".
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='batch_required_override');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_catalog ADD COLUMN batch_required_override TINYINT(1) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_item_catalog ADD COLUMN serial_required_override TINYINT(1) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_item_catalog ADD COLUMN heat_required_override TINYINT(1) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_item_catalog ADD COLUMN mark_required_override TINYINT(1) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Split the single free-text batch_code into four typed identifiers so stock
-- can be broken out by tracking type. batch_code is kept (now nullable) as a
-- legacy display fallback for rows created before this migration.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_batches' AND COLUMN_NAME='batch_no');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_batches MODIFY COLUMN batch_code VARCHAR(60) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_item_batches ADD COLUMN batch_no VARCHAR(60) NULL AFTER batch_code','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_item_batches ADD COLUMN serial_no VARCHAR(60) NULL AFTER batch_no','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_item_batches ADD COLUMN heat_no VARCHAR(60) NULL AFTER serial_no','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_item_batches ADD COLUMN mark_no VARCHAR(60) NULL AFTER heat_no','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'UPDATE fab_item_batches SET batch_no = batch_code WHERE batch_no IS NULL AND batch_code IS NOT NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_item_batches DROP INDEX uq_fab_item_batches','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_item_batches ADD UNIQUE KEY uq_fab_item_batches (company_id, catalog_item_id, plant_id, stock_location_id, batch_no, serial_no, heat_no, mark_no)','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Same four identifiers on the GRN line (source of truth at receipt time).
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_grn_lines' AND COLUMN_NAME='batch_no');
SET @sql = IF(@col=0,'ALTER TABLE fab_grn_lines MODIFY COLUMN batch_code VARCHAR(60) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_grn_lines ADD COLUMN batch_no VARCHAR(60) NULL AFTER batch_code','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_grn_lines ADD COLUMN serial_no VARCHAR(60) NULL AFTER batch_no','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_grn_lines ADD COLUMN heat_no VARCHAR(60) NULL AFTER serial_no','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_grn_lines ADD COLUMN mark_no VARCHAR(60) NULL AFTER heat_no','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'UPDATE fab_grn_lines SET batch_no = batch_code WHERE batch_no IS NULL AND batch_code IS NOT NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Same four identifiers on the stock ledger (audit trail).
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_ledger' AND COLUMN_NAME='batch_no');
SET @sql = IF(@col=0,'ALTER TABLE fab_stock_ledger MODIFY COLUMN batch_code VARCHAR(60) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_stock_ledger ADD COLUMN batch_no VARCHAR(60) NULL AFTER batch_code','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_stock_ledger ADD COLUMN serial_no VARCHAR(60) NULL AFTER batch_no','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_stock_ledger ADD COLUMN heat_no VARCHAR(60) NULL AFTER serial_no','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_stock_ledger ADD COLUMN mark_no VARCHAR(60) NULL AFTER heat_no','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'UPDATE fab_stock_ledger SET batch_no = batch_code WHERE batch_no IS NULL AND batch_code IS NOT NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add shortform to fab_item_categories, fab_item_groups, fab_item_subgroups
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_categories' AND COLUMN_NAME='shortform');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_categories ADD COLUMN shortform VARCHAR(10) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_groups' AND COLUMN_NAME='shortform');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_groups ADD COLUMN shortform VARCHAR(10) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_subgroups' AND COLUMN_NAME='shortform');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_subgroups ADD COLUMN shortform VARCHAR(10) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

UPDATE fab_item_categories SET shortform = LEFT(code, 10) WHERE shortform IS NULL;
UPDATE fab_item_groups SET shortform = LEFT(code, 10) WHERE shortform IS NULL;
UPDATE fab_item_subgroups SET shortform = LEFT(code, 10) WHERE shortform IS NULL;

-- ===== STOCK PIECE REDESIGN (2026-07-10) =====
--
-- Replaces the batch-level `fab_item_batches` / `fab_stock_balances` model
-- with a piece-level `fab_stock_pieces` table (one row per receivable unit
-- of stock, carrying its own batch/heat/serial/mark identifiers). The stock
-- ledger gains a `piece_id` pointer for new code to write against; old
-- batch_id/batch_code columns are left in place (unused going forward) so a
-- parallel in-progress unit (EU-3) can still reference them if needed.

-- 1. New table: fab_stock_pieces
CREATE TABLE IF NOT EXISTS fab_stock_pieces (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  company_id        INT            NOT NULL,
  catalog_item_id   INT            NOT NULL,
  plant_id          INT            NOT NULL,
  stock_location_id INT            NOT NULL,
  batch_no          VARCHAR(60)    NULL,
  heat_no           VARCHAR(60)    NULL,
  serial_no         VARCHAR(60)    NULL,
  mark_no           VARCHAR(60)    NULL,
  qty               DECIMAL(14,4)  NOT NULL DEFAULT 0,
  uom               VARCHAR(20)    NULL,
  unit_cost         DECIMAL(14,4)  NULL,
  status            VARCHAR(20)    NOT NULL DEFAULT 'in_stock',
  grn_id            INT            NULL,
  grn_line_id       INT            NULL,
  received_date     DATE           NULL,
  notes             TEXT           NULL,
  created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at        TIMESTAMP      NULL,
  KEY idx_fsp_company (company_id),
  KEY idx_fsp_item    (catalog_item_id),
  KEY idx_fsp_grn     (grn_id)
);

-- 2. Drop obsolete tables (superseded by fab_stock_pieces / confirmed dead)
DROP TABLE IF EXISTS fab_item_batches;
DROP TABLE IF EXISTS fab_stock_balances;
DROP TABLE IF EXISTS fab_item_config_values;

-- 3. Drop traceability flag columns from the item taxonomy tables.
-- NOTE: as of this migration, batch_required/serial_required/heat_required/
-- mark_required only actually exist on fab_item_categories (see the
-- "TRACEABILITY" block above) — fab_item_groups and fab_item_subgroups never
-- had them added. The guards below are no-ops for those two tables but are
-- included for completeness/safety in case a future migration adds them.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_categories' AND COLUMN_NAME='batch_required');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_categories DROP COLUMN batch_required','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_categories' AND COLUMN_NAME='serial_required');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_categories DROP COLUMN serial_required','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_categories' AND COLUMN_NAME='heat_required');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_categories DROP COLUMN heat_required','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_categories' AND COLUMN_NAME='mark_required');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_categories DROP COLUMN mark_required','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_groups' AND COLUMN_NAME='batch_required');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_groups DROP COLUMN batch_required','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_groups' AND COLUMN_NAME='serial_required');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_groups DROP COLUMN serial_required','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_groups' AND COLUMN_NAME='heat_required');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_groups DROP COLUMN heat_required','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_groups' AND COLUMN_NAME='mark_required');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_groups DROP COLUMN mark_required','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_subgroups' AND COLUMN_NAME='batch_required');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_subgroups DROP COLUMN batch_required','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_subgroups' AND COLUMN_NAME='serial_required');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_subgroups DROP COLUMN serial_required','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_subgroups' AND COLUMN_NAME='heat_required');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_subgroups DROP COLUMN heat_required','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_subgroups' AND COLUMN_NAME='mark_required');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_subgroups DROP COLUMN mark_required','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='batch_required_override');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_catalog DROP COLUMN batch_required_override','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='serial_required_override');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_catalog DROP COLUMN serial_required_override','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='heat_required_override');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_catalog DROP COLUMN heat_required_override','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='mark_required_override');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_catalog DROP COLUMN mark_required_override','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 4. Strip descriptive/dimensional columns from fab_item_catalog (moved out
-- of scope for this app's item master; not referenced by stock pieces).
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='gross_weight');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_catalog DROP COLUMN gross_weight','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='net_weight');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_catalog DROP COLUMN net_weight','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='weight_unit');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_catalog DROP COLUMN weight_unit','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='volume');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_catalog DROP COLUMN volume','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='volume_unit');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_catalog DROP COLUMN volume_unit','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='length');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_catalog DROP COLUMN `length`','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='width');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_catalog DROP COLUMN width','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='height');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_catalog DROP COLUMN height','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='dimension_unit');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_catalog DROP COLUMN dimension_unit','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='dimension_decimals');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_catalog DROP COLUMN dimension_decimals','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='barcode');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_catalog DROP COLUMN barcode','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='division');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_catalog DROP COLUMN division','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='material_type');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_catalog DROP COLUMN material_type','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='purchase_cost');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_catalog DROP COLUMN purchase_cost','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 5. Replace mrp_active (boolean) with mrp_policy (enum). Order matters:
-- ADD mrp_policy -> backfill from mrp_active -> DROP mrp_active, so the
-- backfill only ever runs once, while mrp_active still exists.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='mrp_policy');
SET @sql = IF(@col=0,"ALTER TABLE fab_item_catalog ADD COLUMN mrp_policy ENUM('manual','reorder_point','lot_for_lot') NOT NULL DEFAULT 'lot_for_lot'",'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='mrp_active');
SET @sql = IF(@col>0,"UPDATE fab_item_catalog SET mrp_policy = IF(mrp_active = 1, 'lot_for_lot', 'manual')",'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='mrp_active');
SET @sql = IF(@col>0,'ALTER TABLE fab_item_catalog DROP COLUMN mrp_active','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 6. fab_stock_ledger: add piece_id for new code to write against, near
-- batch_id (the column it supersedes). batch_id/batch_code and the
-- batch_no/heat_no/serial_no/mark_no snapshot columns (added earlier, see
-- ~line 1653-1666) are left in place as denormalized audit-trail fields.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_ledger' AND COLUMN_NAME='piece_id');
SET @sql = IF(@col=0,'ALTER TABLE fab_stock_ledger ADD COLUMN piece_id INT NULL AFTER batch_id','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_ledger' AND INDEX_NAME='idx_fab_stock_ledger_piece');
SET @sql = IF(@idx=0,'ALTER TABLE fab_stock_ledger ADD KEY idx_fab_stock_ledger_piece (piece_id)','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Confirm batch_no/heat_no/serial_no/mark_no snapshot columns exist on
-- fab_stock_ledger (they should already be present from the migration at
-- ~line 1653-1666; guarded here defensively so this section is self-contained).
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_ledger' AND COLUMN_NAME='batch_no');
SET @sql = IF(@col=0,'ALTER TABLE fab_stock_ledger ADD COLUMN batch_no VARCHAR(60) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_ledger' AND COLUMN_NAME='heat_no');
SET @sql = IF(@col=0,'ALTER TABLE fab_stock_ledger ADD COLUMN heat_no VARCHAR(60) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_ledger' AND COLUMN_NAME='serial_no');
SET @sql = IF(@col=0,'ALTER TABLE fab_stock_ledger ADD COLUMN serial_no VARCHAR(60) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_ledger' AND COLUMN_NAME='mark_no');
SET @sql = IF(@col=0,'ALTER TABLE fab_stock_ledger ADD COLUMN mark_no VARCHAR(60) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 7. Relax remaining legacy NOT NULL columns left over from the dropped
-- fab_item_batches model, so grnService.js's piece-level writes no longer
-- need placeholder values to satisfy them.
--
-- Verified against the current schema (live DESCRIBE, not just this file's
-- implied history) before writing this block:
--   - fab_grn_lines.batch_code   -> already NULLable (nulled by the
--     "Same four identifiers on the GRN line" guarded block above, ~line 1640,
--     which runs the first time batch_no is added to this table).
--   - fab_stock_ledger.batch_code -> already NULLable, same reasoning, via
--     the "Same four identifiers on the stock ledger" block above (~line 1655).
--   - fab_stock_ledger.batch_id  -> STILL `INT NOT NULL` (base CREATE TABLE,
--     ~line 539). No prior block ever MODIFY'd this column, so it's the only
--     one of the three actually requiring a change here.
--
-- MODIFY COLUMN to relax NOT NULL -> NULL is naturally idempotent (safe to
-- re-run), so no information_schema guard is needed for it specifically, but
-- the columns are still only touched where confirmed necessary above. The
-- batch_code MODIFYs are included defensively (harmless no-ops on this DB,
-- but keep this block self-contained for any environment where the earlier
-- guarded blocks were skipped for some reason, e.g. a partially-migrated DB).
ALTER TABLE fab_stock_ledger MODIFY COLUMN batch_id INT NULL;
ALTER TABLE fab_stock_ledger MODIFY COLUMN batch_code VARCHAR(60) NULL;
ALTER TABLE fab_grn_lines MODIFY COLUMN batch_code VARCHAR(60) NULL;

-- ===== Operations / Operation Flows (flat routing model) =====

CREATE TABLE IF NOT EXISTS fab_operations (
  id                       INT AUTO_INCREMENT PRIMARY KEY,
  company_id               INT           NOT NULL,
  name                     VARCHAR(255)  NOT NULL,
  code                     VARCHAR(100)  NOT NULL,
  default_resource_type_id INT           NULL,
  time_formula             TEXT          NULL,
  time_unit                ENUM('min','hr','sec') NOT NULL DEFAULT 'min',
  active                   TINYINT(1)    NOT NULL DEFAULT 1,
  deleted_at               DATETIME      DEFAULT NULL,
  created_at               TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  name_active              VARCHAR(255)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL,
  code_active              VARCHAR(100)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE KEY uq_fop_name (company_id, name_active),
  UNIQUE KEY uq_fop_code (company_id, code_active),
  KEY idx_fop_company (company_id)
);

CREATE TABLE IF NOT EXISTS fab_operation_variables (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  company_id    INT           NOT NULL,
  operation_id  INT           NOT NULL,
  var_key       VARCHAR(64)   NOT NULL,
  label         VARCHAR(255)  NOT NULL,
  unit          VARCHAR(32)   NULL,
  default_value DECIMAL(18,4) NULL,
  sort_order    INT           NOT NULL DEFAULT 0,
  deleted_at    DATETIME      DEFAULT NULL,
  created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE KEY uq_fopv (operation_id, var_key),
  KEY idx_fopv_op (operation_id)
);

CREATE TABLE IF NOT EXISTS fab_operation_resource_types (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  company_id       INT NOT NULL,
  operation_id     INT NOT NULL,
  resource_type_id INT NOT NULL,
  deleted_at       DATETIME      DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE KEY uq_fort (operation_id, resource_type_id),
  KEY idx_fort_op (operation_id),
  KEY idx_fort_rt (resource_type_id)
);

CREATE TABLE IF NOT EXISTS fab_operation_flows (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT           NOT NULL,
  name      VARCHAR(255)  NOT NULL,
  code      VARCHAR(100)  NOT NULL,
  active    TINYINT(1)    NOT NULL DEFAULT 1,
  deleted_at DATETIME      DEFAULT NULL,
  created_at TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  name_active VARCHAR(255) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL,
  code_active VARCHAR(100) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE KEY uq_fofl_name (company_id, name_active),
  UNIQUE KEY uq_fofl_code (company_id, code_active),
  KEY idx_fofl_company (company_id)
);

CREATE TABLE IF NOT EXISTS fab_operation_flow_steps (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  company_id       INT           NOT NULL,
  flow_id          INT           NOT NULL,
  operation_id     INT           NOT NULL,
  seq_no           INT           NOT NULL,
  depends_on       VARCHAR(255)  NULL,
  resource_type_id INT           NULL,
  notes            TEXT          NULL,
  deleted_at       DATETIME      DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fofs_flow (flow_id)
);

-- BOM ↔ Operation Flow attach: links a manufacturing flow to a BOM header
CREATE TABLE IF NOT EXISTS fab_bom_flow_bindings (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT           NOT NULL,
  bom_id     INT           NOT NULL,
  flow_id    INT           NOT NULL,
  active     TINYINT(1)    NOT NULL DEFAULT 1,
  deleted_at DATETIME      DEFAULT NULL,
  created_at TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fbfb_company (company_id),
  KEY idx_fbfb_bom     (bom_id),
  KEY idx_fbfb_flow    (flow_id)
);

-- ===== Project Task Queue (EU-4) =====
-- Materialized, per-item tasks generated from an operation flow's steps.
-- All cross-refs below (project_id, item_id, flow_id, flow_step_id, operation_id,
-- resource_type_id, assigned_resource_id) follow the established fab_erp
-- convention: plain INT + KEY index, no FK, so soft-deleted parent rows never
-- block inserts/updates here (see fab_operation_flow_steps above for the same
-- pattern). Only company_id gets a real FK. Lifecycle transitions (status,
-- started_at, etc.) are written exclusively via dedicated routes in a later
-- unit, not through the generic /mutate writeFields list.
CREATE TABLE IF NOT EXISTS fab_project_tasks (
  id                              INT AUTO_INCREMENT PRIMARY KEY,
  company_id                      INT           NOT NULL,
  project_id                      INT           NOT NULL,
  item_id                         INT           NOT NULL,
  flow_id                         INT           NOT NULL,
  flow_step_id                    INT           NOT NULL,
  operation_id                    INT           NOT NULL,
  seq_no                          INT           NOT NULL,
  depends_on                      VARCHAR(255)  NULL,
  resource_type_id                INT           NULL,
  assigned_resource_id            INT           NULL,
  status                          ENUM('blocked','eligible','in_progress','paused','done','cancelled') NOT NULL DEFAULT 'blocked',
  deps_cleared_at                 DATETIME      NULL,
  queued_at                       DATETIME      NULL,
  started_at                      DATETIME      NULL,
  paused_at                       DATETIME      NULL,
  completed_at                    DATETIME      NULL,
  wait_working_minutes            INT           NOT NULL DEFAULT 0,
  blocked_by_other_tasks_minutes  INT           NOT NULL DEFAULT 0,
  idle_wait_minutes               INT           NOT NULL DEFAULT 0,
  delay_reason                    ENUM('lack_of_manpower','machine_down','lack_of_consumable','planning_issue','minor_operational_delay') NULL,
  computed_hours                  DECIMAL(10,2) NULL,
  sort_order                      INT           NOT NULL DEFAULT 0,
  deleted_at                      DATETIME      DEFAULT NULL,
  created_at                      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at                      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fpjt_company        (company_id),
  KEY idx_fpjt_project        (project_id),
  KEY idx_fpjt_item           (item_id),
  KEY idx_fpjt_flow           (flow_id),
  KEY idx_fpjt_flow_step      (flow_step_id),
  KEY idx_fpjt_operation      (operation_id),
  KEY idx_fpjt_resource_type  (resource_type_id),
  KEY idx_fpjt_assigned_res   (assigned_resource_id),
  KEY idx_fpjt_status         (company_id, status),
  KEY idx_fpjt_seq            (item_id, seq_no)
);

-- ===== BOM Templates (EU-12) =====
-- Reusable, parameterized BOM patterns. A template has a tree of nodes
-- (assembly/intermediate/raw_material, self-referencing via parent_node_id,
-- mirroring fab_material_bom_items.parent_bom_item_id) and raw_material nodes
-- may carry one or more parameterized material "slots" instead of a fixed
-- catalog item.

-- Header: one row per reusable BOM pattern. name/code uniqueness follows the
-- established case-insensitive, soft-delete-aware VIRTUAL column pattern used
-- by fab_operations / fab_operation_flows / fab_resource_types etc.
CREATE TABLE IF NOT EXISTS fab_bom_templates (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  name         VARCHAR(255)  NOT NULL,
  code         VARCHAR(100)  NOT NULL,
  base_qty     DECIMAL(18,4) NOT NULL DEFAULT 1,
  base_unit    VARCHAR(50)   NULL,
  active       TINYINT(1)    NOT NULL DEFAULT 1,
  deleted_at   DATETIME      DEFAULT NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  name_active  VARCHAR(255)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL,
  code_active  VARCHAR(100)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE KEY uq_fbt_name (company_id, name_active),
  UNIQUE KEY uq_fbt_code (company_id, code_active),
  KEY idx_fbt_company (company_id)
);

-- Tree structure: self-referencing via parent_node_id (mirrors
-- fab_material_bom_items.parent_bom_item_id). ref_catalog_item_id is set for
-- fixed parts and left NULL for parameterized slots (see fab_bom_template_slots).
-- Cross-refs follow the established fab_erp convention: plain INT + KEY index,
-- no FK, except on company_id.
CREATE TABLE IF NOT EXISTS fab_bom_template_nodes (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  company_id          INT           NOT NULL,
  template_id         INT           NOT NULL,
  parent_node_id      INT           NULL,
  node_role           ENUM('assembly','intermediate','raw_material') NOT NULL,
  ref_catalog_item_id INT           NULL,
  qty                 DECIMAL(18,4) NOT NULL DEFAULT 1,
  unit                VARCHAR(50)   NULL,
  sort_order          INT           NOT NULL DEFAULT 0,
  deleted_at          DATETIME      DEFAULT NULL,
  created_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fbtn_company     (company_id),
  KEY idx_fbtn_template    (template_id),
  KEY idx_fbtn_parent      (parent_node_id),
  KEY idx_fbtn_ref_catalog (ref_catalog_item_id)
);

-- Parameterized material choice: one row per raw_material node slot. Stores
-- the target dimension/attribute criteria (dimension_params JSON) and the
-- strategy used to resolve a concrete catalog item at BOM-instantiation time.
CREATE TABLE IF NOT EXISTS fab_bom_template_slots (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  company_id              INT           NOT NULL,
  template_id             INT           NOT NULL,
  node_id                 INT           NOT NULL,
  slot_key                VARCHAR(100)  NOT NULL,
  param_label             VARCHAR(255)  NULL,
  catalog_category        VARCHAR(100)  NULL,
  catalog_group           VARCHAR(100)  NULL,
  dimension_params        JSON          NULL,
  selection_strategy      ENUM('available_now','soonest_available','manual') NOT NULL DEFAULT 'available_now',
  default_catalog_item_id INT           NULL,
  deleted_at              DATETIME      DEFAULT NULL,
  created_at              TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fbts_company         (company_id),
  KEY idx_fbts_template        (template_id),
  KEY idx_fbts_node            (node_id),
  KEY idx_fbts_default_catalog (default_catalog_item_id)
);

-- ── fab_operation_flows: description (free-text, shown in the flow list) ──────
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_operation_flows' AND COLUMN_NAME='description');
SET @sql = IF(@col=0,'ALTER TABLE fab_operation_flows ADD COLUMN description TEXT NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
