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
