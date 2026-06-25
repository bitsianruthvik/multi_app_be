-- Migration 007: backfill app_user_access for existing users
-- Run STEP 1 SELECT to verify before running STEP 3 INSERT

-- STEP 1: Preview
SELECT u.id AS user_id, u.email, a.id AS app_id, a.slug, u.role_id, u.company_id
FROM users u
JOIN apps a ON a.company_id = u.company_id AND a.deleted_at IS NULL
WHERE u.deleted_at IS NULL
ORDER BY u.company_id, u.id, a.id;

-- STEP 2: Count check
SELECT
  (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) AS active_users,
  (SELECT COUNT(*) FROM apps  WHERE deleted_at IS NULL) AS active_apps,
  (SELECT COUNT(*) FROM app_user_access WHERE deleted_at IS NULL) AS existing_rows;

-- STEP 3: Insert (idempotent)
INSERT INTO app_user_access (user_id, app_id, role_id, company_id)
SELECT u.id, a.id, u.role_id, u.company_id
FROM users u
JOIN apps a ON a.company_id = u.company_id AND a.deleted_at IS NULL
WHERE u.deleted_at IS NULL
ON DUPLICATE KEY UPDATE role_id = VALUES(role_id);

-- STEP 4: Verify
SELECT COUNT(*) AS total FROM app_user_access WHERE deleted_at IS NULL;
SELECT u.email, a.slug AS app, r.name AS role
FROM app_user_access aua
JOIN users u ON u.id = aua.user_id
JOIN apps  a ON a.id = aua.app_id
JOIN roles r ON r.id = aua.role_id
WHERE aua.deleted_at IS NULL
LIMIT 20;
