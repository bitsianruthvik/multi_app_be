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

-- ============================================================================
-- GST identity (2026-09-30, TM/CF_ERP_GST_PLAN.md §1) — cf_erp init.sql §37
-- carries the rest of the GST work; the party half lives here because this
-- file runs FIRST and the module owns its table.
-- ============================================================================
-- tax_number IS the GSTIN (validated with its mod-36 check character by
-- gstin.js when a registered party is given one). gst_registration says how the
-- party is registered: it decides B2B vs unregistered, and SEZ / overseas make
-- a supply inter-state (IGST) whatever the states. state_code is derived from
-- the GSTIN when there is one; for an unregistered party it is typed.
-- Plain columns, each ADD guarded on its own (TiDB: no key in the same ALTER
-- as its column). The addresses table has no key into cf_erp.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_parties' AND COLUMN_NAME = 'gst_registration');
SET @sql = IF(@col = 0,
  "ALTER TABLE cf_parties ADD COLUMN gst_registration ENUM('regular','composition','unregistered','sez','overseas') NOT NULL DEFAULT 'regular'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_parties' AND COLUMN_NAME = 'state_code');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_parties ADD COLUMN state_code CHAR(2) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_parties' AND COLUMN_NAME = 'city');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_parties ADD COLUMN city VARCHAR(100) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_parties' AND COLUMN_NAME = 'pincode');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_parties ADD COLUMN pincode VARCHAR(10) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Ship-to addresses. A customer's site in another state can carry that state's
-- GSTIN. is_default_ship: at most one per party — the service keeps it so (TiDB
-- has no partial unique index). Place of supply of goods = the ship-to's state.
CREATE TABLE IF NOT EXISTS cf_party_addresses (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  company_id       INT           NOT NULL,
  party_id         INT           NOT NULL,
  label            VARCHAR(100)  NULL,
  address          TEXT          NULL,
  city             VARCHAR(100)  NULL,
  pincode          VARCHAR(10)   NULL,
  state_code       CHAR(2)       NULL,
  gstin            VARCHAR(15)   NULL,
  is_default_ship  TINYINT(1)    NOT NULL DEFAULT 0,

  deleted_at       DATETIME      DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by       INT           NULL,

  UNIQUE KEY uq_cpad_tenant (company_id, id),
  KEY idx_cpad_party (company_id, party_id),

  CONSTRAINT fk_cpad_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cpad_party   FOREIGN KEY (company_id, party_id) REFERENCES cf_parties(company_id, id),
  CONSTRAINT fk_cpad_creator FOREIGN KEY (created_by) REFERENCES users(id)
);
