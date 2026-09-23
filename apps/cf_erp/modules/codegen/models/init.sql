-- ============================================================================
-- cf_erp / codegen module — user-configurable code and name generation
-- ============================================================================
-- The user asked for the code generator to be a SEPARATE module that users can
-- customise (2026-09-22), rather than a name_pattern / code_pattern column on
-- definitions as the architecture diagram drew it. So:
--
--   * A SCHEME is a user-defined rule: "codes for catalog items under
--     Steel > Plates look like PL-{GRADE}-{THICKNESS}".
--   * It APPLIES when all its CONDITIONS hold for the record being coded.
--   * Its PATTERN is an ordered list of SEGMENTS: fixed text, a token read from
--     the record (a spec value, the parent's code, the BOM position ...), a date,
--     or a running number.
--   * Running numbers live in SEQUENCES, one counter per scheme per prefix.
--
-- Entity-agnostic on purpose. Nothing here references an ERP table: entity
-- types ('item', 'definition', later 'sales_order', 'batch', 'unit' ...) and the
-- tokens each offers are a registry in code, supplied by the owning module's
-- "context provider". Adopting the generator for a new entity is a code change
-- in that entity's module — never a schema change here. The same property is
-- what would let this module move into the platform core unchanged.
--
-- Scheme choice when several match: most conditions wins (a deeper classification
-- counting as more specific), then the higher `priority`. A tie is a
-- configuration error the service reports rather than silently picks.
--
-- Same platform rules as the core schema: company_id + companyId mapping,
-- deleted_at, VIRTUAL generated columns for soft-delete-aware uniqueness.
-- Run AFTER apps/cf_erp/models/init.sql. Idempotent; no DROPs.
-- ============================================================================


-- ----- Schemes ---------------------------------------------------------------
-- target_field: a scheme generates either a code or a name. The taxonomy names
-- temporary items the same way it codes them ("Web 01 - Girder G01" /
-- "P100-G01-WEB01"), so both come from here.
--
-- seq_scope: where a running number restarts.
--   prefix — one counter per distinct text in front of the sequence segment.
--            "SO-2609-###" restarts every month; "{PARENT}-WEB##" restarts per
--            parent; "PL-E250-12-##" per grade and thickness. Covers almost
--            every restart rule without configuring one.
--   scheme — one counter for the whole scheme, whatever the prefix.

CREATE TABLE IF NOT EXISTS cf_code_schemes (
  id            INT           AUTO_INCREMENT PRIMARY KEY,
  company_id    INT           NOT NULL,
  code          VARCHAR(100)  NOT NULL,             -- the scheme's own id, e.g. CAT_PLATES
  name          VARCHAR(255)  NOT NULL,
  entity_type   VARCHAR(50)   NOT NULL,             -- item, definition, ... (registry in code)
  target_field  ENUM('code','name') NOT NULL DEFAULT 'code',
  seq_scope     ENUM('prefix','scheme') NOT NULL DEFAULT 'prefix',
  priority      INT           NOT NULL DEFAULT 0,   -- tie-breaker only
  description   TEXT          NULL,
  status        ENUM('active','inactive') NOT NULL DEFAULT 'active',

  deleted_at    DATETIME      DEFAULT NULL,
  created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by    INT           NULL,

  code_active   VARCHAR(100)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_ccs_tenant (company_id, id),
  UNIQUE KEY uq_ccs_code   (company_id, code_active),
  KEY idx_ccs_lookup (company_id, entity_type, target_field, status),

  CONSTRAINT fk_ccs_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_ccs_creator FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ----- Conditions — when a scheme applies ------------------------------------
-- All of a scheme's conditions must hold. No conditions = applies to every
-- record of its entity type (the fallback scheme).
--   token_key  what to test, from the entity's registry: 'kind',
--              'classification', 'definition', ...
--   operator   eq | in (comma-separated list) | under (tree-valued tokens:
--              "classification under Steel > Plates" includes its subtree)
--   value      compared as text; ids are stored as their decimal string.
-- No FK on `value`: it may be an id of any table. The service validates it on
-- save, and a stale condition simply never matches.

CREATE TABLE IF NOT EXISTS cf_code_scheme_conditions (
  id          INT           AUTO_INCREMENT PRIMARY KEY,
  company_id  INT           NOT NULL,
  scheme_id   INT           NOT NULL,
  token_key   VARCHAR(100)  NOT NULL,
  operator    ENUM('eq','in','under') NOT NULL DEFAULT 'eq',
  value       VARCHAR(255)  NOT NULL,

  deleted_at  DATETIME      DEFAULT NULL,
  created_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by  INT           NULL,

  KEY idx_ccsc_scheme (company_id, scheme_id),

  CONSTRAINT fk_ccsc_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_ccsc_scheme  FOREIGN KEY (company_id, scheme_id) REFERENCES cf_code_schemes(company_id, id),
  CONSTRAINT fk_ccsc_creator FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ----- Segments — the pattern, in order --------------------------------------
--   literal   literal_text as-is                        'PL-'
--   token     a value from the record, via token_key    spec:GRADE, parent.code, position
--   sequence  the running number (at most one per scheme; the text before it
--             is the prefix its counter is keyed on)
--   date      the generation date in `format`           YYMM, YYYYMMDD
-- format:     sequence -> zero-pad width ('000'); date -> pattern; number token
--             -> decimals ('0', '0.0').
-- transform / max_length shape token text (first 3 letters, upper case).
-- is_required: a missing token fails generation (1) or drops the segment (0).
-- A scheme with no sequence must produce unique codes from tokens alone; if it
-- does not, the unique code index refuses the second record and the service
-- reports the collision instead of guessing.

CREATE TABLE IF NOT EXISTS cf_code_scheme_segments (
  id            INT           AUTO_INCREMENT PRIMARY KEY,
  company_id    INT           NOT NULL,
  scheme_id     INT           NOT NULL,
  sort_order    INT           NOT NULL,
  segment_type  ENUM('literal','token','sequence','date') NOT NULL,
  literal_text  VARCHAR(100)  NULL,
  token_key     VARCHAR(100)  NULL,
  format        VARCHAR(50)   NULL,
  transform     ENUM('none','upper','lower') NOT NULL DEFAULT 'none',
  max_length    SMALLINT      NULL,
  is_required   TINYINT(1)    NOT NULL DEFAULT 1,

  deleted_at    DATETIME      DEFAULT NULL,
  created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by    INT           NULL,

  KEY idx_ccss_scheme (company_id, scheme_id, sort_order),

  CONSTRAINT fk_ccss_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_ccss_scheme  FOREIGN KEY (company_id, scheme_id) REFERENCES cf_code_schemes(company_id, id),
  CONSTRAINT fk_ccss_creator FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ----- Sequences — the running-number counters -------------------------------
-- One row per (scheme, prefix). The generator increments inside the same
-- transaction that saves the record (SELECT ... FOR UPDATE; TiDB runs
-- pessimistic transactions by default), so two users can never receive the
-- same number.
-- NEVER soft-delete or lower next_value: a counter that goes backwards re-issues
-- codes. That is also why this table has no is_live column — its unique key is
-- deliberately plain. It is read-only to everything except the generator.

CREATE TABLE IF NOT EXISTS cf_code_sequences (
  id          INT           AUTO_INCREMENT PRIMARY KEY,
  company_id  INT           NOT NULL,
  scheme_id   INT           NOT NULL,
  seq_key     VARCHAR(255)  NOT NULL DEFAULT '',   -- resolved prefix; '' when seq_scope = 'scheme'
  next_value  INT           NOT NULL DEFAULT 1,

  deleted_at  DATETIME      DEFAULT NULL,          -- never set; required by the query engine
  created_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_ccq_key (company_id, scheme_id, seq_key),

  CONSTRAINT fk_ccq_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_ccq_scheme  FOREIGN KEY (company_id, scheme_id) REFERENCES cf_code_schemes(company_id, id)
);
