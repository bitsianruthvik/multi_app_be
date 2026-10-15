-- ============================================================================
-- cf_crm — customer, referral and marketing network (ported from NorthEast
-- Network, a Vercel + Postgres app). 12 tables. MySQL 8 and TiDB.
-- ============================================================================
-- THE MODEL IN ONE PARAGRAPH
--   A CUSTOMER (cf_crm_customers) is the tenant of this app: it owns the
--   branding (colours, logo, app name) and ONE shared contact network. One or
--   more platform companies belong to a customer (cf_crm_customer_companies);
--   their logins all work on the same network. Inside the network the data is
--   a set of typed JSON RECORDS (people, companies, leads, chits, property,
--   interactions, campaigns, segments, groups, blacklist, comments, documents)
--   that the browser keeps a local copy of and syncs by cursor
--   (updated_at, type, id). The columns next to `data` (person_id, lead_id,
--   owner_in_charge, is_private, business) are copied out of `data` on every
--   write so the visibility rules in the sync can be SQL without JSON_TABLE,
--   which TiDB does not have.
--
-- WHY THESE CHOICES
--   - Every table carries customer_id and every key starts with it.
--   - updated_at is DATETIME(6): the sync cursor compares it, and a batch of
--     400 records written in one statement must still be ordered by (type, id).
--   - Ids that the browser polls with `id > last` (chat messages,
--     notifications, audit) use AUTO_ID_CACHE 1 so TiDB hands them out in
--     order across servers. MySQL ignores the TiDB-only comment.
--   - Mobile numbers live in cf_crm_phones (normalised, one row per number),
--     because "a mobile belongs to one person" has to be checked by the
--     server, and a JSON array cannot be indexed on TiDB.
--   - Files are stored in the database (MEDIUMBLOB, 4 MB cap in code), as the
--     original did, so a document is private to the customer and backed up
--     with everything else. TiDB's 6 MB row limit is above the cap.
-- Idempotent: every statement can be run again.
-- ============================================================================

CREATE TABLE IF NOT EXISTS cf_crm_customers (
  id          INT NOT NULL AUTO_INCREMENT,
  slug        VARCHAR(64)  NOT NULL,
  name        VARCHAR(200) NOT NULL,
  -- { appName, wordmark:{a,b,sub}, logoSvg | logoUrl, colors:{...}, dark:{...} }
  brand       JSON NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at  DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cf_crm_customers_slug (slug)
);

-- A platform company belongs to at most one customer.
CREATE TABLE IF NOT EXISTS cf_crm_customer_companies (
  company_id   INT NOT NULL,
  customer_id  INT NOT NULL,
  -- the business id (in the customer's settings) this company's staff work on
  -- by default; NULL = all businesses
  business_id  VARCHAR(40) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id),
  KEY ix_cf_crm_cc_customer (customer_id)
);

-- What a login is in this app: role, the owner name they act as, the
-- businesses they may work on, per-person permission overrides.
CREATE TABLE IF NOT EXISTS cf_crm_members (
  customer_id  INT NOT NULL,
  user_id      INT NOT NULL,
  role         VARCHAR(40)  NOT NULL DEFAULT 'readonly',
  owner        VARCHAR(120) NOT NULL DEFAULT '',
  businesses   JSON NULL,
  perms        JSON NULL,
  active       TINYINT(1) NOT NULL DEFAULT 1,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  last_seen    DATETIME NULL,
  PRIMARY KEY (customer_id, user_id),
  KEY ix_cf_crm_members_user (user_id)
);

CREATE TABLE IF NOT EXISTS cf_crm_records (
  customer_id      INT NOT NULL,
  type             VARCHAR(20) NOT NULL,
  id               VARCHAR(64) NOT NULL,
  data             JSON NULL,
  deleted          TINYINT(1) NOT NULL DEFAULT 0,
  person_id        VARCHAR(64)  NULL,
  lead_id          VARCHAR(64)  NULL,
  owner_in_charge  VARCHAR(120) NULL,
  is_private       TINYINT(1) NOT NULL DEFAULT 0,
  business         VARCHAR(40)  NULL,
  updated_at       DATETIME(6) NOT NULL,
  updated_by       INT NULL,
  PRIMARY KEY (customer_id, type, id),
  KEY ix_cf_crm_records_sync (customer_id, updated_at, type, id),
  KEY ix_cf_crm_records_person (customer_id, person_id),
  KEY ix_cf_crm_records_lead (customer_id, lead_id)
);

CREATE TABLE IF NOT EXISTS cf_crm_phones (
  customer_id  INT NOT NULL,
  person_id    VARCHAR(64) NOT NULL,
  phone        VARCHAR(20) NOT NULL,
  PRIMARY KEY (customer_id, person_id, phone),
  KEY ix_cf_crm_phones_phone (customer_id, phone)
);

-- key 'config': the customer's whole setup (businesses, stages, fields, owners…)
CREATE TABLE IF NOT EXISTS cf_crm_settings (
  customer_id  INT NOT NULL,
  k            VARCHAR(40) NOT NULL,
  value        JSON NOT NULL,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (customer_id, k)
);

CREATE TABLE IF NOT EXISTS cf_crm_audit (
  id           BIGINT NOT NULL AUTO_INCREMENT,
  customer_id  INT NOT NULL,
  at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  user_id      INT NULL,
  who          VARCHAR(200) NULL,
  action       VARCHAR(40)  NULL,
  entity       VARCHAR(200) NULL,
  entity_id    VARCHAR(64)  NULL,
  detail       VARCHAR(300) NULL,
  PRIMARY KEY (id),
  KEY ix_cf_crm_audit_customer (customer_id, id),
  KEY ix_cf_crm_audit_entity (customer_id, entity_id)
) /*T![auto_id_cache] AUTO_ID_CACHE=1 */;

CREATE TABLE IF NOT EXISTS cf_crm_chat_threads (
  customer_id  INT NOT NULL,
  id           VARCHAR(64) NOT NULL,
  kind         VARCHAR(20) NOT NULL,
  name         VARCHAR(120) NOT NULL DEFAULT '',
  business     VARCHAR(40) NULL,
  members      JSON NULL,
  created_by   INT NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (customer_id, id)
);

CREATE TABLE IF NOT EXISTS cf_crm_chat_messages (
  id           BIGINT NOT NULL AUTO_INCREMENT,
  customer_id  INT NOT NULL,
  thread_id    VARCHAR(64) NOT NULL,
  user_id      INT NULL,
  who          VARCHAR(200) NULL,
  text         TEXT NOT NULL,
  at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at   DATETIME(3) NULL,
  deleted_by   INT NULL,
  PRIMARY KEY (id),
  KEY ix_cf_crm_chat_thread (customer_id, thread_id, id)
) /*T![auto_id_cache] AUTO_ID_CACHE=1 */;

CREATE TABLE IF NOT EXISTS cf_crm_chat_reads (
  customer_id  INT NOT NULL,
  thread_id    VARCHAR(64) NOT NULL,
  user_id      INT NOT NULL,
  last_id      BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (customer_id, thread_id, user_id)
);

CREATE TABLE IF NOT EXISTS cf_crm_notifications (
  id           BIGINT NOT NULL AUTO_INCREMENT,
  customer_id  INT NOT NULL,
  user_id      INT NOT NULL,
  kind         VARCHAR(20)  NULL,
  text         VARCHAR(300) NULL,
  link         VARCHAR(200) NULL,
  at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  read_at      DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY ix_cf_crm_notif_user (customer_id, user_id, id)
) /*T![auto_id_cache] AUTO_ID_CACHE=1 */;

CREATE TABLE IF NOT EXISTS cf_crm_files (
  customer_id  INT NOT NULL,
  id           VARCHAR(32) NOT NULL,
  data         MEDIUMBLOB NOT NULL,
  mime         VARCHAR(100) NOT NULL DEFAULT 'application/octet-stream',
  size         INT NOT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by   INT NULL,
  PRIMARY KEY (customer_id, id)
);

SELECT IF((SELECT COUNT(*) FROM information_schema.tables
            WHERE table_schema = DATABASE() AND table_name LIKE 'cf\_crm\_%') >= 12,
          'SCHEMA-OK', 'SCHEMA-MISSING') AS result;
