-- ============================================================================
-- cf_erp — permissions and app access. Run AFTER models/init.sql and
-- modules/codegen/models/init.sql. Idempotent: every insert checks first
-- (features.feature_tag has no unique key, so INSERT IGNORE would duplicate).
-- ============================================================================

-- 1. Features (global). Four view tags and seven manage tags, matching lib/http.js PERM.
INSERT INTO features (feature_name, feature_tag, type)
SELECT x.feature_name, x.feature_tag, x.type
  FROM (
    SELECT 'CF ERP: view catalog and setup' AS feature_name, 'cf_erp_catalog_view'   AS feature_tag, 'frontend' AS type UNION ALL
    SELECT 'CF ERP: manage items and definitions',          'cf_erp_catalog_manage',             'backend'          UNION ALL
    SELECT 'CF ERP: manage classification and specifications','cf_erp_setup_manage',             'backend'          UNION ALL
    SELECT 'CF ERP: manage coding rules',                    'cf_erp_codegen_manage',            'backend'          UNION ALL
    SELECT 'CF ERP: view sales orders and customers',        'cf_erp_orders_view',               'frontend'         UNION ALL
    SELECT 'CF ERP: manage sales orders and their structures','cf_erp_orders_manage',            'backend'          UNION ALL
    SELECT 'CF ERP: manage customers and suppliers',         'cf_erp_parties_manage',            'backend'          UNION ALL
    SELECT 'CF ERP: view machines, operations and flows',    'cf_erp_production_view',           'frontend'         UNION ALL
    SELECT 'CF ERP: manage machines, operations and flows',  'cf_erp_production_manage',         'backend'          UNION ALL
    SELECT 'CF ERP: view stock, batches and movements',      'cf_erp_inventory_view',            'frontend'         UNION ALL
    SELECT 'CF ERP: manage stock, batches and movements',    'cf_erp_inventory_manage',          'backend'
  ) x
 WHERE NOT EXISTS (SELECT 1 FROM features f WHERE f.feature_tag = x.feature_tag AND f.deleted_at IS NULL);

-- 2. One capability per feature, named after it.
INSERT INTO features_capability (name, features_json)
SELECT f.feature_tag, JSON_ARRAY(f.id)
  FROM features f
 WHERE f.feature_tag IN ('cf_erp_catalog_view', 'cf_erp_catalog_manage', 'cf_erp_setup_manage', 'cf_erp_codegen_manage',
                     'cf_erp_orders_view', 'cf_erp_orders_manage', 'cf_erp_parties_manage',
                     'cf_erp_production_view', 'cf_erp_production_manage', 'cf_erp_inventory_view', 'cf_erp_inventory_manage')
   AND f.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM features_capability fc WHERE fc.name = f.feature_tag AND fc.deleted_at IS NULL);

-- 3. Every company's admin role gets all eleven, for that company's cf_erp app.
--    (The backend lets admins through anyway; the frontend's usePermission does not.)
INSERT INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
SELECT r.id, NULL, a.company_id, a.id, fc.capability_id
  FROM apps a
  JOIN roles r ON r.company_id = a.company_id AND LOWER(r.name) = 'admin' AND r.deleted_at IS NULL
  JOIN features_capability fc ON fc.name IN ('cf_erp_catalog_view', 'cf_erp_catalog_manage', 'cf_erp_setup_manage', 'cf_erp_codegen_manage',
                     'cf_erp_orders_view', 'cf_erp_orders_manage', 'cf_erp_parties_manage',
                     'cf_erp_production_view', 'cf_erp_production_manage', 'cf_erp_inventory_view', 'cf_erp_inventory_manage')
                             AND fc.deleted_at IS NULL
 WHERE a.slug = 'cf_erp' AND a.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM role_capability x
      WHERE x.role_id = r.id AND x.app_id = a.id AND x.capability_id = fc.capability_id AND x.deleted_at IS NULL);

-- 4. Users whose company role is admin may open the app.
INSERT INTO app_user_access (user_id, app_id, role_id, company_id)
SELECT u.id, a.id, u.role_id, a.company_id
  FROM apps a
  JOIN users u ON u.company_id = a.company_id AND u.deleted_at IS NULL
  JOIN roles r ON r.id = u.role_id AND LOWER(r.name) = 'admin'
 WHERE a.slug = 'cf_erp' AND a.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM app_user_access x WHERE x.user_id = u.id AND x.app_id = a.id AND x.deleted_at IS NULL);
