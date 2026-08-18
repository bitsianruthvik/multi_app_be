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

-- fab_constants was dropped 2026-08. Unused key/value table with no reader.
-- Its CREATE stayed here and would rebuild it on the next run of this file.
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
  txn_date          DATE           NOT NULL,
  notes             TEXT           NULL,
  created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at        TIMESTAMP      NULL,
  KEY idx_fab_stock_ledger_batch (batch_id),
  KEY idx_fab_stock_ledger_item  (company_id, catalog_item_id, plant_id, stock_location_id)
);

-- FEAT-02: material reservations. A task's gated material is earmarked when its
-- gate first clears (status 'active'), so a later task can't clear against the
-- same stock: gating availability = SUM(in_stock pieces) − SUM(active reservations).
-- The reservation is flipped to 'consumed' when the task starts and physically
-- deducts the stock, or 'released' if the task is cancelled / re-materialized.
-- fab_stock_reservations was dropped 2026-08. Earmarking was removed with the material-gate simplification.
-- Its CREATE stayed here and would rebuild it on the next run of this file.
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

-- Dimensions + weight on fab_items (2026-08, see migrations/2026-08-order-bom-dims-weight.sql).
-- Dimensions are entered on the rows that have no children — the cut pieces. Weight is entered
-- at the bottom and rolls up: computed_unit_weight is Σ(child.qty × child effective unit weight),
-- total_weight is (unit_weight ?? computed_unit_weight) × qty. Entered and computed are kept in
-- separate columns so an assembly weighing more than its parts (welds, bolts, paint) reads as an
-- override with a visible gap rather than silently clobbering one value with the other.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='length');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN `length` DECIMAL(18,6) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='width');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN width DECIMAL(18,6) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='height');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN height DECIMAL(18,6) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='dim_unit');
SET @sql = IF(@col=0,"ALTER TABLE fab_items ADD COLUMN dim_unit VARCHAR(10) NOT NULL DEFAULT 'mm'",'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='unit_weight');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN unit_weight DECIMAL(18,6) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='computed_unit_weight');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN computed_unit_weight DECIMAL(18,6) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='total_weight');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN total_weight DECIMAL(18,6) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='weight_unit');
SET @sql = IF(@col=0,"ALTER TABLE fab_items ADD COLUMN weight_unit VARCHAR(10) NOT NULL DEFAULT 'kg'",'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND INDEX_NAME='idx_fi_order_parent');
SET @sql = IF(@idx=0,'ALTER TABLE fab_items ADD INDEX idx_fi_order_parent (order_id, parent_item_id)','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Generated identity code (2026-08, see migrations/2026-08-order-item-codes.sql).
-- <CUSTOMER>-<ORDER NUMBER>-<ABBR>-<ABBR>… — the long code for drawings and paperwork,
-- distinct from `mark`, which is the short thing painted on the steel. Server-issued and
-- frozen once set (itemCodeService only fills blanks), so it is absent from writeFields.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='code');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN code VARCHAR(160) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='code_active');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN code_active VARCHAR(160) GENERATED ALWAYS AS (IF(deleted_at IS NULL, code, NULL)) VIRTUAL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND INDEX_NAME='uq_fi_company_code_active');
SET @sql = IF(@idx=0,'ALTER TABLE fab_items ADD UNIQUE KEY uq_fi_company_code_active (company_id, code_active)','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- nest_no (2026-08, see migrations/2026-08-nest-grouping.sql) — which parts come off
-- the SAME physical plate. Rows sharing (order_id, catalog_item_id, nest_no) are one nest.
-- A label, not a table, so the gate and consumption paths keep reading the per-part rows
-- unchanged; what was missing was only the ability to say "these twenty are one plate".
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='nest_no');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN nest_no VARCHAR(40) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND INDEX_NAME='idx_fi_order_nest');
SET @sql = IF(@idx=0,'ALTER TABLE fab_items ADD INDEX idx_fi_order_nest (order_id, catalog_item_id, nest_no)','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Weight is volume x density (2026-08, see migrations/2026-08-rm-density-and-section-area.sql).
--   flat plate  thickness x width x length x density_kg_m3
--   profile     section_area_mm2 x length x density_kg_m3
-- A profile MUST carry its cross-section: an ISA 100x100x10 is an L with two legs
-- (~1898 mm2), so thickness x width counts one leg and is 47% light, silently.
-- fab_item_catalog.unit_weight / weight_basis DROPPED 2026-08-07 — the per-metre
-- model, replaced by density_kg_m3 + section_area_mm2 below.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='density_kg_m3');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_catalog ADD COLUMN density_kg_m3 DECIMAL(12,3) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='section_area_mm2');
SET @sql = IF(@col=0,'ALTER TABLE fab_item_catalog ADD COLUMN section_area_mm2 DECIMAL(14,3) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Composite Girder / BowString / Tub Girder / Openweb Girder / PEB — drives the structure wizard.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_order_lines' AND COLUMN_NAME='line_type');
SET @sql = IF(@col=0,'ALTER TABLE fab_order_lines ADD COLUMN line_type VARCHAR(40) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- span / girder / segment / part — which level of the BOQ this row is.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='level_kind');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN level_kind VARCHAR(20) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Flow allocation, stage 3 (2026-08, see migrations/2026-08-flow-rules.sql).
-- (line_type, level_kind, code_suffix) -> flow. A DEFAULT is a rule with no suffix.
-- No rule for a level means no flow means nothing to do — spans and girders are
-- groupings and legitimately carry none. See §13 in ARCHITECTURE.md.
CREATE TABLE IF NOT EXISTS fab_flow_rules (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  company_id  INT           NOT NULL,
  line_type   VARCHAR(40)   NULL,
  level_kind  VARCHAR(20)   NOT NULL,
  code_suffix VARCHAR(20)   NULL,
  flow_id     INT           NOT NULL,
  active      TINYINT(1)    NOT NULL DEFAULT 1,
  notes       VARCHAR(255)  NULL,
  deleted_at  DATETIME      DEFAULT NULL,
  created_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_ffr_lookup (company_id, level_kind, line_type)
);

-- 'rule' or 'manual' — so Apply knows what not to overwrite, and so "why does
-- this part have that flow" has an answer.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='flow_source');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN flow_source VARCHAR(20) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- A nested plate is issued from stock ONCE, not once per part cut from it
-- (2026-08, see migrations/2026-08-nest-issue-once.sql). The first task to start on a
-- nest inserts here and consumes; later parts on the same nest find the row and consume
-- nothing. The UNIQUE key is what makes concurrent starts safe. Links with nest_no NULL
-- keep the per-part behaviour every pre-nest order relies on.
CREATE TABLE IF NOT EXISTS fab_nest_issues (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  order_id        INT            NOT NULL,
  catalog_item_id INT            NOT NULL,
  nest_no         VARCHAR(40)    NOT NULL,
  qty             DECIMAL(18,6)  NULL,
  unit            VARCHAR(20)    NULL,
  task_id         INT            NULL,
  item_id         INT            NULL,
  issued_at       DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE KEY uq_fni_nest (company_id, order_id, catalog_item_id, nest_no),
  KEY idx_fni_order (order_id)
);

-- Add bom_id to fab_material_bom_items
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_material_bom_items' AND COLUMN_NAME='bom_id');
SET @sql = IF(@col=0,'ALTER TABLE fab_material_bom_items ADD COLUMN bom_id INT NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Add item_category to fab_material_bom_items
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_material_bom_items' AND COLUMN_NAME='item_category');
SET @sql = IF(@col=0,"ALTER TABLE fab_material_bom_items ADD COLUMN item_category VARCHAR(20) NOT NULL DEFAULT 'component'",'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- fab_material_bom_items.manufacturing_plant_id DROPPED 2026-08-07 — 305 values,
-- zero readers, left over from the removed multi-plant BOM routing.

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
-- fab_sales_orders / fab_so_items were dropped 2026-08-05 (plan Phase 2e).
-- Superseded by fab_orders / fab_order_lines. No code in any app referenced
-- them under either the table name or a fabErpX resource name. Their CREATE
-- statements are removed here as well as dropped in the migration, because
-- /push-to-prod pipes init.sql -- leaving the CREATE would resurrect them on
-- the next deploy.

-- ── Supplier × Item records ─────────────────────────────────────────────────


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

-- The GRN line carried the same four traceability identifiers. fab_grn_lines
-- went with the purchase side (2026-08, goods receipt replaced by direct
-- stock-in), and its guarded block had to go with it: the guard counted
-- columns on the table, so once the table vanished the count was 0 and every
-- ALTER inside fired against nothing.

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
  received_date     DATE           NULL,
  notes             TEXT           NULL,
  -- WIP model: ties a work-in-process / produced piece to the fab_items node
  -- (order BOM instance) it belongs to, so the single WIP piece can be located
  -- as it moves machine→machine and finalized at the terminal step.
  wip_item_id       INT            NULL,
  created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at        TIMESTAMP      NULL,
  KEY idx_fsp_company (company_id),
  KEY idx_fsp_item    (catalog_item_id),
  KEY idx_fsp_wip     (company_id, wip_item_id)
);

-- Idempotent add of wip_item_id for DBs created before the WIP-inventory feature.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_pieces' AND COLUMN_NAME='wip_item_id');
SET @sql = IF(@col=0,'ALTER TABLE fab_stock_pieces ADD COLUMN wip_item_id INT NULL AFTER notes','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_pieces' AND INDEX_NAME='idx_fsp_wip');
SET @sql = IF(@idx=0,'ALTER TABLE fab_stock_pieces ADD KEY idx_fsp_wip (company_id, wip_item_id)','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

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

-- Per-flow-step material/component/consumable inputs. Declares what an
-- operation consumes; ref_bom_role ('raw_material'|'child_parts') is resolved
-- against the item's BOM at materialize time, ref_catalog_item_id is a fixed
-- consumable. gate=1 means the step's eligibility waits on this input being
-- available (stock present for materials/consumables, producing task done for
-- components). See taskGatingService.js.
CREATE TABLE IF NOT EXISTS fab_operation_flow_step_inputs (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  company_id          INT           NOT NULL,
  flow_step_id        INT           NOT NULL,
  input_role          VARCHAR(30)   NOT NULL,
  ref_catalog_item_id INT           NULL,
  ref_bom_role        VARCHAR(50)   NULL,
  qty                 DECIMAL(18,4)  NULL,
  unit                VARCHAR(20)   NULL,
  gate                TINYINT(1)    NOT NULL DEFAULT 0,
  notes               VARCHAR(255)  NULL,
  deleted_at          DATETIME      DEFAULT NULL,
  created_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_ofsi_company (company_id),
  KEY idx_ofsi_step    (flow_step_id)
);

-- fab_operation_flow_step_outputs DROPPED 2026-08-07. It declared what a flow
-- step produces, for make→make chaining, but no reader was ever written and it
-- held 3 rows of test data. Step INPUTS above are live and drive the gate.

-- Materialized per-task copy of the flow step's gated inputs. Written by
-- materializeTasks; satisfied_at is stamped when the input becomes available.
-- A blocked task clears to 'eligible' only when process predecessors are done
-- AND every gate=1 row here is satisfied.
CREATE TABLE IF NOT EXISTS fab_task_inputs (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  company_id          INT           NOT NULL,
  task_id             INT           NOT NULL,
  order_id            INT           NULL,
  input_role          VARCHAR(30)   NOT NULL,
  ref_catalog_item_id INT           NULL,
  producing_item_id   INT           NULL,
  qty                 DECIMAL(18,4)  NULL,
  unit                VARCHAR(20)   NULL,
  gate                TINYINT(1)    NOT NULL DEFAULT 0,
  satisfied_at        DATETIME      NULL,
  deleted_at          DATETIME      DEFAULT NULL,
  created_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fti_company (company_id),
  KEY idx_fti_task    (task_id),
  KEY idx_fti_producing (producing_item_id)
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
  -- FEAT-05: production output captured at completion (/tasks/:id/stop).
  produced_qty                    DECIMAL(18,4) NULL,          -- good units produced (NULL until stopped)
  scrap_qty                       DECIMAL(18,4) NOT NULL DEFAULT 0,
  qc_result                       ENUM('pass','fail') NULL,    -- NULL until stopped; 'fail' spawns a rework task
  is_rework                       TINYINT(1)    NOT NULL DEFAULT 0,
  rework_of_task_id               INT           NULL,          -- the QC-failed task this reworks
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




-- ── fab_operation_flows: description (free-text, shown in the flow list) ──────
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_operation_flows' AND COLUMN_NAME='description');
SET @sql = IF(@col=0,'ALTER TABLE fab_operation_flows ADD COLUMN description TEXT NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ===== Collapse fab_projects -> fab_orders (EU-1, 2026-07-15) =====
-- A sales order IS the project now — fab_items.project_id and
-- fab_project_tasks.project_id are repointed to fab_orders.id, and the
-- standalone fab_projects / fab_project_items tables are dropped outright.
-- Full clean removal (pre-live, user-approved), matching the MRP/Scheduler
-- removal precedent at the top of this file. Idempotent — safe to re-run.

-- fab_items' FK into fab_projects has an auto-generated constraint name
-- that can differ across environments (local MySQL vs TiDB), so it must be
-- looked up dynamically rather than hardcoded.
SET @fk_name = (SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND REFERENCED_TABLE_NAME='fab_projects' LIMIT 1);
SET @sql = IF(@fk_name IS NOT NULL, CONCAT('ALTER TABLE fab_items DROP FOREIGN KEY ', @fk_name), 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='project_id');
SET @sql = IF(@col=1,'ALTER TABLE fab_items CHANGE COLUMN project_id order_id INT NOT NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx_old = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND INDEX_NAME='idx_fi_project');
SET @idx_new = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND INDEX_NAME='idx_fi_order');
SET @sql = IF(@idx_old>0 AND @idx_new=0,'ALTER TABLE fab_items RENAME INDEX idx_fi_project TO idx_fi_order','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='flow_id');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN flow_id INT NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND INDEX_NAME='idx_fi_flow');
SET @sql = IF(@idx=0,'ALTER TABLE fab_items ADD KEY idx_fi_flow (flow_id)','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Sanity check: every fab_items.order_id must map to a real fab_orders.id
-- before the new FK can be safely added. If orphans exist, skip the FK add
-- (no-op) rather than fail the whole script — do not force the FK against
-- orphaned data.
SET @fk_exists = (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND CONSTRAINT_NAME='fab_items_order_fk');
SET @orphan_count = (SELECT COUNT(*) FROM fab_items WHERE order_id NOT IN (SELECT id FROM fab_orders));
SET @sql = IF(@fk_exists=0 AND @orphan_count=0,'ALTER TABLE fab_items ADD CONSTRAINT fab_items_order_fk FOREIGN KEY (order_id) REFERENCES fab_orders(id)','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- fab_project_tasks has no FK into fab_projects (only company_id is FK'd,
-- confirmed via information_schema.KEY_COLUMN_USAGE) — this rename is
-- metadata-only.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_project_tasks' AND COLUMN_NAME='project_id');
SET @sql = IF(@col=1,'ALTER TABLE fab_project_tasks CHANGE COLUMN project_id order_id INT NOT NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx_old = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_project_tasks' AND INDEX_NAME='idx_fpjt_project');
SET @idx_new = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_project_tasks' AND INDEX_NAME='idx_fpjt_order');
SET @sql = IF(@idx_old>0 AND @idx_new=0,'ALTER TABLE fab_project_tasks RENAME INDEX idx_fpjt_project TO idx_fpjt_order','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- fab_project_items has real FKs to fab_projects/fab_item_catalog/fab_plants;
-- dropping the table drops those FKs with it. DROP TABLE IF EXISTS is valid
-- MySQL syntax and needs no guard.
DROP TABLE IF EXISTS fab_project_items;

-- fab_projects can only be dropped once nothing still holds a live FK into
-- it (fab_items' FK dropped above; fab_project_items dropped above). Recheck
-- dynamically rather than assume — if an unexpected referencing table is
-- found, skip the drop (no-op) instead of guessing.
SET @other_fk = (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='fab_projects');
SET @sql = IF(@other_fk=0,'DROP TABLE IF EXISTS fab_projects','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ===== fab_orders.customer_id (EU-1 gap fix, 2026-07-16) =====
-- resourceDef.json's fabErpOrder "customer" relation always joined
-- fo.customer_id = fcus_o.id, but the EU-1 collapse of fab_projects into
-- fab_orders never actually added that column — every fabErpOrder query
-- failed with "Unknown column 'fo.customer_id' in 'on clause'", which the
-- frontend swallows and renders as an empty Orders list. Plain INT + KEY
-- index, no FK, matching the established cross-ref convention elsewhere in
-- this file (see fab_operation_flow_steps).
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_orders' AND COLUMN_NAME='customer_id');
SET @sql = IF(@col=0,'ALTER TABLE fab_orders ADD COLUMN customer_id INT NULL AFTER customer_name','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_orders' AND INDEX_NAME='idx_fo_customer');
SET @sql = IF(@idx=0,'ALTER TABLE fab_orders ADD KEY idx_fo_customer (customer_id)','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- FEAT-03 (2026-07-23): persisted task-count completion % (0-100) for the Orders
-- board, maintained by taskEngineService.rollUpOrderStatus on every task event.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_orders' AND COLUMN_NAME='progress_pct');
SET @sql = IF(@col=0,'ALTER TABLE fab_orders ADD COLUMN progress_pct TINYINT UNSIGNED NOT NULL DEFAULT 0','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ===== Shop-Floor Time Intelligence (Phase 1) =====
-- EU-1: event tables + operator assignment. Append-only event logs feed the
-- (not-yet-built) wait-attribution engine; fab_task_wait_segments is the
-- computed/materialized output of that engine, written by a backend job, not
-- by users directly. All five tables follow the established fab_erp
-- convention: only company_id gets a real FOREIGN KEY, every other cross-ref
-- (task_id, resource_id, entered_by, user_id, superseded_by_event_id) is a
-- plain INT + KEY index so a soft-deleted parent never blocks a write.

-- Append-only log of task lifecycle events (deps cleared, materials ready,
-- queued, started, paused, resumed, completed, cancelled, or a free-text
-- state_note). source distinguishes events entered live on the shop floor
-- from backfilled/system-generated ones. superseded_by_event_id lets a
-- correction event point at the event it replaces without deleting history.
CREATE TABLE IF NOT EXISTS fab_task_events (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  company_id              INT           NOT NULL,
  task_id                 INT           NOT NULL,
  event_type              ENUM('deps_cleared','materials_ready','queued','started','paused','resumed','completed','cancelled','state_note') NOT NULL,
  at                      DATETIME      NOT NULL,
  source                  ENUM('live','backfill','system') NOT NULL DEFAULT 'live',
  entered_by              INT           NULL,
  note                    VARCHAR(500)  NULL,
  superseded_by_event_id  INT           NULL,
  deleted_at              DATETIME      DEFAULT NULL,
  created_at              TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fte_company_task_at (company_id, task_id, at),
  KEY idx_fte_task_type        (task_id, event_type)
);

-- Append-only log of resource (machine) state changes: running/idle/down/off,
-- with an optional reason_code (see fab_resource_downtime_reasons). Same
-- source/entered_by/note/superseded_by_event_id pattern as fab_task_events.
CREATE TABLE IF NOT EXISTS fab_resource_events (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  company_id              INT           NOT NULL,
  resource_id             INT           NOT NULL,
  state                   ENUM('running','idle','down','off') NOT NULL,
  reason_code             VARCHAR(50)   NULL,
  at                      DATETIME      NOT NULL,
  source                  ENUM('live','backfill','system') NOT NULL DEFAULT 'live',
  entered_by              INT           NULL,
  note                    VARCHAR(500)  NULL,
  superseded_by_event_id  INT           NULL,
  deleted_at              DATETIME      DEFAULT NULL,
  created_at              TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fre_company_resource_at (company_id, resource_id, at)
);

-- Per-company configurable downtime reason codes, picked from when logging a
-- fab_resource_events 'down' state. Deliberately NOT seeded with any rows
-- here (or anywhere in init.sql) — when a company has zero rows in this
-- table, the API layer falls back to the built-in default reason list:
-- breakdown, maintenance, no_operator, no_power, other.
CREATE TABLE IF NOT EXISTS fab_resource_downtime_reasons (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  company_id  INT           NOT NULL,
  code        VARCHAR(50)   NOT NULL,
  label       VARCHAR(255)  NOT NULL,
  active      TINYINT(1)    NOT NULL DEFAULT 1,
  deleted_at  DATETIME      DEFAULT NULL,
  created_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_frdr_company (company_id)
);

-- Operator-to-resource assignment. A row with absent_on IS NULL is a standing
-- assignment (this user normally operates this resource); a row with
-- absent_on set marks that specific operator absent on that date (used by
-- the wait-attribution engine to explain no_operator idle time). The unique
-- key relies on MySQL treating NULLs as distinct values in a unique index —
-- multiple standing-assignment rows (absent_on NULL) for the same
-- resource_id/user_id pair are not blocked by this key, which is acceptable
-- here since a standing assignment is naturally a single row per pair in
-- practice.
CREATE TABLE IF NOT EXISTS fab_resource_operators (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  resource_id  INT           NOT NULL,
  user_id      INT           NOT NULL,
  is_primary   TINYINT(1)    NOT NULL DEFAULT 0,
  absent_on    DATE          NULL,
  deleted_at   DATETIME      DEFAULT NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE KEY uq_fro_resource_user_absent (resource_id, user_id, absent_on),
  KEY idx_fro_company_resource (company_id, resource_id)
);

-- Computed/materialized wait-time segments for a task, classified by reason
-- (waiting on predecessors, materials, shift, a down/busy machine, an absent
-- operator, blocked output, or unexplained idle time). Written by the
-- wait-attribution engine (a later unit), not by users — computed_at records
-- when the engine last (re)computed this segment.
CREATE TABLE IF NOT EXISTS fab_task_wait_segments (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  company_id       INT           NOT NULL,
  task_id          INT           NOT NULL,
  reason           ENUM('waiting_predecessors','waiting_materials','no_shift','machine_down','no_operator','machine_busy','output_blocked','unexplained_idle') NOT NULL,
  seg_start        DATETIME      NOT NULL,
  seg_end          DATETIME      NOT NULL,
  working_minutes  INT           NOT NULL DEFAULT 0,
  computed_at      DATETIME      NULL,
  deleted_at       DATETIME      DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_ftws_company_task   (company_id, task_id),
  KEY idx_ftws_company_reason (company_id, reason)
);

-- ===== Shop-Floor Time Intelligence (Phase 2 — Buffers) =====
-- EU-6: buffers (per-resource input/output staging areas) + their live
-- contents + periodic level snapshots for capacity/overflow monitoring. All
-- three tables follow the established fab_erp convention: only company_id
-- gets a real FOREIGN KEY, every other cross-ref (resource_id,
-- stock_location_id, buffer_id, task_id, item_id) is a plain INT + KEY index
-- so a soft-deleted parent never blocks a write.

-- One row per input/output staging buffer on a resource. Uniqueness on
-- (resource_id, kind) must be soft-delete-aware, so it follows the same
-- generated-VIRTUAL-column idiom used by fab_operations/fab_resource_types/
-- fab_operation_flows (name_active/code_active): kind_active mirrors `kind`
-- while the row is live and goes NULL once deleted_at is set, which releases
-- the uniqueness constraint on soft delete (a NULL component makes MySQL
-- treat the row as distinct from all others in the index) — same mechanism
-- as pairing a real column (company_id) with a generated *_active column
-- there, applied here to the real resource_id column paired with the
-- generated kind_active column.
CREATE TABLE IF NOT EXISTS fab_buffers (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  company_id         INT           NOT NULL,
  resource_id        INT           NOT NULL,
  kind               ENUM('input','output') NOT NULL,
  stock_location_id  INT           NULL,
  capacity_value     DECIMAL(18,4) NULL,
  capacity_uom       VARCHAR(20)   NOT NULL DEFAULT 'kg',
  weight_metric_key  VARCHAR(100)  NOT NULL DEFAULT 'unit_weight_kg',
  warn_pct           TINYINT       NOT NULL DEFAULT 80,
  block_pct          TINYINT       NOT NULL DEFAULT 100,
  active             TINYINT(1)    NOT NULL DEFAULT 1,
  deleted_at         DATETIME      DEFAULT NULL,
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  kind_active        VARCHAR(10)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, kind, NULL)) VIRTUAL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE KEY uq_fb_resource_kind (resource_id, kind_active),
  KEY idx_fb_company_resource (company_id, resource_id)
);


-- Periodic point-in-time snapshots of a buffer's load vs. capacity, written
-- by a backend job (not by users directly) to power buffer-level
-- capacity/overflow monitoring and history charts.

-- ===== Shop-Floor Time Intelligence (Phase 4 — Learned Durations) =====
-- EU-14: rolling per-(operation, resource_type) duration stats, computed
-- nightly by operationStatsService.recomputeAllCompanies() from completed
-- fab_project_tasks' touch time (see fab_task_events). Read by EU-15 to seed
-- estimated durations for not-yet-run tasks of the same operation/resource
-- type. Written exclusively by the backend job — never by users directly.
--
-- Uniqueness on (company_id, operation_id, resource_type_id) needs to be
-- soft-delete-aware AND resource_type_id may legitimately be NULL (an
-- operation with no resource-type breakdown). Mirroring the established
-- generated-column idiom (fab_buffers.kind_active etc.) verbatim doesn't
-- work here because MySQL/TiDB treat every NULL in a unique index as
-- distinct from every other NULL — a plain UNIQUE (company_id, operation_id,
-- resource_type_id) would let the nightly job insert a fresh row each run
-- for any group with a NULL resource_type_id instead of updating the
-- existing one. Fix: resource_type_key COALESCEs NULL resource_type_id to
-- the sentinel 0 (real resource_type_id values are AUTO_INCREMENT and never
-- 0) *and* goes NULL once deleted_at is set, same soft-delete-release
-- mechanism as name_active/kind_active elsewhere in this file. That keeps
-- "no resource type" a single group per (company, operation) while still
-- releasing the key on soft delete.
-- fab_operation_stats was dropped 2026-08. Learned durations were removed; the formula is the estimate.
-- Its CREATE stayed here and would rebuild it on the next run of this file.
-- ===== Progress report templates (Project Progress view, 2026-07-24) =====
-- A template is a named, ordered set of "stages"; each stage clubs one or more
-- operations. It gives the Progress tab a fixed, comparable set of columns per
-- project. A project resolves its template via fab_orders.progress_template_id
-- (manual override) first, else the active template whose match_item_category_id
-- matches the order's top-level finished-good category. Distinct from the BOM
-- fab_bom_templates — this is reporting only, it never drives materialization.
CREATE TABLE IF NOT EXISTS fab_progress_templates (
  id                     INT AUTO_INCREMENT PRIMARY KEY,
  company_id             INT           NOT NULL,
  name                   VARCHAR(120)  NOT NULL,
  code                   VARCHAR(40)   NULL,
  match_item_category_id INT           NULL,      -- auto-match by finished-good category
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

-- fab_orders.progress_template_id — manual template override (wins over match).
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_orders' AND COLUMN_NAME='progress_template_id');
SET @sql = IF(@col=0,'ALTER TABLE fab_orders ADD COLUMN progress_template_id INT NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ===== fab_project_tasks.formula_hours (EU-15, 2026-08) =====
-- EU-15 seeds computed_hours from a learned p80 stat (operationStatsService.
-- getUsableStat) at materialization time when one is usable for the task's
-- (operation_id, resource_type_id), which overwrites the formula-derived
-- estimate that used to live in computed_hours. formula_hours preserves that
-- original formula value so it's never lost. Guarded ALTER since
-- fab_project_tasks predates this column in already-provisioned databases —
-- same idiom as the fab_orders.customer_id gap fix above (information_schema
-- existence check + PREPARE/EXECUTE), and deliberately not added to the
-- CREATE TABLE above either, matching that same precedent.
-- RETIRED 2026-08-05. formula_hours held the formula's own estimate beside a
-- learned p80 that overrode it; the learning subsystem is gone (buffer sizing
-- is a fixed 50%, so nothing consumed it) and the column was dropped. Leaving
-- this ALTER in would recreate it on the next run of this file — which is
-- exactly what push-to-prod does.

-- FEAT-05 (2026-07-23): production output + rework. Idempotent adds for DBs
-- created before this feature. Mirrors the CREATE TABLE columns above.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_project_tasks' AND COLUMN_NAME='produced_qty');
SET @sql = IF(@col=0,'ALTER TABLE fab_project_tasks ADD COLUMN produced_qty DECIMAL(18,4) NULL AFTER computed_hours','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_project_tasks' AND COLUMN_NAME='scrap_qty');
SET @sql = IF(@col=0,'ALTER TABLE fab_project_tasks ADD COLUMN scrap_qty DECIMAL(18,4) NOT NULL DEFAULT 0 AFTER produced_qty','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_project_tasks' AND COLUMN_NAME='qc_result');
SET @sql = IF(@col=0,"ALTER TABLE fab_project_tasks ADD COLUMN qc_result ENUM('pass','fail') NULL AFTER scrap_qty",'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_project_tasks' AND COLUMN_NAME='is_rework');
SET @sql = IF(@col=0,'ALTER TABLE fab_project_tasks ADD COLUMN is_rework TINYINT(1) NOT NULL DEFAULT 0 AFTER qc_result','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_project_tasks' AND COLUMN_NAME='rework_of_task_id');
SET @sql = IF(@col=0,'ALTER TABLE fab_project_tasks ADD COLUMN rework_of_task_id INT NULL AFTER is_rework','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_project_tasks' AND INDEX_NAME='idx_fpjt_rework_of');
SET @sql = IF(@idx=0,'ALTER TABLE fab_project_tasks ADD KEY idx_fpjt_rework_of (company_id, rework_of_task_id)','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ===== Critical Chain (EU-1, 2026-07) =====
-- Read-only schema for the fab_erp Critical Chain time-buffer module: one
-- frozen baseline plan per order, its chain tasks and project/feeding
-- buffers, periodic buffer-consumption snapshots, and the company's single
-- drum (constraint resource) with its planned slots. Same convention as the
-- rest of fab_erp: only company_id gets a real FOREIGN KEY, every other
-- cross-reference (order_id, task_id, plan_id, buffer_id, drum_id,
-- resource_type_id, resource_id, feeds_task_id/after_task_id) is a plain
-- INT + KEY index so a soft-deleted parent never blocks a write. Writes go
-- through a dedicated route in a later EU — these tables are read-only via
-- the generic query API (see resourceDef.json, writeFields: []).

CREATE TABLE IF NOT EXISTS fab_cc_plans (
  id                       INT AUTO_INCREMENT PRIMARY KEY,
  company_id               INT           NOT NULL,
  order_id                 INT           NOT NULL,
  status                   ENUM('draft','baselined','superseded','archived') NOT NULL DEFAULT 'draft',
  due_date                 DATETIME      NULL,
  chain_length_minutes     INT           NULL,
  project_buffer_minutes   INT           NULL,
  aggressive_finish        DATETIME      NULL,
  committed_finish         DATETIME      NULL,
  projected_finish         DATETIME      NULL,
  fever_zone               ENUM('green','yellow','red') NULL,
  -- SMALLINT, not TINYINT: buffer burn passes 100% exactly when a project is
  -- in the trouble the fever chart exists to show, and TINYINT stops at 127.
  buffer_consumed_pct      SMALLINT      NULL,
  chain_complete_pct       TINYINT       NULL,
  drum_planned_start       DATETIME      NULL,
  baselined_at             DATETIME      NULL,
  superseded_by_plan_id    INT           NULL,
  deleted_at               DATETIME      DEFAULT NULL,
  created_at               TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fccp_company_order  (company_id, order_id),
  KEY idx_fccp_company_status (company_id, status)
);

CREATE TABLE IF NOT EXISTS fab_cc_chain_tasks (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  company_id          INT           NOT NULL,
  plan_id             INT           NOT NULL,
  task_id             INT           NOT NULL,
  seq                 INT           NOT NULL,
  chain_role          ENUM('critical','feeding') NOT NULL,
  feeding_group_id    INT           NULL,
  aggressive_minutes  INT           NOT NULL,
  planned_start       DATETIME      NULL,
  planned_end         DATETIME      NULL,
  deleted_at          DATETIME      DEFAULT NULL,
  created_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fcct_company_plan (company_id, plan_id),
  KEY idx_fcct_company_task (company_id, task_id)
);

CREATE TABLE IF NOT EXISTS fab_cc_buffers (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  company_id         INT           NOT NULL,
  plan_id            INT           NOT NULL,
  kind               ENUM('project','feeding') NOT NULL,
  size_minutes       INT           NOT NULL,
  consumed_minutes   INT           NOT NULL DEFAULT 0,
  feeds_task_id      INT           NULL,
  after_task_id      INT           NULL,
  warn_pct           TINYINT       NOT NULL DEFAULT 33,
  act_pct            TINYINT       NOT NULL DEFAULT 67,
  deleted_at         DATETIME      DEFAULT NULL,
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fccb_company_plan (company_id, plan_id)
);

CREATE TABLE IF NOT EXISTS fab_cc_buffer_snapshots (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  company_id            INT           NOT NULL,
  plan_id               INT           NOT NULL,
  buffer_id             INT           NOT NULL,
  at                    DATETIME      NOT NULL,
  chain_complete_pct    TINYINT       NOT NULL,
  buffer_consumed_pct   SMALLINT      NOT NULL,
  zone                  ENUM('green','yellow','red') NOT NULL,
  deleted_at            DATETIME      DEFAULT NULL,
  created_at            TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fccbs_company_plan_at (company_id, plan_id, at)
);

-- One active row per company (enforced at the application layer, not by a
-- DB constraint — matches the plain company_id KEY called for in the EU-1
-- spec rather than inventing a uniqueness idiom it didn't ask for).
CREATE TABLE IF NOT EXISTS fab_cc_drum (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  company_id         INT           NOT NULL,
  resource_type_id   INT           NOT NULL,
  resource_id        INT           NULL,
  load_minutes       INT           NULL,
  method             ENUM('auto') NOT NULL DEFAULT 'auto',
  computed_at        DATETIME      NULL,
  deleted_at         DATETIME      DEFAULT NULL,
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fccd_company (company_id)
);

CREATE TABLE IF NOT EXISTS fab_cc_drum_slots (
  id                        INT AUTO_INCREMENT PRIMARY KEY,
  company_id                INT           NOT NULL,
  drum_id                   INT           NOT NULL,
  order_id                  INT           NOT NULL,
  plan_id                   INT           NOT NULL,
  seq                       INT           NOT NULL,
  planned_start             DATETIME      NULL,
  planned_end               DATETIME      NULL,
  capacity_buffer_minutes   INT           NOT NULL DEFAULT 0,
  is_committed              TINYINT(1)    NOT NULL DEFAULT 0,
  deleted_at                DATETIME      DEFAULT NULL,
  created_at                TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fccds_company_drum_seq (company_id, drum_id, seq)
);

-- ===========================================================================
-- PIECE MARKS AND PEOPLE
-- ===========================================================================
-- These three tables and the fab_items mark columns shipped as hand-applied
-- migrations (2026-08-piece-marks.sql, the people model) and were never folded
-- back in. Production has them; init.sql did not — so anything built from this
-- file alone came up with no marks and no workers, silently. Reconciled from
-- the live schema 2026-08-05.

-- A mark is the identifier stamped on the steel: top-level items get PREFIX+seq
-- (B1, B2) and their children hang off the parent (B1-a, B1-a-i), so the
-- hierarchy is readable on the shop floor.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_items' AND COLUMN_NAME = 'mark');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN mark VARCHAR(40) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN mark_prefix VARCHAR(10) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN mark_seq INT NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Two marks alike on one order would be two pieces of steel that cannot be
-- told apart. NULLs are permitted and repeatable, so unmarked items coexist.
SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_items'
               AND INDEX_NAME = 'uq_fab_items_order_mark');
SET @sql = IF(@idx=0,'ALTER TABLE fab_items ADD UNIQUE KEY uq_fab_items_order_mark (order_id, mark)','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_items'
               AND INDEX_NAME = 'idx_fab_items_company_mark');
SET @sql = IF(@idx=0,'ALTER TABLE fab_items ADD KEY idx_fab_items_company_mark (company_id, mark)','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Which prefix a category's items get. The row with item_category_id = NULL is
-- the fallback for every item whose category has no row of its own; without any
-- row at all markService falls back to the hardcoded 'P'.
-- Uniqueness is on the generated item_category_id_active, not on
-- item_category_id: rows are soft-deleted, and a tombstone must not stop the
-- same category being given a prefix again. It cannot enforce "one fallback
-- row" — that row is the one with a NULL category, and repeated NULLs are
-- legal — so the editor enforces that rule instead.
CREATE TABLE IF NOT EXISTS fab_mark_schemes (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  company_id              INT          NOT NULL,
  item_category_id        INT          NULL,
  prefix                  VARCHAR(10)  NOT NULL,
  sort_order              INT          NOT NULL DEFAULT 0,
  deleted_at              DATETIME     NULL,
  created_at              TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  item_category_id_active INT GENERATED ALWAYS AS (IF(deleted_at IS NULL, item_category_id, NULL)) VIRTUAL,
  KEY idx_fab_mark_schemes_company (company_id),
  UNIQUE KEY uq_fms_company_cat_active (company_id, item_category_id_active)
);

-- Who does the work. A worker may be an employee, a contractor, or a vendor's
-- crew; user_id links the ones who also log in.
CREATE TABLE IF NOT EXISTS fab_workers (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT          NOT NULL,
  name         VARCHAR(255) NOT NULL,
  code         VARCHAR(64)  NULL,
  worker_type  ENUM('employee','contractor','vendor') NOT NULL DEFAULT 'employee',
  user_id      INT          NULL,
  vendor_name  VARCHAR(255) NULL,
  phone        VARCHAR(50)  NULL,
  active       TINYINT(1)   NOT NULL DEFAULT 1,
  deleted_at   DATETIME     NULL,
  created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fab_workers_company (company_id, active),
  KEY idx_fab_workers_user (user_id)
);

-- Intervals, not a single current machine: 'assigned' puts a worker on a
-- resource from from_ts until to_ts (NULL = still there), 'away' records leave.
-- Open-ended rows are why to_ts is nullable.
CREATE TABLE IF NOT EXISTS fab_worker_assignments (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT          NOT NULL,
  worker_id    INT          NOT NULL,
  resource_id  INT          NULL,
  kind         ENUM('assigned','away') NOT NULL DEFAULT 'assigned',
  from_ts      DATETIME     NOT NULL,
  to_ts        DATETIME     NULL,
  reason       VARCHAR(64)  NULL,
  note         VARCHAR(400) NULL,
  entered_by   INT          NULL,
  deleted_at   DATETIME     NULL,
  created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fwa_company (company_id),
  KEY idx_fwa_worker (worker_id, from_ts),
  KEY idx_fwa_resource (resource_id, kind, from_ts)
);

-- ── People own the calendar (2026-08-06) ────────────────────────────────────
-- Which shift a person is on, as intervals. A person is assigned to a SHIFT ROW
-- rather than a bare time range, so the midnight rollover, the unpaid break
-- (working_minutes) and the plant's non-working days all come from fab_shifts
-- and its calendar instead of being reimplemented per person.
-- Rotation is close-one-open-the-next; to_ts NULL projects forward indefinitely,
-- which is what lets the scheduler plan from today's roster.
CREATE TABLE IF NOT EXISTS fab_worker_shifts (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  company_id       INT NOT NULL,
  worker_id        INT NOT NULL,
  shift_id         INT NOT NULL,
  from_ts          DATETIME NOT NULL,
  to_ts            DATETIME NULL,
  source           ENUM('live','backfill','system') NOT NULL DEFAULT 'live',
  entered_by       INT NULL,
  superseded_by_id INT NULL,
  note             VARCHAR(400) NULL,
  deleted_at       DATETIME NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fws_worker  (worker_id, from_ts),
  KEY idx_fws_company (company_id),
  KEY idx_fws_shift   (shift_id)
);

-- Who actually touched a task — the traceability record (which qualified welder
-- made which joint, AWS D1.1 / EN 1090). fab_task_events.entered_by is the LOGIN
-- that tapped the screen, typically a supervisor, and answers a different
-- question. Records WHO, deliberately never HOW FAST.
CREATE TABLE IF NOT EXISTS fab_task_workers (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  company_id       INT NOT NULL,
  task_id          INT NOT NULL,
  worker_id        INT NOT NULL,
  role             VARCHAR(64) NULL,
  from_ts          DATETIME NOT NULL,
  to_ts            DATETIME NULL,
  source           ENUM('live','backfill','system') NOT NULL DEFAULT 'live',
  entered_by       INT NULL,
  superseded_by_id INT NULL,
  note             VARCHAR(400) NULL,
  deleted_at       DATETIME NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_ftw_task    (task_id, from_ts),
  KEY idx_ftw_worker  (worker_id, from_ts),
  KEY idx_ftw_company (company_id)
);

-- Per-company key/value settings. Currently one key: capacity_mode
-- ('calendar' | 'crew'). A MISSING ROW MEANS 'calendar', so every existing
-- company keeps its current behaviour until somebody switches it deliberately —
-- crew-derived capacity gives an unmanned machine ZERO capacity, and flipping a
-- company whose roster doesn't cover its working machines would make them
-- unschedulable. POST /capacity-mode refuses that switch while machines with
-- queued work still have nobody on them.
CREATE TABLE IF NOT EXISTS fab_company_settings (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  company_id    INT NOT NULL,
  setting_key   VARCHAR(64)  NOT NULL,
  setting_value VARCHAR(255) NULL,
  updated_by    INT NULL,
  deleted_at    DATETIME NULL,
  created_at    TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fcs_company_key (company_id, setting_key)
);

-- Append-only correction on the pre-existing assignment table: a superseded row
-- stays on disk and reads filter `superseded_by_id IS NULL`. Same idiom as
-- fab_task_events.superseded_by_event_id. Matters here because machine and
-- project delays are derived from these rows — a delay figure that changes with
-- no record of why is worse than one that is simply wrong.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_worker_assignments'
              AND COLUMN_NAME = 'superseded_by_id');
SET @sql = IF(@col = 0,
  "ALTER TABLE fab_worker_assignments ADD COLUMN superseded_by_id INT NULL COMMENT 'Append-only correction: replaced by that row. Reads filter superseded_by_id IS NULL.'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_worker_assignments'
              AND COLUMN_NAME = 'source');
SET @sql = IF(@col = 0,
  "ALTER TABLE fab_worker_assignments ADD COLUMN source ENUM('live','backfill','system') NOT NULL DEFAULT 'live' COMMENT 'live = recorded as it happened; backfill = written up later'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fab_worker_assignments'
              AND INDEX_NAME = 'idx_fwa_live');
SET @sql = IF(@idx = 0,
  "CREATE INDEX idx_fwa_live ON fab_worker_assignments (company_id, kind, superseded_by_id, from_ts)",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── Plant timezone (2026-08-06) ─────────────────────────────────────────────
-- fab_shifts.start_time is what is written on the board at the SITE. Without a
-- zone the calendar walk read it as UTC, so an Indian plant on a UTC server ran
-- 5.5h late in no_shift attribution, the coverage meter, and (under
-- capacity_mode=crew) the scheduling calendar. Resolution: plant.timezone ->
-- fab_company_settings.timezone -> UTC. NULL keeps the pre-change behaviour.
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

-- Leaving the firm (2026-08-06) ------------------------------------------
-- exited_at is the INSTANT somebody left. active alone could not say when, and
-- setting it did nothing to their open intervals -- so the machine kept crew
-- that had left (phantom crew for no_operator, and for capacity under
-- capacity_mode=crew). Exit now CLOSES the open assignment/shift at this
-- instant, which is also why no interval query filters active=1 any more: a
-- present-tense flag cannot answer a question about the past, and somebody who
-- left in March really was on that machine in February.
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

-- Gap capture (2026-08-06) -------------------------------------------------
-- Explaining idle time that has no derivable cause. Supervisors explain a gap
-- by writing an EVENT (the shape machine_down already uses), never by
-- overriding fab_task_wait_segments -- that table is materialised by the
-- attribution engine and rewritten on every recompute. Three scopes, because
-- that is what makes capture cheap: site (weather stops a whole yard), machine
-- (breakdown), task (an inspection follows the job wherever it sits).
SET @cur = (SELECT COLUMN_TYPE FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'fab_task_wait_segments' AND COLUMN_NAME = 'reason');
SET @sql = IF(@cur IS NOT NULL AND @cur NOT LIKE '%waiting_inspection%',
  "ALTER TABLE fab_task_wait_segments MODIFY COLUMN reason ENUM('waiting_predecessors','waiting_materials','no_shift','machine_down','no_operator','machine_busy','output_blocked','unexplained_idle','waiting_inspection','weather','drawing_hold','other_explained') NOT NULL",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. Task-scoped holds ───────────────────────────────────────────────────
-- The job is stopped for something external to the shop.
--
-- `party` earns its place: waiting on the CLIENT's inspector and waiting on our
-- own QC have different escalation paths, and a delay you can prove was the
-- client's is commercially different from one that was yours. `reference` is the
-- inspection call-off or drawing revision number — the thing you quote when
-- arguing about it later.
CREATE TABLE IF NOT EXISTS fab_task_holds (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  company_id       INT NOT NULL,
  task_id          INT NOT NULL,
  hold_code        VARCHAR(40) NOT NULL,   -- validated against fab_gap_reasons
  from_ts          DATETIME NOT NULL,
  to_ts            DATETIME NULL,          -- NULL = still held
  party            VARCHAR(120) NULL,
  reference        VARCHAR(120) NULL,
  note             VARCHAR(400) NULL,
  source           ENUM('live','backfill','system') NOT NULL DEFAULT 'live',
  entered_by       INT NULL,
  superseded_by_id INT NULL,
  deleted_at       DATETIME NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fth_task    (task_id, from_ts),
  KEY idx_fth_company (company_id, from_ts)
);

-- ── 3. Site-scoped stoppages ───────────────────────────────────────────────
-- One row covers every machine at that plant for that span. Rain stopping an
-- outdoor yard is ONE action here and nine on the machine stream; that
-- difference is the whole reason the scope exists.
CREATE TABLE IF NOT EXISTS fab_plant_events (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  company_id       INT NOT NULL,
  plant_id         INT NOT NULL,
  event_code       VARCHAR(40) NOT NULL,   -- validated against fab_gap_reasons
  from_ts          DATETIME NOT NULL,
  to_ts            DATETIME NULL,
  note             VARCHAR(400) NULL,
  source           ENUM('live','backfill','system') NOT NULL DEFAULT 'live',
  entered_by       INT NULL,
  superseded_by_id INT NULL,
  deleted_at       DATETIME NULL,
  created_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fpe_plant   (plant_id, from_ts),
  KEY idx_fpe_company (company_id, from_ts)
);

-- ── 4. The reason catalogue ────────────────────────────────────────────────
-- Company-specific ADDITIONS and overrides. A built-in list lives in
-- services/gapReasons.js; this table is empty by default and only holds what a
-- site adds ("waiting for crane", "gas cylinder empty") or hides. Same pattern
-- as fab_resource_downtime_reasons — configurable without a deploy.
--
-- `wait_reason` is the crucial column: it says which fab_task_wait_segments
-- reason this code produces, so a site can add its own vocabulary without
-- inventing a new attribution category the engine knows nothing about.
CREATE TABLE IF NOT EXISTS fab_gap_reasons (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  company_id   INT NOT NULL,
  scope        ENUM('site','machine','task') NOT NULL,
  code         VARCHAR(40)  NOT NULL,
  label        VARCHAR(120) NOT NULL,
  wait_reason  VARCHAR(40)  NOT NULL,
  sort_order   INT NOT NULL DEFAULT 100,
  active       TINYINT(1) NOT NULL DEFAULT 1,
  deleted_at   DATETIME NULL,
  created_at   TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fgr_company_code (company_id, code),
  KEY idx_fgr_company (company_id, active)
);

-- Blocker detail on wait segments (2026-08-06) ------------------------------
-- The pre-eligibility window is now sliced by WHAT WAS OUTSTANDING rather than
-- stamped with one reason. These columns name the blocker per slice. See
-- taskAttributionService.loadBlockers / sliceByBlocker.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'fab_task_wait_segments' AND COLUMN_NAME = 'blocker_type');
SET @sql = IF(@col = 0,
  "ALTER TABLE fab_task_wait_segments ADD COLUMN blocker_type VARCHAR(20) NULL COMMENT 'predecessor | input — what kind of thing was holding the task during this segment'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'fab_task_wait_segments' AND COLUMN_NAME = 'blocker_ref_id');
SET @sql = IF(@col = 0,
  "ALTER TABLE fab_task_wait_segments ADD COLUMN blocker_ref_id INT NULL COMMENT 'the predecessor fab_project_tasks.id, or the fab_task_inputs.id — NULL when several were outstanding at once'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'fab_task_wait_segments' AND COLUMN_NAME = 'blocker_label');
SET @sql = IF(@col = 0,
  "ALTER TABLE fab_task_wait_segments ADD COLUMN blocker_label VARCHAR(200) NULL COMMENT 'human name of the blocker, denormalised at write time so the read path stays one query'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Answers "what is holding the most work up right now", which is the whole point.
SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'fab_task_wait_segments' AND INDEX_NAME = 'idx_ftws_blocker');
SET @sql = IF(@idx = 0,
  "CREATE INDEX idx_ftws_blocker ON fab_task_wait_segments (company_id, blocker_type, blocker_ref_id)",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ===== Sales-order wizard (2026-08-10) =====
-- Folded in from migrations/2026-08-order-wizard.sql so a full init.sql run
-- applies it. Every statement is guarded; re-running is a no-op.
-- The sales order becomes one resumable wizard: lines → BOM → nesting → flows
-- → project tree → confirm.
--
-- Three things change in the data model.
--
-- 1. A LINE IS NO LONGER A CATALOG ITEM. The item catalog holds raw materials
--    and consumables; nobody is going to add "42m span composite girder" to it,
--    because every job is one-off and it would be a catalog of one. A line is
--    now free text: a code the user types, a structure type, and a quantity.
--    catalog_item_id had no foreign key, so this is a clean drop.
--
-- 2. DATES AND PLANT LIVE ON THE ORDER ONLY. A line carrying its own requested
--    date and target plant invited two answers to one question, and the order's
--    answer is the one anybody acts on.
--
-- 3. A LINE OWNS ITS BOQ SUBTREE, via fab_items.order_line_id. Line progress
--    used to find its items by matching catalog_item_id — which cannot survive
--    (1) — so the link becomes explicit.
--
-- Also drops bom_id and routing_plan_id: both survive only as names in
-- resourceDef.json, referenced by no query and no screen, left behind when
-- routing plans were removed on 2026-08-05.
--
-- Idempotent throughout (information_schema guards), so a re-run is a no-op.
-- ---------------------------------------------------------------------------

-- ── fab_order_lines: free-text identity ─────────────────────────────────────

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_order_lines' AND COLUMN_NAME='code');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_order_lines ADD COLUMN code VARCHAR(60) NULL AFTER line_no',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_order_lines' AND COLUMN_NAME='description');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_order_lines ADD COLUMN description VARCHAR(255) NULL AFTER code',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Carry across whatever the existing rows pointed at, so they still read as
-- something rather than turning into blank rows.
--
-- GUARDED so the file stays re-runnable. Written as a bare UPDATE this was a
-- one-shot: it succeeded once and then made the whole file un-re-runnable,
-- which breaks the contract every other statement here keeps and that the
-- deploy flow relies on. A migration that only works once is a migration that
-- fails the second time somebody deploys.
--
-- Since 2026-08-13 the only rows it can touch are PURCHASE lines — sales lines
-- carry a NULL catalog_item_id, so the join excludes them — and those already
-- get their code and description from the catalog when raised. It is kept as
-- the backstop for a purchase line created without them.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_order_lines' AND COLUMN_NAME='catalog_item_id');
SET @sql = IF(@col=1,
  'UPDATE fab_order_lines fol
      JOIN fab_item_catalog fic ON fic.id = fol.catalog_item_id
       SET fol.code = COALESCE(NULLIF(fol.code, ''''), fic.code),
           fol.description = COALESCE(NULLIF(fol.description, ''''), fic.name)
    WHERE fol.code IS NULL OR fol.code = ''''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── drop what a line no longer decides ──────────────────────────────────────

-- REMOVED 2026-08-13: the drop of fab_order_lines.catalog_item_id.
--
-- It did its job — a SALES line is free text and stopped naming a catalog item
-- long ago. But the column came back on 2026-08-13 with a different meaning:
-- a PURCHASE line orders a specific plate, and that is the whole point of
-- ordering against a document. Both statements then lived in this file, one
-- adding the column near the end and this one dropping it in the middle.
--
-- The first run worked (nothing to drop yet, then it was added). Every run
-- after that failed here with "can't drop column catalog_item_id with
-- composite index covered", because idx_fol_catalog covers it — so the file
-- stopped being re-runnable and everything below this line was skipped on
-- every deploy. Exactly the failure the comment above this block warns about.
--
-- Deleted rather than guarded: the column is wanted now, and a drop that must
-- never fire is not a drop.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_order_lines' AND COLUMN_NAME='target_plant_id');
SET @sql = IF(@col=1, 'ALTER TABLE fab_order_lines DROP COLUMN target_plant_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_order_lines' AND COLUMN_NAME='requested_date');
SET @sql = IF(@col=1, 'ALTER TABLE fab_order_lines DROP COLUMN requested_date', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_order_lines' AND COLUMN_NAME='bom_id');
SET @sql = IF(@col=1, 'ALTER TABLE fab_order_lines DROP COLUMN bom_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_order_lines' AND COLUMN_NAME='routing_plan_id');
SET @sql = IF(@col=1, 'ALTER TABLE fab_order_lines DROP COLUMN routing_plan_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── a line owns its BOQ subtree ─────────────────────────────────────────────

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='order_line_id');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_items ADD COLUMN order_line_id INT NULL AFTER order_id',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND INDEX_NAME='idx_fi_order_line');
SET @sql = IF(@idx=0,
  'ALTER TABLE fab_items ADD KEY idx_fi_order_line (order_line_id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── the order remembers where the wizard got to ─────────────────────────────
-- Persisted rather than held in the browser: the whole point is that you can
-- close it, go home, and have a colleague pick it up on another machine.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_orders' AND COLUMN_NAME='wizard_step');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_orders ADD COLUMN wizard_step VARCHAR(20) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── retire ready_to_plan ────────────────────────────────────────────────────
-- Added earlier the same day to mark "preparation done, planner can build
-- tasks". The wizard now owns that meaning and shows it far better, and
-- confirmation moved to the end of the wizard — so nothing sets this any more.
-- Any row still carrying it is put back to draft, which is what it now means:
-- in the wizard, not yet confirmed.

UPDATE fab_orders SET status = 'draft' WHERE status = 'ready_to_plan';


-- ===== Raw material: thickness and form (2026-08-11) =====
-- Folded in from migrations/2026-08-rm-thickness-and-form.sql. Guarded; a
-- re-run is a no-op. Additive only.
-- Raw material gets a shape the system can reason about.
--
-- Thickness already existed on every RM item — as a CUSTOM FIELD whose value is
-- the free text "20 mm". That was fine while it was documentation. It is not
-- fine now that it decides which materials a part is allowed to be cut from: a
-- dropdown driven by string matching returns an empty list the first time
-- somebody types "20mm", and gives no clue why.
--
--   thickness_mm    DECIMAL  — the cross-section dimension a plate is chosen by
--   material_form   VARCHAR  — 'plate' | 'section' | NULL
--
-- material_form exists because thickness alone is a WRONG filter. An ISA
-- 100×100×10 angle records a thickness of 10, so a 10mm plate part would be
-- offered an angle as a valid choice. For a section the whole profile IS the
-- item; thickness is a property of it, not the thing you select on. So plate
-- parts filter by thickness among plates, and sections are chosen directly.
--
-- Length and width deliberately do NOT go here. A plate item is "20mm plate" —
-- the 12000×2500 is a property of the piece that turned up, not of the item, and
-- one item legitimately has pieces of many sizes. They go on fab_stock_pieces.
--
-- Idempotent throughout; re-running is a no-op.
-- ---------------------------------------------------------------------------

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='thickness_mm');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_item_catalog ADD COLUMN thickness_mm DECIMAL(10,3) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND COLUMN_NAME='material_form');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_item_catalog ADD COLUMN material_form VARCHAR(20) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Filtering happens per (company, form, thickness) on every BOM row.
SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_catalog' AND INDEX_NAME='idx_fic_form_thickness');
SET @sql = IF(@idx=0,
  'ALTER TABLE fab_item_catalog ADD KEY idx_fic_form_thickness (company_id, material_form, thickness_mm)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── backfill from the custom fields that already hold this ─────────────────
-- "20 mm" / "20mm" / "20" all yield 20. Anything with no leading number is left
-- NULL rather than guessed at: a material with no thickness simply does not
-- appear in a thickness-filtered list, which is the safe failure.

UPDATE fab_item_catalog fic
  JOIN fab_custom_fields cf
    ON cf.level = 'item' AND cf.level_id = fic.id AND cf.company_id = fic.company_id
   AND cf.field_key IN ('Thickness', 'Thickness (mm)', 'Thickness mm') AND cf.deleted_at IS NULL
   SET fic.thickness_mm = CAST(TRIM(cf.field_value) AS DECIMAL(10,3))
 WHERE fic.thickness_mm IS NULL
   AND TRIM(cf.field_value) REGEXP '^[0-9]+(\\.[0-9]+)?';

-- Form, from the Material Type custom field. Plate is anything calling itself a
-- plate or sheet; the rolled sections are listed by their Indian-standard
-- prefixes (ISA angle, ISMB/ISMC beam and channel, and the generic words).
UPDATE fab_item_catalog fic
  JOIN fab_custom_fields cf
    ON cf.level = 'item' AND cf.level_id = fic.id AND cf.company_id = fic.company_id
   AND cf.field_key = 'Material Type' AND cf.deleted_at IS NULL
   SET fic.material_form = CASE
     WHEN LOWER(cf.field_value) REGEXP 'plate|sheet|flat'          THEN 'plate'
     WHEN LOWER(cf.field_value) REGEXP 'isa|ismb|ismc|isnb|angle|channel|beam|section|pipe|tube|rod|bar' THEN 'section'
     ELSE NULL END
 WHERE fic.material_form IS NULL;

-- Sections by their own name, BEFORE the plate fallback. Without this an
-- unclassified ISA 100x100x10 keeps material_form NULL, and NULL is treated as
-- plate by the picker — so it would be offered to every 10mm plate part, which
-- is the precise mistake material_form exists to stop. Prod spells Material
-- Type differently from local, so the name is the more reliable signal.
UPDATE fab_item_catalog
   SET material_form = 'section'
 WHERE material_form IS NULL AND procurement_type = 'buy'
   AND LOWER(name) REGEXP 'isa |isa[0-9]|ismb|ismc|isnb|angle|channel|beam|joist|pipe|tube|^isa';

-- Anything still unclassified but clearly a plate by its own name.
UPDATE fab_item_catalog
   SET material_form = 'plate'
 WHERE material_form IS NULL AND procurement_type = 'buy'
   AND LOWER(name) REGEXP 'plate|sheet';

-- ── batch-level dimensions ────────────────────────────────────────────────
-- A 20mm plate item covers pieces of many sizes, so the size belongs to the
-- piece. Nesting does not read these yet — it still takes a typed plate size —
-- but recording them at stock-in is what will later let a nest be drawn from an
-- identified piece rather than a described one.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_pieces' AND COLUMN_NAME='length_mm');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_stock_pieces ADD COLUMN length_mm DECIMAL(12,3) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_pieces' AND COLUMN_NAME='width_mm');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_stock_pieces ADD COLUMN width_mm DECIMAL(12,3) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ===== BOM templates (2026-08-11) =====
-- Folded in from migrations/2026-08-bom-templates.sql. CREATE TABLE IF NOT
-- EXISTS plus a guarded seed; a re-run adds nothing and never resurrects a
-- part somebody deleted.
-- What a structure type is made of, as data rather than as a constant.
--
-- This lived in `DEFAULT_PARTS` in multi_app_fe/src/apps/fab_erp/types.ts — a
-- hardcoded TypeScript array. Three things were wrong with that, and they only
-- get worse as more companies come on:
--
--   * changing the parts of a composite girder needed a code change and a deploy
--   * every company on the platform got the same seven parts
--   * only 'Composite Girder' had an entry at all, so picking BowString, Tub
--     Girder, Openweb or PEB in the wizard filled in nothing
--
-- It is the SAME SHAPE as fab_flow_rules — "for this kind of line item, do X by
-- default" — and that one was already a company-scoped table editable in Setup.
-- Two implementations of one idea is one too many, so this follows it exactly.
--
-- A template row is a PART: its code, what to call it, and optionally the
-- thickness and material it usually is. The wizard copies them in and everything
-- stays editable before anything is generated — these are a starting point, not
-- a schema, which is why nothing here is enforced downstream.
--
-- Idempotent; re-running is a no-op.
-- ---------------------------------------------------------------------------

-- ── the name was used before, by something else ───────────────────────────
-- `fab_bom_templates` was ALSO the name of the reusable/versioned BOM model
-- removed in migrations/2026-08-drop-bom-templates.sql — a completely different
-- schema with no line_type. That drop lives in migrations/, which push-to-prod
-- never runs, so any database restored from a dump taken before it was applied
-- by hand still carries the old table.
--
-- On such a database CREATE TABLE IF NOT EXISTS silently does nothing, the
-- table keeps the wrong shape, and the seed below then dies on `Unknown column
-- 'line_type'` — taking the rest of init.sql with it.
--
-- So: if a table of that name exists and has no line_type column, it is the
-- legacy one. All three legacy tables held zero rows for the life of that
-- feature, so dropping is safe and loses nothing.
SET @legacy_exists = (
  SELECT COUNT(*) FROM information_schema.tables
   WHERE table_schema = DATABASE() AND table_name = 'fab_bom_templates');
SET @has_line_type = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'fab_bom_templates'
     AND column_name = 'line_type');
SET @sql = IF(@legacy_exists = 1 AND @has_line_type = 0,
  'DROP TABLE fab_bom_templates', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

DROP TABLE IF EXISTS fab_bom_template_slots;
DROP TABLE IF EXISTS fab_bom_template_nodes;

CREATE TABLE IF NOT EXISTS fab_bom_templates (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  company_id          INT NOT NULL,
  -- Which structure type this part belongs to, matching fab_order_lines.line_type.
  -- Free text rather than an enum for the same reason line_type is: the list of
  -- structure types is itself hardcoded in two places today, and an enum here
  -- would make that a third.
  line_type           VARCHAR(40) NOT NULL,
  code                VARCHAR(60) NOT NULL,
  name                VARCHAR(255) NULL,
  qty                 DECIMAL(14,4) NOT NULL DEFAULT 1,
  -- The usual thickness and material. Both optional: a template that only says
  -- "every composite girder has a top flange" is already worth having, and
  -- guessing a material would be worse than leaving it to the wizard.
  thickness_mm        DECIMAL(10,3) NULL,
  rm_catalog_item_id  INT NULL,
  sort_order          INT NOT NULL DEFAULT 0,
  active              TINYINT(1) NOT NULL DEFAULT 1,
  notes               TEXT NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at          DATETIME NULL,
  KEY idx_fbt_company_type (company_id, line_type, active),
  KEY idx_fbt_material (rm_catalog_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── seed the parts that were hardcoded ────────────────────────────────────
-- Seeded for every company that HAS THE fab_erp APP.
--
-- This used to key off "has rows in fab_item_catalog", which was a proxy for
-- the same thing and matched exactly at the time it was written. But a brand
-- new company's catalog is empty by definition, so a tenant onboarded after
-- this first ran would match nothing and get no templates — ever, since a seed
-- only reaches whoever qualifies on the day it runs. Keying on the app itself
-- is what was actually meant, and it is true from the moment fab_erp is
-- enabled rather than from the first catalog row.
--
-- init.sql is re-run on every deploy (see .claude/commands/push-to-prod.md),
-- so with the right condition this tops up new tenants by itself.
--
-- Guarded per (company, line_type, code) so a re-run adds nothing and, more
-- importantly, never resurrects a part somebody deliberately deleted.
--
-- The /D codes are load-bearing: flow rules match on a code suffix, and that is
-- what makes drilling get assigned without a per-item decision. Renaming them
-- to something tidier would silently route holed stiffeners down the flow that
-- never drills them.

INSERT INTO fab_bom_templates (company_id, line_type, code, name, sort_order)
SELECT c.company_id, 'Composite Girder', s.code, s.name, s.sort_order
  FROM (SELECT DISTINCT company_id FROM apps
         WHERE slug = 'fab_erp' AND deleted_at IS NULL) c
  JOIN (
        SELECT 'TF'   AS code, 'Top Flange'                    AS name, 1 AS sort_order
  UNION SELECT 'WP',        'Web Plate',                     2
  UNION SELECT 'BF',        'Bottom Flange',                 3
  UNION SELECT 'BS',        'Bearing Stiffener Plain',       4
  UNION SELECT 'BS/D',      'Bearing Stiffener Hole',        5
  UNION SELECT 'IS',        'Intermediate Stiffener Plain',  6
  UNION SELECT 'IS/D',      'Intermediate Stiffener Hole',   7
  ) s
 WHERE NOT EXISTS (
   SELECT 1 FROM fab_bom_templates t
    WHERE t.company_id = c.company_id
      AND t.line_type = 'Composite Girder'
      AND t.code = s.code);


-- ===== make vs buy on every BOM node (2026-08-13) =====
-- ---------------------------------------------------------------------------
-- Whether a BOM node is something the shop MAKES or something it BUYS was,
-- until now, only ever recorded on the catalog — so the structural levels of an
-- order's BOM (span, girder, segment, part) had no answer at all. They carry no
-- catalog link: in production today all 230 of them are unclassified, while the
-- 297 catalog-linked leaves under them are almost all 'buy' stock draws.
--
-- That gap is what blocks the next step. "Raise a PO for what we buy, a
-- production order for what we make" cannot be asked of data where most rows
-- answer neither.
--
-- The rule, stated once here and once in services/procurementService.js:
--
--   linked to a catalog item  →  whatever the CATALOG says (it is the authority;
--                                this is what "explicitly selected from the item
--                                catalog" means, and it is how raw materials end
--                                up 'buy' without naming them specially)
--   no catalog link           →  'make' — a girder is not a thing anybody sells
--
-- NULLABLE ON PURPOSE, with no default. NULL means "never classified", which is
-- what makes the backfill below safe to re-run on every deploy: it fills blanks
-- and cannot flatten a deliberate override into 'make'. A DEFAULT would erase
-- that distinction on the first insert.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items'
               AND COLUMN_NAME='procurement_type');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_items ADD COLUMN procurement_type VARCHAR(20) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- The next step reads this per order ("everything in this order we have to buy"),
-- which is exactly this index.
SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items'
               AND INDEX_NAME='idx_fi_order_procurement');
SET @sql = IF(@idx=0,
  'ALTER TABLE fab_items ADD KEY idx_fi_order_procurement (order_id, procurement_type)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── backfill ──────────────────────────────────────────────────────────────
-- Catalog-linked rows MIRROR the catalog every time, because the catalog is the
-- authority for those and re-pointing an item at a different catalog entry must
-- carry its procurement with it.
UPDATE fab_items fi
  JOIN fab_item_catalog fic
    ON fic.id = fi.catalog_item_id AND fic.deleted_at IS NULL
   SET fi.procurement_type = fic.procurement_type
 WHERE fi.deleted_at IS NULL
   AND (fi.procurement_type IS NULL OR fi.procurement_type <> fic.procurement_type);

-- Everything else defaults to 'make', but ONLY where nothing has been recorded
-- yet — an override that says 'buy' on an uncatalogued node survives re-runs.
UPDATE fab_items fi
   SET fi.procurement_type = 'make'
 WHERE fi.deleted_at IS NULL
   AND fi.catalog_item_id IS NULL
   AND fi.procurement_type IS NULL;


-- ===== procurement + production orders (2026-08-13) =====
-- ---------------------------------------------------------------------------
-- A sales order is a promise. Keeping it means two different kinds of work that
-- had no record of their own: buying what we do not have, and making what
-- nobody sells. fab_items.procurement_type says which is which per node; this
-- is where those two answers become documents.
--
--   PRODUCTION ORDER   one per sales order, order_type='manufacturing'. It owns
--                      the make side and its task DAG.
--   PROCUREMENT ORDER  order_type='purchase', one per supplier, carrying the
--                      shortfall lines — what stock cannot cover.
--
-- Both hang off the sales order by source_order_id, so the sales order's status
-- can be read as a combination of the two.
--
-- NOTE ON THE DAG: fab_project_tasks.order_id still points at the SALES order
-- and is NOT repointed. 2154 live task rows and roughly twenty modules read it
-- (critical chain, drum, dispatch, buffers, shift log, analytics,
-- reconciliation, readiness), all of which reach order priority and dates
-- through it. The production order claims its DAG through a NEW nullable column
-- instead: additive, reversible, and it leaves every one of those paths
-- working. "The DAG lives in the production order" is a question of which
-- column answers it, not of moving 2154 rows.
-- ---------------------------------------------------------------------------

-- ── suppliers ─────────────────────────────────────────────────────────────
-- There was no supplier anywhere in this system: goods came in through
-- /stock/receive with "no purchase order, no supplier, no receipt document".
-- A purchase order has to be addressed to somebody.
CREATE TABLE IF NOT EXISTS fab_suppliers (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  company_id     INT           NOT NULL,
  code           VARCHAR(60)   NOT NULL,
  name           VARCHAR(255)  NOT NULL,
  contact_name   VARCHAR(255)  NULL,
  email          VARCHAR(255)  NULL,
  phone          VARCHAR(60)   NULL,
  address        TEXT          NULL,
  payment_terms  VARCHAR(120)  NULL,
  -- Working days from order to delivery. Feeds "will it arrive in time", which
  -- is the only question a required date can be checked against.
  lead_time_days INT           NULL,
  currency       VARCHAR(10)   NULL,
  active         TINYINT(1)    NOT NULL DEFAULT 1,
  notes          TEXT          NULL,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at     DATETIME      NULL,
  KEY idx_fsup_company (company_id, active),
  KEY idx_fsup_code    (company_id, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which supplier a purchase order is addressed to.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_orders' AND COLUMN_NAME='supplier_id');
SET @sql = IF(@col=0, 'ALTER TABLE fab_orders ADD COLUMN supplier_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- "Everything raised for this sales order" is the query both new steps run.
SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_orders' AND INDEX_NAME='idx_fo_source_type');
SET @sql = IF(@idx=0,
  'ALTER TABLE fab_orders ADD KEY idx_fo_source_type (source_order_id, order_type)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── purchase-order lines ──────────────────────────────────────────────────
-- fab_order_lines was built for SALES lines: free text, a price, a completed
-- qty. A purchase line needs to name a catalog item — it is a specific plate,
-- not a description — and to track what has physically arrived against it.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_order_lines' AND COLUMN_NAME='catalog_item_id');
SET @sql = IF(@col=0, 'ALTER TABLE fab_order_lines ADD COLUMN catalog_item_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_order_lines' AND COLUMN_NAME='qty_received');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_order_lines ADD COLUMN qty_received DECIMAL(18,4) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_order_lines' AND COLUMN_NAME='expected_date');
SET @sql = IF(@col=0, 'ALTER TABLE fab_order_lines ADD COLUMN expected_date DATE NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_order_lines' AND INDEX_NAME='idx_fol_catalog');
SET @sql = IF(@idx=0,
  'ALTER TABLE fab_order_lines ADD KEY idx_fol_catalog (company_id, catalog_item_id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── the production order owns its DAG ─────────────────────────────────────
-- Additive on purpose — see the note at the top of this block.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_project_tasks' AND COLUMN_NAME='production_order_id');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_project_tasks ADD COLUMN production_order_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_project_tasks' AND INDEX_NAME='idx_fpt_prod_order');
SET @sql = IF(@idx=0,
  'ALTER TABLE fab_project_tasks ADD KEY idx_fpt_prod_order (production_order_id, status)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── stock reservations, restored ──────────────────────────────────────────
-- Removed 2026-08-05 with the simplification pass. Back because a shortfall
-- computed against raw on-hand is a lie the moment two orders ask at once:
-- both are told the same plate is free, both are told to buy nothing, and one
-- of them finds out on the shop floor.
--
-- One difference from the 2026-07-23 original: task_id is NULLABLE now. That
-- version only ever earmarked at gate-clear, when a task existed. Procurement
-- earmarks for the ORDER, long before any task does — so a reservation belongs
-- to a task or to an order, and `kind` says which.
CREATE TABLE IF NOT EXISTS fab_stock_reservations (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  company_id        INT            NOT NULL,
  catalog_item_id   INT            NOT NULL,
  kind              ENUM('order','task') NOT NULL DEFAULT 'order',
  task_id           INT            NULL,
  order_id          INT            NULL,
  qty               DECIMAL(18,4)  NOT NULL DEFAULT 0,
  status            ENUM('active','consumed','released') NOT NULL DEFAULT 'active',
  notes             TEXT           NULL,
  created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  released_at       DATETIME       NULL,
  deleted_at        DATETIME       DEFAULT NULL,
  KEY idx_fsr_avail (company_id, catalog_item_id, status),
  KEY idx_fsr_task  (company_id, task_id, status),
  KEY idx_fsr_order (company_id, order_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A database that still carries the pre-removal table has task_id NOT NULL and
-- no `kind`. Widen it rather than leaving it unusable for order reservations.
SET @tbl = (SELECT COUNT(*) FROM information_schema.TABLES
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_reservations');
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_reservations' AND COLUMN_NAME='kind');
SET @sql = IF(@tbl=1 AND @col=0,
  "ALTER TABLE fab_stock_reservations ADD COLUMN kind ENUM('order','task') NOT NULL DEFAULT 'task'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @nn = (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_reservations'
              AND COLUMN_NAME='task_id' AND IS_NULLABLE='NO');
SET @sql = IF(@nn=1, 'ALTER TABLE fab_stock_reservations MODIFY COLUMN task_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- =============================================================================
-- PRODUCTION PLANNER (Phase A, 2026-08-14) — FAB_ERP_PLANNER_PLAN.md
--
-- Four tables in two pairs:
--
--   fab_plan_runs / _run_items    the frozen IDEAL. Every Suggest run is
--                                 persisted whether or not it is accepted. If
--                                 the ideal were recomputed later from current
--                                 data it would always look perfect in
--                                 hindsight and the retrospective comparison
--                                 would be unfalsifiable.
--
--   fab_plan_entries / _entry_tasks   the ACTUAL plan — hand-editable, pinnable,
--                                 and never rewritten in place by a re-suggest.
--
-- Deliberately NOT reusing fab_cc_chain_tasks.planned_start/end: that is a
-- rebuildable cache, deleted and reinserted on every re-baseline (which fires
-- on materialize AND re-materialize), so a hand-placed bar would vanish.
-- =============================================================================

CREATE TABLE IF NOT EXISTS fab_plan_runs (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  company_id          INT           NOT NULL,
  status              ENUM('suggested','accepted','superseded') NOT NULL DEFAULT 'suggested',
  window_from         DATETIME      NOT NULL,
  window_to           DATETIME      NOT NULL,
  -- CSV of resource_type_ids the run was scoped to; NULL = whole shop. The
  -- planner works one resource type at a time most days, so a run is usually
  -- narrow and must not be read later as a shop-wide recommendation.
  resource_type_ids   VARCHAR(255)  NULL,
  -- The levelSchedule anchor, frozen. Without it a replay of this run cannot
  -- reproduce its own output — see resourceLevelingService's determinism note.
  anchor_at           DATETIME      NOT NULL,
  computed_at         DATETIME      NOT NULL,
  computed_by         INT           NULL,
  accepted_at         DATETIME      NULL,
  accepted_by         INT           NULL,
  entry_count         INT           NOT NULL DEFAULT 0,
  task_count          INT           NOT NULL DEFAULT 0,
  planned_minutes     INT           NOT NULL DEFAULT 0,
  -- Tasks the engine could not place at all (no capacity, no crew, no calendar).
  -- Counted rather than dropped: a suggestion that silently omits half the work
  -- reads as a light week.
  unschedulable_count INT           NOT NULL DEFAULT 0,
  notes               TEXT          NULL,
  created_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at          DATETIME      DEFAULT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fplr_company (company_id, status),
  KEY idx_fplr_window  (company_id, window_from, window_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS fab_plan_run_items (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  company_id          INT           NOT NULL,
  run_id              INT           NOT NULL,
  resource_type_id    INT           NOT NULL,
  resource_id         INT           NULL,
  bundle_key          VARCHAR(190)  NULL,
  ancestor_item_id    INT           NULL,
  order_id            INT           NULL,
  operation_id        INT           NULL,
  planned_start       DATETIME      NOT NULL,
  planned_end         DATETIME      NOT NULL,
  planned_minutes     INT           NOT NULL DEFAULT 0,
  task_count          INT           NOT NULL DEFAULT 1,
  -- JSON array of task ids, frozen as a COPY. Tasks get re-materialized,
  -- re-sequenced and cancelled; joining to them later would silently reshape a
  -- historical snapshot.
  task_ids            TEXT          NULL,
  -- Ranking components, likewise copied not joined — the whole point is that
  -- why this was suggested first stays answerable weeks later.
  priority_rank       INT           NULL,
  order_slack_minutes INT           NULL,
  is_critical_chain   TINYINT(1)    NOT NULL DEFAULT 0,
  seq_no              INT           NULL,
  reason              VARCHAR(255)  NULL,
  label               VARCHAR(255)  NULL,
  created_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at          DATETIME      DEFAULT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fplri_run   (company_id, run_id),
  KEY idx_fplri_start (company_id, planned_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS fab_plan_entries (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  company_id          INT           NOT NULL,
  -- The local plan day this bar belongs to, resolved through the plant timezone
  -- at write time. Week view groups by it; never derive it from planned_start
  -- in SQL or a night shift lands on the wrong day.
  plan_date           DATE          NOT NULL,
  resource_type_id    INT           NOT NULL,
  -- Set only when the bar is pinned to one machine. Lanes are resource TYPES.
  resource_id         INT           NULL,
  planned_start       DATETIME      NOT NULL,
  planned_end         DATETIME      NOT NULL,
  planned_minutes     INT           NOT NULL DEFAULT 0,
  kind                ENUM('bundle','task') NOT NULL DEFAULT 'task',
  -- (order_id, operation_id, resource_type_id, ancestor_item_id) for a bundle.
  bundle_key          VARCHAR(190)  NULL,
  ancestor_item_id    INT           NULL,
  order_id            INT           NULL,
  operation_id        INT           NULL,
  source              ENUM('suggested','manual') NOT NULL DEFAULT 'suggested',
  accepted_from_run_id INT          NULL,
  run_item_id         INT           NULL,
  -- A pinned bar survives re-suggestion untouched and is fed into the next level
  -- pass as pre-occupied capacity. Manual bars are pinned on creation: somebody
  -- placed it by hand, so an algorithm does not get to move it.
  is_pinned           TINYINT(1)    NOT NULL DEFAULT 0,
  status              ENUM('planned','superseded','cancelled') NOT NULL DEFAULT 'planned',
  label               VARCHAR(255)  NULL,
  notes               TEXT          NULL,
  created_by          INT           NULL,
  updated_by          INT           NULL,
  created_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at          DATETIME      DEFAULT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_fple_grid   (company_id, plan_date, resource_type_id),
  KEY idx_fple_status (company_id, status),
  KEY idx_fple_span   (company_id, planned_start, planned_end),
  KEY idx_fple_order  (company_id, order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS fab_plan_entry_tasks (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  company_id          INT           NOT NULL,
  plan_entry_id       INT           NOT NULL,
  task_id             INT           NOT NULL,
  planned_minutes     INT           NOT NULL DEFAULT 0,
  sort_order          INT           NOT NULL DEFAULT 0,
  created_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at          DATETIME      DEFAULT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  -- One row per task even for kind='task' (a bundle of one), so every read has
  -- exactly one shape.
  UNIQUE KEY uq_fplet (company_id, plan_entry_id, task_id),
  -- Is this task already planned? is asked on every manual add and every
  -- suggest run. MySQL has no partial unique index, so the
  -- one-active-entry-per-task rule is enforced in planService, not here.
  KEY idx_fplet_task  (company_id, task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── fab_resource_type_properties.company_id — CROSS-TENANT LEAK FIX ──────────
-- Found 2026-08-14 by a tenant-isolation test: a brand-new company could read
-- every other company's machine properties through the generic query API.
--
-- `core/query/queryBuilder/securityInjector.js` skips company scoping entirely
-- when the resourceDef exposes no `<alias>.company_id`, on the assumption that
-- such tables are child rows only ever reached by joining a scoped parent. This
-- table broke that assumption: it is registered as a TOP-LEVEL queryable
-- resource (`fabErpResourceTypeProperty`) while being scoped only through
-- resource_type_id, so nothing constrained it and every tenant saw all 10 rows.
--
-- Writes were already failing on it — mutateController's insert stamps
-- company_id and its update/delete filter on it, so all three threw "Unknown
-- column". Adding the column fixes the leak and the writes together.
--
-- Nullable on purpose: a row that cannot be attributed stays invisible, because
-- `company_id = ?` excludes NULL. It fails closed.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resource_type_properties'
               AND COLUMN_NAME='company_id');
SET @sql = IF(@col=0,'ALTER TABLE fab_resource_type_properties ADD COLUMN company_id INT NULL AFTER id','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Backfill from the parent resource type, which has always carried the tenant.
UPDATE fab_resource_type_properties p
  JOIN fab_resource_types rt ON rt.id = p.resource_type_id
   SET p.company_id = rt.company_id
 WHERE p.company_id IS NULL;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resource_type_properties'
               AND INDEX_NAME='idx_frtp_company');
SET @sql = IF(@idx=0,'ALTER TABLE fab_resource_type_properties ADD KEY idx_frtp_company (company_id)','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── fab_orders.must_finish_by ─────────────────────────────────────────────────
-- The must-match execution date: a planning instruction the engine may not
-- schedule past. Distinct from required_date (the CUSTOMER date, which a planner
-- may knowingly miss) and from confirmed_date (when the order was confirmed, an
-- event date written by orderReadinessService).
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_orders' AND COLUMN_NAME='must_finish_by');
SET @sql = IF(@col=0,'ALTER TABLE fab_orders ADD COLUMN must_finish_by DATE NULL AFTER required_date','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ═══════════════════════════════════════════════════════════════════════════
-- ITEM FIELD REGISTRY (2026-08-15) — see TM/FAB_ERP_FIELDS_AND_SEQUENCE_PLAN.md
--
-- ONE definition table and ONE value store, replacing three overlapping ones.
--
-- WHY. `evaluateFormula` read item.* only from fab_item_metric_values, while the
-- BOQ sheet and the BOM tree wrote fab_items.length/width/height — real columns
-- nothing mirrored. So on any order built the normal way every item.* resolved
-- to 0 and a formula collapsed to its constant term: "Cut Plate" fell from 38.8
-- minutes to 10 on every part regardless of size, silently, because the engine
-- deliberately defaults unknown symbols to 0 so IF() fallbacks can work.
--
-- fab_field_defs is fab_item_metric_defs generalised — that table was already
-- the only thing in the system carrying BOTH data_type and unit, i.e. it was
-- the field registry all along, just named "metric" and wired to nothing.
-- Values move to fab_custom_fields, which already holds per-catalog-item,
-- per-category and per-stock-piece values.
--
-- Additive and idempotent: nothing is dropped here. fab_item_metric_defs /
-- _values and fab_items.length/width/height stay until Phase 4, so this file
-- can be re-run and the change abandoned by ignoring the new table.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS fab_field_defs (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  company_id     INT           NOT NULL,
  field_key      VARCHAR(100)  NOT NULL,
  label          VARCHAR(255)  NOT NULL,
  -- number | integer | text. A text field can never be formula_usable: the
  -- engine coerces with Number(), so text yields NaN, the try/catch returns
  -- null, and the task gets a zero-length bar with no error anywhere.
  data_type      VARCHAR(20)   NOT NULL DEFAULT 'number',
  unit           VARCHAR(50)   NULL,
  formula_usable TINYINT(1)    NOT NULL DEFAULT 1,
  -- Whether the value may differ per physical piece. OFF by default and
  -- nominated per field: a silent piece-level override would change a task's
  -- estimate the moment stock was issued, which is either exactly right or
  -- very surprising depending on the field.
  piece_varying  TINYINT(1)    NOT NULL DEFAULT 0,
  default_value  DECIMAL(18,6) NULL,
  -- Optional taxonomy attachment: which items USUALLY carry this field. A
  -- convenience for the editor, never a constraint — the authoritative
  -- required set is derived from the flow's formulas (see itemFieldService).
  category_id    INT           NULL,
  group_id       INT           NULL,
  subgroup_id    INT           NULL,
  sort_order     INT           NOT NULL DEFAULT 0,
  active         TINYINT(1)    NOT NULL DEFAULT 1,
  notes          TEXT          NULL,
  deleted_at     DATETIME      DEFAULT NULL,
  created_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_ffd_company (company_id),
  KEY idx_ffd_key     (company_id, field_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Definitions from the old metric registry. KEYS ARE PRESERVED EXACTLY: every
-- live formula references item.length_mm / item.weld_length_m / item.thickness_mm
-- by name, so a renamed key breaks every formula in the company at once.
INSERT INTO fab_field_defs
  (company_id, field_key, label, data_type, unit, formula_usable, sort_order)
SELECT d.company_id, d.metric_key, d.metric_label,
       CASE WHEN d.data_type IN ('text','string') THEN 'text' ELSE 'number' END,
       d.unit,
       CASE WHEN d.data_type IN ('text','string') THEN 0 ELSE 1 END,
       0
  FROM fab_item_metric_defs d
 WHERE d.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM fab_field_defs f
                    WHERE f.company_id = d.company_id AND f.field_key = d.metric_key
                      AND f.deleted_at IS NULL);

-- The three dimension keys must exist as definitions before their values move,
-- or migrated values would have no type and no unit.
INSERT INTO fab_field_defs
  (company_id, field_key, label, data_type, unit, formula_usable, sort_order)
SELECT co.id, k.field_key, k.label, 'number', 'mm', 1, k.so
  FROM companies co
  JOIN (SELECT 'length_mm' AS field_key, 'Length' AS label, 1 AS so
        UNION ALL SELECT 'width_mm', 'Width', 2
        UNION ALL SELECT 'thickness_mm', 'Thickness', 3) k
 WHERE EXISTS (SELECT 1 FROM fab_items i WHERE i.company_id = co.id AND i.deleted_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM fab_field_defs f
                    WHERE f.company_id = co.id AND f.field_key = k.field_key
                      AND f.deleted_at IS NULL);

-- Definitions for custom-field keys already in use that the registry has never
-- heard of (23 item-level + 90 stock_piece-level rows in production). Without
-- this they stay untyped and unitless, which is the state this change exists to
-- end. Defaulted to text/non-formula: promoting a field to numeric is a
-- deliberate act, and guessing it would put unvalidated values into estimates.
INSERT INTO fab_field_defs
  (company_id, field_key, label, data_type, unit, formula_usable, sort_order)
SELECT c.company_id, c.field_key, c.field_key, 'text', NULL, 0, 100
  FROM (SELECT DISTINCT company_id, field_key FROM fab_custom_fields WHERE deleted_at IS NULL) c
 WHERE NOT EXISTS (SELECT 1 FROM fab_field_defs f
                    WHERE f.company_id = c.company_id AND f.field_key = c.field_key
                      AND f.deleted_at IS NULL);

-- Values: fab_item_metric_values → fab_custom_fields at level 'order_item'.
--
-- 'order_item', NOT 'item'. `level='item'` already means a CATALOG item
-- (level_id = fab_item_catalog.id) — see the fab_item_config_values migration
-- earlier in this file. Reusing it for fab_items rows would collide two id
-- spaces in one column and mix a catalog item's fields with an order item's.
INSERT INTO fab_custom_fields
  (company_id, level, level_id, field_key, field_type, field_value, sort_order)
SELECT v.company_id, 'order_item', v.item_id, v.metric_key, 'number',
       CAST(v.metric_value AS CHAR), 0
  FROM fab_item_metric_values v
 WHERE v.deleted_at IS NULL AND v.metric_value IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM fab_custom_fields c
                    WHERE c.company_id = v.company_id AND c.level = 'order_item'
                      AND c.level_id = v.item_id AND c.field_key = v.metric_key
                      AND c.deleted_at IS NULL);

-- Values: fab_items.length → length_mm
INSERT INTO fab_custom_fields
  (company_id, level, level_id, field_key, field_type, field_value, sort_order)
SELECT i.company_id, 'order_item', i.id, 'length_mm', 'number', CAST(i.length AS CHAR), 0
  FROM fab_items i
 WHERE i.deleted_at IS NULL AND i.length IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM fab_custom_fields c
                    WHERE c.company_id = i.company_id AND c.level = 'order_item'
                      AND c.level_id = i.id AND c.field_key = 'length_mm'
                      AND c.deleted_at IS NULL);

-- Values: fab_items.width → width_mm
INSERT INTO fab_custom_fields
  (company_id, level, level_id, field_key, field_type, field_value, sort_order)
SELECT i.company_id, 'order_item', i.id, 'width_mm', 'number', CAST(i.width AS CHAR), 0
  FROM fab_items i
 WHERE i.deleted_at IS NULL AND i.width IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM fab_custom_fields c
                    WHERE c.company_id = i.company_id AND c.level = 'order_item'
                      AND c.level_id = i.id AND c.field_key = 'width_mm'
                      AND c.deleted_at IS NULL);

-- Values: fab_items.height → THICKNESS_MM.
--
-- NOT height_mm. The BOQ sheet's "Thick" column is declared with key 'height'
-- (boqSheetService COLS), so fab_items.height holds THICKNESS. Mapping it to a
-- height_mm field would silently destroy every thickness value in the system
-- and leave formulas reading 0 for the dimension that decides cutting time.
INSERT INTO fab_custom_fields
  (company_id, level, level_id, field_key, field_type, field_value, sort_order)
SELECT i.company_id, 'order_item', i.id, 'thickness_mm', 'number', CAST(i.height AS CHAR), 0
  FROM fab_items i
 WHERE i.deleted_at IS NULL AND i.height IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM fab_custom_fields c
                    WHERE c.company_id = i.company_id AND c.level = 'order_item'
                      AND c.level_id = i.id AND c.field_key = 'thickness_mm'
                      AND c.deleted_at IS NULL);

-- fab_project_tasks.task_qty (2026-08-15) — how many pieces this task covers.
--
-- A time formula is PER PIECE (a shop's cycle time), but nothing multiplied it
-- by the quantity, so a task covering 20 flanges was estimated as one. And
-- `item.qty` was not even reachable from a formula: item.* resolves from field
-- values, so a formula naming it read 0.
--
-- SNAPSHOTTED at materialization rather than joined to fab_items.qty at read
-- time, for the same reason computed_hours is: a BOM quantity edited after the
-- fact must not silently move the estimate under a plan that has already been
-- committed and possibly started. Re-materialization is the deliberate path for
-- picking up a changed quantity.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_project_tasks' AND COLUMN_NAME='task_qty');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_project_tasks ADD COLUMN task_qty DECIMAL(18,4) NULL AFTER computed_hours',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Backfill from the item each task belongs to. NULL is treated as 1 by
-- taskDuration, so an un-backfilled row keeps exactly its old behaviour.
UPDATE fab_project_tasks t
   JOIN fab_items i ON i.id = t.item_id AND i.deleted_at IS NULL
    SET t.task_qty = i.qty
 WHERE t.task_qty IS NULL AND t.deleted_at IS NULL AND i.qty IS NOT NULL;

-- fab_operation_flow_steps.params_json (2026-08-15) — the step.* namespace.
--
-- `formulaEngine` has documented a `step.*` namespace since it was written, and
-- `evaluateFormula` takes a stepValues argument — but every caller passed `{}`
-- and no table had anywhere to put them, so `step.anything` silently evaluated
-- to 0. This is the storage.
--
-- WHY IT MATTERS. The same operation legitimately behaves differently in
-- different flows: one flow rolls a plate along its length, another across its
-- width; one drills a pilot hole, another the full bore. Without a per-step
-- parameter the only way to express that is to clone the operation, which
-- multiplies the master data and leaves two "Cut Plate" rows whose formulas
-- drift apart. A step parameter says it once, on the step that means it.
--
-- JSON rather than a child table: these are a handful of scalars read as a unit
-- every time a task materializes, never queried across steps, and never joined.
-- A child table would be three more queries per materialize for no gain.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_operation_flow_steps'
               AND COLUMN_NAME='params_json');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_operation_flow_steps ADD COLUMN params_json JSON NULL AFTER resource_type_id',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- fab_operations.setup_minutes + fab_project_tasks.setup_hours (2026-08-15)
--
-- A time formula is PER PIECE and planning multiplies it by task_qty. That is
-- right for run time and wrong for setup: setting up a machine happens ONCE
-- for the run, not once per piece. Every seeded formula carried its setup as a
-- constant term ("10 + cut length / speed"), so a 20-off task was billing 200
-- minutes of setup for one setup — the estimate grew with quantity in a way the
-- shop floor does not.
--
-- WHY TWO COLUMNS. `setup_minutes` on the operation is the master datum a
-- planner edits. `setup_hours` on the task is that value FROZEN at
-- materialization, exactly as `computed_hours` freezes the formula result. The
-- task table is read by twelve scheduling paths that do not join operations;
-- making them join would be twelve chances to forget, and re-deriving setup at
-- read time would silently re-time committed work every time somebody edited an
-- operation. Both columns NULL ⇒ 0 ⇒ precisely the old behaviour.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_operations' AND COLUMN_NAME='setup_minutes');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_operations ADD COLUMN setup_minutes DECIMAL(10,2) NULL AFTER time_unit',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_project_tasks' AND COLUMN_NAME='setup_hours');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_project_tasks ADD COLUMN setup_hours DECIMAL(10,4) NULL AFTER computed_hours',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Deliberately NOT backfilled. Existing formulas still carry their setup as a
-- constant inside time_formula; writing a setup_minutes now would charge it
-- twice. Moving a constant out of a formula is a per-operation judgement (which
-- part of "10 + x" is setup?), so it is left to whoever edits the operation.

-- ── Machine asset register + planned maintenance (2026-08-16) ───────────────
--
-- A resource was a capacity figure and nothing else: what it can do per day,
-- what it costs per hour. It is also a thing somebody bought on a date for an
-- amount, that wears out, and that has to be stopped periodically to be looked
-- after. None of that was recordable, so "when was this last serviced" and
-- "what is it worth" lived in somebody's head or a spreadsheet.
--
-- WHY THE ASSET FIELDS ARE ON THE RESOURCE, NOT THE TYPE. A resource TYPE is a
-- class ("CNC Plate Cutting") — it has no purchase date, because three tables
-- of the same type were bought in different years for different money. Every
-- one of these is a fact about one physical machine.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resources' AND COLUMN_NAME='purchase_date');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_resources
     ADD COLUMN purchase_date        DATE          NULL,
     ADD COLUMN commissioned_date    DATE          NULL,
     ADD COLUMN supplier_id          INT           NULL,
     ADD COLUMN serial_no            VARCHAR(120)  NULL,
     ADD COLUMN asset_tag            VARCHAR(60)   NULL,
     ADD COLUMN warranty_until       DATE          NULL,
     ADD COLUMN asset_cost           DECIMAL(18,2) NULL,
     ADD COLUMN salvage_value        DECIMAL(18,2) NULL,
     ADD COLUMN useful_life_years    DECIMAL(6,2)  NULL,
     ADD COLUMN depreciation_method  VARCHAR(20)   NULL,
     ADD COLUMN depreciation_rate_pct DECIMAL(6,3) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- `currency` already exists on fab_resources (it carried cost_per_hour) and is
-- reused for asset_cost rather than adding a second one — two currency columns
-- on one row is an invitation to set them differently.
--
-- ACCUMULATED DEPRECIATION IS DELIBERATELY NOT A COLUMN. It is a pure function
-- of cost, method, life, salvage and elapsed time, so storing it means storing
-- something that is wrong every day after it is written and that can disagree
-- with the inputs sitting beside it. It is computed on read — see
-- services/assetService.js.

-- ── Maintenance plans: what has to be done, how often ───────────────────────
--
-- Calendar-based on purpose. Runtime-based ("every 500 running hours") is the
-- other real model and the event data to support it exists, but a shop that
-- cannot yet say when a machine was last greased is not helped by a second
-- trigger type it also cannot populate. `frequency_days` is the whole rule.
--
-- ON THE RESOURCE, NOT THE TYPE. The interval is often a type-level convention
-- ("grease every plasma table monthly") but the DUE DATE is per machine, and
-- the due date is the only thing anybody acts on.
CREATE TABLE IF NOT EXISTS fab_maintenance_plans (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  company_id      INT NOT NULL,
  resource_id     INT NOT NULL,
  name            VARCHAR(160) NOT NULL,
  -- The interval. NOT NULL because a plan with no interval is a note, not a plan.
  frequency_days  INT NOT NULL,
  -- How many days before it is due to start warning. Zero = warn on the day.
  lead_days       INT NOT NULL DEFAULT 7,
  last_done_at    DATE NULL,
  -- Derived (last_done_at + frequency_days) but STORED, because it is what
  -- every due-list query filters and sorts on, and recomputing it per row per
  -- query to answer "what is due this week" across a shop is a scan.
  -- maintenanceService is the only writer.
  next_due_at     DATE NULL,
  active          TINYINT(1) NOT NULL DEFAULT 1,
  notes           TEXT NULL,
  deleted_at      DATETIME NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_mp_company_resource (company_id, resource_id),
  INDEX idx_mp_due (company_id, next_due_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Maintenance logs: what was actually done, and when ──────────────────────
--
-- One row per occurrence. `plan_id` is nullable because a breakdown repair is
-- maintenance too and does not belong to a cycle — refusing to record it would
-- push exactly the events worth knowing about back into somebody's head.
--
-- An open row (completed_at IS NULL) is what "this machine is in maintenance"
-- means. The machine's `down` state is written to fab_resource_events at the
-- same moment, so the planner and the machine board see it without knowing this
-- table exists — but this table is the record of WHY.
CREATE TABLE IF NOT EXISTS fab_maintenance_logs (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  company_id      INT NOT NULL,
  resource_id     INT NOT NULL,
  plan_id         INT NULL,
  -- What it was due on when it was started, copied not joined: a plan's
  -- next_due_at moves the moment this completes, and the history has to keep
  -- saying whether this one was late.
  due_at          DATE NULL,
  started_at      DATETIME NOT NULL,
  completed_at    DATETIME NULL,
  started_by      INT NULL,
  completed_by    INT NULL,
  -- Filled on completion from started_at..completed_at. Stored because the
  -- machine may be deleted or its events pruned, and "how long were we down
  -- for maintenance last year" has to survive that.
  downtime_minutes INT NULL,
  notes           TEXT NULL,
  deleted_at      DATETIME NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ml_company_resource (company_id, resource_id),
  INDEX idx_ml_open (company_id, resource_id, completed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Purchase orders raised FOR a machine or a machine type (2026-08-16) ─────
--
-- Two new reasons to buy something, neither of which is a sales order:
--   spare parts for a specific machine   -> for_resource_id
--   a new machine of a given type        -> for_resource_type_id
--
-- On the PO header rather than a join table because a purchase order is raised
-- for exactly one of these, and the question people ask is "what have we spent
-- on this machine" — which is a filter on the header, not a graph walk.
--
-- `source_order_id` already links a PO to the SALES order that caused it; these
-- are the same idea for the other two causes, kept as separate columns so a
-- query never has to guess which kind of id it is looking at.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_orders' AND COLUMN_NAME='for_resource_id');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_orders
     ADD COLUMN for_resource_id      INT NULL,
     ADD COLUMN for_resource_type_id INT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_orders' AND INDEX_NAME='idx_fo_for_resource');
SET @sql = IF(@idx=0,
  'ALTER TABLE fab_orders ADD KEY idx_fo_for_resource (company_id, for_resource_id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ══ CATALOG UNIFICATION, PHASE 1 (2026-08-16) ══════════════════════════════
-- Makes the field registry capable of describing every physical thing. Purely
-- additive: nothing reads these until Phase 2, so this cannot change behaviour.
-- See FAB_ERP_CATALOG_UNIFICATION_PLAN.md.

-- ── fab_field_defs.level — where a field is AUTHORED ────────────────────────
--
-- Replaces the `piece_varying` boolean, which could say "may differ per piece"
-- but could not say "meaningless at item level". `length_mm` on the catalog row
-- "MS Plate 20mm" IS meaningless — that item covers every length ever bought —
-- so the boolean allowed a value to be entered somewhere it can only mislead.
--
--   item   authored on the catalog item; every piece inherits it (thickness)
--   piece  authored on the stock piece ONLY (length, heat number)
--   both   authored on the item, overridable per piece
--
-- It also tells the UI which screen to ask on, which the boolean could not.
--
-- `piece_varying` is KEPT and backfilled from, per the plan's rule 1 (additive
-- first, destructive last). Phase 11 drops it.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_field_defs' AND COLUMN_NAME='level');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_field_defs ADD COLUMN level VARCHAR(10) NOT NULL DEFAULT ''item'' AFTER piece_varying',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Existing defs: piece_varying = 1 meant "can differ per piece", which is
-- exactly `both`. Everything else is item-level. Guarded so a later re-run
-- never overwrites a level somebody has since set deliberately.
UPDATE fab_field_defs
   SET level = IF(piece_varying = 1, 'both', 'item')
 WHERE deleted_at IS NULL AND (level IS NULL OR level = '' OR level = 'item')
   AND piece_varying = 1;

-- ── fab_field_defs.allowed_values — a field that is a PICKER ───────────────
--
-- A JSON array of permitted values. Present ⇒ the editor renders a dropdown and
-- rejects anything else; absent ⇒ free entry as before.
--
-- WHY IT MATTERS BEYOND TIDINESS. `cost_treatment` decides whether a spare is
-- expensed or capitalised, and as free text it can hold "expense", "Expense"
-- and "expensed" — three values, one meaning, and an accounting split that
-- silently drops rows it does not recognise. The same already happened once in
-- this registry: `Thickness (mm)` exists as free text alongside the numeric
-- `thickness_mm`.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_field_defs' AND COLUMN_NAME='allowed_values');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_field_defs ADD COLUMN allowed_values JSON NULL AFTER unit',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── Housekeeping: fab_order_lines has never had a CREATE TABLE ─────────────
--
-- init.sql only ever ALTERs it; the table is assumed to pre-exist from the
-- legacy schema. Both live databases have it, so nothing is broken today — but
-- a database built from init.sql alone would fail on every ALTER below.
--
-- The shape here is copied from the LIVE table, deliberately. A
-- `CREATE TABLE IF NOT EXISTS` whose columns disagree with an existing table
-- silently does nothing and leaves the wrong shape in place — that is the
-- fab_bom_templates trap recorded in §13. Copying the live shape means this is
-- a no-op everywhere it already exists, and correct where it does not.
CREATE TABLE IF NOT EXISTS fab_order_lines (
  id              INT NOT NULL AUTO_INCREMENT,
  company_id      INT NOT NULL,
  order_id        INT NOT NULL,
  line_no         INT NOT NULL DEFAULT 1,
  code            VARCHAR(60)   DEFAULT NULL,
  description     VARCHAR(255)  DEFAULT NULL,
  qty             DECIMAL(14,4) NOT NULL DEFAULT 0.0000,
  unit            VARCHAR(20)   DEFAULT NULL,
  unit_price      DECIMAL(14,4) DEFAULT NULL,
  discount        DECIMAL(8,4)  DEFAULT NULL,
  status          VARCHAR(30)   DEFAULT NULL,
  qty_completed   DECIMAL(14,4) DEFAULT 0.0000,
  scheduled_start DATETIME      DEFAULT NULL,
  scheduled_end   DATETIME      DEFAULT NULL,
  notes           TEXT          DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at      DATETIME      DEFAULT NULL,
  line_type       VARCHAR(40)   DEFAULT NULL,
  catalog_item_id INT           DEFAULT NULL,
  qty_received    DECIMAL(18,4) NOT NULL DEFAULT 0,
  expected_date   DATE          DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_fab_order_lines_order (order_id),
  KEY fk_fab_order_lines_company (company_id),
  KEY idx_fol_catalog (company_id, catalog_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Same gap: `shift_calendar_id` exists only in a hand-applied migration, yet
-- resourceDef.json and four services depend on it.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resources' AND COLUMN_NAME='shift_calendar_id');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_resources ADD COLUMN shift_calendar_id INT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ══ CATALOG UNIFICATION, PHASE 2 (2026-08-16) ══════════════════════════════
-- Defines what fields each KIND of thing has, scoped by category and placed at
-- the level where the value actually varies. Definitions and a de-duplication
-- only — no storage moves; those are Phase 3.
--
-- Seeded per company and resolved by category CODE, never id: the taxonomy is
-- seeded separately per company so the ids differ, and a hardcoded id would
-- attach a raw-material field to whatever category happened to hold that id in
-- the next tenant.

-- ── A Machines category, so machine fields have somewhere to hang ──────────
-- Phase 8 turns resource types into catalog items in this category. Creating it
-- now costs nothing and lets Phase 2 keep its promise: "what fields does X
-- have" answered for every kind of thing, in one place, once.
INSERT INTO fab_item_categories (company_id, code, name)
SELECT co.id, 'mach', 'Machines & Equipment'
  FROM companies co
 WHERE NOT EXISTS (SELECT 1 FROM fab_item_categories c
                    WHERE c.company_id = co.id AND c.code = 'mach' AND c.deleted_at IS NULL);

-- ── 1. Place the EXISTING canonical fields ────────────────────────────────
--
-- These already exist unscoped and at the default level. Only rows still in the
-- untouched default state are moved, so a level somebody has since set by hand
-- is never overwritten by a re-run.

-- Dimensions are `both`: a part carries its own on the order, and a stock piece
-- carries the plate's. Same key, different subjects, different steps of the
-- resolution chain.
UPDATE fab_field_defs SET level = 'both', piece_varying = 1
 WHERE deleted_at IS NULL AND level = 'item' AND piece_varying = 0
   AND field_key IN ('length_mm', 'width_mm');

-- Thickness is the item's identity — "MS Plate 20mm" IS 20mm — so it is never
-- authored per piece.
UPDATE fab_field_defs SET level = 'item'
 WHERE deleted_at IS NULL AND field_key = 'thickness_mm';

-- ── 2. Retire the duplicates ──────────────────────────────────────────────
--
-- Deactivated, NOT deleted, per the plan's rule 1 (additive first, destructive
-- last). Phase 11 removes them once the dual-read window has been clean.
--
--   `Thickness (mm)`  a THIRD copy — verified value-by-value against
--                     fab_item_catalog.thickness_mm on 2026-08-16, all seven
--                     agree, so there is nothing to migrate. Phase 3 moves the
--                     column itself into the registry.
--   `Length (mm)` / `Width (mm)`  category-level rows holding NULL. Empty
--                     definitions, nothing to carry across.
--   `length`          a single value of "0" — junk from an early import.
UPDATE fab_field_defs
   SET active = 0,
       notes = CONCAT(COALESCE(notes, ''),
                      '\nRetired 2026-08-16 (catalog unification Phase 2): duplicates a canonical numeric field.')
 WHERE deleted_at IS NULL AND active = 1
   AND field_key IN ('Thickness (mm)', 'Length (mm)', 'Width (mm)', 'length');

UPDATE fab_custom_fields SET deleted_at = NOW()
 WHERE deleted_at IS NULL
   AND field_key IN ('Thickness (mm)', 'Length (mm)', 'Width (mm)', 'length');

-- ── 2b. `Grade` is UPGRADED IN PLACE, not replaced ────────────────────────
--
-- It already holds the real data (seven catalog items say "E350 B0"), and its
-- CATEGORY-level row held "E250 B0, E250 BR, E350 B0, E350 BR" — a list of
-- permitted values stuffed into a value field, because until Phase 1 there was
-- nowhere else to put it. So the list becomes `allowed_values` and the key
-- stays exactly as it is.
--
-- IT MUST NOT BECOME A NEW `grade` KEY, for a reason worth remembering:
-- `fab_custom_fields.field_key` collates utf8mb4_0900_ai_ci and therefore
-- compares CASE-INSENSITIVELY, while `fab_field_defs.field_key` compares
-- case-sensitively. Seeding a lowercase `grade` alongside the existing `Grade`
-- created a second definition, while every value-migration INSERT was silently
-- blocked by its own NOT EXISTS guard matching the old rows. The result was two
-- definitions, no values moved, and nothing to show for it — caught only by
-- verify-field-consolidation.mjs. Plan rule 7 already said it: never rename a
-- key in place.
UPDATE fab_field_defs
   SET allowed_values = '["E250 B0","E250 BR","E350 B0","E350 BR"]',
       data_type = 'text', formula_usable = 0, level = 'item',
       category_id = (SELECT c.id FROM fab_item_categories c
                       WHERE c.company_id = fab_field_defs.company_id
                         AND c.code = 'rm' AND c.deleted_at IS NULL LIMIT 1)
 WHERE deleted_at IS NULL AND field_key = 'Grade' AND allowed_values IS NULL;

-- Remove the stray lowercase definition an earlier run of this block created.
UPDATE fab_field_defs SET deleted_at = NOW()
 WHERE deleted_at IS NULL AND BINARY field_key = 'grade';

-- The category row was never a value — it was the list, which is now on the
-- definition. Leaving it would show every raw-material category a "Grade" of
-- "E250 B0, E250 BR, E350 B0, E350 BR", which its own picker rejects.
UPDATE fab_custom_fields SET deleted_at = NOW()
 WHERE deleted_at IS NULL AND field_key = 'Grade' AND level = 'category';

-- ── 3. Free-text fields that are really typed values ──────────────────────
INSERT INTO fab_field_defs
  (company_id, field_key, label, data_type, unit, allowed_values,
   formula_usable, piece_varying, level, category_id, sort_order, active)
SELECT co.id, f.field_key, f.label, f.data_type, f.unit, f.allowed_values,
       f.formula_usable, IF(f.level = 'item', 0, 1), f.level, cat.id, f.sort_order, 1
  FROM companies co
  JOIN (
    -- key                  label                    type      unit     allowed_values                                                   fu lvl     cat     sort
    SELECT 'material_form'       AS field_key, 'Material form'        AS label, 'text'   AS data_type, NULL     AS unit, '["plate","section","bar","tube","sheet"]' AS allowed_values, 0 AS formula_usable, 'item'  AS level, 'rm'   AS cat_code, 11 AS sort_order
    UNION ALL SELECT 'density_kg_m3',        'Density',              'number',  'kg/m3', NULL,                                                      1, 'item',  'rm',   12
    UNION ALL SELECT 'section_area_mm2',     'Section area',         'number',  'mm2',   NULL,                                                      1, 'item',  'rm',   13
    UNION ALL SELECT 'rate_per_kg',          'Rate',                 'number',  'INR/kg', NULL,                                                      0, 'item',  'rm',   14
    UNION ALL SELECT 'heat_no',              'Heat / batch no',      'text',    NULL,    NULL,                                                      0, 'piece', 'rm',   15
    UNION ALL SELECT 'mill_cert_ref',        'Mill certificate',     'text',    NULL,    NULL,                                                      0, 'piece', 'rm',   16
    -- Spares
    UNION ALL SELECT 'manufacturer',         'Manufacturer',         'text',    NULL,    NULL,                                                      0, 'item',  'mro',  20
    UNION ALL SELECT 'part_number',          'Manufacturer part no', 'text',    NULL,    NULL,                                                      0, 'item',  'mro',  21
    UNION ALL SELECT 'cost_treatment',       'Cost treatment',       'text',    NULL,    '["expense","capitalise"]',                                0, 'item',  'mro',  22
    UNION ALL SELECT 'lead_time_days',       'Lead time',            'number',  'days',  NULL,                                                      0, 'item',  'mro',  23
    UNION ALL SELECT 'reorder_level',        'Reorder level',        'number',  'nos',   NULL,                                                      0, 'item',  'mro',  24
    UNION ALL SELECT 'condition',            'Condition',            'text',    NULL,    '["new","refurbished","used"]',                            0, 'piece', 'mro',  25
    -- Consumables
    UNION ALL SELECT 'pack_size',            'Pack size',            'number',  'nos',   NULL,                                                      0, 'item',  'cons', 30
    UNION ALL SELECT 'shelf_life_days',      'Shelf life',           'number',  'days',  NULL,                                                      0, 'item',  'cons', 31
    UNION ALL SELECT 'batch_no',             'Batch no',             'text',    NULL,    NULL,                                                      0, 'piece', 'cons', 32
    UNION ALL SELECT 'expiry_date',          'Expiry date',          'date',    NULL,    NULL,                                                      0, 'piece', 'cons', 33
    -- Machines: the TYPE is the catalog item, the MACHINE is the stock piece.
    UNION ALL SELECT 'model',                'Model',                'text',    NULL,    NULL,                                                      0, 'item',  'mach', 40
    UNION ALL SELECT 'power_kw',             'Power',                'number',  'kW',    NULL,                                                      1, 'item',  'mach', 41
    UNION ALL SELECT 'max_thickness_mm',     'Max thickness',        'number',  'mm',    NULL,                                                      1, 'item',  'mach', 42
    UNION ALL SELECT 'serial_no',            'Serial no',            'text',    NULL,    NULL,                                                      0, 'piece', 'mach', 43
    UNION ALL SELECT 'asset_tag',            'Asset tag',            'text',    NULL,    NULL,                                                      0, 'piece', 'mach', 44
    UNION ALL SELECT 'purchase_date',        'Purchased on',         'date',    NULL,    NULL,                                                      0, 'piece', 'mach', 45
    UNION ALL SELECT 'commissioned_date',    'Commissioned on',      'date',    NULL,    NULL,                                                      0, 'piece', 'mach', 46
    UNION ALL SELECT 'warranty_until',       'Warranty until',       'date',    NULL,    NULL,                                                      0, 'piece', 'mach', 47
    UNION ALL SELECT 'asset_cost',           'Asset cost',           'number',  'INR',   NULL,                                                      0, 'piece', 'mach', 48
    UNION ALL SELECT 'salvage_value',        'Salvage value',        'number',  'INR',   NULL,                                                      0, 'piece', 'mach', 49
    UNION ALL SELECT 'useful_life_years',    'Useful life',          'number',  'years', NULL,                                                      0, 'piece', 'mach', 50
    UNION ALL SELECT 'depreciation_method',  'Depreciation method',  'text',    NULL,    '["straight_line","wdv","none"]', 0, 'piece', 'mach', 51
  ) f
  JOIN fab_item_categories cat
    ON cat.company_id = co.id AND cat.code = f.cat_code AND cat.deleted_at IS NULL
 WHERE NOT EXISTS (SELECT 1 FROM fab_field_defs d
                    WHERE d.company_id = co.id AND d.field_key = f.field_key
                      AND d.deleted_at IS NULL);

-- ── 4. Carry the free-text values onto their typed definitions ────────────
--
-- Only where the value survives being read as what the new definition says it
-- is. A row that does not convert is LEFT WHERE IT IS rather than dropped, and
-- the retirement above deliberately does not cover these keys, so nothing is
-- lost silently — `scripts/verify-field-consolidation.mjs` lists them.
INSERT INTO fab_custom_fields
  (company_id, level, level_id, field_key, field_type, field_value, sort_order)
SELECT c.company_id, c.level, c.level_id, m.new_key, 'number', c.field_value, 0
  FROM fab_custom_fields c
  JOIN (SELECT 'Rate (INR/kg)' AS old_key, 'rate_per_kg' AS new_key
        UNION ALL SELECT 'Sell Rate (INR/kg)', 'sell_rate_per_kg'
        UNION ALL SELECT 'Estimated Value (INR)', 'estimated_value'
        UNION ALL SELECT 'Total Steel Weight (kg)', 'total_steel_weight_kg') m
    ON m.old_key = c.field_key
 WHERE c.deleted_at IS NULL
   AND c.field_value REGEXP '^-?[0-9]+(\\.[0-9]+)?$'
   AND NOT EXISTS (SELECT 1 FROM fab_custom_fields x
                    WHERE x.company_id = c.company_id AND x.level = c.level
                      AND x.level_id = c.level_id AND x.field_key = m.new_key
                      AND x.deleted_at IS NULL);

-- Grade needs no value migration — it was upgraded in place in step 2b, so its
-- seven item-level values are already under the right definition.

-- The remaining free-text definitions get a typed replacement seeded above and
-- are retired only once their values have moved — which the verifier confirms
-- before Phase 11 drops anything.
INSERT INTO fab_field_defs
  (company_id, field_key, label, data_type, unit, formula_usable, piece_varying, level, sort_order, active)
SELECT co.id, f.field_key, f.label, f.data_type, f.unit, 0, 0, 'item', f.sort_order, 1
  FROM companies co
  JOIN (SELECT 'sell_rate_per_kg' AS field_key, 'Sell rate' AS label, 'number' AS data_type, 'INR' AS unit, 60 AS sort_order
        UNION ALL SELECT 'estimated_value',       'Estimated value',      'number', 'INR', 61
        UNION ALL SELECT 'total_steel_weight_kg', 'Total steel weight',   'number', 'kg',  62
        UNION ALL SELECT 'drawing_ref',           'Drawing reference',    'text',   NULL,  63
        UNION ALL SELECT 'span_ref',              'Span reference',       'text',   NULL,  64) f
 WHERE NOT EXISTS (SELECT 1 FROM fab_field_defs d
                    WHERE d.company_id = co.id AND d.field_key = f.field_key
                      AND d.deleted_at IS NULL);

-- ══ CATALOG UNIFICATION, PHASE 4 (2026-08-16) ══════════════════════════════
-- `consumable` and `cost_treatment` as inherited fields.
--
-- CORRECTION TO THE PLAN. Phase 4 was written as "the material rule flips to
-- include where consumable = yes, deleting the hardcoded exclusion list". That
-- is wrong, and building it would have made the material picker worse than it
-- is today. Two different questions were conflated:
--
--   "can this be issued INTO a product?"   a bolt yes, paint yes, plate yes,
--                                          a machine never.  -> `consumable`
--   "can a part be CUT FROM this?"         plate yes, section yes, a bolt no,
--                                          paint no.          -> a SCOPE
--
-- `consumable = yes` is true of bolts and paint, so using it for the picker
-- would pull both back in — the exact opposite of the `NOT_CUT_FROM` exclusion
-- it was meant to replace. The picker rule is an inclusion over TAXONOMY
-- (category = Raw Materials), which is Phase 7's scopes, and the hardcoded list
-- stays until then rather than being replaced by something worse.

-- ── `consumable` — may stock of this item be consumed into a product? ──────
--
-- Unscoped: it applies to every category, unlike the raw-material or spare
-- fields which only make sense for their own kind of thing.
INSERT INTO fab_field_defs
  (company_id, field_key, label, data_type, allowed_values,
   formula_usable, piece_varying, level, sort_order, active, notes)
SELECT co.id, 'consumable', 'Can be consumed into a product', 'bool', '["yes","no"]',
       0, 0, 'item', 5, 1,
       'Set on the CATEGORY and inherited. Machines and tooling are "no"; that is what stops a machine being issued as material.'
  FROM companies co
 WHERE NOT EXISTS (SELECT 1 FROM fab_field_defs d
                    WHERE d.company_id = co.id AND d.field_key = 'consumable'
                      AND d.deleted_at IS NULL);

-- Values on the categories, inherited by every item beneath them.
--
-- FAIL-OPEN ON UNSET, DELIBERATELY. Phase 6 will refuse consumption only for an
-- explicit `no`, never for a blank. Refusing to issue material is a hard block
-- on shop-floor work, and a category somebody has not classified yet must not
-- stop a job that runs fine today. That is the opposite of the choice made for
-- the PICKER, where an unclassified category is excluded until somebody says
-- otherwise — because excluding something from a dropdown costs nothing and
-- including the wrong thing is how paint ended up offered as plate.
INSERT INTO fab_custom_fields
  (company_id, level, level_id, field_key, field_type, field_value, sort_order)
SELECT c.company_id, 'category', c.id, 'consumable', 'text', v.val, 0
  FROM fab_item_categories c
  JOIN (SELECT 'rm'   AS code, 'yes' AS val
        UNION ALL SELECT 'cons', 'yes'
        UNION ALL SELECT 'fast', 'yes'
        UNION ALL SELECT 'pack', 'yes'
        UNION ALL SELECT 'sfg',  'yes'
        -- The three that must never be issued as material.
        UNION ALL SELECT 'mach', 'no'
        UNION ALL SELECT 'tool', 'no'
        UNION ALL SELECT 'mro',  'no') v
    ON v.code = c.code
 WHERE c.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM fab_custom_fields x
                    WHERE x.company_id = c.company_id AND x.level = 'category'
                      AND x.level_id = c.id AND x.field_key = 'consumable'
                      AND x.deleted_at IS NULL);

-- ── `cost_treatment` — expense or capitalise ──────────────────────────────
--
-- Defaulted on the MRO category so every spare inherits "expense", which is the
-- treatment the overwhelming majority get: filters, belts, lubricants and
-- consumable tooling are charged to the period they are used in and do not
-- change what the machine is worth.
--
-- A group or an individual item overrides it. That is where the other two real
-- treatments live: a major spare that extends the machine's life or capability
-- (a control system, a spindle rebuild) is capitalised, and so is an insurance
-- spare bought for one machine and held against failure — under IAS 16 those
-- are fixed assets rather than inventory, depreciated over the life of the
-- machine they serve even while sitting on the shelf.
--
-- Set on the category rather than per purchase, because policy belongs in one
-- place a finance person can see, not on a checkbox somebody ticks on a Friday.
INSERT INTO fab_custom_fields
  (company_id, level, level_id, field_key, field_type, field_value, sort_order)
SELECT c.company_id, 'category', c.id, 'cost_treatment', 'text', 'expense', 0
  FROM fab_item_categories c
 WHERE c.code = 'mro' AND c.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM fab_custom_fields x
                    WHERE x.company_id = c.company_id AND x.level = 'category'
                      AND x.level_id = c.id AND x.field_key = 'cost_treatment'
                      AND x.deleted_at IS NULL);

-- `cost_treatment` was seeded in Phase 2 scoped to MRO only. Machines need it
-- too — a machine IS the capitalised asset — so widen it to unscoped rather
-- than create a second definition under a different name, which is the mistake
-- Phase 2 made with Grade.
UPDATE fab_field_defs SET category_id = NULL
 WHERE deleted_at IS NULL AND field_key = 'cost_treatment' AND category_id IS NOT NULL;

-- ── Piece-level reservations (2026-08-16, catalog unification Phase 6b) ─────
--
-- A reservation could only ever say "this order has claimed 3 of item X". Once
-- consumption matches on the plate size a nest declared, that is no longer
-- enough: two orders can both hold "3 of MS Plate 20mm" while only one
-- 3000x1500 piece exists, and both believe they have it. The first to start
-- takes it and the second discovers the problem at a machine.
--
-- `stock_piece_id` NULL keeps the old meaning — a quantity of an item, not a
-- named plate — so every existing reservation and every unmeasured yard behaves
-- exactly as before. It is only set when the requirement carries a size AND
-- measured stock exists to match it against, which is the same condition that
-- makes consumption size-aware in the first place.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_reservations'
               AND COLUMN_NAME='stock_piece_id');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_stock_reservations ADD COLUMN stock_piece_id INT NULL AFTER catalog_item_id',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- `notes` is in this table's CREATE but missing from any database created before
-- it was added — `CREATE TABLE IF NOT EXISTS` asserts a name exists, never that
-- it has the right shape, so the column never arrived. Local had no `notes`
-- while production did, which is drift between two environments running the
-- same file. Guarded ALTER converges them.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_reservations'
               AND COLUMN_NAME='notes');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_stock_reservations ADD COLUMN notes TEXT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_reservations'
               AND INDEX_NAME='idx_fsr_piece');
SET @sql = IF(@idx=0,
  'ALTER TABLE fab_stock_reservations ADD KEY idx_fsr_piece (company_id, stock_piece_id, status)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ══ CATALOG UNIFICATION, PHASE 8 (2026-08-17) ══════════════════════════════
-- A machine type becomes a catalog item; a machine becomes a stock piece.
--
-- That is what makes "where is this machine" an ordinary stock question with an
-- ordinary answer, and moving one out of the factory an ordinary stock transfer
-- with a history — rather than a fact nobody records anywhere.
--
-- SAFE ONLY BECAUSE PHASE 6 LANDED FIRST. Once a machine is a stock piece, the
-- FIFO consumption that used to pick any in-stock piece of a catalog item could
-- have picked a CNC table and consumed it into a girder. Phase 4 marked the
-- Machines category `consumable = no` and Phase 6 enforces it before any size
-- check runs, so that path is closed before this opens it.

-- ── Where machines live ───────────────────────────────────────────────────
--
-- A stock piece must have a location, and a machine's WIP area is the wrong one
-- — that holds material flowing THROUGH the machine, not the machine.
--
-- Two per plant, because "off site" has to be somewhere: a stock location is
-- scoped to a plant, so off-site means "away from this plant" rather than a
-- nowhere that no row can express. Machines in it STAY SCHEDULABLE, per the
-- decision on 2026-08-16 — off-site work is real work, and this records where a
-- machine is, not whether it may be used.
INSERT INTO fab_stock_locations (company_id, plant_id, name, code, description)
SELECT p.company_id, p.id, 'Machines - on site', 'MACH-ON',
       'Where machines physically stand at this plant. Auto-provisioned.'
  FROM fab_plants p
 WHERE p.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM fab_stock_locations l
                    WHERE l.company_id = p.company_id AND l.plant_id = p.id
                      AND l.code = 'MACH-ON' AND l.deleted_at IS NULL);

INSERT INTO fab_stock_locations (company_id, plant_id, name, code, description)
SELECT p.company_id, p.id, 'Machines - off site', 'MACH-OFF',
       'Machines away from this plant: hired out, at a job site, or away for repair.'
  FROM fab_plants p
 WHERE p.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM fab_stock_locations l
                    WHERE l.company_id = p.company_id AND l.plant_id = p.id
                      AND l.code = 'MACH-OFF' AND l.deleted_at IS NULL);

-- ── The two links ─────────────────────────────────────────────────────────
--
-- A resource TYPE points at the catalog item that describes that model; a
-- RESOURCE points at the stock piece that is that physical machine.
--
-- Nullable, and the system works without them. A resource remains what the
-- scheduler reads — its capacity columns are untouched (decision D8) — and this
-- adds an identity beside that, rather than moving it.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resource_types'
               AND COLUMN_NAME='catalog_item_id');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_resource_types ADD COLUMN catalog_item_id INT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resources'
               AND COLUMN_NAME='stock_piece_id');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_resources ADD COLUMN stock_piece_id INT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── Backfill: a catalog item per machine type ─────────────────────────────
--
-- Code prefixed `MACH-` so a machine type can never collide with a material
-- code, and so it reads as what it is in any list it appears in.
INSERT INTO fab_item_catalog (company_id, code, name, category_id, procurement_type, unit)
SELECT rt.company_id, CONCAT('MACH-', rt.code), rt.name, cat.id, 'buy', 'nos'
  FROM fab_resource_types rt
  JOIN fab_item_categories cat
    ON cat.company_id = rt.company_id AND cat.code = 'mach' AND cat.deleted_at IS NULL
 WHERE rt.deleted_at IS NULL AND rt.catalog_item_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM fab_item_catalog i
                    WHERE i.company_id = rt.company_id
                      AND i.code = CONCAT('MACH-', rt.code) AND i.deleted_at IS NULL);

UPDATE fab_resource_types rt
  JOIN fab_item_catalog i
    ON i.company_id = rt.company_id AND i.code = CONCAT('MACH-', rt.code)
   AND i.deleted_at IS NULL
   SET rt.catalog_item_id = i.id
 WHERE rt.deleted_at IS NULL AND rt.catalog_item_id IS NULL;

-- ── Backfill: a stock piece per machine ───────────────────────────────────
--
-- ALWAYS QUANTITY 1. A machine is a serialised thing, not a quantity: "3 of CNC
-- table" would be three machines the leveller cannot tell apart and cannot
-- schedule separately, and a partial consume would leave two-thirds of a table.
--
-- Placed in the plant's on-site machine area. A machine whose resource carries
-- no plant is SKIPPED rather than guessed at — a stock piece must have a
-- location, and inventing one would put the machine somewhere it is not.
INSERT INTO fab_stock_pieces
  (company_id, catalog_item_id, plant_id, stock_location_id, qty, uom, status,
   serial_no, received_date, notes)
SELECT r.company_id, rt.catalog_item_id, r.plant_id, loc.id, 1, 'nos', 'in_stock',
       r.code, COALESCE(r.purchase_date, DATE(r.created_at)),
       CONCAT('Machine ', r.name, ' (resource #', r.id, ')')
  FROM fab_resources r
  JOIN fab_resource_types rt
    ON rt.id = r.resource_type_id AND rt.deleted_at IS NULL AND rt.catalog_item_id IS NOT NULL
  JOIN fab_stock_locations loc
    ON loc.company_id = r.company_id AND loc.plant_id = r.plant_id
   AND loc.code = 'MACH-ON' AND loc.deleted_at IS NULL
 WHERE r.deleted_at IS NULL AND r.stock_piece_id IS NULL AND r.plant_id IS NOT NULL;

UPDATE fab_resources r
  JOIN fab_stock_pieces p
    ON p.company_id = r.company_id AND p.serial_no = r.code
   AND p.deleted_at IS NULL AND p.status IN ('in_stock', 'wip')
  JOIN fab_resource_types rt
    ON rt.id = r.resource_type_id AND rt.catalog_item_id = p.catalog_item_id
   SET r.stock_piece_id = p.id
 WHERE r.deleted_at IS NULL AND r.stock_piece_id IS NULL;

-- Repair any machine-area name already stored as mojibake.
--
-- The first version of the seed above used an em-dash. The mysql client reading
-- this file does not always negotiate utf8mb4 — the documented push-to-prod
-- command does not pass --default-character-set — so those bytes were read as
-- latin1 and re-encoded, storing "Machines ÔÇö on site" instead of the dash.
--
-- The lesson is the rule now followed throughout this file: SEEDED DATA IS
-- ASCII ONLY. Comments can say what they like, because comments are not stored;
-- a value is at the mercy of whatever charset the client happened to use.
UPDATE fab_stock_locations
   SET name = 'Machines - on site'
 WHERE code = 'MACH-ON' AND deleted_at IS NULL AND name <> 'Machines - on site';

UPDATE fab_stock_locations
   SET name = 'Machines - off site'
 WHERE code = 'MACH-OFF' AND deleted_at IS NULL AND name <> 'Machines - off site';

-- ── Units-of-production depreciation inputs (2026-08-17, Phase 9) ──────────
--
-- The method that depreciates by USE rather than by time: a press worked twice
-- as hard wears out twice as fast, and for equipment whose life really is
-- measured in cycles or hours that is the truthful answer.
--
-- BOTH ARE RECORDED, NOT DERIVED, even though this system tracks actual machine
-- running time. `machineAnalyticsService` computes `touchMinutes` per run, but
-- it carries a `touchBasis` that falls back to 'elapsed' whenever shift or event
-- data is missing — so a book value derived from it would move as the event log
-- filled in, and the same report run twice would give two answers. Depreciation
-- has to be reproducible. Somebody enters the reading, as they would off an
-- hour meter.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_resources'
               AND COLUMN_NAME='useful_life_units');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_resources
     ADD COLUMN useful_life_units DECIMAL(18,4) NULL,
     ADD COLUMN units_used        DECIMAL(18,4) NULL,
     ADD COLUMN units_uom         VARCHAR(20)   NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ══ CATALOG UNIFICATION, PHASE 10 (2026-08-17) ═════════════════════════════
-- The machine<->stock-area coupling, driven by the standard structure instead
-- of a hardcoded two-sided model.
--
-- WHAT WAS WRONG WITH IT. `fab_buffers` keys on (resource_id, kind) where kind
-- is 'input' or 'output', and resolves a buffer to a location by falling back
-- to the naming convention `WIP-M<resource id>` — the SAME location for both
-- sides. So a machine's input buffer and its output buffer measure one pile,
-- and `isOutputBlocked`'s test that both sides are simultaneously full compares
-- a number with itself. The two-sided model was never real in the data.
--
-- It also cannot express two things a shop actually has: a staging bay shared
-- by three machines, and a machine with more than two areas.
--
-- NOT TOUCHED: `fab_cc_buffers`. Those are the critical chain's TIME buffers —
-- a completely different concept that happens to share the word. 270 of them
-- exist in production and none of this goes near them.

-- ── Capacity belongs to the AREA ──────────────────────────────────────────
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_locations'
               AND COLUMN_NAME='capacity_value');
SET @sql = IF(@col=0,
  'ALTER TABLE fab_stock_locations
     ADD COLUMN capacity_value    DECIMAL(18,4) NULL,
     ADD COLUMN capacity_uom      VARCHAR(20)   NULL,
     ADD COLUMN warn_pct          INT           NULL,
     ADD COLUMN block_pct         INT           NULL,
     ADD COLUMN weight_metric_key VARCHAR(100)  NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── A machine's areas, with roles ─────────────────────────────────────────
--
-- Many-to-many on purpose: one machine may have several areas, and one area may
-- serve several machines. Neither is expressible today, and both are ordinary.
CREATE TABLE IF NOT EXISTS fab_resource_stock_areas (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  company_id        INT NOT NULL,
  resource_id       INT NOT NULL,
  stock_location_id INT NOT NULL,
  -- 'input' | 'output' | 'wip'. Free text rather than an enum so a shop can add
  -- a role without a migration, which is the whole point of moving off the
  -- hardcoded two-sided model.
  role              VARCHAR(20) NOT NULL DEFAULT 'wip',
  active            TINYINT(1)  NOT NULL DEFAULT 1,
  notes             TEXT NULL,
  deleted_at        DATETIME NULL,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_frsa_resource (company_id, resource_id, role),
  KEY idx_frsa_location (company_id, stock_location_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Migrate the existing buffers ──────────────────────────────────────────
--
-- Each buffer's capacity moves onto the location it ALREADY resolves to, and a
-- role link is created. Behaviour is preserved exactly, including the quirk
-- that both sides currently point at one area: making them distinct areas is an
-- operational decision about the shop floor, not something a migration should
-- decide on somebody's behalf.
UPDATE fab_stock_locations l
  JOIN (
    SELECT COALESCE(b.stock_location_id,
                    (SELECT x.id FROM fab_stock_locations x
                      WHERE x.company_id = b.company_id
                        AND x.code = CONCAT('WIP-M', b.resource_id)
                        AND x.deleted_at IS NULL LIMIT 1)) AS loc_id,
           MAX(b.capacity_value) AS capacity_value,
           MAX(b.capacity_uom)   AS capacity_uom,
           MAX(b.warn_pct)       AS warn_pct,
           MAX(b.block_pct)      AS block_pct,
           MAX(b.weight_metric_key) AS weight_metric_key
      FROM fab_buffers b
     WHERE b.deleted_at IS NULL AND b.active = 1
     GROUP BY loc_id
  ) src ON src.loc_id = l.id
   SET l.capacity_value = COALESCE(l.capacity_value, src.capacity_value),
       l.capacity_uom = COALESCE(l.capacity_uom, src.capacity_uom),
       l.warn_pct = COALESCE(l.warn_pct, src.warn_pct),
       l.block_pct = COALESCE(l.block_pct, src.block_pct),
       l.weight_metric_key = COALESCE(l.weight_metric_key, src.weight_metric_key)
 WHERE l.deleted_at IS NULL;

INSERT INTO fab_resource_stock_areas
  (company_id, resource_id, stock_location_id, role, active, notes)
SELECT b.company_id, b.resource_id,
       COALESCE(b.stock_location_id,
                (SELECT x.id FROM fab_stock_locations x
                  WHERE x.company_id = b.company_id
                    AND x.code = CONCAT('WIP-M', b.resource_id)
                    AND x.deleted_at IS NULL LIMIT 1)),
       b.kind, b.active,
       'Migrated from fab_buffers 2026-08-17'
  FROM fab_buffers b
 WHERE b.deleted_at IS NULL AND b.active = 1
   AND COALESCE(b.stock_location_id,
                (SELECT x.id FROM fab_stock_locations x
                  WHERE x.company_id = b.company_id
                    AND x.code = CONCAT('WIP-M', b.resource_id)
                    AND x.deleted_at IS NULL LIMIT 1)) IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM fab_resource_stock_areas a
                    WHERE a.company_id = b.company_id AND a.resource_id = b.resource_id
                      AND a.role = b.kind AND a.deleted_at IS NULL);

-- Every machine that has a WIP area but no buffer gets a plain 'wip' link, so
-- the new structure describes the whole shop rather than only the three
-- machines somebody happened to configure buffers for.
INSERT INTO fab_resource_stock_areas
  (company_id, resource_id, stock_location_id, role, active, notes)
SELECT r.company_id, r.id, r.stock_location_id, 'wip', 1,
       'Backfilled from fab_resources.stock_location_id 2026-08-17'
  FROM fab_resources r
 WHERE r.deleted_at IS NULL AND r.stock_location_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM fab_resource_stock_areas a
                    WHERE a.company_id = r.company_id AND a.resource_id = r.id
                      AND a.stock_location_id = r.stock_location_id
                      AND a.deleted_at IS NULL);

-- ── Provision the areas that active buffers point at but never had ─────────
--
-- Found by verify-buffer-migration.mjs on production: of six active buffers,
-- four resolved to NO location at all. `bufferLocationId` falls back to a
-- location named `WIP-M<resource id>`, and that location had only ever been
-- created for machines that had actually run work through them
-- (`ensureMachineWipLocation` provisions on first use). So somebody configured
-- a 5000 kg limit on three machines and it has been inert on two of them ever
-- since — measured against nothing, never able to warn or block.
--
-- Migrating only the buffers that happen to resolve would carry that silence
-- into the new structure and make it permanent. Provisioning the area instead
-- makes the configuration mean what it says.
--
-- THIS IS A BEHAVIOUR CHANGE, and a deliberate one: those buffers become live.
-- Safe to do now specifically because there are zero WIP pieces anywhere, so
-- every newly-live area starts empty at 0% and nothing can begin blocked.
INSERT INTO fab_stock_locations (company_id, plant_id, name, code, description)
SELECT DISTINCT r.company_id, r.plant_id,
       CONCAT(COALESCE(r.name, CONCAT('Machine #', r.id)), ' WIP'),
       CONCAT('WIP-M', r.id),
       'Auto-provisioned for a buffer that had no area (catalog unification Phase 10)'
  FROM fab_buffers b
  JOIN fab_resources r ON r.id = b.resource_id AND r.deleted_at IS NULL
 WHERE b.deleted_at IS NULL AND b.active = 1 AND b.stock_location_id IS NULL
   AND r.plant_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM fab_stock_locations x
                    WHERE x.company_id = r.company_id
                      AND x.code = CONCAT('WIP-M', r.id) AND x.deleted_at IS NULL);
-- rerun the capacity + link migration now those areas exist
--
-- Repeated deliberately. init.sql runs top to bottom, and the provisioning
-- above happens AFTER the migration below ran and skipped those machines — so
-- on a single pass their links would still be missing, and would only appear
-- the next time anybody happened to run the file. Both statements are
-- NOT EXISTS / COALESCE guarded, so running them a second time is a no-op for
-- everything already migrated.
UPDATE fab_stock_locations l
  JOIN (
    SELECT COALESCE(b.stock_location_id,
                    (SELECT x.id FROM fab_stock_locations x
                      WHERE x.company_id = b.company_id
                        AND x.code = CONCAT('WIP-M', b.resource_id)
                        AND x.deleted_at IS NULL LIMIT 1)) AS loc_id,
           MAX(b.capacity_value) AS capacity_value,
           MAX(b.capacity_uom)   AS capacity_uom,
           MAX(b.warn_pct)       AS warn_pct,
           MAX(b.block_pct)      AS block_pct,
           MAX(b.weight_metric_key) AS weight_metric_key
      FROM fab_buffers b
     WHERE b.deleted_at IS NULL AND b.active = 1
     GROUP BY loc_id
  ) src ON src.loc_id = l.id
   SET l.capacity_value = COALESCE(l.capacity_value, src.capacity_value),
       l.capacity_uom = COALESCE(l.capacity_uom, src.capacity_uom),
       l.warn_pct = COALESCE(l.warn_pct, src.warn_pct),
       l.block_pct = COALESCE(l.block_pct, src.block_pct),
       l.weight_metric_key = COALESCE(l.weight_metric_key, src.weight_metric_key)
 WHERE l.deleted_at IS NULL;

INSERT INTO fab_resource_stock_areas
  (company_id, resource_id, stock_location_id, role, active, notes)
SELECT b.company_id, b.resource_id,
       COALESCE(b.stock_location_id,
                (SELECT x.id FROM fab_stock_locations x
                  WHERE x.company_id = b.company_id
                    AND x.code = CONCAT('WIP-M', b.resource_id)
                    AND x.deleted_at IS NULL LIMIT 1)),
       b.kind, b.active,
       'Migrated from fab_buffers 2026-08-17'
  FROM fab_buffers b
 WHERE b.deleted_at IS NULL AND b.active = 1
   AND COALESCE(b.stock_location_id,
                (SELECT x.id FROM fab_stock_locations x
                  WHERE x.company_id = b.company_id
                    AND x.code = CONCAT('WIP-M', b.resource_id)
                    AND x.deleted_at IS NULL LIMIT 1)) IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM fab_resource_stock_areas a
                    WHERE a.company_id = b.company_id AND a.resource_id = b.resource_id
                      AND a.role = b.kind AND a.deleted_at IS NULL);

-- ══ CATALOG UNIFICATION, PHASE 7 (2026-08-17) ══════════════════════════════
-- Named pick lists, defined by rules over the taxonomy.
--
-- The material picker's rule was a SUBTRACTION: everything bought, minus
-- consumables and fasteners. Subtraction means every category added later is
-- included by default until somebody remembers to exclude it — which is how
-- paint and welding flux ended up offered as things to cut a flange from.
--
-- A scope is an INCLUSION. An item qualifies if it matches any include rule and
-- no exclude rule; within one rule the fields are ANDed. That gives
-- "raw materials", "raw materials AND group metals", "raw materials OR
-- semi-finished" and "everything bought except consumables" in one shape.
CREATE TABLE IF NOT EXISTS fab_item_scopes (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  company_id  INT NOT NULL,
  scope_key   VARCHAR(60)  NOT NULL,
  label       VARCHAR(160) NOT NULL,
  notes       TEXT NULL,
  active      TINYINT(1) NOT NULL DEFAULT 1,
  deleted_at  DATETIME NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fis_company_key (company_id, scope_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS fab_item_scope_rules (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  company_id       INT NOT NULL,
  scope_id         INT NOT NULL,
  -- 'include' | 'exclude'. Excludes always win.
  rule_type        VARCHAR(10) NOT NULL DEFAULT 'include',
  -- Every field NULL means "any". Non-null fields are ANDed within the rule.
  category_id      INT NULL,
  group_id         INT NULL,
  subgroup_id      INT NULL,
  procurement_type VARCHAR(10) NULL,
  material_form    VARCHAR(20) NULL,
  notes            TEXT NULL,
  deleted_at       DATETIME NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fisr_scope (company_id, scope_id, rule_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Where a scope applies ─────────────────────────────────────────────────
--
-- The two-tier resolution asked for on 2026-08-16: the ORDER LINE's type wins,
-- the STRUCTURE LEVEL is the fallback, and a binding with neither is the global
-- default for that purpose.
--
-- The chain MUST NOT be able to resolve to nothing. An empty picker looks
-- exactly like "we have no stock" and gets filed as a data problem, so a
-- missing binding falls through to the global default rather than to silence.
CREATE TABLE IF NOT EXISTS fab_item_scope_bindings (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  company_id  INT NOT NULL,
  scope_id    INT NOT NULL,
  -- What is being picked: 'bom_material' | 'spares' | 'machines'.
  purpose     VARCHAR(40) NOT NULL,
  -- NULL = applies to any. Both NULL = the global default for this purpose.
  line_type   VARCHAR(40) NULL,
  level_kind  VARCHAR(20) NULL,
  active      TINYINT(1) NOT NULL DEFAULT 1,
  deleted_at  DATETIME NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fisb (company_id, purpose, line_type, level_kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Seed the three standard scopes ────────────────────────────────────────
INSERT INTO fab_item_scopes (company_id, scope_key, label, notes)
SELECT co.id, s.k, s.l, s.n
  FROM companies co
  JOIN (SELECT 'bom_material' AS k, 'What a part is cut from' AS l,
               'Raw materials. Narrow it to a group (Metals) or a subgroup (Plate) by adding fields to the include rule.' AS n
        UNION ALL SELECT 'spares', 'Spare parts', 'MRO and spares, for machine purchase orders.'
        UNION ALL SELECT 'machines', 'Machines', 'Machine types, for buying new plant.') s
 WHERE NOT EXISTS (SELECT 1 FROM fab_item_scopes x
                    WHERE x.company_id = co.id AND x.scope_key = s.k AND x.deleted_at IS NULL);

-- bom_material: INCLUDE raw materials. This is the change from the old
-- subtraction rule, and it is what was asked for on 2026-08-16 — "filter for
-- category raw materials instead of all buy".
INSERT INTO fab_item_scope_rules (company_id, scope_id, rule_type, category_id, notes)
SELECT sc.company_id, sc.id, 'include', cat.id, 'Raw materials'
  FROM fab_item_scopes sc
  JOIN fab_item_categories cat ON cat.company_id = sc.company_id AND cat.code = 'rm' AND cat.deleted_at IS NULL
 WHERE sc.scope_key = 'bom_material' AND sc.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM fab_item_scope_rules r
                    WHERE r.scope_id = sc.id AND r.deleted_at IS NULL);

INSERT INTO fab_item_scope_rules (company_id, scope_id, rule_type, category_id, notes)
SELECT sc.company_id, sc.id, 'include', cat.id, 'MRO and spares'
  FROM fab_item_scopes sc
  JOIN fab_item_categories cat ON cat.company_id = sc.company_id AND cat.code = 'mro' AND cat.deleted_at IS NULL
 WHERE sc.scope_key = 'spares' AND sc.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM fab_item_scope_rules r
                    WHERE r.scope_id = sc.id AND r.deleted_at IS NULL);

INSERT INTO fab_item_scope_rules (company_id, scope_id, rule_type, category_id, notes)
SELECT sc.company_id, sc.id, 'include', cat.id, 'Machine types'
  FROM fab_item_scopes sc
  JOIN fab_item_categories cat ON cat.company_id = sc.company_id AND cat.code = 'mach' AND cat.deleted_at IS NULL
 WHERE sc.scope_key = 'machines' AND sc.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM fab_item_scope_rules r
                    WHERE r.scope_id = sc.id AND r.deleted_at IS NULL);

-- Global default bindings: no line_type, no level_kind.
INSERT INTO fab_item_scope_bindings (company_id, scope_id, purpose, line_type, level_kind)
SELECT sc.company_id, sc.id, sc.scope_key, NULL, NULL
  FROM fab_item_scopes sc
 WHERE sc.deleted_at IS NULL AND sc.scope_key IN ('bom_material', 'spares', 'machines')
   AND NOT EXISTS (SELECT 1 FROM fab_item_scope_bindings b
                    WHERE b.company_id = sc.company_id AND b.purpose = sc.scope_key
                      AND b.line_type IS NULL AND b.level_kind IS NULL AND b.deleted_at IS NULL);

-- ══ CATALOG UNIFICATION, PHASE 11 (2026-08-17) ═════════════════════════════
-- The destructive phase, run only against what the gate says is safe.
--
-- `scripts/verify-legacy-divergence.mjs` reports, per legacy source, whether it
-- still agrees with its replacement AND whether any code still reads it. On
-- production it marks exactly ONE source droppable:
--
--   fab_items.length/width/height  BLOCKED — 5 rows already disagree with the
--                                  registry, and five services still read them
--   fab_item_metric_values         BLOCKED — itemWeightService still WRITES it
--   fab_buffers                    BLOCKED — bufferService falls back to it
--   fab_field_defs.piece_varying   BLOCKED — authoredOnPiece falls back to it
--   fab_item_metric_defs           DROPPABLE — no readers, no divergence
--
-- So only the last one goes. Everything else keeps its dual-read until its
-- precondition is done; the report says what each one needs.
--
-- Verified before dropping: all eight metric keys (thickness_mm, length_mm,
-- width_mm, unit_weight_kg, num_holes, edge_length_m, weld_length_m,
-- surface_area_m2) exist in fab_field_defs, so nothing here is the only copy.
-- Its resourceDef entry was removed first, so the generic API can no longer
-- reach it.
--
-- NOT dropped: fab_item_metric_VALUES. Same era, similar name, entirely
-- different situation — it is still written on every weight roll-up.
SET @tbl = (SELECT COUNT(*) FROM information_schema.TABLES
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_item_metric_defs');
SET @sql = IF(@tbl=1, 'DROP TABLE fab_item_metric_defs', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ══ STOCK LEDGER: CODED MOVEMENTS (2026-08-17) ═════════════════════════════
--
-- Asked for: "let's maintain ledger entry whenever something moves — from one
-- stock area to another, either through an operation like a crane operation or
-- just a machine being carried from one place to another."
--
-- What was actually there:
--   grn_receipt 113 · wip_issue 5 · wip_open 4      and NOTHING else
--
-- So nothing recorded a MOVE. `machineLocationService` did write a transfer
-- pair, but it wrote `batch_code = 'MACHINE'` and no piece reference, so the
-- ledger said a machine TYPE moved, not which machine — and no transfer row had
-- ever been written in production anyway.
--
-- Three gaps, fixed here and in stockMovementService.js:
--
--   1. no piece identity on a ledger row  -> piece_id + piece_code
--   2. no way to pair the two halves of a move -> move_ref
--   3. non-catalog stock could not BE a piece -> catalog_item_id nullable
--
-- WHY A PAIR AND NOT from/to COLUMNS. `fab_stock_ledger` has one
-- `stock_location_id`, and every existing row means "this much, in this place".
-- A move is therefore two rows: -qty leaving and +qty arriving, which keeps a
-- balance-per-location query a plain SUM with no special case for transfers.
-- `move_ref` is what makes the two halves recoverable as one event; without it
-- you can see stock left and stock arrived but cannot prove they were the same
-- movement.
--
-- WHY piece_code IS DENORMALISED. It is a snapshot, deliberately. A ledger is
-- an audit trail, and it has to keep reading correctly after a piece is
-- consumed, renumbered or deleted. Joining to fab_stock_pieces for the code
-- would make history change when the present does.
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_ledger' AND COLUMN_NAME='piece_code');
SET @s = IF(@c=0, 'ALTER TABLE fab_stock_ledger
     ADD COLUMN piece_code VARCHAR(40) NULL,
     ADD COLUMN move_ref   VARCHAR(48) NULL,
     ADD COLUMN from_location_id INT NULL,
     ADD COLUMN to_location_id   INT NULL', 'SELECT 1');
PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;

SET @i = (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_ledger' AND INDEX_NAME='idx_fsl_move');
SET @s = IF(@i=0, 'CREATE INDEX idx_fsl_move ON fab_stock_ledger (company_id, move_ref)', 'SELECT 1');
PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;

SET @i = (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_ledger' AND INDEX_NAME='idx_fsl_piece');
SET @s = IF(@i=0, 'CREATE INDEX idx_fsl_piece ON fab_stock_ledger (company_id, piece_id)', 'SELECT 1');
PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;

-- A stock piece may now exist WITHOUT a catalog item.
--
-- This is a widening (NOT NULL -> NULL), so no existing row is affected and no
-- read breaks. It is required because a made part carries `catalog_item_id =
-- NULL` on fab_items — a catalogue-rooted identity cannot describe something
-- this shop invented for one order — and until now that made it impossible for
-- work in progress to be a stock piece at all. Which is why production held 173
-- pieces, every one of them catalog-backed, while WIP existed only as ledger
-- rows with no piece behind them.
--
-- `wip_item_id` is the identity in that case, and the piece still gets a code,
-- so a ledger row about a made part reads the same as one about a plate.
SET @n = (SELECT IS_NULLABLE FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_stock_pieces' AND COLUMN_NAME='catalog_item_id');
SET @s = IF(@n='NO', 'ALTER TABLE fab_stock_pieces MODIFY COLUMN catalog_item_id INT NULL', 'SELECT 1');
PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;

-- ══ SIMILAR GIRDERS AND SEGMENTS (2026-08-18) ══════════════════════════════
--
-- Asked for: "we should give a very simple UI to mark girders or segments
-- similar. That way entering values throughout would reduce by a lot,
-- especially during flow and value entry phase" — and, on scope, "we can mark
-- either G1 same as G2 or G11 same as G12, basically girders or segments".
--
-- A six-girder span produced 210 parts, and typing a Top Flange's thickness
-- thirty times is not thirty decisions — it is one decision typed thirty times.
--
-- HOW A GROUP IS EXPRESSED. `similar_group` is stamped on the GIRDER or SEGMENT
-- rows that are copies of each other, never on the parts. The parts follow,
-- because a part's correspondence to its opposite number is already carried by
-- its code: strip the group root's code from `VSHW-…-SPANA-G1-1-TF` and `-1-TF`
-- is what makes it the same part as G2's. That is the same "codes ARE the
-- structure" rule the BOQ sheet is built on, so no second notion of identity is
-- introduced and nothing has to be kept in sync.
--
-- It is a free-text key rather than a foreign key to a groups table because a
-- group has no properties of its own — it is only ever "these rows are the
-- same as each other". A table would add a join and an orphan-cleanup problem
-- to store nothing.
--
-- NOT A CONSTRAINT. Marking two girders similar does not stop them diverging:
-- it means a value entered against one is written to all of them. If someone
-- later gives one girder a different plate thickness, that is a real answer to
-- a real question and the data says so. The grouping saves typing; it does not
-- claim the parts are interchangeable forever.
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='similar_group');
SET @s = IF(@c=0, 'ALTER TABLE fab_items ADD COLUMN similar_group VARCHAR(40) NULL', 'SELECT 1');
PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;

SET @i = (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND INDEX_NAME='idx_fi_similar');
SET @s = IF(@i=0, 'CREATE INDEX idx_fi_similar ON fab_items (company_id, order_id, similar_group)', 'SELECT 1');
PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;

-- ══ RESOURCES: NO MACHINE SHIFTS, ALWAYS A LOCATION (2026-08-18) ═══════════
--
-- Asked for: "remove shifts for resources, we will give shifts for people and
-- track the resource availability based on that. Machine can technically run 24
-- hours so we shouldn't give shifts for it" — and "stock location of a resource
-- should never be null".
--
-- 1. CLEAR EVERY MACHINE'S OWN CALENDAR.
--
-- The field is gone from the UI, but all 18 production machines already had one
-- set, so removing the control alone would have frozen them on machine-specific
-- calendars forever with no way to change them — the worst of both.
--
-- Nothing breaks, because the resolution chain already widens: taskWaitService,
-- gapService and resourceLevelingService all read the machine's own calendar
-- FIRST and fall back to any calendar on its plant, then the company's. Clearing
-- the column moves every machine onto its plant's calendar, which is exactly
-- "the machine has no shift of its own". The column stays — the chain still
-- reads it, and a company that genuinely does run one machine on a different
-- pattern can still set it as data.
UPDATE fab_resources SET shift_calendar_id = NULL
 WHERE deleted_at IS NULL AND shift_calendar_id IS NOT NULL;

-- 2. GIVE EVERY MACHINE A STOCK LOCATION, FROM THE PIECE THAT IS THAT MACHINE.
--
-- 16 of 18 resources had no `stock_location_id` while their stock piece did:
-- the Phase 8 backfill created each machine's piece in the plant's on-site
-- machine area but never wrote the location back to the resource row. So the
-- machine knew where it was and the resource did not.
--
-- Derived rather than typed, because the piece is already the authority on where
-- a physical thing is — that is the whole point of a machine being a stock
-- piece. Making the field required in the UI without this would have meant 16
-- machines that could not be saved without someone re-entering a location the
-- system already knew.
UPDATE fab_resources r
  JOIN fab_stock_pieces p
    ON p.id = r.stock_piece_id AND p.deleted_at IS NULL AND p.stock_location_id IS NOT NULL
   SET r.stock_location_id = p.stock_location_id,
       r.plant_id = COALESCE(r.plant_id, p.plant_id)
 WHERE r.deleted_at IS NULL AND r.stock_location_id IS NULL;

-- 3. ASSET TAG RETIRED.
--
-- A second internal identifier for a thing `code` already names, with no rule
-- about which wins. Production had zero of them. The column is left in place
-- rather than dropped: it is out of the UI, and dropping a column is the kind
-- of thing verify-legacy-divergence.mjs exists to gate.

-- ══ DRAWINGS (2026-08-18) ══════════════════════════════════════════════════
--
-- Asked for: upload drawing PDFs in the structure wizard, "which can be
-- referenced by the org later while working on a task", and "a way to access
-- current item and all of its above steps' diagrams on every operation".
--
-- THE SECOND HALF IS THE POINT. A drawing is attached to ONE item, but the
-- person cutting a web plate needs the plate's drawing AND the segment's AND
-- the girder's — the assembly context is what tells them which way round it
-- goes. So a task shows its item's own drawings plus every ancestor's, and
-- nobody has to attach the same general arrangement to two hundred parts.
--
-- BYTES IN THE DATABASE, FOR NOW. The backend runs on Render's free plan with
-- no persistent disk (render.yaml has no disk section), so anything written to
-- local storage is lost on every deploy and every spin-down — drawings that
-- silently vanish are worse than no drawings, because people come to rely on
-- them. Decided 2026-08-18: compress and store in TiDB until S3 is connected.
--
-- `content` is therefore a LONGBLOB holding the DEFLATE-compressed PDF, and
-- `storage` records which it is. When S3 arrives, new rows carry
-- storage='s3' + `uri` and leave `content` null; nothing has to migrate, and
-- both kinds read through the same endpoint.
--
-- TiDB's txn-entry-size-limit caps a single row at about 6 MB, so the service
-- enforces a ceiling well under that and rejects a too-large file with a clear
-- message rather than failing on commit with an opaque one.
CREATE TABLE IF NOT EXISTS fab_item_drawings (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  company_id      INT NOT NULL,
  item_id         INT NOT NULL,
  file_name       VARCHAR(255) NOT NULL,
  mime_type       VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
  -- Bytes as uploaded, before compression — what the user recognises.
  size_bytes      INT NOT NULL,
  -- 'db' = deflate-compressed bytes in `content`; 's3' = fetch from `uri`.
  storage         VARCHAR(16) NOT NULL DEFAULT 'db',
  compression     VARCHAR(16) NULL DEFAULT 'deflate',
  content         LONGBLOB NULL,
  uri             VARCHAR(1024) NULL,
  revision        VARCHAR(40) NULL,
  notes           VARCHAR(500) NULL,
  uploaded_by     INT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at      TIMESTAMP NULL,
  KEY idx_fid_item (company_id, item_id, deleted_at),
  CONSTRAINT fk_fid_item FOREIGN KEY (item_id) REFERENCES fab_items(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ══ FIELDS v2: ONE DEFINITION, ONE VALUE, ONE LADDER (2026-08-18) ══════════
--
-- See FAB_ERP_FIELDS_REDESIGN.md. These three tables replace fab_field_defs and
-- fab_custom_fields. Both old tables stay for now and are retired in step 8,
-- behind verify-legacy-divergence.mjs.
--
-- WHAT WAS WRONG, IN ONE PARAGRAPH. Two columns called `level` meant different
-- things. Values joined definitions BY STRING across two different collations,
-- which silently produced a duplicate `Grade` and blocked a migration. There
-- was no unique key, so a write could not be an upsert. Every value was TEXT,
-- so reads had to coerce, and to protect the formula engine the resolver simply
-- DROPPED every text field -- which is why heat_no and serial_no could never be
-- read through it. And the unit lived on the definition, so a value could never
-- say what it was measured in.

-- A unit is only useful if you can convert it. `factor_to_base` is what turns
-- "mm" from a label into arithmetic: today a formula reading `length_mm` is
-- trusting the NAME of the field, and nothing stops a value of 6 meaning metres.
CREATE TABLE IF NOT EXISTS fab_units (
  code            VARCHAR(20)    NOT NULL,
  dimension       VARCHAR(20)    NOT NULL,
  base_code       VARCHAR(20)    NOT NULL,
  factor_to_base  DECIMAL(24,12) NOT NULL DEFAULT 1,
  label           VARCHAR(60)    NOT NULL,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- fab_units seed data (2026-08-18)
-- Run: source this file with the mysql CLI after the fab_units DDL exists.
-- Safe to re-run: every row is an upsert on the code primary key.
--
-- WHY A FACTOR AT ALL. services/fieldVocabulary.js declares units but converts
-- nothing, so a length authored in metres against a formula that assumes
-- millimetres is wrong by 1000x and still looks plausible. One number per unit
-- closes that hole without a conversion library:
--     value_in_base = value * factor_to_base
-- and two values are only comparable when their rows share a base_code. A
-- caller that sees two different base_code values must refuse, not guess.
--
-- WHY SOME UNITS ARE THEIR OWN BASE. Money, the rate group and the electrical
-- group have no factor that is true at all times:
--   money       INR to USD needs an exchange rate that moves daily. Freezing
--               one into seed data would silently backdate every costing that
--               ever reads it, so no rate is stored here at all.
--   rates       mm/min and kg/min measure different things, and INR/kg carries
--               money inside it. Each is comparable only against itself.
--   electrical  kW to kVA needs the power factor of the real load, and A / V
--               are not power in the first place.
-- These still get a row, with factor_to_base = 1 and base_code = code, so that
-- "this unit does not convert" is an explicit answer from the table rather than
-- a missing row a caller has to interpret.
--
-- ASCII ONLY. The deploy pipes this file through the mysql client without
-- --default-character-set, so a non-ASCII byte lands in production as mojibake.
-- That is why area reads m2 and volume reads m3 rather than the squared and
-- cubed glyphs, here and in the comments.

-- ===== LENGTH (base: m) =====
-- Metre and not millimetre as the base: mm would turn every imperial factor
-- into a large number, and the shop floor quotes both systems.
INSERT INTO fab_units (code, dimension, base_code, factor_to_base, label) VALUES
  ('mm',   'length', 'm', 0.001000000000, 'Millimetre'),
  ('cm',   'length', 'm', 0.010000000000, 'Centimetre'),
  ('m',    'length', 'm', 1.000000000000, 'Metre'),
  ('inch', 'length', 'm', 0.025400000000, 'Inch'),
  ('ft',   'length', 'm', 0.304800000000, 'Foot')
ON DUPLICATE KEY UPDATE dimension=VALUES(dimension), base_code=VALUES(base_code), factor_to_base=VALUES(factor_to_base), label=VALUES(label);

-- ===== AREA (base: m2) =====
-- sqft is the square of the exact 0.3048 m foot, so 0.09290304 is exact rather
-- than a rounded figure.
INSERT INTO fab_units (code, dimension, base_code, factor_to_base, label) VALUES
  ('mm2',  'area', 'm2', 0.000001000000, 'Square millimetre'),
  ('cm2',  'area', 'm2', 0.000100000000, 'Square centimetre'),
  ('m2',   'area', 'm2', 1.000000000000, 'Square metre'),
  ('sqft', 'area', 'm2', 0.092903040000, 'Square foot')
ON DUPLICATE KEY UPDATE dimension=VALUES(dimension), base_code=VALUES(base_code), factor_to_base=VALUES(factor_to_base), label=VALUES(label);

-- ===== VOLUME (base: m3) =====
-- litre is volume and not a dimension of its own: 1 litre is exactly 1 dm3.
INSERT INTO fab_units (code, dimension, base_code, factor_to_base, label) VALUES
  ('mm3',   'volume', 'm3', 0.000000001000, 'Cubic millimetre'),
  ('cm3',   'volume', 'm3', 0.000001000000, 'Cubic centimetre'),
  ('m3',    'volume', 'm3', 1.000000000000, 'Cubic metre'),
  ('litre', 'volume', 'm3', 0.001000000000, 'Litre')
ON DUPLICATE KEY UPDATE dimension=VALUES(dimension), base_code=VALUES(base_code), factor_to_base=VALUES(factor_to_base), label=VALUES(label);

-- ===== MASS (base: kg) =====
-- tonne is the metric tonne of 1000 kg, the only tonne steel is quoted in here;
-- a short or long ton would be a different code. lb is the international
-- avoirdupois pound, which is exact by definition and not a measured value.
INSERT INTO fab_units (code, dimension, base_code, factor_to_base, label) VALUES
  ('g',     'mass', 'kg', 0.001000000000, 'Gram'),
  ('kg',    'mass', 'kg', 1.000000000000, 'Kilogram'),
  ('tonne', 'mass', 'kg', 1000.000000000000, 'Tonne (metric, 1000 kg)'),
  ('lb',    'mass', 'kg', 0.453592370000, 'Pound')
ON DUPLICATE KEY UPDATE dimension=VALUES(dimension), base_code=VALUES(base_code), factor_to_base=VALUES(factor_to_base), label=VALUES(label);

-- ===== TIME (base: sec) =====
-- Second and not hour, so every factor is a whole number and a cycle time in
-- seconds converts without a repeating decimal.
-- years is a NOMINAL 365 days. A Julian 365.25-day year would surprise anyone
-- reading a warranty or depreciation field, and leap-day exactness is not what
-- those fields are measuring.
INSERT INTO fab_units (code, dimension, base_code, factor_to_base, label) VALUES
  ('sec',   'time', 'sec', 1.000000000000, 'Second'),
  ('min',   'time', 'sec', 60.000000000000, 'Minute'),
  ('hrs',   'time', 'sec', 3600.000000000000, 'Hour'),
  ('days',  'time', 'sec', 86400.000000000000, 'Day'),
  ('years', 'time', 'sec', 31536000.000000000000, 'Year (nominal, 365 days)')
ON DUPLICATE KEY UPDATE dimension=VALUES(dimension), base_code=VALUES(base_code), factor_to_base=VALUES(factor_to_base), label=VALUES(label);

-- ===== COUNT (base: nos) =====
-- Dimensionless, so every factor is 1 and the base is only nominal.
-- Deliberately NOT pairs = 2 nos and NOT sets = n nos: a pair of bearings is one
-- issued line, and a set has no fixed member count, so multiplying either out
-- would inflate stock the moment somebody converted it.
INSERT INTO fab_units (code, dimension, base_code, factor_to_base, label) VALUES
  ('nos',   'count', 'nos', 1.000000000000, 'Numbers'),
  ('pcs',   'count', 'nos', 1.000000000000, 'Pieces'),
  ('sets',  'count', 'nos', 1.000000000000, 'Sets'),
  ('pairs', 'count', 'nos', 1.000000000000, 'Pairs')
ON DUPLICATE KEY UPDATE dimension=VALUES(dimension), base_code=VALUES(base_code), factor_to_base=VALUES(factor_to_base), label=VALUES(label);

-- ===== RATIO (base: ratio) =====
-- The one self-based group that DOES convert: percent is exactly 1/100 of a
-- bare ratio. Storing 0.01 here is what stops a 5 percent scrap allowance being
-- read as 5x by a formula that expects a fraction.
INSERT INTO fab_units (code, dimension, base_code, factor_to_base, label) VALUES
  ('%',     'ratio', 'ratio', 0.010000000000, 'Percent'),
  ('ratio', 'ratio', 'ratio', 1.000000000000, 'Ratio (fraction)')
ON DUPLICATE KEY UPDATE dimension=VALUES(dimension), base_code=VALUES(base_code), factor_to_base=VALUES(factor_to_base), label=VALUES(label);

-- ===== RATE (self-based, see header) =====
-- Each rate is its own base. Converting mm/min to m/min is arithmetically easy
-- but is NOT modelled here, because this table carries one factor per row and a
-- compound unit needs a factor per component. Until that exists, a rate is
-- comparable only against a rate with the same code.
INSERT INTO fab_units (code, dimension, base_code, factor_to_base, label) VALUES
  ('mm/min',  'rate', 'mm/min',  1.000000000000, 'Millimetres per minute'),
  ('m/min',   'rate', 'm/min',   1.000000000000, 'Metres per minute'),
  ('kg/min',  'rate', 'kg/min',  1.000000000000, 'Kilograms per minute'),
  ('kg/m3',   'rate', 'kg/m3',   1.000000000000, 'Kilograms per cubic metre'),
  ('nos/min', 'rate', 'nos/min', 1.000000000000, 'Numbers per minute'),
  ('INR/kg',  'rate', 'INR/kg',  1.000000000000, 'Rupees per kilogram')
ON DUPLICATE KEY UPDATE dimension=VALUES(dimension), base_code=VALUES(base_code), factor_to_base=VALUES(factor_to_base), label=VALUES(label);

-- ===== MONEY (self-based, see header) =====
-- No currency converts without an exchange rate, and an exchange rate is a
-- dated fact rather than seed data. Each currency is therefore its own base, so
-- a cross-currency comparison fails loudly instead of quietly applying a rate
-- that was true on the day this file was written.
INSERT INTO fab_units (code, dimension, base_code, factor_to_base, label) VALUES
  ('INR', 'money', 'INR', 1.000000000000, 'Indian Rupee'),
  ('USD', 'money', 'USD', 1.000000000000, 'US Dollar'),
  ('EUR', 'money', 'EUR', 1.000000000000, 'Euro')
ON DUPLICATE KEY UPDATE dimension=VALUES(dimension), base_code=VALUES(base_code), factor_to_base=VALUES(factor_to_base), label=VALUES(label);

-- ===== ELECTRICAL (self-based, see header) =====
-- Four different physical quantities that the picker groups together for the
-- user, not one dimension. kW is real power, kVA is apparent power, and the
-- ratio between them is the power factor of the load being measured rather than
-- a constant. A is current and V is voltage. Nothing here converts to anything
-- else here, which is why the group name is the dimension and the base is the
-- unit itself.
INSERT INTO fab_units (code, dimension, base_code, factor_to_base, label) VALUES
  ('kW',  'electrical', 'kW',  1.000000000000, 'Kilowatt (real power)'),
  ('kVA', 'electrical', 'kVA', 1.000000000000, 'Kilovolt-ampere (apparent power)'),
  ('A',   'electrical', 'A',   1.000000000000, 'Ampere'),
  ('V',   'electrical', 'V',   1.000000000000, 'Volt')
ON DUPLICATE KEY UPDATE dimension=VALUES(dimension), base_code=VALUES(base_code), factor_to_base=VALUES(factor_to_base), label=VALUES(label);

-- THE DEFINITION. One table owns `field_key`, under one collation, so the
-- duplicate-`Grade` failure cannot recur.
--
-- `applies_at` replaces the old `level` (item|piece|both) AND its gate. It names
-- the NARROWEST rung a value may be set on, and it may also be set at any
-- BROADER rung above that. So applies_at=catalog_item means the field does not
-- vary per instance: settable at category, group, subgroup or the item, and
-- rejected on an order_item or a stock_piece. applies_at=stock_piece means it
-- varies per physical piece and may be set all the way down -- including
-- broadly, because a broad value is a DEFAULT and a default is meaningful at
-- any width ("our plate is normally 6000 long").
--
-- That single rule replaces the old level enum AND the runtime gate that had to
-- stop a stray piece-level value overriding an item-level field. Here the
-- stray cannot be written in the first place.
--
-- `is_standard` marks a field the code ships against. Its KEY is immutable and
-- it cannot be deleted -- a feature written against `thickness_mm` must not have
-- it renamed out from under it -- while its label, unit, allowed values and
-- scoping stay editable. That is what lets standard and custom fields share one
-- table, one resolver and one screen.
CREATE TABLE IF NOT EXISTS fab_fields (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  company_id      INT NOT NULL,
  field_key       VARCHAR(100) NOT NULL,
  label           VARCHAR(255) NOT NULL,
  data_type       VARCHAR(20)  NOT NULL DEFAULT 'number',
  -- Constrains which units are valid for a value. NULL = unitless.
  dimension       VARCHAR(20)  NULL,
  default_unit    VARCHAR(20)  NULL,
  allowed_values  JSON         NULL,
  applies_at      VARCHAR(20)  NOT NULL DEFAULT 'catalog_item',
  formula_usable  TINYINT(1)   NOT NULL DEFAULT 1,
  default_num     DECIMAL(18,6) NULL,
  default_text    VARCHAR(500)  NULL,
  is_standard     TINYINT(1)   NOT NULL DEFAULT 0,
  -- Where the field is OFFERED. NULL at every level = offered everywhere.
  category_id     INT NULL,
  group_id        INT NULL,
  subgroup_id     INT NULL,
  sort_order      INT NOT NULL DEFAULT 0,
  active          TINYINT(1) NOT NULL DEFAULT 1,
  notes           TEXT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at      DATETIME NULL,
  UNIQUE KEY uq_ff_company_key (company_id, field_key),
  KEY idx_ff_scope (company_id, category_id, group_id, subgroup_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- THE VALUE. Four fixes are structural rather than behavioural:
--
--   field_id            an integer FK, so the string-collation bug class dies
--   UNIQUE(...)         so a write is a real upsert, not SELECT-then-branch
--   value_num/text/date so a number is a number and text stops being dropped
--   unit_code           so a value states what it was measured in
--
-- `scope` is ONE ladder with one meaning, unlike the two `level` columns it
-- replaces: category, group, subgroup, catalog_item, order_item, stock_piece.
--
-- The second index is for the matchers. Procurement and consumption currently
-- filter on fab_stock_pieces.length_mm/width_mm as columns; when those move to
-- fields (step 4) the equivalent query is a join on this index rather than a
-- table scan.
CREATE TABLE IF NOT EXISTS fab_field_values (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  company_id  INT NOT NULL,
  field_id    INT NOT NULL,
  scope       VARCHAR(20) NOT NULL,
  scope_id    INT NOT NULL,
  value_num   DECIMAL(18,6) NULL,
  value_text  VARCHAR(500)  NULL,
  value_date  DATE          NULL,
  unit_code   VARCHAR(20)   NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at  DATETIME NULL,
  UNIQUE KEY uq_ffv_target (company_id, field_id, scope, scope_id),
  KEY idx_ffv_match (company_id, field_id, value_num, scope, scope_id),
  KEY idx_ffv_scope (company_id, scope, scope_id),
  CONSTRAINT fk_ffv_field FOREIGN KEY (field_id) REFERENCES fab_fields(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- SEED fab_fields FROM THE OLD REGISTRY.
--
-- Definitions carry over; VALUES do not. Production data is dummy, so the 915
-- value rows are rebuilt rather than migrated -- cheaper than a migration and
-- it leaves no half-converted state to reason about later.
--
-- Every seeded field is `is_standard = 1`: these are the ones features are
-- written against, so their KEY is immutable and they cannot be deleted. Label,
-- unit, allowed values and scoping stay editable, which is what lets standard
-- and custom fields share one table and one screen.
--
-- The level mapping, and why:
--   item  -> order_item    does not vary per PIECE. Not catalog_item: the old
--                          gate (authoredOnPiece) only ever gated the PIECE
--                          step, and the old chain read order_item as its
--                          second-narrowest source for EVERY field. Mapping
--                          this to catalog_item would refuse 457 of the 915
--                          live values -- every per-order thickness and weight.
--   both  -> stock_piece   "set on the item, overridden per piece" IS
--                          settable-all-the-way-down under one rule
--   piece -> stock_piece   varies per physical piece
INSERT INTO fab_fields
  (company_id, field_key, label, data_type, dimension, default_unit, allowed_values,
   applies_at, formula_usable, default_num, is_standard,
   category_id, group_id, subgroup_id, sort_order, active)
SELECT d.company_id, d.field_key, d.label,
       CASE WHEN d.data_type IN ('number','text','date','bool','enum') THEN d.data_type ELSE 'number' END,
       u.dimension, d.unit, d.allowed_values,
       CASE d.level WHEN 'item' THEN 'order_item' ELSE 'stock_piece' END,
       d.formula_usable, d.default_value, 1,
       d.category_id, d.group_id, d.subgroup_id, d.sort_order, d.active
  FROM fab_field_defs d
  LEFT JOIN fab_units u ON u.code = d.unit
 WHERE d.deleted_at IS NULL
ON DUPLICATE KEY UPDATE
  label = VALUES(label), data_type = VALUES(data_type), dimension = VALUES(dimension),
  default_unit = VALUES(default_unit), allowed_values = VALUES(allowed_values),
  applies_at = VALUES(applies_at), formula_usable = VALUES(formula_usable),
  default_num = VALUES(default_num), is_standard = VALUES(is_standard),
  category_id = VALUES(category_id), group_id = VALUES(group_id),
  subgroup_id = VALUES(subgroup_id), sort_order = VALUES(sort_order), active = VALUES(active);
