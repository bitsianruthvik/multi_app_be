-- FabFlow seed: features and capabilities.
-- Run once per environment. Safe to re-run (uses INSERT IGNORE / NOT EXISTS guards).
-- Roles (fab_user, fab_project_manager) must be created per-company via the admin UI
-- and then mapped to the capabilities below using role_capability.

-- FabFlow features
INSERT IGNORE INTO features (feature_name, feature_tag, type) VALUES
  ('View Project Plans',   'fab_view_plans',   'frontend'),
  ('Create Project Plan',  'fab_create_plan',  'frontend'),
  ('Edit Project Plan',    'fab_edit_plan',    'frontend'),
  ('Upload Excel',         'fab_upload_excel', 'frontend'),
  ('Approve Project Plan', 'fab_approve_plan', 'frontend');

-- Capability: fab_standard_user (view + create + edit + upload, no approve)
INSERT INTO features_capability (name, features_json)
SELECT 'fab_standard_user', JSON_ARRAYAGG(id)
FROM features
WHERE feature_tag IN ('fab_view_plans','fab_create_plan','fab_edit_plan','fab_upload_excel')
  AND deleted_at IS NULL
AND NOT EXISTS (SELECT 1 FROM features_capability WHERE name = 'fab_standard_user');

-- Capability: fab_project_manager (all five features including approve)
INSERT INTO features_capability (name, features_json)
SELECT 'fab_project_manager', JSON_ARRAYAGG(id)
FROM features
WHERE feature_tag IN ('fab_view_plans','fab_create_plan','fab_edit_plan','fab_upload_excel','fab_approve_plan')
  AND deleted_at IS NULL
AND NOT EXISTS (SELECT 1 FROM features_capability WHERE name = 'fab_project_manager');

-- -------------------------------------------------------------------
-- After running this script:
-- 1. Go to Admin > Roles and create roles "fab_user" and "fab_project_manager" for your company.
-- 2. Go to Admin > Role Mapping and assign:
--    fab_user          → capability: fab_standard_user
--    fab_project_manager → capability: fab_project_manager
-- 3. Assign users to these roles via Admin > Users.
-- -------------------------------------------------------------------
