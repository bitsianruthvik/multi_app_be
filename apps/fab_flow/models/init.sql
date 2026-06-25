-- fab_flow app schema.
-- Tables: fab_project_plans, fab_nodes, fab_node_relationships,
--         fab_process_steps, fab_process_step_node_map, fab_process_preconditions,
--         fab_excel_import_batches, fab_excel_import_issues.
-- Depends on core tables: users, companies.

CREATE TABLE IF NOT EXISTS fab_project_plans (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  project_code    VARCHAR(100)  NOT NULL,
  project_name    VARCHAR(500)  NOT NULL,
  client_name     VARCHAR(255)  DEFAULT NULL,
  site_location   VARCHAR(255)  DEFAULT NULL,
  plan_name       VARCHAR(500)  NOT NULL,
  plan_revision   VARCHAR(50)   NOT NULL DEFAULT 'Rev 0',
  status          ENUM('Draft','Approved','Superseded') NOT NULL DEFAULT 'Draft',
  source          ENUM('Manual','Excel Upload')         NOT NULL DEFAULT 'Manual',
  notes           TEXT          DEFAULT NULL,
  company_id      INT           NOT NULL,
  created_by      INT           NOT NULL,
  approved_by     INT           DEFAULT NULL,
  approved_at     DATETIME      DEFAULT NULL,
  deleted_at      DATETIME      DEFAULT NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id)  REFERENCES companies(id),
  FOREIGN KEY (created_by)  REFERENCES users(id),
  FOREIGN KEY (approved_by) REFERENCES users(id),
  KEY idx_fpp_company_status  (company_id, status),
  KEY idx_fpp_company_project (company_id, project_code)
);

CREATE TABLE IF NOT EXISTS fab_nodes (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  project_plan_id   INT           NOT NULL,
  node_code         VARCHAR(100)  NOT NULL,
  display_name      VARCHAR(500)  NOT NULL,
  level_name        VARCHAR(100)  DEFAULT NULL,
  description       TEXT          DEFAULT NULL,
  quantity          DECIMAL(10,3) DEFAULT 1,
  unit              VARCHAR(50)   DEFAULT 'Nos',
  drawing_ref       VARCHAR(255)  DEFAULT NULL,
  drawing_sheet_no  VARCHAR(100)  DEFAULT NULL,
  drawing_revision  VARCHAR(50)   DEFAULT NULL,
  material_grade    VARCHAR(100)  DEFAULT NULL,
  profile           VARCHAR(255)  DEFAULT NULL,
  length_mm         DECIMAL(12,3) DEFAULT NULL,
  width_mm          DECIMAL(12,3) DEFAULT NULL,
  thickness_mm      DECIMAL(12,3) DEFAULT NULL,
  weight_kg         DECIMAL(12,3) DEFAULT NULL,
  location_ref      VARCHAR(255)  DEFAULT NULL,
  dispatchable      TINYINT(1)    DEFAULT 0,
  notes             TEXT          DEFAULT NULL,
  deleted_at        DATETIME      DEFAULT NULL,
  created_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (project_plan_id) REFERENCES fab_project_plans(id),
  UNIQUE KEY uq_fn_plan_code (project_plan_id, node_code),
  KEY idx_fn_plan     (project_plan_id),
  KEY idx_fn_level    (level_name)
);

CREATE TABLE IF NOT EXISTS fab_node_relationships (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  project_plan_id   INT           NOT NULL,
  parent_node_id    INT           NOT NULL,
  child_node_id     INT           NOT NULL,
  quantity_required DECIMAL(10,3) DEFAULT 1,
  relationship_type VARCHAR(100)  DEFAULT 'Assembly',
  is_primary        TINYINT(1)    DEFAULT 1,
  notes             TEXT          DEFAULT NULL,
  deleted_at        DATETIME      DEFAULT NULL,
  created_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_plan_id) REFERENCES fab_project_plans(id),
  FOREIGN KEY (parent_node_id)  REFERENCES fab_nodes(id),
  FOREIGN KEY (child_node_id)   REFERENCES fab_nodes(id),
  UNIQUE KEY uq_fnr_edge (parent_node_id, child_node_id),
  KEY idx_fnr_plan   (project_plan_id),
  KEY idx_fnr_parent (parent_node_id),
  KEY idx_fnr_child  (child_node_id)
);

CREATE TABLE IF NOT EXISTS fab_process_steps (
  id                         INT AUTO_INCREMENT PRIMARY KEY,
  project_plan_id            INT           NOT NULL,
  company_id                 INT           NOT NULL,
  process_step_code          VARCHAR(100)  DEFAULT NULL,
  process_name               VARCHAR(255)  NOT NULL,
  process_type               VARCHAR(100)  DEFAULT NULL,
  sequence_no                INT           NOT NULL DEFAULT 10,
  parallel_group             VARCHAR(50)   DEFAULT NULL,
  machine_or_workcentre_type VARCHAR(255)  DEFAULT NULL,
  estimated_time_value       DECIMAL(10,2) DEFAULT NULL,
  estimated_time_unit        VARCHAR(20)   DEFAULT 'min',
  mandatory                  TINYINT(1)    DEFAULT 1,
  notes                      TEXT          DEFAULT NULL,
  deleted_at                 DATETIME      DEFAULT NULL,
  created_at                 TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (project_plan_id) REFERENCES fab_project_plans(id),
  FOREIGN KEY (company_id)      REFERENCES companies(id),
  KEY idx_fps_plan     (project_plan_id),
  KEY idx_fps_company  (company_id),
  KEY idx_fps_sequence (project_plan_id, sequence_no)
);

CREATE TABLE IF NOT EXISTS fab_process_step_node_map (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  process_step_id  INT           NOT NULL,
  node_id          INT           NOT NULL,
  company_id       INT           NOT NULL,
  node_role        ENUM('Input','Output','Worked-On','Consumed','Reference') NOT NULL DEFAULT 'Worked-On',
  quantity         DECIMAL(10,3) DEFAULT NULL,
  notes            TEXT          DEFAULT NULL,
  deleted_at       DATETIME      DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (process_step_id) REFERENCES fab_process_steps(id),
  FOREIGN KEY (node_id)         REFERENCES fab_nodes(id),
  FOREIGN KEY (company_id)      REFERENCES companies(id),
  KEY idx_fpsnm_step    (process_step_id),
  KEY idx_fpsnm_node    (node_id),
  KEY idx_fpsnm_company (company_id)
);

CREATE TABLE IF NOT EXISTS fab_process_preconditions (
  id                        INT AUTO_INCREMENT PRIMARY KEY,
  process_step_id           INT           NOT NULL,
  company_id                INT           NOT NULL,
  required_node_id          INT           DEFAULT NULL,
  required_process_step_id  INT           DEFAULT NULL,
  required_condition        VARCHAR(100)  DEFAULT 'Complete',
  notes                     TEXT          DEFAULT NULL,
  deleted_at                DATETIME      DEFAULT NULL,
  created_at                TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (process_step_id)          REFERENCES fab_process_steps(id),
  FOREIGN KEY (company_id)               REFERENCES companies(id),
  FOREIGN KEY (required_node_id)         REFERENCES fab_nodes(id),
  FOREIGN KEY (required_process_step_id) REFERENCES fab_process_steps(id),
  KEY idx_fppc_step     (process_step_id),
  KEY idx_fppc_company  (company_id),
  KEY idx_fppc_req_step (required_process_step_id)
);

CREATE TABLE IF NOT EXISTS fab_excel_import_batches (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  project_plan_id INT           NOT NULL,
  file_name       VARCHAR(500)  NOT NULL,
  uploaded_by     INT           NOT NULL,
  status          ENUM('Pending','Parsed','Failed','Imported') NOT NULL DEFAULT 'Pending',
  error_count     INT           DEFAULT 0,
  warning_count   INT           DEFAULT 0,
  parsed_data     JSON          DEFAULT NULL,
  deleted_at      DATETIME      DEFAULT NULL,
  uploaded_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_plan_id) REFERENCES fab_project_plans(id),
  FOREIGN KEY (uploaded_by)     REFERENCES users(id),
  KEY idx_feib_plan (project_plan_id)
);

CREATE TABLE IF NOT EXISTS fab_excel_import_issues (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  import_batch_id INT           NOT NULL,
  sheet_name      VARCHAR(100)  DEFAULT NULL,
  `row_number`    INT           DEFAULT NULL,
  severity        ENUM('Error','Warning') NOT NULL,
  field_name      VARCHAR(100)  DEFAULT NULL,
  message         TEXT          NOT NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (import_batch_id) REFERENCES fab_excel_import_batches(id),
  KEY idx_feii_batch (import_batch_id)
);
