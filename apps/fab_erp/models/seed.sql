-- =============================================================================
-- fab_erp RBAC seed  (EU-A5)
-- =============================================================================
-- What this file does:
--   1. Inserts one row into `apps` for the fab_erp app.
--   2. Inserts 14 rows into `features` (global table — no company_id column).
--   3. Inserts 7 rows into `features_capability` (global table — no company_id),
--      one capability per permission group, each features_json built via a
--      JSON_ARRAYAGG subquery so IDs are resolved at import time.
--
-- CRITICAL — company_id:
--   The securityInjector auto-injects company_id from the JWT on every query.
--   If the apps row is inserted with the wrong company_id, ALL fab_erp queries
--   will silently return empty results (no error, just nothing). Set @companyId
--   to the EXACT numeric id of the target tenant company BEFORE importing.
--
-- Schema notes (confirmed from core-init.sql and ARCHITECTURE.md §5):
--   - `features`            is a GLOBAL table — no company_id column.
--   - `features_capability` is a GLOBAL table — no company_id column.
--   - `apps`                requires company_id (tenant-scoped).
--   - `apps.slug`           has a UNIQUE constraint — INSERT IGNORE is safe for re-runs.
--
-- How to import:
--   mysql -u root -p sqldb < path/to/seed.sql
--   OR via MySQL Workbench: File > Run SQL Script
--
-- EU-A6 will APPEND role_capability + app_user_access rows to this same file.
-- =============================================================================

-- TODO: Set this to the real tenant company id before importing.
-- Wrong value → app row is isolated to the wrong company → all queries return empty.
SET @companyId = 1;

-- =============================================================================
-- 1. APP ROW
-- =============================================================================
-- `apps` columns: id, company_id, name, slug, is_public, created_at, settings, deleted_at
-- INSERT IGNORE skips silently if slug already exists (safe for re-runs).

INSERT IGNORE INTO apps (company_id, name, slug, is_public, settings)
VALUES (@companyId, 'Fab ERP', 'fab_erp', 1, NULL);

-- =============================================================================
-- 2. FEATURES  (global — no company_id column)
-- =============================================================================
-- 18 rows: one frontend (view) + one backend (manage) per permission group.
-- `name` column exists in the DDL (VARCHAR 255) but is not required; we mirror
-- the fab_flow seed which omits it.  feature_tag values are verbatim from the
-- EU-A5 spec and must not be changed — other units depend on them exactly.
--
-- INSERT IGNORE prevents duplicates on re-runs (feature_tag has no UNIQUE
-- constraint in core-init.sql, but idempotency is still correct practice).

INSERT IGNORE INTO features (feature_name, feature_tag, type) VALUES
  -- Resource Types & Resources
  ('View Resources',            'fab_erp_resources_view',      'frontend'),
  ('Manage Resources',          'fab_erp_resources_manage',    'backend'),
  -- Item Metrics & Constants
  ('View Item Metrics',         'fab_erp_items_meta_view',     'frontend'),
  ('Manage Item Metrics',       'fab_erp_items_meta_manage',   'backend'),
  -- Formulas
  ('View Formulas',             'fab_erp_formulas_view',       'frontend'),
  ('Manage Formulas',           'fab_erp_formulas_manage',     'backend'),
  -- Templates (process / routing / mfg-method)
  ('View Templates',            'fab_erp_templates_view',      'frontend'),
  ('Manage Templates',          'fab_erp_templates_manage',    'backend'),
  -- Projects & Items
  ('View Projects',             'fab_erp_projects_view',       'frontend'),
  ('Manage Projects',           'fab_erp_projects_manage',     'backend'),
  -- Calendars
  ('View Calendars',            'fab_erp_calendars_view',      'frontend'),
  ('Manage Calendars',          'fab_erp_calendars_manage',    'backend'),
  -- Planning & Capacity
  ('View Planning',             'fab_erp_planning_view',       'frontend'),
  ('Manage Planning',           'fab_erp_planning_manage',     'backend'),
  -- Operations
  ('View Operations',           'fab_erp_operations_view',     'frontend'),
  ('Manage Operations',         'fab_erp_operations_manage',   'backend'),
  -- Operation Flows
  ('View Operation Flows',      'fab_erp_flows_view',          'frontend'),
  ('Manage Operation Flows',    'fab_erp_flows_manage',        'backend'),
  -- Inventory & Stock
  ('View Inventory',            'fab_erp_inventory_view',          'frontend'),
  ('Manage Inventory',          'fab_erp_inventory_manage',        'frontend'),
  ('Manage Stock Locations',    'fab_erp_stock_location_manage',   'frontend'),
  ('Manage Item Taxonomy',      'fab_erp_taxonomy_manage',          'frontend'),
  -- GRN (Goods Receipt Note)
  ('View GRNs',                 'fab_erp_grn_view',                 'frontend'),
  ('Manage GRNs',                'fab_erp_grn_manage',              'frontend'),
  -- BOM Templates (EU-12)
  ('View BOM Templates',        'fab_erp_bomtemplate_view',        'frontend'),
  ('Manage BOM Templates',      'fab_erp_bomtemplate_manage',      'backend'),
  -- Task Queue (EU-4)
  ('View Task Queue',           'fab_erp_taskqueue_view',          'frontend'),
  ('Manage Task Queue',         'fab_erp_taskqueue_manage',        'backend'),
  -- Project DAG (EU-4)
  ('View Project DAG',          'fab_erp_projectdag_view',         'frontend');

-- =============================================================================
-- 3. FEATURES_CAPABILITY  (global — no company_id column)
-- =============================================================================
-- 11 capabilities, one per permission group.
-- features_json is built via JSON_ARRAYAGG(id) from a subquery — IDs are
-- resolved dynamically at import time so this script does not hardcode any IDs.
-- Each INSERT is guarded by NOT EXISTS *and* a HAVING JSON_ARRAYAGG(id) IS NOT NULL
-- clause so it is safe to re-run: without the HAVING, an ungrouped aggregate still
-- returns one (NULL) row when NOT EXISTS filters everything out, inserting a junk
-- duplicate capability with features_json = NULL on every re-run.
--
-- `features_capability` columns: capability_id (PK AI), name, features_json, deleted_at

-- Capability 1: Resources (view + manage)
INSERT INTO features_capability (name, features_json)
SELECT 'fab_erp_resources', JSON_ARRAYAGG(id)
FROM features
WHERE feature_tag IN ('fab_erp_resources_view', 'fab_erp_resources_manage')
  AND deleted_at IS NULL
AND NOT EXISTS (
  SELECT 1 FROM features_capability WHERE name = 'fab_erp_resources'
)
HAVING JSON_ARRAYAGG(id) IS NOT NULL;

-- Capability 2: Item Metrics & Constants (view + manage)
INSERT INTO features_capability (name, features_json)
SELECT 'fab_erp_items_meta', JSON_ARRAYAGG(id)
FROM features
WHERE feature_tag IN ('fab_erp_items_meta_view', 'fab_erp_items_meta_manage')
  AND deleted_at IS NULL
AND NOT EXISTS (
  SELECT 1 FROM features_capability WHERE name = 'fab_erp_items_meta'
)
HAVING JSON_ARRAYAGG(id) IS NOT NULL;

-- Capability 3: Formulas (view + manage)
INSERT INTO features_capability (name, features_json)
SELECT 'fab_erp_formulas', JSON_ARRAYAGG(id)
FROM features
WHERE feature_tag IN ('fab_erp_formulas_view', 'fab_erp_formulas_manage')
  AND deleted_at IS NULL
AND NOT EXISTS (
  SELECT 1 FROM features_capability WHERE name = 'fab_erp_formulas'
)
HAVING JSON_ARRAYAGG(id) IS NOT NULL;

-- Capability 4: Templates — process / routing / mfg-method (view + manage)
INSERT INTO features_capability (name, features_json)
SELECT 'fab_erp_templates', JSON_ARRAYAGG(id)
FROM features
WHERE feature_tag IN ('fab_erp_templates_view', 'fab_erp_templates_manage')
  AND deleted_at IS NULL
AND NOT EXISTS (
  SELECT 1 FROM features_capability WHERE name = 'fab_erp_templates'
)
HAVING JSON_ARRAYAGG(id) IS NOT NULL;

-- Capability 5: Projects & Items (view + manage)
INSERT INTO features_capability (name, features_json)
SELECT 'fab_erp_projects', JSON_ARRAYAGG(id)
FROM features
WHERE feature_tag IN ('fab_erp_projects_view', 'fab_erp_projects_manage')
  AND deleted_at IS NULL
AND NOT EXISTS (
  SELECT 1 FROM features_capability WHERE name = 'fab_erp_projects'
)
HAVING JSON_ARRAYAGG(id) IS NOT NULL;

-- Capability 6: Calendars (view + manage)
INSERT INTO features_capability (name, features_json)
SELECT 'fab_erp_calendars', JSON_ARRAYAGG(id)
FROM features
WHERE feature_tag IN ('fab_erp_calendars_view', 'fab_erp_calendars_manage')
  AND deleted_at IS NULL
AND NOT EXISTS (
  SELECT 1 FROM features_capability WHERE name = 'fab_erp_calendars'
)
HAVING JSON_ARRAYAGG(id) IS NOT NULL;

-- Capability 7: Planning & Capacity (view + manage)
INSERT INTO features_capability (name, features_json)
SELECT 'fab_erp_planning', JSON_ARRAYAGG(id)
FROM features
WHERE feature_tag IN ('fab_erp_planning_view', 'fab_erp_planning_manage')
  AND deleted_at IS NULL
AND NOT EXISTS (
  SELECT 1 FROM features_capability WHERE name = 'fab_erp_planning'
)
HAVING JSON_ARRAYAGG(id) IS NOT NULL;

-- Capability 8: Operations (view + manage)
INSERT INTO features_capability (name, features_json)
SELECT 'fab_erp_operations', JSON_ARRAYAGG(id)
FROM features
WHERE feature_tag IN ('fab_erp_operations_view', 'fab_erp_operations_manage')
  AND deleted_at IS NULL
AND NOT EXISTS (
  SELECT 1 FROM features_capability WHERE name = 'fab_erp_operations'
)
HAVING JSON_ARRAYAGG(id) IS NOT NULL;

-- Capability 9: Operation Flows (view + manage)
INSERT INTO features_capability (name, features_json)
SELECT 'fab_erp_flows', JSON_ARRAYAGG(id)
FROM features
WHERE feature_tag IN ('fab_erp_flows_view', 'fab_erp_flows_manage')
  AND deleted_at IS NULL
AND NOT EXISTS (
  SELECT 1 FROM features_capability WHERE name = 'fab_erp_flows'
)
HAVING JSON_ARRAYAGG(id) IS NOT NULL;

-- Capability 10: Inventory & Stock Setup (view + manage + locations + taxonomy)
INSERT INTO features_capability (name, features_json)
SELECT 'fab_erp_inventory_setup', JSON_ARRAYAGG(id)
FROM features
WHERE feature_tag IN ('fab_erp_inventory_view', 'fab_erp_inventory_manage', 'fab_erp_stock_location_manage', 'fab_erp_taxonomy_manage')
  AND deleted_at IS NULL
AND NOT EXISTS (
  SELECT 1 FROM features_capability WHERE name = 'fab_erp_inventory_setup'
)
HAVING JSON_ARRAYAGG(id) IS NOT NULL;

-- Capability 11: GRN (view + manage)
INSERT INTO features_capability (name, features_json)
SELECT 'fab_erp_grn', JSON_ARRAYAGG(id)
FROM features
WHERE feature_tag IN ('fab_erp_grn_view', 'fab_erp_grn_manage')
  AND deleted_at IS NULL
AND NOT EXISTS (
  SELECT 1 FROM features_capability WHERE name = 'fab_erp_grn'
)
HAVING JSON_ARRAYAGG(id) IS NOT NULL;

-- Capability 12: BOM Templates (view + manage) (EU-12)
INSERT INTO features_capability (name, features_json)
SELECT 'fab_erp_bomtemplate', JSON_ARRAYAGG(id)
FROM features
WHERE feature_tag IN ('fab_erp_bomtemplate_view', 'fab_erp_bomtemplate_manage')
  AND deleted_at IS NULL
AND NOT EXISTS (
  SELECT 1 FROM features_capability WHERE name = 'fab_erp_bomtemplate'
)
HAVING JSON_ARRAYAGG(id) IS NOT NULL;

-- Capability 13: Task Queue (view + manage) (EU-4)
INSERT INTO features_capability (name, features_json)
SELECT 'fab_erp_taskqueue', JSON_ARRAYAGG(id)
FROM features
WHERE feature_tag IN ('fab_erp_taskqueue_view', 'fab_erp_taskqueue_manage')
  AND deleted_at IS NULL
AND NOT EXISTS (
  SELECT 1 FROM features_capability WHERE name = 'fab_erp_taskqueue'
)
HAVING JSON_ARRAYAGG(id) IS NOT NULL;

-- Capability 14: Project DAG (view only) (EU-4)
INSERT INTO features_capability (name, features_json)
SELECT 'fab_erp_projectdag', JSON_ARRAYAGG(id)
FROM features
WHERE feature_tag IN ('fab_erp_projectdag_view')
  AND deleted_at IS NULL
AND NOT EXISTS (
  SELECT 1 FROM features_capability WHERE name = 'fab_erp_projectdag'
)
HAVING JSON_ARRAYAGG(id) IS NOT NULL;

-- ===== EU-A6 appends below: role_capability + app_user_access =====

-- =============================================================================
-- 4. ROLE_CAPABILITY  (tenant-scoped)
-- =============================================================================
-- Grant all 11 fab_erp capabilities to the Admin role for @companyId.
-- Columns confirmed from core-init.sql:
--   role_id, team_id (NULL = company-wide), company_id, app_id, capability_id
-- INSERT IGNORE is safe because there is no unique constraint on the column
-- combination, but re-running will simply skip existing rows with the same PK.
-- We use SET variables to resolve role_id and app_id exactly once, then
-- reference them in all 11 inserts — matching the pattern in demo_seed.sql.
--
-- NOTE: The Admin role name is 'Admin' (capital A) as created by registerAdmin.
--       If your company uses a different admin role name, update the WHERE clause.

SET @erp_app_id = (
  SELECT id FROM apps
  WHERE slug = 'fab_erp' AND company_id = @companyId
  LIMIT 1
);

SET @admin_role_id = (
  SELECT id FROM roles
  WHERE name = 'Admin' AND company_id = @companyId
  LIMIT 1
);

-- Capability 1: fab_erp_resources → Admin
INSERT IGNORE INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
VALUES (
  @admin_role_id,
  NULL,
  @companyId,
  @erp_app_id,
  (SELECT capability_id FROM features_capability WHERE name = 'fab_erp_resources' LIMIT 1)
);

-- Capability 2: fab_erp_items_meta → Admin
INSERT IGNORE INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
VALUES (
  @admin_role_id,
  NULL,
  @companyId,
  @erp_app_id,
  (SELECT capability_id FROM features_capability WHERE name = 'fab_erp_items_meta' LIMIT 1)
);

-- Capability 3: fab_erp_formulas → Admin
INSERT IGNORE INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
VALUES (
  @admin_role_id,
  NULL,
  @companyId,
  @erp_app_id,
  (SELECT capability_id FROM features_capability WHERE name = 'fab_erp_formulas' LIMIT 1)
);

-- Capability 4: fab_erp_templates → Admin
INSERT IGNORE INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
VALUES (
  @admin_role_id,
  NULL,
  @companyId,
  @erp_app_id,
  (SELECT capability_id FROM features_capability WHERE name = 'fab_erp_templates' LIMIT 1)
);

-- Capability 5: fab_erp_projects → Admin
INSERT IGNORE INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
VALUES (
  @admin_role_id,
  NULL,
  @companyId,
  @erp_app_id,
  (SELECT capability_id FROM features_capability WHERE name = 'fab_erp_projects' LIMIT 1)
);

-- Capability 6: fab_erp_calendars → Admin
INSERT IGNORE INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
VALUES (
  @admin_role_id,
  NULL,
  @companyId,
  @erp_app_id,
  (SELECT capability_id FROM features_capability WHERE name = 'fab_erp_calendars' LIMIT 1)
);

-- Capability 7: fab_erp_planning → Admin
INSERT IGNORE INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
VALUES (
  @admin_role_id,
  NULL,
  @companyId,
  @erp_app_id,
  (SELECT capability_id FROM features_capability WHERE name = 'fab_erp_planning' LIMIT 1)
);

-- Capability 8: fab_erp_operations → Admin
INSERT IGNORE INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
VALUES (
  @admin_role_id,
  NULL,
  @companyId,
  @erp_app_id,
  (SELECT capability_id FROM features_capability WHERE name = 'fab_erp_operations' LIMIT 1)
);

-- Capability 9: fab_erp_flows → Admin
INSERT IGNORE INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
VALUES (
  @admin_role_id,
  NULL,
  @companyId,
  @erp_app_id,
  (SELECT capability_id FROM features_capability WHERE name = 'fab_erp_flows' LIMIT 1)
);

-- Capability 11: fab_erp_inventory_setup → Admin
INSERT IGNORE INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
VALUES (
  @admin_role_id,
  NULL,
  @companyId,
  @erp_app_id,
  (SELECT capability_id FROM features_capability WHERE name = 'fab_erp_inventory_setup' LIMIT 1)
);

-- Capability 12: fab_erp_grn → Admin
INSERT IGNORE INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
VALUES (
  @admin_role_id,
  NULL,
  @companyId,
  @erp_app_id,
  (SELECT capability_id FROM features_capability WHERE name = 'fab_erp_grn' LIMIT 1)
);

-- Capability 13: fab_erp_bomtemplate → Admin (EU-12)
INSERT IGNORE INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
VALUES (
  @admin_role_id,
  NULL,
  @companyId,
  @erp_app_id,
  (SELECT capability_id FROM features_capability WHERE name = 'fab_erp_bomtemplate' LIMIT 1)
);

-- Capability 14: fab_erp_taskqueue → Admin (EU-4)
INSERT IGNORE INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
VALUES (
  @admin_role_id,
  NULL,
  @companyId,
  @erp_app_id,
  (SELECT capability_id FROM features_capability WHERE name = 'fab_erp_taskqueue' LIMIT 1)
);

-- Capability 15: fab_erp_projectdag → Admin (EU-4)
INSERT IGNORE INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
VALUES (
  @admin_role_id,
  NULL,
  @companyId,
  @erp_app_id,
  (SELECT capability_id FROM features_capability WHERE name = 'fab_erp_projectdag' LIMIT 1)
);

-- =============================================================================
-- 5. APP_USER_ACCESS  (tenant-scoped)
-- =============================================================================
-- Grant every active user in @companyId access to the fab_erp app.
-- Columns confirmed from core-init.sql:
--   user_id, app_id, role_id, company_id
-- UNIQUE KEY uq_user_app (user_id, app_id) makes ON DUPLICATE KEY UPDATE safe
-- for re-runs without inserting phantom rows.
--
-- Pattern is identical to core migration 007_backfill_app_user_access.sql:
-- set-based JOIN so any future users added before the next seed run are also
-- covered. role_id is taken from users.role_id (the user's current role).

INSERT INTO app_user_access (user_id, app_id, role_id, company_id)
SELECT
  u.id          AS user_id,
  @erp_app_id   AS app_id,
  u.role_id     AS role_id,
  u.company_id  AS company_id
FROM users u
WHERE u.company_id = @companyId
  AND u.deleted_at IS NULL
ON DUPLICATE KEY UPDATE role_id = VALUES(role_id);

-- =============================================================================
-- 6. PROJECT MANAGER — read-only inventory visibility
-- =============================================================================
-- The fab_project_manager role needs to view stock balances/batches (Stock
-- Levels tab + Item Batches page) without granting full inventory management.
-- Create a single-feature view-only capability for fab_erp_inventory_view and
-- grant it to fab_project_manager, mirroring the *_view_only pattern used for
-- resources/items_meta/formulas/templates/calendars.

INSERT INTO features_capability (name, features_json)
SELECT 'fab_erp_inventory_view_only', JSON_ARRAY(id)
FROM features
WHERE feature_tag = 'fab_erp_inventory_view'
AND NOT EXISTS (
  SELECT 1 FROM features_capability WHERE name = 'fab_erp_inventory_view_only'
);

SET @pm_role_id = (
  SELECT id FROM roles
  WHERE name = 'fab_project_manager' AND company_id = @companyId
  LIMIT 1
);

INSERT IGNORE INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
SELECT
  @pm_role_id,
  NULL,
  @companyId,
  @erp_app_id,
  fc.capability_id
FROM features_capability fc
WHERE fc.name = 'fab_erp_inventory_view_only'
  AND @pm_role_id IS NOT NULL;

-- =============================================================================
-- 7. MACHINE BOARD / MACHINE STATE  (EU-4, Shop-Floor Time Intelligence)
-- =============================================================================
-- Single permission tag for the whole Machine Board feature (GET board
-- included — one tag per the EU-4 plan). Mirrors the fab_erp_taskengine_view
-- block in seed_fab_erp_taskengine.sql (TM root): set-based, no @companyId
-- to set — role_capability is granted to every fab_erp tenant's Admin role
-- by joining companies -> apps -> roles, so this is safe to re-run in any
-- environment (local MySQL + TiDB) without editing.

INSERT IGNORE INTO features (feature_name, feature_tag, type) VALUES
  ('Manage Machine State',      'fab_erp_machine_state_manage', 'backend');

INSERT INTO features_capability (name, features_json)
SELECT 'fab_erp_machine_state', JSON_ARRAYAGG(id)
FROM features
WHERE feature_tag IN ('fab_erp_machine_state_manage')
  AND deleted_at IS NULL
AND NOT EXISTS (
  SELECT 1 FROM features_capability WHERE name = 'fab_erp_machine_state'
)
HAVING JSON_ARRAYAGG(id) IS NOT NULL;

INSERT IGNORE INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
SELECT r.id, NULL, c.id, a.id, fc.capability_id
FROM companies c
JOIN apps  a ON a.company_id = c.id AND a.slug = 'fab_erp'
JOIN roles r ON r.company_id = c.id AND r.name = 'Admin'
JOIN features_capability fc ON fc.name = 'fab_erp_machine_state';

-- =============================================================================
-- Section 8: Shop-Floor Time Intelligence Phases 2-4 permission tags
-- (mirror of TM/seed_fab_erp_shopfloor_p234.sql — set-based, idempotent)
--   fab_erp_buffer_config, fab_erp_time_backfill, fab_erp_shopfloor_analytics_view
-- =============================================================================
INSERT IGNORE INTO features (feature_name, feature_tag, type) VALUES
  ('Configure Machine Buffers',       'fab_erp_buffer_config',            'backend'),
  ('Back-enter / Correct Task Times', 'fab_erp_time_backfill',            'backend'),
  ('View Shop-Floor Analytics',       'fab_erp_shopfloor_analytics_view', 'backend');

INSERT INTO features_capability (name, features_json)
SELECT 'fab_erp_buffer_config', JSON_ARRAYAGG(id)
FROM features WHERE feature_tag IN ('fab_erp_buffer_config') AND deleted_at IS NULL
AND NOT EXISTS (SELECT 1 FROM features_capability WHERE name = 'fab_erp_buffer_config')
HAVING JSON_ARRAYAGG(id) IS NOT NULL;

INSERT INTO features_capability (name, features_json)
SELECT 'fab_erp_time_backfill', JSON_ARRAYAGG(id)
FROM features WHERE feature_tag IN ('fab_erp_time_backfill') AND deleted_at IS NULL
AND NOT EXISTS (SELECT 1 FROM features_capability WHERE name = 'fab_erp_time_backfill')
HAVING JSON_ARRAYAGG(id) IS NOT NULL;

INSERT INTO features_capability (name, features_json)
SELECT 'fab_erp_shopfloor_analytics_view', JSON_ARRAYAGG(id)
FROM features WHERE feature_tag IN ('fab_erp_shopfloor_analytics_view') AND deleted_at IS NULL
AND NOT EXISTS (SELECT 1 FROM features_capability WHERE name = 'fab_erp_shopfloor_analytics_view')
HAVING JSON_ARRAYAGG(id) IS NOT NULL;

INSERT IGNORE INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
SELECT r.id, NULL, c.id, a.id, fc.capability_id
FROM companies c
JOIN apps  a ON a.company_id = c.id AND a.slug = 'fab_erp'
JOIN roles r ON r.company_id = c.id AND r.name = 'Admin'
JOIN features_capability fc
  ON fc.name IN ('fab_erp_buffer_config', 'fab_erp_time_backfill', 'fab_erp_shopfloor_analytics_view');

-- =============================================================================
-- Section 9: Critical Chain view/manage permission tags (EU-1)
-- (mirror of TM/seed_fab_erp_criticalchain.sql — set-based, idempotent)
--   fab_erp_cc_view, fab_erp_cc_manage
-- =============================================================================
INSERT IGNORE INTO features (feature_name, feature_tag, type) VALUES
  ('View Critical Chain',    'fab_erp_cc_view',    'frontend'),
  ('Manage Critical Chain',  'fab_erp_cc_manage',  'backend');

INSERT INTO features_capability (name, features_json)
SELECT 'fab_erp_cc_view', JSON_ARRAYAGG(id)
FROM features WHERE feature_tag IN ('fab_erp_cc_view') AND deleted_at IS NULL
AND NOT EXISTS (SELECT 1 FROM features_capability WHERE name = 'fab_erp_cc_view')
HAVING JSON_ARRAYAGG(id) IS NOT NULL;

INSERT INTO features_capability (name, features_json)
SELECT 'fab_erp_cc_manage', JSON_ARRAYAGG(id)
FROM features WHERE feature_tag IN ('fab_erp_cc_manage') AND deleted_at IS NULL
AND NOT EXISTS (SELECT 1 FROM features_capability WHERE name = 'fab_erp_cc_manage')
HAVING JSON_ARRAYAGG(id) IS NOT NULL;

INSERT IGNORE INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
SELECT r.id, NULL, c.id, a.id, fc.capability_id
FROM companies c
JOIN apps  a ON a.company_id = c.id AND a.slug = 'fab_erp'
JOIN roles r ON r.company_id = c.id AND r.name = 'Admin'
JOIN features_capability fc
  ON fc.name IN ('fab_erp_cc_view', 'fab_erp_cc_manage');
