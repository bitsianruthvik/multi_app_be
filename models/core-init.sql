-- Core schema — owned by the platform, shared across all apps.
-- Tables: companies, apps, users, teams, roles, features, features_capability, role_capability.
-- App-specific tables live in apps/<slug>/models/init.sql.

CREATE TABLE IF NOT EXISTS features (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255),
  feature_name VARCHAR(100),
  feature_tag VARCHAR(100),
  type ENUM('frontend', 'backend'),
  deleted_at DATETIME NULL DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS features_capability (
  capability_id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100),
  features_json JSON,
  deleted_at DATETIME NULL DEFAULT NULL,
  CONSTRAINT chk_valid_json CHECK (JSON_VALID(features_json))
);


-- Companies table used to store app/company specific settings and slug
CREATE TABLE IF NOT EXISTS companies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  slug VARCHAR(100) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS apps (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  name VARCHAR(200) NOT NULL,
  slug VARCHAR(100) NOT NULL UNIQUE,
  is_public TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  settings JSON,
  deleted_at DATETIME NULL DEFAULT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS teams (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  company_id INT NOT NULL,
  deleted_at DATETIME NULL DEFAULT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS roles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  company_id INT NOT NULL,
  role_tag VARCHAR(64) NULL,
  deleted_at DATETIME NULL DEFAULT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

-- role_capability comes AFTER companies/apps/teams/roles because it has a real
-- foreign key into each of them. It used to sit near the top, which worked on
-- every existing database (CREATE TABLE IF NOT EXISTS is a no-op once the table
-- is there) and failed on every EMPTY one — so no new environment could be built
-- from these files at all. Found 2026-09-24. Reordering idempotent statements
-- changes nothing for a populated database.
-- Post-migration shape: role_capability uses FK columns (role_id, team_id, company_id).
-- See migrations/core/002_role_capability_fk.sql for the data migration.
CREATE TABLE IF NOT EXISTS role_capability (
  id INT AUTO_INCREMENT PRIMARY KEY,
  role_id INT NULL,
  team_id INT NULL,
  company_id INT NULL,
  app_id INT NULL,
  capability_id INT,
  deleted_at DATETIME NULL DEFAULT NULL,
  FOREIGN KEY (capability_id) REFERENCES features_capability(capability_id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT fk_rc_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  CONSTRAINT fk_rc_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  CONSTRAINT fk_rc_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT fk_rc_app FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(100) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  -- Nullable, because production is nullable and 13 of its 23 users have no
  -- team at all. The permission lookup is written for it: authController joins
  -- `role_capability` with `rc.team_id <=> ?`, the null-safe comparison, so a
  -- user with no team matches the grants that name no team. Declaring these
  -- NOT NULL here, as this file used to, meant a database built from this file
  -- could not hold production's own rows — a restore of a production backup
  -- died on "Column 'team_id' cannot be null".
  role_id INT NULL,
  team_id INT NULL,
  company_id INT NULL,
  deleted_at DATETIME NULL DEFAULT NULL,
  -- Per-user UI state, deep-merged by PUT /api/:company/:app/user/preferences
  -- and read by GET .../user/profile (core/query/profileController.js).
  --
  -- This column was live in every running database — local and production —
  -- while this file did not create it, so a database built from this file alone
  -- had a profile endpoint that answered 500 "Unknown column 'preferences'".
  -- Nothing caught it because no database had been built from empty since the
  -- column was added by hand. See the retrofit at the end of this file for the
  -- other half of the fix.
  preferences JSON NULL DEFAULT NULL,
  FOREIGN KEY (role_id) REFERENCES roles(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  FOREIGN KEY (team_id) REFERENCES teams(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  FOREIGN KEY (company_id) REFERENCES companies(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS app_user_access (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  app_id     INT NOT NULL,
  role_id    INT NOT NULL,
  company_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL DEFAULT NULL,
  UNIQUE KEY uq_user_app (user_id, app_id),
  KEY idx_aua_app     (app_id),
  KEY idx_aua_company (company_id),
  KEY idx_aua_role    (role_id),
  CONSTRAINT fk_aua_user    FOREIGN KEY (user_id)    REFERENCES users(id)     ON DELETE CASCADE,
  CONSTRAINT fk_aua_app     FOREIGN KEY (app_id)     REFERENCES apps(id)      ON DELETE CASCADE,
  CONSTRAINT fk_aua_role    FOREIGN KEY (role_id)    REFERENCES roles(id)     ON DELETE CASCADE,
  CONSTRAINT fk_aua_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ############################################################################
-- ## RETROFITS — guarded ALTERs, and they belong at the END                  ##
-- ############################################################################
-- A guarded ALTER must come after the CREATE TABLE of the table it alters.
-- Everything above is CREATE TABLE IF NOT EXISTS, which means statement order
-- in this file is exercised exactly once per database: the first time it meets
-- an EMPTY schema. After that every ordering mistake is invisible. So new
-- columns go here, guarded, rather than beside their table.
--
-- `users.preferences` is the reason this section exists. It was added to the
-- live databases by hand and never written down, so for an unknown stretch this
-- file could not rebuild a working platform: `GET /user/profile` and
-- `PUT /user/preferences` both name the column, and a fresh database did not
-- have it. The CREATE TABLE above now declares it for a new database; this
-- ALTER covers an existing one. Both are needed — neither alone is enough.

SET @needs_preferences = (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'users'
     AND COLUMN_NAME  = 'preferences');
SET @sql = IF(@needs_preferences = 1,
  'ALTER TABLE users ADD COLUMN preferences JSON NULL DEFAULT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ============================================================================
-- COMPANY ADMIN PANEL (user, 2026-11-19): people, roles and what each role may do, for a company's own admin.
--   users.username             a login for someone with no email (unique within the company). email stays NOT NULL:
--                              such a person's email is <username>@<company>.login, never shown.
--   users.must_change_password 1 = the password was set by an admin (new person, reset): it must be changed at the next login.
--   users.is_company_admin     1 = may open the admin panel of the company. (A role NAMED admin still passes every check, as before.)
--   users.deactivated_at       set = cannot log in; the name stays on everything the person recorded.
--   users.last_login_at        shown on the People list.
--   roles.standard_key         '<app>:<key>' when the role was made from a standard role of an app (apps/<app>/permissions.js).
--   admin_audit                every change made in the panel: who, when, what.
-- ============================================================================
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'username');
SET @sql = IF(@c = 0, 'ALTER TABLE users ADD COLUMN username VARCHAR(60) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'must_change_password');
SET @sql = IF(@c = 0, 'ALTER TABLE users ADD COLUMN must_change_password TINYINT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_company_admin');
SET @sql = IF(@c = 0, 'ALTER TABLE users ADD COLUMN is_company_admin TINYINT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'deactivated_at');
SET @sql = IF(@c = 0, 'ALTER TABLE users ADD COLUMN deactivated_at DATETIME NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'last_login_at');
SET @sql = IF(@c = 0, 'ALTER TABLE users ADD COLUMN last_login_at DATETIME NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'uq_users_company_username');
SET @sql = IF(@c = 0, 'ALTER TABLE users ADD UNIQUE KEY uq_users_company_username (company_id, username)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'roles' AND COLUMN_NAME = 'standard_key');
SET @sql = IF(@c = 0, 'ALTER TABLE roles ADD COLUMN standard_key VARCHAR(60) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

CREATE TABLE IF NOT EXISTS admin_audit (
  id            INT          AUTO_INCREMENT PRIMARY KEY,
  company_id    INT          NOT NULL,
  actor_id      INT          NULL,
  actor_name    VARCHAR(100) NULL,
  action        VARCHAR(40)  NOT NULL,
  subject_type  VARCHAR(20)  NOT NULL,          -- person · role
  subject_id    INT          NULL,
  summary       VARCHAR(500) NOT NULL,
  detail        JSON         NULL,
  created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  KEY idx_admaud_company (company_id, id)
);

SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
            AND COLUMN_NAME IN ('username', 'must_change_password', 'is_company_admin', 'deactivated_at', 'last_login_at')) = 5
          AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'roles' AND COLUMN_NAME = 'standard_key') = 1
          AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_audit') = 1,
          'ADMIN-PANEL-OK', 'ADMIN-PANEL-MISSING') AS result;

-- ============================================================================
-- COMPANY BRAND (user, 2026-11-26): "3-6 colors for every company to make the products … very close to their company
-- colors, and the company logos shown where possible." Shown only AFTER sign-in (the sign-in pages stay CEOFactory's:
-- nobody learns which companies exist). Set by the company's admin (admin panel › Branding) or by us
-- (scripts/core/company-brand.mjs). colors = ["#RRGGBB", …] 3-6, in order: primary, secondary, accent, then extras.
-- logo = a data: URL (png/jpeg/webp/svg, ≤ 300 KB), always shown as <img>, so an SVG cannot run script.
-- ============================================================================
CREATE TABLE IF NOT EXISTS company_brand (
  company_id  INT          NOT NULL PRIMARY KEY,
  colors      JSON         NULL,
  logo        MEDIUMTEXT   NULL,
  updated_by  INT          NULL,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
