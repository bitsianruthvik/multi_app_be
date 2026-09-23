-- ============================================================================
-- parties module — customers, suppliers and subcontractors
-- ============================================================================
-- A separate module for the same reason as the code generator: these are the
-- platform's shared masters, not cf_erp's. fab_erp put customers, suppliers and
-- plants inside its own schema, and a future CRM or supplier app would then
-- have to depend on fab_erp to read them. Here the dependency points the other
-- way — cf_erp tables reference cf_parties; nothing in this folder references
-- cf_erp — so the table can be lifted into the platform core unchanged.
--
-- One party can be a customer AND a supplier (a steel stockist who also buys
-- scrap), so roles are flags, not a type column.
--
-- Codes are typed by people (like classification codes): the module does not
-- depend on the code generator either.
--
-- RUN ORDER: this file first, then apps/cf_erp/models/init.sql (sales orders
-- reference cf_parties), then modules/codegen/models/init.sql.
-- Idempotent: CREATE TABLE IF NOT EXISTS only.
-- ============================================================================

CREATE TABLE IF NOT EXISTS cf_parties (
  id                INT           AUTO_INCREMENT PRIMARY KEY,
  company_id        INT           NOT NULL,
  code              VARCHAR(50)   NOT NULL,
  name              VARCHAR(255)  NOT NULL,
  is_customer       TINYINT(1)    NOT NULL DEFAULT 0,
  is_supplier       TINYINT(1)    NOT NULL DEFAULT 0,
  is_subcontractor  TINYINT(1)    NOT NULL DEFAULT 0,
  tax_number        VARCHAR(50)   NULL,
  contact_name      VARCHAR(255)  NULL,
  email             VARCHAR(255)  NULL,
  phone             VARCHAR(50)   NULL,
  address           TEXT          NULL,
  notes             TEXT          NULL,
  status            ENUM('active','inactive') NOT NULL DEFAULT 'active',

  deleted_at        DATETIME      DEFAULT NULL,
  created_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by        INT           NULL,

  code_active       VARCHAR(50)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_cpt_tenant (company_id, id),
  UNIQUE KEY uq_cpt_code   (company_id, code_active),
  KEY idx_cpt_roles (company_id, is_customer, is_supplier, is_subcontractor),

  CONSTRAINT fk_cpt_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cpt_creator FOREIGN KEY (created_by) REFERENCES users(id)
);
