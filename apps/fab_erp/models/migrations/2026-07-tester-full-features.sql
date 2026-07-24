-- 2026-07-23 — Seed the full fab_erp feature set to every 'tester' role
-- Same gap as BUG-06 (2026-07-admin-full-features.sql), but for the 'tester'
-- role: its role_capability grants had drifted behind the feature set as new
-- fab_erp capabilities shipped (BOM Templates, Buffer Config, Machine State
-- manage, Shopfloor Analytics, Time Backfill were missing for test@placebo.com
-- in prod; Task Queue/DAG/Task Engine were also missing locally). Reuses the
-- 'fab_erp_admin_all' capability (all fab_erp feature tags, upserted by the
-- admin migration) and grants it to the 'tester' role of every company that
-- has the fab_erp app. Data-driven (by role name + app slug) — works regardless
-- of id numbering differences between local and prod. Idempotent — safe to
-- re-run. Assumes 2026-07-admin-full-features.sql has already created the
-- 'fab_erp_admin_all' capability; re-derives it here too so this file is
-- self-sufficient if run alone.

SET @fab_feats = (
  SELECT JSON_ARRAYAGG(id) FROM features
   WHERE feature_tag LIKE 'fab_erp%' AND deleted_at IS NULL
);

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

-- Grant it to every 'tester' role of every company that has the fab_erp app.
INSERT INTO role_capability (role_id, company_id, app_id, capability_id)
SELECT r.id, r.company_id, a.id, @cap_id
  FROM roles r
  JOIN apps a ON a.company_id = r.company_id AND a.slug = 'fab_erp'
 WHERE r.name = 'tester' AND r.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM role_capability rc
      WHERE rc.role_id = r.id AND rc.capability_id = @cap_id AND rc.deleted_at IS NULL
   );
