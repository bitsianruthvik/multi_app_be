-- Migration: replace plain string columns (role, team, company) on role_capability
-- with proper FK columns (role_id, team_id, company_id).
-- Run AFTER 001_add_deleted_at.sql.

ALTER TABLE role_capability ADD COLUMN role_id INT NULL, ADD COLUMN team_id INT NULL, ADD COLUMN company_id INT NULL;

UPDATE role_capability rc
  JOIN companies c ON c.slug = rc.company OR c.name = rc.company
  SET rc.company_id = c.id;

UPDATE role_capability rc
  JOIN roles r ON r.name = rc.role AND r.company_id = rc.company_id
  SET rc.role_id = r.id;

UPDATE role_capability rc
  JOIN teams t ON t.name = rc.team AND t.company_id = rc.company_id
  SET rc.team_id = t.id;

ALTER TABLE role_capability
  ADD CONSTRAINT fk_rc_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_rc_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_rc_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE role_capability DROP COLUMN role, DROP COLUMN team, DROP COLUMN company;
