-- 2026-07-23 — Seed the full fab_erp feature set to every admin role (BUG-06)
-- The Placebo "admin" role could not reach the core manufacturing flow because
-- its role_capability grants covered only a handful of feature tags, hiding
-- Orders / Task Queue / Item Catalog / Operations / Flows / GRN etc. from the
-- sidebar. This grants a single 'fab_erp_admin_all' capability (the complete
-- fab_erp feature set) to the 'admin' role of every company that has the fab_erp
-- app. Data-driven (by role name + app slug), so it works regardless of the id
-- numbering that differs between local and prod. Idempotent — safe to re-run.

-- All fab_erp feature ids (features.feature_tag is globally unique, so one
-- capability can enumerate every tag).
SET @fab_feats = (
  SELECT JSON_ARRAYAGG(id) FROM features
   WHERE feature_tag LIKE 'fab_erp%' AND deleted_at IS NULL
);

-- Upsert the capability.
INSERT INTO features_capability (features_json, name)
SELECT @fab_feats, 'fab_erp_admin_all'
  FROM DUAL
 WHERE NOT EXISTS (
   SELECT 1 FROM features_capability WHERE name = 'fab_erp_admin_all' AND deleted_at IS NULL
 );

UPDATE features_capability
   SET features_json = @fab_feats
 WHERE name = 'fab_erp_admin_all' AND deleted_at IS NULL;

SET @cap_id = (
  SELECT capability_id FROM features_capability
   WHERE name = 'fab_erp_admin_all' AND deleted_at IS NULL LIMIT 1
);

-- Grant it to every admin role of every company that has the fab_erp app.
INSERT INTO role_capability (role_id, company_id, app_id, capability_id)
SELECT r.id, r.company_id, a.id, @cap_id
  FROM roles r
  JOIN apps a ON a.company_id = r.company_id AND a.slug = 'fab_erp'
 WHERE r.name = 'admin' AND r.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM role_capability rc
      WHERE rc.role_id = r.id AND rc.capability_id = @cap_id AND rc.deleted_at IS NULL
   );
