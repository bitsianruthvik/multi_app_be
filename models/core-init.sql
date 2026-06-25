-- Core schema — owned by the platform, shared across all apps.
-- Tables: companies, apps, users, teams, roles, features, features_capability, role_capability.
-- App-specific tables live in apps/<slug>/models/init.sql.

CREATE TABLE features (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255),
  feature_name VARCHAR(100),
  feature_tag VARCHAR(100),
  type ENUM('frontend', 'backend'),
  deleted_at DATETIME NULL DEFAULT NULL
);

CREATE TABLE features_capability (
  capability_id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100),
  features_json JSON,
  deleted_at DATETIME NULL DEFAULT NULL,
  CONSTRAINT chk_valid_json CHECK (JSON_VALID(features_json))
);

-- Post-migration shape: role_capability uses FK columns (role_id, team_id, company_id).
-- See migrations/core/002_role_capability_fk.sql for the data migration.
CREATE TABLE role_capability (
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

-- Companies table used to store app/company specific settings and slug
CREATE TABLE companies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  slug VARCHAR(100) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL DEFAULT NULL
);

CREATE TABLE apps (
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

CREATE TABLE teams (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  company_id INT NOT NULL,
  deleted_at DATETIME NULL DEFAULT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE TABLE roles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  company_id INT NOT NULL,
  role_tag VARCHAR(64) NULL,
  deleted_at DATETIME NULL DEFAULT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(100) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role_id INT NOT NULL,
  team_id INT NOT NULL,
  company_id INT NOT NULL,
  deleted_at DATETIME NULL DEFAULT NULL,
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
