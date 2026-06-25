-- Migration: Multi-node process steps
-- Replaces fab_node_process_routes + fab_process_dependencies
-- with fab_process_steps + fab_process_step_node_map + fab_process_preconditions

-- ── 1. New tables ────────────────────────────────────────────────────────────

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

-- ── 2. Migrate existing data ─────────────────────────────────────────────────

-- Temp column so we can join old IDs to new IDs during migration
ALTER TABLE fab_process_steps ADD COLUMN legacy_route_id INT DEFAULT NULL;

-- Copy process routes → process steps (company_id from the parent plan)
INSERT INTO fab_process_steps
  (project_plan_id, company_id, process_step_code, process_name, process_type,
   sequence_no, parallel_group, machine_or_workcentre_type,
   estimated_time_value, estimated_time_unit, mandatory, notes,
   deleted_at, created_at, updated_at, legacy_route_id)
SELECT
  fnpr.project_plan_id, fpp.company_id,
  fnpr.process_step_code, fnpr.process_name, fnpr.process_type,
  fnpr.sequence_no, fnpr.parallel_group, fnpr.machine_or_workcentre_type,
  fnpr.estimated_time_value, fnpr.estimated_time_unit, fnpr.mandatory, fnpr.notes,
  fnpr.deleted_at, fnpr.created_at, fnpr.updated_at, fnpr.id
FROM fab_node_process_routes fnpr
JOIN fab_project_plans fpp ON fpp.id = fnpr.project_plan_id;

-- Copy node associations (all existing routes get role = Worked-On)
INSERT INTO fab_process_step_node_map
  (process_step_id, node_id, company_id, node_role, created_at)
SELECT fps.id, fnpr.node_id, fpp.company_id, 'Worked-On', fnpr.created_at
FROM fab_node_process_routes fnpr
JOIN fab_process_steps fps ON fps.legacy_route_id = fnpr.id
JOIN fab_project_plans fpp ON fpp.id = fnpr.project_plan_id;

-- Copy dependencies → preconditions
INSERT INTO fab_process_preconditions
  (process_step_id, company_id, required_process_step_id, required_condition, notes, created_at)
SELECT
  fps_succ.id, fpp.company_id,
  fps_pred.id, 'Complete', fpd.notes, fpd.created_at
FROM fab_process_dependencies fpd
JOIN fab_process_steps fps_succ ON fps_succ.legacy_route_id = fpd.successor_process_route_id
JOIN fab_process_steps fps_pred ON fps_pred.legacy_route_id = fpd.predecessor_process_route_id
JOIN fab_project_plans fpp ON fpp.id = fps_succ.project_plan_id;

-- Remove temp column
ALTER TABLE fab_process_steps DROP COLUMN legacy_route_id;

-- ── 3. Drop old tables ───────────────────────────────────────────────────────

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS fab_process_dependencies;
DROP TABLE IF EXISTS fab_node_process_routes;
SET FOREIGN_KEY_CHECKS = 1;

-- ── 4. Verify ────────────────────────────────────────────────────────────────

SELECT 'fab_process_steps'          AS tbl, COUNT(*) AS cnt FROM fab_process_steps
UNION ALL
SELECT 'fab_process_step_node_map',          COUNT(*) FROM fab_process_step_node_map
UNION ALL
SELECT 'fab_process_preconditions',          COUNT(*) FROM fab_process_preconditions;
